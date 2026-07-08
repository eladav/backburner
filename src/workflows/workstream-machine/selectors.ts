import type { AttentionReason } from "../../state/types.js";
import type { WorkstreamMachineContext } from "./types.js";

export function isResolved(context: WorkstreamMachineContext): boolean {
  return context.resolution === "merged";
}

export function isAbandoned(context: WorkstreamMachineContext): boolean {
  return context.status === "closed";
}

export function isReviewRequested(context: WorkstreamMachineContext): boolean {
  return (
    context.reviewLabel !== undefined &&
    context.activePullRequestLabels.includes(context.reviewLabel)
  );
}

export function hasFeedback(context: WorkstreamMachineContext): boolean {
  return hasFeedbackAttention(context.attentionReasons);
}

function hasFeedbackAttention(reasons: AttentionReason[]): boolean {
  return reasons.some((reason) =>
    reason === "issue_comment_added" ||
    reason === "issue_comment_edited" ||
    reason === "pr_comment_added" ||
    reason === "pr_comment_edited"
  );
}
