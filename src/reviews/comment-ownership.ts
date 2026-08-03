import type { NormalizedComment } from "../domain/entities.js";
import type { ReviewSessionRecord } from "./session.js";

export function isOrchestratorOwnedReviewComment(
  comment: NormalizedComment,
  sessions: readonly ReviewSessionRecord[]
): boolean {
  if (comment.body.trimStart().startsWith("🤖")) {
    return true;
  }

  return sessions.some((session) => {
    if (session.repoId !== comment.repoId || session.pullRequestNumber !== comment.parentNumber) {
      return false;
    }
    if (session.terminalComment?.commentId === comment.sourceId) {
      return true;
    }
    return session.publicationReceipts.some((receipt) =>
      receipt.githubId === comment.sourceId ||
      (receipt.ownedCommentIds ?? []).includes(comment.sourceId)
    );
  });
}
