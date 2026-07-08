import type { CommandRunner } from "../utils/command-runner.js";

export interface GhActor {
  login: string;
}

export interface GhLabel {
  name: string;
}

export interface GhIssueSummary {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  author: GhActor | null;
  labels: GhLabel[];
}

export interface GhPullRequestSummary {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  updatedAt: string;
  author: GhActor | null;
  labels: GhLabel[];
  headRefName: string;
  headSha: string | undefined;
  baseRefName: string;
  isDraft: boolean;
}

export interface GhComment {
  id: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: GhActor | null;
}

export interface GhPullRequestReview {
  id: string;
  url?: string;
  body?: string;
  submittedAt?: string;
  updatedAt?: string;
  state?: string;
  author: GhActor | null;
}

export interface GhPullRequestReviewComment {
  id: number;
  html_url?: string;
  body?: string;
  created_at: string;
  updated_at: string;
  user?: {
    login?: string;
  };
  path?: string;
  line?: number | null;
  side?: "LEFT" | "RIGHT" | string | null;
  start_line?: number | null;
  start_side?: "LEFT" | "RIGHT" | string | null;
  original_line?: number | null;
  original_start_line?: number | null;
  commit_id?: string;
  original_commit_id?: string;
  diff_hunk?: string;
  in_reply_to_id?: number;
}

export type GhPullRequestDiffSide = "LEFT" | "RIGHT";

export interface GhPullRequestChangedFile {
  path: string;
  rightChangedLines: number[];
  leftChangedLines: number[];
  rightCommentableLines: number[];
  leftCommentableLines: number[];
}

export interface GhSearchCodeItem {
  name: string;
  path: string;
  sha: string;
  url: string;
  gitUrl: string;
  htmlUrl: string;
  repository: {
    id: number;
    fullName: string;
    htmlUrl: string;
  };
}

export interface GhSearchCodeResult {
  totalCount: number;
  incompleteResults: boolean;
  items: GhSearchCodeItem[];
}

export interface GhIssueCommentMutationResult {
  id: number;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: GhActor | null;
}

export interface GhPullRequestReviewCommentReplyResult {
  id: number;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: GhActor | null;
}

export interface GhPullRequestReviewSubmissionResult {
  id: number;
  url: string;
  body: string;
  state: string;
  submittedAt: string;
  author: GhActor | null;
}

export type GitHubReactionCommentKind =
  | "issue_comment"
  | "pull_request_comment"
  | "pull_request_review"
  | "pull_request_review_comment";

export interface BrokerTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BrokerToolCallSuccess {
  ok: true;
  tool: string;
  result: Record<string, unknown>;
  summary: string;
}

export interface BrokerToolCallFailure {
  ok: false;
  tool: string;
  error: {
    code: string;
    message: string;
  };
}

export type BrokerToolCallResult = BrokerToolCallSuccess | BrokerToolCallFailure;

export interface BrokerToolService {
  readonly namespace?: string | undefined;
  listTools(): BrokerTool[];
  callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult>;
}

export interface GitHubRepositoryMetadata {
  id: string;
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
  defaultBranch: string;
}

export interface GitHubGateway {
  getRepositoryMetadata(owner: string, name: string): Promise<GitHubRepositoryMetadata>;
  getRepositoryDefaultBranch(owner: string, name: string): Promise<string>;
  getIssue(owner: string, name: string, issueNumber: number): Promise<GhIssueSummary>;
  getPullRequest(owner: string, name: string, prNumber: number): Promise<GhPullRequestSummary>;
  findOpenPullRequestByHeadBranch(
    owner: string,
    name: string,
    headBranch: string
  ): Promise<GhPullRequestSummary | null>;
  createPullRequest(input: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<GhPullRequestSummary>;
  searchCode(input: {
    owner: string;
    name: string;
    query: string;
    pathPrefix?: string;
    limit: number;
  }): Promise<GhSearchCodeResult>;
  postIssueComment(input: {
    owner: string;
    name: string;
    issueNumber: number;
    body: string;
  }): Promise<GhIssueCommentMutationResult>;
  updateIssueComment(input: {
    owner: string;
    name: string;
    commentId: string | number;
    body: string;
  }): Promise<GhIssueCommentMutationResult>;
  addReaction(input: {
    owner: string;
    name: string;
    issueNumber?: number;
    commentId?: string;
    commentKind?: GitHubReactionCommentKind;
    content: string;
  }): Promise<void>;
  postPullRequestReviewCommentReply(input: {
    owner: string;
    name: string;
    pullRequestNumber: number;
    commentId: number;
    body: string;
  }): Promise<GhPullRequestReviewCommentReplyResult>;
  submitPullRequestReview(input: {
    owner: string;
    name: string;
    pullRequestNumber: number;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body?: string;
    commitId?: string;
    comments?: Array<{
      path: string;
      line: number;
      side?: "LEFT" | "RIGHT";
      startLine?: number;
      startSide?: "LEFT" | "RIGHT";
      body: string;
    }>;
  }): Promise<GhPullRequestReviewSubmissionResult>;
  listOpenIssues(owner: string, name: string): Promise<GhIssueSummary[]>;
  listOpenPullRequests(owner: string, name: string): Promise<GhPullRequestSummary[]>;
  listIssueComments(owner: string, name: string, issueNumber: number): Promise<GhComment[]>;
  listPullRequestComments(owner: string, name: string, prNumber: number): Promise<GhComment[]>;
  listPullRequestReviews(owner: string, name: string, prNumber: number): Promise<GhPullRequestReview[]>;
  listPullRequestReviewComments(
    owner: string,
    name: string,
    prNumber: number
  ): Promise<GhPullRequestReviewComment[]>;
  listPullRequestChangedFiles(
    owner: string,
    name: string,
    prNumber: number
  ): Promise<GhPullRequestChangedFile[]>;
  listIssueEvents(
    owner: string,
    name: string,
    issueNumber: number
  ): Promise<GhIssueEvent[]>;
  listPullRequestCheckRuns(
    owner: string,
    name: string,
    headSha: string
  ): Promise<GhCheckRun[]>;
}

export interface GhIssueEvent {
  event: string;
  createdAt: string;
  actor: GhActor | null;
  label?: GhLabel;
}

export interface GhCheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
  conclusion: string | null;
  url: string;
  startedAt: string | null;
  completedAt: string | null;
}

