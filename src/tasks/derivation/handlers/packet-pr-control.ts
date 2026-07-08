import type { RepoConfig } from "../../../config/types.js";
import type { NormalizedPullRequest } from "../../../domain/entities.js";
import { classifyManagementPullRequest } from "../../../github/pr-classification.js";
import type { PacketPullRequestProjection } from "../../../workstreams/packet-projections.js";
import type { TaskRecord } from "../../types.js";
import {
  buildTaskId,
  createPullRequestTask
} from "../builders.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler,
  TaskDerivationSink
} from "../types.js";
import { createPrepareForMergeTask } from "./prepare-for-merge.js";
import { isActiveParentWorkstream } from "./shared.js";

export const packetPullRequestControlHandler: TaskDerivationHandler = {
  name: "packet_pr_control",
  derive(context, env, sink) {
    return derivePacketPullRequestTasks(context, env, sink);
  }
};

function derivePacketPullRequestTasks(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment,
  sink: TaskDerivationSink
): TaskRecord[] {
  if (!isActiveParentWorkstream(context.workstream)) {
    return [];
  }

  const tasks: TaskRecord[] = [];
  const projectionsForWorkstream = env.packetPullRequestProjections.filter(
    (projection) => projection.parentWorkstream.id === context.workstream.id
  );

  for (const projection of projectionsForWorkstream) {
    const isManagementPR = classifyManagementPullRequest({
      repoId: projection.pullRequest.repoId,
      repoSlug: projection.pullRequest.repoSlug,
      pullRequestNumber: projection.pullRequest.number,
      headBranch: projection.pullRequest.headBranch,
      managementPrs: env.input.previousState.managementPrs,
      ...(env.input.managementRepo ? { managementRepo: env.input.managementRepo } : {})
    }).kind === "management";

    if (isManagementPR) {
      continue;
    }

    const repoConfig = env.repoConfigs.get(projection.pullRequest.repoId);
    if (!repoConfig || projection.pullRequest.state !== "open") {
      continue;
    }

    if (projection.pullRequest.labels.includes(repoConfig.labels.agentReview)) {
      const packetReviewTask = derivePacketPullRequestReviewTask(context, projection, repoConfig, env, sink);
      if (packetReviewTask) {
        tasks.push(packetReviewTask);
      }
    }

    if (projection.pullRequest.labels.includes(repoConfig.labels.prepareForMerge)) {
      const packetPrepareForMergeTask = createPrepareForMergeTask({
        pullRequest: projection.pullRequest,
        repoSyncRecord: env.repoSyncRecords.get(projection.pullRequest.repoId),
        repoConfig,
        contextBuilder: env.input.contextBuilder,
        now: env.input.now,
        workstreamId: context.workstream.id,
        worktree: projection.packetWorktree,
        packetProjection: projection
      });
      tasks.push(packetPrepareForMergeTask);
    }
  }

  return tasks;
}

function derivePacketPullRequestReviewTask(
  context: ResolvedWorkstreamContext,
  projection: PacketPullRequestProjection,
  repoConfig: RepoConfig,
  env: TaskDerivationEnvironment,
  sink: TaskDerivationSink
): TaskRecord | undefined {
  const handledHeadSha = findHandledReviewHeadShaForPullRequest({
    pullRequest: projection.pullRequest,
    previousPullRequests: env.input.previousState.prs,
    currentPullRequests: env.currentPullRequests,
    tasks: env.input.previousState.tasks
  });

  if (handledHeadSha && handledHeadSha === projection.pullRequest.headSha) {
    const taskId = buildTaskId("review_pr", projection.pullRequest.id);
    sink.preserveExisting(taskId);
    return undefined;
  }

  return createPullRequestTask(
    "review_pr",
    projection.pullRequest,
    env.repoSyncRecords.get(projection.pullRequest.repoId),
    {
      reason: `Packet pull request has the "${repoConfig.labels.agentReview}" label and code changed (head: ${projection.pullRequest.headSha || "unknown"}).`,
      summary: `Review packet PR #${projection.pullRequest.number}: ${projection.pullRequest.title}`,
      contextBuilder: env.input.contextBuilder,
      now: env.input.now
    },
    projection.packetWorktree,
    context.workstream.id
  );
}

function findHandledReviewHeadShaForPullRequest(input: {
  pullRequest: NormalizedPullRequest;
  previousPullRequests: NormalizedPullRequest[];
  currentPullRequests: NormalizedPullRequest[];
  tasks: TaskRecord[];
}): string | undefined {
  const latestCompletedTask = input.tasks
    .filter(
      (task) =>
        task.kind === "review_pr" &&
        task.status === "completed" &&
        task.sourceId === input.pullRequest.id
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  if (!latestCompletedTask) {
    return undefined;
  }

  const previousPr = input.previousPullRequests.find((pr) => pr.id === input.pullRequest.id);
  if (previousPr) {
    return previousPr.headSha;
  }

  const currentPr = input.currentPullRequests.find((pr) => pr.id === input.pullRequest.id);
  if (currentPr) {
    return currentPr.headSha;
  }

  return undefined;
}
