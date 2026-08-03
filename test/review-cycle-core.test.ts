import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_REVIEW_AUTOMATION_MAX_TURNS,
  MAX_REVIEW_AUTOMATION_TURNS,
  RepoConfigSchema
} from "../src/config/schemas.js";
import {
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_TEXT_LENGTH,
  parseFixResultV1,
  parseReviewResultV2,
  type ReviewResultV2
} from "../src/reviews/contracts.js";
import {
  createReviewSession,
  ReviewSessionStateFileSchema,
  type ReviewPublicationReceipt,
  type ReviewSessionRecord
} from "../src/reviews/session.js";
import { StateStore } from "../src/state/loader.js";
import { transitionReviewCycle } from "../src/workflows/review-cycle-machine/machine.js";
import {
  isReviewOutstandingForHead,
  remainingFixTurns
} from "../src/workflows/review-cycle-machine/selectors.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const NOW = "2026-08-03T10:00:00.000Z";

test("repo review automation defaults, accepts bounds, and rejects unsafe values", () => {
  const base = {
    id: "repo-1",
    owner: "example",
    name: "repo",
    defaultBranch: "main",
    localPath: "example/repo",
    enabled: true,
    labels: {
      agentInProgress: "in-progress",
      agentPlanApproved: "plan-approved",
      agentProductApproved: "product-approved",
      agentReview: "review"
    }
  };

  assert.equal(
    RepoConfigSchema.parse(base).reviewAutomation.maxTurns,
    DEFAULT_REVIEW_AUTOMATION_MAX_TURNS
  );
  assert.equal(
    RepoConfigSchema.parse({ ...base, reviewAutomation: { maxTurns: 0 } })
      .reviewAutomation.maxTurns,
    0
  );
  assert.equal(
    RepoConfigSchema.parse({
      ...base,
      reviewAutomation: { maxTurns: MAX_REVIEW_AUTOMATION_TURNS }
    }).defaultBranch,
    "main"
  );

  for (const maxTurns of [-1, 1.5, MAX_REVIEW_AUTOMATION_TURNS + 1]) {
    assert.equal(
      RepoConfigSchema.safeParse({ ...base, reviewAutomation: { maxTurns } }).success,
      false
    );
  }
});

test("review result v2 validates head, action invariants, paths, and dependency graph", () => {
  const valid = reviewResult("REQUEST_CHANGES", "F001");
  assert.equal(parseReviewResultV2(valid, { targetHeadSha: HEAD_A }).findings[0]?.id, "F001");

  assert.throws(
    () => parseReviewResultV2(valid, { targetHeadSha: "b".repeat(40) }),
    /does not match target/
  );
  assert.throws(
    () => parseReviewResultV2({ ...valid, action: "APPROVE" }, { targetHeadSha: HEAD_A }),
    /APPROVE must not contain actionable findings/
  );
  assert.throws(
    () => parseReviewResultV2({
      ...valid,
      findings: [{ ...valid.findings[0], path: "../secret", line: 1, side: "RIGHT" }]
    }, { targetHeadSha: HEAD_A }),
    /repository-relative POSIX path/
  );
  assert.throws(
    () => parseReviewResultV2({
      ...valid,
      findings: [
        { ...valid.findings[0], dependsOn: ["F002"] },
        { ...valid.findings[0], id: "F002", dependsOn: ["F001"] }
      ]
    }, { targetHeadSha: HEAD_A }),
    /dependency cycle/
  );
});

test("review result v2 canonicalizes a single verification instruction", () => {
  const result = reviewResult("REQUEST_CHANGES", "F001");
  const parsed = parseReviewResultV2({
    ...result,
    findings: [{ ...result.findings[0], verification: "Run the focused state test." }]
  }, { targetHeadSha: HEAD_A });

  assert.deepEqual(parsed.findings[0]?.verification, ["Run the focused state test."]);
});

test("fix result v1 validates finding identity and task-attributable changed paths", () => {
  const valid = {
    schemaVersion: 1,
    findingId: "F001",
    disposition: "fixed",
    summary: "Fixed persistence ordering.",
    filesChanged: ["src/reviews/session.ts"],
    checks: [{ command: "npm test", outcome: "passed", durationMs: 10 }],
    relatedFindingIds: ["F002"],
    notes: []
  };
  assert.equal(parseFixResultV1(valid, {
    findingId: "F001",
    knownFindingIds: ["F001", "F002"],
    actualChangedPaths: ["src/reviews/session.ts"]
  }).disposition, "fixed");

  assert.throws(
    () => parseFixResultV1(valid, {
      findingId: "F001",
      actualChangedPaths: ["src/reviews/contracts.ts"]
    }),
    /task-attributable diff/
  );
  assert.throws(
    () => parseFixResultV1({ ...valid, disposition: "already_covered" }, {
      findingId: "F001"
    }),
    /must not report changed files/
  );
});

test("successful fix results require bounded passing verification with no failures or timeouts", () => {
  const base = {
    schemaVersion: 1 as const,
    findingId: "F001",
    disposition: "fixed" as const,
    summary: "Fixed.",
    filesChanged: ["src/fix.ts"],
    checks: [{ command: "npm test", outcome: "passed" as const, durationMs: 10 }],
    relatedFindingIds: [],
    notes: []
  };
  assert.throws(() => parseFixResultV1({ ...base, checks: [] }, { findingId: "F001" }), /passed bounded verification/);
  for (const outcome of ["failed", "timed_out"] as const) {
    assert.throws(() => parseFixResultV1({
      ...base,
      checks: [{ command: "npm test", outcome, durationMs: 10 }]
    }, { findingId: "F001" }), /must not contain failed or timed-out checks|passed bounded verification/);
  }
  assert.equal(parseFixResultV1({
    ...base,
    disposition: "blocked",
    filesChanged: [],
    checks: [{ command: "npm test", outcome: "timed_out", durationMs: 1_000 }]
  }, { findingId: "F001" }).disposition, "blocked");
});

test("review contracts reject oversized finding sets and text", () => {
  const base = reviewResult("REQUEST_CHANGES", "F001");
  assert.throws(() => parseReviewResultV2({
    ...base,
    findings: Array.from({ length: MAX_REVIEW_FINDINGS + 1 }, (_, index) => ({
      ...base.findings[0]!,
      id: `F${index}`
    }))
  }, { targetHeadSha: HEAD_A }), /Too big|at most/i);
  assert.throws(() => parseReviewResultV2({
    ...base,
    summary: "x".repeat(MAX_REVIEW_TEXT_LENGTH + 1)
  }, { targetHeadSha: HEAD_A }), /Too big|at most/i);
});

test("review session state is versioned, round-trips, and rejects duplicate active PR sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "review-cycle-state-"));
  try {
    const store = new StateStore(tempDir);
    const initialState = await store.load();
    assert.deepEqual(initialState.reviewSessions, []);
    assert.equal(
      await readFile(path.join(tempDir, "review-sessions.json"), "utf8"),
      '{\n  "schemaVersion": 1,\n  "reviewSessions": []\n}\n'
    );

    const session = makeSession();
    await store.writeReviewSessionState([session]);
    assert.deepEqual((await store.load()).reviewSessions, [session]);

    const duplicate = { ...session, id: `${session.id}:duplicate` };
    assert.equal(ReviewSessionStateFileSchema.safeParse({
      schemaVersion: 1,
      reviewSessions: [session, duplicate]
    }).success, false);

    await writeFile(path.join(tempDir, "review-sessions.json"), JSON.stringify({
      schemaVersion: 1,
      reviewSessions: [{ id: "malformed-active-session" }]
    }), "utf8");
    await assert.rejects(() => store.loadReviewSessionState(), /review-sessions\.json\.reviewSessions\.0/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("maxTurns zero publishes one review and dispatches no fixes", () => {
  let session = makeSession(0);
  session = accepted(session, {
    type: "REVIEW_TASK_DISPATCHED",
    at: NOW,
    taskId: "review-1",
    targetHeadSha: HEAD_A
  });
  session = accepted(session, {
    type: "REVIEW_TASK_SUCCEEDED",
    at: NOW,
    taskId: "review-1",
    executionId: "execution-1",
    result: reviewResult("REQUEST_CHANGES", "F001")
  });
  session = accepted(session, {
    type: "REVIEW_PUBLISHED",
    at: NOW,
    liveHeadSha: HEAD_A,
    receipt: reviewReceipt(1, HEAD_A)
  });

  assert.equal(session.status, "max_turns");
  assert.equal(session.turnsCompleted, 0);
  assert.equal(remainingFixTurns(session), 0);
});

test("five successful fix batches permit a sixth verification review but no sixth fix batch", () => {
  let session = makeSession(5);

  for (let turn = 1; turn <= 5; turn += 1) {
    const reviewTaskId = `review-${turn}`;
    const findingId = `F${String(turn).padStart(3, "0")}`;
    session = accepted(session, {
      type: "REVIEW_TASK_DISPATCHED",
      at: NOW,
      taskId: reviewTaskId,
      targetHeadSha: HEAD_A
    });
    session = accepted(session, {
      type: "REVIEW_TASK_SUCCEEDED",
      at: NOW,
      taskId: reviewTaskId,
      executionId: `review-execution-${turn}`,
      result: reviewResult("REQUEST_CHANGES", findingId)
    });
    session = accepted(session, {
      type: "REVIEW_PUBLISHED",
      at: NOW,
      liveHeadSha: HEAD_A,
      receipt: reviewReceipt(turn, HEAD_A)
    });
    session = accepted(session, {
      type: "FIX_TASK_DISPATCHED",
      at: NOW,
      findingId,
      taskId: `fix-${turn}`,
      headBefore: HEAD_A
    });
    session = accepted(session, {
      type: "FIX_TASK_SUCCEEDED",
      at: NOW,
      taskId: `fix-${turn}`,
      executionId: `fix-execution-${turn}`,
      result: {
        schemaVersion: 1,
        findingId,
        disposition: "already_covered",
        summary: "An earlier change already covers this finding.",
        filesChanged: [],
        checks: [{ command: "npm test -- review cycle", outcome: "passed", durationMs: 10 }],
        relatedFindingIds: [],
        notes: []
      }
    });
    session = accepted(session, {
      type: "FIX_HANDOFF_NO_CHANGE",
      at: NOW,
      findingId,
      headSha: HEAD_A
    });
    session = accepted(session, {
      type: "FIX_PUBLISHED",
      at: NOW,
      findingId,
      receipt: fixReceipt(turn, findingId, HEAD_A)
    });
  }

  assert.equal(session.status, "review_pending");
  assert.equal(session.turnsCompleted, 5);
  assert.equal(session.reviewOrdinal, 6);
  assert.equal(session.turnHistory.length, 5);
  assert.equal(session.turnHistory[0]?.findings[0]?.result?.disposition, "already_covered");

  session = accepted(session, {
    type: "REVIEW_TASK_DISPATCHED",
    at: NOW,
    taskId: "review-6",
    targetHeadSha: HEAD_A
  });
  session = accepted(session, {
    type: "REVIEW_TASK_SUCCEEDED",
    at: NOW,
    taskId: "review-6",
    executionId: "review-execution-6",
    result: reviewResult("REQUEST_CHANGES", "F006")
  });
  session = accepted(session, {
    type: "REVIEW_PUBLISHED",
    at: NOW,
    liveHeadSha: HEAD_A,
    receipt: reviewReceipt(6, HEAD_A)
  });

  assert.equal(session.status, "max_turns");
  assert.equal(session.turnsCompleted, 5);
});

test("durable push intent survives stale observation without changing session or turn identity", () => {
  let session = makeSession();
  session = accepted(session, { type: "REVIEW_TASK_DISPATCHED", at: NOW, taskId: "review-1", targetHeadSha: HEAD_A });
  session = accepted(session, {
    type: "REVIEW_TASK_SUCCEEDED",
    at: NOW,
    taskId: "review-1",
    executionId: "review-execution-1",
    result: reviewResult("REQUEST_CHANGES", "F001")
  });
  session = accepted(session, { type: "REVIEW_PUBLISHED", at: NOW, liveHeadSha: HEAD_A, receipt: reviewReceipt(1, HEAD_A) });
  session = accepted(session, { type: "FIX_TASK_DISPATCHED", at: NOW, findingId: "F001", taskId: "fix-1", headBefore: HEAD_A });
  session = accepted(session, {
    type: "FIX_TASK_SUCCEEDED",
    at: NOW,
    taskId: "fix-1",
    executionId: "fix-execution-1",
    result: {
      schemaVersion: 1,
      findingId: "F001",
      disposition: "fixed",
      summary: "Fixed.",
      filesChanged: ["src/fix.ts"],
      checks: [{ command: "npm test", outcome: "passed", durationMs: 10 }],
      relatedFindingIds: [],
      notes: []
    }
  });
  const intent = {
    findingId: "F001",
    headBefore: HEAD_A,
    headAfter: HEAD_B,
    commitSha: HEAD_B,
    filesChanged: ["src/fix.ts"]
  };
  session = accepted(session, { type: "FIX_HANDOFF_PUSH_INTENT_RECORDED", at: NOW, ...intent });
  session = accepted(session, { type: "FIX_HANDOFF_PUSH_AWAITING_OBSERVATION", at: NOW, ...intent });

  assert.equal(session.status, "fix_handoff_pending");
  assert.equal(session.expectedHeadSha, HEAD_A);
  assert.equal(session.turnsCompleted, 0);
  assert.equal(session.reviewOrdinal, 1);
  assert.equal(session.findings[0]?.pushCompletedAt, NOW);

  session = accepted(session, { type: "FIX_HANDOFF_PUSHED", at: NOW, ...intent });
  assert.equal(session.status, "fix_publication_pending");
  assert.equal(session.expectedHeadSha, HEAD_B);
});

test("a blocked fix records the handled head and remains failed until explicit retry", () => {
  let session = makeSession();
  session = accepted(session, { type: "REVIEW_TASK_DISPATCHED", at: NOW, taskId: "review-1", targetHeadSha: HEAD_A });
  session = accepted(session, {
    type: "REVIEW_TASK_SUCCEEDED",
    at: NOW,
    taskId: "review-1",
    executionId: "review-execution-1",
    result: reviewResult("REQUEST_CHANGES", "F001")
  });
  session = accepted(session, { type: "REVIEW_PUBLISHED", at: NOW, liveHeadSha: HEAD_A, receipt: reviewReceipt(1, HEAD_A) });
  session = accepted(session, { type: "FIX_TASK_DISPATCHED", at: NOW, findingId: "F001", taskId: "fix-1", headBefore: HEAD_A });
  session = accepted(session, {
    type: "FIX_TASK_SUCCEEDED",
    at: NOW,
    taskId: "fix-1",
    executionId: "fix-execution-1",
    result: {
      schemaVersion: 1,
      findingId: "F001",
      disposition: "blocked",
      summary: "Cannot fix safely.",
      filesChanged: [],
      checks: [{ command: "npm test", outcome: "failed", durationMs: 10 }],
      relatedFindingIds: [],
      notes: []
    }
  });
  assert.equal(session.status, "failed");
  assert.equal(session.terminalHeadSha, HEAD_A);
});

test("illegal events do not mutate a session and terminal head is the freshness marker", () => {
  const session = makeSession();
  const result = transitionReviewCycle(session, {
    type: "FIX_TASK_DISPATCHED",
    at: NOW,
    findingId: "F001",
    taskId: "fix-1",
    headBefore: HEAD_A
  });
  assert.equal(result.accepted, false);
  assert.equal(result.session, session);

  const terminal = {
    ...session,
    status: "approved" as const,
    currentReview: reviewResult("APPROVE"),
    lastReviewedHeadSha: HEAD_A,
    terminalHeadSha: HEAD_A,
    terminalAt: NOW
  };
  assert.equal(isReviewOutstandingForHead([terminal], "repo-1", "pr-7", HEAD_A), false);
  assert.equal(
    isReviewOutstandingForHead([terminal], "repo-1", "pr-7", "b".repeat(40)),
    true
  );

  const superseded = transitionReviewCycle(session, {
    type: "UNEXPECTED_HEAD_OBSERVED",
    at: NOW,
    actualHeadSha: "b".repeat(40)
  });
  assert.equal(superseded.accepted, true);
  assert.equal(superseded.session.status, "superseded");
  assert.equal(superseded.session.terminalHeadSha, HEAD_A);
  assert.equal(superseded.session.events.at(-1)?.headSha, "b".repeat(40));
});

function makeSession(maxTurns = 5): ReviewSessionRecord {
  return createReviewSession({
    repoId: "repo-1",
    repoSlug: "example/repo",
    pullRequestId: "pr-7",
    pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/example/repo/pull/7",
    workstreamId: "workstream-1",
    trigger: "label",
    maxTurns,
    headSha: HEAD_A,
    ordinal: 1,
    now: NOW
  });
}

function reviewResult(
  action: ReviewResultV2["action"],
  findingId?: string
): ReviewResultV2 {
  const findings = findingId === undefined ? [] : [{
    id: findingId,
    title: "Persist before dispatch",
    category: "reliability" as const,
    severity: "blocking" as const,
    actionable: true,
    path: "src/reviews/session.ts",
    line: 10,
    side: "RIGHT" as const,
    evidence: "State is updated only in memory.",
    impact: "A restart can duplicate work.",
    instruction: "Persist before dispatch.",
    acceptanceCriteria: ["A restart cannot duplicate a child task."],
    verification: ["Run the focused review-cycle test with a bounded timeout."],
    dependsOn: [],
    overlapsWith: []
  }];
  return {
    schemaVersion: 2,
    action,
    reviewedHeadSha: HEAD_A,
    summary: action === "APPROVE" ? "Ready to merge." : "Changes are required.",
    findings
  };
}

function reviewReceipt(ordinal: number, headSha: string): ReviewPublicationReceipt {
  return {
    id: `review-receipt-${ordinal}`,
    kind: "review",
    reviewOrdinal: ordinal,
    headSha,
    githubId: `github-review-${ordinal}`,
    url: `https://github.com/example/repo/pull/7#pullrequestreview-${ordinal}`,
    marker: `review:${ordinal}`,
    publishedAt: NOW,
    githubObjectKind: "pull_request_review",
    ownedCommentIds: []
  };
}

function fixReceipt(
  turnNumber: number,
  findingId: string,
  headSha: string
): ReviewPublicationReceipt {
  return {
    id: `fix-receipt-${turnNumber}`,
    kind: "fix",
    reviewOrdinal: turnNumber,
    turnNumber,
    findingId,
    headSha,
    githubId: `github-comment-${turnNumber}`,
    url: `https://github.com/example/repo/pull/7#issuecomment-${turnNumber}`,
    marker: `fix:${turnNumber}:${findingId}`,
    publishedAt: NOW,
    githubObjectKind: "pull_request_comment",
    ownedCommentIds: [`github-comment-${turnNumber}`]
  };
}

function accepted(
  session: ReviewSessionRecord,
  event: Parameters<typeof transitionReviewCycle>[1]
): ReviewSessionRecord {
  const result = transitionReviewCycle(session, event);
  assert.equal(result.accepted, true, result.rejectionReason);
  return result.session;
}
