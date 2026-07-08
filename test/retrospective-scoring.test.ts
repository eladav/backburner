import * as assert from "node:assert/strict";
import { test } from "node:test";
import { scoreRetrospectiveProblem, scoreRetrospectiveProblems } from "../src/retrospectives/scoring.js";
import type { RetrospectiveProblemRecord, RetrospectiveBand } from "../src/retrospectives/types.js";
import type { ScopeValidationConfig } from "../src/retrospectives/scopes.js";
import { DefaultContextBuilder } from "../src/context/types.js";

const now = "2026-06-04T12:00:00Z";

const mockConfig: ScopeValidationConfig = {
  repoIds: ["repo1"],
  providers: ["codex"],
  roles: ["discussion"],
  taskKinds: ["triage_issue"],
};

function baseProblem(): RetrospectiveProblemRecord {
  return {
    id: "p1",
    candidateId: "c1",
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
    suggestedScopes: [{ kind: "global" }],
    detectedAt: now,
    updatedAt: now,
  };
}

test("scoreRetrospectiveProblem: passing case", () => {
  const result = scoreRetrospectiveProblem({
    problem: baseProblem(),
    scopeValidationConfig: mockConfig,
    now,
  });

  assert.equal(result.problem.thresholdDecision, "pass");
  assert.equal(result.problem.decisionReason, "All criteria passed");
  assert.equal(result.problem.thresholdCriteria?.length, 6);
  assert.ok(result.problem.thresholdCriteria?.every((c) => c.passed));
  assert.deepEqual(result.problem.selectedScope, { kind: "global" });
});

test("scoreRetrospectiveProblem: individual failures", () => {
  const fields: Array<keyof RetrospectiveProblemRecord> = [
    "impact",
    "transferability",
    "confidence",
    "improvementLikelihood",
    "overfittingRisk",
  ];

  for (const field of fields) {
    const problem = baseProblem();
    (problem as any)[field] = field === "overfittingRisk" ? "high" : "low";

    const result = scoreRetrospectiveProblem({
      problem,
      scopeValidationConfig: mockConfig,
      now,
    });

    assert.equal(result.problem.thresholdDecision, "fail", `Should fail for field ${field}`);
    assert.match(result.problem.decisionReason!, new RegExp(field));
  }
});

test("scoreRetrospectiveProblem: missing fields fail conservatively", () => {
  const fields: Array<keyof RetrospectiveProblemRecord> = [
    "impact",
    "transferability",
    "confidence",
    "improvementLikelihood",
    "overfittingRisk",
  ];

  for (const field of fields) {
    const problem = baseProblem();
    delete (problem as any)[field];

    const result = scoreRetrospectiveProblem({
      problem,
      scopeValidationConfig: mockConfig,
      now,
    });

    assert.equal(result.problem.thresholdDecision, "fail", `Should fail for missing field ${field}`);
    assert.match(result.problem.decisionReason!, new RegExp(field));
    assert.match(result.problem.decisionReason!, /missing/);
  }
});

test("scoreRetrospectiveProblem: no valid scope fails", () => {
  const problem = baseProblem();
  problem.suggestedScopes = [{ kind: "repo", repoId: "unknown" } as any];

  const result = scoreRetrospectiveProblem({
    problem,
    scopeValidationConfig: mockConfig,
    now,
  });

  assert.equal(result.problem.thresholdDecision, "fail");
  assert.match(result.problem.decisionReason!, /no suggested scope validated successfully/);
  assert.match(result.problem.decisionReason!, /Unknown repo ID/);
});

test("scoreRetrospectiveProblem: scope selection logic (narrowest first)", () => {
  const problem = baseProblem();
  problem.suggestedScopes = [
    { kind: "global" },
    { kind: "repo", repoId: "repo1" },
    { kind: "repo_task_kind", repoId: "repo1", taskKind: "triage_issue" },
  ];

  const result = scoreRetrospectiveProblem({
    problem,
    scopeValidationConfig: mockConfig,
    now,
  });

  assert.equal(result.problem.thresholdDecision, "pass");
  assert.deepEqual(result.problem.selectedScope, {
    kind: "repo_task_kind",
    repoId: "repo1",
    taskKind: "triage_issue",
  });
});

test("scoreRetrospectiveProblems: idempotence", () => {
  const problems = [baseProblem()];
  const scored = scoreRetrospectiveProblems(problems, mockConfig, now);

  assert.equal(scored[0]?.thresholdDecision, "pass");
  const firstUpdatedAt = scored[0]?.updatedAt;

  const rescored = scoreRetrospectiveProblems(scored, mockConfig, "2026-06-04T13:00:00Z");
  assert.equal(rescored[0]?.updatedAt, firstUpdatedAt, "Should not update updatedAt if nothing changed");
});

test("extraction instructions do not disclose threshold criteria", () => {
  const builder = new DefaultContextBuilder();
  const context = builder.build({
    taskKind: "extract_retrospective_problems",
    repoIdentifier: "repo1",
    sourceKind: "retrospective_candidate",
    sourceUrl: "https://github.com/repo1",
    labels: [],
  });

  const instruction = context.instruction;
  const forbidden = [
    "impact is high",
    "transferability is high",
    "improvement likelihood is high",
    "overfitting risk is low",
    "strict gate",
    "threshold gate",
    "all six",
  ];

  for (const term of forbidden) {
    assert.ok(!instruction.toLowerCase().includes(term.toLowerCase()), `Instruction should not contain forbidden term: "${term}"`);
  }

  // Ensure it DOES contain the field names
  const requiredFields = [
    '"impact":',
    '"transferability":',
    '"improvementLikelihood":',
    '"overfittingRisk":',
  ];

  for (const field of requiredFields) {
    assert.ok(instruction.includes(field), `Instruction should contain required field: ${field}`);
  }
});

test("scoreRetrospectiveProblem: malformed scopes fail", () => {
  const now = "2026-06-05T12:00:00Z";
  const problem: RetrospectiveProblemRecord = {
    id: "p1",
    candidateId: "c1",
    confidence: "high",
    impact: "high",
    transferability: "high",
    improvementLikelihood: "high",
    overfittingRisk: "low",
    suggestedScopes: [
      { kind: "repo", repoId: 123 } as any,
      { kind: "unknown" } as any,
      "not an object" as any
    ],
    detectedAt: now,
    evidenceReferences: [],
    affectedRepoIds: [],
    roles: [],
    taskKinds: [],
    providers: [],
    status: "pending",
  };

  const scopeValidationConfig: ScopeValidationConfig = {
    repoIds: ["repo1"],
    providers: ["codex"],
    roles: ["discussion"],
    taskKinds: ["triage_issue"],
  };

  const result = scoreRetrospectiveProblem({ problem, scopeValidationConfig, now });
  assert.equal(result.problem.thresholdDecision, "fail");

  const scopeCriterion = result.problem.thresholdCriteria!.find(c => c.criterion === "scope");
  assert.equal(scopeCriterion?.passed, false);
  assert.match(scopeCriterion?.reason!, /no suggested scope validated successfully/);
  assert.match(scopeCriterion?.reason!, /Unknown repo ID: "123"/);
  assert.match(scopeCriterion?.reason!, /Unknown scope kind: "unknown"/);
  assert.match(scopeCriterion?.reason!, /Scope input must be a plain object/);
});

test("scoreRetrospectiveProblem: normalization of semantic scopes", () => {
  const problem = baseProblem();
  problem.suggestedScopes = [{ kind: "workflow" }] as any;
  problem.affectedRepoIds = ["repo1"];
  problem.taskKinds = ["triage_issue"];

  const result = scoreRetrospectiveProblem({
    problem,
    scopeValidationConfig: mockConfig,
    now,
  });

  assert.equal(result.problem.thresholdDecision, "pass");
  assert.equal(result.problem.selectedScope?.kind, "repo_task_kind");
  assert.match(result.problem.scopeValidationReason!, /after normalizing semantic scopes/);
  assert.ok(result.problem.rawSuggestedScopes);
  assert.ok(result.problem.semanticSuggestedScopes);
});
