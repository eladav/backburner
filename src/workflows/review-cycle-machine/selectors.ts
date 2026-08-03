import type {
  ReviewFindingState,
  ReviewSessionRecord
} from "../../reviews/session.js";
import { isTerminalReviewSessionStatus } from "../../reviews/session.js";

export function remainingFixTurns(session: ReviewSessionRecord): number {
  return Math.max(0, session.maxTurns - session.turnsCompleted);
}

export function hasFixTurnBudget(session: ReviewSessionRecord): boolean {
  return remainingFixTurns(session) > 0;
}

export function selectNextReviewFinding(
  session: ReviewSessionRecord
): ReviewFindingState | undefined {
  const completed = new Set(
    session.findings
      .filter((finding) =>
        finding.status === "fixed" || finding.status === "already_covered"
      )
      .map((finding) => finding.finding.id)
  );
  const actionableFindingIds = new Set(
    session.findings.map((finding) => finding.finding.id)
  );

  return [...session.findings]
    .sort((left, right) => left.order - right.order)
    .find((finding) =>
      finding.status === "pending" &&
      finding.finding.dependsOn.every((dependencyId) =>
        !actionableFindingIds.has(dependencyId) || completed.has(dependencyId)
      )
    );
}

export function allReviewFindingsHandled(session: ReviewSessionRecord): boolean {
  return session.findings.length > 0 && session.findings.every((finding) =>
    finding.status === "fixed" || finding.status === "already_covered"
  );
}

export function selectActiveReviewSession(
  sessions: readonly ReviewSessionRecord[],
  repoId: string,
  pullRequestId: string
): ReviewSessionRecord | undefined {
  return sessions.find((session) =>
    session.repoId === repoId &&
    session.pullRequestId === pullRequestId &&
    !isTerminalReviewSessionStatus(session.status)
  );
}

export function isReviewOutstandingForHead(
  sessions: readonly ReviewSessionRecord[],
  repoId: string,
  pullRequestId: string,
  headSha: string
): boolean {
  const sessionsForPullRequest = sessions.filter((session) =>
    session.repoId === repoId && session.pullRequestId === pullRequestId
  );
  const active = sessionsForPullRequest.find(
    (session) => !isTerminalReviewSessionStatus(session.status)
  );
  if (active !== undefined) {
    return true;
  }

  return !sessionsForPullRequest.some((session) =>
    ["approved", "no_actionable", "max_turns"].includes(session.status) &&
    session.terminalHeadSha === headSha
  );
}

export function canContinueReviewSession(session: ReviewSessionRecord, targetUrl: string): boolean {
  return session.status === "max_turns" && session.terminalComment?.url === targetUrl;
}

export function canRetryReviewSession(session: ReviewSessionRecord, targetUrl: string): boolean {
  return session.status === "failed" && session.terminalComment?.url === targetUrl;
}
