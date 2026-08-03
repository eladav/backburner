import type { CommandRunner } from "../utils/command-runner.js";
import { SecurityFilteredGitHubGateway } from "./security.js";
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

export class UnsecuredGhCliGitHubGateway implements GitHubGateway {
  private authenticatedUser?: Promise<string>;

  constructor(private readonly commandRunner: CommandRunner) {}

  async getAuthenticatedUser(): Promise<string> {
    this.authenticatedUser ??= this.runGhJson<{ login?: string }>(["api", "user"])
      .then((user) => {
        const login = user.login?.trim();
        if (!login) throw new Error("gh api user did not return an authenticated login");
        return login;
      });
    return this.authenticatedUser;
  }

  async getRepositoryMetadata(owner: string, name: string): Promise<GitHubRepositoryMetadata> {
    const data = await this.runGhJson<{
      id: string;
      name: string;
      nameWithOwner: string;
      url: string;
      defaultBranchRef?: {
        name?: string;
      } | null;
      owner?: {
        login?: string;
      } | null;
    }>([
      "repo",
      "view",
      `${owner}/${name}`,
      "--json",
      "id,name,nameWithOwner,url,defaultBranchRef,owner"
    ]);

    const defaultBranch = data.defaultBranchRef?.name?.trim();
    if (!defaultBranch) {
      throw new Error(`gh did not return a default branch for ${owner}/${name}`);
    }

    return {
      id: data.id,
      owner: data.owner?.login?.trim() || owner,
      name: data.name,
      nameWithOwner: data.nameWithOwner,
      url: data.url,
      defaultBranch
    };
  }

  async getRepositoryDefaultBranch(owner: string, name: string): Promise<string> {
    const metadata = await this.getRepositoryMetadata(owner, name);
    return metadata.defaultBranch;
  }

  async getIssue(owner: string, name: string, issueNumber: number): Promise<GhIssueSummary> {
    return this.runGhJson<GhIssueSummary>([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      `${owner}/${name}`,
      "--json",
      "id,number,title,body,url,state,createdAt,updatedAt,author,labels"
    ]);
  }

  async getPullRequest(owner: string, name: string, prNumber: number): Promise<GhPullRequestSummary> {
    const data = await this.runGhJson<GhPullRequestSummary & { headRefOid: string }>([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      `${owner}/${name}`,
      "--json",
      "id,number,title,body,url,state,createdAt,updatedAt,author,labels,headRefName,headRefOid,baseRefName,isDraft"
    ]);
    return { ...data, headSha: data.headRefOid || "" };
  }

  async findOpenPullRequestByHeadBranch(
    owner: string,
    name: string,
    headBranch: string
  ): Promise<GhPullRequestSummary | null> {
    const prs = await this.listOpenPullRequests(owner, name);
    return prs.find((pr) => pr.headRefName === headBranch) ?? null;
  }

  async createPullRequest(input: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<GhPullRequestSummary> {
    const result = await this.commandRunner.run("gh", [
      "pr",
      "create",
      "--repo",
      `${input.owner}/${input.name}`,
      "--head",
      input.headBranch,
      "--base",
      input.baseBranch,
      "--title",
      input.title,
      "--body",
      input.body
    ]);

    const created = await this.findOpenPullRequestByHeadBranch(input.owner, input.name, input.headBranch);
    if (created) {
      return created;
    }

    const createdUrl = extractFirstUrl(result.stdout);
    if (createdUrl) {
      return buildFallbackPullRequestSummary(input, createdUrl);
    }

    throw new Error(
      `gh pr create succeeded but the new pull request could not be resolved for branch ${input.headBranch}`
    );
  }

  async listOpenIssues(owner: string, name: string): Promise<GhIssueSummary[]> {
    return this.runGhJson<GhIssueSummary[]>([
      "issue",
      "list",
      "--repo",
      `${owner}/${name}`,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "id,number,title,body,url,state,createdAt,updatedAt,author,labels"
    ]);
  }

  async listOpenPullRequests(owner: string, name: string): Promise<GhPullRequestSummary[]> {
    const data = await this.runGhJson<Array<GhPullRequestSummary & { headRefOid: string }>>([
      "pr",
      "list",
      "--repo",
      `${owner}/${name}`,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "id,number,title,body,url,state,createdAt,updatedAt,author,labels,headRefName,headRefOid,baseRefName,isDraft"
    ]);
    return data.map((pr) => ({ ...pr, headSha: pr.headRefOid || "" }));
  }

  async listIssueComments(owner: string, name: string, issueNumber: number): Promise<GhComment[]> {
    const data = await this.runGhJson<{ comments?: GhComment[] }>([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      `${owner}/${name}`,
      "--json",
      "comments"
    ]);

    return data.comments ?? [];
  }

  async listPullRequestComments(owner: string, name: string, prNumber: number): Promise<GhComment[]> {
    const data = await this.runGhJson<
      Array<{
        id: number;
        html_url: string;
        body: string;
        created_at: string;
        updated_at: string;
        user: { login: string };
      }> | Array<Array<{
        id: number;
        html_url: string;
        body: string;
        created_at: string;
        updated_at: string;
        user: { login: string };
      }>>
    >([
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`
    ]);

    if (!Array.isArray(data)) {
      return [];
    }

    const flat = (Array.isArray(data[0]) ? (data as any[][]).flat() : data) as Array<{
      id: number;
      html_url: string;
      body: string;
      created_at: string;
      updated_at: string;
      user: { login: string };
    }>;

    return flat.map((c) => ({
      id: String(c.id),
      url: c.html_url,
      body: c.body,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      author: { login: c.user.login }
    }));
  }

  async listPullRequestReviews(owner: string, name: string, prNumber: number): Promise<GhPullRequestReview[]> {
    const data = await this.runGhJson<{ reviews?: GhPullRequestReview[] }>([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      `${owner}/${name}`,
      "--json",
      "reviews"
    ]);

    return data.reviews ?? [];
  }

  async listPullRequestReviewComments(
    owner: string,
    name: string,
    prNumber: number
  ): Promise<GhPullRequestReviewComment[]> {
    const data = await this.runGhJson<GhPullRequestReviewComment[] | GhPullRequestReviewComment[][]>([
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${name}/pulls/${prNumber}/comments?per_page=100`
    ]);

    if (!Array.isArray(data)) {
      return [];
    }

    if (data.length === 0) {
      return [];
    }

    if (Array.isArray(data[0])) {
      return (data as GhPullRequestReviewComment[][]).flat();
    }

    return data as GhPullRequestReviewComment[];
  }

  async listPullRequestChangedFiles(
    owner: string,
    name: string,
    prNumber: number
  ): Promise<GhPullRequestChangedFile[]> {
    const data = await this.runGhJson<PullRequestFileApiResponse[] | PullRequestFileApiResponse[][]>([
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${name}/pulls/${prNumber}/files?per_page=100`
    ]);

    if (!Array.isArray(data)) {
      return [];
    }

    const flat = (
      data.length > 0 && Array.isArray(data[0]) ? (data as any[][]).flat() : data
    ) as PullRequestFileApiResponse[];

    return flat.map((file) => {
      const {
        rightChangedLines,
        leftChangedLines,
        rightCommentableLines,
        leftCommentableLines
      } = parsePullRequestFilePatch(file.patch ?? "");
      return {
        path: file.filename ?? "",
        rightChangedLines,
        leftChangedLines,
        rightCommentableLines,
        leftCommentableLines
      };
    });
  }

  async listIssueEvents(
    owner: string,
    name: string,
    issueNumber: number
  ): Promise<GhIssueEvent[]> {
    const data = await this.runGhJson<
      Array<{
        event: string;
        created_at: string;
        actor: { login: string } | null;
        label?: { name: string };
      }> | Array<Array<{
        event: string;
        created_at: string;
        actor: { login: string } | null;
        label?: { name: string };
      }>>
    >([
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${name}/issues/${issueNumber}/events?per_page=100`
    ]);

    if (!Array.isArray(data)) {
      return [];
    }

    const flat = (
      data.length > 0 && Array.isArray(data[0]) ? (data as any[][]).flat() : data
    ) as Array<{
      event: string;
      created_at: string;
      actor: { login: string } | null;
      label?: { name: string };
    }>;

    return flat.map((item) => {
      const eventObj: GhIssueEvent = {
        event: item.event,
        createdAt: item.created_at,
        actor: item.actor ? { login: item.actor.login } : null
      };
      if (item.label) {
        eventObj.label = { name: item.label.name };
      }
      return eventObj;
    });
  }

  async listPullRequestCheckRuns(owner: string, name: string, headSha: string): Promise<GhCheckRun[]> {
    const data = await this.runGhJson<
      Array<{
        total_count?: number;
        check_runs?: Array<{
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
          html_url: string;
          started_at: string | null;
          completed_at: string | null;
        }>;
      }>
    >([
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${name}/commits/${headSha}/check-runs?per_page=100`
    ]);

    if (!Array.isArray(data)) {
      return [];
    }

    const checkRuns = data.flatMap((page) => page.check_runs ?? []);

    return checkRuns.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status as GhCheckRun["status"],
      conclusion: run.conclusion,
      url: run.html_url,
      startedAt: run.started_at,
      completedAt: run.completed_at
    }));
  }

  async searchCode(input: {
    owner: string;
    name: string;
    query: string;
    pathPrefix?: string;
    limit: number;
  }): Promise<GhSearchCodeResult> {
    const searchTerms = [`repo:${input.owner}/${input.name}`, input.query.trim()];
    if (input.pathPrefix) {
      searchTerms.push(`path:${input.pathPrefix}`);
    }

    const search = new URLSearchParams({
      q: searchTerms.join(" "),
      per_page: String(input.limit)
    });

    const data = await this.runGhJson<{
      total_count?: number;
      incomplete_results?: boolean;
      items?: Array<{
        name?: string;
        path?: string;
        sha?: string;
        url?: string;
        git_url?: string;
        html_url?: string;
        repository?: {
          id?: number;
          full_name?: string;
          html_url?: string;
        };
      }>;
    }>(["api", `search/code?${search.toString()}`]);

    return {
      totalCount: data.total_count ?? 0,
      incompleteResults: data.incomplete_results ?? false,
      items: (data.items ?? []).map((item) => ({
        name: item.name ?? "",
        path: item.path ?? "",
        sha: item.sha ?? "",
        url: item.url ?? "",
        gitUrl: item.git_url ?? "",
        htmlUrl: item.html_url ?? "",
        repository: {
          id: item.repository?.id ?? 0,
          fullName: item.repository?.full_name ?? `${input.owner}/${input.name}`,
          htmlUrl: item.repository?.html_url ?? `https://github.com/${input.owner}/${input.name}`
        }
      }))
    };
  }

  async postIssueComment(input: {
    owner: string;
    name: string;
    issueNumber: number;
    body: string;
  }): Promise<GhIssueCommentMutationResult> {
    const data = await this.runGhJson<{
      id?: number;
      html_url?: string;
      body?: string;
      created_at?: string;
      updated_at?: string;
      user?: {
        login?: string;
      };
    }>([
      "api",
      `repos/${input.owner}/${input.name}/issues/${input.issueNumber}/comments`,
      "--method",
      "POST",
      "--field",
      `body=${input.body}`
    ]);

    return {
      id: data.id ?? 0,
      url: data.html_url ?? "",
      body: data.body ?? input.body,
      createdAt: data.created_at ?? "",
      updatedAt: data.updated_at ?? "",
      author: data.user?.login ? { login: data.user.login } : null
    };
  }

  async updateIssueComment(input: {
    owner: string;
    name: string;
    commentId: string | number;
    body: string;
  }): Promise<GhIssueCommentMutationResult> {
    const data = await this.runGhJson<{
      id?: number;
      html_url?: string;
      body?: string;
      created_at?: string;
      updated_at?: string;
      user?: {
        login?: string;
      };
    }>([
      "api",
      `repos/${input.owner}/${input.name}/issues/comments/${input.commentId}`,
      "--method",
      "PATCH",
      "--field",
      `body=${input.body}`
    ]);

    return {
      id: data.id ?? 0,
      url: data.html_url ?? "",
      body: data.body ?? input.body,
      createdAt: data.created_at ?? "",
      updatedAt: data.updated_at ?? "",
      author: data.user?.login ? { login: data.user.login } : null
    };
  }

  async addReaction(input: {
    owner: string;
    name: string;
    issueNumber?: number;
    commentId?: string;
    commentKind?: "issue_comment" | "pull_request_comment" | "pull_request_review" | "pull_request_review_comment";
    content: string;
  }): Promise<void> {
    const slug = `${input.owner}/${input.name}`;
    if (input.commentId !== undefined) {
      const commentPath =
        input.commentKind === "pull_request_review_comment"
          ? `/repos/${slug}/pulls/comments/${input.commentId}/reactions`
          : `/repos/${slug}/issues/comments/${input.commentId}/reactions`;
      await this.commandRunner.run("gh", [
        "api",
        "-X", "POST",
        commentPath,
        "-f", `content=${input.content}`
      ]);
    } else if (input.issueNumber !== undefined) {
      await this.commandRunner.run("gh", [
        "api",
        "-X", "POST",
        `/repos/${slug}/issues/${input.issueNumber}/reactions`,
        "-f", `content=${input.content}`
      ]);
    } else {
      throw new Error(`addReaction requires either issueNumber or commentId`);
    }
  }

  async postPullRequestReviewCommentReply(input: {
    owner: string;
    name: string;
    pullRequestNumber: number;
    commentId: number;
    body: string;
  }): Promise<GhPullRequestReviewCommentReplyResult> {
    const data = await this.runGhJson<{
      id?: number;
      html_url?: string;
      body?: string;
      created_at?: string;
      updated_at?: string;
      user?: {
        login?: string;
      };
    }>([
      "api",
      `repos/${input.owner}/${input.name}/pulls/${input.pullRequestNumber}/comments/${input.commentId}/replies`,
      "--method",
      "POST",
      "--field",
      `body=${input.body}`
    ]);

    return {
      id: data.id ?? 0,
      url: data.html_url ?? "",
      body: data.body ?? input.body,
      createdAt: data.created_at ?? "",
      updatedAt: data.updated_at ?? "",
      author: data.user?.login ? { login: data.user.login } : null
    };
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
    const payload = {
      event: input.event,
      ...(input.body ? { body: input.body } : {}),
      ...(input.commitId ? { commit_id: input.commitId } : {}),
      ...(input.comments?.length
        ? {
            comments: input.comments.map((comment) => ({
              path: comment.path,
              line: comment.line,
              side: comment.side ?? "RIGHT",
              ...(comment.startLine ? { start_line: comment.startLine } : {}),
              ...(comment.startSide ? { start_side: comment.startSide } : {}),
              body: comment.body
            }))
          }
        : {})
    };

    const data = await this.runGhJson<{
      id?: number;
      html_url?: string;
      body?: string;
      state?: string;
      submitted_at?: string;
      user?: {
        login?: string;
      };
    }>(
      [
        "api",
        `repos/${input.owner}/${input.name}/pulls/${input.pullRequestNumber}/reviews`,
        "--method",
        "POST",
        "--input",
        "-"
      ],
      JSON.stringify(payload)
    );

    return {
      id: data.id ?? 0,
      url: data.html_url ?? "",
      body: data.body ?? input.body ?? "",
      state: data.state ?? input.event,
      submittedAt: data.submitted_at ?? "",
      author: data.user?.login ? { login: data.user.login } : null
    };
  }

  private async runGhJson<T>(args: string[], input?: string): Promise<T> {
    const result = await this.commandRunner.run("gh", args, input === undefined ? undefined : { input });
    try {
      return JSON.parse(result.stdout) as T;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`gh ${args.join(" ")}: invalid JSON (${message})`);
    }
  }
}

interface PullRequestFileApiResponse {
  filename?: string;
  patch?: string;
}

function parsePullRequestFilePatch(patch: string): {
  rightChangedLines: number[];
  leftChangedLines: number[];
  rightCommentableLines: number[];
  leftCommentableLines: number[];
} {
  const rightChangedLines: number[] = [];
  const leftChangedLines: number[] = [];
  const rightCommentableLines: number[] = [];
  const leftCommentableLines: number[] = [];

  if (!patch) {
    return {
      rightChangedLines,
      leftChangedLines,
      rightCommentableLines,
      leftCommentableLines
    };
  }

  const lines = patch.split(/\r?\n/);
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      const headerMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (headerMatch && headerMatch[1] && headerMatch[2]) {
        currentOldLine = parseInt(headerMatch[1], 10);
        currentNewLine = parseInt(headerMatch[2], 10);
        inHunk = true;
      }
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith("+")) {
      rightChangedLines.push(currentNewLine);
      rightCommentableLines.push(currentNewLine);
      currentNewLine++;
    } else if (line.startsWith("-")) {
      leftChangedLines.push(currentOldLine);
      leftCommentableLines.push(currentOldLine);
      currentOldLine++;
    } else if (line.startsWith(" ")) {
      leftCommentableLines.push(currentOldLine);
      rightCommentableLines.push(currentNewLine);
      currentOldLine++;
      currentNewLine++;
    } else if (line.startsWith("\\")) {
      // No newline at end of file, ignore
    }
  }

  return {
    rightChangedLines,
    leftChangedLines,
    rightCommentableLines,
    leftCommentableLines
  };
}

function extractFirstUrl(value: string): string | undefined {
  const match = value.match(/https:\/\/github\.com\/[^\s]+/);
  return match?.[0];
}

function buildFallbackPullRequestSummary(
  input: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  },
  url: string
): GhPullRequestSummary {
  const numberMatch = url.match(/\/pull\/(\d+)(?:\/?|$)/);
  return {
    id: `pull_request:${input.owner}/${input.name}:${numberMatch?.[1] ?? "unknown"}`,
    number: numberMatch?.[1] ? Number(numberMatch[1]) : 0,
    title: input.title,
    body: input.body,
    url,
    state: "OPEN",
    createdAt: "",
    updatedAt: "",
    author: null,
    labels: [],
    headRefName: input.headBranch,
    headSha: "",
    baseRefName: input.baseBranch,
    isDraft: false
  };
}

export class GhCliGitHubGateway extends SecurityFilteredGitHubGateway {
  constructor(commandRunner: CommandRunner, allowedUsers: string[]) {
    super(new UnsecuredGhCliGitHubGateway(commandRunner), allowedUsers);
  }
}
