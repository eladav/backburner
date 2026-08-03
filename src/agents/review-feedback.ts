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
import type { ReviewResultV2 } from "../reviews/contracts.js";

export interface ReviewPublisher {
  publishReview(task: TaskRecord, execution: ExecutionRecord): Promise<void>;
}

export interface ReviewCyclePublicationReceipt {
  id: string;
  url: string;
  commentKind: "pull_request_review" | "pull_request_comment";
  author?: string;
  ownedReviewCommentIds: string[];
}

export interface ReviewCyclePublisher {
  publishCycleReview(
    task: TaskRecord,
    execution: ExecutionRecord
  ): Promise<ReviewCyclePublicationReceipt>;
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

  async publishCycleReview(
    task: TaskRecord,
    execution: ExecutionRecord
  ): Promise<ReviewCyclePublicationReceipt> {
    const lineage = task.context.reviewCycle;
    const review = execution.result?.reviewCycleReview;
    if (task.kind !== "review_pr" || execution.taskStatus !== "completed" || !lineage || !review) {
      throw new Error(`Task ${task.id} is not a completed automatic review-cycle review.`);
    }

    const repo = this.reposById.get(task.repoId);
    const pullRequestNumber = Task.from(task).owningPullRequestNumber();
    if (!repo || pullRequestNumber === undefined) {
      throw new Error(`Could not resolve repository or pull request for review-cycle task ${task.id}.`);
    }

    const pr = await this.gitHubGateway.getPullRequest(repo.owner, repo.name, pullRequestNumber);
    if (pr.headSha !== lineage.targetHeadSha || review.reviewedHeadSha !== lineage.targetHeadSha) {
      throw new Error(
        `Refusing stale review publication for ${repo.owner}/${repo.name}#${pullRequestNumber}: ` +
          `expected ${lineage.targetHeadSha}, live ${pr.headSha ?? "unknown"}, reviewed ${review.reviewedHeadSha}.`
      );
    }

    const marker = reviewCycleMarker(lineage.sessionId, "review", lineage.reviewOrdinal);
    const existing = await findExistingCycleReview(
      this.gitHubGateway,
      repo.owner,
      repo.name,
      pullRequestNumber,
      marker
    );
    if (existing) {
      return existing;
    }

    const changedFiles = await this.gitHubGateway.listPullRequestChangedFiles(
      repo.owner,
      repo.name,
      pullRequestNumber
    );
    const validation = validateCycleReview(review, changedFiles, marker);
    const body = buildCycleReviewBody(review, validation.movedToSummary, marker);

    try {
      const submission = await this.gitHubGateway.submitPullRequestReview({
        owner: repo.owner,
        name: repo.name,
        pullRequestNumber,
        event: "COMMENT",
        body,
        commitId: lineage.targetHeadSha,
        comments: validation.validInlineComments
      });
      const observedSubmission = await findExistingCycleReview(
        this.gitHubGateway,
        repo.owner,
        repo.name,
        pullRequestNumber,
        marker
      );
      if (observedSubmission?.commentKind === "pull_request_review") {
        return {
          ...observedSubmission,
          ownedReviewCommentIds: uniqueStrings([
            String(submission.id),
            ...(submission.nodeId ? [submission.nodeId] : []),
            ...observedSubmission.ownedReviewCommentIds
          ])
        };
      }
      const ownedReviewCommentIds = await findOwnedInlineCommentIds(
        this.gitHubGateway,
        repo.owner,
        repo.name,
        pullRequestNumber,
        marker
      );
      if (submission.nodeId && !ownedReviewCommentIds.includes(submission.nodeId)) {
        ownedReviewCommentIds.push(submission.nodeId);
      }
      return {
        id: String(submission.id),
        url: submission.url,
        commentKind: "pull_request_review",
        ...(submission.author?.login ? { author: submission.author.login } : {}),
        ownedReviewCommentIds
      };
    } catch (error) {
      this.logger?.warn(
        `Failed to publish automatic review with inline findings; posting the complete review as a PR comment: ${error instanceof Error ? error.message : String(error)}`
      );
      // A transport failure can arrive after GitHub accepted the review. Check
      // the durable marker again before creating a summary fallback.
      const acceptedReview = await findExistingCycleReview(
        this.gitHubGateway,
        repo.owner,
        repo.name,
        pullRequestNumber,
        marker
      );
      if (acceptedReview) {
        return acceptedReview;
      }
      const fallback = await this.gitHubGateway.postIssueComment({
        owner: repo.owner,
        name: repo.name,
        issueNumber: pullRequestNumber,
        body: buildCycleReviewBody(review, review.findings.map((finding) => ({
          finding,
          reason: "published in summary fallback"
        })), marker)
      });
      return {
        id: String(fallback.id),
        url: fallback.url,
        commentKind: "pull_request_comment",
        ...(fallback.author?.login ? { author: fallback.author.login } : {}),
        ownedReviewCommentIds: []
      };
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

async function findExistingCycleReview(
  gateway: GitHubGateway,
  owner: string,
  name: string,
  pullRequestNumber: number,
  marker: string
): Promise<ReviewCyclePublicationReceipt | undefined> {
  const [authenticatedUser, reviews, comments] = await Promise.all([
    gateway.getAuthenticatedUser(),
    gateway.listPullRequestReviews(owner, name, pullRequestNumber),
    gateway.listIssueComments(owner, name, pullRequestNumber)
  ]);
  const review = reviews.find((candidate) =>
    sameLogin(candidate.author?.login, authenticatedUser) && candidate.body?.includes(marker)
  );
  if (review) {
    return {
      id: String(review.id),
      url: review.url ?? `https://github.com/${owner}/${name}/pull/${pullRequestNumber}`,
      commentKind: "pull_request_review",
      ...(review.author?.login ? { author: review.author.login } : {}),
      ownedReviewCommentIds: await findOwnedInlineCommentIds(
        gateway,
        owner,
        name,
        pullRequestNumber,
        marker,
        authenticatedUser
      )
    };
  }

  const comment = comments.find((candidate) =>
    sameLogin(candidate.author?.login, authenticatedUser) && candidate.body.includes(marker)
  );
  if (!comment) return undefined;
  return {
    id: String(comment.id),
    url: comment.url,
    commentKind: "pull_request_comment",
    ...(comment.author?.login ? { author: comment.author.login } : {}),
    ownedReviewCommentIds: []
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

interface CycleReviewValidation {
  validInlineComments: Array<{
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
  }>;
  movedToSummary: Array<{ finding: ReviewResultV2["findings"][number]; reason: string }>;
}

function validateCycleReview(
  review: ReviewResultV2,
  changedFiles: GhPullRequestChangedFile[],
  marker: string
): CycleReviewValidation {
  const changedFileByPath = new Map(changedFiles.map((file) => [file.path, file]));
  const validInlineComments: CycleReviewValidation["validInlineComments"] = [];
  const movedToSummary: CycleReviewValidation["movedToSummary"] = [];

  for (const finding of review.findings) {
    if (!finding.path || finding.line === undefined || !finding.side) {
      movedToSummary.push({ finding, reason: "no inline location" });
      continue;
    }
    const anchor = validateInlineCommentAnchor(
      {
        path: finding.path,
        line: finding.line,
        side: finding.side,
        ...(finding.instruction ? { body: finding.instruction } : {})
      },
      changedFileByPath.get(finding.path)
    );
    if (!anchor.isValid) {
      movedToSummary.push({ finding, reason: anchor.reason ?? "invalid inline location" });
      continue;
    }
    validInlineComments.push({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: `${withBotPrefix(`${finding.id} — ${finding.title}: ${finding.instruction ?? finding.evidence ?? "Review finding."}`)}\n\n${marker}`
    });
  }

  return { validInlineComments, movedToSummary };
}

function buildCycleReviewBody(
  review: ReviewResultV2,
  movedToSummary: CycleReviewValidation["movedToSummary"],
  marker: string
): string {
  const lines = [
    withBotPrefix(`Review result: ${formatReviewAction(review.action)}`),
    "",
    `Reviewed head: \`${review.reviewedHeadSha.slice(0, 12)}\``,
    "",
    review.summary
  ];
  if (review.findings.length > 0) {
    const movedIds = new Set(movedToSummary.map((item) => item.finding.id));
    lines.push("", "Findings:");
    for (const finding of review.findings) {
      const location = finding.path && finding.line ? ` — \`${finding.path}:${finding.line}\`` : "";
      const publication = movedIds.has(finding.id) ? " — summary" : " — inline";
      lines.push(
        `- **${escapeReviewText(finding.id)} · ${escapeReviewText(finding.title)}**${location}${publication}: ${escapeReviewText(finding.instruction ?? finding.evidence ?? "Review feedback.")}`
      );
    }
  }
  lines.push("", marker);
  return lines.join("\n");
}

function escapeReviewText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").slice(0, 600);
}

function reviewCycleMarker(sessionId: string, kind: string, ordinal: number): string {
  return `<!-- backburner-review-cycle:v1 session=${sessionId} kind=${kind} ordinal=${ordinal} -->`;
}

async function findOwnedInlineCommentIds(
  gateway: GitHubGateway,
  owner: string,
  name: string,
  pullRequestNumber: number,
  marker: string,
  authenticatedUser?: string
): Promise<string[]> {
  try {
    const expectedAuthor = authenticatedUser ?? await gateway.getAuthenticatedUser();
    const comments = await gateway.listPullRequestReviewComments(owner, name, pullRequestNumber);
    return comments
      .filter((comment) =>
        sameLogin(comment.user?.login, expectedAuthor) && comment.body?.includes(marker)
      )
      .map((comment) => String(comment.id));
  } catch {
    // Prefixing remains defense in depth if indexing inline IDs transiently fails.
    return [];
  }
}

function sameLogin(candidate: string | undefined, expected: string): boolean {
  return candidate?.toLowerCase() === expected.toLowerCase();
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
