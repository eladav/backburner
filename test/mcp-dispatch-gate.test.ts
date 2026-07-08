import * as assert from "node:assert/strict";
import { test } from "node:test";
import { workflowRegistry } from "../src/workflows/registry.js";
import { evaluateMcpDispatchGate } from "../src/workstreams/mcp-blockers.js";
import type {
  WorkstreamRecord,
  McpStatusRecord,
  WorktreeRecord,
  WorkstreamMcpScopedExclusion
} from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { CapabilityValidationResult } from "../src/capabilities/types.js";

const mockWorkstream = {
  id: "ws-1",
  owner: "eladav",
  repo: "agents-over-github",
  issueNumber: 310,
  phase: "implementing",
  status: "open",
  mcpBlockers: [],
  mcpSkipExclusions: []
} as any as WorkstreamRecord;

const createTask = (id: string, kind: TaskRecord["kind"]): TaskRecord => ({
  id,
  workstreamId: "ws-1",
  repoId: "repo-1",
  repoSlug: "eladav/agents-over-github",
  sourceKind: "issue",
  sourceId: "issue-1",
  kind,
  status: "pending",
  relevant: true,
  createdAt: "2026-06-30T10:00:00Z",
  updatedAt: "2026-06-30T10:00:00Z",
  context: {
    recoveryNeeded: false,
    localRepoPath: "/path/to/repo",
    branchName: "feature-branch"
  }
} as any as TaskRecord);

const mockWorktree = {
  id: "wt-1",
  repoId: "repo-1",
  path: "/path/to/repo",
  branchName: "feature-branch",
  status: "implementing",
  packet: {
    parentWorkstreamId: "ws-1",
    packetId: "packet-1",
    waveIndex: 1,
    parentIntegrationBranch: "main"
  }
} as any as WorktreeRecord;

const mockMcpStatus: McpStatusRecord = {
  handle: "context7",
  providerId: "smithery",
  providerMcpId: "context7",
  status: "action_required",
  lastCheckedAt: "2026-06-30T10:00:00Z",
  actionRequired: {
    reason: "Auth required"
  }
};

test("evaluateMcpDispatchGate: ready capability does not block task", (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => {
    return {
      kind,
      role: "implementation",
      modelClass: "strong",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      sourceKinds: ["pull_request"],
      requiredCapabilityNames: ["context7-docs"]
    };
  });

  const task = createTask("task-1", "implement_plan");
  const validation = {
    valid: [{ name: "context7-docs", kind: "sensor", uses: "context7", mcpStatus: "ready" }],
    blocked: []
  } as any as CapabilityValidationResult;

  const result = evaluateMcpDispatchGate({
    tasks: [task],
    worktrees: [mockWorktree],
    workstreams: [mockWorkstream],
    capabilityValidation: validation,
    mcpStatuses: [{ ...mockMcpStatus, status: "ready" }],
    now: "2026-06-30T11:00:00Z"
  });

  assert.deepEqual(result.tasksToDispatch, [task]);
  assert.equal(result.blockedTaskIds.size, 0);
  assert.equal(result.workstreams[0]?.mcpBlockers?.length, 0);
});

test("evaluateMcpDispatchGate: required capability blocked by mcp_action_required blocks task", (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => {
    return {
      kind,
      role: "implementation",
      modelClass: "strong",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      sourceKinds: ["pull_request"],
      requiredCapabilityNames: ["context7-docs"]
    };
  });

  const task = createTask("task-1", "implement_plan");
  const validation = {
    valid: [],
    blocked: [{
      name: "context7-docs",
      kind: "sensor",
      uses: "context7",
      reason: "mcp_action_required",
      message: "Auth required"
    }]
  } as any as CapabilityValidationResult;

  const result = evaluateMcpDispatchGate({
    tasks: [task],
    worktrees: [mockWorktree],
    workstreams: [mockWorkstream],
    capabilityValidation: validation,
    mcpStatuses: [mockMcpStatus],
    now: "2026-06-30T11:00:00Z"
  });

  assert.deepEqual(result.tasksToDispatch, []);
  assert.ok(result.blockedTaskIds.has("task-1"));
  assert.equal(result.workstreams[0]?.mcpBlockers?.length, 1);
  const blocker = result.workstreams[0]?.mcpBlockers?.[0]!;
  assert.equal(blocker.id, "mcp-blocker:ws-1:context7:task-1");
  assert.equal(blocker.resolutionState, "waiting_for_user");
  assert.equal(blocker.packetId, "packet-1");
});

test("evaluateMcpDispatchGate: capability blocked but NOT required does not block task", (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => {
    return {
      kind,
      role: "implementation",
      modelClass: "strong",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      sourceKinds: ["pull_request"],
      requiredCapabilityNames: [] // Not required!
    };
  });

  const task = createTask("task-1", "implement_plan");
  const validation = {
    valid: [],
    blocked: [{
      name: "context7-docs",
      kind: "sensor",
      uses: "context7",
      reason: "mcp_action_required",
      message: "Auth required"
    }]
  } as any as CapabilityValidationResult;

  const result = evaluateMcpDispatchGate({
    tasks: [task],
    worktrees: [mockWorktree],
    workstreams: [mockWorkstream],
    capabilityValidation: validation,
    mcpStatuses: [mockMcpStatus],
    now: "2026-06-30T11:00:00Z"
  });

  assert.deepEqual(result.tasksToDispatch, [task]);
  assert.equal(result.blockedTaskIds.size, 0);
  assert.equal(result.workstreams[0]?.mcpBlockers?.length, 0);
});

test("evaluateMcpDispatchGate: running gate twice does not duplicate blockers", (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => {
    return {
      kind,
      role: "implementation",
      modelClass: "strong",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      sourceKinds: ["pull_request"],
      requiredCapabilityNames: ["context7-docs"]
    };
  });

  const task = createTask("task-1", "implement_plan");
  const validation = {
    valid: [],
    blocked: [{
      name: "context7-docs",
      kind: "sensor",
      uses: "context7",
      reason: "mcp_action_required",
      message: "Auth required"
    }]
  } as any as CapabilityValidationResult;

  const result1 = evaluateMcpDispatchGate({
    tasks: [task],
    worktrees: [mockWorktree],
    workstreams: [mockWorkstream],
    capabilityValidation: validation,
    mcpStatuses: [mockMcpStatus],
    now: "2026-06-30T11:00:00Z"
  });

  assert.equal(result1.workstreams[0]?.mcpBlockers?.length, 1);
  const blocker1 = result1.workstreams[0]?.mcpBlockers?.[0]!;
  assert.equal(blocker1.surfacedAt, undefined);

  const result2 = evaluateMcpDispatchGate({
    tasks: [task],
    worktrees: [mockWorktree],
    workstreams: result1.workstreams,
    capabilityValidation: validation,
    mcpStatuses: [mockMcpStatus],
    now: "2026-06-30T12:00:00Z"
  });

  assert.equal(result2.workstreams[0]?.mcpBlockers?.length, 1);
  const blocker2 = result2.workstreams[0]?.mcpBlockers?.[0]!;
  assert.equal(blocker2.createdAt, blocker1.createdAt);
  assert.equal(blocker2.surfacedAt, undefined);
});

test("evaluateMcpDispatchGate: status flips to ready clears blocker and dispatches task", (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => {
    return {
      kind,
      role: "implementation",
      modelClass: "strong",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      sourceKinds: ["pull_request"],
      requiredCapabilityNames: ["context7-docs"]
    };
  });

  const task = createTask("task-1", "implement_plan");
  const validation = {
    valid: [],
    blocked: [{
      name: "context7-docs",
      kind: "sensor",
      uses: "context7",
      reason: "mcp_action_required",
      message: "Auth required"
    }]
  } as any as CapabilityValidationResult;

  // 1. First run blocks the task
  const result1 = evaluateMcpDispatchGate({
    tasks: [task],
    worktrees: [mockWorktree],
    workstreams: [mockWorkstream],
    capabilityValidation: validation,
    mcpStatuses: [mockMcpStatus],
    now: "2026-06-30T11:00:00Z"
  });
  assert.deepEqual(result1.tasksToDispatch, []);
  assert.equal(result1.workstreams[0]?.mcpBlockers?.length, 1);

  const validation2 = {
    valid: [{ name: "context7-docs", kind: "sensor", uses: "context7", mcpStatus: "ready" }],
    blocked: []
  } as any as CapabilityValidationResult;

  // 2. Second run with ready status clears blocker and dispatches task
  const result2 = evaluateMcpDispatchGate({
    tasks: [task],
    worktrees: [mockWorktree],
    workstreams: result1.workstreams,
    capabilityValidation: validation2,
    mcpStatuses: [{ ...mockMcpStatus, status: "ready" }],
    now: "2026-06-30T12:00:00Z"
  });

  assert.deepEqual(result2.tasksToDispatch, [task]);
  assert.equal(result2.workstreams[0]?.mcpBlockers?.length, 0);
});

test("evaluateMcpDispatchGate: matching skip exclusion unblocks the scoped task", (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => {
    return {
      kind,
      role: "implementation",
      modelClass: "strong",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      sourceKinds: ["pull_request"],
      requiredCapabilityNames: ["context7-docs"]
    };
  });

  const task = createTask("task-1", "implement_plan");
  const validation = {
    valid: [],
    blocked: [{
      name: "context7-docs",
      kind: "sensor",
      uses: "context7",
      reason: "mcp_action_required",
      message: "Auth required"
    }]
  } as any as CapabilityValidationResult;

  // Pre-seed a skip exclusion
  const wsWithExclusion: WorkstreamRecord = {
    ...mockWorkstream,
    mcpSkipExclusions: [{
      id: "mcp-exclusion:ws-1:context7:task-1",
      taskId: "task-1",
      taskKind: "implement_plan",
      mcpHandle: "context7",
      affectedCapabilityNames: ["context7-docs"],
      createdAt: "2026-06-30T11:00:00Z"
    }]
  };

  const result = evaluateMcpDispatchGate({
    tasks: [task],
    worktrees: [mockWorktree],
    workstreams: [wsWithExclusion],
    capabilityValidation: validation,
    mcpStatuses: [mockMcpStatus],
    now: "2026-06-30T12:00:00Z"
  });

  assert.deepEqual(result.tasksToDispatch, [task]);
  assert.equal(result.blockedTaskIds.has("task-1"), false);
  assert.equal(result.workstreams[0]?.mcpBlockers?.length, 0);
});

test("evaluateMcpDispatchGate: packet task blocker does not block unrelated task", (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => {
    if (kind === "implement_plan") {
      return {
        kind,
        role: "implementation",
        modelClass: "strong",
        executionPermission: "workspace-write",
        handoffPolicy: {
          expectsPushableHandoff: true,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        sourceKinds: ["pull_request"],
        requiredCapabilityNames: ["context7-docs"]
      };
    } else {
      return {
        kind,
        role: "discussion",
        modelClass: "strong",
        executionPermission: "read-only",
        handoffPolicy: {
          expectsPushableHandoff: false,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        sourceKinds: ["comment"],
        requiredCapabilityNames: [] // Unrelated, no capabilities required
      };
    }
  });

  const task1 = createTask("task-1", "implement_plan");
  const task2 = createTask("task-2", "respond_pr_comment");

  const validation = {
    valid: [],
    blocked: [{
      name: "context7-docs",
      kind: "sensor",
      uses: "context7",
      reason: "mcp_action_required",
      message: "Auth required"
    }]
  } as any as CapabilityValidationResult;

  const result = evaluateMcpDispatchGate({
    tasks: [task1, task2],
    worktrees: [mockWorktree],
    workstreams: [mockWorkstream],
    capabilityValidation: validation,
    mcpStatuses: [mockMcpStatus],
    now: "2026-06-30T11:00:00Z"
  });

  assert.deepEqual(result.tasksToDispatch, [task2]);
  assert.ok(result.blockedTaskIds.has("task-1"));
  assert.ok(!result.blockedTaskIds.has("task-2"));
});

test("evaluateMcpDispatchGate: multiple tasks blocked on same handle get separate blockers", (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => {
    return {
      kind,
      role: "implementation",
      modelClass: "strong",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      sourceKinds: ["pull_request"],
      requiredCapabilityNames: ["context7-docs"]
    };
  });

  const task1 = createTask("task-1", "implement_plan");
  const task2 = {
    ...createTask("task-2", "implement_plan"),
    context: {
      localRepoPath: "/path/to/repo2",
      branchName: "branch2"
    }
  } as any as TaskRecord;

  const worktree2 = {
    id: "wt-2",
    repoId: "repo-1",
    path: "/path/to/repo2",
    branchName: "branch2",
    status: "implementing",
    packet: {
      parentWorkstreamId: "ws-1",
      packetId: "packet-2",
      waveIndex: 1,
      parentIntegrationBranch: "main"
    }
  } as any as WorktreeRecord;

  const validation = {
    valid: [],
    blocked: [{
      name: "context7-docs",
      kind: "sensor",
      uses: "context7",
      reason: "mcp_action_required",
      message: "Auth required"
    }]
  } as any as CapabilityValidationResult;

  const result = evaluateMcpDispatchGate({
    tasks: [task1, task2],
    worktrees: [mockWorktree, worktree2],
    workstreams: [mockWorkstream],
    capabilityValidation: validation,
    mcpStatuses: [mockMcpStatus],
    now: "2026-06-30T11:00:00Z"
  });

  assert.deepEqual(result.tasksToDispatch, []);
  assert.equal(result.workstreams[0]?.mcpBlockers?.length, 2);
  const ids = result.workstreams[0]?.mcpBlockers?.map(b => b.id);
  assert.ok(ids?.includes("mcp-blocker:ws-1:context7:task-1"));
  assert.ok(ids?.includes("mcp-blocker:ws-1:context7:task-2"));
});

test("evaluateMcpDispatchGate: concurrent dispatch order preserved", (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => {
    if (kind === "implement_plan") {
      return {
        kind,
        role: "implementation",
        modelClass: "strong",
        executionPermission: "workspace-write",
        handoffPolicy: {
          expectsPushableHandoff: true,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        sourceKinds: ["pull_request"],
        requiredCapabilityNames: ["context7-docs"]
      };
    } else {
      return {
        kind,
        role: "discussion",
        modelClass: "strong",
        executionPermission: "read-only",
        handoffPolicy: {
          expectsPushableHandoff: false,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        sourceKinds: ["comment"],
        requiredCapabilityNames: []
      };
    }
  });

  const task1 = createTask("task-1", "respond_pr_comment");
  const task2 = createTask("task-2", "implement_plan"); // Blocked
  const task3 = createTask("task-3", "respond_pr_comment");

  const validation = {
    valid: [],
    blocked: [{
      name: "context7-docs",
      kind: "sensor",
      uses: "context7",
      reason: "mcp_action_required",
      message: "Auth required"
    }]
  } as any as CapabilityValidationResult;

  const result = evaluateMcpDispatchGate({
    tasks: [task1, task2, task3],
    worktrees: [mockWorktree],
    workstreams: [mockWorkstream],
    capabilityValidation: validation,
    mcpStatuses: [mockMcpStatus],
    now: "2026-06-30T11:00:00Z"
  });

  assert.deepEqual(result.tasksToDispatch, [task1, task3]);
});
