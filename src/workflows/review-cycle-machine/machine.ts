import type { FixResultV1 } from "../../reviews/contracts.js";
import {
  ReviewSessionRecordSchema,
  isTerminalReviewSessionStatus,
  type ReviewFindingState,
  type ReviewSessionFailure,
  type ReviewSessionRecord,
  type ReviewTimelineEvent
} from "../../reviews/session.js";
import type { ReviewCycleEvent } from "./events.js";
import {
  allReviewFindingsHandled,
  hasFixTurnBudget,
  selectNextReviewFinding
} from "./selectors.js";

export interface ReviewCycleTransitionResult {
  accepted: boolean;
  session: ReviewSessionRecord;
  rejectionReason?: string;
}

/**
 * Pure transition adapter for the durable review-session aggregate.
 * Callers persist the returned record before performing the next side effect.
 */
export function transitionReviewCycle(
  session: ReviewSessionRecord,
  event: ReviewCycleEvent
): ReviewCycleTransitionResult {
  if (isTerminalReviewSessionStatus(session.status)) {
    return rejected(session, `session is terminal (${session.status})`);
  }

  let next: ReviewSessionRecord | undefined;
  let reason: string | undefined;

  switch (event.type) {
    case "REVIEW_TASK_DISPATCHED": {
      if (session.status !== "review_pending") {
        reason = "review tasks can be dispatched only from review_pending";
        break;
      }
      if (event.targetHeadSha !== session.expectedHeadSha) {
        reason = "review target does not match expectedHeadSha";
        break;
      }
      next = appendEvent({
        ...session,
        status: "reviewing",
        activeReviewTaskId: event.taskId,
        updatedAt: event.at
      }, {
        type: "review_dispatched",
        at: event.at,
        taskId: event.taskId,
        headSha: event.targetHeadSha
      });
      break;
    }

    case "REVIEW_TASK_SUCCEEDED": {
      if (session.status !== "reviewing" || session.activeReviewTaskId !== event.taskId) {
        reason = "review result does not belong to the active review task";
        break;
      }
      if (event.result.reviewedHeadSha !== session.expectedHeadSha) {
        reason = "reviewedHeadSha does not match expectedHeadSha";
        break;
      }
      const findings = event.result.findings
        .map((finding, order) => ({ finding, order }))
        .filter(({ finding }) => finding.actionable)
        .map(({ finding, order }): ReviewFindingState => ({
          order,
          finding,
          status: "pending"
        }));
      next = appendEvent({
        ...omitActiveReviewTask(session),
        status: "review_publication_pending",
        currentReview: event.result,
        lastReviewedHeadSha: event.result.reviewedHeadSha,
        findings,
        updatedAt: event.at
      }, {
        type: "review_completed",
        at: event.at,
        taskId: event.taskId,
        executionId: event.executionId,
        headSha: event.result.reviewedHeadSha
      });
      break;
    }

    case "REVIEW_TASK_FAILED": {
      if (session.status !== "reviewing") {
        reason = "review task failure is legal only while reviewing";
        break;
      }
      next = failSession(session, event.failure, event.at);
      break;
    }

    case "REVIEW_PUBLISHED": {
      if (session.status !== "review_publication_pending" || session.currentReview === undefined) {
        reason = "review publication is legal only after a valid review result";
        break;
      }
      if (
        event.liveHeadSha !== session.expectedHeadSha ||
        event.receipt.headSha !== session.expectedHeadSha
      ) {
        reason = "review publication head does not match expectedHeadSha";
        break;
      }
      if (
        event.receipt.kind !== "review" ||
        event.receipt.reviewOrdinal !== session.reviewOrdinal
      ) {
        reason = "review receipt identity does not match the active review";
        break;
      }

      let status: ReviewSessionRecord["status"];
      let terminalEvent: ReviewTimelineEvent["type"] | undefined;
      if (session.currentReview.action === "APPROVE") {
        status = "approved";
        terminalEvent = "session_approved";
      } else if (session.currentReview.action === "COMMENT") {
        status = "no_actionable";
        terminalEvent = "session_no_actionable";
      } else if (!hasFixTurnBudget(session)) {
        status = "max_turns";
        terminalEvent = "session_max_turns";
      } else {
        status = "fix_pending";
      }

      next = appendEvent({
        ...session,
        status,
        publicationReceipts: [...session.publicationReceipts, event.receipt],
        ...(terminalEvent === undefined
          ? {}
          : { terminalHeadSha: event.liveHeadSha, terminalAt: event.at }),
        updatedAt: event.at
      }, {
        type: "review_published",
        at: event.at,
        headSha: event.liveHeadSha
      });
      if (terminalEvent !== undefined) {
        next = appendEvent(next, {
          type: terminalEvent,
          at: event.at,
          headSha: event.liveHeadSha
        });
      }
      break;
    }

    case "FIX_TASK_DISPATCHED": {
      if (session.status !== "fix_pending") {
        reason = "fix tasks can be dispatched only from fix_pending";
        break;
      }
      if (!hasFixTurnBudget(session)) {
        reason = "no fix turn budget remains";
        break;
      }
      if (event.headBefore !== session.expectedHeadSha) {
        reason = "fix headBefore does not match expectedHeadSha";
        break;
      }
      const finding = selectNextReviewFinding(session);
      if (finding?.finding.id !== event.findingId) {
        reason = "fix task is not for the next dependency-ready finding";
        break;
      }
      const findingIndex = session.findings.indexOf(finding);
      next = appendEvent({
        ...session,
        status: "fixing",
        activeFixTaskId: event.taskId,
        currentFindingIndex: findingIndex,
        findings: updateFinding(session.findings, findingIndex, {
          status: "dispatched",
          taskId: event.taskId,
          headBefore: event.headBefore
        }),
        updatedAt: event.at
      }, {
        type: "fix_dispatched",
        at: event.at,
        turnNumber: session.turnsCompleted + 1,
        findingId: event.findingId,
        taskId: event.taskId,
        headSha: event.headBefore
      });
      break;
    }

    case "FIX_TASK_SUCCEEDED": {
      if (
        session.status !== "fixing" ||
        session.activeFixTaskId !== event.taskId ||
        session.currentFindingIndex === undefined
      ) {
        reason = "fix result does not belong to the active fix task";
        break;
      }
      const finding = session.findings[session.currentFindingIndex];
      if (finding === undefined || finding.finding.id !== event.result.findingId) {
        reason = "fix result findingId does not match the active finding";
        break;
      }
      if (event.result.disposition === "blocked") {
        next = failSession(session, {
          step: "fix",
          reason: event.result.summary,
          taskId: event.taskId,
          executionId: event.executionId,
          findingId: event.result.findingId,
          failedAt: event.at
        }, event.at, session.expectedHeadSha);
        break;
      }
      next = appendEvent({
        ...omitActiveFixTask(session),
        status: "fix_handoff_pending",
        findings: updateFinding(session.findings, session.currentFindingIndex, {
          status: "handoff_pending",
          executionId: event.executionId,
          result: event.result
        }),
        updatedAt: event.at
      }, {
        type: "fix_completed",
        at: event.at,
        turnNumber: session.turnsCompleted + 1,
        findingId: event.result.findingId,
        taskId: event.taskId,
        executionId: event.executionId,
        headSha: session.expectedHeadSha
      });
      break;
    }

    case "FIX_TASK_FAILED": {
      if (session.status !== "fixing") {
        reason = "fix task failure is legal only while fixing";
        break;
      }
      next = failSession(session, event.failure, event.at);
      break;
    }

    case "FIX_HANDOFF_PUSH_INTENT_RECORDED": {
      const activeFinding = currentFinding(session);
      if (
        session.status !== "fix_handoff_pending" ||
        activeFinding === undefined ||
        activeFinding.finding.id !== event.findingId
      ) {
        reason = "push intent does not belong to the active finding";
        break;
      }
      if (
        activeFinding.result?.disposition !== "fixed" ||
        event.headBefore !== session.expectedHeadSha ||
        event.headAfter === event.headBefore ||
        activeFinding.pushIntentRecordedAt !== undefined
      ) {
        reason = "push intent is inconsistent with the fix result or expected head";
        break;
      }
      next = appendEvent({
        ...session,
        findings: updateCurrentFinding(session, {
          headAfter: event.headAfter,
          commitSha: event.commitSha,
          filesChanged: event.filesChanged,
          pushIntentRecordedAt: event.at
        }),
        updatedAt: event.at
      }, {
        type: "fix_handoff_push_intent",
        at: event.at,
        turnNumber: session.turnsCompleted + 1,
        findingId: event.findingId,
        headSha: event.headAfter
      });
      break;
    }

    case "FIX_HANDOFF_PUSH_AWAITING_OBSERVATION": {
      const activeFinding = currentFinding(session);
      if (
        session.status !== "fix_handoff_pending" ||
        activeFinding === undefined ||
        activeFinding.finding.id !== event.findingId
      ) {
        reason = "pending push observation does not belong to the active finding";
        break;
      }
      if (
        activeFinding.result?.disposition !== "fixed" ||
        activeFinding.pushIntentRecordedAt === undefined ||
        activeFinding.pushCompletedAt !== undefined ||
        activeFinding.headBefore !== event.headBefore ||
        activeFinding.headAfter !== event.headAfter ||
        activeFinding.commitSha !== event.commitSha ||
        event.headBefore !== session.expectedHeadSha ||
        !samePaths(activeFinding.filesChanged, event.filesChanged)
      ) {
        reason = "pending push observation is inconsistent with the durable push intent";
        break;
      }
      next = appendEvent({
        ...session,
        findings: updateCurrentFinding(session, {
          pushCompletedAt: event.at
        }),
        updatedAt: event.at
      }, {
        type: "fix_handoff_push_pending",
        at: event.at,
        turnNumber: session.turnsCompleted + 1,
        findingId: event.findingId,
        headSha: event.headAfter
      });
      break;
    }

    case "FIX_HANDOFF_PUSHED": {
      const activeFinding = currentFinding(session);
      if (
        session.status !== "fix_handoff_pending" ||
        activeFinding === undefined ||
        activeFinding.finding.id !== event.findingId
      ) {
        reason = "pushed handoff does not belong to the active finding";
        break;
      }
      if (
        activeFinding.result?.disposition !== "fixed" ||
        activeFinding.pushIntentRecordedAt === undefined ||
        event.headAfter === event.headBefore ||
        event.headBefore !== session.expectedHeadSha ||
        activeFinding.headBefore !== event.headBefore ||
        activeFinding.headAfter !== event.headAfter ||
        activeFinding.commitSha !== event.commitSha ||
        !samePaths(activeFinding.filesChanged, event.filesChanged)
      ) {
        reason = "pushed handoff is inconsistent with the fix result or expected head";
        break;
      }
      next = appendEvent({
        ...session,
        status: "fix_publication_pending",
        expectedHeadSha: event.headAfter,
        findings: updateCurrentFinding(session, {
          status: "publication_pending",
          headAfter: event.headAfter,
          commitSha: event.commitSha,
          filesChanged: event.filesChanged
        }),
        updatedAt: event.at
      }, {
        type: "fix_handoff_pushed",
        at: event.at,
        turnNumber: session.turnsCompleted + 1,
        findingId: event.findingId,
        headSha: event.headAfter
      });
      break;
    }

    case "FIX_HANDOFF_NO_CHANGE": {
      const activeFinding = currentFinding(session);
      if (
        session.status !== "fix_handoff_pending" ||
        activeFinding === undefined ||
        activeFinding.finding.id !== event.findingId
      ) {
        reason = "no-change handoff does not belong to the active finding";
        break;
      }
      if (
        activeFinding.result?.disposition !== "already_covered" ||
        event.headSha !== session.expectedHeadSha
      ) {
        reason = "no-change handoff is inconsistent with the fix result or expected head";
        break;
      }
      next = appendEvent({
        ...session,
        status: "fix_publication_pending",
        findings: updateCurrentFinding(session, {
          status: "publication_pending",
          headAfter: event.headSha,
          filesChanged: []
        }),
        updatedAt: event.at
      }, {
        type: "fix_handoff_no_change",
        at: event.at,
        turnNumber: session.turnsCompleted + 1,
        findingId: event.findingId,
        headSha: event.headSha
      });
      break;
    }

    case "FIX_PUBLISHED": {
      const activeFinding = currentFinding(session);
      if (
        session.status !== "fix_publication_pending" ||
        activeFinding === undefined ||
        activeFinding.finding.id !== event.findingId
      ) {
        reason = "fix publication does not belong to the active finding";
        break;
      }
      if (
        event.receipt.kind !== "fix" ||
        event.receipt.findingId !== event.findingId ||
        event.receipt.reviewOrdinal !== session.reviewOrdinal ||
        event.receipt.turnNumber !== session.turnsCompleted + 1 ||
        event.receipt.headSha !== session.expectedHeadSha
      ) {
        reason = "fix receipt identity does not match the active finding";
        break;
      }
      const disposition = activeFinding.result?.disposition;
      if (disposition !== "fixed" && disposition !== "already_covered") {
        reason = "fix publication requires a successful fix disposition";
        break;
      }
      const completedFindings = updateCurrentFinding(session, {
        status: disposition,
        publicationReceipt: event.receipt
      });
      let afterPublication = appendEvent({
        ...session,
        status: "fix_pending",
        findings: completedFindings,
        publicationReceipts: [...session.publicationReceipts, event.receipt],
        updatedAt: event.at
      }, {
        type: "fix_published",
        at: event.at,
        turnNumber: session.turnsCompleted + 1,
        findingId: event.findingId,
        headSha: session.expectedHeadSha
      });

      if (allReviewFindingsHandled(afterPublication)) {
        const completedTurn = session.turnsCompleted + 1;
        const { currentReview: _review, currentFindingIndex: _index, ...withoutCurrent } = afterPublication;
        afterPublication = appendEvent({
          ...withoutCurrent,
          status: "review_pending",
          turnsCompleted: completedTurn,
          reviewOrdinal: session.reviewOrdinal + 1,
          turnHistory: [...session.turnHistory, {
            reviewOrdinal: session.reviewOrdinal,
            turnNumber: completedTurn,
            headSha: session.expectedHeadSha,
            review: session.currentReview!,
            findings: completedFindings,
            completedAt: event.at
          }],
          findings: [],
          updatedAt: event.at
        }, {
          type: "turn_completed",
          at: event.at,
          reviewOrdinal: session.reviewOrdinal,
          turnNumber: completedTurn,
          headSha: session.expectedHeadSha
        });
      }
      next = afterPublication;
      break;
    }

    case "PUBLICATION_FAILED_RETRYABLY": {
      if (
        session.status !== "review_publication_pending" &&
        session.status !== "fix_publication_pending"
      ) {
        reason = "retryable publication failures require a publication-pending state";
        break;
      }
      next = {
        ...session,
        updatedAt: event.at
      };
      break;
    }

    case "EXPECTED_HEAD_OBSERVED": {
      if (event.headSha !== session.expectedHeadSha) {
        reason = "observed head does not match expectedHeadSha";
        break;
      }
      next = session;
      break;
    }

    case "UNEXPECTED_HEAD_OBSERVED": {
      if (event.actualHeadSha === session.expectedHeadSha) {
        reason = "unexpected-head event must identify a different head";
        break;
      }
      next = appendEvent({
        ...session,
        status: "superseded",
        // A session's terminal SHA is the head that session actually handled.
        // The newly observed SHA belongs to the successor session.
        terminalHeadSha: session.expectedHeadSha,
        ...(event.supersededBySessionId === undefined
          ? {}
          : { supersededBySessionId: event.supersededBySessionId }),
        terminalAt: event.at,
        updatedAt: event.at
      }, {
        type: "session_superseded",
        at: event.at,
        headSha: event.actualHeadSha
      });
      break;
    }

    case "SESSION_FAILED": {
      next = failSession(session, event.failure, event.at, event.liveHeadSha);
      break;
    }

    case "PR_CLOSED":
    case "REVIEW_LABEL_REMOVED": {
      next = appendEvent({
        ...session,
        status: "canceled",
        terminalHeadSha: event.liveHeadSha,
        terminalAt: event.at,
        updatedAt: event.at
      }, {
        type: "session_canceled",
        at: event.at,
        headSha: event.liveHeadSha,
        message: event.type === "PR_CLOSED" ? "pull request closed" : "review label removed"
      });
      break;
    }
  }

  if (next === undefined) {
    return rejected(session, reason ?? `event ${event.type} is not legal from ${session.status}`);
  }

  return {
    accepted: true,
    session: ReviewSessionRecordSchema.parse(next)
  };
}

function rejected(session: ReviewSessionRecord, rejectionReason: string): ReviewCycleTransitionResult {
  return { accepted: false, session, rejectionReason };
}

function appendEvent(
  session: ReviewSessionRecord,
  event: Omit<ReviewTimelineEvent, "sequence" | "reviewOrdinal"> & {
    reviewOrdinal?: number;
  }
): ReviewSessionRecord {
  return {
    ...session,
    events: [...session.events, {
      ...event,
      sequence: (session.events.at(-1)?.sequence ?? -1) + 1,
      reviewOrdinal: event.reviewOrdinal ?? session.reviewOrdinal
    }]
  };
}

function failSession(
  session: ReviewSessionRecord,
  failure: ReviewSessionFailure,
  at: string,
  terminalHeadSha?: string
): ReviewSessionRecord {
  const handledHeadSha = terminalHeadSha ?? session.expectedHeadSha;
  return appendEvent({
    ...session,
    status: "failed",
    failure,
    terminalHeadSha: handledHeadSha,
    terminalAt: at,
    updatedAt: at
  }, {
    type: "session_failed",
    at,
    ...(failure.findingId === undefined ? {} : { findingId: failure.findingId }),
    ...(failure.taskId === undefined ? {} : { taskId: failure.taskId }),
    ...(failure.executionId === undefined ? {} : { executionId: failure.executionId }),
    headSha: handledHeadSha,
    message: failure.reason
  });
}

function currentFinding(session: ReviewSessionRecord): ReviewFindingState | undefined {
  return session.currentFindingIndex === undefined
    ? undefined
    : session.findings[session.currentFindingIndex];
}

function updateCurrentFinding(
  session: ReviewSessionRecord,
  patch: Partial<ReviewFindingState>
): ReviewFindingState[] {
  if (session.currentFindingIndex === undefined) return session.findings;
  return updateFinding(session.findings, session.currentFindingIndex, patch);
}

function updateFinding(
  findings: readonly ReviewFindingState[],
  index: number,
  patch: Partial<ReviewFindingState>
): ReviewFindingState[] {
  return findings.map((finding, findingIndex) =>
    findingIndex === index ? { ...finding, ...patch } : finding
  );
}

function samePaths(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (left === undefined || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function omitActiveReviewTask(session: ReviewSessionRecord): Omit<ReviewSessionRecord, "activeReviewTaskId"> {
  const { activeReviewTaskId: _activeReviewTaskId, ...rest } = session;
  return rest;
}

function omitActiveFixTask(session: ReviewSessionRecord): Omit<ReviewSessionRecord, "activeFixTaskId"> {
  const { activeFixTaskId: _activeFixTaskId, ...rest } = session;
  return rest;
}
