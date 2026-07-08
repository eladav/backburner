import * as assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowRegistry, getRequiredCapabilityNames } from "../src/workflows/registry.js";
import type { WorkflowTaskDefinition } from "../src/workflows/registry.js";
import type { TaskKind } from "../src/tasks/types.js";

const MINIMAL_DEF: WorkflowTaskDefinition = {
  kind: "triage_issue",
  role: "discussion",
  modelClass: "strong",
  executionPermission: "read-only",
  handoffPolicy: {
    expectsPushableHandoff: false,
    orchestratorOwnsPush: true,
    remotePublishOwner: "orchestrator"
  },
  sourceKinds: ["issue"]
};

const TASK_KINDS: TaskKind[] = [
  "product_discovery",
  "write_product_spec",
  "respond_issue_comment",
  "review_pr",
  "respond_pr_comment",
  "write_plan",
  "implement_plan",
  "plan_breakdown",
  "wave_plan_assessment",
  "wave_plan_replanning",
  "sync_parent_branch_preflight",
  "sync_parent_branch",
  "prepare_pr_for_merge",
  "extract_retrospective_problems",
  "investigate_learning_opportunity",
  "draft_management_learning_proposal"
];

test("getRequiredCapabilityNames returns empty array for all existing task kinds", () => {
  for (const kind of TASK_KINDS) {
    const names = getRequiredCapabilityNames(kind);
    assert.deepEqual(names, [], `Expected empty requiredCapabilityNames for kind ${kind}`);
  }
});

test("requiredCapabilityNames is preserved on the definition object in a custom registry", () => {
  const def: WorkflowTaskDefinition = {
    ...MINIMAL_DEF,
    requiredCapabilityNames: ["context7-docs", "github-issues"]
  };
  const registry = new WorkflowRegistry([def]);
  assert.deepEqual(registry.getDefinition("triage_issue").requiredCapabilityNames, ["context7-docs", "github-issues"]);
});

test("field is undefined on definition when absent in a custom registry", () => {
  const registry = new WorkflowRegistry([MINIMAL_DEF]);
  const definition = registry.getDefinition("triage_issue");
  assert.equal(definition.requiredCapabilityNames, undefined);
});

test("getDefinition still returns the full definition including requiredCapabilityNames", () => {
  const def: WorkflowTaskDefinition = {
    ...MINIMAL_DEF,
    requiredCapabilityNames: ["my-capability"]
  };
  const registry = new WorkflowRegistry([def]);
  const definition = registry.getDefinition("triage_issue");
  assert.deepEqual(definition.requiredCapabilityNames, ["my-capability"]);
});

test("existing behavior unchanged — getDefinition throws for unknown kind", () => {
  const registry = new WorkflowRegistry();
  assert.throws(
    () => registry.getDefinition("unknown_kind" as any),
    /No workflow task definition registered for task kind "unknown_kind"/
  );
});
