import type {
  AttentionReason,
  WorkstreamPhase,
  WorkstreamResolution,
  WorkstreamStatus,
  WorktreeRecord
} from "../state/types.js";
import { evaluateWorkstreamMachine } from "../workflows/workstream-machine/evaluate.js";

export interface WorkstreamPhaseReducerInput {
  previousPhase: WorkstreamPhase | undefined;
  originType: "issue" | "pr";
  issuePresent: boolean;
  activePullRequestState: "open" | "closed" | "merged" | undefined;
  activePullRequestLabels: string[];
  attentionReasons: AttentionReason[];
  reviewOutstandingForActiveHead?: boolean;
  inProgressLabel: string | undefined;
  reviewLabel: string | undefined;
  approvalLabel: string | undefined;
  activeWorktreeStatus: WorktreeRecord["status"] | undefined;
  status: WorkstreamStatus;
  resolution: WorkstreamResolution;
}

export function reduceWorkstreamPhase(input: WorkstreamPhaseReducerInput): WorkstreamPhase {
  return evaluateWorkstreamMachine(input);
}
