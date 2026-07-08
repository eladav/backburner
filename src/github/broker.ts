import type { RepoConfig } from "../config/types.js";
import type { GitHubGateway, BrokerTool, BrokerToolService, BrokerToolCallResult, BrokerToolCallSuccess, BrokerToolCallFailure } from "./types.js";
import type { Logger } from "../utils/logger.js";

const MAX_COMMENT_BODY_LENGTH = 65_536;
const MAX_PR_BODY_LENGTH = 65_536;
const MAX_SEARCH_LIMIT = 25;

export type GitHubBrokerToolName =
  | "get_issue"
  | "get_issue_comments"
  | "get_pr"
  | "get_pr_comments"
  | "get_pr_checks"
  | "search_code"
  | "post_issue_comment"
  | "post_pr_review_comment_reply"
  | "create_pr";

interface ManagedRepo {
  id: string;
  owner: string;
  name: string;
  slug: string;
}

export class GitHubBrokerService implements BrokerToolService {
  private readonly managedRepos: Map<string, ManagedRepo>;
  private readonly allowedToolNames: ReadonlySet<string>;

  constructor(
    private readonly gitHubGateway: GitHubGateway,
    repos: RepoConfig[],
    private readonly logger: Logger,
    allowedToolNames: readonly string[] = TOOL_DEFINITIONS.map((tool) => tool.name)
  ) {
    this.allowedToolNames = new Set(allowedToolNames);
    this.managedRepos = new Map(
      repos
        .filter((repo) => repo.enabled)
        .map((repo) => {
          const slug = `${repo.owner}/${repo.name}`;
          return [
            slug,
            {
              id: repo.id,
              owner: repo.owner,
              name: repo.name,
              slug
            } satisfies ManagedRepo
          ] as const;
        })
    );
  }

  listTools(): BrokerTool[] {
    return TOOL_DEFINITIONS.filter((tool) => this.allowedToolNames.has(tool.name));
  }

  async callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    const startedAt = new Date().toISOString();
    const sanitizedArguments = sanitizeArguments(name, rawArguments);

    if (!this.allowedToolNames.has(name)) {
      const repo = extractRepoSlug(rawArguments);
      return {
        ok: false,
        tool: name,
        error: {
          code: "tool_not_found",
          message: `GitHub broker tool "${name}" is not enabled for this run`
        }
      };
    }

    try {
      switch (name) {
        case "get_issue":
          return await this.runReadTool(startedAt, name as GitHubBrokerToolName, rawArguments, sanitizedArguments, async () => {
            const input = validateIssueLookup(rawArguments);
            const repo = this.requireManagedRepo(input.repo);
            const issue = await this.gitHubGateway.getIssue(repo.owner, repo.name, input.issueNumber);

            return {
              ok: true,
              tool: name,
              repo: repo.slug,
              summary: `get_issue succeeded for ${repo.slug}`,
              result: {
                repo: repo.slug,
                issue
              }
            };
          });
        case "get_issue_comments":
          return await this.runReadTool(startedAt, name as GitHubBrokerToolName, rawArguments, sanitizedArguments, async () => {
            const input = validateIssueLookup(rawArguments);
            const repo = this.requireManagedRepo(input.repo);
            const comments = await this.gitHubGateway.listIssueComments(repo.owner, repo.name, input.issueNumber);

            return {
              ok: true,
              tool: name,
              repo: repo.slug,
              summary: `get_issue_comments succeeded for ${repo.slug}`,
              result: {
                repo: repo.slug,
                issueNumber: input.issueNumber,
                comments
              }
            };
          });
        case "get_pr":
          return await this.runReadTool(startedAt, name as GitHubBrokerToolName, rawArguments, sanitizedArguments, async () => {
            const input = validatePullRequestLookup(rawArguments);
            const repo = this.requireManagedRepo(input.repo);
            const pullRequest = await this.gitHubGateway.getPullRequest(
              repo.owner,
              repo.name,
              input.pullRequestNumber
            );

            return {
              ok: true,
              tool: name,
              repo: repo.slug,
              summary: `get_pr succeeded for ${repo.slug}`,
              result: {
                repo: repo.slug,
                pullRequest
              }
            };
          });
        case "get_pr_comments":
          return await this.runReadTool(startedAt, name as GitHubBrokerToolName, rawArguments, sanitizedArguments, async () => {
            const input = validatePullRequestLookup(rawArguments);
            const repo = this.requireManagedRepo(input.repo);
            const [comments, reviews, reviewComments] = await Promise.all([
              this.gitHubGateway.listPullRequestComments(repo.owner, repo.name, input.pullRequestNumber),
              this.gitHubGateway.listPullRequestReviews(repo.owner, repo.name, input.pullRequestNumber),
              this.gitHubGateway.listPullRequestReviewComments(repo.owner, repo.name, input.pullRequestNumber)
            ]);

            return {
              ok: true,
              tool: name,
              repo: repo.slug,
              summary: `get_pr_comments succeeded for ${repo.slug}`,
              result: {
                repo: repo.slug,
                pullRequestNumber: input.pullRequestNumber,
                comments,
                reviews,
                reviewComments
              }
            };
          });
        case "get_pr_checks":
          return await this.runReadTool(startedAt, name as GitHubBrokerToolName, rawArguments, sanitizedArguments, async () => {
            const input = validatePullRequestLookup(rawArguments);
            const repo = this.requireManagedRepo(input.repo);
            const pullRequest = await this.gitHubGateway.getPullRequest(repo.owner, repo.name, input.pullRequestNumber);

            if (!pullRequest.headSha) {
              return {
                ok: true,
                tool: name,
                repo: repo.slug,
                summary: `get_pr_checks: head SHA unavailable for PR #${input.pullRequestNumber}`,
                result: {
                  repo: repo.slug,
                  pullRequestNumber: input.pullRequestNumber,
                  headSha: "",
                  checkRuns: []
                }
              };
            }

            const checkRuns = await this.gitHubGateway.listPullRequestCheckRuns(repo.owner, repo.name, pullRequest.headSha);

            return {
              ok: true,
              tool: name,
              repo: repo.slug,
              summary: `get_pr_checks succeeded for ${repo.slug}`,
              result: {
                repo: repo.slug,
                pullRequestNumber: input.pullRequestNumber,
                headSha: pullRequest.headSha,
                checkRuns
              }
            };
          });
        case "search_code":
          return await this.runReadTool(startedAt, name as GitHubBrokerToolName, rawArguments, sanitizedArguments, async () => {
            const input = validateCodeSearch(rawArguments);
            const repo = this.requireManagedRepo(input.repo);
            const result = await this.gitHubGateway.searchCode(
              input.pathPrefix === undefined
                ? {
                    owner: repo.owner,
                    name: repo.name,
                    query: input.query,
                    limit: input.limit
                  }
                : {
                    owner: repo.owner,
                    name: repo.name,
                    query: input.query,
                    pathPrefix: input.pathPrefix,
                    limit: input.limit
                  }
            );

            return {
              ok: true,
              tool: name,
              repo: repo.slug,
              summary: `search_code succeeded for ${repo.slug}`,
              result: {
                repo: repo.slug,
                query: input.query,
                pathPrefix: input.pathPrefix ?? null,
                totalCount: result.totalCount,
                incompleteResults: result.incompleteResults,
                items: result.items
              }
            };
          });
        case "post_issue_comment":
          return await this.runReadTool(startedAt, name as GitHubBrokerToolName, rawArguments, sanitizedArguments, async () => {
            const input = validatePostIssueComment(rawArguments);
            const repo = this.requireManagedRepo(input.repo);
            const comment = await this.gitHubGateway.postIssueComment({
              owner: repo.owner,
              name: repo.name,
              issueNumber: input.issueNumber,
              body: input.body
            });

            return {
              ok: true,
              tool: name,
              repo: repo.slug,
              summary: `post_issue_comment succeeded for ${repo.slug}`,
              result: {
                repo: repo.slug,
                issueNumber: input.issueNumber,
                comment
              }
            };
          });
        case "post_pr_review_comment_reply":
          return await this.runReadTool(startedAt, name as GitHubBrokerToolName, rawArguments, sanitizedArguments, async () => {
            const input = validatePostPullRequestReviewCommentReply(rawArguments);
            const repo = this.requireManagedRepo(input.repo);
            const comment = await this.gitHubGateway.postPullRequestReviewCommentReply({
              owner: repo.owner,
              name: repo.name,
              pullRequestNumber: input.pullRequestNumber,
              commentId: input.commentId,
              body: input.body
            });

            return {
              ok: true,
              tool: name,
              repo: repo.slug,
              summary: `post_pr_review_comment_reply succeeded for ${repo.slug}`,
              result: {
                repo: repo.slug,
                pullRequestNumber: input.pullRequestNumber,
                commentId: input.commentId,
                reply: comment
              }
            };
          });
        case "create_pr":
          return await this.runReadTool(startedAt, name as GitHubBrokerToolName, rawArguments, sanitizedArguments, async () => {
            const input = validateCreatePullRequest(rawArguments);
            const repo = this.requireManagedRepo(input.repo);
            const baseBranch =
              input.baseBranch ?? (await this.gitHubGateway.getRepositoryDefaultBranch(repo.owner, repo.name));
            const pullRequest = await this.gitHubGateway.createPullRequest({
              owner: repo.owner,
              name: repo.name,
              headBranch: input.headBranch,
              baseBranch,
              title: input.title,
              body: input.body
            });

            return {
              ok: true,
              tool: name,
              repo: repo.slug,
              summary: `create_pr succeeded for ${repo.slug}`,
              result: {
                repo: repo.slug,
                pullRequest
              }
            };
          });
        default:
          return {
            ok: false,
            tool: name,
            error: {
              code: "tool_not_found",
              message: `Unknown GitHub broker tool "${name}"`
            }
          };
      }
    } catch (error: unknown) {
      const failure = toFailure(name, rawArguments, error);
      const repo = extractRepoSlug(rawArguments);
      this.logInvocation({
        timestamp: startedAt,
        toolName: name,
        status: "error",
        arguments: sanitizedArguments,
        ...(repo ? { repo } : {}),
        message: failure.error.message
      });
      return failure;
    }
  }

  private requireManagedRepo(repoSlug: string): ManagedRepo {
    const repo = this.managedRepos.get(repoSlug);
    if (!repo) {
      throw new RepoNotManagedError(`Repository "${repoSlug}" is not enabled in management/repos.json`);
    }

    return repo;
  }

  private async runReadTool(
    timestamp: string,
    toolName: GitHubBrokerToolName,
    rawArguments: unknown,
    sanitizedArguments: Record<string, unknown>,
    runner: () => Promise<BrokerToolCallSuccess & { repo: string }>
  ): Promise<BrokerToolCallResult> {
    const result = await runner();
    this.logInvocation({
      timestamp,
      toolName,
      repo: result.repo,
      status: "ok",
      arguments: sanitizedArguments
    });
    return result;
  }

  private logInvocation(entry: {
    timestamp: string;
    toolName: string;
    repo?: string;
    status: "ok" | "error";
    arguments: Record<string, unknown>;
    message?: string;
  }): void {
    this.logger.info(
      JSON.stringify({
        component: "github-broker-mcp",
        timestamp: entry.timestamp,
        toolName: entry.toolName,
        repo: entry.repo ?? "unknown",
        resultStatus: entry.status,
        arguments: entry.arguments,
        ...(entry.message ? { message: entry.message } : {})
      })
    );
  }
}

class BrokerValidationError extends Error {}
class RepoNotManagedError extends Error {}

function toFailure(name: string, rawArguments: unknown, error: unknown): BrokerToolCallFailure & { repo?: string } {
  const repo = extractRepoSlug(rawArguments);
  if (error instanceof BrokerValidationError) {
    return {
      ok: false,
      tool: name,
      ...(repo ? { repo } : {}),
      error: {
        code: "invalid_arguments",
        message: error.message
      }
    };
  }

  if (error instanceof RepoNotManagedError) {
    return {
      ok: false,
      tool: name,
      ...(repo ? { repo } : {}),
      error: {
        code: "repo_not_managed",
        message: error.message
      }
    };
  }

  return {
    ok: false,
    tool: name,
    ...(repo ? { repo } : {}),
    error: {
      code: "github_error",
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

function validateIssueLookup(value: unknown): { repo: string; issueNumber: number } {
  const object = expectObject(value, "tool arguments must be an object");
  return {
    repo: expectRepoSlug(object.repo, '"repo" must be an "owner/name" string'),
    issueNumber: expectPositiveInteger(object.issueNumber, '"issueNumber" must be a positive integer')
  };
}

function validatePullRequestLookup(value: unknown): { repo: string; pullRequestNumber: number } {
  const object = expectObject(value, "tool arguments must be an object");
  return {
    repo: expectRepoSlug(object.repo, '"repo" must be an "owner/name" string'),
    pullRequestNumber: expectPositiveInteger(
      object.pullRequestNumber,
      '"pullRequestNumber" must be a positive integer'
    )
  };
}

function validateCodeSearch(value: unknown): {
  repo: string;
  query: string;
  pathPrefix?: string;
  limit: number;
} {
  const object = expectObject(value, "tool arguments must be an object");
  const limitValue = object.limit === undefined ? 10 : object.limit;
  const pathPrefix = optionalTrimmedString(
    object.pathPrefix,
    '"pathPrefix" must be a non-empty string when provided'
  );

  return {
    repo: expectRepoSlug(object.repo, '"repo" must be an "owner/name" string'),
    query: expectNonEmptyString(object.query, '"query" must be a non-empty string'),
    ...(pathPrefix ? { pathPrefix } : {}),
    limit: expectBoundedPositiveInteger(
      limitValue,
      1,
      MAX_SEARCH_LIMIT,
      `"limit" must be between 1 and ${MAX_SEARCH_LIMIT}`
    )
  };
}

function validatePostIssueComment(value: unknown): { repo: string; issueNumber: number; body: string } {
  const object = expectObject(value, "tool arguments must be an object");

  return {
    repo: expectRepoSlug(object.repo, '"repo" must be an "owner/name" string'),
    issueNumber: expectPositiveInteger(object.issueNumber, '"issueNumber" must be a positive integer'),
    body: expectBoundedString(
      object.body,
      MAX_COMMENT_BODY_LENGTH,
      `"body" must be a non-empty string up to ${MAX_COMMENT_BODY_LENGTH} characters`
    )
  };
}

function validateCreatePullRequest(value: unknown): {
  repo: string;
  headBranch: string;
  baseBranch?: string;
  title: string;
  body: string;
} {
  const object = expectObject(value, "tool arguments must be an object");
  const baseBranch = optionalTrimmedString(
    object.baseBranch,
    '"baseBranch" must be a non-empty string when provided'
  );

  return {
    repo: expectRepoSlug(object.repo, '"repo" must be an "owner/name" string'),
    headBranch: expectNonEmptyString(object.headBranch, '"headBranch" must be a non-empty string'),
    ...(baseBranch ? { baseBranch } : {}),
    title: expectNonEmptyString(object.title, '"title" must be a non-empty string'),
    body: expectBoundedString(
      object.body,
      MAX_PR_BODY_LENGTH,
      `"body" must be a non-empty string up to ${MAX_PR_BODY_LENGTH} characters`
    )
  };
}

function validatePostPullRequestReviewCommentReply(
  value: unknown
): { repo: string; pullRequestNumber: number; commentId: number; body: string } {
  const object = expectObject(value, "tool arguments must be an object");

  return {
    repo: expectRepoSlug(object.repo, '"repo" must be an "owner/name" string'),
    pullRequestNumber: expectPositiveInteger(
      object.pullRequestNumber,
      '"pullRequestNumber" must be a positive integer'
    ),
    commentId: expectPositiveInteger(object.commentId, '"commentId" must be a positive integer'),
    body: expectBoundedString(
      object.body,
      MAX_COMMENT_BODY_LENGTH,
      `"body" must be a non-empty string up to ${MAX_COMMENT_BODY_LENGTH} characters`
    )
  };
}

function sanitizeArguments(name: string, value: unknown): Record<string, unknown> {
  const object = isRecord(value) ? value : {};

  switch (name) {
    case "post_issue_comment":
    case "post_pr_review_comment_reply":
      return {
        repo: safeString(object.repo),
        ...(name === "post_issue_comment"
          ? { issueNumber: safeNumber(object.issueNumber) }
          : {
              pullRequestNumber: safeNumber(object.pullRequestNumber),
              commentId: safeNumber(object.commentId)
            }),
        bodyPreview: previewBody(object.body),
        bodyLength: safeLength(object.body)
      };
    case "create_pr":
      return {
        repo: safeString(object.repo),
        headBranch: safeString(object.headBranch),
        baseBranch: safeString(object.baseBranch),
        title: safeString(object.title),
        bodyPreview: previewBody(object.body),
        bodyLength: safeLength(object.body)
      };
    default:
      return Object.fromEntries(
        Object.entries(object).map(([key, entry]) => [key, typeof entry === "string" ? entry : entry ?? null])
      );
  }
}

function previewBody(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }

  return trimmed.slice(0, 120);
}

function safeLength(value: unknown): number | null {
  return typeof value === "string" ? value.length : null;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function extractRepoSlug(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.repo !== "string") {
    return undefined;
  }

  return value.repo;
}

function expectObject(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BrokerValidationError(message);
  }

  return value;
}

function expectRepoSlug(value: unknown, message: string): string {
  const repo = expectNonEmptyString(value, message);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new BrokerValidationError(message);
  }

  return repo;
}

function expectNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrokerValidationError(message);
  }

  return value.trim();
}

function optionalTrimmedString(value: unknown, message: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectNonEmptyString(value, message);
}

function expectPositiveInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new BrokerValidationError(message);
  }

  return value as number;
}

function expectBoundedPositiveInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  message: string
): number {
  const parsed = expectPositiveInteger(value, message);
  if (parsed < minimum || parsed > maximum) {
    throw new BrokerValidationError(message);
  }

  return parsed;
}

function expectBoundedString(value: unknown, maximumLength: number, message: string): string {
  const parsed = expectNonEmptyString(value, message);
  if (parsed.length > maximumLength) {
    throw new BrokerValidationError(message);
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const TOOL_DEFINITIONS: BrokerTool[] = [
  {
    name: "get_issue",
    title: "Get GitHub Issue",
    description: "Return a single managed GitHub issue with structured metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "issueNumber"],
      properties: {
        repo: { type: "string", description: 'Managed repository slug in "owner/name" form.' },
        issueNumber: { type: "integer", minimum: 1 }
      }
    }
  },
  {
    name: "get_issue_comments",
    title: "Get GitHub Issue Comments",
    description: "Return top-level comments for a managed GitHub issue.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "issueNumber"],
      properties: {
        repo: { type: "string" },
        issueNumber: { type: "integer", minimum: 1 }
      }
    }
  },
  {
    name: "get_pr",
    title: "Get GitHub Pull Request",
    description: "Return a single managed GitHub pull request with structured metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "pullRequestNumber"],
      properties: {
        repo: { type: "string" },
        pullRequestNumber: { type: "integer", minimum: 1 }
      }
    }
  },
  {
    name: "get_pr_comments",
    title: "Get Pull Request Discussion",
    description:
      "Return top-level PR comments, reviews, and inline review comments for a managed pull request.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "pullRequestNumber"],
      properties: {
        repo: { type: "string" },
        pullRequestNumber: { type: "integer", minimum: 1 }
      }
    }
  },
  {
    name: "get_pr_checks",
    title: "Get Pull Request CI Check Results",
    description:
      "Return CI check run results for the head commit of a managed pull request. Reports status (queued/in_progress/completed) and conclusion (success/failure/etc.) for each check.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "pullRequestNumber"],
      properties: {
        repo: { type: "string" },
        pullRequestNumber: { type: "integer", minimum: 1 }
      }
    }
  },
  {
    name: "search_code",
    title: "Search Managed Repository Code",
    description: "Run a bounded code search in a managed repository.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "query"],
      properties: {
        repo: { type: "string" },
        query: { type: "string" },
        pathPrefix: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT }
      }
    }
  },
  {
    name: "post_issue_comment",
    title: "Post GitHub Issue Comment",
    description: "Post a comment on a managed issue or pull request thread.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "issueNumber", "body"],
      properties: {
        repo: { type: "string" },
        issueNumber: { type: "integer", minimum: 1 },
        body: { type: "string", minLength: 1, maxLength: MAX_COMMENT_BODY_LENGTH }
      }
    }
  },
  {
    name: "post_pr_review_comment_reply",
    title: "Reply To Inline Review Comment",
    description: "Post a reply directly to an inline pull request review comment in a managed repository.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "pullRequestNumber", "commentId", "body"],
      properties: {
        repo: { type: "string" },
        pullRequestNumber: { type: "integer", minimum: 1 },
        commentId: { type: "integer", minimum: 1 },
        body: { type: "string", minLength: 1, maxLength: MAX_COMMENT_BODY_LENGTH }
      }
    }
  },
  {
    name: "create_pr",
    title: "Create Pull Request",
    description: "Create a pull request in a managed repository from an existing head branch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "headBranch", "title", "body"],
      properties: {
        repo: { type: "string" },
        headBranch: { type: "string", minLength: 1 },
        baseBranch: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1, maxLength: MAX_PR_BODY_LENGTH }
      }
    }
  }
];
