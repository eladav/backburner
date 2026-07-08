import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractAndExportWaveAssessmentResult,
  extractAndExportPlanBreakdownResult,
  extractPlanBreakdownResult
} from "../src/agents/extraction.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { PlanBreakdownSessionStore } from "../src/workstreams/plan-breakdown-generator/store.js";
import type { PlanBreakdownSession } from "../src/workstreams/plan-breakdown-generator/types.js";
import type { WaveAssessmentSession } from "../src/workstreams/wave-assessment/session.js";
import { WaveAssessmentSessionStore } from "../src/workstreams/wave-assessment/store.js";

const baseTask = {
  kind: "plan_breakdown",
  id: "task:1",
  sourceId: "issue:owner/repo:1",
  workstreamId: "owner/repo:issue:1"
} as unknown as TaskRecord;

const baseWaveAssessmentTask = {
  kind: "wave_plan_assessment",
  id: "task:wave_plan_assessment:checkpoint-1",
  sourceId: "pull_request:owner/repo:1",
  workstreamId: "owner/repo:issue:1",
  context: {
    repoIdentifier: "owner/repo",
    labels: [],
    instruction: "Assess wave.",
    waveAssessmentCheckpoint: {
      id: "checkpoint-1",
      sessionId: "checkpoint-1",
      identity: {
        repoKey: "owner/repo",
        workstreamId: "owner/repo:issue:1",
        waveId: "wave-0",
        parentPrNumber: 1,
        parentHeadSha: "sha1",
        parentIntegrationBranch: "agent/owner-repo/issue-1",
        defaultBranch: "main",
        planRevision: "rev1",
        originalPlanningSessionId: "planner-1",
        currentWaveIndex: 0,
        nextWaveIndex: 1,
        completedPacketIds: ["T1"],
        pendingFuturePacketIds: ["T2"],
        planNodeIds: ["T1", "T2"]
      }
    }
  }
} as unknown as TaskRecord;

const validBreakdown = {
  title: "Test Plan",
  summary: "This is a test plan.",
  tasks: [
    {
      id: "T1",
      title: "Task 1",
      description: "Desc 1",
      dependsOn: [],
      blocks: [],
      canRunInParallelWith: [],
      risk: "low" as const,
      filesLikelyInvolved: [],
      acceptanceCriteria: [],
      verification: []
    }
  ],
  waves: [
    {
      id: "W1",
      taskIds: ["T1"],
      rationale: "Rationale 1"
    }
  ],
  recommendedFirstWaveId: "W1",
  graphConcerns: [],
  humanDecisionsNeeded: [],
  suggestedNextAction: "Next action"
};

test("extractAndExportPlanBreakdownResult returns ok:true and exported result for valid sessionId", async () => {
  const sessionId = "test-session-id";
  const store = new PlanBreakdownSessionStore();
  const session: PlanBreakdownSession = {
    id: sessionId,
    title: validBreakdown.title,
    summary: validBreakdown.summary,
    tasks: { T1: validBreakdown.tasks[0]! },
    waves: { W1: validBreakdown.waves[0]! },
    waveOrder: ["W1"],
    recommendedFirstWaveId: validBreakdown.recommendedFirstWaveId,
    graphConcerns: validBreakdown.graphConcerns,
    humanDecisionsNeeded: validBreakdown.humanDecisionsNeeded,
    suggestedNextAction: validBreakdown.suggestedNextAction,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validationIssues: []
  };
  await store.saveSession(session);

  const stdout = JSON.stringify({ sessionId });
  const result = extractAndExportPlanBreakdownResult(baseTask, stdout, store);

  assert.ok(result.ok);
  assert.strictEqual(result.sessionId, sessionId);
  assert.strictEqual(result.planBreakdown.title, validBreakdown.title);
  assert.strictEqual(result.planBreakdown.tasks[0]?.id, "T1");
});

test("extractAndExportPlanBreakdownResult trims padded sessionId before resolving the session store", async () => {
  const sessionId = "trimmed-session-id";
  const store = new PlanBreakdownSessionStore();
  const session: PlanBreakdownSession = {
    id: sessionId,
    title: validBreakdown.title,
    summary: validBreakdown.summary,
    tasks: { T1: validBreakdown.tasks[0]! },
    waves: { W1: validBreakdown.waves[0]! },
    waveOrder: ["W1"],
    recommendedFirstWaveId: validBreakdown.recommendedFirstWaveId,
    graphConcerns: validBreakdown.graphConcerns,
    humanDecisionsNeeded: validBreakdown.humanDecisionsNeeded,
    suggestedNextAction: validBreakdown.suggestedNextAction,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validationIssues: []
  };
  await store.saveSession(session);

  const stdout = JSON.stringify({ sessionId: `  ${sessionId}  ` });
  const result = extractAndExportPlanBreakdownResult(baseTask, stdout, store);

  assert.ok(result.ok);
  assert.strictEqual(result.sessionId, sessionId);
  assert.strictEqual(result.planBreakdown.title, validBreakdown.title);
});

test("extractAndExportPlanBreakdownResult rejects whitespace-only sessionId with the existing missing_session_id contract", () => {
  const stdout = JSON.stringify({ sessionId: "   " });
  const result = extractAndExportPlanBreakdownResult(baseTask, stdout);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "missing_session_id");
});

test("extractAndExportPlanBreakdownResult succeeds even if sourceId is malformed if workstreamId is present", async () => {
  const sessionId = "test-session-id";
  const store = new PlanBreakdownSessionStore();
  const session: PlanBreakdownSession = {
    id: sessionId,
    title: validBreakdown.title,
    summary: validBreakdown.summary,
    tasks: { T1: validBreakdown.tasks[0]! },
    waves: { W1: validBreakdown.waves[0]! },
    waveOrder: ["W1"],
    recommendedFirstWaveId: validBreakdown.recommendedFirstWaveId,
    graphConcerns: validBreakdown.graphConcerns,
    humanDecisionsNeeded: validBreakdown.humanDecisionsNeeded,
    suggestedNextAction: validBreakdown.suggestedNextAction,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validationIssues: []
  };
  await store.saveSession(session);

  const weirdTask = { ...baseTask, sourceId: "SOME_RANDOM_ID" };
  const stdout = JSON.stringify({ sessionId });
  const result = extractAndExportPlanBreakdownResult(weirdTask, stdout, store);

  assert.ok(result.ok);
  assert.strictEqual(result.sessionId, sessionId);
});

test("extractAndExportPlanBreakdownResult fails with missing_workstream_id if task.workstreamId is missing", async () => {
  const sessionId = "test-session-id";
  const store = new PlanBreakdownSessionStore();
  const session: PlanBreakdownSession = {
    id: sessionId,
    title: validBreakdown.title,
    summary: validBreakdown.summary,
    tasks: { T1: validBreakdown.tasks[0]! },
    waves: { W1: validBreakdown.waves[0]! },
    waveOrder: ["W1"],
    recommendedFirstWaveId: validBreakdown.recommendedFirstWaveId,
    graphConcerns: validBreakdown.graphConcerns,
    humanDecisionsNeeded: validBreakdown.humanDecisionsNeeded,
    suggestedNextAction: validBreakdown.suggestedNextAction,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validationIssues: []
  };
  await store.saveSession(session);

  const legacyTask = { ...baseTask, workstreamId: undefined };
  const stdout = JSON.stringify({ sessionId });
  const result = extractAndExportPlanBreakdownResult(legacyTask, stdout, store);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "missing_workstream_id");
});

test("extractAndExportPlanBreakdownResult fails if sessionId is missing", () => {
  const stdout = JSON.stringify({ other: "data" });
  const result = extractAndExportPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "missing_session_id");
});

test("extractAndExportPlanBreakdownResult fails if JSON is malformed", () => {
  const stdout = '{"sessionId": "partially", "extra": }';
  const result = extractAndExportPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "malformed_json");
});

test("extractAndExportPlanBreakdownResult fails if sessionId is unknown", () => {
  const store = new PlanBreakdownSessionStore();
  const stdout = JSON.stringify({ sessionId: "unknown" });
  const result = extractAndExportPlanBreakdownResult(baseTask, stdout, store);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "unknown_session_id");
});

test("extractAndExportPlanBreakdownResult fails if raw PlanBreakdownResult is provided instead of sessionId", () => {
  const stdout = JSON.stringify(validBreakdown);
  const result = extractAndExportPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "missing_session_id");
});

test("extractAndExportWaveAssessmentResult rejects sessions with stale planNodeIds", async () => {
  const store = new WaveAssessmentSessionStore();
  const session: WaveAssessmentSession = {
    sessionId: "checkpoint-1",
    workstreamId: "owner/repo:issue:1",
    waveId: "wave-0",
    parentPrNumber: 1,
    assessedParentHeadSha: "sha1",
    originalPlanningSessionId: "planner-1",
    currentPlanRevision: "rev1",
    planNodeIds: ["T1"],
    status: "completed",
    decision: "continue",
    summary: "Looks current.",
    findings: [],
    validationIssues: [],
    timestamps: {
      createdAt: "2026-04-18T09:00:00.000Z",
      updatedAt: "2026-04-18T09:05:00.000Z",
      finalizedAt: "2026-04-18T09:05:00.000Z"
    }
  };
  await store.saveSession(session);

  const result = extractAndExportWaveAssessmentResult(
    baseWaveAssessmentTask,
    JSON.stringify({ sessionId: session.sessionId }),
    store
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "checkpoint_mismatch");
  assert.match(result.message, /planNodeIds/);
});

test("extractAndExportPlanBreakdownResult fails if session export fails (e.g. invalid session)", async () => {
  const sessionId = "invalid-session";
  const store = new PlanBreakdownSessionStore();
  const session: PlanBreakdownSession = {
    id: sessionId,
    title: "", // Invalid: empty title
    summary: validBreakdown.summary,
    tasks: { T1: validBreakdown.tasks[0]! },
    waves: { W1: validBreakdown.waves[0]! },
    waveOrder: ["W1"],
    recommendedFirstWaveId: validBreakdown.recommendedFirstWaveId,
    graphConcerns: validBreakdown.graphConcerns,
    humanDecisionsNeeded: validBreakdown.humanDecisionsNeeded,
    suggestedNextAction: validBreakdown.suggestedNextAction,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validationIssues: []
  };
  await store.saveSession(session);

  const stdout = JSON.stringify({ sessionId });
  const result = extractAndExportPlanBreakdownResult(baseTask, stdout, store);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "export_failed");
  assert.match(result.message, /title/);
});

test("extractAndExportPlanBreakdownResult fails if session is invalid (catches export failure)", async () => {
  const sessionId = "cycle-session";
  const store = new PlanBreakdownSessionStore();
  const session: PlanBreakdownSession = {
    id: sessionId,
    title: validBreakdown.title,
    summary: validBreakdown.summary,
    tasks: {
      T1: { ...validBreakdown.tasks[0]!, id: "T1", dependsOn: ["T1"] } // Self-dependency
    },
    waves: { W1: validBreakdown.waves[0]! },
    waveOrder: ["W1"],
    recommendedFirstWaveId: validBreakdown.recommendedFirstWaveId,
    graphConcerns: validBreakdown.graphConcerns,
    humanDecisionsNeeded: validBreakdown.humanDecisionsNeeded,
    suggestedNextAction: validBreakdown.suggestedNextAction,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validationIssues: []
  };
  await store.saveSession(session);

  const stdout = JSON.stringify({ sessionId });
  const result = extractAndExportPlanBreakdownResult(baseTask, stdout, store);

  assert.strictEqual(result.ok, false);
  // It fails during export because validateSession catches the self-reference
  assert.strictEqual(result.reason, "export_failed");
  assert.match(result.message, /self-reference/);
});

test("extractPlanBreakdownResult returns undefined when no valid JSON is present", () => {
  const stdout = "Some plain text output.";
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult extracts from sessionId using provided store", async () => {
  const sessionId = "test-session-id";
  const store = new PlanBreakdownSessionStore();
  const session: PlanBreakdownSession = {
    id: sessionId,
    title: validBreakdown.title,
    summary: validBreakdown.summary,
    tasks: { T1: validBreakdown.tasks[0]! },
    waves: { W1: validBreakdown.waves[0]! },
    waveOrder: ["W1"],
    recommendedFirstWaveId: validBreakdown.recommendedFirstWaveId,
    graphConcerns: validBreakdown.graphConcerns,
    humanDecisionsNeeded: validBreakdown.humanDecisionsNeeded,
    suggestedNextAction: validBreakdown.suggestedNextAction,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validationIssues: []
  };
  await store.saveSession(session);

  const stdout = JSON.stringify({ sessionId });
  const result = extractPlanBreakdownResult(baseTask, stdout, store);

  assert.ok(result);
  assert.strictEqual(result.title, validBreakdown.title);
  assert.strictEqual(result.tasks[0]?.id, "T1");
});

test("extractPlanBreakdownResult trims padded sessionId before resolving the session store", async () => {
  const sessionId = "trimmed-session-id";
  const store = new PlanBreakdownSessionStore();
  const session: PlanBreakdownSession = {
    id: sessionId,
    title: validBreakdown.title,
    summary: validBreakdown.summary,
    tasks: { T1: validBreakdown.tasks[0]! },
    waves: { W1: validBreakdown.waves[0]! },
    waveOrder: ["W1"],
    recommendedFirstWaveId: validBreakdown.recommendedFirstWaveId,
    graphConcerns: validBreakdown.graphConcerns,
    humanDecisionsNeeded: validBreakdown.humanDecisionsNeeded,
    suggestedNextAction: validBreakdown.suggestedNextAction,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validationIssues: []
  };
  await store.saveSession(session);

  const stdout = `Preamble text.\n${JSON.stringify({ sessionId: `  ${sessionId}  ` })}\nEpilogue text.`;
  const result = extractPlanBreakdownResult(baseTask, stdout, store);

  assert.ok(result);
  assert.strictEqual(result.title, validBreakdown.title);
});

test("extractPlanBreakdownResult returns undefined if sessionId session not found", () => {
  const store = new PlanBreakdownSessionStore();
  const stdout = JSON.stringify({ sessionId: "unknown" });
  const result = extractPlanBreakdownResult(baseTask, stdout, store);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined if sessionId is present but no store is provided", () => {
  const stdout = JSON.stringify({ sessionId: "some-id" });
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult no longer extracts trailing raw JSON (use sessionId instead)", () => {
  const stdout = `Some explanatory text.\n\n${JSON.stringify(validBreakdown)}`;
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined for Markdown fallback (deprecated)", () => {
  const stdout = "## Breakdown recommendation\n\nThe plan content.";
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined for invalid JSON", () => {
  const stdout = '{"title": "Broken"';
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when required fields are missing", () => {
  const invalid = { ...validBreakdown } as any;
  delete invalid.title;
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when recommendedFirstWaveId is invalid", () => {
  const invalid = { ...validBreakdown, recommendedFirstWaveId: "W99" };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a nested task is missing a title", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      {
        id: "T1",
        // title missing
        description: "Desc 1",
        dependsOn: [],
        blocks: [],
        canRunInParallelWith: [],
        risk: "low",
        filesLikelyInvolved: [],
        acceptanceCriteria: [],
        verification: []
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a nested task has invalid risk", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      {
        ...validBreakdown.tasks[0],
        risk: "extreme" // invalid risk
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a nested wave is missing rationale", () => {
  const invalid = {
    ...validBreakdown,
    waves: [
      {
        id: "W1",
        taskIds: ["T1"]
        // rationale missing
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when there are duplicate task IDs", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      ...validBreakdown.tasks,
      { ...validBreakdown.tasks[0], id: "T1" } // Duplicate ID
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when there are duplicate wave IDs", () => {
  const invalid = {
    ...validBreakdown,
    waves: [
      ...validBreakdown.waves,
      { ...validBreakdown.waves[0], id: "W1" } // Duplicate ID
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a nested task is missing an id", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      {
        ...validBreakdown.tasks[0],
        id: undefined as any
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a nested task is missing a required array field", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      {
        ...validBreakdown.tasks[0],
        dependsOn: undefined as any
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a nested task has a non-string in a required array field", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      {
        ...validBreakdown.tasks[0],
        dependsOn: ["T0", 123] as any
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined if ANY task in the list is invalid", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      validBreakdown.tasks[0],
      { ...validBreakdown.tasks[0], id: "T2", title: "" } // Invalid second task
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when summary is empty", () => {
  const invalid = { ...validBreakdown, summary: "" };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a nested task description is empty", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      {
        ...validBreakdown.tasks[0],
        description: ""
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a nested wave rationale is empty", () => {
  const invalid = {
    ...validBreakdown,
    waves: [
      {
        ...validBreakdown.waves[0],
        rationale: ""
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a task references an unknown ID in dependsOn", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      {
        ...validBreakdown.tasks[0],
        dependsOn: ["T99"] // Unknown ID
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a task references an unknown ID in blocks", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      {
        ...validBreakdown.tasks[0],
        blocks: ["T99"] // Unknown ID
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined when a task references an unknown ID in canRunInParallelWith", () => {
  const invalid = {
    ...validBreakdown,
    tasks: [
      {
        ...validBreakdown.tasks[0],
        canRunInParallelWith: ["T99"] // Unknown ID
      }
    ]
  };
  const stdout = JSON.stringify(invalid);
  const result = extractPlanBreakdownResult(baseTask, stdout);
  assert.strictEqual(result, undefined);
});

test("extractPlanBreakdownResult returns undefined for non-plan_breakdown task", () => {
  const otherTask = { kind: "triage_issue", id: "task:2" } as TaskRecord;
  const stdout = JSON.stringify(validBreakdown);
  const result = extractPlanBreakdownResult(otherTask, stdout);
  assert.strictEqual(result, undefined);
});
