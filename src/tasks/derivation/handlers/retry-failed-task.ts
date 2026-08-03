import { createEntityId } from "../../../github/normalize.js";
import type { TaskRecord } from "../../types.js";
import { extractRetryCommentId } from "../../retry.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler,
  TaskDerivationSink
} from "../types.js";

export const retryFailedTaskHandler: TaskDerivationHandler = {
  name: "retry_failed_task",
  derive(context, env, sink) {
    for (const task of deriveRetryTasks(context, env, sink)) {
      sink.replace(task);
    }
    return [];
  }
};

interface RetryRequest {
  targetFailureCommentId: string;
}

const RETRY_REASON_SUFFIX = "Retry requested by a human comment after a technical failure.";

function deriveRetryTasks(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment,
  sink: TaskDerivationSink
): TaskRecord[] {
  const legacyRetryTargetCommentId = getLegacyRetryTargetCommentId(context, env);
  if (!context.attention?.reasons.includes("retry_requested") && !legacyRetryTargetCommentId) {
    return [];
  }

  const retryRequests = collectRetryRequests(context, env, legacyRetryTargetCommentId);
  if (retryRequests.length === 0) {
    return [];
  }

  const requeuedTasks = new Map<string, TaskRecord>();
  for (const request of retryRequests) {
    for (const failedTask of findMatchingFailedTasks(request, context, env)) {
      // prepare_pr_for_merge retry depends on normal derivation having already built
      // the current-cycle task; keep retryFailedTaskHandler after parent handlers.
      const currentDesiredTask = sink.get(failedTask.id);
      if (failedTask.kind === "prepare_pr_for_merge" && !currentDesiredTask) {
        continue;
      }

      const baseTask = currentDesiredTask ?? failedTask;
      requeuedTasks.set(failedTask.id, {
        ...baseTask,
        status: "pending",
        context: {
          ...baseTask.context,
          recoveryNeeded: true
        },
        reason: appendRetryReason(baseTask.reason),
        ...(failedTask.lastExecutionId ? { lastExecutionId: failedTask.lastExecutionId } : {}),
        ...(failedTask.lastFailureCommentId ? { lastFailureCommentId: failedTask.lastFailureCommentId } : {}),
        updatedAt: env.input.now
      });
    }
  }

  return [...requeuedTasks.values()];
}

function collectRetryRequests(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment,
  legacyRetryTargetCommentId: string | undefined
): RetryRequest[] {
  const requests = new Map<string, RetryRequest>();

  for (const commentId of context.attention?.commentIds ?? []) {
    const comment = env.currentCommentsById.get(commentId);
    const targetFailureCommentId = comment ? extractRetryCommentId(comment.body) : undefined;
    if (!targetFailureCommentId || requests.has(targetFailureCommentId)) {
      continue;
    }

    requests.set(targetFailureCommentId, {
      targetFailureCommentId
    });
  }

  if (requests.size === 0 && legacyRetryTargetCommentId) {
    requests.set(legacyRetryTargetCommentId, {
      targetFailureCommentId: legacyRetryTargetCommentId
    });
  }

  return [...requests.values()];
}

function findMatchingFailedTasks(
  request: RetryRequest,
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord[] {
  const candidates = env.existingTasks.filter(
    (task) =>
      task.status === "failed" &&
      task.context.reviewCycle === undefined &&
      task.lastFailureCommentId === request.targetFailureCommentId &&
      taskMatchesRepo(task, context)
  );

  const modernMatches = candidates.filter((task) => task.workstreamId === context.workstream.id);
  if (modernMatches.length > 1) {
    console.warn(
      `[retry_failed_task] Multiple modern tasks matched failure comment ${request.targetFailureCommentId} for workstream ${context.workstream.id}; retrying all: ${modernMatches.map((task) => task.id).join(", ")}`
    );
  }
  if (modernMatches.length > 0) {
    return modernMatches;
  }

  const legacySourceIds = buildLegacyWorkstreamSourceIds(context);
  const legacyMatches = candidates.filter(
    (task) => task.workstreamId === undefined && legacyTaskMatchesCurrentWorkstreamSource(task, legacySourceIds)
  );
  if (legacyMatches.length > 1) {
    console.warn(
      `[retry_failed_task] Ignoring ambiguous legacy retry target ${request.targetFailureCommentId} for workstream ${context.workstream.id}; matched tasks: ${legacyMatches.map((task) => task.id).join(", ")}`
    );
    return [];
  }

  return legacyMatches.length === 1 ? legacyMatches : [];
}

function appendRetryReason(reason: string): string {
  const suffix = ` ${RETRY_REASON_SUFFIX}`;
  let baseReason = reason;
  while (baseReason.endsWith(suffix)) {
    baseReason = baseReason.slice(0, -suffix.length);
  }

  return `${baseReason}${suffix}`;
}

function getLegacyRetryTargetCommentId(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): string | undefined {
  return env.input.previousState.attention.find(
    (record) => record.workstreamId === context.workstream.id
  )?.retryTargetCommentId;
}

function taskMatchesRepo(task: TaskRecord, context: ResolvedWorkstreamContext): boolean {
  if (task.repoSlug === context.workstream.repoKey) {
    return true;
  }

  return Boolean(context.repoConfig && task.repoId === context.repoConfig.id);
}

function legacyTaskMatchesCurrentWorkstreamSource(
  task: TaskRecord,
  sourceIds: Set<string>
): boolean {
  return (
    sourceIds.has(task.sourceId) ||
    (task.parentSourceId !== undefined && sourceIds.has(task.parentSourceId))
  );
}

function buildLegacyWorkstreamSourceIds(context: ResolvedWorkstreamContext): Set<string> {
  const sourceIds = new Set<string>();
  if (context.issue) {
    sourceIds.add(context.issue.id);
  }
  if (context.activePullRequest) {
    sourceIds.add(context.activePullRequest.id);
  }
  for (const prNumber of context.attention?.pullRequestNumbers ?? []) {
    sourceIds.add(createEntityId("pull_request", context.workstream.repoKey, prNumber));
  }
  if (context.workstream.origin.type === "pr") {
    sourceIds.add(createEntityId("pull_request", context.workstream.repoKey, context.workstream.origin.number));
  }
  if (context.workstream.origin.type === "issue") {
    sourceIds.add(createEntityId("issue", context.workstream.repoKey, context.workstream.origin.number));
  }

  return sourceIds;
}
