import type { NormalizedPullRequest } from "../../../domain/entities.js";
import type { WorkstreamRecord, WorktreeRecord } from "../../../state/types.js";

export function isActiveParentWorkstream(workstream: WorkstreamRecord): boolean {
  return (
    workstream.status === "open" &&
    workstream.phase !== "abandoned" &&
    workstream.phase !== "resolved"
  );
}

export function resolvePacketPullRequest(
  worktree: WorktreeRecord,
  currentPrsByRepoAndNumber: Map<string, NormalizedPullRequest>
): NormalizedPullRequest | undefined {
  if (worktree.prNumber !== undefined) {
    const pr = currentPrsByRepoAndNumber.get(`${worktree.repoSlug}:${worktree.prNumber}`);
    if (pr) {
      return pr;
    }
  }

  if (worktree.prUrl) {
    const match = worktree.prUrl.match(/\/pull\/(\d+)$/);
    if (match) {
      const prNumber = Number(match[1]);
      const pr = currentPrsByRepoAndNumber.get(`${worktree.repoSlug}:${prNumber}`);
      if (pr) {
        return pr;
      }
    }
  }

  return undefined;
}
