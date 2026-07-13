import type {
  WaveAssessmentCheckpoint,
  WaveAssessmentCheckpointIdentity,
  WaveAssessmentDecision,
  WaveAssessmentFinding,
  WaveAssessmentResult
} from "../../state/types.js";

export type {
  WaveAssessmentCheckpoint,
  WaveAssessmentCheckpointIdentity,
  WaveAssessmentDecision,
  WaveAssessmentFinding,
  WaveAssessmentResult
};

export type WaveAssessmentGateStatus = "allowed" | "gated" | "stale";

export type WaveAssessmentGateReason =
  | "assessment_continue_comment_posted"
  | "assessment_missing"
  | "assessment_not_finalized"
  | "assessment_comment_missing"
  | "assessment_requires_replan"
  | "assessment_blocked"
  | "assessment_checkpoint_stale";

export interface WaveAssessmentGateDecision {
  status: WaveAssessmentGateStatus;
  reason: WaveAssessmentGateReason;
  checkpoint: WaveAssessmentCheckpoint;
  assessment?: WaveAssessmentResult | undefined;
}
