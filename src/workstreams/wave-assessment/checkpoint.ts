import { createHash } from "node:crypto";
import type { ParentBranchSyncPreflight } from "../../tasks/types.js";
import type {
  WaveAssessmentCheckpoint,
  WaveAssessmentCheckpointIdentity,
  WaveAssessmentResult
} from "./types.js";
import type { WorkstreamRecord } from "../../state/types.js";
import type { WaveAssessmentGateDecision } from "./types.js";

export function buildWaveAssessmentCheckpointIdentity(
  preflight: ParentBranchSyncPreflight,
  extra?: {
    parentHeadSha?: string | undefined;
    planRevision?: string | undefined;
    originalPlanningSessionId?: string | undefined;
    planNodeIds?: string[] | undefined;
  }
): WaveAssessmentCheckpointIdentity {
  return {
    repoKey: preflight.repoKey,
    workstreamId: preflight.workstreamId,
    waveId: `wave-${preflight.currentWaveIndex}`,
    parentPrNumber: preflight.parentPrNumber ?? 0,
    parentHeadSha: extra?.parentHeadSha ?? preflight.parentHeadSha ?? "unknown",
    parentIntegrationBranch: preflight.parentIntegrationBranch,
    defaultBranch: preflight.defaultBranch,
    planRevision: extra?.planRevision ?? preflight.planRevision ?? "unknown",
    originalPlanningSessionId:
      extra?.originalPlanningSessionId ?? preflight.originalPlanningSessionId ?? "unknown",
    currentWaveIndex: preflight.currentWaveIndex,
    nextWaveIndex: preflight.nextWaveIndex,
    completedPacketIds: [...preflight.completedPacketIds],
    pendingFuturePacketIds: [...preflight.pendingFuturePacketIds],
    planNodeIds: [
      ...(extra?.planNodeIds ??
        preflight.planNodeIds ?? [...preflight.completedPacketIds, ...preflight.pendingFuturePacketIds])
    ]
  };
}

export function buildWaveAssessmentCheckpoint(
  identity: WaveAssessmentCheckpointIdentity
): WaveAssessmentCheckpoint {
  const identityHash = createHash("sha256")
    .update(stableStringifyIdentity(identity))
    .digest("hex")
    .slice(0, 16);
  const id = [
    "wave-assessment",
    truncateIdPart(sanitizeIdPart(identity.repoKey), 40),
    truncateIdPart(sanitizeIdPart(identity.workstreamId), 60),
    `wave-${identity.currentWaveIndex}-to-${identity.nextWaveIndex}`,
    `pr-${identity.parentPrNumber}`,
    identityHash
  ].join(":");

  return {
    id,
    sessionId: id,
    identity
  };
}

export function buildWaveAssessmentCheckpointForPreflight(
  preflight: ParentBranchSyncPreflight
): WaveAssessmentCheckpoint {
  return buildWaveAssessmentCheckpoint(buildWaveAssessmentCheckpointIdentity(preflight));
}

export function waveAssessmentCheckpointIdentityMatches(
  left: WaveAssessmentCheckpointIdentity,
  right: WaveAssessmentCheckpointIdentity
): boolean {
  return (
    left.repoKey === right.repoKey &&
    left.workstreamId === right.workstreamId &&
    left.waveId === right.waveId &&
    left.parentPrNumber === right.parentPrNumber &&
    left.parentHeadSha === right.parentHeadSha &&
    left.parentIntegrationBranch === right.parentIntegrationBranch &&
    left.defaultBranch === right.defaultBranch &&
    left.planRevision === right.planRevision &&
    left.originalPlanningSessionId === right.originalPlanningSessionId &&
    left.currentWaveIndex === right.currentWaveIndex &&
    left.nextWaveIndex === right.nextWaveIndex &&
    arraysEqual(left.completedPacketIds, right.completedPacketIds) &&
    arraysEqual(left.pendingFuturePacketIds, right.pendingFuturePacketIds) &&
    arraysEqual(left.planNodeIds, right.planNodeIds)
  );
}

export function isWaveAssessmentStaleForPreflight(
  assessment: WaveAssessmentResult,
  preflight: ParentBranchSyncPreflight
): boolean {
  const checkpoint = buildWaveAssessmentCheckpointForPreflight(preflight);
  return !waveAssessmentCheckpointIdentityMatches(
    assessment.checkpoint.identity,
    checkpoint.identity
  );
}

export function decideWaveAssessmentGate(input: {
  preflight: ParentBranchSyncPreflight;
  assessment?: WaveAssessmentResult | undefined;
}): WaveAssessmentGateDecision {
  const checkpoint = buildWaveAssessmentCheckpointForPreflight(input.preflight);
  const { assessment } = input;

  if (!assessment) {
    return { status: "gated", reason: "assessment_missing", checkpoint };
  }

  if (!waveAssessmentCheckpointIdentityMatches(assessment.checkpoint.identity, checkpoint.identity)) {
    return {
      status: "stale",
      reason: "assessment_checkpoint_stale",
      checkpoint,
      assessment
    };
  }

  if (assessment.status !== "finalized") {
    return {
      status: "gated",
      reason: "assessment_not_finalized",
      checkpoint,
      assessment
    };
  }

  if (assessment.decision === "replan") {
    return {
      status: "gated",
      reason: "assessment_requires_replan",
      checkpoint,
      assessment
    };
  }

  if (assessment.decision === "blocked") {
    return {
      status: "gated",
      reason: "assessment_blocked",
      checkpoint,
      assessment
    };
  }

  if (!assessment.postedCommentId) {
    return {
      status: "gated",
      reason: "assessment_comment_missing",
      checkpoint,
      assessment
    };
  }

  return {
    status: "allowed",
    reason: "assessment_continue_comment_posted",
    checkpoint,
    assessment
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "none";
}

function truncateIdPart(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function stableStringifyIdentity(identity: WaveAssessmentCheckpointIdentity): string {
  return JSON.stringify({
    repoKey: identity.repoKey,
    workstreamId: identity.workstreamId,
    waveId: identity.waveId,
    parentPrNumber: identity.parentPrNumber,
    parentHeadSha: identity.parentHeadSha,
    parentIntegrationBranch: identity.parentIntegrationBranch,
    defaultBranch: identity.defaultBranch,
    planRevision: identity.planRevision,
    originalPlanningSessionId: identity.originalPlanningSessionId,
    currentWaveIndex: identity.currentWaveIndex,
    nextWaveIndex: identity.nextWaveIndex,
    completedPacketIds: identity.completedPacketIds,
    pendingFuturePacketIds: identity.pendingFuturePacketIds,
    planNodeIds: identity.planNodeIds
  });
}

export function applyWaveAssessmentResultsToWorkstreams(input: {
  workstreams: WorkstreamRecord[];
  assessments: WaveAssessmentResult[];
}): WorkstreamRecord[] {
  if (input.assessments.length === 0) {
    return input.workstreams;
  }

  const assessmentsByWorkstreamId = new Map<string, WaveAssessmentResult[]>();
  for (const assessment of input.assessments) {
    const list = assessmentsByWorkstreamId.get(assessment.checkpoint.identity.workstreamId) ?? [];
    list.push(assessment);
    assessmentsByWorkstreamId.set(assessment.checkpoint.identity.workstreamId, list);
  }

  return input.workstreams.map((workstream) => {
    const assessments = assessmentsByWorkstreamId.get(workstream.id);
    if (!workstream.packetPlan || !assessments || assessments.length === 0) {
      return workstream;
    }

    const byId = new Map((workstream.packetPlan.waveAssessments ?? []).map((assessment) => [assessment.id, assessment]));
    for (const assessment of assessments) {
      byId.set(assessment.id, assessment);
    }

    return {
      ...workstream,
      packetPlan: {
        ...workstream.packetPlan,
        waveAssessments: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
      }
    };
  });
}
