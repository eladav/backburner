import type { AttentionReason } from "../../state/types.js";
import type { WorkstreamMachineEvent } from "./events.js";
import {
  hasFeedback,
  isAbandoned,
  isReviewRequested,
  isResolved
} from "./selectors.js";
import type { WorkstreamMachineContext } from "./types.js";

type WorkstreamMachineEventRule = {
  derive: (
    input: WorkstreamMachineContext,
    events: WorkstreamMachineEvent[]
  ) => WorkstreamMachineEvent[];
};

export function deriveWorkstreamMachineEvents(
  input: WorkstreamMachineContext
): WorkstreamMachineEvent[] {
  // Repo reconciliation has already resolved the workstream projection; this layer
  // only converts those resolved facts into ordered phase-machine events.
  const events = derivePrimaryPhaseEvents(input);

  for (const rule of eventRules) {
    events.push(...rule.derive(input, events));
  }

  return events;
}

const eventRules: WorkstreamMachineEventRule[] = [
  {
    derive: (input) =>
      input.previousPhase === undefined ? [{ type: "WORKSTREAM_INITIALIZED" }] : []
  },
  {
    derive: (input) =>
      input.attentionReasons.includes("contextual_feedback_received")
        ? [{ type: "contextualFeedbackReceived" }]
        : []
  },
  {
    derive: (_input, events) =>
      hasPhaseSignal(events) ? [] : [{ type: "NO_PHASE_SIGNAL_OBSERVED" }]
  }
];

function derivePrimaryPhaseEvents(input: WorkstreamMachineContext): WorkstreamMachineEvent[] {
  if (isResolved(input)) {
    return [{ type: "WORKSTREAM_MERGED" }];
  }

  if (isAbandoned(input)) {
    return [{ type: "WORKSTREAM_CLOSED" }];
  }

  if (input.attentionReasons.includes("cancel_requested")) {
    return [{ type: "CANCEL" }];
  }

  if (input.attentionReasons.includes("retry_requested")) {
    return [{ type: "RETRY" }];
  }

  if (
    input.attentionReasons.includes("product_approval_observed") &&
    input.activeWorktreeStatus === undefined
  ) {
    return [{ type: "PRODUCT_APPROVAL_OBSERVED" }];
  }

  if (isReviewRequested(input)) {
    return [{ type: "ACTIVE_PR_REVIEW_REQUEST_OBSERVED" }];
  }

  const feedbackSource = hasFeedback(input)
    ? deriveFeedbackSource(input.attentionReasons)
    : undefined;

  if (input.activeWorktreeStatus === "implementing") {
    return feedbackSource === undefined
      ? [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: input.activeWorktreeStatus }]
      : [{ type: "IMPLEMENTATION_FEEDBACK_OBSERVED", source: feedbackSource }];
  }

  if (input.activeWorktreeStatus === "implementation_done") {
    return feedbackSource === undefined
      ? [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: input.activeWorktreeStatus }]
      : [{ type: "IMPLEMENTATION_FEEDBACK_OBSERVED", source: feedbackSource }];
  }

  if (input.activeWorktreeStatus === "implementation_ready") {
    return [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: input.activeWorktreeStatus }];
  }

  if (input.activeWorktreeStatus === "product_specification") {
    return [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: input.activeWorktreeStatus }];
  }

  if (
    input.activeWorktreeStatus === "awaiting_plan_approval" &&
    activePullRequestHasLabel(input, input.approvalLabel)
  ) {
    return [{ type: "ACTIVE_PR_PLAN_APPROVAL_OBSERVED" }];
  }

  if (
    input.activeWorktreeStatus === "planning" ||
    input.activeWorktreeStatus === "awaiting_plan_approval"
  ) {
    return feedbackSource === undefined
      ? [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: input.activeWorktreeStatus }]
      : [{ type: "PLANNING_FEEDBACK_OBSERVED", source: feedbackSource }];
  }

  if (activePullRequestHasLabel(input, input.inProgressLabel)) {
    return feedbackSource === undefined
      ? [{ type: "ACTIVE_PR_PLANNING_LABEL_OBSERVED" }]
      : [{ type: "PLANNING_FEEDBACK_OBSERVED", source: feedbackSource }];
  }

  if (input.activeWorktreeStatus !== undefined) {
    if (feedbackSource !== undefined && isPriorPullRequestImplementationFallback(input)) {
      return [{ type: "IMPLEMENTATION_FEEDBACK_OBSERVED", source: feedbackSource }];
    }

    if (feedbackSource !== undefined) {
      return [{ type: "PLANNING_FEEDBACK_OBSERVED", source: feedbackSource }];
    }

    return [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: input.activeWorktreeStatus }];
  }

  return feedbackSource === undefined
    ? []
    : [{ type: "WORKSTREAM_COMMENT_ATTENTION_OBSERVED", source: feedbackSource }];
}

function activePullRequestHasLabel(
  input: WorkstreamMachineContext,
  label: string | undefined
): boolean {
  // Active PR/worktree events intentionally refer only to the selected active projection.
  return label !== undefined && input.activePullRequestLabels.includes(label);
}

function deriveFeedbackSource(
  reasons: AttentionReason[]
): "issue_comment" | "pr_comment" | "mixed" {
  const hasIssueComment = reasons.some(isIssueCommentFeedback);
  const hasPullRequestComment = reasons.some(isPullRequestCommentFeedback);

  if (hasIssueComment && hasPullRequestComment) {
    return "mixed";
  }

  return hasIssueComment ? "issue_comment" : "pr_comment";
}

function isIssueCommentFeedback(reason: AttentionReason): boolean {
  return reason === "issue_comment_added" || reason === "issue_comment_edited";
}

function isPullRequestCommentFeedback(reason: AttentionReason): boolean {
  return reason === "pr_comment_added" || reason === "pr_comment_edited";
}

function hasPhaseSignal(events: WorkstreamMachineEvent[]): boolean {
  return events.some((event) =>
    event.type !== "WORKSTREAM_INITIALIZED" &&
    event.type !== "WORKSTREAM_COMMENT_ATTENTION_OBSERVED" &&
    event.type !== "contextualFeedbackReceived"
  );
}

function isPriorPullRequestImplementationFallback(input: WorkstreamMachineContext): boolean {
  return (
    input.originType === "pr" &&
    input.activeWorktreeStatus !== undefined &&
    (
      input.previousPhase === "implementation_ready" ||
      input.previousPhase === "implementing" ||
      input.previousPhase === "implementation_done" ||
      input.previousPhase === "implementation_feedback"
    )
  );
}
