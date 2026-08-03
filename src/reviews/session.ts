import { z } from "zod";
import {
  FixResultV1Schema,
  ReviewFindingV2Schema,
  ReviewResultV2Schema
} from "./contracts.js";

export const REVIEW_SESSION_SCHEMA_VERSION = 1 as const;

export const REVIEW_SESSION_STATUSES = [
  "review_pending",
  "reviewing",
  "review_publication_pending",
  "fix_pending",
  "fixing",
  "fix_handoff_pending",
  "fix_publication_pending",
  "approved",
  "no_actionable",
  "max_turns",
  "failed",
  "superseded",
  "canceled"
] as const;

export const ReviewSessionStatusSchema = z.enum(REVIEW_SESSION_STATUSES);
export const ReviewSessionTriggerSchema = z.enum([
  "label",
  "head_changed",
  "continue",
  "retry"
]);

const nonEmptyString = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });
const headSha = z.string().regex(/^[0-9a-f]{40}$/i, "must be a 40-character Git commit SHA");

export const GitHubCommentReceiptSchema = z.object({
  commentId: nonEmptyString,
  url: z.url(),
  marker: nonEmptyString,
  publishedAt: timestamp,
  authorLogin: nonEmptyString.optional(),
  githubObjectKind: z.enum(["pull_request_comment", "pull_request_review", "pull_request_review_comment"]).default("pull_request_comment")
}).strict();

export const ReviewPublicationReceiptSchema = z.object({
  id: nonEmptyString,
  kind: z.enum(["review", "fix", "terminal"]),
  reviewOrdinal: z.number().int().positive(),
  turnNumber: z.number().int().nonnegative().optional(),
  findingId: nonEmptyString.optional(),
  headSha,
  githubId: nonEmptyString,
  url: z.url(),
  marker: nonEmptyString,
  publishedAt: timestamp,
  authorLogin: nonEmptyString.optional(),
  githubObjectKind: z.enum(["pull_request_comment", "pull_request_review", "pull_request_review_comment"]),
  ownedCommentIds: z.array(nonEmptyString).default([])
}).strict().superRefine((receipt, context) => {
  if (receipt.kind === "fix" && (receipt.findingId === undefined || receipt.turnNumber === undefined)) {
    context.addIssue({
      code: "custom",
      message: "fix receipts require findingId and turnNumber"
    });
  }
  if (receipt.kind === "review" && receipt.findingId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["findingId"],
      message: "review receipts must not identify a finding"
    });
  }
});

export const ReviewTimelineEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.enum([
    "session_started",
    "review_dispatched",
    "review_completed",
    "review_published",
    "fix_dispatched",
    "fix_completed",
    "fix_handoff_pushed",
    "fix_handoff_no_change",
    "fix_published",
    "turn_completed",
    "session_approved",
    "session_no_actionable",
    "session_max_turns",
    "session_failed",
    "session_superseded",
    "session_canceled"
  ]),
  at: timestamp,
  reviewOrdinal: z.number().int().positive(),
  turnNumber: z.number().int().nonnegative().optional(),
  findingId: nonEmptyString.optional(),
  taskId: nonEmptyString.optional(),
  executionId: nonEmptyString.optional(),
  headSha: headSha.optional(),
  message: nonEmptyString.optional()
}).strict();

export const ReviewSessionFailureSchema = z.object({
  step: z.enum(["review", "fix", "contract", "handoff", "publication", "orchestration"]),
  reason: nonEmptyString,
  taskId: nonEmptyString.optional(),
  executionId: nonEmptyString.optional(),
  findingId: nonEmptyString.optional(),
  failedAt: timestamp
}).strict();

export const ReviewFindingStateSchema = z.object({
  order: z.number().int().nonnegative(),
  finding: ReviewFindingV2Schema,
  status: z.enum([
    "pending",
    "dispatched",
    "executed",
    "handoff_pending",
    "publication_pending",
    "fixed",
    "already_covered",
    "failed"
  ]),
  taskId: nonEmptyString.optional(),
  executionId: nonEmptyString.optional(),
  result: FixResultV1Schema.optional(),
  headBefore: headSha.optional(),
  headAfter: headSha.optional(),
  commitSha: headSha.optional(),
  filesChanged: z.array(nonEmptyString).optional(),
  publicationReceipt: ReviewPublicationReceiptSchema.optional()
}).strict().superRefine((finding, context) => {
  if (finding.result !== undefined && finding.result.findingId !== finding.finding.id) {
    context.addIssue({
      code: "custom",
      path: ["result", "findingId"],
      message: "must match finding.id"
    });
  }
  if (finding.status === "fixed" && finding.result?.disposition !== "fixed") {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "fixed state requires a fixed result"
    });
  }
  if (
    finding.status === "already_covered" &&
    finding.result?.disposition !== "already_covered"
  ) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "already_covered state requires an already_covered result"
    });
  }
});

export const ReviewSessionRecordSchema = z.object({
  schemaVersion: z.literal(REVIEW_SESSION_SCHEMA_VERSION),
  id: nonEmptyString,
  repoId: nonEmptyString,
  repoSlug: nonEmptyString,
  pullRequestId: nonEmptyString,
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.url(),
  workstreamId: nonEmptyString,
  packetId: nonEmptyString.optional(),
  status: ReviewSessionStatusSchema,
  trigger: ReviewSessionTriggerSchema,
  maxTurns: z.number().int().min(0).max(50),
  turnsCompleted: z.number().int().nonnegative(),
  reviewOrdinal: z.number().int().positive(),
  startHeadSha: headSha,
  expectedHeadSha: headSha,
  lastReviewedHeadSha: headSha.optional(),
  terminalHeadSha: headSha.optional(),
  activeReviewTaskId: nonEmptyString.optional(),
  activeFixTaskId: nonEmptyString.optional(),
  currentFindingIndex: z.number().int().nonnegative().optional(),
  currentReview: ReviewResultV2Schema.optional(),
  findings: z.array(ReviewFindingStateSchema),
  events: z.array(ReviewTimelineEventSchema),
  publicationReceipts: z.array(ReviewPublicationReceiptSchema),
  terminalComment: GitHubCommentReceiptSchema.optional(),
  failure: ReviewSessionFailureSchema.optional(),
  supersededBySessionId: nonEmptyString.optional(),
  continuedFromSessionId: nonEmptyString.optional(),
  retriedFromSessionId: nonEmptyString.optional(),
  commandCommentId: nonEmptyString.optional(),
  commandCommentUrl: z.url().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  terminalAt: timestamp.optional()
}).strict().superRefine((session, context) => {
  if (session.turnsCompleted > session.maxTurns) {
    context.addIssue({
      code: "custom",
      path: ["turnsCompleted"],
      message: "must not exceed maxTurns"
    });
  }
  if (session.reviewOrdinal !== session.turnsCompleted + 1) {
    context.addIssue({
      code: "custom",
      path: ["reviewOrdinal"],
      message: "must equal turnsCompleted + 1"
    });
  }

  requireUnique(session.events.map((event) => `${event.sequence}`), "events", context);
  requireUnique(session.publicationReceipts.map((receipt) => receipt.id), "publicationReceipts", context);
  requireUnique(session.findings.map((finding) => finding.finding.id), "findings", context);

  const terminal = isTerminalReviewSessionStatus(session.status);
  if (terminal !== (session.terminalAt !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["terminalAt"],
      message: terminal ? "is required for terminal sessions" : "is allowed only for terminal sessions"
    });
  }
  if (
    ["approved", "no_actionable", "max_turns"].includes(session.status) &&
    session.terminalHeadSha === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["terminalHeadSha"],
      message: "is required for a completed terminal review"
    });
  }
  if (session.status === "failed" && session.failure === undefined) {
    context.addIssue({
      code: "custom",
      path: ["failure"],
      message: "is required for failed sessions"
    });
  }

  const reviewResultStatuses: ReviewSessionStatus[] = [
    "review_publication_pending",
    "fix_pending",
    "fixing",
    "fix_handoff_pending",
    "fix_publication_pending",
    "approved",
    "no_actionable",
    "max_turns"
  ];
  if (reviewResultStatuses.includes(session.status) && session.currentReview === undefined) {
    context.addIssue({
      code: "custom",
      path: ["currentReview"],
      message: `is required while status is ${session.status}`
    });
  }
  if (
    session.currentReview !== undefined &&
    session.lastReviewedHeadSha !== session.currentReview.reviewedHeadSha
  ) {
    context.addIssue({
      code: "custom",
      path: ["lastReviewedHeadSha"],
      message: "must match currentReview.reviewedHeadSha"
    });
  }
});

export const ReviewSessionStateFileSchema = z.object({
  schemaVersion: z.literal(REVIEW_SESSION_SCHEMA_VERSION),
  reviewSessions: z.array(ReviewSessionRecordSchema)
}).strict().superRefine((state, context) => {
  const activeByPullRequest = new Map<string, number>();
  state.reviewSessions.forEach((session, index) => {
    if (isTerminalReviewSessionStatus(session.status)) return;

    const key = `${session.repoId}\u0000${session.pullRequestId}`;
    const previousIndex = activeByPullRequest.get(key);
    if (previousIndex !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["reviewSessions", index],
        message: `duplicates active session at reviewSessions[${previousIndex}] for the same pull request`
      });
    } else {
      activeByPullRequest.set(key, index);
    }
  });
});

export type ReviewSessionStatus = z.infer<typeof ReviewSessionStatusSchema>;
export type ReviewSessionTrigger = z.infer<typeof ReviewSessionTriggerSchema>;
export type GitHubCommentReceipt = z.infer<typeof GitHubCommentReceiptSchema>;
export type ReviewPublicationReceipt = z.infer<typeof ReviewPublicationReceiptSchema>;
export type ReviewTimelineEvent = z.infer<typeof ReviewTimelineEventSchema>;
export type ReviewSessionFailure = z.infer<typeof ReviewSessionFailureSchema>;
export type ReviewFindingState = z.infer<typeof ReviewFindingStateSchema>;
export type ReviewSessionRecord = z.infer<typeof ReviewSessionRecordSchema>;
export type ReviewSessionStateFile = z.infer<typeof ReviewSessionStateFileSchema>;

export interface CreateReviewSessionInput {
  repoId: string;
  repoSlug: string;
  pullRequestId: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  workstreamId: string;
  packetId?: string;
  trigger: ReviewSessionTrigger;
  maxTurns: number;
  headSha: string;
  ordinal: number;
  now: string;
  continuedFromSessionId?: string;
  retriedFromSessionId?: string;
  commandCommentId?: string;
  commandCommentUrl?: string;
}

export function createReviewSession(input: CreateReviewSessionInput): ReviewSessionRecord {
  return ReviewSessionRecordSchema.parse({
    schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
    id: reviewSessionId(input.repoId, input.pullRequestId, input.ordinal),
    repoId: input.repoId,
    repoSlug: input.repoSlug,
    pullRequestId: input.pullRequestId,
    pullRequestNumber: input.pullRequestNumber,
    pullRequestUrl: input.pullRequestUrl,
    workstreamId: input.workstreamId,
    ...(input.packetId === undefined ? {} : { packetId: input.packetId }),
    status: "review_pending",
    trigger: input.trigger,
    maxTurns: input.maxTurns,
    turnsCompleted: 0,
    reviewOrdinal: 1,
    startHeadSha: input.headSha,
    expectedHeadSha: input.headSha,
    findings: [],
    events: [{
      sequence: 0,
      type: "session_started",
      at: input.now,
      reviewOrdinal: 1,
      headSha: input.headSha
    }],
    publicationReceipts: [],
    ...(input.continuedFromSessionId === undefined
      ? {}
      : { continuedFromSessionId: input.continuedFromSessionId }),
    ...(input.retriedFromSessionId === undefined
      ? {}
      : { retriedFromSessionId: input.retriedFromSessionId }),
    ...(input.commandCommentId === undefined ? {} : { commandCommentId: input.commandCommentId }),
    ...(input.commandCommentUrl === undefined ? {} : { commandCommentUrl: input.commandCommentUrl }),
    createdAt: input.now,
    updatedAt: input.now
  });
}

export function reviewSessionId(repoId: string, pullRequestId: string, ordinal: number): string {
  return `review-session:${repoId}:${pullRequestId}:${ordinal}`;
}

export function isTerminalReviewSessionStatus(status: ReviewSessionStatus): boolean {
  return [
    "approved",
    "no_actionable",
    "max_turns",
    "failed",
    "superseded",
    "canceled"
  ].includes(status);
}

function requireUnique(
  values: readonly string[],
  field: string,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [field, index],
        message: `duplicate value ${value}`
      });
    }
    seen.add(value);
  });
}
