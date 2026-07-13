import type { RepoConfig } from "../config/types.js";
import type {
  CommentKind,
  NormalizedComment,
  NormalizedIssue,
  NormalizedPullRequest,
  NormalizedPullRequestReviewCommentLocation
} from "../domain/entities.js";
import { classifyPullRequestBase } from "./pr-classification.js";
import type {
  GhComment,
  GhIssueSummary,
  GhPullRequestReview,
  GhPullRequestReviewComment,
  GhPullRequestSummary,
  GitHubRepositoryMetadata
} from "./types.js";

export interface NormalizeContext {
  repo: RepoConfig;
  repoMetadata: GitHubRepositoryMetadata;
  seenAt: string;
  previousIssues: Map<string, NormalizedIssue>;
  previousPullRequests: Map<string, NormalizedPullRequest>;
  previousComments: Map<string, NormalizedComment>;
}

export function normalizeIssue(
  issue: GhIssueSummary,
  comments: NormalizedComment[],
  context: NormalizeContext
): NormalizedIssue {
  const id = createEntityId("issue", context.repoMetadata.nameWithOwner, issue.number);
  const previous = context.previousIssues.get(id);

  return {
    kind: "issue",
    id,
    repoId: context.repo.id,
    repoKey: context.repoMetadata.nameWithOwner,
    repoOwner: context.repoMetadata.owner,
    repoName: context.repoMetadata.name,
    repoSlug: context.repoMetadata.nameWithOwner,
    number: issue.number,
    key: createEntityKey("issue", context.repoMetadata.nameWithOwner, issue.number),
    sourceId: String(issue.id),
    url: issue.url,
    title: issue.title,
    body: issue.body ?? "",
    labels: normalizeLabels(issue.labels),
    author: normalizeActor(issue.author?.login),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ...withOptionalTimestamps(findLastCommentAt(comments), context.seenAt, previous?.lastHandledAt),
    state: normalizeIssueState(issue.state)
  };
}

export function normalizePullRequest(
  pr: GhPullRequestSummary,
  comments: NormalizedComment[],
  context: NormalizeContext
): NormalizedPullRequest {
  const id = createEntityId("pull_request", context.repoMetadata.nameWithOwner, pr.number);
  const previous = context.previousPullRequests.get(id);

  return {
    kind: "pull_request",
    id,
    repoId: context.repo.id,
    repoKey: context.repoMetadata.nameWithOwner,
    repoOwner: context.repoMetadata.owner,
    repoName: context.repoMetadata.name,
    repoSlug: context.repoMetadata.nameWithOwner,
    number: pr.number,
    key: createEntityKey("pull_request", context.repoMetadata.nameWithOwner, pr.number),
    sourceId: String(pr.id),
    url: pr.url,
    title: pr.title,
    body: pr.body ?? "",
    labels: normalizeLabels(pr.labels),
    author: normalizeActor(pr.author?.login),
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    ...withOptionalTimestamps(findLastCommentAt(comments), context.seenAt, previous?.lastHandledAt),
    state: normalizePullRequestState(pr.state),
    headBranch: pr.headRefName,
    headSha: pr.headSha ?? "",
    baseBranch: pr.baseRefName,
    defaultBranch: context.repoMetadata.defaultBranch,
    baseClassification: classifyPullRequestBase({
      pullRequestNumber: pr.number,
      repoSlug: context.repoMetadata.nameWithOwner,
      baseBranch: pr.baseRefName,
      defaultBranch: context.repoMetadata.defaultBranch
    }).kind,
    isDraft: pr.isDraft
  };
}

export function normalizeIssueComments(
  comments: GhComment[],
  parentNumber: number,
  parentType: "issue" | "pull_request",
  commentKind: Extract<CommentKind, "issue_comment" | "pull_request_comment">,
  context: NormalizeContext
): NormalizedComment[] {
  return comments.map((comment) =>
    normalizeComment({
      sourceId: String(comment.id),
      url: comment.url,
      body: comment.body ?? "",
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: normalizeActor(comment.author?.login),
      parentNumber,
      parentType,
      commentKind,
      context,
      reactionTargetId: String(comment.id)
    })
  );
}

export function normalizePullRequestReviews(
  reviews: GhPullRequestReview[],
  parentNumber: number,
  context: NormalizeContext
): NormalizedComment[] {
  return reviews
    .filter((review) => (review.body ?? "").trim() !== "")
    .map((review) => {
      const createdAt = review.submittedAt ?? review.updatedAt;
      const updatedAt = review.updatedAt ?? review.submittedAt;

      if (!createdAt || !updatedAt) {
        throw new Error(
          `PR review ${review.id} in ${context.repoMetadata.nameWithOwner} is missing timestamps`
        );
      }

      return normalizeComment({
        sourceId: String(review.id),
        url: review.url ?? "",
        body: review.body ?? "",
        createdAt,
        updatedAt,
        author: normalizeActor(review.author?.login),
        parentNumber,
        parentType: "pull_request",
        commentKind: "pull_request_review",
        context,
        reactionTargetId: String(review.id)
      });
    });
}

export function normalizePullRequestReviewComments(
  comments: GhPullRequestReviewComment[],
  parentNumber: number,
  context: NormalizeContext
): NormalizedComment[] {
  return comments.map((comment) =>
    normalizeComment({
      sourceId: String(comment.id),
      url: comment.html_url ?? "",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      author: normalizeActor(comment.user?.login),
      parentNumber,
      parentType: "pull_request",
      commentKind: "pull_request_review_comment",
      context,
      reactionTargetId: String(comment.id),
      pullRequestReviewLocation: buildPullRequestReviewLocation(comment)
    })
  );
}

export function buildPullRequestReviewLocation(
  comment: GhPullRequestReviewComment
): NormalizedPullRequestReviewCommentLocation | undefined {
  const location: NormalizedPullRequestReviewCommentLocation = {
    path: comment.path ?? undefined,
    line: comment.line ?? undefined,
    side: comment.side ?? undefined,
    startLine: comment.start_line ?? undefined,
    startSide: comment.start_side ?? undefined,
    originalLine: comment.original_line ?? undefined,
    originalStartLine: comment.original_start_line ?? undefined,
    commitId: comment.commit_id ?? undefined,
    originalCommitId: comment.original_commit_id ?? undefined,
    diffHunk: comment.diff_hunk ?? undefined,
    inReplyToId: comment.in_reply_to_id ?? undefined
  };

  function hasMeaningfulLocationValue(value: unknown): boolean {
    if (typeof value === "string") {
      return value.trim().length > 0;
    }

    if (typeof value === "number") {
      return true;
    }

    return false;
  }

  const hasMeaningfulField = [
    comment.path,
    comment.line,
    comment.start_line,
    comment.original_line,
    comment.original_start_line,
    comment.diff_hunk,
    comment.commit_id,
    comment.original_commit_id,
    comment.in_reply_to_id,
    comment.side,
    comment.start_side
  ].some(hasMeaningfulLocationValue);

  return hasMeaningfulField ? location : undefined;
}

export function createEntityId(
  kind: "issue" | "pull_request",
  repoSlug: string,
  number: number
): string {
  return `${kind}:${repoSlug}:${number}`;
}

export function createEntityKey(
  kind: "issue" | "pull_request",
  repoSlug: string,
  number: number
): string {
  return `${repoSlug}:${kind}:${number}`;
}

export function createCommentId(
  repoSlug: string,
  commentKind: CommentKind,
  sourceId: string
): string {
  return `comment:${repoSlug}:${commentKind}:${sourceId}`;
}

export function normalizeComment(input: {
  sourceId: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: string;
  parentNumber: number;
  parentType: "issue" | "pull_request";
  commentKind: CommentKind;
  context: NormalizeContext;
  reactionTargetId?: string;
  pullRequestReviewLocation?: NormalizedPullRequestReviewCommentLocation | undefined;
}): NormalizedComment {
  const id = createCommentId(
    input.context.repoMetadata.nameWithOwner,
    input.commentKind,
    input.sourceId
  );
  const previous = input.context.previousComments.get(id);

  return {
    ...previous,
    kind: "comment",
    commentKind: input.commentKind,
    id,
    sourceId: input.sourceId,
    repoId: input.context.repo.id,
    repoKey: input.context.repoMetadata.nameWithOwner,
    repoOwner: input.context.repoMetadata.owner,
    repoName: input.context.repoMetadata.name,
    repoSlug: input.context.repoMetadata.nameWithOwner,
    parentType: input.parentType,
    parentNumber: input.parentNumber,
    parentKey: createEntityKey(
      input.parentType === "issue" ? "issue" : "pull_request",
      input.context.repoMetadata.nameWithOwner,
      input.parentNumber
    ),
    url: input.url,
    body: input.body,
    author: input.author,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    reactionTargetId: input.reactionTargetId,
    lastSeenAt: input.context.seenAt,
    ...(previous?.lastHandledAt ? { lastHandledAt: previous.lastHandledAt } : {}),
    ...(input.pullRequestReviewLocation ? { pullRequestReviewLocation: input.pullRequestReviewLocation } : {}),
  };
}

function normalizeActor(login: string | undefined): string {
  return login?.trim() || "unknown";
}

function normalizeLabels(labels: Array<{ name: string }> | undefined): string[] {
  return (labels ?? []).map((label) => label.name).sort((left, right) => left.localeCompare(right));
}

function normalizeIssueState(state: GhIssueSummary["state"]): "open" | "closed" {
  return state === "OPEN" ? "open" : "closed";
}

function normalizePullRequestState(
  state: GhPullRequestSummary["state"]
): "open" | "closed" | "merged" {
  if (state === "MERGED") {
    return "merged";
  }

  return state === "OPEN" ? "open" : "closed";
}

function findLastCommentAt(comments: NormalizedComment[]): string | undefined {
  return comments.reduce<string | undefined>((latest, comment) => {
    if (!latest) {
      return comment.updatedAt;
    }

    return comment.updatedAt > latest ? comment.updatedAt : latest;
  }, undefined);
}

function withOptionalTimestamps(
  lastCommentAt: string | undefined,
  lastSeenAt: string | undefined,
  lastHandledAt: string | undefined
): Partial<Pick<NormalizedIssue, "lastCommentAt" | "lastSeenAt" | "lastHandledAt">> {
  return {
    ...(lastCommentAt ? { lastCommentAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(lastHandledAt ? { lastHandledAt } : {})
  };
}
