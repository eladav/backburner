import type { GitGateway } from "../git/types.js";
import type { WorkspaceRecoveryRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { validateWorkspaceOwnership } from "./workspace-ownership.js";

/**
 * Service responsible for recovering agent workspaces after a failure.
 *
 * It ensures that a task-owned workspace is returned to a clean state
 * (synced with its remote branch and free of untracked files) so that
 * subsequent orchestrator turns can safely reuse or refresh it.
 */
export class WorkspaceRecoveryService {
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  /**
   * Resolves the absolute path to the workspace owned by a task, if any.
   *
   * @param task The task record to inspect.
   * @returns The absolute workspace path, or null if the task does not use a persistent local workspace.
   */
  resolveTaskWorkspacePath(task: TaskRecord): string | null {
    switch (task.kind) {
      case "implement_plan":
      case "write_plan":
      case "respond_pr_comment":
      case "fix_review_finding":
        return task.context.localRepoPath ?? null;
      case "prepare_pr_for_merge":
        return task.context.prepareForMerge?.persistentWorktreePath ?? null;
      default:
        // Other task kinds (triage, review, breakdown, sync preflight) are either
        // read-only or do not own a dedicated persistent worktree.
        return null;
    }
  }

  /**
   * Resolves the branch name associated with a task for recovery purposes.
   *
   * @param task The task record to inspect.
   * @returns The branch name, or null if none can be resolved.
   */
  private resolveTaskBranch(task: TaskRecord): string | null {
    if (task.kind === "prepare_pr_for_merge") {
      return task.context.prepareForMerge?.headBranch ?? null;
    }
    return task.context.branchName ?? null;
  }

  /**
   * Returns true if the task association requires workspace recovery.
   *
   * Triggers:
   * 1. Task status is "failed" (traditional technical failure) AND it has a path.
   * 2. Task context has "recoveryNeeded: true" (explicitly set during retry derivation).
   *
   * @param task The task record to inspect.
   */
  isRecoveryNeeded(task: TaskRecord): boolean {
    const explicitRecovery = task.context.recoveryNeeded === true;
    if (explicitRecovery) {
      return true;
    }

    // Explicitly recovered in the current cycle or a previous turn.
    if (task.context.recoveryNeeded === false) {
      return false;
    }

    const hasPath = this.resolveTaskWorkspacePath(task) !== null;
    const isFailed = task.status === "failed";

    return isFailed && hasPath;
  }

  /**
   * Performs the recovery of a task's workspace.
   *
   * 1. Validates that the workspace path is owned by the orchestrator.
   * 2. Verifies it is a valid git working tree.
   * 3. Aborts any in-progress merge.
   * 4. Ensures the correct branch is checked out.
   * 5. Performs a hard reset to origin/<branch> (branch may be derived from
   *    the workspace's current branch if the task context has none; fails
   *    explicitly if no branch can be determined).
   * 6. Cleans untracked files and directories.
   *
   * @param opts Recovery options.
   * @returns A record summarizing the recovery outcome.
   */
  async recoverWorkspace(opts: {
    task: TaskRecord;
    codeRoot: string;
    gitGateway: GitGateway;
  }): Promise<WorkspaceRecoveryRecord> {
    const { task, codeRoot, gitGateway } = opts;
    const workspacePath = this.resolveTaskWorkspacePath(task);

    if (!workspacePath) {
      return {
        taskId: task.id,
        taskKind: task.kind,
        outcome: "skipped",
        reason: "Task has no associated workspace path.",
        recoveredAt: this.now(),
      };
    }

    const ownership = validateWorkspaceOwnership(workspacePath, codeRoot);
    if (!ownership.valid) {
      return {
        taskId: task.id,
        taskKind: task.kind,
        workspacePath,
        outcome: "rejected",
        reason: ownership.reason,
        recoveredAt: this.now(),
      };
    }

    try {
      const isGit = await gitGateway.isInsideWorkingTree(workspacePath);
      if (!isGit) {
        return {
          taskId: task.id,
          taskKind: task.kind,
          workspacePath,
          outcome: "failed",
          reason: `Path "${workspacePath}" is not a git working tree.`,
          recoveredAt: this.now(),
        };
      }

      await gitGateway.fetchRepository(workspacePath);

      // Abort any in-progress merge state before resetting.
      const mergeState = await gitGateway.getActiveMergeState(workspacePath);
      if (mergeState === "merging") {
        await gitGateway.abortMerge(workspacePath);
      } else if (mergeState === "rebasing") {
        await gitGateway.abortRebase(workspacePath);
      } else if (mergeState === "cherry-picking") {
        await gitGateway.abortCherryPick(workspacePath);
      } else if (mergeState === "reverting") {
        await gitGateway.abortRevert(workspacePath);
      }

      const currentBranch = await gitGateway.getCurrentBranch(workspacePath);
      let branch = this.resolveTaskBranch(task);

      if (!branch) {
        // No branch in task context (e.g. write_plan/implement_plan tasks
        // derived from a repoSyncRecord without an active worktree). Fall back
        // to whatever branch the workspace is currently on so we can reset to
        // its remote ref instead of leaving local-only commits ahead of origin.
        branch = currentBranch;
      }

      if (!branch) {
        return {
          taskId: task.id,
          taskKind: task.kind,
          workspacePath,
          outcome: "failed",
          reason:
            "Cannot recover: task has no associated branch name and the workspace is not currently on a branch (detached HEAD).",
          recoveredAt: this.now(),
        };
      }

      if (currentBranch !== branch) {
        await gitGateway.checkoutBranch(workspacePath, branch);
      }
      await gitGateway.resetHard(workspacePath, `origin/${branch}`);

      await gitGateway.cleanUntrackedFiles(workspacePath);

      return {
        taskId: task.id,
        taskKind: task.kind,
        workspacePath,
        outcome: "recovered",
        reason: `Workspace at "${workspacePath}" reset and cleaned.`,
        recoveredAt: this.now(),
      };
    } catch (err: unknown) {
      return {
        taskId: task.id,
        taskKind: task.kind,
        workspacePath,
        outcome: "failed",
        reason: err instanceof Error ? err.message : String(err),
        recoveredAt: this.now(),
      };
    }
  }
}
