import type {
  GitHubGateway,
  GitHubRepositoryMetadata,
  GhIssueSummary,
  GhPullRequestSummary,
  GhComment,
  GhPullRequestReview,
  GhPullRequestReviewComment,
  GhPullRequestChangedFile,
  GhSearchCodeResult,
  GhIssueCommentMutationResult,
  GhPullRequestReviewCommentReplyResult,
  GhPullRequestReviewSubmissionResult,
  GhIssueEvent,
  GhCheckRun
} from "./types.js";

export class SecurityFilteredGitHubGateway implements GitHubGateway {
  constructor(
    private readonly inner: GitHubGateway,
    private readonly allowedUsers: string[]
  ) {}

  private isAllowed(login: string | undefined | null): boolean {
    return this.allowedUsers.includes(login || "");
  }

  async getAuthenticatedUser(): Promise<string> {
    return this.inner.getAuthenticatedUser();
  }

  async getRepositoryMetadata(owner: string, name: string): Promise<GitHubRepositoryMetadata> {
    return this.inner.getRepositoryMetadata(owner, name);
  }

  async getRepositoryDefaultBranch(owner: string, name: string): Promise<string> {
    return this.inner.getRepositoryDefaultBranch(owner, name);
  }

  async getIssue(owner: string, name: string, issueNumber: number): Promise<GhIssueSummary> {
    const issue = await this.inner.getIssue(owner, name, issueNumber);
    if (!this.isAllowed(issue.author?.login)) {
      throw new Error(`Unauthorized: Issue #${issueNumber} author is not in allowedUsers`);
    }
    return this.filterLabels(owner, name, issue);
  }

  async getPullRequest(owner: string, name: string, prNumber: number): Promise<GhPullRequestSummary> {
    const pr = await this.inner.getPullRequest(owner, name, prNumber);
    if (!this.isAllowed(pr.author?.login)) {
      throw new Error(`Unauthorized: PR #${prNumber} author is not in allowedUsers`);
    }
    return this.filterLabels(owner, name, pr);
  }

  async findOpenPullRequestByHeadBranch(
    owner: string,
    name: string,
    headBranch: string
  ): Promise<GhPullRequestSummary | null> {
    const pr = await this.inner.findOpenPullRequestByHeadBranch(owner, name, headBranch);
    if (pr && !this.isAllowed(pr.author?.login)) {
      return null;
    }
    if (!pr) {
      return null;
    }
    return this.filterLabels(owner, name, pr);
  }

  async createPullRequest(input: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<GhPullRequestSummary> {
    const pr = await this.inner.createPullRequest(input);
    if (!this.isAllowed(pr.author?.login)) {
      throw new Error(`Unauthorized: Created PR author is not in allowedUsers`);
    }
    return this.filterLabels(input.owner, input.name, pr);
  }

  async listOpenIssues(owner: string, name: string): Promise<GhIssueSummary[]> {
    const issues = await this.inner.listOpenIssues(owner, name);
    const filteredIssues = issues.filter((issue) => this.isAllowed(issue.author?.login));
    return Promise.all(filteredIssues.map((issue) => this.filterLabels(owner, name, issue)));
  }

  async listOpenPullRequests(owner: string, name: string): Promise<GhPullRequestSummary[]> {
    const prs = await this.inner.listOpenPullRequests(owner, name);
    const filteredPrs = prs.filter((pr) => this.isAllowed(pr.author?.login));
    return Promise.all(filteredPrs.map((pr) => this.filterLabels(owner, name, pr)));
  }

  async listIssueComments(owner: string, name: string, issueNumber: number): Promise<GhComment[]> {
    const comments = await this.inner.listIssueComments(owner, name, issueNumber);
    return comments.filter((comment) => this.isAllowed(comment.author?.login));
  }

  async listPullRequestComments(owner: string, name: string, prNumber: number): Promise<GhComment[]> {
    const comments = await this.inner.listPullRequestComments(owner, name, prNumber);
    return comments.filter((comment) => this.isAllowed(comment.author?.login));
  }

  async listPullRequestReviews(owner: string, name: string, prNumber: number): Promise<GhPullRequestReview[]> {
    const reviews = await this.inner.listPullRequestReviews(owner, name, prNumber);
    return reviews.filter((review) => this.isAllowed(review.author?.login));
  }

  async listPullRequestReviewComments(
    owner: string,
    name: string,
    prNumber: number
  ): Promise<GhPullRequestReviewComment[]> {
    const comments = await this.inner.listPullRequestReviewComments(owner, name, prNumber);
    return comments.filter((comment) => this.isAllowed(comment.user?.login));
  }

  async listPullRequestChangedFiles(
    owner: string,
    name: string,
    prNumber: number
  ): Promise<GhPullRequestChangedFile[]> {
    return this.inner.listPullRequestChangedFiles(owner, name, prNumber);
  }

  async searchCode(input: {
    owner: string;
    name: string;
    query: string;
    pathPrefix?: string;
    limit: number;
  }): Promise<GhSearchCodeResult> {
    return this.inner.searchCode(input);
  }

  async postIssueComment(input: {
    owner: string;
    name: string;
    issueNumber: number;
    body: string;
  }): Promise<GhIssueCommentMutationResult> {
    return this.inner.postIssueComment(input);
  }

  async updateIssueComment(input: {
    owner: string;
    name: string;
    commentId: string | number;
    body: string;
  }): Promise<GhIssueCommentMutationResult> {
    return this.inner.updateIssueComment(input);
  }

  async addReaction(input: {
    owner: string;
    name: string;
    issueNumber?: number;
    commentId?: string;
    commentKind?: "issue_comment" | "pull_request_comment" | "pull_request_review" | "pull_request_review_comment";
    content: string;
  }): Promise<void> {
    return this.inner.addReaction(input);
  }

  async postPullRequestReviewCommentReply(input: {
    owner: string;
    name: string;
    pullRequestNumber: number;
    commentId: number;
    body: string;
  }): Promise<GhPullRequestReviewCommentReplyResult> {
    return this.inner.postPullRequestReviewCommentReply(input);
  }

  async submitPullRequestReview(input: {
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
  }): Promise<GhPullRequestReviewSubmissionResult> {
    return this.inner.submitPullRequestReview(input);
  }

  async listIssueEvents(
    owner: string,
    name: string,
    issueNumber: number
  ): Promise<GhIssueEvent[]> {
    return this.inner.listIssueEvents(owner, name, issueNumber);
  }

  async listPullRequestCheckRuns(
    owner: string,
    name: string,
    headSha: string
  ): Promise<GhCheckRun[]> {
    return this.inner.listPullRequestCheckRuns(owner, name, headSha);
  }

  private async filterLabels<T extends GhIssueSummary | GhPullRequestSummary>(
    owner: string,
    name: string,
    entity: T
  ): Promise<T> {
    const labels = entity.labels || [];
    if (labels.length === 0) {
      return {
        ...entity,
        labels: []
      };
    }

    const events = await this.inner.listIssueEvents(owner, name, entity.number);
    const allowedLabels = new Set<string>();

    for (const label of labels) {
      const labelEvents = events.filter(
        (e) => e.label?.name === label.name && (e.event === "labeled" || e.event === "unlabeled")
      );

      const sortedEvents = [...labelEvents].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      const lastEvent = sortedEvents[sortedEvents.length - 1];

      if (lastEvent && lastEvent.event === "labeled") {
        if (this.isAllowed(lastEvent.actor?.login)) {
          allowedLabels.add(label.name);
        }
      }
    }

    return {
      ...entity,
      labels: labels.filter((l) => allowedLabels.has(l.name))
    };
  }
}
