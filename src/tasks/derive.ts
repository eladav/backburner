import type { RepoConfig } from "../config/types.js";
import type {
  NormalizedComment,
  NormalizedIssue,
  NormalizedPullRequest
} from "../domain/entities.js";
import type {
  AttentionRecord,
  ExecutionRecord,
  RepoSyncRecord,
  WorkstreamRecord,
  WorktreeRecord
} from "../state/types.js";
import type {
  ParentBranchSyncPreflight,
  PrepareForMergePreflight,
  TaskContextPacket,
  TaskRecord,
  TaskStatus
} from "./types.js";
import { deriveWorkstreams } from "../workstreams/derive.js";
import { deriveAttentionRecords } from "../attention/derive.js";
import { buildParentBranchSyncPreflight, hasGeneratedPlanBreakdown } from "../workstreams/packet-plan.js";
import {
  buildWaveAssessmentCheckpointIdentity,
  waveAssessmentCheckpointIdentityMatches
} from "../workstreams/wave-assessment/checkpoint.js";
import {
  collectPacketPullRequestProjections,
  type PacketPullRequestProjection
} from "../workstreams/packet-projections.js";
import { classifyManagementPullRequest } from "../github/pr-classification.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationInput
} from "./derivation/types.js";
import { runBlockingHandler, runHandlers } from "./derivation/runner.js";
import {
  activeParentWorkstreamHandlers,
  deriveManagementPullRequestCommentTasks,
  finalWorkstreamHandlers,
  isActiveParentWorkstream,
  parentWorkstreamHandlers,
  planBreakdownHandler
} from "./derivation/handlers/index.js";

export type { TaskDerivationInput } from "./derivation/types.js";

export function deriveTasks(input: TaskDerivationInput): TaskRecord[] {
  const repoConfigs = new Map(input.repos.map((repo) => [repo.id, repo]));
  const repoSyncRecords = new Map(input.repoSyncRecords.map((record) => [record.repoId, record]));
  const previousIssues = new Map(input.previousState.issues.map((issue) => [issue.id, issue]));
  const previousPullRequests = new Map(input.previousState.prs.map((pr) => [pr.id, pr]));
  const previousComments = new Map(input.previousState.comments.map((comment) => [comment.id, comment]));
  const currentIssues = [...input.currentIssues].sort(compareIssueLikeEntities);
  const currentPullRequests = [...input.currentPullRequests].sort(compareIssueLikeEntities);
  const currentComments = [...input.currentComments].sort(compareComments);
  const worktrees = [...(input.worktrees ?? input.previousState.worktrees)].sort(compareWorktrees);
  const currentIssuesById = new Map(currentIssues.map((issue) => [issue.id, issue]));
  const currentPullRequestsById = new Map(
    currentPullRequests.map((pullRequest) => [pullRequest.id, pullRequest])
  );
  const currentCommentsById = new Map(currentComments.map((comment) => [comment.id, comment]));
  const currentWorktreePaths = new Set(worktrees.map((worktree) => worktree.path));
  const provisionalWorkstreams =
    input.workstreams ??
    deriveWorkstreams({
      repos: input.repos,
      currentIssues,
      currentPullRequests,
      previousPullRequests: input.previousState.prs,
      worktrees,
      previousWorkstreams: input.previousState.workstreams
    });
  const attentionRecords =
    input.attention ??
    deriveAttentionRecords({
      repos: input.repos,
      workstreams: provisionalWorkstreams,
      previousState: input.previousState,
      currentIssues,
      currentPullRequests,
      currentComments,
      tasks: input.previousState.tasks,
      worktrees,
      now: input.now
    });
  const workstreams =
    input.workstreams ??
    deriveWorkstreams({
      repos: input.repos,
      currentIssues,
      currentPullRequests,
      previousPullRequests: input.previousState.prs,
      worktrees,
      previousWorkstreams: input.previousState.workstreams,
      attention: attentionRecords
    });
  const existingTasks = input.previousState.tasks;
  const existingTasksById = new Map(existingTasks.map((task) => [task.id, task]));
  const desiredTasks = new Map<string, TaskRecord>();
  const attentionByWorkstreamId = new Map(attentionRecords.map((record) => [record.workstreamId, record]));
  const currentIssuesByRepoAndNumber = new Map(
    currentIssues.map((issue) => [`${issue.repoKey}:${issue.number}`, issue] as const)
  );
  const currentPrsByRepoAndNumber = new Map(
    currentPullRequests.map((pr) => [`${pr.repoKey}:${pr.number}`, pr] as const)
  );
  const worktreesById = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
  const worktreesByRepoAndBranch = new Map(
    worktrees.map((worktree) => [`${worktree.repoId}:${worktree.branchName}`, worktree] as const)
  );
  const worktreesByPath = new Map(
    worktrees.map((worktree) => [worktree.path, worktree] as const)
  );
  const currentPrsByRepoAndBranch = new Map(
    currentPullRequests.map((pr) => [`${pr.repoId}:${pr.headBranch}`, pr] as const)
  );
  const workstreamsById = new Map(workstreams.map((w) => [w.id, w]));

  const packetPullRequestProjections = collectPacketPullRequestProjections({
    pullRequests: currentPullRequests,
    workstreams,
    worktrees
  });

  const packetProjectionByRepoAndPrNumber = new Map<string, PacketPullRequestProjection>();
  for (const projection of packetPullRequestProjections) {
    const key = `${projection.pullRequest.repoId}:${projection.pullRequest.number}`;
    if (!packetProjectionByRepoAndPrNumber.has(key)) {
      packetProjectionByRepoAndPrNumber.set(key, projection);
    }
  }

  const packetWorktreesByWorkstreamId = new Map<string, WorktreeRecord[]>();
  for (const worktree of worktrees) {
    if (worktree.packet && isPacketWorktreeInCurrentPlan(worktree, workstreamsById)) {
      const list = packetWorktreesByWorkstreamId.get(worktree.packet.parentWorkstreamId) ?? [];
      list.push(worktree);
      packetWorktreesByWorkstreamId.set(worktree.packet.parentWorkstreamId, list);
    }
  }

  const env: TaskDerivationEnvironment = {
    input,
    repoConfigs,
    repoSyncRecords,
    previousIssues,
    previousPullRequests,
    previousComments,
    currentIssues,
    currentPullRequests,
    currentCommentsById,
    currentIssuesByRepoAndNumber,
    currentPrsByRepoAndNumber,
    packetPullRequestProjections,
    packetProjectionByRepoAndPrNumber,
    packetWorktreesByWorkstreamId,
    existingTasks,
    existingTasksById
  };
  const taskSink = {
    add: (task: TaskRecord) => addTask(task, env, desiredTasks),
    replace: (task: TaskRecord) => {
      desiredTasks.set(task.id, task);
      return task;
    },
    get: (taskId: string) => desiredTasks.get(taskId),
    preserveExisting: (taskId: string) => {
      const existingTask = existingTasksById.get(taskId);
      if (existingTask) {
        desiredTasks.set(taskId, existingTask);
      }
      return existingTask;
    }
  };

  for (const workstream of [...workstreams].sort(compareWorkstreams)) {
    const context = resolveWorkstreamContext(
      workstream,
      attentionByWorkstreamId.get(workstream.id),
      currentIssuesByRepoAndNumber,
      currentPrsByRepoAndNumber,
      worktreesById,
      worktreesByRepoAndBranch,
      repoConfigs,
      repoSyncRecords,
      input.managementRepo,
      input.previousState.managementPrs
    );

    if (context.isManagementPullRequest) {
      for (const task of deriveManagementPullRequestCommentTasks(context, env, taskSink)) {
        taskSink.add(task);
      }
      continue;
    }

    if (runBlockingHandler(planBreakdownHandler, context, env, taskSink)) {
      continue;
    }

    runHandlers(parentWorkstreamHandlers, context, env, taskSink);

    if (isActiveParentWorkstream(workstream)) {
      runHandlers(activeParentWorkstreamHandlers, context, env, taskSink);
    }

    runHandlers(finalWorkstreamHandlers, context, env, taskSink);
  }

  for (const existingTask of existingTasks) {
    if (desiredTasks.has(existingTask.id)) {
      continue;
    }

    if (!isUnresolvedStatus(existingTask.status) && existingTask.status !== "failed") {
      continue;
    }

    if (
      !shouldCarryForwardUnresolvedTask(existingTask, {
        repoConfigs,
        currentIssuesById,
        currentIssuesByRepoAndNumber,
        currentPullRequestsById,
        currentCommentsById,
        currentWorktreePaths,
        worktreesByPath,
        currentPullRequestsByRepoAndBranch: currentPrsByRepoAndBranch,
        attentionByWorkstreamId,
        workstreamsById,
        repoSyncRecords,
        previousTasks: input.previousState.tasks,
        previousExecutions: input.previousState.executions,
        ...(input.managementRepo ? { managementRepo: input.managementRepo } : {}),
        managementPrs: input.previousState.managementPrs
      })
    ) {
      continue;
    }

    const refreshedTask = refreshCarriedForwardTask(existingTask, workstreamsById);
    if (!refreshedTask) {
      continue;
    }

    desiredTasks.set(
      existingTask.id,
      mergeTask(
        refreshedTask,
        {
          ...refreshedTask,
          status: normalizeTaskStatusForNewCycle(refreshedTask.status)
        },
        input.now
      )
    );
  }

  return [...desiredTasks.values()].sort(compareTasks);
}

function refreshCarriedForwardTask(
  task: TaskRecord,
  workstreamsById: Map<string, WorkstreamRecord>
): TaskRecord | undefined {
  if (task.kind !== "respond_issue_comment" || task.workstreamId === undefined) {
    return task;
  }

  const currentWorkstream = workstreamsById.get(task.workstreamId);
  if (!currentWorkstream) {
    return task;
  }

  if (
    (task.workflowPhase === "product_discovery" || task.workflowPhase === "product_specification") &&
    currentWorkstream.phase !== "product_discovery" &&
    currentWorkstream.phase !== "product_specification"
  ) {
    return undefined;
  }

  if (task.workflowPhase === currentWorkstream.phase) {
    return task;
  }

  return {
    ...task,
    workflowPhase: currentWorkstream.phase
  };
}

function isPacketWorktreeInCurrentPlan(
  worktree: WorktreeRecord,
  workstreamsById: ReadonlyMap<string, WorkstreamRecord>
): boolean {
  if (!worktree.packet) {
    return false;
  }

  const parentWorkstream = workstreamsById.get(worktree.packet.parentWorkstreamId);
  if (!parentWorkstream?.packetPlan) {
    return true;
  }

  return Boolean(parentWorkstream.packetPlan.packets[worktree.packet.packetId]);
}

function addTask(
  task: TaskRecord,
  env: TaskDerivationEnvironment,
  desiredTasks: Map<string, TaskRecord>
): TaskRecord {
  const currentDesiredTask = desiredTasks.get(task.id);
  if (currentDesiredTask) {
    const mergedCycleTask = mergeSameCycleTask(currentDesiredTask, task);
    desiredTasks.set(task.id, mergedCycleTask);
    return mergedCycleTask;
  }

  const mergedTask = mergeTask(env.existingTasksById.get(task.id), task, env.input.now);
  desiredTasks.set(task.id, mergedTask);
  return mergedTask;
}

function mergeSameCycleTask(current: TaskRecord, candidate: TaskRecord): TaskRecord {
  if (
    current.kind === "prepare_pr_for_merge" &&
    candidate.kind === "prepare_pr_for_merge" &&
    candidate.status === "pending" &&
    current.status === "failed"
  ) {
    return mergeSameCycleReplacement(current, candidate);
  }

  if (candidate.context.localRepoPath && !current.context.localRepoPath) {
    return mergeSameCycleReplacement(current, candidate);
  }

  return current;
}

function mergeSameCycleReplacement(current: TaskRecord, candidate: TaskRecord): TaskRecord {
  return {
    ...candidate,
    createdAt: current.createdAt,
    ...(current.lastExecutionId ? { lastExecutionId: current.lastExecutionId } : {}),
    ...(current.lastFailureCommentId ? { lastFailureCommentId: current.lastFailureCommentId } : {}),
    context: {
      ...candidate.context,
      ...(current.context.recoveryNeeded !== undefined ? { recoveryNeeded: current.context.recoveryNeeded } : {})
    }
  };
}

function resolveWorkstreamContext(
  workstream: WorkstreamRecord,
  attention: AttentionRecord | undefined,
  currentIssuesByRepoAndNumber: Map<string, NormalizedIssue>,
  currentPrsByRepoAndNumber: Map<string, NormalizedPullRequest>,
  worktreesById: Map<string, WorktreeRecord>,
  worktreesByRepoAndBranch: Map<string, WorktreeRecord>,
  repoConfigs: Map<string, RepoConfig>,
  repoSyncRecords: Map<string, RepoSyncRecord>,
  managementRepo: { repoId?: string; repoSlug?: string } | undefined,
  managementPrs: import("../retrospectives/types.js").ManagementPrRecord[]
): ResolvedWorkstreamContext {
  const issueNumber = workstream.linkedIssueNumber ?? (workstream.origin.type === "issue" ? workstream.origin.number : undefined);
  const issue = issueNumber !== undefined
    ? currentIssuesByRepoAndNumber.get(`${workstream.repoKey}:${issueNumber}`)
    : undefined;

  const activePullRequest = resolveActivePullRequest(workstream, currentPrsByRepoAndNumber);
  const activeWorktree =
    (workstream.activeWorktreeId ? worktreesById.get(workstream.activeWorktreeId) : undefined) ??
    (activePullRequest
      ? worktreesByRepoAndBranch.get(`${activePullRequest.repoId}:${activePullRequest.headBranch}`)
      : undefined);
  const repoId = issue?.repoId ?? activePullRequest?.repoId ?? activeWorktree?.repoId;
  const repoSlug = issue?.repoSlug ?? activePullRequest?.repoSlug ?? activeWorktree?.repoSlug;

  const isManagementPullRequest = activePullRequest
    ? classifyManagementPullRequest({
        repoId: activePullRequest.repoId,
        repoSlug: activePullRequest.repoSlug,
        pullRequestNumber: activePullRequest.number,
        headBranch: activePullRequest.headBranch,
        managementPrs,
        ...(managementRepo ? { managementRepo } : {})
      }).kind === "management"
    : false;

  return {
    workstream,
    attention,
    issue,
    activePullRequest,
    activeWorktree,
    repoConfig: repoId ? repoConfigs.get(repoId) : undefined,
    repoSyncRecord: repoId ? repoSyncRecords.get(repoId) : undefined,
    isManagementPullRequest
  };
}

function resolveActivePullRequest(
  workstream: WorkstreamRecord,
  currentPrsByRepoAndNumber: Map<string, NormalizedPullRequest>
): NormalizedPullRequest | undefined {
  const candidateNumbers = [
    ...(workstream.activePrNumber !== undefined ? [workstream.activePrNumber] : []),
    ...workstream.linkedPrs.map((pr) => pr.number),
    ...(workstream.origin.type === "pr" ? [workstream.origin.number] : [])
  ];

  for (const number of candidateNumbers) {
    const pr = currentPrsByRepoAndNumber.get(`${workstream.repoKey}:${number}`);
    if (pr) {
      return pr;
    }
  }

  return undefined;
}

function resolveCommentPullRequest(
  comment: NormalizedComment,
  context: ResolvedWorkstreamContext
): NormalizedPullRequest | undefined {
  if (context.activePullRequest && context.activePullRequest.number === comment.parentNumber) {
    return context.activePullRequest;
  }

  return undefined;
}

function resolvePacketPullRequest(
  worktree: WorktreeRecord,
  currentPrsByRepoAndNumber: Map<string, NormalizedPullRequest>
): NormalizedPullRequest | undefined {
  if (worktree.prNumber !== undefined) {
    const pr = currentPrsByRepoAndNumber.get(`${worktree.repoSlug}:${worktree.prNumber}`);
    if (pr) {
      return pr;
    }
  }

  if (worktree.prUrl) {
    const match = worktree.prUrl.match(/\/pull\/(\d+)$/);
    if (match) {
      const prNumber = Number(match[1]);
      const pr = currentPrsByRepoAndNumber.get(`${worktree.repoSlug}:${prNumber}`);
      if (pr) {
        return pr;
      }
    }
  }

  return undefined;
}

function mergeTask(existing: TaskRecord | undefined, desired: TaskRecord, now: string): TaskRecord {
  if (!existing) {
    return desired;
  }

  const mergedBase = {
    ...desired,
    createdAt: existing.createdAt,
    ...(existing.lastExecutionId ? { lastExecutionId: existing.lastExecutionId } : {}),
    ...(existing.lastFailureCommentId ? { lastFailureCommentId: existing.lastFailureCommentId } : {})
  };

  if (tasksEquivalent(existing, mergedBase)) {
    return existing;
  }

  const shouldResetStatus =
    isTerminalStatus(existing.status) &&
    existing.status !== "failed" &&
    (existing.reason !== desired.reason ||
      existing.summary !== desired.summary ||
      !contextsEquivalentForRerun(existing.context, desired.context));

  let status = normalizeTaskStatusForNewCycle(existing.status);
  let recoveryNeeded = existing.context?.recoveryNeeded;

  if (shouldResetStatus) {
    status = "pending";
  }
  if (desired.status === "failed") {
    status = "failed";
    recoveryNeeded = true;
  }

  return {
    ...mergedBase,
    status,
    context: {
      ...mergedBase.context,
      recoveryNeeded
    },
    updatedAt: now
  };
}

function tasksEquivalent(left: TaskRecord, right: TaskRecord): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.status === right.status &&
    left.executionPermission === right.executionPermission &&
    handoffPoliciesEquivalent(left.handoffPolicy, right.handoffPolicy) &&
    left.repoId === right.repoId &&
    left.repoName === right.repoName &&
    left.repoSlug === right.repoSlug &&
    left.sourceKind === right.sourceKind &&
    left.sourceId === right.sourceId &&
    left.sourceUrl === right.sourceUrl &&
    left.parentSourceKind === right.parentSourceKind &&
    left.parentSourceId === right.parentSourceId &&
    left.relevant === right.relevant &&
    left.reason === right.reason &&
    left.summary === right.summary &&
    left.workstreamId === right.workstreamId &&
    left.workflowPhase === right.workflowPhase &&
    left.createdAt === right.createdAt &&
    left.sourceReactionTargetId === right.sourceReactionTargetId &&
    contextsEquivalent(left.context, right.context)
  );
}

function handoffPoliciesEquivalent(left: TaskRecord["handoffPolicy"], right: TaskRecord["handoffPolicy"]): boolean {
  return (
    left.expectsPushableHandoff === right.expectsPushableHandoff &&
    left.orchestratorOwnsPush === right.orchestratorOwnsPush &&
    left.remotePublishOwner === right.remotePublishOwner
  );
}

function contextsEquivalent(left: TaskContextPacket, right: TaskContextPacket): boolean {
  return (
    contextsEquivalentForRerun(left, right) &&
    arraysEqual(left.labels, right.labels)
  );
}

function contextsEquivalentForRerun(left: TaskContextPacket, right: TaskContextPacket): boolean {
  return (
    left.repoIdentifier === right.repoIdentifier &&
    left.localRepoPath === right.localRepoPath &&
    left.productSpecDocumentPath === right.productSpecDocumentPath &&
    left.issueUrl === right.issueUrl &&
    left.issueTitle === right.issueTitle &&
    left.issueBody === right.issueBody &&
    left.pullRequestUrl === right.pullRequestUrl &&
    left.commentUrl === right.commentUrl &&
    left.relevantCommentText === right.relevantCommentText &&
    left.branchName === right.branchName &&
    left.planDocumentPath === right.planDocumentPath &&
    left.logDocumentPath === right.logDocumentPath &&
    left.instruction === right.instruction &&
    preflightsEquivalent(left.preflight, right.preflight) &&
    prepareForMergePreflightsEquivalent(left.prepareForMerge, right.prepareForMerge) &&
    waveAssessmentCheckpointsEquivalent(
      left.waveAssessmentCheckpoint,
      right.waveAssessmentCheckpoint
    ) &&
    waveAssessmentResultsEquivalent(
      left.finalizedWaveAssessment,
      right.finalizedWaveAssessment
    )
  );
}

function waveAssessmentCheckpointsEquivalent(
  left: TaskContextPacket["waveAssessmentCheckpoint"],
  right: TaskContextPacket["waveAssessmentCheckpoint"]
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    waveAssessmentCheckpointIdentityMatches(left.identity, right.identity)
  );
}

function waveAssessmentResultsEquivalent(
  left: TaskContextPacket["finalizedWaveAssessment"],
  right: TaskContextPacket["finalizedWaveAssessment"]
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.decision === right.decision &&
    left.summary === right.summary &&
    left.status === right.status &&
    left.postedCommentId === right.postedCommentId &&
    left.createdAt === right.createdAt &&
    left.finalizedAt === right.finalizedAt &&
    left.updatedAt === right.updatedAt &&
    waveAssessmentCheckpointsEquivalent(left.checkpoint, right.checkpoint) &&
    assessmentFindingsEquivalent(left.findings, right.findings)
  );
}

function assessmentFindingsEquivalent(
  left: NonNullable<TaskContextPacket["finalizedWaveAssessment"]>["findings"],
  right: NonNullable<TaskContextPacket["finalizedWaveAssessment"]>["findings"]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftFinding, index) => {
    const rightFinding = right[index];
    return Boolean(
      rightFinding &&
        leftFinding.id === rightFinding.id &&
        leftFinding.category === rightFinding.category &&
        leftFinding.summary === rightFinding.summary &&
        leftFinding.details === rightFinding.details &&
        leftFinding.createdAt === rightFinding.createdAt &&
        arraysEqual(leftFinding.affectedPlanNodeIds, rightFinding.affectedPlanNodeIds)
    );
  });
}

function preflightsEquivalent(
  left: ParentBranchSyncPreflight | undefined,
  right: ParentBranchSyncPreflight | undefined
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.workstreamId === right.workstreamId &&
    left.repoKey === right.repoKey &&
    left.parentIntegrationBranch === right.parentIntegrationBranch &&
    left.parentPrNumber === right.parentPrNumber &&
    left.defaultBranch === right.defaultBranch &&
    left.currentWaveIndex === right.currentWaveIndex &&
    left.nextWaveIndex === right.nextWaveIndex &&
    arraysEqual(left.completedPacketIds, right.completedPacketIds) &&
    arraysEqual(left.pendingFuturePacketIds, right.pendingFuturePacketIds)
  );
}

function prepareForMergePreflightsEquivalent(
  left: PrepareForMergePreflight | undefined,
  right: PrepareForMergePreflight | undefined
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.prNumber === right.prNumber &&
    left.headBranch === right.headBranch &&
    left.headSha === right.headSha &&
    left.baseBranch === right.baseBranch &&
    left.prTitle === right.prTitle
  );
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareIssueLikeEntities(
  left: Pick<NormalizedIssue | NormalizedPullRequest, "repoSlug" | "number" | "id">,
  right: Pick<NormalizedIssue | NormalizedPullRequest, "repoSlug" | "number" | "id">
): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  if (left.number !== right.number) {
    return left.number - right.number;
  }

  return left.id.localeCompare(right.id);
}

function compareComments(left: NormalizedComment, right: NormalizedComment): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  if (left.parentNumber !== right.parentNumber) {
    return left.parentNumber - right.parentNumber;
  }

  return left.id.localeCompare(right.id);
}

function compareWorktrees(left: WorktreeRecord, right: WorktreeRecord): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareWorkstreams(left: WorkstreamRecord, right: WorkstreamRecord): number {
  const repoComparison = left.repoKey.localeCompare(right.repoKey);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareTasks(left: TaskRecord, right: TaskRecord): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  const kindComparison = left.kind.localeCompare(right.kind);
  if (kindComparison !== 0) {
    return kindComparison;
  }

  return left.id.localeCompare(right.id);
}


function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed";
}

function normalizeTaskStatusForNewCycle(status: TaskStatus): TaskStatus {
  return status === "dispatched" ? "pending" : status;
}

function isUnresolvedStatus(status: TaskStatus): boolean {
  return status === "pending" || status === "queued" || status === "dispatched";
}

function shouldCarryForwardUnresolvedTask(
  task: TaskRecord,
  input: {
    repoConfigs: Map<string, RepoConfig>;
    currentIssuesById: Map<string, NormalizedIssue>;
    currentIssuesByRepoAndNumber: Map<string, NormalizedIssue>;
    currentPullRequestsById: Map<string, NormalizedPullRequest>;
    currentCommentsById: Map<string, NormalizedComment>;
    currentWorktreePaths: Set<string>;
    worktreesByPath: Map<string, WorktreeRecord>;
    currentPullRequestsByRepoAndBranch: Map<string, NormalizedPullRequest>;
    attentionByWorkstreamId: Map<string, AttentionRecord>;
    workstreamsById: Map<string, WorkstreamRecord>;
    repoSyncRecords: Map<string, RepoSyncRecord>;
    previousTasks: TaskRecord[];
    previousExecutions: ExecutionRecord[];
    managementRepo?: { repoId?: string; repoSlug?: string };
    managementPrs?: import("../retrospectives/types.js").ManagementPrRecord[];
  }
  ) {
  const isManagement = (pr: NormalizedPullRequest | undefined) => {
    if (!pr || !input.managementPrs) return false;
    return classifyManagementPullRequest({
      repoId: pr.repoId,
      repoSlug: pr.repoSlug,
      pullRequestNumber: pr.number,
      headBranch: pr.headBranch,
      managementPrs: input.managementPrs,
      ...(input.managementRepo ? { managementRepo: input.managementRepo } : {})
    }).kind === "management";
  };

  if (task.workstreamId) {
    const workstream = input.workstreamsById.get(task.workstreamId);
    const isParentActive =
      workstream &&
      workstream.status === "open" &&
      workstream.phase !== "abandoned" &&
      workstream.phase !== "resolved";
    if (!isParentActive) {
      return false;
    }
  }

  switch (task.kind) {
    case "product_discovery": {
      const issue = input.currentIssuesById.get(task.sourceId);
      const repoConfig = input.repoConfigs.get(task.repoId);
      return Boolean(
        issue &&
          issue.state === "open" &&
          repoConfig &&
          !issue.labels.includes(repoConfig.labels.agentProductApproved)
      );
    }
    case "write_product_spec": {
      if (task.context.localRepoPath && input.currentWorktreePaths.has(task.context.localRepoPath)) {
        const worktree = input.worktreesByPath.get(task.context.localRepoPath);
        return Boolean(worktree && worktree.status !== "closed" && !worktree.productSpecWrittenAt);
      }

      const issue = input.currentIssuesById.get(task.sourceId);
      const repoConfig = input.repoConfigs.get(task.repoId);
      return Boolean(
        issue &&
          issue.state === "open" &&
          repoConfig &&
          issue.labels.includes(repoConfig.labels.agentProductApproved)
      );
    }
    case "triage_issue": {
      return false;
    }
    case "respond_issue_comment": {
      const comment = input.currentCommentsById.get(task.sourceId);
      const issue = task.parentSourceId ? input.currentIssuesById.get(task.parentSourceId) : undefined;
      return Boolean(comment && comment.parentType === "issue" && issue?.state === "open");
    }
    case "respond_pr_comment": {
      const comment = input.currentCommentsById.get(task.sourceId);
      const pullRequest = task.parentSourceId ? input.currentPullRequestsById.get(task.parentSourceId) : undefined;
      if (isManagement(pullRequest)) return false;
      return Boolean(comment && comment.parentType === "pull_request" && pullRequest?.state === "open");
    }
    case "review_pr": {
      const pullRequest = input.currentPullRequestsById.get(task.sourceId);
      const repoConfig = input.repoConfigs.get(task.repoId);
      if (isManagement(pullRequest)) return false;
      return Boolean(
        pullRequest &&
          pullRequest.state === "open" &&
          repoConfig &&
          pullRequest.labels.includes(repoConfig.labels.agentReview)
      );
    }
    case "write_plan": {
      if (task.context.localRepoPath && input.currentWorktreePaths.has(task.context.localRepoPath)) {
        const worktree = input.worktreesByPath.get(task.context.localRepoPath);
        return worktree?.status !== "closed";
      }

      const pullRequest = input.currentPullRequestsById.get(task.sourceId);
      const repoConfig = input.repoConfigs.get(task.repoId);
      return Boolean(
        pullRequest &&
          pullRequest.state === "open" &&
          repoConfig &&
          (pullRequest.labels.includes(repoConfig.labels.agentInProgress) ||
            pullRequest.labels.includes(repoConfig.labels.agentPlanApproved))
      );
    }
    case "implement_plan": {
      if (task.context.localRepoPath && input.currentWorktreePaths.has(task.context.localRepoPath)) {
        const worktree = input.worktreesByPath.get(task.context.localRepoPath);
        if (worktree?.status === "closed") {
          return false;
        }
        const pullRequest = worktree
          ? input.currentPullRequestsByRepoAndBranch.get(`${worktree.repoId}:${worktree.branchName}`)
          : undefined;
        const repoConfig = input.repoConfigs.get(task.repoId);
        return Boolean(
          pullRequest &&
            pullRequest.state === "open" &&
            repoConfig &&
            pullRequest.labels.includes(repoConfig.labels.agentPlanApproved)
        );
      }

      const pullRequest = input.currentPullRequestsById.get(task.sourceId);
      const repoConfig = input.repoConfigs.get(task.repoId);
      return Boolean(
        pullRequest &&
          pullRequest.state === "open" &&
          repoConfig &&
          pullRequest.labels.includes(repoConfig.labels.agentPlanApproved)
      );
    }
    case "plan_breakdown": {
      const source = input.currentIssuesById.get(task.sourceId) ?? input.currentPullRequestsById.get(task.sourceId);
      const repoConfig = input.repoConfigs.get(task.repoId);
      const workstream = task.workstreamId ? input.workstreamsById.get(task.workstreamId) : undefined;
      if (task.workstreamId !== undefined && workstream === undefined) {
        return false; // workstream was deleted or not found — don't carry forward
      }
      return Boolean(
        source &&
          source.state === "open" &&
          repoConfig &&
          !hasGeneratedPlanBreakdown(workstream) &&
          source.labels.includes(repoConfig.labels.planBreakdownNeeded)
      );
    }
    case "sync_parent_branch_preflight": {
      const issue = input.currentIssuesById.get(task.sourceId);
      if (issue?.state !== "open") {
        return false;
      }

      const workstreamId = task.context.preflight?.workstreamId;
      if (!workstreamId) {
        return false;
      }

      const workstream = input.workstreamsById.get(workstreamId);
      if (!workstream) {
        return false;
      }

      const attention = input.attentionByWorkstreamId.get(workstreamId);
      if (!attention?.reasons.includes("packet_wave_complete_sync_needed")) {
        return false;
      }

      const repoConfig = input.repoConfigs.get(task.repoId);
      const repoSyncRecord = input.repoSyncRecords.get(task.repoId);
      const defaultBranch = repoConfig?.defaultBranch ?? repoSyncRecord?.defaultBranch ?? undefined;

      const preflight = buildParentBranchSyncPreflight({ workstream, defaultBranch });
      if (!preflight) {
        return false;
      }

      // Check if the preflight has changed. If the preflight would be different, we should NOT carry forward
      // the old task because it would be stale.
      return preflightsEquivalent(task.context.preflight, preflight);
    }
    case "sync_parent_branch": {
      const parentPr = input.currentPullRequestsById.get(task.sourceId);
      const repoConfig = input.repoConfigs.get(task.repoId);
      if (!parentPr || parentPr.state !== "open" || !repoConfig || !parentPr.labels.includes(repoConfig.labels.agentSyncParentBranch)) {
        return false;
      }

      const workstreamId = task.context.preflight?.workstreamId;
      if (!workstreamId) {
        return false;
      }

      const workstream = input.workstreamsById.get(workstreamId);
      if (!workstream) {
        return false;
      }

      const issueNumber = workstream.linkedIssueNumber ?? (workstream.origin.type === "issue" ? workstream.origin.number : undefined);
      if (issueNumber === undefined) {
        return false;
      }

      const issue = input.currentIssuesByRepoAndNumber.get(`${workstream.repoKey}:${issueNumber}`);
      if (issue?.state !== "open") {
        return false;
      }

      const attention = input.attentionByWorkstreamId.get(workstreamId);
      if (!attention?.reasons.includes("packet_wave_complete_sync_needed")) {
        return false;
      }

      const repoSyncRecord = input.repoSyncRecords.get(task.repoId);
      const defaultBranch = repoConfig.defaultBranch ?? repoSyncRecord?.defaultBranch ?? undefined;

      const preflight = buildParentBranchSyncPreflight({ workstream, defaultBranch });
      if (!preflight) {
        return false;
      }

      return preflightsEquivalent(task.context.preflight, preflight);
    }
    case "wave_plan_assessment":
    case "wave_plan_replanning": {
      const parentPr = input.currentPullRequestsById.get(task.sourceId);
      if (!parentPr || parentPr.state !== "open") {
        return false;
      }

      const workstreamId = task.workstreamId ?? task.context.waveAssessmentCheckpoint?.identity.workstreamId;
      if (!workstreamId) {
        return false;
      }

      const workstream = input.workstreamsById.get(workstreamId);
      if (!workstream) {
        return false;
      }

      const issueNumber = workstream.linkedIssueNumber ?? (workstream.origin.type === "issue" ? workstream.origin.number : undefined);
      if (issueNumber === undefined) {
        return false;
      }

      const issue = input.currentIssuesByRepoAndNumber.get(`${workstream.repoKey}:${issueNumber}`);
      if (issue?.state !== "open") {
        return false;
      }

      const attention = input.attentionByWorkstreamId.get(workstreamId);
      if (!attention?.reasons.includes("packet_wave_complete_sync_needed")) {
        return false;
      }

      const repoConfig = input.repoConfigs.get(task.repoId);
      const repoSyncRecord = input.repoSyncRecords.get(task.repoId);
      return isCurrentWaveAssessmentTaskCheckpoint({
        task,
        parentPr,
        workstream,
        repoConfig,
        repoSyncRecord,
        previousTasks: input.previousTasks,
        previousExecutions: input.previousExecutions
      });
    }
    case "prepare_pr_for_merge": {
      const pullRequest = input.currentPullRequestsById.get(task.sourceId);
      const repoConfig = input.repoConfigs.get(task.repoId);

      if (isManagement(pullRequest)) return false;

      if (
        !pullRequest ||
        pullRequest.state !== "open" ||
        !repoConfig ||
        !pullRequest.labels.includes(repoConfig.labels.prepareForMerge)
      ) {
        return false;
      }

      const currentPreflight: PrepareForMergePreflight = {
        prNumber: pullRequest.number,
        headBranch: pullRequest.headBranch,
        headSha: pullRequest.headSha,
        baseBranch: pullRequest.baseBranch,
        prTitle: pullRequest.title
      };

      return prepareForMergePreflightsEquivalent(task.context.prepareForMerge, currentPreflight);
    }
    default:
      return false;
  }
}

function isCurrentWaveAssessmentTaskCheckpoint(input: {
  task: TaskRecord;
  parentPr: NormalizedPullRequest;
  workstream: WorkstreamRecord;
  repoConfig?: RepoConfig | undefined;
  repoSyncRecord?: RepoSyncRecord | undefined;
  previousTasks: TaskRecord[];
  previousExecutions: ExecutionRecord[];
}): boolean {
  const taskCheckpoint = input.task.context.waveAssessmentCheckpoint;
  if (!taskCheckpoint || !input.parentPr.headSha) {
    return false;
  }

  const defaultBranch =
    input.repoConfig?.defaultBranch ?? input.repoSyncRecord?.defaultBranch ?? undefined;
  const currentPreflight = buildParentBranchSyncPreflight({
    workstream: input.workstream,
    defaultBranch
  });
  if (!currentPreflight || !currentPreflight.parentPrNumber) {
    return false;
  }

  const currentIdentity = buildWaveAssessmentCheckpointIdentity(currentPreflight, {
    parentHeadSha: input.parentPr.headSha,
    planRevision: resolveCurrentPacketPlanRevision(input.workstream),
    originalPlanningSessionId: resolveCurrentOriginalPlanningSessionId({
      workstream: input.workstream,
      previousTasks: input.previousTasks,
      previousExecutions: input.previousExecutions
    }),
    planNodeIds: input.workstream.packetPlan
      ? Object.keys(input.workstream.packetPlan.packets).sort()
      : []
  });

  return waveAssessmentCheckpointIdentityMatches(
    taskCheckpoint.identity,
    currentIdentity
  );
}

function resolveCurrentPacketPlanRevision(workstream: WorkstreamRecord): string {
  return (
    workstream.packetPlan?.source?.generatedAt ??
    workstream.packetPlan?.updatedAt ??
    `${workstream.packetPlan?.currentWaveIndex ?? 0}:${Object.keys(workstream.packetPlan?.packets ?? {}).sort().join(",")}`
  );
}

function resolveCurrentOriginalPlanningSessionId(input: {
  workstream: WorkstreamRecord;
  previousTasks: TaskRecord[];
  previousExecutions: ExecutionRecord[];
}): string {
  const previousTasksById = new Map(input.previousTasks.map((task) => [task.id, task]));
  const planBreakdownExecutions = input.previousExecutions
    .filter((execution) => execution.taskKind === "plan_breakdown" && execution.taskStatus === "completed")
    .filter((execution) => previousTasksById.get(execution.taskId)?.workstreamId === input.workstream.id)
    .sort((left, right) => right.endedAt.localeCompare(left.endedAt));

  return planBreakdownExecutions[0]?.result?.planBreakdownSessionId ?? "unknown";
}
