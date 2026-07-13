export type CommentKind =
  | "issue_comment"
  | "pull_request_comment"
  | "pull_request_review"
  | "pull_request_review_comment";

export interface NormalizedTimestamps {
  createdAt: string;
  updatedAt: string;
  lastCommentAt?: string;
  lastSeenAt?: string;
  lastHandledAt?: string;
}

export interface NormalizedBaseEntity extends NormalizedTimestamps {
  id: string;
  kind: "issue" | "pull_request";
  repoId: string;
  repoKey: string;
  repoOwner: string;
  repoName: string;
  repoSlug: string;
  number: number;
  key: string;
  sourceId: string;
  url: string;
  title: string;
  body: string;
  labels: string[];
  author: string;
  state: "open" | "closed" | "merged";
}

export interface NormalizedIssue extends NormalizedBaseEntity {
  kind: "issue";
  state: "open" | "closed";
}

export interface NormalizedPullRequest extends NormalizedBaseEntity {
  kind: "pull_request";
  state: "open" | "closed" | "merged";
  headBranch: string;
  headSha: string;
  baseBranch: string;
  defaultBranch: string;
  baseClassification: "top_level" | "non_default_parent";
  isDraft: boolean;
}

export interface NormalizedPullRequestReviewCommentLocation {
  path?: string | undefined;
  line?: number | null | undefined;
  side?: string | null | undefined;
  startLine?: number | null | undefined;
  startSide?: string | null | undefined;
  originalLine?: number | null | undefined;
  originalStartLine?: number | null | undefined;
  commitId?: string | undefined;
  originalCommitId?: string | undefined;
  diffHunk?: string | undefined;
  inReplyToId?: number | undefined;
}

export interface NormalizedComment extends NormalizedTimestamps {
  kind: "comment";
  commentKind: CommentKind;
  id: string;
  sourceId: string;
  repoId: string;
  repoKey: string;
  repoOwner: string;
  repoName: string;
  repoSlug: string;
  parentType: "issue" | "pull_request";
  parentNumber: number;
  parentKey: string;
  url: string;
  body: string;
  author: string;
  reactionTargetId?: string | undefined;
  pullRequestReviewLocation?: NormalizedPullRequestReviewCommentLocation;
}
