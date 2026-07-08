import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { BrokerTool, BrokerToolCallResult, BrokerToolService } from "../github/types.js";
import type { CommandRunner } from "../utils/command-runner.js";
import { CommandExecutionError } from "../utils/command-runner.js";
import type { Logger } from "../utils/logger.js";

const MAX_DIFF_BYTES = 64_000;
const MAX_FILE_BYTES = 256_000;
const CONFLICT_MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)(?: .*)?$/m;

type GitOperation = "none" | "merge" | "rebase" | "cherry-pick" | "revert";
type WorkstreamState = "merge_conflict" | "merge_started" | "merge_aborted";

export interface BackburnerGitWorkstreamRegistration {
  backburnerGitSessionId: string;
  workstreamId: string;
  repoRoot: string;
  expectedHeadSha: string;
  baseRef: string;
  currentBranch: string;
  state: WorkstreamState;
}

interface RegisteredWorkstream extends BackburnerGitWorkstreamRegistration {
  repoRoot: string;
}

interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
  originalPath?: string;
}

interface ValidatedPathSnapshot {
  paths: string[];
  tracked: Set<string>;
  entries: Map<string, PorcelainEntry>;
}

class BackburnerGitToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class BackburnerGitToolService implements BrokerToolService {
  private readonly sessions = new Map<string, RegisteredWorkstream>();

  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly logger: Logger
  ) {}

  listTools(): BrokerTool[] {
    return TOOL_DEFINITIONS;
  }

  registerPrepareForMergeWorkstream(input: BackburnerGitWorkstreamRegistration): void {
    if (this.sessions.has(input.backburnerGitSessionId)) {
      throw new Error(
        `Backburner Git session "${input.backburnerGitSessionId}" is already registered. ` +
        "Concurrent prepare-for-merge tasks must use distinct session IDs."
      );
    }
    this.sessions.set(input.backburnerGitSessionId, {
      ...input,
      repoRoot: path.resolve(input.repoRoot)
    });
  }

  unregisterBackburnerGitSession(backburnerGitSessionId: string): void {
    this.sessions.delete(backburnerGitSessionId);
  }

  updateWorkstreamState(backburnerGitSessionId: string, state: WorkstreamState): void {
    const registered = this.sessions.get(backburnerGitSessionId);
    if (!registered) {
      throw new BackburnerGitToolError("unknown_workstream", `Unknown Backburner Git session "${backburnerGitSessionId}"`);
    }
    registered.state = state;
  }

  async callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    const startedAt = new Date().toISOString();
    try {
      const result = await this.callToolInner(name, rawArguments);
      this.logInvocation(startedAt, name, rawArguments, "ok");
      return result;
    } catch (error) {
      const failure = toFailure(name, error);
      this.logInvocation(startedAt, name, rawArguments, "error", failure.ok ? undefined : failure.error.message);
      return failure;
    }
  }

  private async callToolInner(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    switch (name) {
      case "backburner_git_get_state": {
        const workstream = this.requireWorkstream(expectBackburnerGitSessionId(rawArguments));
        const result = await this.getState(workstream);
        return success(name, "Backburner Git state loaded.", result);
      }
      case "backburner_git_get_conflicts": {
        const workstream = this.requireWorkstream(expectBackburnerGitSessionId(rawArguments));
        const result = await this.getConflicts(workstream);
        return success(name, "Backburner Git conflicts loaded.", result);
      }
      case "backburner_git_get_conflict_versions": {
        const args = expectObject(rawArguments, "tool arguments must be an object");
        const workstream = this.requireWorkstream(expectString(args.backburnerGitSessionId, '"backburnerGitSessionId" is required'));
        const safePath = await this.validateKnownPath(workstream, expectString(args.path, '"path" is required'));
        const result = await this.getConflictVersions(workstream, safePath);
        return success(name, `Backburner Git conflict versions loaded for ${safePath}.`, result);
      }
      case "backburner_git_get_diff": {
        const args = expectObject(rawArguments ?? {}, "tool arguments must be an object");
        const workstream = this.requireWorkstream(expectString(args.backburnerGitSessionId, '"backburnerGitSessionId" is required'));
        const options = expectDiffOptions(args.options);
        const safePath = options.path ? await this.validateKnownPath(workstream, options.path) : undefined;
        const result = await this.getDiff(workstream, safePath ? { ...options, path: safePath } : options);
        return success(name, "Backburner Git diff loaded.", result);
      }
      case "backburner_git_mark_resolved": {
        const args = expectObject(rawArguments, "tool arguments must be an object");
        const workstream = this.requireWorkstream(expectString(args.backburnerGitSessionId, '"backburnerGitSessionId" is required'));
        this.requireMergeConflictState(workstream);
        const paths = await this.validatePathList(workstream, args.paths);
        for (const repoPath of paths) {
          await this.rejectConflictMarkers(workstream, repoPath);
        }
        await this.runGit(workstream.repoRoot, ["add", "--", ...paths]);
        return success(name, "Backburner Git paths marked resolved.", { paths, state: await this.getState(workstream) });
      }
      case "backburner_git_mark_deleted": {
        const args = expectObject(rawArguments, "tool arguments must be an object");
        const workstream = this.requireWorkstream(expectString(args.backburnerGitSessionId, '"backburnerGitSessionId" is required'));
        this.requireMergeConflictState(workstream);
        const paths = await this.validateDeletedPathList(workstream, args.paths);
        await this.runGit(workstream.repoRoot, ["rm", "--force", "--", ...paths]);
        return success(name, "Backburner Git deleted paths marked resolved.", { paths, state: await this.getState(workstream) });
      }
      case "backburner_git_unstage": {
        const args = expectObject(rawArguments, "tool arguments must be an object");
        const workstream = this.requireWorkstream(expectString(args.backburnerGitSessionId, '"backburnerGitSessionId" is required'));
        this.requireMergeConflictState(workstream);
        const paths = await this.validatePathList(workstream, args.paths);
        await this.runGit(workstream.repoRoot, ["restore", "--staged", "--", ...paths]);
        return success(name, "Backburner Git paths unstaged.", { paths, state: await this.getState(workstream) });
      }
      case "backburner_git_restore_worktree": {
        const args = expectObject(rawArguments, "tool arguments must be an object");
        const workstream = this.requireWorkstream(expectString(args.backburnerGitSessionId, '"backburnerGitSessionId" is required'));
        this.requireMergeConflictState(workstream);
        const paths = await this.validateRestorableWorktreePathList(workstream, args.paths);
        await this.runGit(workstream.repoRoot, ["restore", "--worktree", "--", ...paths]);
        return success(name, "Backburner Git worktree paths restored.", { paths, state: await this.getState(workstream) });
      }
      case "backburner_git_continue_merge": {
        const workstream = this.requireWorkstream(expectBackburnerGitSessionId(rawArguments));
        this.requireMergeConflictState(workstream);
        const result = await this.continueMerge(workstream);
        workstream.state = "merge_started";
        return success(name, "Backburner Git merge continued.", result);
      }
      case "backburner_git_abort_merge": {
        const workstream = this.requireWorkstream(expectBackburnerGitSessionId(rawArguments));
        await this.requireActiveOperation(workstream, "merge");
        await this.runGit(workstream.repoRoot, ["merge", "--abort"]);
        workstream.state = "merge_aborted";
        return success(name, "Backburner Git merge aborted.", { state: await this.getState(workstream) });
      }
      default:
        throw new BackburnerGitToolError("tool_not_found", `Unknown Backburner Git tool "${name}"`);
    }
  }

  private requireWorkstream(backburnerGitSessionId: string): RegisteredWorkstream {
    const workstream = this.sessions.get(backburnerGitSessionId);
    if (!workstream) {
      throw new BackburnerGitToolError("unknown_workstream", `Unknown Backburner Git session "${backburnerGitSessionId}"`);
    }
    return workstream;
  }

  private requireMergeConflictState(workstream: RegisteredWorkstream): void {
    if (workstream.state !== "merge_conflict") {
      throw new BackburnerGitToolError(
        "invalid_workstream_state",
        `Backburner Git session "${workstream.backburnerGitSessionId}" for workstream "${workstream.workstreamId}" ` +
        `is in ${workstream.state} state, not merge_conflict`
      );
    }
  }

  private async requireActiveOperation(
    workstream: RegisteredWorkstream,
    expected: GitOperation
  ): Promise<void> {
    const operation = await this.getActiveOperation(workstream.repoRoot);
    if (operation !== expected) {
      throw new BackburnerGitToolError("invalid_git_operation", `Expected active ${expected}, found ${operation}`);
    }
  }

  private async validatePathList(workstream: RegisteredWorkstream, rawPaths: unknown): Promise<string[]> {
    return (await this.validatePathListWithSnapshot(workstream, rawPaths)).paths;
  }

  private async validatePathListWithSnapshot(
    workstream: RegisteredWorkstream,
    rawPaths: unknown
  ): Promise<ValidatedPathSnapshot> {
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      throw new BackburnerGitToolError("invalid_arguments", '"paths" must be a non-empty string array');
    }
    const [tracked, entries] = await Promise.all([
      this.getTrackedPaths(workstream.repoRoot),
      this.getPorcelainEntryMap(workstream.repoRoot)
    ]);
    const known = new Set([...tracked, ...entries.keys()]);
    const paths = [];
    for (const entry of rawPaths) {
      const repoPath = validateRepoRelativePath(workstream.repoRoot, expectString(entry, "each path must be a string"));
      if (!known.has(repoPath)) {
        throw new BackburnerGitToolError(
          "path_not_changed",
          `Path "${repoPath}" is not conflicted, tracked, or changed for this Backburner Git session`
        );
      }
      paths.push(repoPath);
    }
    return { paths, tracked, entries };
  }

  private async validateDeletedPathList(workstream: RegisteredWorkstream, rawPaths: unknown): Promise<string[]> {
    const { paths, entries } = await this.validatePathListWithSnapshot(workstream, rawPaths);
    const invalid = paths.filter((repoPath) => {
      const entry = entries.get(repoPath);
      return !entry || !isCurrentDeletionEntry(entry);
    });
    if (invalid.length > 0) {
      throw new BackburnerGitToolError(
        "path_not_deleted",
        `Path is not currently deleted or unmerged for this Backburner Git session: ${invalid.join(", ")}`
      );
    }
    return paths;
  }

  private async validateRestorableWorktreePathList(
    workstream: RegisteredWorkstream,
    rawPaths: unknown
  ): Promise<string[]> {
    const { paths, tracked, entries } = await this.validatePathListWithSnapshot(workstream, rawPaths);
    const invalid = paths.filter((repoPath) => {
      const entry = entries.get(repoPath);
      return !tracked.has(repoPath) || !entry || isUnmergedEntry(entry) || entry.y === " ";
    });
    if (invalid.length > 0) {
      throw new BackburnerGitToolError(
        "path_not_restorable",
        `Path has no restorable tracked worktree change for this Backburner Git session: ${invalid.join(", ")}. ` +
        "To undo a staged change, use backburner_git_unstage instead."
      );
    }
    return paths;
  }

  private async validateKnownPath(workstream: RegisteredWorkstream, inputPath: string): Promise<string> {
    const repoPath = validateRepoRelativePath(workstream.repoRoot, inputPath);
    const known = await this.getKnownPaths(workstream);
    if (!known.has(repoPath)) {
      throw new BackburnerGitToolError(
        "path_not_changed",
        `Path "${repoPath}" is not conflicted, tracked, or changed for this Backburner Git session`
      );
    }
    return repoPath;
  }

  private async getKnownPaths(workstream: RegisteredWorkstream): Promise<Set<string>> {
    const entries = await this.getPorcelainEntries(workstream.repoRoot);
    const known = new Set(entries.map((entry) => entry.path));
    for (const repoPath of await this.getTrackedPaths(workstream.repoRoot)) {
      known.add(repoPath);
    }
    return known;
  }

  private async getTrackedPaths(repoRoot: string): Promise<Set<string>> {
    const tracked = await this.runGit(repoRoot, ["ls-files"]);
    return new Set(tracked.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }

  private async getState(workstream: RegisteredWorkstream): Promise<Record<string, unknown>> {
    const [operation, currentBranch, currentHeadSha, entries, conflictedFiles] = await Promise.all([
      this.getActiveOperation(workstream.repoRoot),
      this.getCurrentBranch(workstream.repoRoot),
      this.runGit(workstream.repoRoot, ["rev-parse", "HEAD"]).then((result) => result.stdout.trim()),
      this.getPorcelainEntries(workstream.repoRoot),
      this.getUnresolvedConflictPaths(workstream.repoRoot)
    ]);

    const files = classifyPorcelainEntries(entries);

    return {
      operation,
      currentBranch,
      baseRef: workstream.baseRef,
      expectedHeadSha: workstream.expectedHeadSha,
      currentHeadSha,
      worktreeClean: entries.length === 0,
      indexHasUnresolvedConflicts: conflictedFiles.length > 0,
      stagedFiles: files.stagedFiles,
      unstagedFiles: files.unstagedFiles,
      untrackedFiles: files.untrackedFiles,
      conflictedFiles,
      statusSummary: await this.getStatusSummary(workstream.repoRoot)
    };
  }

  private async getConflicts(workstream: RegisteredWorkstream): Promise<Record<string, unknown>> {
    const entries = (await this.getPorcelainEntries(workstream.repoRoot)).filter(isUnmergedEntry);
    const conflicts = [];
    for (const entry of entries) {
      const filePath = path.join(workstream.repoRoot, entry.path);
      const exists = await pathExists(filePath);
      conflicts.push({
        path: entry.path,
        type: conflictType(entry),
        exists,
        conflictMarkersPresent: exists ? await fileHasConflictMarkers(filePath) : false
      });
    }
    return { conflicts };
  }

  private async getConflictVersions(
    workstream: RegisteredWorkstream,
    repoPath: string
  ): Promise<Record<string, unknown>> {
    const [base, ours, theirs, current] = await Promise.all([
      this.readGitStage(workstream, 1, repoPath),
      this.readGitStage(workstream, 2, repoPath),
      this.readGitStage(workstream, 3, repoPath),
      readBoundedWorkingTreeFile(path.join(workstream.repoRoot, repoPath))
    ]);
    return {
      path: repoPath,
      stages: {
        base: base.exists,
        ours: ours.exists,
        theirs: theirs.exists
      },
      base: base.content,
      ours: ours.content,
      theirs: theirs.content,
      current: current.content,
      currentExists: current.exists,
      truncated: base.truncated || ours.truncated || theirs.truncated || current.truncated
    };
  }

  private async getDiff(
    workstream: RegisteredWorkstream,
    options: { staged: boolean; unstaged: boolean; path?: string }
  ): Promise<Record<string, unknown>> {
    const args = ["diff"];
    if (options.staged) {
      args.push("--cached");
    }
    if (options.path) {
      args.push("--", options.path);
    }
    const result = await this.runGit(workstream.repoRoot, args);
    const bounded = boundText(result.stdout, MAX_DIFF_BYTES);
    return {
      staged: options.staged,
      unstaged: options.unstaged,
      path: options.path ?? null,
      diff: bounded.text,
      truncated: bounded.truncated,
      originalLength: result.stdout.length
    };
  }

  private async continueMerge(workstream: RegisteredWorkstream): Promise<Record<string, unknown>> {
    await this.requireActiveOperation(workstream, "merge");
    const unresolved = await this.getUnresolvedConflictPaths(workstream.repoRoot);
    if (unresolved.length > 0) {
      throw new BackburnerGitToolError("unresolved_conflicts", `Unresolved conflict entries remain: ${unresolved.join(", ")}`);
    }
    const markerFiles = await this.findConflictMarkersInChangedTrackedFiles(workstream);
    if (markerFiles.length > 0) {
      throw new BackburnerGitToolError("conflict_markers_present", `Conflict markers remain in: ${markerFiles.join(", ")}`);
    }
    const files = classifyPorcelainEntries(await this.getPorcelainEntries(workstream.repoRoot));
    if (files.unstagedFiles.length > 0 || files.untrackedFiles.length > 0) {
      throw new BackburnerGitToolError(
        "dirty_worktree",
        "Cannot continue merge with a dirty worktree " +
        `(unstaged tracked: ${files.unstagedFiles.join(", ") || "none"}; ` +
        `untracked: ${files.untrackedFiles.join(", ") || "none"}). ` +
        "Stage intended modified files with backburner_git_mark_resolved or mark intended deleted files with " +
        "backburner_git_mark_deleted. If a staged resolution was accidentally changed or deleted in the worktree, " +
        "restore it with backburner_git_restore_worktree. Remove unintended untracked files before continuing. " +
        "Then call backburner_git_continue_merge again."
      );
    }

    await this.runGit(workstream.repoRoot, ["commit", "--no-edit"]);
    const state = await this.getState(workstream);

    return {
      commitSha: expectString(state.currentHeadSha, "currentHeadSha missing from Backburner Git state"),
      state
    };
  }

  private async findConflictMarkersInChangedTrackedFiles(workstream: RegisteredWorkstream): Promise<string[]> {
    const result = await this.runGit(workstream.repoRoot, ["diff", "--name-only", "--cached"]);
    const files = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const markerFiles = [];
    for (const repoPath of files) {
      if (await fileHasConflictMarkers(path.join(workstream.repoRoot, repoPath))) {
        markerFiles.push(repoPath);
      }
    }
    return markerFiles;
  }

  private async rejectConflictMarkers(workstream: RegisteredWorkstream, repoPath: string): Promise<void> {
    if (await fileHasConflictMarkers(path.join(workstream.repoRoot, repoPath))) {
      throw new BackburnerGitToolError("conflict_markers_present", `Path "${repoPath}" still contains conflict markers`);
    }
  }

  private async readGitStage(
    workstream: RegisteredWorkstream,
    stage: 1 | 2 | 3,
    repoPath: string
  ): Promise<{ exists: boolean; content: string | null; truncated: boolean }> {
    try {
      const result = await this.runGit(workstream.repoRoot, ["show", `:${stage}:${repoPath}`]);
      const bounded = boundText(result.stdout, MAX_FILE_BYTES);
      return { exists: true, content: bounded.text, truncated: bounded.truncated };
    } catch (error) {
      if (error instanceof CommandExecutionError) {
        return { exists: false, content: null, truncated: false };
      }
      throw error;
    }
  }

  private async getActiveOperation(repoRoot: string): Promise<GitOperation> {
    const gitDir = await this.getGitDir(repoRoot);
    if (await pathExists(path.join(gitDir, "MERGE_HEAD"))) return "merge";
    if (await pathExists(path.join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
    if (await pathExists(path.join(gitDir, "REVERT_HEAD"))) return "revert";
    if (
      await pathExists(path.join(gitDir, "REBASE_HEAD")) ||
      await pathExists(path.join(gitDir, "rebase-merge")) ||
      await pathExists(path.join(gitDir, "rebase-apply"))
    ) {
      return "rebase";
    }
    return "none";
  }

  private async getGitDir(repoRoot: string): Promise<string> {
    const result = await this.runGit(repoRoot, ["rev-parse", "--git-dir"]);
    const raw = result.stdout.trim();
    return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  }

  private async getCurrentBranch(repoRoot: string): Promise<string | null> {
    try {
      const result = await this.runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async getStatusSummary(repoRoot: string): Promise<string> {
    const result = await this.runGit(repoRoot, ["status", "--short"]);
    return result.stdout.trim();
  }

  private async getUnresolvedConflictPaths(repoRoot: string): Promise<string[]> {
    const entries = await this.getPorcelainEntries(repoRoot);
    return entries.filter(isUnmergedEntry).map((entry) => entry.path);
  }

  private async getPorcelainEntries(repoRoot: string): Promise<PorcelainEntry[]> {
    const result = await this.runGit(repoRoot, ["status", "--porcelain"]);
    return result.stdout.split(/\r?\n/).filter(Boolean).map(parsePorcelainEntry);
  }

  private async getPorcelainEntryMap(repoRoot: string): Promise<Map<string, PorcelainEntry>> {
    return new Map((await this.getPorcelainEntries(repoRoot)).map((entry) => [entry.path, entry]));
  }

  private async runGit(cwd: string, args: string[]) {
    return await this.commandRunner.run("git", args, { cwd });
  }

  private logInvocation(
    timestamp: string,
    toolName: string,
    rawArguments: unknown,
    status: "ok" | "error",
    message?: string
  ): void {
    const backburnerGitSessionId = isRecord(rawArguments) && typeof rawArguments.backburnerGitSessionId === "string"
      ? rawArguments.backburnerGitSessionId
      : undefined;
    this.logger.info(
      JSON.stringify({
        component: "backburner-git-mcp",
        timestamp,
        toolName,
        backburnerGitSessionId: backburnerGitSessionId ?? "unknown",
        workstreamId: backburnerGitSessionId
          ? this.sessions.get(backburnerGitSessionId)?.workstreamId ?? "unknown"
          : "unknown",
        resultStatus: status,
        ...(message ? { message } : {})
      })
    );
  }
}

function validateRepoRelativePath(repoRoot: string, inputPath: string): string {
  if (path.isAbsolute(inputPath) || /^[A-Za-z]:/.test(inputPath) || inputPath.startsWith("\\\\")) {
    throw new BackburnerGitToolError("invalid_path", "Path must be repo-relative, not absolute");
  }
  const normalized = path.posix.normalize(inputPath.replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === "" ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new BackburnerGitToolError("invalid_path", "Path must not contain '..' or be empty");
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    throw new BackburnerGitToolError("invalid_path", "Path must not point inside .git");
  }
  const resolved = path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new BackburnerGitToolError("invalid_path", "Path escapes the registered repo root");
  }
  return normalized;
}

function parsePorcelainEntry(line: string): PorcelainEntry {
  const x = line[0] ?? " ";
  const y = line[1] ?? " ";
  const rawPath = line.slice(3);
  if (rawPath.includes(" -> ")) {
    const [originalPath, newPath] = rawPath.split(" -> ");
    return originalPath === undefined
      ? { x, y, path: newPath ?? rawPath }
      : { x, y, path: newPath ?? rawPath, originalPath };
  }
  return { x, y, path: rawPath };
}

function isUnmergedEntry(entry: PorcelainEntry): boolean {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(`${entry.x}${entry.y}`);
}

function isDeletionResolutionEntry(entry: PorcelainEntry): boolean {
  return ["DD", "DU", "UD"].includes(`${entry.x}${entry.y}`);
}

function isCurrentDeletionEntry(entry: PorcelainEntry): boolean {
  return isDeletionResolutionEntry(entry) || entry.y === "D";
}

function classifyPorcelainEntries(entries: PorcelainEntry[]): {
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
} {
  return {
    stagedFiles: entries
      .filter((entry) => entry.x !== " " && entry.x !== "?" && !isUnmergedEntry(entry))
      .map((entry) => entry.path),
    unstagedFiles: entries
      .filter((entry) => entry.y !== " " && entry.y !== "?" && !isUnmergedEntry(entry))
      .map((entry) => entry.path),
    untrackedFiles: entries
      .filter((entry) => entry.x === "?" && entry.y === "?")
      .map((entry) => entry.path)
  };
}

function conflictType(entry: PorcelainEntry): string {
  switch (`${entry.x}${entry.y}`) {
    case "DD": return "deleted by us and them";
    case "AU": return "added by us";
    case "UD": return "deleted by them";
    case "UA": return "added by them";
    case "DU": return "deleted by us";
    case "AA": return "both added";
    case "UU": return "both modified";
    default: return "unmerged";
  }
}

async function fileHasConflictMarkers(filePath: string): Promise<boolean> {
  const file = await readBoundedWorkingTreeFile(filePath);
  return file.exists && CONFLICT_MARKER_RE.test(file.content ?? "");
}

async function readBoundedWorkingTreeFile(filePath: string): Promise<{
  exists: boolean;
  content: string | null;
  truncated: boolean;
}> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return { exists: false, content: null, truncated: false };
    }
    const raw = await readFile(filePath, "utf8");
    const bounded = boundText(raw, MAX_FILE_BYTES);
    return { exists: true, content: bounded.text, truncated: bounded.truncated };
  } catch {
    return { exists: false, content: null, truncated: false };
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxBytes) + "\n...[truncated]", truncated: true };
}

function expectBackburnerGitSessionId(value: unknown): string {
  const object = expectObject(value, "tool arguments must be an object");
  return expectString(object.backburnerGitSessionId, '"backburnerGitSessionId" is required');
}

function expectObject(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BackburnerGitToolError("invalid_arguments", message);
  }
  return value;
}

function expectString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BackburnerGitToolError("invalid_arguments", message);
  }
  return value.trim();
}

function expectDiffOptions(value: unknown): { staged: boolean; unstaged: boolean; path?: string } {
  const object = value === undefined ? {} : expectObject(value, '"options" must be an object');
  const staged = object.staged === true;
  const unstaged = object.unstaged !== false;
  const filePath = object.path === undefined ? undefined : expectString(object.path, '"options.path" must be a string');
  return {
    staged,
    unstaged,
    ...(filePath ? { path: filePath } : {})
  };
}

function toFailure(name: string, error: unknown): BrokerToolCallResult {
  if (error instanceof BackburnerGitToolError) {
    return { ok: false, tool: name, error: { code: error.code, message: error.message } };
  }
  return {
    ok: false,
    tool: name,
    error: {
      code: "backburner_git_error",
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

function success(name: string, summary: string, result: Record<string, unknown>): BrokerToolCallResult {
  return { ok: true, tool: name, summary, result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const TOOL_DEFINITIONS: BrokerTool[] = [
  {
    name: "backburner_git_get_state",
    title: "Get Backburner Git state",
    description: "Return scoped Git state for the orchestrator-issued prepare-for-merge Backburner Git session.",
    inputSchema: {
      type: "object",
      properties: { backburnerGitSessionId: { type: "string" } },
      required: ["backburnerGitSessionId"]
    }
  },
  {
    name: "backburner_git_get_conflicts",
    title: "Get Backburner Git conflicts",
    description: "Return conflicted files for the orchestrator-issued prepare-for-merge Backburner Git session.",
    inputSchema: {
      type: "object",
      properties: { backburnerGitSessionId: { type: "string" } },
      required: ["backburnerGitSessionId"]
    }
  },
  {
    name: "backburner_git_get_conflict_versions",
    title: "Get Backburner Git conflict versions",
    description: "Return base, ours, theirs, and current versions for one conflicted or changed path.",
    inputSchema: {
      type: "object",
      properties: { backburnerGitSessionId: { type: "string" }, path: { type: "string" } },
      required: ["backburnerGitSessionId", "path"]
    }
  },
  {
    name: "backburner_git_get_diff",
    title: "Get Backburner Git diff",
    description: "Return a bounded diff for the orchestrator-issued prepare-for-merge Backburner Git session.",
    inputSchema: {
      type: "object",
      properties: {
        backburnerGitSessionId: { type: "string" },
        options: {
          type: "object",
          properties: {
            staged: { type: "boolean" },
            unstaged: { type: "boolean" },
            path: { type: "string" }
          }
        }
      },
      required: ["backburnerGitSessionId"]
    }
  },
  {
    name: "backburner_git_mark_resolved",
    title: "Mark Backburner Git paths resolved",
    description: "Stage resolved paths in the orchestrator-issued merge-conflict Backburner Git session.",
    inputSchema: {
      type: "object",
      properties: { backburnerGitSessionId: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
      required: ["backburnerGitSessionId", "paths"]
    }
  },
  {
    name: "backburner_git_mark_deleted",
    title: "Mark Backburner Git deleted paths resolved",
    description: "Resolve intentional deletions in the orchestrator-issued merge-conflict Backburner Git session.",
    inputSchema: {
      type: "object",
      properties: { backburnerGitSessionId: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
      required: ["backburnerGitSessionId", "paths"]
    }
  },
  {
    name: "backburner_git_unstage",
    title: "Unstage Backburner Git paths",
    description: "Unstage paths in the orchestrator-issued prepare-for-merge Backburner Git session.",
    inputSchema: {
      type: "object",
      properties: { backburnerGitSessionId: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
      required: ["backburnerGitSessionId", "paths"]
    }
  },
  {
    name: "backburner_git_restore_worktree",
    title: "Restore Backburner Git worktree paths",
    description: "Restore tracked unstaged worktree changes from the index without changing staged merge resolutions.",
    inputSchema: {
      type: "object",
      properties: { backburnerGitSessionId: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
      required: ["backburnerGitSessionId", "paths"]
    }
  },
  {
    name: "backburner_git_continue_merge",
    title: "Continue Backburner Git merge",
    description: "Complete the active merge after all conflicts are resolved and the worktree has no unstaged tracked or untracked files. This tool never pushes.",
    inputSchema: {
      type: "object",
      properties: { backburnerGitSessionId: { type: "string" } },
      required: ["backburnerGitSessionId"]
    }
  },
  {
    name: "backburner_git_abort_merge",
    title: "Abort Backburner Git merge",
    description: "Abort the active merge for the orchestrator-issued prepare-for-merge Backburner Git session. This tool never deletes clones.",
    inputSchema: {
      type: "object",
      properties: { backburnerGitSessionId: { type: "string" } },
      required: ["backburnerGitSessionId"]
    }
  }
];
