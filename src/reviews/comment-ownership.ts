import type { NormalizedComment } from "../domain/entities.js";
import type { ReviewSessionRecord } from "./session.js";

export function isOrchestratorOwnedReviewComment(
  comment: NormalizedComment,
  sessions: readonly ReviewSessionRecord[]
): boolean {
  return sessions.some((session) => {
    if (
      comment.parentType !== "pull_request" ||
      session.repoId !== comment.repoId ||
      session.pullRequestNumber !== comment.parentNumber
    ) {
      return false;
    }
    if (
      session.terminalComment?.commentId === comment.sourceId &&
      receiptAuthorMatches(session.terminalComment.authorLogin, comment.author)
    ) {
      return true;
    }
    if (session.ownedComments.some((receipt) =>
      receipt.commentId === comment.sourceId && receiptAuthorMatches(receipt.authorLogin, comment.author)
    )) return true;
    return session.publicationReceipts.some((receipt) =>
      receiptAuthorMatches(receipt.authorLogin, comment.author) &&
      (receipt.githubId === comment.sourceId || receipt.ownedCommentIds.includes(comment.sourceId))
    );
  });
}

export function isTrackedReviewCycleThread(
  comment: NormalizedComment,
  sessions: readonly ReviewSessionRecord[]
): boolean {
  return comment.parentType === "pull_request" && sessions.some((session) =>
    session.repoId === comment.repoId && session.pullRequestNumber === comment.parentNumber
  );
}

function receiptAuthorMatches(receiptAuthor: string | undefined, commentAuthor: string): boolean {
  return receiptAuthor !== undefined && receiptAuthor.toLowerCase() === commentAuthor.toLowerCase();
}
