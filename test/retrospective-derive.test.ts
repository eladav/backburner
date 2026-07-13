import * as assert from "node:assert/strict";
import { test } from "node:test";
import { deriveRetrospectiveTasks } from "../src/retrospectives/derive.js";
import { DefaultContextBuilder } from "../src/context/types.js";
import type { AgentConfig } from "../src/config/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type {
  RetrospectiveCandidateRecord,
  RetrospectiveProblemRecord,
  LearningOpportunityRecord,
  LearningProposalRecord,
} from "../src/retrospectives/types.js";

const now = "2026-06-04T12:00:00Z";
const contextBuilder = new DefaultContextBuilder();

const strongRetroAgent: AgentConfig = {
  id: "strong-retro",
  provider: "codex",
  modelClass: "strong",
  roles: ["retrospective"],
  command: "codex",
  enabled: true,
};

test("deriveRetrospectiveTasks does not derive tasks when operational tasks are pending", () => {
  const existingTasks: TaskRecord[] = [
    {
      id: "task:1",
      kind: "write_plan",
      status: "pending",
      relevant: true,
      // ... minimal fields
    } as any,
  ];

  const result = deriveRetrospectiveTasks({
    existingTasks,
    candidates: [baseCandidate("c1")],
    problems: [],
    opportunities: [],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });

  assert.equal(result.tasks.length, 0);
});

test("deriveRetrospectiveTasks does not derive tasks when retrospective task is in flight", () => {
  const existingTasks: TaskRecord[] = [
    {
      id: "extract_retrospective_problems:c1",
      kind: "extract_retrospective_problems",
      status: "dispatched",
      relevant: true,
    } as any,
  ];

  const result = deriveRetrospectiveTasks({
    existingTasks,
    candidates: [baseCandidate("c1")],
    problems: [],
    opportunities: [],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });

  assert.equal(result.tasks.length, 0);
});

test("deriveRetrospectiveTasks blocks candidate when no retrospective agent is configured", () => {
  const result = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates: [baseCandidate("c1")],
    problems: [],
    opportunities: [],
    proposals: [],
    agents: [], // No agents
    contextBuilder,
    now,
  });

  assert.equal(result.tasks.length, 0);
  assert.equal(result.candidates[0]!.status, "blocked");
  assert.match(result.candidates[0]!.skipReason!, /No enabled strong agent/);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0]!.reason, /No enabled strong agent/);
});

test("deriveRetrospectiveTasks blocks problem and opportunity when no retrospective agent is configured", () => {
  const result = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates: [],
    problems: [baseProblem("p1", "c1")],
    opportunities: [baseOpportunity("o1", "p1")],
    proposals: [],
    agents: [], // No agents
    contextBuilder,
    now,
  });

  assert.equal(result.tasks.length, 0);
  assert.equal(result.problems[0]!.status, "blocked");
  assert.match(result.problems[0]!.decisionReason!, /No enabled strong agent/);
  assert.equal(result.opportunities[0]!.status, "blocked");
  assert.match(result.opportunities[0]!.decisionReason!, /No enabled strong agent/);
});

test("deriveRetrospectiveTasks does not derive investigation for problem without 'pass' threshold decision", () => {
  const problem = baseProblem("p1", "c1");
  delete (problem as any).thresholdDecision;

  const result = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates: [],
    problems: [problem],
    opportunities: [],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });

  assert.equal(result.tasks.length, 0, "Should not derive task for problem without 'pass' decision");
});

test("deriveRetrospectiveTasks derives extraction from oldest candidate", () => {
  const candidates = [
    baseCandidate("c1", "2026-06-04T10:00:00Z"),
    baseCandidate("c2", "2026-06-04T09:00:00Z"),
  ];

  const result = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates,
    problems: [],
    opportunities: [],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]!.kind, "extract_retrospective_problems");
  assert.equal(result.tasks[0]!.sourceId, "c2");
  assert.equal(result.tasks[0]!.context.retrospectiveCandidate?.id, "c2");
  assert.equal(result.candidates.find(c => c.id === "c2")?.status, "extracting");
});

test("deriveRetrospectiveTasks derives investigation from threshold-passing problem", () => {
  const problems = [
    baseProblem("p1", "c1", "pass"),
  ];

  const result = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates: [],
    problems,
    opportunities: [],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]!.kind, "investigate_learning_opportunity");
  assert.equal(result.tasks[0]!.sourceId, "p1");
  assert.equal(result.tasks[0]!.context.retrospectiveProblem?.id, "p1");
  assert.equal(result.problems[0]!.status, "investigating");
});

test("deriveRetrospectiveTasks derives proposal from investigated opportunity", () => {
  const opportunities = [
    baseOpportunity("o1", "p1"),
  ];

  const result = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates: [],
    problems: [],
    opportunities,
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]!.kind, "draft_management_learning_proposal");
  assert.equal(result.tasks[0]!.sourceId, "o1");
  assert.equal(result.tasks[0]!.context.learningOpportunity?.id, "o1");
});

test("deriveRetrospectiveTasks prioritizes extraction over investigation", () => {
  const candidates = [baseCandidate("c1")];
  const problems = [baseProblem("p1", "c0", "pass")];

  const result = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates,
    problems,
    opportunities: [],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]!.kind, "extract_retrospective_problems");
});

test("deriveRetrospectiveTasks correctly propagates repoId and repoSlug from candidate to tasks", () => {
  const candidate = baseCandidate("c-retro");
  candidate.repoId = "configured-id";
  candidate.repoSlug = "owner/real-slug";

  const problem = baseProblem("p-retro", "c-retro", "pass");
  problem.affectedRepoIds = ["configured-id"];

  const opportunity = baseOpportunity("o-retro", "p-retro");

  // Test extraction task
  const result1 = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates: [candidate],
    problems: [],
    opportunities: [],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });
  assert.equal(result1.tasks[0]!.repoId, "configured-id");
  assert.equal(result1.tasks[0]!.repoSlug, "owner/real-slug");

  // Test investigation task
  candidate.status = "extracted";
  const result2 = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates: [candidate],
    problems: [problem],
    opportunities: [],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });
  assert.equal(result2.tasks[0]!.repoId, "configured-id");
  assert.equal(result2.tasks[0]!.repoSlug, "owner/real-slug");

  // Test proposal task
  problem.status = "completed";
  const result3 = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates: [candidate],
    problems: [problem],
    opportunities: [opportunity],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });
  assert.equal(result3.tasks[0]!.repoId, "configured-id");
  assert.equal(result3.tasks[0]!.repoSlug, "owner/real-slug");
});

function baseCandidate(id: string, detectedAt = now): RetrospectiveCandidateRecord {
  return {
    id,
    sourceWorkstreamId: "ws1",
    repoId: "repo1",
    repoSlug: "owner/repo1",
    origin: { type: "issue", number: 1 },
    terminalResolution: "merged",
    detectedAt,
    resolvedAt: detectedAt,
    status: "new",
    labels: [],
    sourceSummary: "summary",
    taskSummary: { total: 1, completed: 1, failed: 0, kinds: [], taskIds: [] },
    executionSummary: { total: 1, providers: [], models: [], roles: [], executionIds: [] },
    artifactReferences: [],
    evidenceReferences: [],
  };
}

function baseProblem(id: string, candidateId: string, thresholdDecision: "pass" | "fail" = "pass"): RetrospectiveProblemRecord {
  return {
    id,
    candidateId,
    status: "pending",
    evidenceReferences: [],
    affectedRepoIds: ["repo1"],
    roles: ["discussion"],
    taskKinds: ["triage_issue"],
    providers: ["codex"],
    confidence: "high",
    impact: "high",
    transferability: "high",
    improvementLikelihood: "high",
    overfittingRisk: "low",
    suggestedScopes: [],
    thresholdDecision,
    detectedAt: now,
    updatedAt: now,
  };
}

function baseOpportunity(id: string, problemId: string): LearningOpportunityRecord {
  return {
    id,
    problemId,
    status: "investigated",
    evidenceReferences: [],
    detectedAt: now,
    updatedAt: now,
  };
}
