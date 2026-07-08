import type {
  NormalizedComment,
  NormalizedIssue,
  NormalizedPullRequest
} from "../domain/entities.js";
import type { TaskRecord, TaskSourceKind } from "./types.js";
import type { AgentProvider } from "../config/types.js";

export interface TaskEntityLookups {
  issuesById?: ReadonlyMap<string, NormalizedIssue>;
  issuesByKey?: ReadonlyMap<string, NormalizedIssue>;
  pullRequestsById?: ReadonlyMap<string, NormalizedPullRequest>;
  pullRequestsByKey?: ReadonlyMap<string, NormalizedPullRequest>;
  commentsById?: ReadonlyMap<string, NormalizedComment>;
}

type SourceCommentKind =
  | "issue_comment"
  | "pull_request_comment"
  | "pull_request_review"
  | "pull_request_review_comment";

export class Task {
  constructor(public readonly record: TaskRecord) {}

  static from(record: TaskRecord): Task {
    return new Task(record);
  }

  get id(): string {
    return this.record.id;
  }

  get waitingOnProvider(): AgentProvider | undefined {
    return this.record.waitingOnProvider;
  }

  get kind(): TaskRecord["kind"] {
    return this.record.kind;
  }

  get sourceKind(): TaskRecord["sourceKind"] {
    return this.record.sourceKind;
  }

  get sourceId(): string {
    return this.record.sourceId;
  }

  get parentSourceKind(): Extract<TaskSourceKind, "issue" | "pull_request"> | undefined {
    return this.record.parentSourceKind;
  }

  get parentSourceId(): string | undefined {
    return this.record.parentSourceId;
  }

  getOwningThreadKind(): Extract<TaskSourceKind, "issue" | "pull_request"> | undefined {
    if (this.record.parentSourceKind) {
      return this.record.parentSourceKind;
    }
    if (this.record.sourceKind === "issue" || this.record.sourceKind === "pull_request") {
      return this.record.sourceKind;
    }
    return undefined;
  }

  getOwningThreadId(): string | undefined {
    return this.record.parentSourceId ?? (this.record.sourceKind === "comment" ? undefined : this.record.sourceId);
  }

  owningPullRequestNumber(): number | undefined {
    const pullRequestId =
      this.getOwningThreadKind() === "pull_request" ? this.getOwningThreadId() : undefined;
    if (!pullRequestId) {
      return undefined;
    }

    const match = pullRequestId.match(/:(\d+)$/);
    return match ? Number(match[1]) : undefined;
  }

  owningThreadNumber(): number | undefined {
    const owningThreadId = this.getOwningThreadId() ?? this.record.sourceId;
    const match = owningThreadId.match(/:(\d+)$/);
    return match ? Number(match[1]) : undefined;
  }

  resolveSourceIssue(lookups: TaskEntityLookups): NormalizedIssue | undefined {
    switch (this.record.sourceKind) {
      case "issue":
        return lookups.issuesById?.get(this.record.sourceId);
      case "pull_request":
        return undefined;
      case "comment":
        return this.resolveCommentParentIssue(lookups, this.record.sourceId);
    }
  }

  resolveOwningIssue(lookups: TaskEntityLookups): NormalizedIssue | undefined {
    const owningThreadId = this.getOwningThreadId();
    if (this.getOwningThreadKind() === "issue" && owningThreadId) {
      return lookups.issuesById?.get(owningThreadId);
    }

    if (this.record.sourceKind === "issue") {
      return lookups.issuesById?.get(this.record.sourceId);
    }

    if (this.record.sourceKind === "comment") {
      return this.resolveCommentParentIssue(lookups, this.record.sourceId);
    }

    return undefined;
  }

  resolveSourcePullRequest(lookups: TaskEntityLookups): NormalizedPullRequest | undefined {
    switch (this.record.sourceKind) {
      case "issue":
        return undefined;
      case "pull_request":
        return lookups.pullRequestsById?.get(this.record.sourceId);
      case "comment":
        return this.resolveCommentParentPullRequest(lookups, this.record.sourceId);
    }
  }

  resolveOwningPullRequest(lookups: TaskEntityLookups): NormalizedPullRequest | undefined {
    const owningThreadId = this.getOwningThreadId();
    if (this.getOwningThreadKind() === "pull_request" && owningThreadId) {
      return lookups.pullRequestsById?.get(owningThreadId);
    }

    if (this.record.sourceKind === "pull_request") {
      return lookups.pullRequestsById?.get(this.record.sourceId);
    }

    if (this.record.sourceKind === "comment") {
      return this.resolveCommentParentPullRequest(lookups, this.record.sourceId);
    }

    return undefined;
  }

  resolveSourceComment(lookups: TaskEntityLookups): NormalizedComment | undefined {
    if (this.record.sourceKind !== "comment") {
      return undefined;
    }

    return lookups.commentsById?.get(this.record.sourceId);
  }

  resolveOwningComment(lookups: TaskEntityLookups): NormalizedComment | undefined {
    if (this.record.sourceKind !== "comment") {
      return undefined;
    }

    return lookups.commentsById?.get(this.record.sourceId);
  }

  isSourceIssue(issue: Pick<NormalizedIssue, "id">): boolean {
    return this.record.sourceKind === "issue" && this.record.sourceId === issue.id;
  }

  isOwningIssue(issue: Pick<NormalizedIssue, "id">): boolean {
    return this.getOwningThreadKind() === "issue" && this.getOwningThreadId() === issue.id;
  }

  isSourcePullRequest(pullRequest: Pick<NormalizedPullRequest, "id">): boolean {
    return this.record.sourceKind === "pull_request" && this.record.sourceId === pullRequest.id;
  }

  isOwningPullRequest(pullRequest: Pick<NormalizedPullRequest, "id">): boolean {
    return this.getOwningThreadKind() === "pull_request" && this.getOwningThreadId() === pullRequest.id;
  }

  isSourceComment(comment: Pick<NormalizedComment, "id">): boolean {
    return this.record.sourceKind === "comment" && this.record.sourceId === comment.id;
  }

  isOwningComment(comment: Pick<NormalizedComment, "id">): boolean {
    return this.record.sourceKind === "comment" && this.record.sourceId === comment.id;
  }

  isRelatedToIssue(issue: Pick<NormalizedIssue, "id">): boolean {
    return this.isSourceIssue(issue) || this.isOwningIssue(issue);
  }

  isRelatedToPullRequest(pullRequest: Pick<NormalizedPullRequest, "id">): boolean {
    return this.isSourcePullRequest(pullRequest) || this.isOwningPullRequest(pullRequest);
  }

  isCommentOriginated(): boolean {
    return this.record.sourceKind === "comment";
  }

  getSourceCommentId(): string | undefined {
    if (this.record.sourceKind !== "comment") {
      return undefined;
    }

    if (this.record.sourceReactionTargetId) {
      return this.record.sourceReactionTargetId;
    }

    const match = this.record.sourceId.match(/:(\d+)$/);
    if (match) {
      return match[1];
    }

    return /^\d+$/.test(this.record.sourceId) ? this.record.sourceId : undefined;
  }

  getSourceCommentKind(): SourceCommentKind | undefined {
    if (this.record.sourceKind !== "comment") {
      return undefined;
    }

    const match = this.record.sourceId.match(
      /^comment:[^:]+\/[^:]+:(issue_comment|pull_request_comment|pull_request_review|pull_request_review_comment):/
    );
    return match?.[1] as SourceCommentKind | undefined;
  }

  getSourceEntityNumber(): number | undefined {
    // If it's an issue or PR, its ID ends with :number
    if (this.record.sourceKind === "issue" || this.record.sourceKind === "pull_request") {
      const match = this.record.sourceId.match(/:(\d+)$/);
      return match ? Number(match[1]) : undefined;
    }
    // For comments, we usually want the parent's number for reactions/feedback if no commentId is used
    // but the lifecycle notifier will use the precise source.
    return undefined;
  }

  private resolveCommentParentIssue(
    lookups: TaskEntityLookups,
    commentId: string
  ): NormalizedIssue | undefined {
    const comment = lookups.commentsById?.get(commentId);
    if (!comment || comment.parentType !== "issue") {
      return undefined;
    }

    return lookups.issuesByKey?.get(comment.parentKey);
  }

  private resolveCommentParentPullRequest(
    lookups: TaskEntityLookups,
    commentId: string
  ): NormalizedPullRequest | undefined {
    const comment = lookups.commentsById?.get(commentId);
    if (!comment || comment.parentType !== "pull_request") {
      return undefined;
    }

    return lookups.pullRequestsByKey?.get(comment.parentKey);
  }
}
