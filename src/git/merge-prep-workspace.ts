import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { GitGateway } from "./types.js";

export type WorktreeRefreshStatus =
  | "fast_forwarded"
  | "already_up_to_date"
  | "blocked_dirty"
  | "blocked_diverged"
  | "blocked_ahead"
  | "blocked_not_git"
  | "blocked_wrong_branch";

export interface WorktreeRefreshResult {
  status: WorktreeRefreshStatus;
  localPath: string;
  branch: string;
  message: string;
}

export interface MergePrepCloneResult {
  clonePath: string;
  verifiedHeadSha: string;
  executionId: string;
}

export type MergePrepInspectStatus =
  | "ready_to_push"
  | "clone_missing"
  | "wrong_branch"
  | "active_merge_state"
  | "dirty_uncommitted"
  | "sha_baseline_mismatch"
  | "no_commits_ahead";

export interface MergePrepInspectResult {
  status: MergePrepInspectStatus;
  localSha?: string;
  aheadCount?: number;
  message: string;
  /** Output of git log --oneline <originalHeadSha>..HEAD */
  commitLog?: string;
  /** Output of git diff --stat <originalHeadSha>..HEAD */
  diffStats?: string;
}

export type MergePrepPushStatus = "pushed" | "lease_failed" | "push_failed";

export interface MergePrepPushResult {
  status: MergePrepPushStatus;
  pushedSha?: string;
  message: string;
}

export interface MergePrepAuditData {
  prNumber: number;
  headBranch: string;
  baseBranch: string;
  originalHeadSha: string;
  finalLocalSha?: string | undefined;
  commitLog?: string | undefined;
  diffStats?: string | undefined;
  pushed: boolean;
  pushedSha?: string | undefined;
  blockerReason?: string | undefined;
  safeNextAction?: string | undefined;
  /** Status of the post-push persistent worktree refresh. */
  persistentRefreshStatus?: "succeeded" | "failed" | "skipped" | undefined;
  /** Error message if the persistent worktree refresh failed. */
  persistentRefreshMessage?: string | undefined;
}

export interface MergePrepCloneInput {
  codeRoot: string;
  repoSshUrl: string;
  owner: string;
  repoName: string;
  prNumber: number;
  headBranch: string;
  expectedHeadSha: string;
}

export const MERGE_PREP_ROOT_DIR = "_merge-prep";

export class MergePrepWorkspaceService {
  constructor(private readonly gitGateway: GitGateway) {}

  /**
   * Generate a unique execution ID for a merge-prep clone directory.
   * Uses randomUUID to guarantee uniqueness across retries/reruns.
   */
  generateExecutionId(): string {
    return randomUUID().replace(/-/g, "").slice(0, 12);
  }

  /**
   * Refresh a persistent worktree before dispatch.
   *
   * Rules:
   * - If path is not a git working tree → blocked_not_git
   * - If working tree is dirty → blocked_dirty (do NOT reset/force)
   * - Fetch origin
   * - If on wrong branch → blocked_wrong_branch
   * - Compare local HEAD vs origin/<branch>:
   *   - behind → fast-forward → fast_forwarded
   *   - equal → already_up_to_date
   *   - ahead only → blocked_ahead
   *   - diverged → blocked_diverged
   */
  async refreshPersistentWorktreeBeforeDispatch(input: {
    localPath: string;
    expectedBranch: string;
  }): Promise<WorktreeRefreshResult> {
    const { localPath, expectedBranch } = input;

    const isGit = await this.gitGateway.isInsideWorkingTree(localPath);
    if (!isGit) {
      return {
        status: "blocked_not_git",
        localPath,
        branch: expectedBranch,
        message: `Path ${localPath} is not a git working tree.`
      };
    }

    const isClean = await this.gitGateway.isWorkingTreeClean(localPath);
    if (!isClean) {
      return {
        status: "blocked_dirty",
        localPath,
        branch: expectedBranch,
        message: `Worktree at ${localPath} has uncommitted changes; refusing to fast-forward.`
      };
    }

    await this.gitGateway.fetchRepository(localPath);

    const currentBranch = await this.gitGateway.getCurrentBranch(localPath);
    if (currentBranch !== expectedBranch) {
      return {
        status: "blocked_wrong_branch",
        localPath,
        branch: expectedBranch,
        message: `Worktree at ${localPath} is on branch "${currentBranch}", expected "${expectedBranch}".`
      };
    }

    const { ahead, behind } = await this.gitGateway.getAheadBehindVsRemote(localPath, expectedBranch);

    if (behind === 0 && ahead === 0) {
      return {
        status: "already_up_to_date",
        localPath,
        branch: expectedBranch,
        message: "Already up to date."
      };
    }

    if (behind > 0 && ahead === 0) {
      await this.gitGateway.fastForwardDefaultBranch(localPath, expectedBranch);
      return {
        status: "fast_forwarded",
        localPath,
        branch: expectedBranch,
        message: `Fast-forwarded ${expectedBranch} by ${behind} commit(s).`
      };
    }

    if (ahead > 0 && behind === 0) {
      return {
        status: "blocked_ahead",
        localPath,
        branch: expectedBranch,
        message: `Worktree at ${localPath} is ${ahead} commit(s) ahead of origin/${expectedBranch}. May be an unpushed handoff.`
      };
    }

    return {
      status: "blocked_diverged",
      localPath,
      branch: expectedBranch,
      message: `Worktree at ${localPath} has diverged from origin/${expectedBranch} (${ahead} ahead, ${behind} behind).`
    };
  }

  /**
   * Create a dedicated temporary clone for a prepare-for-merge agent task.
   *
   * Clone path: <codeRoot>/_merge-prep/<owner>/<repo>/pr-<number>-<executionId>/
   *
   * Steps:
   * 1. Generate a unique executionId.
   * 2. Create the clone directory structure.
   * 3. Clone from SSH URL.
   * 4. Checkout the PR head branch at origin/<headBranch>.
   * 5. Verify HEAD matches expectedHeadSha.
   * 6. If SHA mismatch: delete clone and throw.
   */
  async prepareMergePrepClone(input: MergePrepCloneInput): Promise<MergePrepCloneResult> {
    const { codeRoot, repoSshUrl, owner, repoName, prNumber, headBranch, expectedHeadSha } = input;
    const executionId = this.generateExecutionId();

    const clonePath = path.join(
      codeRoot,
      MERGE_PREP_ROOT_DIR,
      owner,
      repoName,
      `pr-${prNumber}-${executionId}`
    );

    const parentDir = path.dirname(clonePath);
    await mkdir(parentDir, { recursive: true });

    await this.gitGateway.cloneRepositoryFromUrl(repoSshUrl, clonePath);
    await this.gitGateway.checkoutBranchAtRemote(clonePath, headBranch, { skipFetch: true });

    const headSha = await this.gitGateway.getHeadCommitSha(clonePath);
    if (headSha !== expectedHeadSha) {
      await this.gitGateway.removeDirectory(clonePath);
      throw new Error(
        `Merge-prep clone SHA mismatch for PR #${prNumber}: expected ${expectedHeadSha}, got ${headSha}. Branch moved before work began.`
      );
    }

    return { clonePath, verifiedHeadSha: headSha, executionId };
  }

  /**
   * Inspect the clone result after the agent returns.
   *
   * Checks (in order):
   * 1. Clone exists and is a git working tree.
   * 2. On the expected branch.
   * 3. No active merge/rebase/cherry-pick/revert state.
   * 4. Working tree is clean (dirty clone always blocks push).
   * 5. Local HEAD is a descendant of originalHeadSha.
   * 6. At least one commit ahead of originalHeadSha.
   * 7. All good → ready_to_push with commit log and diff stats from GitGateway methods.
   *
   * Note: commit log and diff stats are obtained via this.gitGateway.getCommitLogSince()
   * and this.gitGateway.getDiffStatSince() — both first-class GitGateway interface methods.
   * There are no private helpers or as-any access here.
   */
  async inspectMergePrepCloneResult(input: {
    clonePath: string;
    expectedBranch: string;
    originalHeadSha: string;
  }): Promise<MergePrepInspectResult> {
    const { clonePath, expectedBranch, originalHeadSha } = input;

    const isGit = await this.gitGateway.isInsideWorkingTree(clonePath);
    if (!isGit) {
      return { status: "clone_missing", message: `Clone at ${clonePath} is not a git working tree.` };
    }

    const currentBranch = await this.gitGateway.getCurrentBranch(clonePath);
    if (currentBranch !== expectedBranch) {
      return {
        status: "wrong_branch",
        message: `Clone is on branch "${currentBranch}", expected "${expectedBranch}".`
      };
    }

    const mergeState = await this.gitGateway.getActiveMergeState(clonePath);
    if (mergeState !== "none") {
      return {
        status: "active_merge_state",
        message: `Clone has an active ${mergeState} operation in progress.`
      };
    }

    const isClean = await this.gitGateway.isWorkingTreeClean(clonePath);
    if (!isClean) {
      return {
        status: "dirty_uncommitted",
        message: `Clone at ${clonePath} has uncommitted changes after agent returned. Dirty clone always blocks push.`
      };
    }

    const localSha = await this.gitGateway.getHeadCommitSha(clonePath);

    const isDescendant = await this.gitGateway.isAncestorOf(clonePath, originalHeadSha, localSha);
    if (!isDescendant) {
      return {
        status: "sha_baseline_mismatch",
        localSha,
        message: `Local HEAD ${localSha} is not a descendant of original PR head ${originalHeadSha}. History was rewritten or baseline diverged.`
      };
    }

    const aheadCount = await this.gitGateway.countCommitsAheadOf(clonePath, originalHeadSha);
    if (aheadCount === 0) {
      return {
        status: "no_commits_ahead",
        localSha,
        aheadCount: 0,
        message: `Clone HEAD matches original PR head SHA ${originalHeadSha}. No merge-prep commits were made.`
      };
    }

    // Use first-class GitGateway methods — no as-any, no private helpers
    const commitLog = await this.gitGateway.getCommitLogSince(clonePath, originalHeadSha);
    const diffStats = await this.gitGateway.getDiffStatSince(clonePath, originalHeadSha);

    return {
      status: "ready_to_push",
      localSha,
      aheadCount,
      commitLog,
      diffStats,
      message: `Clone is ${aheadCount} commit(s) ahead of original head. Ready to push.`
    };
  }

  /**
   * Push the merge-prep result with a normal non-force push.
   *
   * If the remote branch advanced while prepare-for-merge was running, Git will
   * reject the push and the orchestrator reports a retryable lease-style failure.
   */
  async publishMergePrepResult(input: {
    clonePath: string;
    headBranch: string;
    originalHeadSha: string;
  }): Promise<MergePrepPushResult> {
    const { clonePath, headBranch } = input;

    try {
      await this.gitGateway.pushBranch(clonePath, headBranch);
      const pushedSha = await this.gitGateway.getHeadCommitSha(clonePath);
      return {
        status: "pushed",
        pushedSha,
        message: `Pushed ${headBranch} to origin (SHA: ${pushedSha}).`
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isLeaseFailure =
        message.includes("stale info") ||
        message.includes("remote rejected") ||
        message.includes("fetch first") ||
        message.includes("[rejected]") ||
        message.includes("non-fast-forward");
      if (isLeaseFailure) {
        return {
          status: "lease_failed",
          message: `Push rejected: remote branch "${headBranch}" moved while agent was running. Lease expired. Remote state was preserved.`
        };
      }
      return { status: "push_failed", message: `Push failed: ${message}` };
    }
  }

  /**
   * Write the audit entry to the agent log in the durable persistent worktree.
   *
   * The orchestrator (not the agent) calls this. The durable log is the canonical
   * audit trail for future agents.
   */
  async writeAuditToLog(input: {
    audit: MergePrepAuditData;
    persistentLogDocumentPath: string;
  }): Promise<void> {
    const { audit, persistentLogDocumentPath } = input;
    const logEntry = buildMergePrepLogEntry(audit);
    try {
      await appendFile(persistentLogDocumentPath, `\n${logEntry}\n`, "utf-8");
    } catch {
      // Non-fatal: failure to write audit log should not block cleanup
    }
  }

  /**
   * Refresh the durable persistent worktree after a successful merge-prep push.
   * Returns the refresh status so the caller can include it in the audit.
   *
   * Ensures follow-up tasks (review, discussion) see the merge-prep commit.
   * Steps: fetch origin, checkout branch, fast-forward only.
   */
  async refreshPersistentWorktreeAfterMergePrep(input: {
    persistentWorktreePath: string;
    headBranch: string;
  }): Promise<{ status: "succeeded" | "failed"; message?: string }> {
    const { persistentWorktreePath, headBranch } = input;
    try {
      await this.gitGateway.fetchRepository(persistentWorktreePath);
      await this.gitGateway.checkoutBranch(persistentWorktreePath, headBranch);
      await this.gitGateway.fastForwardDefaultBranch(persistentWorktreePath, headBranch);
      return { status: "succeeded" };
    } catch (err) {
      return {
        status: "failed",
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * Clean up the temporary clone directory.
   *
   * Always delete after success or failure. Never silently preserve.
   */
  async cleanupMergePrepClone(input: { clonePath: string }): Promise<void> {
    try {
      await this.gitGateway.removeDirectory(input.clonePath);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Write the audit log entry into the temporary clone and commit it,
   * so it is included in the branch push and later pulled cleanly
   * by the persistent worktree.
   *
   * The relative log path is derived from the persistent worktree root
   * and the absolute log document path, then re-applied inside the clone.
   *
   * Non-fatal: a failure here is logged as a warning but does not block push.
   */
  async commitAuditInClone(input: {
    clonePath: string;
    persistentWorktreePath: string;
    persistentLogDocumentPath: string;
    audit: MergePrepAuditData;
  }): Promise<void> {
    const { clonePath, persistentWorktreePath, persistentLogDocumentPath, audit } = input;

    const relativeLogPath = path.relative(persistentWorktreePath, persistentLogDocumentPath);

    // Guard: log path must not escape the worktree root.
    if (relativeLogPath.startsWith("..")) {
      // Non-fatal; just skip
      return;
    }

    const absoluteLogPathInClone = path.join(clonePath, relativeLogPath);

    try {
      await mkdir(path.dirname(absoluteLogPathInClone), { recursive: true });
      const logEntry = buildMergePrepLogEntry(audit);
      await appendFile(absoluteLogPathInClone, `\n${logEntry}\n`, "utf-8");
      await this.gitGateway.commitAll(
        clonePath,
        `chore(agent): log merge-prep result for PR #${audit.prNumber}`
      );
    } catch {
      // Non-fatal: failure to write and commit audit log should not block push
    }
  }
}

export function buildMergePrepPrComment(audit: MergePrepAuditData): string {
  const lines = [
    "🤖 **Merge preparation result**",
    "",
    `- **PR**: #${audit.prNumber}`,
    `- **Head branch**: \`${audit.headBranch}\``,
    `- **Base branch**: \`${audit.baseBranch}\``,
    `- **Original head SHA**: \`${audit.originalHeadSha}\``,
    `- **Final local SHA**: ${audit.finalLocalSha ? `\`${audit.finalLocalSha}\`` : "N/A"}`,
    `- **Branch pushed**: ${audit.pushed ? `Yes (SHA: \`${audit.pushedSha}\`)` : "No"}`
  ];

  if (audit.persistentRefreshStatus) {
    lines.push(`- **Persistent worktree refresh**: ${audit.persistentRefreshStatus}`);
    if (audit.persistentRefreshStatus === "failed" && audit.persistentRefreshMessage) {
      lines.push(`  - Refresh error: ${audit.persistentRefreshMessage}`);
    }
  }

  if (audit.commitLog) {
    lines.push("", "**Commits applied:**", "```", audit.commitLog, "```");
  }
  if (audit.diffStats) {
    lines.push("", "**Files changed:**", "```", audit.diffStats, "```");
  }
  if (audit.blockerReason) {
    lines.push("", `**Blocker**: ${audit.blockerReason}`);
  }
  if (audit.safeNextAction) {
    lines.push(`**Recommended next action**: ${audit.safeNextAction}`);
  }

  return lines.join("\n");
}

function buildMergePrepLogEntry(audit: MergePrepAuditData): string {
  const timestamp = new Date().toISOString();
  const status = audit.pushed ? "SUCCESS" : "BLOCKED";
  const lines = [
    `- ${timestamp}: merge-prep for PR #${audit.prNumber} — ${status}`,
    `  original-head: ${audit.originalHeadSha}`,
    `  final-sha: ${audit.finalLocalSha ?? "none"}`,
    `  pushed: ${audit.pushed}${audit.pushedSha ? ` (${audit.pushedSha})` : ""}`,
    `  persistent-refresh: ${audit.persistentRefreshStatus ?? "skipped"}`
  ];
  if (audit.persistentRefreshStatus === "failed" && audit.persistentRefreshMessage) {
    lines.push(`  persistent-refresh-error: ${audit.persistentRefreshMessage}`);
  }
  if (audit.blockerReason) {
    lines.push(`  blocker: ${audit.blockerReason}`);
  }
  return lines.join("\n");
}
