import type {
  AttentionReason,
  WorkstreamPhase,
  WorkstreamResolution,
  WorkstreamStatus,
  WorktreeRecord
} from "../../state/types.js";

export interface WorkstreamMachineContext {
  previousPhase: WorkstreamPhase | undefined;
  originType: "issue" | "pr";
  issuePresent: boolean;
  activePullRequestState: "open" | "closed" | "merged" | undefined;
  activePullRequestLabels: string[];
  attentionReasons: AttentionReason[];
  /**
   * The review label is authorization, while this projection says whether the
   * active PR head still needs a review session. A terminal session for the
   * current head clears this even when the label remains applied.
   */
  reviewOutstandingForActiveHead?: boolean;
  inProgressLabel: string | undefined;
  reviewLabel: string | undefined;
  approvalLabel: string | undefined;
  activeWorktreeStatus: WorktreeRecord["status"] | undefined;
  status: WorkstreamStatus;
  resolution: WorkstreamResolution;
}
