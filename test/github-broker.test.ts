import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { RepoConfig } from "../src/config/types.js";
import { GitHubBrokerService } from "../src/github/broker.js";
import { handleBrokerHttpRequest } from "../src/github/broker-server.js";
import { createTeeFileLogger } from "../src/utils/logger.js";
import type {
  GhComment,
  GhIssueCommentMutationResult,
  GhIssueSummary,
  GhPullRequestReview,
  GhPullRequestReviewCommentReplyResult,
  GhPullRequestReviewSubmissionResult,
  GhPullRequestReviewComment,
  GhPullRequestChangedFile,
  GhPullRequestSummary,
  GhSearchCodeResult,
  GitHubGateway,
  GitHubRepositoryMetadata,
  GhIssueEvent,
  GhCheckRun
} from "../src/github/types.js";

test("GitHub broker MCP lists tools and returns structured get_issue results", async () => {
  const loggerMessages: string[] = [];
  const broker = new GitHubBrokerService(
    new StubGitHubGateway(),
    [baseRepoConfig()],
    {
      info: (message) => loggerMessages.push(message),
      warn: (message) => loggerMessages.push(`warn:${message}`)
    }
  );
  const initializeResponse = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {}
  });
  const toolsResponse = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  const issueResponse = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "get_issue",
      arguments: {
        repo: "eladaviv/repo-one",
        issueNumber: 17
      }
    }
  });

  assert.equal(initializeResponse.result?.protocolVersion, "2024-11-05");
  assert.deepEqual(
    (toolsResponse.result?.tools as Array<{ name: string }>).map((tool) => tool.name),
    [
      "get_issue",
      "get_issue_comments",
      "get_pr",
      "get_pr_comments",
      "get_pr_checks",
      "search_code",
      "post_issue_comment",
      "post_pr_review_comment_reply",
      "create_pr"
    ]
  );
  assert.equal(issueResponse.result?.isError, false);
  assert.match(issueResponse.result?.content[0].text, /"title": "Issue title"/);
  assert.match(issueResponse.result?.content[0].text, /"body": "Issue body"/);
  assert.equal(issueResponse.result?.structuredContent?.repo, "eladaviv/repo-one");
  assert.equal(issueResponse.result?.structuredContent?.issue?.number, 17);
  assert.equal(
    loggerMessages.some((message) => message.includes('"toolName":"get_issue"')),
    true
  );
});

test("GitHub broker MCP exposes PR details in model-visible text while retaining structured data", async () => {
  const broker = new GitHubBrokerService(
    new StubGitHubGateway(),
    [baseRepoConfig()],
    {
      info: () => undefined,
      warn: () => undefined
    }
  );
  const response = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "get_pr",
      arguments: {
        repo: "eladaviv/repo-one",
        pullRequestNumber: 23
      }
    }
  });

  const text = response.result?.content[0].text as string;
  assert.match(text, /"pullRequestNumber": 23/);
  assert.match(text, /"title": "PR title"/);
  assert.match(text, /"body": "PR body"/);
  assert.match(text, /"headRefName": "feature\/broker"/);
  assert.equal(response.result?.structuredContent?.pullRequest?.body, "PR body");
});

test("GitHub broker MCP exposes PR comment bodies in model-visible text and retains full structured threads", async () => {
  const sentinel = "SENTINEL: please preserve this exact review feedback";
  const broker = new GitHubBrokerService(
    new StubGitHubGateway({ pullRequestCommentBody: sentinel }),
    [baseRepoConfig()],
    {
      info: () => undefined,
      warn: () => undefined
    }
  );
  const response = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "get_pr_comments",
      arguments: {
        repo: "eladaviv/repo-one",
        pullRequestNumber: 23
      }
    }
  });

  const text = response.result?.content[0].text as string;
  assert.match(text, new RegExp(sentinel));
  assert.match(text, /"totalCount": 1/);
  assert.notEqual(text, "get_pr_comments succeeded for eladaviv/repo-one");
  assert.equal(response.result?.structuredContent?.comments[0].body, sentinel);
  assert.equal(response.result?.structuredContent?.reviews[0].body, "Structured review body");
  assert.equal(response.result?.structuredContent?.reviewComments[0].body, "Inline review body");
});

test("GitHub broker MCP marks truncated model-visible PR comment bodies without truncating structured data", async () => {
  const longBody = `start-${"x".repeat(5_000)}-end`;
  const broker = new GitHubBrokerService(
    new StubGitHubGateway({ pullRequestCommentBody: longBody }),
    [baseRepoConfig()],
    {
      info: () => undefined,
      warn: () => undefined
    }
  );
  const response = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "get_pr_comments",
      arguments: {
        repo: "eladaviv/repo-one",
        pullRequestNumber: 23
      }
    }
  });

  const text = response.result?.content[0].text as string;
  assert.match(text, /"bodyTruncated": true/);
  assert.match(text, /"bodyOriginalLength": 5010/);
  assert.match(text, /\.\.\.\[truncated\]/);
  assert.equal(response.result?.structuredContent?.comments[0].body, longBody);
});

test("GitHub broker MCP returns CI check runs for a pull request", async () => {
  const broker = new GitHubBrokerService(
    new StubGitHubGateway(),
    [baseRepoConfig()],
    {
      info: () => undefined,
      warn: () => undefined
    }
  );
  const response = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "get_pr_checks",
      arguments: {
        repo: "eladaviv/repo-one",
        pullRequestNumber: 23
      }
    }
  });

  assert.equal(response.result?.isError, false);
  const text = response.result?.content[0].text as string;
  assert.match(text, /"name": "CI \/ build"/);
  assert.match(text, /"conclusion": "success"/);
  assert.match(text, /"conclusion": "failure"/);
  assert.match(text, /"totalCount": 2/);
  assert.equal(response.result?.structuredContent?.headSha, "abc123");
  assert.equal(response.result?.structuredContent?.checkRuns[0].name, "CI / build");
  assert.equal(response.result?.structuredContent?.checkRuns[1].conclusion, "failure");
});

test("GitHub broker lists get_pr_checks when it is in the explicit allow-list", async () => {
  const broker = new GitHubBrokerService(
    new StubGitHubGateway(),
    [baseRepoConfig()],
    { info: () => undefined, warn: () => undefined },
    ["get_pr", "get_pr_checks"]
  );
  const toolsResponse = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 20,
    method: "tools/list",
    params: {}
  });

  const names = (toolsResponse.result?.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(names.includes("get_pr_checks"), "get_pr_checks should be listed when allowed");
  assert.ok(names.includes("get_pr"), "get_pr should also be listed");
  assert.ok(!names.includes("get_issue"), "get_issue should not appear when not in allow-list");
});

test("GitHub broker hides get_pr_checks when it is excluded from the allow-list", async () => {
  const broker = new GitHubBrokerService(
    new StubGitHubGateway(),
    [baseRepoConfig()],
    { info: () => undefined, warn: () => undefined },
    ["get_issue", "get_pr", "search_code"]
  );
  const toolsResponse = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 21,
    method: "tools/list",
    params: {}
  });
  const callResponse = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 22,
    method: "tools/call",
    params: {
      name: "get_pr_checks",
      arguments: { repo: "eladaviv/repo-one", pullRequestNumber: 23 }
    }
  });

  const names = (toolsResponse.result?.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(!names.includes("get_pr_checks"), "get_pr_checks must not be listed when excluded");
  assert.equal(callResponse.result?.isError, true, "calling excluded tool must return an error");
  assert.equal(callResponse.result?.structuredContent?.error?.code, "tool_not_found");
});

test("GitHub broker get_pr_checks works without capabilities.json (no capability declaration needed)", async () => {
  const broker = new GitHubBrokerService(
    new StubGitHubGateway(),
    [baseRepoConfig()],
    { info: () => undefined, warn: () => undefined }
  );
  const response = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 23,
    method: "tools/call",
    params: {
      name: "get_pr_checks",
      arguments: { repo: "eladaviv/repo-one", pullRequestNumber: 23 }
    }
  });

  assert.equal(response.result?.isError, false);
  assert.equal(response.result?.structuredContent?.pullRequestNumber, 23);
  assert.equal(response.result?.structuredContent?.headSha, "abc123");
  assert.ok(Array.isArray(response.result?.structuredContent?.checkRuns));
});

test("GitHub broker returns empty check runs and no error when PR has no head SHA", async () => {
  const broker = new GitHubBrokerService(
    new StubGitHubGateway({ noHeadSha: true }),
    [baseRepoConfig()],
    { info: () => undefined, warn: () => undefined }
  );
  const response = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 24,
    method: "tools/call",
    params: {
      name: "get_pr_checks",
      arguments: { repo: "eladaviv/repo-one", pullRequestNumber: 23 }
    }
  });

  assert.equal(response.result?.isError, false);
  assert.equal(response.result?.structuredContent?.headSha, "");
  assert.deepEqual(response.result?.structuredContent?.checkRuns, []);
});

test("GitHub broker MCP returns structured validation failures for unmanaged repos", async () => {
  const broker = new GitHubBrokerService(
    new StubGitHubGateway(),
    [baseRepoConfig()],
    {
      info: () => undefined,
      warn: () => undefined
    }
  );
  const response = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "post_issue_comment",
      arguments: {
        repo: "other/repo",
        issueNumber: 2,
        body: "hello"
      }
    }
  });

  assert.equal(response.result?.isError, true);
  assert.equal(response.result?.structuredContent?.error?.code, "repo_not_managed");
});

test("GitHub broker MCP persists structured tool failures to the broker log", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-broker-log-"));
  const logPath = path.join(tempDir, "github-broker.log");
  const logger = createTeeFileLogger(
    {
      info: () => undefined,
      warn: () => undefined
    },
    logPath
  );

  try {
    const broker = new GitHubBrokerService(
      new StubGitHubGateway({
        getIssueError: new Error("gh issue view failed")
      }),
      [baseRepoConfig()],
      logger
    );

    const response = await postJsonRpc(broker, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "get_issue",
        arguments: {
          repo: "eladaviv/repo-one",
          issueNumber: 17
        }
      }
    });

    await logger.close();

    assert.equal(response.result?.isError, true);
    assert.equal(response.result?.structuredContent?.error?.code, "github_error");

    const persistedLog = await readFile(logPath, "utf8");
    assert.match(persistedLog, /"component":"github-broker-mcp"/);
    assert.match(persistedLog, /"toolName":"get_issue"/);
    assert.match(persistedLog, /"resultStatus":"error"/);
    assert.match(persistedLog, /gh issue view failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitHub broker MCP replies to inline PR review comments with structured results", async () => {
  const broker = new GitHubBrokerService(
    new StubGitHubGateway(),
    [baseRepoConfig()],
    {
      info: () => undefined,
      warn: () => undefined
    }
  );
  const response = await postJsonRpc(broker, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "post_pr_review_comment_reply",
      arguments: {
        repo: "eladaviv/repo-one",
        pullRequestNumber: 23,
        commentId: 3116275997,
        body: "🤖 Addressed inline review feedback."
      }
    }
  });

  assert.equal(response.result?.isError, false);
  assert.equal(response.result?.content[0].text, "post_pr_review_comment_reply succeeded for eladaviv/repo-one");
  assert.equal(response.result?.structuredContent?.repo, "eladaviv/repo-one");
  assert.equal(response.result?.structuredContent?.pullRequestNumber, 23);
  assert.equal(response.result?.structuredContent?.commentId, 3116275997);
  assert.equal(response.result?.structuredContent?.reply?.body, "🤖 Addressed inline review feedback.");
});

function baseRepoConfig(): RepoConfig {
  return {
    id: "repo-1",
    owner: "eladaviv",
    name: "repo-one",
    defaultBranch: "main",
    localPath: "repo-one",
    enabled: true,
    labels: {
      agentInProgress: "agent-in-progress",
      agentPlanApproved: "agent-plan-approved",
      agentProductApproved: "agent-product-approved",
      agentReview: "agent-review",
      planBreakdownNeeded: "plan-breakdown-needed",
      agentSyncParentBranch: "agent-sync-parent-branch",
      prepareForMerge: "prepare-for-merge"
    }
  };
}

async function postJsonRpc(
  broker: GitHubBrokerService,
  payload: Record<string, unknown>
): Promise<Record<string, any>> {
  const response = await handleBrokerHttpRequest(
    {
      method: "POST",
      path: "/mcp",
      body: JSON.stringify(payload)
    },
    broker
  );

  assert.equal(response.statusCode, 200);
  return JSON.parse(response.body ?? "{}") as Record<string, any>;
}

test("GitHub broker health endpoint responds without JSON-RPC", async () => {
  const broker = new GitHubBrokerService(new StubGitHubGateway(), [baseRepoConfig()], {
    info: () => undefined,
    warn: () => undefined
  });
  const response = await handleBrokerHttpRequest(
    {
      method: "GET",
      path: "/health"
    },
    broker
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body ?? "{}"), { ok: true });
});

test("GitHub broker compatibility GET endpoints return 200 with guidance", async () => {
  const broker = new GitHubBrokerService(new StubGitHubGateway(), [baseRepoConfig()], {
    info: () => undefined,
    warn: () => undefined
  });

  const rootResponse = await handleBrokerHttpRequest(
    {
      method: "GET",
      path: "/"
    },
    broker
  );
  const mcpResponse = await handleBrokerHttpRequest(
    {
      method: "GET",
      path: "/mcp"
    },
    broker
  );

  assert.equal(rootResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(rootResponse.body ?? "{}"), {
    ok: true,
    service: "backburner-github-broker",
    mcpPath: "/mcp"
  });

  assert.equal(mcpResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(mcpResponse.body ?? "{}"), {
    ok: true,
    transport: "json-rpc",
    method: "POST",
    path: "/mcp"
  });
});

class StubGitHubGateway implements GitHubGateway {
  constructor(
    private readonly options: {
      getIssueError?: Error;
      pullRequestCommentBody?: string;
      noHeadSha?: boolean;
    } = {}
  ) {}

  async getRepositoryMetadata(): Promise<GitHubRepositoryMetadata> {
    return {
      id: "repo-1",
      owner: "eladaviv",
      name: "repo-one",
      nameWithOwner: "eladaviv/repo-one",
      url: "https://github.com/eladaviv/repo-one",
      defaultBranch: "main"
    };
  }

  async getRepositoryDefaultBranch(): Promise<string> {
    return "main";
  }

  async getIssue(_: string, __: string, issueNumber: number): Promise<GhIssueSummary> {
    if (this.options.getIssueError) {
      throw this.options.getIssueError;
    }

    return {
      id: "ISSUE_17",
      number: issueNumber,
      title: "Issue title",
      body: "Issue body",
      url: "https://github.com/eladaviv/repo-one/issues/17",
      state: "OPEN",
      createdAt: "2026-04-19T10:00:00.000Z",
      updatedAt: "2026-04-19T10:05:00.000Z",
      author: { login: "octocat" },
      labels: [{ name: "bug" }]
    };
  }

  async getPullRequest(_: string, __: string, prNumber: number): Promise<GhPullRequestSummary> {
    return {
      id: "PR_23",
      number: prNumber,
      title: "PR title",
      body: "PR body",
      url: "https://github.com/eladaviv/repo-one/pull/23",
      state: "OPEN",
      createdAt: "2026-04-19T10:00:00.000Z",
      updatedAt: "2026-04-19T10:05:00.000Z",
      author: { login: "octocat" },
      labels: [],
      headRefName: "feature/broker",
      headSha: this.options.noHeadSha ? undefined : "abc123",
      baseRefName: "main",
      isDraft: false
    };
  }

  async findOpenPullRequestByHeadBranch(): Promise<GhPullRequestSummary | null> {
    return null;
  }

  async createPullRequest(): Promise<GhPullRequestSummary> {
    return await this.getPullRequest("", "", 23);
  }

  async searchCode(): Promise<GhSearchCodeResult> {
    return {
      totalCount: 1,
      incompleteResults: false,
      items: [
        {
          name: "broker.ts",
          path: "src/github/broker.ts",
          sha: "abc123",
          url: "https://api.github.com/repos/eladaviv/repo-one/contents/src/github/broker.ts",
          gitUrl: "https://api.github.com/repos/eladaviv/repo-one/git/blobs/abc123",
          htmlUrl: "https://github.com/eladaviv/repo-one/blob/main/src/github/broker.ts",
          repository: {
            id: 1,
            fullName: "eladaviv/repo-one",
            htmlUrl: "https://github.com/eladaviv/repo-one"
          }
        }
      ]
    };
  }

  async postIssueComment(): Promise<GhIssueCommentMutationResult> {
    return {
      id: 9001,
      url: "https://github.com/eladaviv/repo-one/issues/17#issuecomment-9001",
      body: "hello",
      createdAt: "2026-04-19T10:06:00.000Z",
      updatedAt: "2026-04-19T10:06:00.000Z",
      author: { login: "octocat" }
    };
  }

  async updateIssueComment(input: { body: string }): Promise<GhIssueCommentMutationResult> {
    return {
      id: 9001,
      url: "https://github.com/eladaviv/repo-one/issues/17#issuecomment-9001",
      body: input.body,
      createdAt: "2026-04-19T10:06:00.000Z",
      updatedAt: "2026-04-19T10:06:00.000Z",
      author: { login: "octocat" }
    };
  }

  async postPullRequestReviewCommentReply(): Promise<GhPullRequestReviewCommentReplyResult> {
    return {
      id: 9002,
      url: "https://github.com/eladaviv/repo-one/pull/23#discussion_r9002",
      body: "🤖 Addressed inline review feedback.",
      createdAt: "2026-04-19T10:07:00.000Z",
      updatedAt: "2026-04-19T10:07:00.000Z",
      author: { login: "octocat" }
    };
  }

  async submitPullRequestReview(): Promise<GhPullRequestReviewSubmissionResult> {
    return {
      id: 9003,
      url: "https://github.com/eladaviv/repo-one/pull/23#pullrequestreview-9003",
      body: "🤖 Review submitted.",
      state: "COMMENTED",
      submittedAt: "2026-04-19T10:08:00.000Z",
      author: { login: "octocat" }
    };
  }

  async listOpenIssues(): Promise<GhIssueSummary[]> {
    return [];
  }

  async listOpenPullRequests(): Promise<GhPullRequestSummary[]> {
    return [];
  }

  async listIssueComments(): Promise<GhComment[]> {
    return [];
  }

  async listPullRequestComments(): Promise<GhComment[]> {
    return [
      {
        id: "PR_COMMENT_1",
        url: "https://github.com/eladaviv/repo-one/pull/23#issuecomment-1",
        body: this.options.pullRequestCommentBody ?? "Default PR comment body",
        createdAt: "2026-04-19T10:10:00.000Z",
        updatedAt: "2026-04-19T10:11:00.000Z",
        author: { login: "reviewer" }
      }
    ];
  }

  async listPullRequestReviews(): Promise<GhPullRequestReview[]> {
    return [
      {
        id: "REVIEW_1",
        url: "https://github.com/eladaviv/repo-one/pull/23#pullrequestreview-1",
        body: "Structured review body",
        submittedAt: "2026-04-19T10:12:00.000Z",
        state: "COMMENTED",
        author: { login: "reviewer" }
      }
    ];
  }

  async listPullRequestReviewComments(): Promise<GhPullRequestReviewComment[]> {
    return [
      {
        id: 1001,
        html_url: "https://github.com/eladaviv/repo-one/pull/23#discussion_r1001",
        body: "Inline review body",
        created_at: "2026-04-19T10:13:00.000Z",
        updated_at: "2026-04-19T10:14:00.000Z",
        user: { login: "reviewer" },
        path: "src/github/broker.ts",
        line: 147,
        original_line: 145,
        side: "RIGHT"
      }
    ];
  }

  async listPullRequestChangedFiles(): Promise<GhPullRequestChangedFile[]> {
    return [];
  }

  async listIssueEvents(): Promise<GhIssueEvent[]> {
    return [];
  }

  async listPullRequestCheckRuns(): Promise<GhCheckRun[]> {
    return [
      {
        id: 1001,
        name: "CI / build",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/eladaviv/repo-one/actions/runs/1001",
        startedAt: "2026-04-19T10:00:00.000Z",
        completedAt: "2026-04-19T10:05:00.000Z"
      },
      {
        id: 1002,
        name: "CI / test",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/eladaviv/repo-one/actions/runs/1002",
        startedAt: "2026-04-19T10:00:00.000Z",
        completedAt: "2026-04-19T10:07:00.000Z"
      }
    ];
  }

  async addReaction(): Promise<void> {}
}
