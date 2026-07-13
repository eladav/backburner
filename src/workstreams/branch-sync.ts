import type { BranchSyncComparison } from "../git/types.js";
import type { WaveAssessmentResult, WorkstreamRecord } from "../state/types.js";
import type { ParentBranchSyncPreflight } from "../tasks/types.js";
import {
  decideWaveAssessmentGate,
  isWaveAssessmentStaleForPreflight
} from "./wave-assessment/checkpoint.js";
import type { WaveAssessmentGateDecision } from "./wave-assessment/types.js";
import {
  advanceReadyWorkstreamPacketWaves,
  type AdvanceReadyWorkstreamPacketWavesResult
} from "./packet-plan.js";

export type BranchSyncRecommendation =
  | "ready_to_advance"
  | "sync_parent_from_default"
  | "manual_conflict_aware_sync_required"
  | "blocked_missing_ref"
  | "blocked_unknown";

export type BranchSyncComparisonSkippedReason = "missing_local_path";

export interface ParentBranchSyncPreflightEvaluationInput {
  preflight: ParentBranchSyncPreflight;
  branchSyncComparison?: BranchSyncComparison | undefined;
  branchSyncComparisonSkippedReason?: BranchSyncComparisonSkippedReason | undefined;
}

export interface PacketWaveAdvancementEvaluation {
  readyWorkstreamIds: string[];
  waveAssessmentGates: WaveAssessmentGateDecision[];
  result: AdvanceReadyWorkstreamPacketWavesResult;
}

export function findWaveAssessmentForPreflight(
  preflight: ParentBranchSyncPreflight,
  assessments: WaveAssessmentResult[]
): WaveAssessmentResult | undefined {
  const matchingAssessments = assessments.filter(
    (assessment) => assessment.checkpoint.identity.workstreamId === preflight.workstreamId
  );
  const currentAssessment = matchingAssessments
    .filter((assessment) => !isWaveAssessmentStaleForPreflight(assessment, preflight))
    .sort(compareWaveAssessmentsNewestFirst)[0];

  if (currentAssessment) {
    return currentAssessment;
  }

  return matchingAssessments.sort(compareWaveAssessmentsNewestFirst)[0];
}

function compareWaveAssessmentsNewestFirst(
  left: WaveAssessmentResult,
  right: WaveAssessmentResult
): number {
  const timestampComparison = compareAssessmentTimestampDesc(
    waveAssessmentOrderingTimestamp(left),
    waveAssessmentOrderingTimestamp(right)
  );
  if (timestampComparison !== 0) {
    return timestampComparison;
  }

  return right.id.localeCompare(left.id);
}

function waveAssessmentOrderingTimestamp(assessment: WaveAssessmentResult): string {
  return assessment.updatedAt ?? assessment.finalizedAt ?? assessment.createdAt ?? "";
}

function compareAssessmentTimestampDesc(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  return right.localeCompare(left);
}

/**
 * Recommends an action for a parent branch synchronization preflight based on branch comparison status.
 */
export function recommendBranchSyncAction(
  comparison: BranchSyncComparison | undefined,
  skippedReason?: BranchSyncComparisonSkippedReason
): BranchSyncRecommendation {
  if (skippedReason === "missing_local_path") {
    return "blocked_unknown";
  }

  if (!comparison) {
    return "blocked_unknown";
  }

  switch (comparison.status) {
    case "up_to_date":
      return "ready_to_advance";
    case "behind_default":
      return "sync_parent_from_default";
    case "diverged":
      return "manual_conflict_aware_sync_required";
    case "missing_parent_branch":
    case "missing_default_branch":
      return "blocked_missing_ref";
    case "unknown":
    default:
      return "blocked_unknown";
  }
}

/**
 * Evaluates which workstreams are ready for packet-wave advancement based on parent branch sync status.
 * Delegates actual advancement to advanceReadyWorkstreamPacketWaves.
 */
export function evaluatePacketWaveAdvancement(input: {
  workstreams: WorkstreamRecord[];
  parentBranchSyncPreflights: ParentBranchSyncPreflightEvaluationInput[];
  waveAssessments?: WaveAssessmentResult[] | undefined;
}): PacketWaveAdvancementEvaluation {
  const waveAssessments = input.waveAssessments ?? [];
  const waveAssessmentGates: WaveAssessmentGateDecision[] = [];
  const readyWorkstreamIds: string[] = [];

  for (const item of input.parentBranchSyncPreflights) {
    const branchIsReady =
      recommendBranchSyncAction(
        item.branchSyncComparison,
        item.branchSyncComparisonSkippedReason
      ) === "ready_to_advance";

    if (!branchIsReady) {
      continue;
    }

    const gate = decideWaveAssessmentGate({
      preflight: item.preflight,
      assessment: findWaveAssessmentForPreflight(item.preflight, waveAssessments)
    });
    waveAssessmentGates.push(gate);

    if (gate.status === "allowed") {
      readyWorkstreamIds.push(item.preflight.workstreamId);
    }
  }

  const workstreamsById = Object.fromEntries(
    input.workstreams.map((workstream) => [workstream.id, workstream])
  );

  return {
    readyWorkstreamIds,
    waveAssessmentGates,
    result: advanceReadyWorkstreamPacketWaves({
      workstreams: workstreamsById,
      readyWorkstreamIds
    })
  };
}
