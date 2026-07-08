import * as assert from "node:assert/strict";
import { test } from "node:test";
import { roleForTask, selectAgentForTask } from "../src/agents/selection.js";
import type { AgentConfig } from "../src/config/types.js";
import { workflowRegistry, getWorkflowTaskDefinition } from "../src/workflows/registry.js";
import type { TaskKind, TaskRecord } from "../src/tasks/types.js";

const TASK_KINDS = [
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
] as const satisfies readonly TaskKind[];

type ActiveTaskKind = (typeof TASK_KINDS)[number];

test("workflow task registry preserves role mappings", () => {
  const expectedRoles = {
    product_discovery: "product",
    write_product_spec: "product",
    review_pr: "review",
    write_plan: "planning",
    implement_plan: "implementation",
    respond_issue_comment: "discussion",
    respond_pr_comment: "discussion",
    plan_breakdown: "implementation_manager",
    wave_plan_assessment: "planning",
    wave_plan_replanning: "implementation_manager",
    sync_parent_branch_preflight: "implementation_manager",
    sync_parent_branch: "implementation_manager",
    prepare_pr_for_merge: "implementation_manager",
    extract_retrospective_problems: "retrospective",
    investigate_learning_opportunity: "retrospective",
    draft_management_learning_proposal: "retrospective"
  } as const satisfies Record<ActiveTaskKind, ReturnType<typeof roleForTask>>;

  for (const kind of TASK_KINDS) {
    const task = baseTask(kind);

    assert.equal(workflowRegistry.getDefinition(kind).role, expectedRoles[kind]);
    assert.equal(roleForTask(task), expectedRoles[kind]);
  }
});

test("workflow task registry preserves model class mappings", () => {
  const expectedModelClasses = {
    product_discovery: "strong",
    write_product_spec: "strong",
    respond_issue_comment: "strong",
    review_pr: "strong",
    respond_pr_comment: "cheap",
    write_plan: "strong",
    implement_plan: "cheap",
    plan_breakdown: "strong",
    wave_plan_assessment: "strong",
    wave_plan_replanning: "strong",
    sync_parent_branch_preflight: "strong",
    sync_parent_branch: "strong",
    prepare_pr_for_merge: "strong",
    extract_retrospective_problems: "strong",
    investigate_learning_opportunity: "strong",
    draft_management_learning_proposal: "strong"
  } as const satisfies Record<ActiveTaskKind, AgentConfig["modelClass"]>;

  for (const kind of TASK_KINDS) {
    assert.equal(workflowRegistry.getDefinition(kind).modelClass, expectedModelClasses[kind]);
  }
});

test("workflow task registry preserves execution policy mappings", () => {
  const expectedPermissions = {
    product_discovery: "read-only",
    write_product_spec: "workspace-write",
    respond_issue_comment: "read-only",
    review_pr: "read-only",
    respond_pr_comment: "workspace-write",
    write_plan: "workspace-write",
    implement_plan: "workspace-write",
    plan_breakdown: "read-only",
    wave_plan_assessment: "read-only",
    wave_plan_replanning: "workspace-write",
    sync_parent_branch_preflight: "read-only",
    sync_parent_branch: "workspace-write",
    prepare_pr_for_merge: "workspace-write",
    extract_retrospective_problems: "read-only",
    investigate_learning_opportunity: "read-only",
    draft_management_learning_proposal: "read-only"
  } as const satisfies Record<ActiveTaskKind, ReturnType<typeof workflowRegistry.resolveTaskExecutionPolicy>["executionPermission"]>;

  for (const kind of TASK_KINDS) {
    assert.equal(workflowRegistry.getDefinition(kind).executionPermission, expectedPermissions[kind]);
    assert.equal(workflowRegistry.resolveTaskExecutionPolicy(kind).executionPermission, expectedPermissions[kind]);
  }
});

test("sync_parent_branch_preflight handoff policy is non-pushable", () => {
  const policy = workflowRegistry.resolveTaskExecutionPolicy("sync_parent_branch_preflight");
  assert.equal(policy.executionPermission, "read-only");
  assert.equal(policy.handoffPolicy.expectsPushableHandoff, false);
  assert.equal(policy.handoffPolicy.orchestratorOwnsPush, true);
});

test("sync_parent_branch handoff policy is pushable and orchestrator-owned", () => {
  const policy = workflowRegistry.resolveTaskExecutionPolicy("sync_parent_branch");
  assert.equal(policy.executionPermission, "workspace-write");
  assert.equal(policy.handoffPolicy.expectsPushableHandoff, true);
  assert.equal(policy.handoffPolicy.orchestratorOwnsPush, true);
});

test("selectAgentForTask selects an enabled matching agent", () => {
  const agents = [
    baseAgent({ id: "reviewer", roles: ["review"] }),
    baseAgent({ id: "planner", roles: ["planning"] })
  ];

  assert.equal(selectAgentForTask(baseTask("write_plan"), agents).id, "planner");
});

test("selectAgentForTask ignores disabled matching agents", () => {
  const agents = [
    baseAgent({ id: "disabled-reviewer", roles: ["review"], enabled: false }),
    baseAgent({ id: "enabled-reviewer", roles: ["review"], enabled: true })
  ];

  assert.equal(selectAgentForTask(baseTask("review_pr"), agents).id, "enabled-reviewer");
});

test("selectAgentForTask selects agent with required model class", () => {
  const agents = [
    baseAgent({ id: "cheap-reviewer", modelClass: "cheap", roles: ["review"] }),
    baseAgent({ id: "strong-reviewer", modelClass: "strong", roles: ["review"] }),
    baseAgent({ id: "cheap-implementer", modelClass: "cheap", roles: ["implementation"] }),
    baseAgent({ id: "strong-implementer", modelClass: "strong", roles: ["implementation"] })
  ];

  assert.equal(selectAgentForTask(baseTask("review_pr"), agents).id, "strong-reviewer");
  assert.equal(selectAgentForTask(baseTask("implement_plan"), agents).id, "cheap-implementer");
});

test("selectAgentForTask throws when only role matches but model class is wrong", () => {
  const agents = [baseAgent({ id: "strong-implementer", modelClass: "strong", roles: ["implementation"] })];

  assert.throws(() => selectAgentForTask(baseTask("implement_plan"), agents), {
    message: /No enabled agent configured for task .* with role "implementation" and modelClass "cheap"/
  });
});

test("selectAgentForTask selects random equivalent agent", () => {
  const agents = [
    baseAgent({ id: "first-discussion", roles: ["discussion"] }),
    baseAgent({ id: "middle-discussion", roles: ["discussion"] }),
    baseAgent({ id: "last-discussion", roles: ["discussion"] })
  ];

  const originalRandom = Math.random;
  try {
    // Random value near 0 picks the first eligible candidate
    Math.random = () => 0;
    assert.equal(selectAgentForTask(baseTask("respond_issue_comment"), agents).id, "first-discussion");

    // Random value in the middle
    Math.random = () => 0.5;
    assert.equal(selectAgentForTask(baseTask("respond_issue_comment"), agents).id, "middle-discussion");

    // Random value near 1 picks the last eligible candidate
    Math.random = () => 0.999999;
    assert.equal(selectAgentForTask(baseTask("respond_issue_comment"), agents).id, "last-discussion");
  } finally {
    Math.random = originalRandom;
  }
});

test("selectAgentForTask ignores ineligible agents when picking random index", () => {
  const agents = [
    baseAgent({ id: "wrong-role", roles: ["review"] }),
    baseAgent({ id: "eligible-1", roles: ["discussion"] }),
    baseAgent({ id: "disabled", roles: ["discussion"], enabled: false }),
    baseAgent({ id: "wrong-model", roles: ["discussion"], modelClass: "cheap" }),
    baseAgent({ id: "eligible-2", roles: ["discussion"] })
  ];

  const originalRandom = Math.random;
  try {
    // There are only 2 eligible agents. random() * 2 should pick between eligible-1 and eligible-2.
    Math.random = () => 0;
    assert.equal(selectAgentForTask(baseTask("respond_issue_comment"), agents).id, "eligible-1");

    Math.random = () => 0.99;
    assert.equal(selectAgentForTask(baseTask("respond_issue_comment"), agents).id, "eligible-2");
  } finally {
    Math.random = originalRandom;
  }
});

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent",
    provider: "codex",
    modelClass: "strong",
    roles: ["discussion"],
    command: "codex",
    enabled: true,
    ...overrides
  } as AgentConfig;
}

function baseTask(kind: TaskKind): TaskRecord {
  return {
    id: `task:${kind}`,
    kind,
    status: "pending",
    executionPermission: workflowRegistry.resolveTaskExecutionPolicy(kind).executionPermission,
    handoffPolicy: workflowRegistry.resolveTaskExecutionPolicy(kind).handoffPolicy,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    sourceKind: workflowRegistry.getDefinition(kind).sourceKinds[0]!,
    sourceId: "source-1",
    sourceUrl: "https://github.com/eladaviv/repo-one/issues/1",
    relevant: true,
    reason: "test",
    summary: "test task",
    context: {
      repoIdentifier: "eladaviv/repo-one",
      labels: [],
      instruction: "test"
    },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z"
  };
}
