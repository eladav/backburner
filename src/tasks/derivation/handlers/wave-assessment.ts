import { buildParentBranchSyncPreflight } from "../../../workstreams/packet-plan.js";
import type {
  WaveAssessmentCheckpoint,
  WaveAssessmentCheckpointIdentity,
  WaveAssessmentResult
} from "../../../workstreams/wave-assessment/types.js";
import {
  buildWaveAssessmentCheckpoint,
  buildWaveAssessmentCheckpointIdentity
} from "../../../workstreams/wave-assessment/checkpoint.js";
import type { ExecutionRecord } from "../../../state/types.js";
import type { TaskRecord } from "../../types.js";
import { buildTaskRecord } from "../builders.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler
} from "../types.js";

export const waveAssessmentHandler: TaskDerivationHandler = {
  name: "wave_assessment",
  derive(context, env) {
    const assessmentTask = deriveWavePlanAssessmentTask(context, env);
    if (assessmentTask) {
      return [assessmentTask];
    }

    const replanningTask = deriveWavePlanReplanningTask(context, env);
    return replanningTask ? [replanningTask] : [];
  }
};

export function isWaveAssessmentCheckpointAllowed(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): boolean {
  const checkpoint = resolveWaveAssessmentCheckpoint(context, env);
  if (!checkpoint) {
    return false;
  }

  const assessment = findMatchingPublishedFinalizedWaveAssessment(
    context.workstream,
    env,
    checkpoint.identity
  );
  return assessment?.decision === "continue";
}

export function hasOpenWaveAssessmentParentPullRequest(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): boolean {
  const checkpoint = resolveWaveAssessmentCheckpoint(context, env);
  if (!checkpoint) {
    return false;
  }

  const parentPrNumber = context.workstream.integration?.prNumber;
  const parentPr =
    parentPrNumber !== undefined
      ? env.currentPrsByRepoAndNumber.get(`${context.workstream.repoKey}:${parentPrNumber}`)
      : undefined;

  return parentPr?.state === "open";
}

function deriveWavePlanAssessmentTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const resolved = resolveWaveAssessmentTaskContext(context, env);
  if (!resolved) {
    return undefined;
  }

  const { checkpoint, issue, parentPr, repoSyncRecord, workstream } = resolved;

  if (findMatchingPublishedFinalizedWaveAssessment(workstream, env, checkpoint.identity)) {
    return undefined;
  }

  const unpublishedAssessment = findMatchingFinalizedWaveAssessment(
    workstream,
    env,
    checkpoint.identity,
    { requirePostedComment: false }
  );
  const taskId = buildWaveAssessmentTaskId(checkpoint);
  if (hasUnresolvedTask(env, taskId)) {
    return undefined;
  }

  return buildTaskRecord(
    taskId,
    "wave_plan_assessment",
    parentPr,
    repoSyncRecord,
    {
      reason: [
        `Current packet wave ${checkpoint.identity.currentWaveIndex} is complete and future packets remain.`,
        `Parent PR #${parentPr.number} is open.`,
        unpublishedAssessment && !unpublishedAssessment.postedCommentId
          ? "A finalized wave assessment exists, but its parent PR comment was not posted; rerun the assessment publication path."
          : "No finalized wave assessment exists for this checkpoint."
      ].join(" "),
      summary: `Assess completed packet wave ${checkpoint.identity.currentWaveIndex} before wave ${checkpoint.identity.nextWaveIndex}`,
      contextBuilder: env.input.contextBuilder,
      now: env.input.now
    },
    env.input.contextBuilder.build({
      taskKind: "wave_plan_assessment",
      repoIdentifier: parentPr.repoSlug,
      sourceKind: "pull_request",
      sourceUrl: parentPr.url,
      parentUrl: issue.url,
      labels: parentPr.labels,
      issueTitle: issue.title,
      issueBody: issue.body,
      waveAssessmentCheckpoint: checkpoint,
      ...(repoSyncRecord?.localPath ? { localRepoPath: repoSyncRecord.localPath } : {})
    }),
    workstream.id
  );
}

function deriveWavePlanReplanningTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const resolved = resolveWaveAssessmentTaskContext(context, env);
  if (!resolved) {
    return undefined;
  }

  const { checkpoint, issue, parentPr, repoSyncRecord, workstream } = resolved;
  const assessment = findMatchingPublishedFinalizedWaveAssessment(workstream, env, checkpoint.identity);
  if (!assessment || assessment.decision !== "replan") {
    return undefined;
  }

  if (
    findMatchingPublishedFinalizedWaveAssessment(
      workstream,
      env,
      checkpoint.identity,
      { decision: "continue" }
    )
  ) {
    return undefined;
  }

  const taskId = buildWaveReplanningTaskId(checkpoint);
  const existing = env.existingTasksById.get(taskId);
  if (hasUnresolvedTask(env, taskId)) {
    return undefined;
  }

  return buildTaskRecord(
    taskId,
    "wave_plan_replanning",
    parentPr,
    repoSyncRecord,
    {
      reason: [
        `Finalized wave assessment ${assessment.id} requires replanning.`,
        `Current packet wave ${checkpoint.identity.currentWaveIndex} is complete before wave ${checkpoint.identity.nextWaveIndex}.`,
        existing?.status === "completed"
          ? "A previous replanning task completed, but no superseding continue assessment was published; rerun replanning completion."
          : undefined
      ].filter((line): line is string => line !== undefined).join(" "),
      summary: `Replan packet workstream after wave assessment ${assessment.id}`,
      contextBuilder: env.input.contextBuilder,
      now: env.input.now
    },
    env.input.contextBuilder.build({
      taskKind: "wave_plan_replanning",
      repoIdentifier: parentPr.repoSlug,
      sourceKind: "pull_request",
      sourceUrl: parentPr.url,
      parentUrl: issue.url,
      labels: parentPr.labels,
      issueTitle: issue.title,
      issueBody: issue.body,
      waveAssessmentCheckpoint: checkpoint,
      finalizedWaveAssessment: assessment,
      ...(repoSyncRecord?.localPath ? { localRepoPath: repoSyncRecord.localPath } : {})
    }),
    workstream.id
  );
}

function resolveWaveAssessmentTaskContext(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
):
  | {
      checkpoint: WaveAssessmentCheckpoint;
      issue: NonNullable<ResolvedWorkstreamContext["issue"]>;
      parentPr: NonNullable<ResolvedWorkstreamContext["activePullRequest"]>;
      repoSyncRecord: ResolvedWorkstreamContext["repoSyncRecord"];
      workstream: ResolvedWorkstreamContext["workstream"];
    }
  | undefined {
  const { workstream, attention, issue, repoSyncRecord } = context;

  if (
    workstream.origin.type !== "issue" ||
    !issue ||
    issue.state !== "open" ||
    !attention?.reasons.includes("packet_wave_complete_sync_needed")
  ) {
    return undefined;
  }

  const checkpoint = resolveWaveAssessmentCheckpoint(context, env);
  if (!checkpoint) {
    return undefined;
  }

  const parentPrNumber = workstream.integration?.prNumber;
  const parentPr =
    parentPrNumber !== undefined
      ? env.currentPrsByRepoAndNumber.get(`${workstream.repoKey}:${parentPrNumber}`)
      : undefined;
  if (!parentPr || parentPr.state !== "open") {
    return undefined;
  }

  return { checkpoint, issue, parentPr, repoSyncRecord, workstream };
}

function resolveWaveAssessmentCheckpoint(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): WaveAssessmentCheckpoint | undefined {
  const { workstream, repoConfig, repoSyncRecord } = context;
  const defaultBranch = repoConfig?.defaultBranch ?? repoSyncRecord?.defaultBranch ?? undefined;
  const preflight = buildParentBranchSyncPreflight({ workstream, defaultBranch });

  if (!preflight || !preflight.parentPrNumber) {
    return undefined;
  }

  const parentPr = env.currentPrsByRepoAndNumber.get(`${workstream.repoKey}:${preflight.parentPrNumber}`);
  if (!parentPr?.headSha) {
    return undefined;
  }

  return buildWaveAssessmentCheckpoint(
    buildWaveAssessmentCheckpointIdentity(preflight, {
      parentHeadSha: parentPr.headSha,
      planRevision: resolvePlanRevision(workstream),
      originalPlanningSessionId: resolveOriginalPlanningSessionId(workstream, env),
      planNodeIds: workstream.packetPlan ? Object.keys(workstream.packetPlan.packets).sort() : []
    })
  );
}

function buildWaveAssessmentTaskId(checkpoint: WaveAssessmentCheckpoint): string {
  return `task:wave_plan_assessment:${checkpoint.id}`;
}

function buildWaveReplanningTaskId(checkpoint: WaveAssessmentCheckpoint): string {
  return `task:wave_plan_replanning:${checkpoint.id}`;
}

function hasUnresolvedTask(env: TaskDerivationEnvironment, taskId: string): boolean {
  const task = env.existingTasksById.get(taskId);
  return task?.status === "pending" || task?.status === "dispatched" || task?.status === "failed";
}

function findMatchingPublishedFinalizedWaveAssessment(
  workstream: ResolvedWorkstreamContext["workstream"],
  env: TaskDerivationEnvironment,
  identity: WaveAssessmentCheckpointIdentity,
  options: { decision?: WaveAssessmentResult["decision"] | undefined } = {}
): WaveAssessmentResult | undefined {
  return findMatchingFinalizedWaveAssessment(
    workstream,
    env,
    identity,
    { ...options, requirePostedComment: true }
  );
}

function findMatchingFinalizedWaveAssessment(
  workstream: ResolvedWorkstreamContext["workstream"],
  env: TaskDerivationEnvironment,
  identity: WaveAssessmentCheckpointIdentity,
  options: {
    decision?: WaveAssessmentResult["decision"] | undefined;
    requirePostedComment: boolean;
  }
): WaveAssessmentResult | undefined {
  const persistedAssessments = workstream.packetPlan?.waveAssessments ?? [];
  const executionAssessments = env.input.previousState.executions
    .map(readWaveAssessmentResult)
    .filter((assessment): assessment is WaveAssessmentResult => assessment !== undefined)
  const assessments = [...persistedAssessments, ...executionAssessments]
    .filter((assessment) => assessment.status === "finalized")
    .filter((assessment) => !options.requirePostedComment || Boolean(assessment.postedCommentId))
    .filter((assessment) => options.decision === undefined || assessment.decision === options.decision)
    .filter((assessment) => checkpointIdentitiesEqual(assessment.checkpoint.identity, identity))
    .sort(compareAssessmentsNewestFirst);

  return assessments[0];
}

function readWaveAssessmentResult(execution: ExecutionRecord): WaveAssessmentResult | undefined {
  const result = execution.result as { waveAssessment?: WaveAssessmentResult } | undefined;
  return result?.waveAssessment;
}

function compareAssessmentsNewestFirst(left: WaveAssessmentResult, right: WaveAssessmentResult): number {
  return getAssessmentTimestamp(right).localeCompare(getAssessmentTimestamp(left));
}

function getAssessmentTimestamp(assessment: WaveAssessmentResult): string {
  return assessment.finalizedAt ?? assessment.updatedAt ?? assessment.createdAt ?? "";
}

function checkpointIdentitiesEqual(
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

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolvePlanRevision(workstream: ResolvedWorkstreamContext["workstream"]): string {
  return (
    workstream.packetPlan?.source?.generatedAt ??
    workstream.packetPlan?.updatedAt ??
    `${workstream.packetPlan?.currentWaveIndex ?? 0}:${Object.keys(workstream.packetPlan?.packets ?? {}).sort().join(",")}`
  );
}

function resolveOriginalPlanningSessionId(
  workstream: ResolvedWorkstreamContext["workstream"],
  env: TaskDerivationEnvironment
): string {
  const planBreakdownExecutions = env.input.previousState.executions
    .filter((execution) => execution.taskKind === "plan_breakdown" && execution.taskStatus === "completed")
    .filter((execution) => {
      const task = env.input.previousState.tasks.find((candidate) => candidate.id === execution.taskId);
      return task?.workstreamId === workstream.id;
    })
    .sort((left, right) => right.endedAt.localeCompare(left.endedAt));

  return planBreakdownExecutions[0]?.result?.planBreakdownSessionId ?? "unknown";
}
