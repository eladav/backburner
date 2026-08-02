import type {
  NormalizedIssue,
  NormalizedComment,
  NormalizedPullRequest
} from "../../../domain/entities.js";
import { classifyManagementPullRequest } from "../../../github/pr-classification.js";
import { workflowRegistry } from "../../../workflows/registry.js";
import { isRetryLinkCommand } from "../../retry.js";
import { parseWaveReassessCommand } from "../../wave-reassess.js";
import type {
  PullRequestReviewCommentLocationContext,
  TaskKind,
  TaskRecord
} from "../../types.js";
import {
  buildCommentReason,
  buildTaskId,
  isAgentAuthoredComment
} from "../builders.js";
import type {
  CommentTaskWorktreeContext,
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler,
  TaskDerivationSink
} from "../types.js";

export const commentResponseHandler: TaskDerivationHandler = {
  name: "comment_response",
  derive(context, env) {
    return deriveCommentTasks(context, env);
  }
};

export function deriveManagementPullRequestCommentTasks(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment,
  _sink: TaskDerivationSink
): TaskRecord[] {
  return deriveCommentTasks(context, env).filter((task) => task.kind !== "respond_pr_comment");
}

function deriveCommentTasks(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord[] {
  const attention = context.attention;
  if (!attention?.commentIds?.length) {
    return [];
  }

  const tasks: TaskRecord[] = [];

  for (const commentId of [...attention.commentIds].sort((left, right) => left.localeCompare(right))) {
    const comment = env.currentCommentsById.get(commentId);
    if (!comment || isAgentAuthoredComment(comment)) {
      continue;
    }

    if (attention.reasons.includes("retry_requested") && isRetryLinkCommand(comment.body)) {
      continue;
    }

    const previousComment = env.previousComments.get(comment.id);
    const isNewOrEdited =
      !previousComment ||
      previousComment.updatedAt !== comment.updatedAt ||
      previousComment.body !== comment.body;
    if (!isNewOrEdited) {
      continue;
    }

    if (comment.parentType === "issue") {
      const issue = context.issue;
      if (!issue || issue.number !== comment.parentNumber) {
        continue;
      }

      if (!env.previousIssues.has(issue.id) && context.attention?.reasons.includes("new_issue")) {
        continue;
      }

      tasks.push(
        createCommentTask(
          "respond_issue_comment",
          comment,
          issue,
          {
            localRepoPath: context.repoSyncRecord?.localPath
          },
          {
            reason: buildCommentReason(comment, previousComment),
            summary: `Respond to issue comment on #${issue.number}: ${issue.title}`,
            contextBuilder: env.input.contextBuilder,
            now: env.input.now
          },
          undefined,
          context.workstream.id,
          context.workstream.phase
        )
      );
      continue;
    }

    const prTask = derivePullRequestCommentTask(comment, previousComment, context, env);
    if (prTask) {
      tasks.push(prTask);
    }
  }

  return tasks;
}

function derivePullRequestCommentTask(
  comment: NormalizedComment,
  previousComment: NormalizedComment | undefined,
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  let parentPullRequest = resolveCommentPullRequest(comment, context);
  let isPacketPR = false;
  let worktreeContext: CommentTaskWorktreeContext = {
    localRepoPath: context.activeWorktree?.path ?? context.repoSyncRecord?.localPath,
    branchName: context.activeWorktree?.branchName,
    planDocumentPath: context.activeWorktree?.planDocumentPath,
    productSpecDocumentPath: context.activeWorktree?.productSpecDocumentPath,
    logDocumentPath: context.activeWorktree?.logDocumentPath,
    packetId: context.activeWorktree?.packet?.packetId
  };

  if (!parentPullRequest) {
    const packetProjection = env.packetProjectionByRepoAndPrNumber.get(
      `${comment.repoId}:${comment.parentNumber}`
    );
    if (
      packetProjection &&
      packetProjection.parentWorkstream.id === context.workstream.id &&
      packetProjection.pullRequest.number === comment.parentNumber
    ) {
      parentPullRequest = packetProjection.pullRequest;
      isPacketPR = true;
      worktreeContext = {
        localRepoPath: packetProjection.packetWorktree?.path ?? context.repoSyncRecord?.localPath,
        branchName: packetProjection.packetWorktree?.branchName,
        planDocumentPath: packetProjection.packetWorktree?.planDocumentPath,
        productSpecDocumentPath: packetProjection.packetWorktree?.productSpecDocumentPath,
        logDocumentPath: packetProjection.packetWorktree?.logDocumentPath,
        packetId: packetProjection.packetWorktree?.packet?.packetId ?? packetProjection.packet.id
      };
    }
  }

  if (!parentPullRequest) {
    return undefined;
  }

  const isManagementPR = classifyManagementPullRequest({
    repoId: parentPullRequest.repoId,
    repoSlug: parentPullRequest.repoSlug,
    pullRequestNumber: parentPullRequest.number,
    headBranch: parentPullRequest.headBranch,
    managementPrs: env.input.previousState.managementPrs,
    ...(env.input.managementRepo ? { managementRepo: env.input.managementRepo } : {})
  }).kind === "management";

  if (isManagementPR) {
    return undefined;
  }

  if (
    !isPacketPR &&
    !env.previousPullRequests.has(parentPullRequest.id) &&
    parentPullRequest.number === comment.parentNumber
  ) {
    return undefined;
  }

  if (
    !isPacketPR &&
    comment.commentKind === "pull_request_comment" &&
    context.workstream.origin.type === "issue" &&
    context.workstream.packetPlan !== undefined &&
    context.workstream.integration?.prNumber === comment.parentNumber &&
    parseWaveReassessCommand(comment.body)
  ) {
    return undefined;
  }

  return createCommentTask(
    "respond_pr_comment",
    comment,
    parentPullRequest,
    worktreeContext,
    {
      reason: buildCommentReason(comment, previousComment),
      summary: `Respond to PR comment on #${parentPullRequest.number}: ${parentPullRequest.title}`,
      contextBuilder: env.input.contextBuilder,
      now: env.input.now
    },
    comment.pullRequestReviewLocation,
    context.workstream.id,
    context.workstream.phase
  );
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

function createCommentTask(
  kind: Extract<TaskKind, "respond_issue_comment" | "respond_pr_comment">,
  comment: NormalizedComment,
  parent: NormalizedIssue | NormalizedPullRequest,
  worktreeContext: CommentTaskWorktreeContext,
  input: {
    reason: string;
    summary: string;
    contextBuilder: TaskDerivationEnvironment["input"]["contextBuilder"];
    now: string;
  },
  pullRequestReviewLocation?: PullRequestReviewCommentLocationContext,
  workstreamId?: string,
  workflowPhase?: TaskRecord["workflowPhase"]
): TaskRecord {
  const executionPolicy = workflowRegistry.resolveTaskExecutionPolicy(kind);

  return {
    id: buildTaskId(kind, comment.id),
    kind,
    status: "pending",
    executionPermission: executionPolicy.executionPermission,
    handoffPolicy: executionPolicy.handoffPolicy,
    repoId: comment.repoId,
    repoName: comment.repoName,
    repoSlug: comment.repoSlug,
    sourceKind: "comment",
    sourceId: comment.id,
    sourceUrl: comment.url,
    sourceReactionTargetId: comment.reactionTargetId,
    parentSourceKind: comment.parentType === "issue" ? "issue" : "pull_request",
    parentSourceId: parent.id,
    relevant: true,
    reason: input.reason,
    summary: input.summary,
    ...(workstreamId ? { workstreamId } : {}),
    ...(workflowPhase ? { workflowPhase } : {}),
    context: input.contextBuilder.build({
      taskKind: kind,
      ...(workflowPhase ? { workflowPhase } : {}),
      repoIdentifier: comment.repoSlug,
      sourceKind: "comment",
      sourceUrl: comment.url,
      labels: parent.labels,
      parentUrl: parent.url,
      ...(parent.kind === "issue"
        ? {
          issueTitle: parent.title,
          issueBody: parent.body
        }
        : { headSha: parent.headSha }),
      commentUrl: comment.url,
      commentText: comment.body,
      ...(worktreeContext.localRepoPath ? { localRepoPath: worktreeContext.localRepoPath } : {}),
      ...(worktreeContext.branchName ? { branchName: worktreeContext.branchName } : {}),
      ...(worktreeContext.planDocumentPath ? { planDocumentPath: worktreeContext.planDocumentPath } : {}),
      ...(worktreeContext.productSpecDocumentPath ? { productSpecDocumentPath: worktreeContext.productSpecDocumentPath } : {}),
      ...(worktreeContext.logDocumentPath ? { logDocumentPath: worktreeContext.logDocumentPath } : {}),
      ...(worktreeContext.packetId ? { packetId: worktreeContext.packetId } : {}),
      ...(pullRequestReviewLocation ? { pullRequestReviewLocation } : {})
    }),
    createdAt: input.now,
    updatedAt: input.now
  };
}
