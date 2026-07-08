import type { RepoConfig } from "../config/types.js";
import type { GitHubGateway, GhPullRequestChangedFile } from "../github/types.js";
import type {
  ExecutionRecord,
  ReviewDecisionResult,
  ReviewInlineComment
} from "../state/types.js";
import { Task } from "../tasks/task.js";
import type { TaskRecord } from "../tasks/types.js";
import type { Logger } from "../utils/logger.js";

export interface ReviewPublisher {
  publishReview(task: TaskRecord, execution: ExecutionRecord): Promise<void>;
}

export interface ValidationResult {
  validInlineComments: ReviewInlineComment[];
  movedToSummary: Array<{ comment: ReviewInlineComment; reason: string }>;
  normalizedReview: {
    action: ReviewDecisionResult["action"];
    summary: string;
  };
}

export class GitHubPullRequestReviewPublisher implements ReviewPublisher {
  private readonly reposById: Map<string, RepoConfig>;

  constructor(
    private readonly gitHubGateway: GitHubGateway,
    repos: RepoConfig[],
    private readonly logger?: Logger
  ) {
    this.reposById = new Map(repos.map((repo) => [repo.id, repo]));
  }

  async publishReview(task: TaskRecord, execution: ExecutionRecord): Promise<void> {
    if (task.kind !== "review_pr" || execution.taskStatus !== "completed") {
      return;
    }

    const review = execution.result?.review;
    if (!review) {
      this.logger?.warn(`Completed review task ${task.id} did not return a structured review result.`);
      return;
    }

    const repo = this.reposById.get(task.repoId);
    const pullRequestNumber = Task.from(task).owningPullRequestNumber();
    if (!repo || pullRequestNumber === undefined) {
      this.logger?.warn(`Could not resolve repo or pull request number for review task ${task.id}.`);
      return;
    }

    try {
      const pr = await this.gitHubGateway.getPullRequest(repo.owner, repo.name, pullRequestNumber);
      const changedFiles = await this.gitHubGateway.listPullRequestChangedFiles(
        repo.owner,
        repo.name,
        pullRequestNumber
      );
      const headSha = pr.headSha;

      const validation = this.validateReview(review, changedFiles);
      if (!validation) {
        this.logger?.warn(`Review task ${task.id} returned an invalid review result (missing summary or action).`);
        return;
      }

      const reviewBody = buildReviewBody(validation);

      try {
        await this.gitHubGateway.submitPullRequestReview({
          owner: repo.owner,
          name: repo.name,
          pullRequestNumber,
          event: "COMMENT",
          body: reviewBody,
          ...(headSha ? { commitId: headSha } : {}),
          comments: validation.validInlineComments as Array<{
            path: string;
            line: number;
            side?: "LEFT" | "RIGHT";
            startLine?: number;
            startSide?: "LEFT" | "RIGHT";
            body: string;
          }>
        });

        this.logger?.info(
          `Published PR review for ${repo.owner}/${repo.name}#${pullRequestNumber}: ` +
            `${validation.validInlineComments.length} inline, ${validation.movedToSummary.length} moved to summary.`
        );
      } catch (error) {
        if (validation.validInlineComments.length > 0) {
          this.logger?.warn(
            `Failed to submit PR review with inline comments, retrying summary-only. Error: ${error instanceof Error ? error.message : String(error)}`
          );

          const fallbackValidation: ValidationResult = {
            ...validation,
            validInlineComments: [],
            movedToSummary: [
              ...validation.movedToSummary,
              ...validation.validInlineComments.map((c) => ({
                comment: c,
                reason: "GitHub rejected inline placement"
              }))
            ]
          };

          const fallbackBody = buildReviewBody(fallbackValidation);
          try {
            await this.gitHubGateway.submitPullRequestReview({
              owner: repo.owner,
              name: repo.name,
              pullRequestNumber,
              event: "COMMENT",
              body: fallbackBody,
              ...(headSha ? { commitId: headSha } : {})
            });

            this.logger?.info(
              `Published fallback PR review for ${repo.owner}/${repo.name}#${pullRequestNumber} with all comments moved to summary.`
            );
          } catch (fallbackError) {
            this.logger?.warn(
              `Failed to submit summary-only PR review, posting a PR thread comment instead. Error: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
            );
            await this.gitHubGateway.postIssueComment({
              owner: repo.owner,
              name: repo.name,
              issueNumber: pullRequestNumber,
              body: fallbackBody
            });
          }
        } else {
          await this.gitHubGateway.postIssueComment({
            owner: repo.owner,
            name: repo.name,
            issueNumber: pullRequestNumber,
            body: reviewBody
          });
        }
      }
    } catch (error) {
      this.logger?.error?.(
        `Failed to publish PR review for ${repo.owner}/${repo.name}#${pullRequestNumber}: ${error instanceof Error ? error.message : String(error)}`
      );
      // Let it propagate so safelyPublishReview can handle it (currently it swallows it)
      throw error;
    }
  }

  private validateReview(
    review: ReviewDecisionResult,
    changedFiles: GhPullRequestChangedFile[]
  ): ValidationResult | undefined {
    const summary = review.summary?.trim();
    if (!summary || !review.action) {
      return undefined;
    }

    const validInlineComments: ReviewInlineComment[] = [];
    const movedToSummary: Array<{ comment: ReviewInlineComment; reason: string }> = [];

    const changedFileByPath = new Map(changedFiles.map((f) => [f.path, f]));

    if (review.inlineComments) {
      for (const comment of review.inlineComments) {
        const shapeResult = validateInlineComment(comment);
        if (!shapeResult.isValid) {
          movedToSummary.push({ comment, reason: shapeResult.reason! });
          continue;
        }

        const normalized = shapeResult.normalized!;
        const path = normalized.path;
        if (path === undefined) {
          continue;
        }

        const anchorResult = validateInlineCommentAnchor(normalized, changedFileByPath.get(path));

        if (anchorResult.isValid) {
          validInlineComments.push(normalized);
        } else {
          movedToSummary.push({ comment: normalized, reason: anchorResult.reason! });
        }
      }
    }

    return {
      validInlineComments,
      movedToSummary,
      normalizedReview: {
        action: review.action,
        summary
      }
    };
  }
}

function validateInlineCommentAnchor(
  comment: ReviewInlineComment,
  changedFile: GhPullRequestChangedFile | undefined
): { isValid: boolean; reason?: string } {
  if (!changedFile) {
    return { isValid: false, reason: "file is not in the PR diff" };
  }

  const { line, side, startLine, startSide } = comment;
  if (line === undefined) {
    return { isValid: false, reason: "missing line number" };
  }

  // Check line/side
  const targetLines = side === "LEFT" ? changedFile.leftCommentableLines : changedFile.rightCommentableLines;
  if (!targetLines.includes(line)) {
    return { isValid: false, reason: `line ${line} on ${side} side is not available in the PR diff` };
  }

  // Check range if present
  if (startLine !== undefined) {
    const effectiveStartSide = startSide || side;

    if (effectiveStartSide === side) {
      // Single-side range: require every line in the range to be commentable
      for (let l = startLine; l <= line; l++) {
        if (!targetLines.includes(l)) {
          return {
            isValid: false,
            reason: `line ${l} in range ${startLine}-${line} on ${side} side is not available in the PR diff`
          };
        }
      }
    } else {
      // Cross-side range: conservative MVP rule
      const startTargetLines =
        effectiveStartSide === "LEFT" ? changedFile.leftCommentableLines : changedFile.rightCommentableLines;
      if (!startTargetLines.includes(startLine)) {
        return {
          isValid: false,
          reason: `start line ${startLine} on ${effectiveStartSide} side is not available in the PR diff`
        };
      }
    }
  }

  return { isValid: true };
}

function validateInlineComment(comment: ReviewInlineComment): {
  isValid: boolean;
  normalized?: ReviewInlineComment;
  reason?: string;
} {
  const path = comment.path?.trim();
  const body = comment.body?.trim();
  const line = comment.line;

  if (!path) return { isValid: false, reason: "missing path" };
  if (!body) return { isValid: false, reason: "missing body" };
  if (line === undefined || !Number.isInteger(line) || line < 1) {
    return { isValid: false, reason: "invalid line number" };
  }

  const side = comment.side === "LEFT" || comment.side === "RIGHT" ? comment.side : "RIGHT";

  let startLine = comment.startLine;
  let startSide = comment.startSide;

  if (startLine !== undefined) {
    if (!Number.isInteger(startLine) || startLine < 1) {
      return { isValid: false, reason: "invalid startLine" };
    }
    if (startLine > line) {
      return { isValid: false, reason: "startLine must be <= line" };
    }
    if (!startSide) {
      startSide = side;
    } else if (startSide !== "LEFT" && startSide !== "RIGHT") {
      return { isValid: false, reason: "invalid startSide" };
    }
  }

  return {
    isValid: true,
    normalized: {
      path,
      line,
      body,
      side,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(startSide !== undefined ? { startSide } : {})
    }
  };
}

function buildReviewBody(validation: ValidationResult): string {
  const { normalizedReview, movedToSummary, validInlineComments } = validation;
  const lines = [
    withBotPrefix(`Review result: ${formatReviewAction(normalizedReview.action)}`),
    "",
    normalizedReview.summary
  ];

  if (movedToSummary.length > 0) {
    lines.push("");
    lines.push(
      `Inline comment publication: ${validInlineComments.length} posted inline, ${movedToSummary.length} moved into this summary.`
    );
    lines.push("");
    lines.push("Moved from inline comments:");
    for (const { comment, reason } of movedToSummary) {
      const location = `${comment.path}:${comment.line}`;
      lines.push(`- ${location}: ${comment.body} (Reason: ${reason})`);
    }
  }

  return lines.join("\n").trim();
}

function formatReviewAction(action: ReviewDecisionResult["action"]): string {
  switch (action) {
    case "APPROVE":
      return "approved";
    case "REQUEST_CHANGES":
      return "changes requested";
    case "COMMENT":
      return "comment";
  }
}

function withBotPrefix(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("🤖")) {
    return trimmed;
  }

  return `🤖 ${trimmed}`;
}
