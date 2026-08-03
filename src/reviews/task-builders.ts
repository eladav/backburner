import type { NormalizedPullRequest } from "../domain/entities.js";
import type { WorktreeRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { workflowRegistry } from "../workflows/registry.js";
import type { FixResultV1, ReviewFindingV2, ReviewResultV2 } from "./contracts.js";

export interface ReviewCycleTaskIdentity {
  sessionId: string;
  workstreamId: string;
  packetId?: string;
  reviewOrdinal: number;
  expectedHeadSha: string;
}

export function buildReviewCycleReviewTask(input: {
  identity: ReviewCycleTaskIdentity;
  pullRequest: NormalizedPullRequest;
  worktree?: WorktreeRecord;
  now: string;
}): TaskRecord {
  const policy = workflowRegistry.resolveTaskExecutionPolicy("review_pr");
  return {
    id: `task:review_pr:${input.identity.sessionId}:review:${input.identity.reviewOrdinal}`,
    kind: "review_pr",
    status: "pending",
    executionPermission: policy.executionPermission,
    handoffPolicy: policy.handoffPolicy,
    repoId: input.pullRequest.repoId,
    repoName: input.pullRequest.repoName,
    repoSlug: input.pullRequest.repoSlug,
    sourceKind: "pull_request",
    sourceId: input.pullRequest.id,
    sourceUrl: input.pullRequest.url,
    relevant: true,
    reason: `Automatic review session ${input.identity.sessionId} is reviewing exact head ${input.identity.expectedHeadSha}.`,
    summary: `Automatic review of PR #${input.pullRequest.number} at ${input.identity.expectedHeadSha.slice(0, 12)}`,
    workstreamId: input.identity.workstreamId,
    context: {
      repoIdentifier: input.pullRequest.repoSlug,
      ...(input.worktree?.path ? { localRepoPath: input.worktree.path } : {}),
      ...(input.worktree?.branchName ? { branchName: input.worktree.branchName } : {}),
      ...(input.identity.packetId ? { packetId: input.identity.packetId } : {}),
      ...(input.worktree?.planDocumentPath ? { planDocumentPath: input.worktree.planDocumentPath } : {}),
      ...(input.worktree?.productSpecDocumentPath
        ? { productSpecDocumentPath: input.worktree.productSpecDocumentPath }
        : {}),
      ...(input.worktree?.logDocumentPath ? { logDocumentPath: input.worktree.logDocumentPath } : {}),
      pullRequestUrl: input.pullRequest.url,
      labels: [...input.pullRequest.labels],
      instruction: `Review the exact PR head ${input.identity.expectedHeadSha} under automatic review session ${input.identity.sessionId}.`,
      reviewCycle: {
        sessionId: input.identity.sessionId,
        reviewOrdinal: input.identity.reviewOrdinal,
        targetHeadSha: input.identity.expectedHeadSha,
        retryScope: "review_session"
      }
    },
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function buildReviewCycleFixTask(input: {
  identity: ReviewCycleTaskIdentity;
  pullRequest: NormalizedPullRequest;
  worktree: WorktreeRecord;
  review: ReviewResultV2;
  finding: ReviewFindingV2;
  precedingDispositions: Array<{
    findingId: string;
    disposition: FixResultV1["disposition"];
    summary: string;
  }>;
  reviewUrl?: string;
  now: string;
}): TaskRecord {
  const policy = workflowRegistry.resolveTaskExecutionPolicy("fix_review_finding");
  const turnNumber = input.identity.reviewOrdinal;
  return {
    id: `task:fix_review_finding:${input.identity.sessionId}:review:${input.identity.reviewOrdinal}:${input.finding.id}`,
    kind: "fix_review_finding",
    status: "pending",
    executionPermission: policy.executionPermission,
    handoffPolicy: policy.handoffPolicy,
    repoId: input.pullRequest.repoId,
    repoName: input.pullRequest.repoName,
    repoSlug: input.pullRequest.repoSlug,
    sourceKind: "pull_request",
    sourceId: input.pullRequest.id,
    sourceUrl: input.pullRequest.url,
    relevant: true,
    reason: `Automatic review session ${input.identity.sessionId}, turn ${turnNumber}, finding ${input.finding.id}.`,
    summary: `Fix ${input.finding.id} on PR #${input.pullRequest.number}: ${input.finding.title}`,
    workstreamId: input.identity.workstreamId,
    context: {
      repoIdentifier: input.pullRequest.repoSlug,
      localRepoPath: input.worktree.path,
      branchName: input.worktree.branchName,
      ...(input.identity.packetId ? { packetId: input.identity.packetId } : {}),
      planDocumentPath: input.worktree.planDocumentPath,
      ...(input.worktree.productSpecDocumentPath
        ? { productSpecDocumentPath: input.worktree.productSpecDocumentPath }
        : {}),
      logDocumentPath: input.worktree.logDocumentPath,
      pullRequestUrl: input.pullRequest.url,
      labels: [...input.pullRequest.labels],
      instruction: `Fix review finding ${input.finding.id}: ${input.finding.title}.`,
      reviewCycle: {
        sessionId: input.identity.sessionId,
        reviewOrdinal: input.identity.reviewOrdinal,
        turnNumber,
        findingId: input.finding.id,
        targetHeadSha: input.identity.expectedHeadSha,
        retryScope: "review_session"
      },
      reviewCycleFix: {
        finding: input.finding,
        findings: input.review.findings,
        precedingDispositions: input.precedingDispositions,
        review: input.review,
        ...(input.reviewUrl ? { reviewUrl: input.reviewUrl } : {})
      }
    },
    createdAt: input.now,
    updatedAt: input.now
  };
}
