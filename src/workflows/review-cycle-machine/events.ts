import type { FixResultV1, ReviewResultV2 } from "../../reviews/contracts.js";
import type {
  ReviewPublicationReceipt,
  ReviewSessionFailure
} from "../../reviews/session.js";

interface TimedEvent {
  at: string;
}

export type ReviewCycleEvent =
  | (TimedEvent & {
      type: "REVIEW_TASK_DISPATCHED";
      taskId: string;
      targetHeadSha: string;
    })
  | (TimedEvent & {
      type: "REVIEW_TASK_SUCCEEDED";
      taskId: string;
      executionId: string;
      result: ReviewResultV2;
    })
  | (TimedEvent & {
      type: "REVIEW_TASK_FAILED";
      failure: ReviewSessionFailure;
    })
  | (TimedEvent & {
      type: "REVIEW_PUBLISHED";
      receipt: ReviewPublicationReceipt;
      liveHeadSha: string;
    })
  | (TimedEvent & {
      type: "FIX_TASK_DISPATCHED";
      findingId: string;
      taskId: string;
      headBefore: string;
    })
  | (TimedEvent & {
      type: "FIX_TASK_SUCCEEDED";
      taskId: string;
      executionId: string;
      result: FixResultV1;
    })
  | (TimedEvent & {
      type: "FIX_TASK_FAILED";
      failure: ReviewSessionFailure;
    })
  | (TimedEvent & {
      type: "FIX_HANDOFF_PUSHED";
      findingId: string;
      headBefore: string;
      headAfter: string;
      commitSha: string;
      filesChanged: string[];
    })
  | (TimedEvent & {
      type: "FIX_HANDOFF_NO_CHANGE";
      findingId: string;
      headSha: string;
    })
  | (TimedEvent & {
      type: "FIX_PUBLISHED";
      findingId: string;
      receipt: ReviewPublicationReceipt;
    })
  | (TimedEvent & {
      type: "PUBLICATION_FAILED_RETRYABLY";
      message: string;
    })
  | (TimedEvent & {
      type: "EXPECTED_HEAD_OBSERVED";
      headSha: string;
    })
  | (TimedEvent & {
      type: "UNEXPECTED_HEAD_OBSERVED";
      actualHeadSha: string;
      supersededBySessionId?: string;
    })
  | (TimedEvent & {
      type: "SESSION_FAILED";
      failure: ReviewSessionFailure;
      liveHeadSha?: string;
    })
  | (TimedEvent & { type: "PR_CLOSED"; liveHeadSha: string })
  | (TimedEvent & { type: "REVIEW_LABEL_REMOVED"; liveHeadSha: string });
