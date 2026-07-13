import type { RepoConfig } from "../config/types.js";
import type {
  NormalizedComment,
  NormalizedIssue,
  NormalizedPullRequest
} from "../domain/entities.js";
import type {
  AttentionReason,
  AttentionRecord,
  PersistedState,
  WorkstreamMcpBlocker,
  WorkstreamRecord,
  WorktreeRecord
} from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { extractRetryCommentId } from "../tasks/retry.js";
import { extractMcpSkipCommand } from "../tasks/mcp-skip.js";
import { hasGeneratedPlanBreakdown, isParentSyncNeededBeforeNextWave } from "../workstreams/packet-plan.js";
import {
  collectPacketPullRequestCommentProjections,
  collectPacketPullRequestProjections
} from "../workstreams/packet-projections.js";

export interface AttentionDerivationInput {
  repos: RepoConfig[];
  workstreams: WorkstreamRecord[];
  previousState: PersistedState;
  currentIssues: NormalizedIssue[];
  currentPullRequests: NormalizedPullRequest[];
  currentComments: NormalizedComment[];
  tasks: TaskRecord[];
  worktrees?: WorktreeRecord[];
  now: string;
}

interface AttentionAccumulator {
  reasons: Set<AttentionReason>;
  issueNumber?: number;
  pullRequestNumbers: Set<number>;
  commentIds: Set<string>;
  retryTargetCommentId?: string;
  mcpSkipTargetTaskId?: string;
  mcpSkipMcpHandle?: string;
  currentPullRequestHeadSha?: string;
  lastHandledReviewHeadSha?: string;
  gaps: Set<string>;
}

export function deriveAttentionRecords(input: AttentionDerivationInput): AttentionRecord[] {
  const reposById = new Map(input.repos.map((repo) => [repo.id, repo]));
  const currentIssuesById = new Map(input.currentIssues.map((issue) => [issue.id, issue]));
  const currentPrsById = new Map(input.currentPullRequests.map((pr) => [pr.id, pr]));
  const previousIssuesById = new Map(input.previousState.issues.map((issue) => [issue.id, issue]));
  const previousPrsById = new Map(input.previousState.prs.map((pr) => [pr.id, pr]));
  const previousCommentsById = new Map(input.previousState.comments.map((comment) => [comment.id, comment]));
  const previousAttentionByWorkstreamId = new Map(
    input.previousState.attention.map((record) => [record.workstreamId, record])
  );
  const issueWorkstreamByKey = new Map<string, WorkstreamRecord>();
  const prWorkstreamByKey = new Map<string, WorkstreamRecord>();
  const handledReviewHeadShaByPrId = buildHandledReviewHeadShaByPrId(
    input.previousState,
    input.currentPullRequests,
    input.tasks
  );

  for (const workstream of input.workstreams) {
    if (workstream.origin.type === "issue" && workstream.linkedIssueNumber !== undefined) {
      issueWorkstreamByKey.set(buildIssueKey(workstream.repoKey, workstream.linkedIssueNumber), workstream);
    }

    for (const pr of workstream.linkedPrs) {
      prWorkstreamByKey.set(buildPrKey(workstream.repoKey, pr.number), workstream);
    }

    if (workstream.origin.type === "pr") {
      prWorkstreamByKey.set(buildPrKey(workstream.repoKey, workstream.origin.number), workstream);
    }
  }

  const worktrees = input.worktrees ?? input.previousState.worktrees;
  const packetPullRequestProjections = collectPacketPullRequestProjections({
    pullRequests: input.currentPullRequests,
    workstreams: input.workstreams,
    worktrees
  });

  const packetCommentProjectionByCommentId = new Map(
    collectPacketPullRequestCommentProjections({
      comments: input.currentComments,
      packetPullRequestProjections
    }).map((projection) => [projection.comment.id, projection])
  );

  const attentionByWorkstreamId = new Map<string, AttentionAccumulator>();

  for (const workstream of input.workstreams) {
    const currentIssue =
      workstream.origin.type === "issue"
        ? currentIssuesById.get(buildEntityId("issue", workstream.repoKey, workstream.origin.number))
        : undefined;
    const previousAttention = previousAttentionByWorkstreamId.get(workstream.id);
    const accumulator = getAccumulator(attentionByWorkstreamId, workstream.id);

    if (currentIssue) {
      accumulator.issueNumber = currentIssue.number;
      if (!previousIssuesById.has(currentIssue.id)) {
        accumulator.reasons.add("new_issue");
      }
    } else if (workstream.linkedIssueNumber !== undefined) {
      accumulator.issueNumber = workstream.linkedIssueNumber;
    }

    const currentLinkedPrs = resolveCurrentLinkedPullRequests(workstream, currentPrsById);
    const currentOpenLinkedPrs = currentLinkedPrs.filter((pr) => pr.state === "open");
    const repo =
      currentIssue?.repoId !== undefined
        ? reposById.get(currentIssue.repoId)
        : currentLinkedPrs[0]
          ? reposById.get(currentLinkedPrs[0].repoId)
          : undefined;

    for (const pr of currentLinkedPrs) {
      accumulator.pullRequestNumbers.add(pr.number);
      if (!previousPrsById.has(pr.id)) {
        accumulator.reasons.add("new_pr");
      }
    }

    if (workstream.origin.type === "pr" && currentLinkedPrs.length > 0) {
      accumulator.reasons.add("workstream_unlinked_pr");
    }

    if (repo) {
      for (const pr of currentOpenLinkedPrs) {
        if (!pr.labels.includes(repo.labels.agentReview)) {
          continue;
        }

        accumulator.reasons.add("pr_review_requested");
        accumulator.currentPullRequestHeadSha = pr.headSha;
        const handledHeadSha = handledReviewHeadShaByPrId.get(pr.id) ?? previousAttention?.lastHandledReviewHeadSha;
        if (handledHeadSha) {
          accumulator.lastHandledReviewHeadSha = handledHeadSha;
          if (handledHeadSha !== pr.headSha) {
            accumulator.reasons.add("pr_head_changed_since_last_review");
          }
        } else {
          accumulator.gaps.add(
            "Review handling is inferred from persisted state; external or unlabeled reviews are not tracked yet."
          );
        }
      }

      if (currentOpenLinkedPrs.some((pr) => pr.labels.includes(repo.labels.agentPlanApproved))) {
        accumulator.reasons.add("plan_approved");
      }

      if (currentIssue?.labels.includes(repo.labels.agentProductApproved)) {
        accumulator.reasons.add("product_approval_observed");
      }

      const planBreakdownAlreadyProduced = hasGeneratedPlanBreakdown(workstream);

      if (!planBreakdownAlreadyProduced && currentIssue?.labels.includes(repo.labels.planBreakdownNeeded)) {
        accumulator.reasons.add("plan_breakdown_requested");
      }

      if (
        !planBreakdownAlreadyProduced &&
        currentOpenLinkedPrs.some((pr) => pr.labels.includes(repo.labels.planBreakdownNeeded))
      ) {
        accumulator.reasons.add("plan_breakdown_requested");
      }

      if (currentOpenLinkedPrs.some((pr) => pr.labels.includes(repo.labels.prepareForMerge))) {
        accumulator.reasons.add("prepare_for_merge_requested");
      }
    }

    if (
      workstream.origin.type === "issue" &&
      workstream.packetPlan &&
      isParentSyncNeededBeforeNextWave(workstream.packetPlan)
    ) {
      accumulator.reasons.add("packet_wave_complete_sync_needed");
    }

    if (previousAttention?.issueNumber !== undefined && accumulator.issueNumber === undefined) {
      accumulator.issueNumber = previousAttention.issueNumber;
    }
  }

  for (const comment of [...input.currentComments].sort(compareComments)) {
    if (isAgentAuthoredComment(comment.body)) {
      continue;
    }

    const previousComment = previousCommentsById.get(comment.id);
    const isNew = previousComment === undefined;
    const isEdited =
      previousComment !== undefined &&
      (previousComment.updatedAt !== comment.updatedAt || previousComment.body !== comment.body);

    if (!isNew && !isEdited) {
      continue;
    }

    let workstream =
      comment.parentType === "issue"
        ? issueWorkstreamByKey.get(buildIssueKey(comment.repoKey, comment.parentNumber))
        : prWorkstreamByKey.get(buildPrKey(comment.repoKey, comment.parentNumber));

    if (!workstream && comment.parentType === "pull_request") {
      const packetProjection = packetCommentProjectionByCommentId.get(comment.id);
      if (packetProjection) {
        workstream = packetProjection.packetProjection.parentWorkstream;
      }
    }

    if (!workstream) {
      continue;
    }

    const accumulator = getAccumulator(attentionByWorkstreamId, workstream.id);
    accumulator.commentIds.add(comment.id);
    if (comment.parentType === "issue") {
      accumulator.issueNumber ??= comment.parentNumber;
      accumulator.reasons.add(isNew ? "issue_comment_added" : "issue_comment_edited");
      const issueRetryCommentId = extractRetryCommentId(comment.body);
      if (issueRetryCommentId !== undefined) {
        accumulator.reasons.add("retry_requested");
        accumulator.retryTargetCommentId ??= issueRetryCommentId;
      }
      if (isCancelRequest(comment.body)) {
        accumulator.reasons.add("cancel_requested");
      }
      const mcpSkipCommand = extractMcpSkipCommand(comment.body);
      if (mcpSkipCommand !== undefined) {
        const matchingBlocker = findMatchingMcpBlocker(
          workstream,
          mcpSkipCommand.taskId,
          mcpSkipCommand.mcpHandle
        );
        const isStale = matchingBlocker !== undefined && comment.createdAt < matchingBlocker.createdAt;
        if (!isStale) {
          accumulator.reasons.add("mcp_skip_requested");
          accumulator.mcpSkipTargetTaskId ??= mcpSkipCommand.taskId;
          accumulator.mcpSkipMcpHandle ??= mcpSkipCommand.mcpHandle;
        }
      }
      continue;
    }

    accumulator.pullRequestNumbers.add(comment.parentNumber);
    accumulator.reasons.add(isNew ? "pr_comment_added" : "pr_comment_edited");
    const retryCommentId = extractRetryCommentId(comment.body);
    if (retryCommentId !== undefined) {
      accumulator.reasons.add("retry_requested");
      accumulator.retryTargetCommentId ??= retryCommentId;
    }
    if (isCancelRequest(comment.body)) {
      accumulator.reasons.add("cancel_requested");
    }
    const mcpSkipCommand = extractMcpSkipCommand(comment.body);
    if (mcpSkipCommand !== undefined) {
      const matchingBlocker = findMatchingMcpBlocker(
        workstream,
        mcpSkipCommand.taskId,
        mcpSkipCommand.mcpHandle
      );
      const isStale = matchingBlocker !== undefined && comment.createdAt < matchingBlocker.createdAt;
      if (!isStale) {
        accumulator.reasons.add("mcp_skip_requested");
        accumulator.mcpSkipTargetTaskId ??= mcpSkipCommand.taskId;
        accumulator.mcpSkipMcpHandle ??= mcpSkipCommand.mcpHandle;
      }
    }
  }

  return [...input.workstreams]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((workstream) => {
      const accumulator = attentionByWorkstreamId.get(workstream.id) ?? {
        reasons: new Set<AttentionReason>(),
        pullRequestNumbers: new Set<number>(),
        commentIds: new Set<string>(),
        gaps: new Set<string>()
      };
      const previous = previousAttentionByWorkstreamId.get(workstream.id);
      const reasons = [...accumulator.reasons].sort((left, right) => left.localeCompare(right));
      const needsAction =
        workstream.status === "open" &&
        evaluateNeedsAction(
          reasons,
          accumulator.lastHandledReviewHeadSha,
          accumulator.currentPullRequestHeadSha
        );

      return {
        workstreamId: workstream.id,
        repoKey: workstream.repoKey,
        needsAction,
        reasons,
        ...(accumulator.issueNumber !== undefined ? { issueNumber: accumulator.issueNumber } : {}),
        ...(accumulator.pullRequestNumbers.size > 0
          ? {
              pullRequestNumbers: [...accumulator.pullRequestNumbers].sort((left, right) => left - right)
            }
          : {}),
        ...(accumulator.commentIds.size > 0
          ? { commentIds: [...accumulator.commentIds].sort((left, right) => left.localeCompare(right)) }
          : {}),
        ...(accumulator.retryTargetCommentId !== undefined
          ? { retryTargetCommentId: accumulator.retryTargetCommentId }
          : {}),
        ...(accumulator.mcpSkipTargetTaskId !== undefined
          ? { mcpSkipTargetTaskId: accumulator.mcpSkipTargetTaskId }
          : {}),
        ...(accumulator.mcpSkipMcpHandle !== undefined
          ? { mcpSkipMcpHandle: accumulator.mcpSkipMcpHandle }
          : {}),
        lastObservedAt: input.now,
        ...(previous?.lastHandledAt ? { lastHandledAt: previous.lastHandledAt } : {}),
        ...(accumulator.currentPullRequestHeadSha
          ? { currentPullRequestHeadSha: accumulator.currentPullRequestHeadSha }
          : {}),
        ...(accumulator.lastHandledReviewHeadSha
          ? { lastHandledReviewHeadSha: accumulator.lastHandledReviewHeadSha }
          : {}),
        ...(accumulator.gaps.size > 0
          ? { gaps: [...accumulator.gaps].sort((left, right) => left.localeCompare(right)) }
          : {})
      } satisfies AttentionRecord;
    });
}

function buildHandledReviewHeadShaByPrId(
  previousState: PersistedState,
  currentPullRequests: NormalizedPullRequest[],
  tasks: TaskRecord[]
): Map<string, string> {
  const handledByPrId = new Map<string, string>();
  const previousPrsById = new Map(previousState.prs.map((pr) => [pr.id, pr]));
  const currentPrsById = new Map(currentPullRequests.map((pr) => [pr.id, pr]));

  for (const task of previousState.tasks) {
    if (task.kind !== "review_pr" || task.status !== "completed") {
      continue;
    }

    const previousPr = previousPrsById.get(task.sourceId);
    if (previousPr) {
      handledByPrId.set(task.sourceId, previousPr.headSha);
    }
  }

  for (const task of tasks) {
    if (task.kind !== "review_pr" || task.status !== "completed") {
      continue;
    }

    const wasAlreadyCompleted = previousState.tasks.some(
      (t) => t.id === task.id && t.status === "completed"
    );
    if (wasAlreadyCompleted) {
      continue;
    }

    const currentPr = currentPrsById.get(task.sourceId);
    if (currentPr) {
      handledByPrId.set(task.sourceId, currentPr.headSha);
    }
  }

  return handledByPrId;
}

function resolveCurrentLinkedPullRequests(
  workstream: WorkstreamRecord,
  currentPrsById: Map<string, NormalizedPullRequest>
): NormalizedPullRequest[] {
  const prIds = new Set<string>();

  if (workstream.origin.type === "pr") {
    prIds.add(buildEntityId("pull_request", workstream.repoKey, workstream.origin.number));
  }

  for (const linkedPr of workstream.linkedPrs) {
    prIds.add(buildEntityId("pull_request", workstream.repoKey, linkedPr.number));
  }

  return [...prIds]
    .map((id) => currentPrsById.get(id))
    .filter((pr): pr is NormalizedPullRequest => pr !== undefined)
    .sort((left, right) => left.number - right.number);
}

function getAccumulator(
  attentionByWorkstreamId: Map<string, AttentionAccumulator>,
  workstreamId: string
): AttentionAccumulator {
  const existing = attentionByWorkstreamId.get(workstreamId);
  if (existing) {
    return existing;
  }

  const created: AttentionAccumulator = {
    reasons: new Set<AttentionReason>(),
    pullRequestNumbers: new Set<number>(),
    commentIds: new Set<string>(),
    gaps: new Set<string>()
  };
  attentionByWorkstreamId.set(workstreamId, created);
  return created;
}

function evaluateNeedsAction(
  reasons: AttentionReason[],
  lastHandledReviewHeadSha: string | undefined,
  currentPullRequestHeadSha: string | undefined
): boolean {
  return reasons.some((reason) =>
    reason === "new_issue" ||
    reason === "issue_comment_added" ||
    reason === "issue_comment_edited" ||
    reason === "new_pr" ||
    reason === "pr_comment_added" ||
    reason === "pr_comment_edited" ||
    reason === "pr_head_changed_since_last_review" ||
    reason === "product_approval_observed" ||
    reason === "plan_approved" ||
    reason === "plan_breakdown_requested" ||
    reason === "packet_wave_complete_sync_needed" ||
    reason === "prepare_for_merge_requested" ||
    reason === "retry_requested" ||
    reason === "cancel_requested" ||
    reason === "mcp_skip_requested" ||
    reason === "workstream_unlinked_pr" ||
    reason === "unknown_phase_needs_attention" ||
    (reason === "pr_review_requested" &&
      (!lastHandledReviewHeadSha ||
        (currentPullRequestHeadSha !== undefined && currentPullRequestHeadSha !== lastHandledReviewHeadSha)))
  );
}

function isAgentAuthoredComment(body: string): boolean {
  return body.trimStart().startsWith("🤖");
}


function isCancelRequest(body: string): boolean {
  return /\bcancel\b/i.test(body) || /\babandon\b/i.test(body);
}

function findMatchingMcpBlocker(
  workstream: WorkstreamRecord,
  taskId: string,
  mcpHandle: string
): WorkstreamMcpBlocker | undefined {
  return (workstream.mcpBlockers ?? []).find(
    (blocker) => blocker.blockedTaskId === taskId && blocker.mcpHandle === mcpHandle
  );
}

function buildIssueKey(repoKey: string, number: number): string {
  return `${repoKey}:issue:${number}`;
}

function buildPrKey(repoKey: string, number: number): string {
  return `${repoKey}:pr:${number}`;
}

function buildEntityId(kind: "issue" | "pull_request", repoKey: string, number: number): string {
  return `${kind}:${repoKey}:${number}`;
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
