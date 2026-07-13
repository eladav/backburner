import type { BranchSyncComparison, GitGateway } from "../git/types.js";
import type { ParentBranchSyncStatus } from "../state/types.js";

export interface ParentBranchSyncResult {
  status: ParentBranchSyncStatus;
  message: string;
  comparison?: BranchSyncComparison;
  error?: string;
}

export interface ParentBranchSyncService {
  syncParentBranch(
    localPath: string,
    parentBranch: string,
    defaultBranch: string
  ): Promise<ParentBranchSyncResult>;
}

export class LocalParentBranchSyncService implements ParentBranchSyncService {
  constructor(private readonly gitGateway: GitGateway) {}

  async syncParentBranch(
    localPath: string,
    parentBranch: string,
    defaultBranch: string
  ): Promise<ParentBranchSyncResult> {
    let initialComparison: BranchSyncComparison | undefined;
    try {
      await this.gitGateway.fetchRepository(localPath);

      if (!(await this.gitGateway.isWorkingTreeClean(localPath))) {
        return {
          status: "blocked",
          message: "Working tree is dirty; refusing to sync parent branch."
        };
      }

      initialComparison = await this.gitGateway.compareBranchSyncStatus(
        localPath,
        parentBranch,
        defaultBranch
      );

      if (initialComparison.status === "up_to_date") {
        return {
          status: "already_up_to_date",
          message: "Parent branch is already up to date with the default branch.",
          comparison: initialComparison
        };
      }

      if (
        initialComparison.status === "missing_parent_branch" ||
        initialComparison.status === "missing_default_branch" ||
        initialComparison.status === "unknown"
      ) {
        return {
          status: "blocked",
          message: initialComparison.message,
          comparison: initialComparison
        };
      }

      // If we are here, status is "behind_default" or "diverged"
      const originalBranch = await this.gitGateway.getCurrentBranch(localPath);

      // Check if parentBranch is already checked out in another worktree
      const parentBranchWorktreePath = await this.gitGateway.getWorktreeForBranch(localPath, parentBranch);
      const syncPath = parentBranchWorktreePath || localPath;

      if (syncPath !== localPath && !(await this.gitGateway.isWorkingTreeClean(syncPath))) {
        return {
          status: "blocked",
          message: `Parent branch is checked out in a dirty worktree at "${syncPath}"; refusing to sync parent branch.`
        };
      }

      let syncResult: ParentBranchSyncResult | undefined;

      try {
        if (!parentBranchWorktreePath && originalBranch !== parentBranch) {
          await this.gitGateway.checkoutBranch(localPath, parentBranch);
        }

        // Ensure local parentBranch is up to date with its remote counterpart before merging
        syncResult = await this.performMerge(
          syncPath,
          parentBranch,
          "pre-merging parent branch from remote",
          initialComparison
        );

        if (!syncResult) {
          syncResult = await this.performMerge(
            syncPath,
            defaultBranch,
            "syncing parent branch with default branch",
            initialComparison
          );
        }

        if (!syncResult) {
          await this.gitGateway.pushBranch(syncPath, parentBranch);

          // Fetch again to ensure refreshed comparison uses the latest remote state
          await this.gitGateway.fetchRepository(localPath);

          const refreshedComparison = await this.gitGateway.compareBranchSyncStatus(
            localPath,
            parentBranch,
            defaultBranch
          );

          if (refreshedComparison.status === "up_to_date") {
            syncResult = {
              status: "synced",
              message: "Parent branch successfully synced with the default branch.",
              comparison: refreshedComparison
            };
          } else {
            syncResult = {
              status: "failed",
              message: `Refreshed comparison shows status "${refreshedComparison.status}" instead of "up_to_date": ${refreshedComparison.message}`,
              comparison: refreshedComparison
            };
          }
        }
      } catch (error) {
        syncResult = {
          status: "failed",
          message: "An unexpected error occurred while syncing parent branch.",
          comparison: initialComparison,
          error: error instanceof Error ? error.message : String(error)
        };
      }

      // Cleanup phase: restore original branch and verify cleanliness
      // Only if we were operating in the original localPath and we actually switched branches
      if (!parentBranchWorktreePath && originalBranch && originalBranch !== parentBranch) {
        try {
          await this.gitGateway.checkoutBranch(localPath, originalBranch);
        } catch (checkoutError) {
          return {
            status: "failed",
            message: `Sync status was ${syncResult?.status || "unknown"}; however, failed to return to original branch "${originalBranch}".`,
            comparison: syncResult?.comparison || initialComparison,
            error: checkoutError instanceof Error ? checkoutError.message : String(checkoutError)
          };
        }
      }

      if (!(await this.gitGateway.isWorkingTreeClean(syncPath))) {
        return {
          status: "failed",
          message: `Sync status was ${syncResult?.status || "unknown"}; however, the working tree at "${syncPath}" is dirty after cleanup.`,
          comparison: syncResult?.comparison || initialComparison
        };
      }

      return syncResult || { status: "failed", message: "Sync process failed to produce a result." };
    } catch (outerError) {
      return {
        status: "failed",
        message: "An unexpected error occurred in the sync service.",
        ...(initialComparison ? { comparison: initialComparison } : {}),
        error: outerError instanceof Error ? outerError.message : String(outerError)
      };
    }
  }

  private async performMerge(
    localPath: string,
    branch: string,
    phaseName: string,
    initialComparison?: BranchSyncComparison
  ): Promise<ParentBranchSyncResult | undefined> {
    try {
      await this.gitGateway.mergeRemoteBranch(localPath, "origin", branch);
      return undefined;
    } catch (mergeError) {
      try {
        await this.gitGateway.abortMerge(localPath);
      } catch (abortError) {
        return {
          status: "failed",
          message: `An error occurred during ${phaseName} and aborting the merge failed.`,
          ...(initialComparison ? { comparison: initialComparison } : {}),
          error: `Merge error: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}. Abort error: ${abortError instanceof Error ? abortError.message : String(abortError)}`
        };
      }

      // If abort succeeded, it was likely a merge conflict, but we check if the error message suggests something else
      const errorMessage = mergeError instanceof Error ? mergeError.message : String(mergeError);
      const lowerMessage = errorMessage.toLowerCase();
      const isConflict =
        lowerMessage.includes("conflict") ||
        lowerMessage.includes("automatic merge failed");

      return {
        status: isConflict ? "conflict" : "failed",
        message: isConflict
          ? `Merge conflict occurred while ${phaseName}; merge aborted.`
          : `Merge failed while ${phaseName}; merge aborted.`,
        ...(initialComparison ? { comparison: initialComparison } : {}),
        error: errorMessage
      };
    }
  }
}

