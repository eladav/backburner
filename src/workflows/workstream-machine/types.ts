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
  inProgressLabel: string | undefined;
  reviewLabel: string | undefined;
  approvalLabel: string | undefined;
  activeWorktreeStatus: WorktreeRecord["status"] | undefined;
  status: WorkstreamStatus;
  resolution: WorkstreamResolution;
}
