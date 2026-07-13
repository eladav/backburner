import type { WorktreeRecord } from "../../state/types.js";

export type WorkstreamMachineEvent =
  | { type: "WORKSTREAM_INITIALIZED" }
  | { type: "WORKSTREAM_MERGED" }
  | { type: "WORKSTREAM_CLOSED" }
  | { type: "ACTIVE_PR_REVIEW_REQUEST_OBSERVED" }
  | { type: "ACTIVE_PR_PLAN_APPROVAL_OBSERVED" }
  | { type: "PRODUCT_APPROVAL_OBSERVED" }
  | { type: "ACTIVE_PR_PLANNING_LABEL_OBSERVED" }
  | {
      type: "ACTIVE_WORKTREE_STATUS_OBSERVED";
      status: WorktreeRecord["status"];
    }
  | {
      type: "PLANNING_FEEDBACK_OBSERVED";
      source: "issue_comment" | "pr_comment" | "mixed";
    }
  | {
      type: "IMPLEMENTATION_FEEDBACK_OBSERVED";
      source: "issue_comment" | "pr_comment" | "mixed";
    }
  | {
      type: "WORKSTREAM_COMMENT_ATTENTION_OBSERVED";
      source: "issue_comment" | "pr_comment" | "mixed";
    }
  | { type: "contextualFeedbackReceived" }
  | { type: "NO_PHASE_SIGNAL_OBSERVED" }
  | { type: "CANCEL" }
  | { type: "RETRY" };
