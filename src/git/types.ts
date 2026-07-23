import { mkdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import type { RepoConfig } from "../config/types.js";
import type { GitHubGateway } from "../github/types.js";
import type { RepoSyncRecord } from "../state/types.js";
import type { CommandRunner } from "../utils/command-runner.js";
import { CommandExecutionError } from "../utils/command-runner.js";
import { assertNoSymlinkedPathComponents } from "../utils/path-safety.js";

export type BranchSyncStatus =
  | "up_to_date"
  | "behind_default"
  | "diverged"
  | "missing_parent_branch"
  | "missing_default_branch"
  | "unknown";

export interface BranchSyncComparison {
  parentBranch: string;
  defaultBranch: string;
  parentRef: string;
  defaultRef: string;
  status: BranchSyncStatus;
  parentAheadCount?: number;
  parentBehindCount?: number;
  message: string;
}

export interface GitGateway {
  cloneRepository(repo: RepoConfig, destinationPath: string): Promise<void>;
  fetchRepository(localPath: string): Promise<void>;
  getCurrentBranch(localPath: string): Promise<string | null>;
  getRemoteDefaultBranch(localPath: string): Promise<string>;
  isWorkingTreeClean(localPath: string): Promise<boolean>;
  ensureDefaultBranchCheckedOut(localPath: string, branch: string): Promise<void>;
  fastForwardDefaultBranch(localPath: string, branch: string): Promise<void>;
  validatePathWithinCodeRoot(codeRoot: string, candidatePath: string): string;
  compareBranchSyncStatus(
    localPath: string,
    parentBranch: string,
    defaultBranch: string
  ): Promise<BranchSyncComparison>;
  listWorktrees(repoPath: string): Promise<{ path: string; branch: string }[]>;
  getWorktreeForBranch(repoPath: string, branch: string): Promise<string | null>;
  createWorktree(
    repoPath: string,
    codeRoot: string,
    worktreePath: string,
    branch: string,
    startPoint: string,
    options?: { reuseExistingBranch?: boolean }
  ): Promise<string>;
  getRemoteUrl?(localPath: string, remote: string): Promise<string>;
  hasCommitsAhead(localPath: string, baseRef: string): Promise<boolean>;
  commitAll(localPath: string, message: string): Promise<boolean>;
  pushBranch(localPath: string, branch: string): Promise<void>;
  checkoutBranch(localPath: string, branch: string): Promise<void>;
  mergeRemoteBranch(localPath: string, remote: string, branch: string): Promise<void>;
  abortMerge(localPath: string): Promise<void>;
  abortRebase(localPath: string): Promise<void>;
  abortCherryPick(localPath: string): Promise<void>;
  abortRevert(localPath: string): Promise<void>;
  isInsideWorkingTree(localPath: string): Promise<boolean>;
  pullFastForwardOnly(localPath: string): Promise<void>;
  getHeadCommitSha(localPath: string): Promise<string>;

  /** Clone a repository from an SSH URL into a dedicated local directory. */
  cloneRepositoryFromUrl(sshUrl: string, destinationPath: string): Promise<void>;

  /** Fetch origin then checkout a branch tracking origin/<branch>. */
  checkoutBranchAtRemote(
    localPath: string,
    branch: string,
    options?: { skipFetch?: boolean }
  ): Promise<void>;

  /**
   * Return ahead/behind counts for the current HEAD vs origin/<branch>.
   * "behind" = commits in remote not in local; "ahead" = commits in local not in remote.
   * Uses: git rev-list --left-right --count origin/<branch>...HEAD
   */
  getAheadBehindVsRemote(localPath: string, branch: string): Promise<{ ahead: number; behind: number }>;

  /**
   * Return true if ancestorSha is an ancestor of descendantSha (or equal to it).
   * Returns false if not an ancestor.
   */
  isAncestorOf(localPath: string, ancestorSha: string, descendantSha: string): Promise<boolean>;

  /**
   * Count commits reachable from HEAD that are not reachable from baseSha.
   * Equivalent to: git rev-list --count <baseSha>..HEAD
   */
  countCommitsAheadOf(localPath: string, baseSha: string): Promise<number>;

  /**
   * Detect active merge/rebase/cherry-pick/revert state.
   * Returns "none" if the working tree is in a normal state.
   * Checks: MERGE_HEAD, REBASE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, rebase-merge/ dir, rebase-apply/ dir.
   */
  getActiveMergeState(
    localPath: string
  ): Promise<"none" | "merging" | "rebasing" | "cherry-picking" | "reverting">;

  /**
   * Push branch to origin with force-with-lease protection.
   * Uses: git push --force-with-lease=refs/heads/<branch>:<expectedOldSha> origin HEAD:refs/heads/<branch>
   * Throws if the remote has moved (lease fails).
   */
  pushWithLease(localPath: string, branch: string, expectedOldSha: string): Promise<void>;

  /** Recursively remove a directory (equivalent to rm -rf). Non-fatal if directory does not exist. */
  removeDirectory(dirPath: string): Promise<void>;

  /** Returns one-line git log for commits from baseSha..HEAD. */
  getCommitLogSince(localPath: string, baseSha: string): Promise<string>;

  /** Returns the diff --stat for baseSha..HEAD. */
  getDiffStatSince(localPath: string, baseSha: string): Promise<string>;

  /**
   * Hard-reset the working tree to the given ref.
   * Equivalent to: git reset --hard <ref>
   * Discards staged and unstaged changes but does not touch untracked files.
   */
  resetHard(localPath: string, ref: string): Promise<void>;

  /**
   * Remove all untracked files and directories.
   * Equivalent to: git clean -fd
   */
  cleanUntrackedFiles(localPath: string): Promise<void>;
}

export class GitCliGateway implements GitGateway {
  constructor(private readonly commandRunner: CommandRunner) {}

  async cloneRepository(repo: RepoConfig, destinationPath: string): Promise<void> {
    const parentDir = path.dirname(destinationPath);
    await mkdir(parentDir, { recursive: true });

    await this.commandRunner.run(
      "git",
      ["clone", `git@github.com:${repo.owner}/${repo.name}.git`, destinationPath],
      { cwd: parentDir }
    );
  }

  async fetchRepository(localPath: string): Promise<void> {
    await this.commandRunner.run("git", ["fetch", "--prune", "origin"], {
      cwd: localPath
    });
  }

  async getCurrentBranch(localPath: string): Promise<string | null> {
    try {
      const result = await this.commandRunner.run(
        "git",
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        { cwd: localPath }
      );

      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async getRemoteDefaultBranch(localPath: string): Promise<string> {
    try {
      const result = await this.commandRunner.run(
        "git",
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        { cwd: localPath }
      );
      return stripOriginPrefix(result.stdout.trim());
    } catch {
      const fallback = await this.commandRunner.run("git", ["remote", "show", "origin"], {
        cwd: localPath
      });
      const match = fallback.stdout.match(/HEAD branch:\s+([^\s]+)/);

      if (!match?.[1]) {
        throw new Error(`Could not determine remote default branch for ${localPath}`);
      }

      return match[1];
    }
  }

  async isWorkingTreeClean(localPath: string): Promise<boolean> {
    const result = await this.commandRunner.run("git", ["status", "--porcelain", "."], {
      cwd: localPath
    });
    return result.stdout.trim() === "";
  }

  async ensureDefaultBranchCheckedOut(localPath: string, branch: string): Promise<void> {
    const hasLocalBranch = await this.hasLocalBranch(localPath, branch);

    if (hasLocalBranch) {
      await this.commandRunner.run("git", ["checkout", branch], { cwd: localPath });
      return;
    }

    await this.commandRunner.run(
      "git",
      ["checkout", "-b", branch, "--track", `origin/${branch}`],
      { cwd: localPath }
    );
  }

  async fastForwardDefaultBranch(localPath: string, branch: string): Promise<void> {
    await this.commandRunner.run(
      "git",
      ["branch", "--set-upstream-to", `origin/${branch}`, branch],
      { cwd: localPath }
    );
    await this.commandRunner.run("git", ["merge", "--ff-only", `origin/${branch}`], {
      cwd: localPath
    });
  }

  validatePathWithinCodeRoot(codeRoot: string, candidatePath: string): string {
    return resolvePathWithinCodeRoot(codeRoot, candidatePath);
  }

  async compareBranchSyncStatus(
    localPath: string,
    parentBranch: string,
    defaultBranch: string
  ): Promise<BranchSyncComparison> {
    const defaultRef = this.remoteBranchRef(defaultBranch);
    const parentRef = this.remoteBranchRef(parentBranch);

    const baseComparison: Omit<BranchSyncComparison, "status" | "message"> = {
      parentBranch,
      defaultBranch,
      parentRef,
      defaultRef
    };

    try {
      if (!(await this.hasRef(localPath, parentRef))) {
        return {
          ...baseComparison,
          status: "missing_parent_branch",
          message: "Parent branch ref was not found locally."
        };
      }

      if (!(await this.hasRef(localPath, defaultRef))) {
        return {
          ...baseComparison,
          status: "missing_default_branch",
          message: "Default branch ref was not found locally."
        };
      }

      const result = await this.commandRunner.run(
        "git",
        ["rev-list", "--left-right", "--count", `${defaultRef}...${parentRef}`],
        { cwd: localPath }
      );

      const tokens = result.stdout.trim().split(/\s+/);
      if (tokens.length < 2) {
        return {
          ...baseComparison,
          status: "unknown",
          message: "Could not compare branch sync status."
        };
      }

      const behind = Number(tokens[0]);
      const ahead = Number(tokens[1]);

      if (isNaN(behind) || isNaN(ahead)) {
        return {
          ...baseComparison,
          status: "unknown",
          message: "Could not compare branch sync status."
        };
      }

      const comparison: BranchSyncComparison = {
        ...baseComparison,
        parentAheadCount: ahead,
        parentBehindCount: behind,
        status: "unknown",
        message: ""
      };

      if (behind === 0) {
        comparison.status = "up_to_date";
        comparison.message = "Parent branch contains the default branch.";
      } else if (ahead === 0) {
        comparison.status = "behind_default";
        comparison.message = "Parent branch is behind the default branch.";
      } else {
        comparison.status = "diverged";
        comparison.message = "Parent branch and default branch have diverged.";
      }

      return comparison;
    } catch {
      return {
        ...baseComparison,
        status: "unknown",
        message: "Could not compare branch sync status."
      };
    }
  }

  async listWorktrees(repoPath: string): Promise<{ path: string; branch: string }[]> {
    const result = await this.commandRunner.run("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath
    });

    const worktrees: { path: string; branch: string }[] = [];
    let currentPath = "";

    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ") && currentPath) {
        const branchRef = line.slice("branch ".length).trim();
        const branchName = branchRef.startsWith("refs/heads/")
          ? branchRef.slice("refs/heads/".length)
          : branchRef;
        worktrees.push({ path: currentPath, branch: branchName });
        currentPath = "";
      }
    }

    return worktrees;
  }

  async getWorktreeForBranch(repoPath: string, branch: string): Promise<string | null> {
    const worktrees = await this.listWorktrees(repoPath);
    const match = worktrees.find((wt) => wt.branch === branch);
    return match ? match.path : null;
  }

  async createWorktree(
    repoPath: string,
    codeRoot: string,
    worktreePath: string,
    branch: string,
    startPoint: string,
    options?: { reuseExistingBranch?: boolean }
  ): Promise<string> {
    const safeWorktreePath = resolvePathWithinCodeRoot(codeRoot, worktreePath);
    await assertNoSymlinkedPathComponents(codeRoot, safeWorktreePath);

    if (options?.reuseExistingBranch) {
      await this.commandRunner.run("git", ["worktree", "prune"], { cwd: repoPath });
      const hasLocalBranch = await this.hasLocalBranch(repoPath, branch);
      if (hasLocalBranch) {
        await this.commandRunner.run(
          "git",
          ["worktree", "add", safeWorktreePath, branch],
          { cwd: repoPath }
        );
        return safeWorktreePath;
      }
    }

    await this.commandRunner.run(
      "git",
      ["worktree", "add", "-b", branch, safeWorktreePath, startPoint],
      { cwd: repoPath }
    );
    return safeWorktreePath;
  }

  async getRemoteUrl(localPath: string, remote: string): Promise<string> {
    const result = await this.commandRunner.run(
      "git",
      ["remote", "get-url", remote],
      { cwd: localPath }
    );
    return result.stdout.trim();
  }

  async hasCommitsAhead(localPath: string, baseRef: string): Promise<boolean> {
    const result = await this.commandRunner.run(
      "git",
      ["rev-list", "--count", `${baseRef}..HEAD`],
      { cwd: localPath }
    );
    return Number(result.stdout.trim() || "0") > 0;
  }

  async commitAll(localPath: string, message: string): Promise<boolean> {
    await this.commandRunner.run("git", ["add", "--all", "."], { cwd: localPath });
    const status = await this.commandRunner.run("git", ["status", "--porcelain", "."], {
      cwd: localPath
    });
    if (status.stdout.trim() === "") {
      return false;
    }

    await this.commandRunner.run("git", ["commit", "-m", message, "."], { cwd: localPath });
    return true;
  }

  async pushBranch(localPath: string, branch: string): Promise<void> {
    await this.commandRunner.run("git", ["push", "-u", "origin", branch], { cwd: localPath });
  }

  async checkoutBranch(localPath: string, branch: string): Promise<void> {
    await this.commandRunner.run("git", ["checkout", branch], { cwd: localPath });
  }

  async mergeRemoteBranch(localPath: string, remote: string, branch: string): Promise<void> {
    await this.commandRunner.run("git", ["merge", "--no-edit", `${remote}/${branch}`], {
      cwd: localPath
    });
  }

  async abortMerge(localPath: string): Promise<void> {
    await this.commandRunner.run("git", ["merge", "--abort"], { cwd: localPath });
  }

  async abortRebase(localPath: string): Promise<void> {
    await this.commandRunner.run("git", ["rebase", "--abort"], { cwd: localPath });
  }

  async abortCherryPick(localPath: string): Promise<void> {
    await this.commandRunner.run("git", ["cherry-pick", "--abort"], { cwd: localPath });
  }

  async abortRevert(localPath: string): Promise<void> {
    await this.commandRunner.run("git", ["revert", "--abort"], { cwd: localPath });
  }

  async isInsideWorkingTree(localPath: string): Promise<boolean> {
    try {
      await stat(localPath);
    } catch (err) {
      if (err instanceof Error && (err as any).code === "ENOENT") {
        return false;
      }
      throw err;
    }

    try {
      const result = await this.commandRunner.run("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: localPath
      });
      return result.stdout.trim() === "true";
    } catch (error) {
      if (
        error instanceof CommandExecutionError &&
        error.stderr.includes("not a git repository")
      ) {
        return false;
      }
      throw error;
    }
  }

  async pullFastForwardOnly(localPath: string): Promise<void> {
    await this.commandRunner.run("git", ["pull", "--ff-only"], { cwd: localPath });
  }

  async getHeadCommitSha(localPath: string): Promise<string> {
    const result = await this.commandRunner.run("git", ["rev-parse", "HEAD"], {
      cwd: localPath
    });
    return result.stdout.trim();
  }

  async cloneRepositoryFromUrl(sshUrl: string, destinationPath: string): Promise<void> {
    const parentDir = path.dirname(destinationPath);
    await mkdir(parentDir, { recursive: true });
    await this.commandRunner.run("git", ["clone", sshUrl, destinationPath], { cwd: parentDir });
  }

  async checkoutBranchAtRemote(
    localPath: string,
    branch: string,
    options?: { skipFetch?: boolean }
  ): Promise<void> {
    if (!options?.skipFetch) {
      await this.commandRunner.run("git", ["fetch", "origin"], { cwd: localPath });
    }
    await this.commandRunner.run(
      "git",
      ["checkout", "-B", branch, `origin/${branch}`],
      { cwd: localPath }
    );
  }

  async getAheadBehindVsRemote(
    localPath: string,
    branch: string
  ): Promise<{ ahead: number; behind: number }> {
    // Output format: "<behind>\t<ahead>" (left = behind, right = ahead)
    const result = await this.commandRunner.run(
      "git",
      ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`],
      { cwd: localPath }
    );
    const tokens = result.stdout.trim().split(/\s+/);
    const behind = Number(tokens[0] ?? "0");
    const ahead = Number(tokens[1] ?? "0");
    return {
      behind: isNaN(behind) ? 0 : behind,
      ahead: isNaN(ahead) ? 0 : ahead
    };
  }

  async isAncestorOf(
    localPath: string,
    ancestorSha: string,
    descendantSha: string
  ): Promise<boolean> {
    if (ancestorSha === descendantSha) return true;
    try {
      await this.commandRunner.run(
        "git",
        ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
        { cwd: localPath }
      );
      return true;
    } catch {
      // git merge-base --is-ancestor exits non-zero when ancestorSha is NOT an ancestor
      return false;
    }
  }

  async countCommitsAheadOf(localPath: string, baseSha: string): Promise<number> {
    const result = await this.commandRunner.run(
      "git",
      ["rev-list", "--count", `${baseSha}..HEAD`],
      { cwd: localPath }
    );
    return Number(result.stdout.trim()) || 0;
  }

  async getActiveMergeState(
    localPath: string
  ): Promise<"none" | "merging" | "rebasing" | "cherry-picking" | "reverting"> {
    // Resolve .git directory path (works in both normal clones and linked worktrees)
    const gitDirResult = await this.commandRunner.run(
      "git",
      ["rev-parse", "--git-dir"],
      { cwd: localPath }
    );
    const rawGitDir = gitDirResult.stdout.trim();
    const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(localPath, rawGitDir);

    // Check file-based state indicators
    const fileChecks: Array<[string, "merging" | "rebasing" | "cherry-picking" | "reverting"]> = [
      [path.join(gitDir, "MERGE_HEAD"), "merging"],
      [path.join(gitDir, "REBASE_HEAD"), "rebasing"],
      [path.join(gitDir, "CHERRY_PICK_HEAD"), "cherry-picking"],
      [path.join(gitDir, "REVERT_HEAD"), "reverting"]
    ];
    for (const [filePath, state] of fileChecks) {
      try {
        await stat(filePath);
        return state;
      } catch {
        // file does not exist, continue
      }
    }

    // Check directory-based rebase state indicators
    const dirChecks: Array<[string, "rebasing"]> = [
      [path.join(gitDir, "rebase-merge"), "rebasing"],
      [path.join(gitDir, "rebase-apply"), "rebasing"]
    ];
    for (const [dirPath, state] of dirChecks) {
      try {
        await stat(dirPath);
        return state;
      } catch {
        // directory does not exist, continue
      }
    }

    return "none";
  }

  async pushWithLease(localPath: string, branch: string, expectedOldSha: string): Promise<void> {
    await this.commandRunner.run(
      "git",
      [
        "push",
        `--force-with-lease=refs/heads/${branch}:${expectedOldSha}`,
        "origin",
        `HEAD:refs/heads/${branch}`
      ],
      { cwd: localPath }
    );
  }

  async removeDirectory(dirPath: string): Promise<void> {
    await rm(dirPath, { recursive: true, force: true });
  }

  async getCommitLogSince(localPath: string, baseSha: string): Promise<string> {
    const result = await this.commandRunner.run(
      "git",
      ["log", "--oneline", `${baseSha}..HEAD`],
      { cwd: localPath }
    );
    return result.stdout.trim();
  }

  async getDiffStatSince(localPath: string, baseSha: string): Promise<string> {
    const result = await this.commandRunner.run(
      "git",
      ["diff", "--stat", `${baseSha}..HEAD`],
      { cwd: localPath }
    );
    return result.stdout.trim();
  }

  async resetHard(localPath: string, ref: string): Promise<void> {
    await this.commandRunner.run("git", ["reset", "--hard", ref], { cwd: localPath });
  }

  async cleanUntrackedFiles(localPath: string): Promise<void> {
    await this.commandRunner.run("git", ["clean", "-fd"], { cwd: localPath });
  }

  private remoteBranchRef(branch: string): string {
    return `refs/remotes/origin/${branch}`;
  }

  private async hasRef(localPath: string, ref: string): Promise<boolean> {
    try {
      await this.commandRunner.run("git", ["show-ref", "--verify", "--quiet", ref], {
        cwd: localPath
      });
      return true;
    } catch (error) {
      if (error instanceof CommandExecutionError && error.exitCode === 1) {
        return false;
      }
      throw error;
    }
  }

  private async hasLocalBranch(localPath: string, branch: string): Promise<boolean> {
    try {
      await this.commandRunner.run(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { cwd: localPath }
      );
      return true;
    } catch (error) {
      if (error instanceof CommandExecutionError && error.exitCode === 1) {
        return false;
      }
      throw error;
    }
  }
}

export interface RepoSyncService {
  syncRepository(repo: RepoConfig, codeRoot: string): Promise<RepoSyncRecord>;
}

export class LocalRepoSyncService implements RepoSyncService {
  constructor(
    private readonly gitGateway: GitGateway,
    private readonly gitHubGateway: GitHubGateway,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async syncRepository(repo: RepoConfig, codeRoot: string): Promise<RepoSyncRecord> {
    const localPath = resolvePathWithinCodeRoot(codeRoot, repo.localPath);
    const repoSlug = `${repo.owner}/${repo.name}`;
    const existedBeforeSync = await pathExists(localPath);
    let currentBranchBefore: string | null = null;
    let currentBranchAfter: string | null = null;
    let fetched = false;
    let defaultBranchSyncStatus: NonNullable<RepoSyncRecord["defaultBranchSyncStatus"]> =
      "not_attempted";
    let defaultBranch: string | null = repo.defaultBranch ?? null;
    let defaultBranchSource: RepoSyncRecord["defaultBranchSource"] =
      repo.defaultBranch ? "config" : "unknown";

    try {
      if (!existedBeforeSync) {
        await this.gitGateway.cloneRepository(repo, localPath);
      }

      await this.gitGateway.fetchRepository(localPath);
      fetched = true;
      currentBranchBefore = await this.gitGateway.getCurrentBranch(localPath);

      if (!defaultBranch) {
        try {
          defaultBranch = await this.gitHubGateway.getRepositoryDefaultBranch(repo.owner, repo.name);
          defaultBranchSource = "github";
        } catch {
          defaultBranch = await this.gitGateway.getRemoteDefaultBranch(localPath);
          defaultBranchSource = "git";
        }
      }

      const clean = await this.gitGateway.isWorkingTreeClean(localPath);
      if (!clean) {
        defaultBranchSyncStatus = "blocked_dirty";
        throw new Error("working tree is dirty; refusing to switch or fast-forward the default branch");
      }

      await this.gitGateway.ensureDefaultBranchCheckedOut(localPath, defaultBranch);
      await this.gitGateway.fastForwardDefaultBranch(localPath, defaultBranch);
      defaultBranchSyncStatus = "synced";
      currentBranchAfter = await this.gitGateway.getCurrentBranch(localPath);

      return {
        repoId: repo.id,
        repoName: repo.name,
        repoSlug,
        localPath,
        codeRoot,
        status: "synced",
        existedBeforeSync,
        cloned: !existedBeforeSync,
        fetched,
        defaultBranchSyncStatus,
        defaultBranch,
        defaultBranchSource,
        currentBranchBefore,
        currentBranchAfter,
        syncedAt: this.now(),
        message: !existedBeforeSync
          ? "Repository cloned, fetched, and synchronized to the latest default branch."
          : "Repository fetched and synchronized to the latest default branch."
      };
    } catch (error: unknown) {
      currentBranchAfter = await safeGetCurrentBranch(this.gitGateway, localPath);

      return {
        repoId: repo.id,
        repoName: repo.name,
        repoSlug,
        localPath,
        codeRoot,
        status: "failed",
        existedBeforeSync,
        cloned: !existedBeforeSync && currentBranchAfter !== null,
        fetched,
        defaultBranchSyncStatus:
          defaultBranchSyncStatus === "blocked_dirty" ? "blocked_dirty" : "failed",
        defaultBranch,
        defaultBranchSource,
        currentBranchBefore,
        currentBranchAfter,
        syncedAt: this.now(),
        message: "Repository synchronization failed.",
        error: {
          step: "sync",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }
}

async function safeGetCurrentBranch(
  gitGateway: GitGateway,
  localPath: string
): Promise<string | null> {
  try {
    return await gitGateway.getCurrentBranch(localPath);
  } catch {
    return null;
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

function resolvePathWithinCodeRoot(codeRoot: string, localPath: string): string {
  const resolvedCodeRoot = path.resolve(codeRoot);
  const resolvedRepoPath = path.resolve(resolvedCodeRoot, localPath);
  const relativePath = path.relative(resolvedCodeRoot, resolvedRepoPath);

  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error(`Configured repo path "${localPath}" escapes the code root`);
  }

  return resolvedRepoPath;
}

function stripOriginPrefix(value: string): string {
  return value.startsWith("origin/") ? value.slice("origin/".length) : value;
}
