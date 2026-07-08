import * as assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultContextBuilder } from "../src/context/types.js";
import {
  PLAN_BREAKDOWN_JSON_EXAMPLE,
  PLAN_BREAKDOWN_JSON_EXAMPLE_OBJECT,
  validatePlanBreakdownResultForPrompt
} from "../src/workstreams/plan-breakdown-schema.js";
import type { PlanBreakdownResult } from "../src/state/types.js";

test("plan_breakdown context instruction includes sessionId contract", () => {
  const builder = new DefaultContextBuilder();
  const context = builder.build({
    taskKind: "plan_breakdown",
    repoIdentifier: "owner/repo",
    sourceKind: "issue",
    sourceUrl: "https://github.com/owner/repo/issues/1",
    labels: []
  });

  const instruction = context.instruction;
  assert.match(instruction, /You must use the Plan Breakdown Generator tool/);
  assert.match(instruction, /Start a new session, build candidate packet plans using patches, and validate them/);
  assert.match(instruction, /Plan breakdown is a one-time decomposition step/);
  assert.match(instruction, /Do not artificially cap packet count or wave count/);
  assert.match(instruction, /more than 10 packets/);
  assert.match(instruction, /cheap or weaker implementation agent/);
  assert.match(instruction, /Packet PRs are planning shells/);
  assert.match(instruction, /Detailed per-packet plan documents are written later by write_plan tasks/);
  assert.match(instruction, /Return exactly one JSON object: \{ "sessionId": "<selected generator session id>" \}/);
  assert.match(instruction, /If no valid session can be produced, publish details to GitHub/);
  assert.match(instruction, /After failure details are published, finish without returning a valid sessionId/);
  assert.match(instruction, /No valid sessionId means the orchestrator treats the plan_breakdown task as failed/);
  assert.match(instruction, /Do not return raw PlanBreakdownResult JSON directly/);
  assert.match(instruction, /Do not return Markdown as the primary result/);
  assert.match(instruction, /Do not wrap the JSON in a Markdown code fence/);
  assert.match(instruction, /Do not include prose before or after the JSON/);
  assert.match(instruction, /The orchestrator will export the selected session into the final PlanBreakdownResult artifact/);
  assert.doesNotMatch(instruction, /produce a Markdown breakdown recommendation/);
  assert.doesNotMatch(instruction, /Return exactly one JSON object matching PlanBreakdownResult/);
  assert.doesNotMatch(instruction, /"tasks": \[/);
  assert.doesNotMatch(instruction, /"waves": \[/);
});

test("PLAN_BREAKDOWN_JSON_EXAMPLE parses successfully and matches the example object", () => {
  const parsed = JSON.parse(PLAN_BREAKDOWN_JSON_EXAMPLE);
  assert.deepEqual(parsed, PLAN_BREAKDOWN_JSON_EXAMPLE_OBJECT);
});

test("validatePlanBreakdownResultForPrompt identifies common graph errors", () => {
  const valid: PlanBreakdownResult = PLAN_BREAKDOWN_JSON_EXAMPLE_OBJECT;
  assert.deepEqual(validatePlanBreakdownResultForPrompt(valid), []);

  const unknownTaskDep: PlanBreakdownResult = {
    ...valid,
    tasks: [{ ...valid.tasks[0]!, dependsOn: ["UNKNOWN"] }]
  };
  assert.ok(validatePlanBreakdownResultForPrompt(unknownTaskDep).some(e => e.includes("references unknown task ID in dependsOn: UNKNOWN")));

  const selfDep: PlanBreakdownResult = {
    ...valid,
    tasks: [{ ...valid.tasks[0]!, id: "T1", dependsOn: ["T1"] }]
  };
  assert.ok(validatePlanBreakdownResultForPrompt(selfDep).some(e => e.includes("has a self-reference in dependsOn")));

  const duplicateTaskId: PlanBreakdownResult = {
    ...valid,
    tasks: [
      { ...valid.tasks[0]!, id: "T1" },
      { ...valid.tasks[1]!, id: "T1" }
    ],
    waves: [{ id: "W1", taskIds: ["T1"], rationale: "r" }]
  };
  assert.ok(validatePlanBreakdownResultForPrompt(duplicateTaskId).some(e => e.includes("Duplicate task ID: T1")));

  const duplicateWaveId: PlanBreakdownResult = {
    ...valid,
    waves: [
      { id: "W1", taskIds: ["T1"], rationale: "r" },
      { id: "W1", taskIds: ["T2"], rationale: "r" }
    ]
  };
  assert.ok(validatePlanBreakdownResultForPrompt(duplicateWaveId).some(e => e.includes("Duplicate wave ID: W1")));

  const duplicateRef: PlanBreakdownResult = {
    ...valid,
    tasks: [{ ...valid.tasks[0]!, id: "T1", dependsOn: ["T2", "T2"] }],
    waves: [
      { id: "W1", taskIds: ["T2"], rationale: "r" },
      { id: "W2", taskIds: ["T1"], rationale: "r" }
    ]
  };
  assert.ok(validatePlanBreakdownResultForPrompt(duplicateRef).some(e => e.includes("Task T1 has duplicate reference in dependsOn: T2")));

  const missingFromWave: PlanBreakdownResult = {
    ...valid,
    waves: [{ ...valid.waves[0]!, taskIds: [] }]
  };
  assert.ok(validatePlanBreakdownResultForPrompt(missingFromWave).some(e => e.includes("is not assigned to any wave")));

  const duplicateInWaves: PlanBreakdownResult = {
    ...valid,
    waves: [
      { id: "W1", taskIds: ["T1"], rationale: "r" },
      { id: "W2", taskIds: ["T1"], rationale: "r" }
    ]
  };
  assert.ok(validatePlanBreakdownResultForPrompt(duplicateInWaves).some(e => e.includes("appears in multiple waves")));

  const forwardDep: PlanBreakdownResult = {
    ...valid,
    tasks: [
      { ...valid.tasks[0]!, id: "T1", dependsOn: ["T2"] },
      { ...valid.tasks[1]!, id: "T2", dependsOn: [] }
    ],
    waves: [
      { id: "W1", taskIds: ["T1"], rationale: "r" },
      { id: "W2", taskIds: ["T2"], rationale: "r" }
    ]
  };
  assert.ok(validatePlanBreakdownResultForPrompt(forwardDep).some(e => e.includes("depends on T2 in a later wave")));

  const sameWaveDep: PlanBreakdownResult = {
    ...valid,
    tasks: [
      { ...valid.tasks[0]!, id: "T1", dependsOn: ["T2"] },
      { ...valid.tasks[1]!, id: "T2", dependsOn: [] }
    ],
    waves: [
      { id: "W1", taskIds: ["T1", "T2"], rationale: "r" }
    ]
  };
  assert.ok(validatePlanBreakdownResultForPrompt(sameWaveDep).some(e => e.includes("depends on T2 in the same wave")));
});
