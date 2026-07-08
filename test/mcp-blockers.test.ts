import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  upsertMcpBlocker,
  clearMcpBlocker,
  applyMcpSkipExclusion,
  isTaskActivelyBlocked,
  reconcileBlockersWithMcpStatuses,
  getUnsurfacedBlockers,
  getApplicableSkipExclusions,
  classifyMidTaskMcpFailure,
  resumeMidTaskBlockedTasks
} from "../src/workstreams/mcp-blockers.js";
import type {
  WorkstreamRecord,
  McpStatusRecord,
  WorkstreamMcpBlocker,
  WorkstreamMcpScopedExclusion
} from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { workflowRegistry } from "../src/workflows/registry.js";
import type { BlockedCapability } from "../src/capabilities/types.js";

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

const mockTask = {
  id: "task-1",
  workstreamId: "ws-1",
  repoId: "repo-1",
  repoSlug: "eladav/agents-over-github",
  sourceKind: "issue",
  sourceId: "issue-1",
  kind: "implement_plan",
  status: "pending",
  relevant: true,
  createdAt: "2026-06-30T10:00:00Z",
  updatedAt: "2026-06-30T10:00:00Z",
  context: {
    recoveryNeeded: false
  }
} as any as TaskRecord;

const mockBlockedCapability: BlockedCapability = {
  name: "context7-docs",
  kind: "sensor",
  uses: "context7",
  reason: "mcp_action_required",
  message: "Needs auth"
};

const mockMcpStatus: McpStatusRecord = {
  handle: "context7",
  providerId: "smithery",
  providerMcpId: "context7",
  status: "action_required",
  lastCheckedAt: "2026-06-30T10:00:00Z",
  actionRequired: {
    reason: "Please click this URL to log in."
  }
};

test("upsertMcpBlocker creates a new blocker with correct fields and safeReason", () => {
  const result = upsertMcpBlocker(
    mockWorkstream,
    mockTask,
    mockBlockedCapability,
    mockMcpStatus,
    "packet-1",
    "2026-06-30T11:00:00Z"
  );

  assert.equal(result.mcpBlockers?.length, 1);
  const blocker = result.mcpBlockers?.[0]!;
  assert.equal(blocker.id, "mcp-blocker:ws-1:context7:task-1");
  assert.equal(blocker.kind, "mcp_action_required");
  assert.equal(blocker.mcpHandle, "context7");
  assert.deepEqual(blocker.affectedCapabilityNames, ["context7-docs"]);
  assert.equal(blocker.safeReason, "Please click this URL to log in.");
  assert.equal(blocker.blockedTaskId, "task-1");
  assert.equal(blocker.packetId, "packet-1");
  assert.equal(blocker.createdAt, "2026-06-30T11:00:00Z");
  assert.equal(blocker.updatedAt, "2026-06-30T11:00:00Z");
  assert.equal(blocker.surfacedAt, undefined);
  assert.equal(blocker.resolutionState, "waiting_for_user");
});

test("upsertMcpBlocker falls back to blockedCapability.message and a generic string without exposing URLs", () => {
  // 1. Fallback to capability message
  const statusWithoutActionRequired = {
    ...mockMcpStatus,
    actionRequired: undefined
  } as any as McpStatusRecord;
  const res1 = upsertMcpBlocker(
    mockWorkstream,
    mockTask,
    mockBlockedCapability,
    statusWithoutActionRequired,
    undefined,
    "2026-06-30T11:00:00Z"
  );
  assert.equal(res1.mcpBlockers?.[0]?.safeReason, "Needs auth");

  // 2. Fallback to generic message
  const capabilityWithoutMessage: BlockedCapability = {
    name: "context7-docs",
    kind: "sensor",
    uses: "context7",
    reason: "mcp_action_required"
  };
  const res2 = upsertMcpBlocker(
    mockWorkstream,
    mockTask,
    capabilityWithoutMessage,
    statusWithoutActionRequired,
    undefined,
    "2026-06-30T11:00:00Z"
  );
  assert.equal(res2.mcpBlockers?.[0]?.safeReason, "MCP requires user authorization or configuration.");

  // 3. Assert no URL or token shape is present in safeReason
  const statusWithSensitiveUrl: McpStatusRecord = {
    ...mockMcpStatus,
    actionRequired: {
      reason: "Authorize at http://localhost:4444/auth?token=supersecret"
    } as any
  };
  const res3 = upsertMcpBlocker(
    mockWorkstream,
    mockTask,
    mockBlockedCapability,
    statusWithSensitiveUrl,
    undefined,
    "2026-06-30T11:00:00Z"
  );
  assert.ok(!res3.mcpBlockers?.[0]?.safeReason.includes("supersecret"));
  assert.ok(!res3.mcpBlockers?.[0]?.safeReason.includes("http://"));
  assert.match(res3.mcpBlockers?.[0]?.safeReason ?? "", /\[redacted-url\]/);
});

test("upsertMcpBlocker is idempotent", () => {
  const t1 = "2026-06-30T11:00:00Z";
  const t2 = "2026-06-30T12:00:00Z";

  const ws1 = upsertMcpBlocker(mockWorkstream, mockTask, mockBlockedCapability, mockMcpStatus, "packet-1", t1);
  const ws2 = upsertMcpBlocker(ws1, mockTask, mockBlockedCapability, mockMcpStatus, "packet-1", t2);

  assert.equal(ws2.mcpBlockers?.length, 1);
  const blocker = ws2.mcpBlockers?.[0]!;
  assert.equal(blocker.createdAt, t1);
  assert.equal(blocker.updatedAt, t2);
});

test("clearMcpBlocker removes matching blocker and is no-op if id doesn't exist", () => {
  const wsWithBlocker = {
    ...mockWorkstream,
    mcpBlockers: [{
      id: "blocker-1",
      kind: "mcp_action_required" as const,
      mcpHandle: "context7",
      affectedCapabilityNames: ["context7-docs"],
      safeReason: "Auth required",
      blockedTaskKind: "implement_plan" as const,
      blockedTaskId: "task-1",
      createdAt: "2026-06-30T11:00:00Z",
      updatedAt: "2026-06-30T11:00:00Z",
      resolutionState: "waiting_for_user" as const
    }]
  } as any as WorkstreamRecord;

  // No-op for non-existent blocker
  const res1 = clearMcpBlocker(wsWithBlocker, "non-existent");
  assert.equal(res1.mcpBlockers?.length, 1);
  assert.equal(res1, wsWithBlocker);

  // Clears successfully
  const res2 = clearMcpBlocker(wsWithBlocker, "blocker-1");
  assert.equal(res2.mcpBlockers?.length, 0);
});

test("applyMcpSkipExclusion creates a scoped exclusion and clears the matching blocker", () => {
  const wsWithBlocker = {
    ...mockWorkstream,
    mcpBlockers: [{
      id: "mcp-blocker:ws-1:context7:task-1",
      kind: "mcp_action_required" as const,
      mcpHandle: "context7",
      affectedCapabilityNames: ["context7-docs"],
      safeReason: "Auth required",
      blockedTaskKind: "implement_plan" as const,
      blockedTaskId: "task-1",
      createdAt: "2026-06-30T11:00:00Z",
      updatedAt: "2026-06-30T11:00:00Z",
      resolutionState: "waiting_for_user" as const
    }]
  } as any as WorkstreamRecord;

  const res1 = applyMcpSkipExclusion(
    wsWithBlocker,
    "task-1",
    "implement_plan",
    "packet-1",
    "context7",
    ["context7-docs"],
    "2026-06-30T12:00:00Z"
  );

  // Blocker should be cleared
  assert.equal(res1.mcpBlockers?.length, 0);

  // Exclusion should be added
  assert.equal(res1.mcpSkipExclusions?.length, 1);
  const exclusion = res1.mcpSkipExclusions?.[0]!;
  assert.equal(exclusion.id, "mcp-exclusion:ws-1:context7:task-1");
  assert.equal(exclusion.taskId, "task-1");
  assert.equal(exclusion.mcpHandle, "context7");
  assert.deepEqual(exclusion.affectedCapabilityNames, ["context7-docs"]);

  // Idempotent: calling again does not duplicate the exclusion
  const res2 = applyMcpSkipExclusion(
    res1,
    "task-1",
    "implement_plan",
    "packet-1",
    "context7",
    ["context7-docs"],
    "2026-06-30T13:00:00Z"
  );
  assert.equal(res2.mcpSkipExclusions?.length, 1);
});

test("isTaskActivelyBlocked returns true only for waiting_for_user", () => {
  const ws = {
    ...mockWorkstream,
    mcpBlockers: [
      {
        id: "blocker-1",
        kind: "mcp_action_required" as const,
        mcpHandle: "context7",
        affectedCapabilityNames: ["context7-docs"],
        safeReason: "Auth required",
        blockedTaskKind: "implement_plan" as const,
        blockedTaskId: "task-1",
        createdAt: "2026-06-30T11:00:00Z",
        updatedAt: "2026-06-30T11:00:00Z",
        resolutionState: "waiting_for_user" as const
      },
      {
        id: "blocker-2",
        kind: "mcp_action_required" as const,
        mcpHandle: "context7",
        affectedCapabilityNames: ["context7-docs"],
        safeReason: "Auth required",
        blockedTaskKind: "implement_plan" as const,
        blockedTaskId: "task-2",
        createdAt: "2026-06-30T11:00:00Z",
        updatedAt: "2026-06-30T11:00:00Z",
        resolutionState: "skipped" as const
      }
    ]
  } as any as WorkstreamRecord;

  assert.equal(isTaskActivelyBlocked(ws, "task-1"), true);
  assert.equal(isTaskActivelyBlocked(ws, "task-2"), false);
  assert.equal(isTaskActivelyBlocked(ws, "task-3"), false);
});

test("reconcileBlockersWithMcpStatuses clears a blocker when status is ready", () => {
  const ws = {
    ...mockWorkstream,
    mcpBlockers: [{
      id: "mcp-blocker:ws-1:context7:task-1",
      kind: "mcp_action_required" as const,
      mcpHandle: "context7",
      affectedCapabilityNames: ["context7-docs"],
      safeReason: "Auth required",
      blockedTaskKind: "implement_plan" as const,
      blockedTaskId: "task-1",
      createdAt: "2026-06-30T11:00:00Z",
      updatedAt: "2026-06-30T11:00:00Z",
      resolutionState: "waiting_for_user" as const
    }]
  } as any as WorkstreamRecord;

  // Status is not ready
  const statuses1: McpStatusRecord[] = [
    { ...mockMcpStatus, status: "action_required" }
  ];
  const res1 = reconcileBlockersWithMcpStatuses(ws, statuses1, "2026-06-30T12:00:00Z");
  assert.equal(res1.workstream.mcpBlockers?.length, 1);
  assert.equal(res1.cleared.length, 0);

  // Status is ready
  const statuses2: McpStatusRecord[] = [
    { ...mockMcpStatus, status: "ready" }
  ];
  const res2 = reconcileBlockersWithMcpStatuses(ws, statuses2, "2026-06-30T12:00:00Z");
  assert.equal(res2.workstream.mcpBlockers?.length, 0);
  assert.equal(res2.cleared.length, 1);
  assert.equal(res2.cleared[0]?.id, "mcp-blocker:ws-1:context7:task-1");

  // Idempotent: second call returns same reference and empty cleared
  const res3 = reconcileBlockersWithMcpStatuses(res2.workstream, statuses2, "2026-06-30T12:00:00Z");
  assert.equal(res3.workstream, res2.workstream);
  assert.equal(res3.cleared.length, 0);
});

test("getUnsurfacedBlockers and getApplicableSkipExclusions filter correctly", () => {
  const ws = {
    ...mockWorkstream,
    mcpBlockers: [
      {
        id: "blocker-1",
        kind: "mcp_action_required" as const,
        mcpHandle: "context7",
        affectedCapabilityNames: ["context7-docs"],
        safeReason: "Auth required",
        blockedTaskKind: "implement_plan" as const,
        blockedTaskId: "task-1",
        createdAt: "2026-06-30T11:00:00Z",
        updatedAt: "2026-06-30T11:00:00Z",
        surfacedAt: undefined,
        resolutionState: "waiting_for_user" as const
      },
      {
        id: "blocker-2",
        kind: "mcp_action_required" as const,
        mcpHandle: "context7",
        affectedCapabilityNames: ["context7-docs"],
        safeReason: "Auth required",
        blockedTaskKind: "implement_plan" as const,
        blockedTaskId: "task-1",
        createdAt: "2026-06-30T11:00:00Z",
        updatedAt: "2026-06-30T11:00:00Z",
        surfacedAt: "2026-06-30T11:30:00Z",
        resolutionState: "waiting_for_user" as const
      }
    ],
    mcpSkipExclusions: [
      {
        id: "ex-1",
        taskId: "task-1",
        taskKind: "implement_plan" as const,
        mcpHandle: "context7",
        affectedCapabilityNames: ["context7-docs"],
        createdAt: "2026-06-30T11:00:00Z"
      },
      {
        id: "ex-2",
        taskId: "task-2",
        taskKind: "implement_plan" as const,
        mcpHandle: "context7",
        affectedCapabilityNames: ["context7-docs"],
        createdAt: "2026-06-30T11:00:00Z"
      }
    ]
  } as any as WorkstreamRecord;

  const unsurfaced = getUnsurfacedBlockers(ws);
  assert.equal(unsurfaced.length, 1);
  assert.equal(unsurfaced[0]?.id, "blocker-1");

  const exclusions = getApplicableSkipExclusions(ws, "task-1");
  assert.equal(exclusions.length, 1);
  assert.equal(exclusions[0]?.id, "ex-1");
});

test("classifyMidTaskMcpFailure detects MCP blocked capabilities for failed task", (t) => {
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

  const task = {
    ...mockTask,
    kind: "implement_plan" as const
  } as any as TaskRecord;
  const capabilities = {
    sensors: [{ name: "context7-docs", uses: "context7", observes: "package-docs", scope: "task-context", cadence: "on-demand", tools: [] }],
    controllers: []
  } as any;
  const declaredMcps = [{ handle: "context7" }] as any;

  // Case 1: Status is ready -> not blocked
  const refreshedMcpStatuses1: McpStatusRecord[] = [
    { ...mockMcpStatus, status: "ready" }
  ];
  const blocked1 = classifyMidTaskMcpFailure({ task, capabilities, declaredMcps, refreshedMcpStatuses: refreshedMcpStatuses1 });
  assert.equal(blocked1.length, 0);

  // Case 2: Status is action_required -> blocked
  const refreshedMcpStatuses2: McpStatusRecord[] = [
    { ...mockMcpStatus, status: "action_required" }
  ];
  const blocked2 = classifyMidTaskMcpFailure({ task, capabilities, declaredMcps, refreshedMcpStatuses: refreshedMcpStatuses2 });
  assert.equal(blocked2.length, 1);
  assert.equal(blocked2[0]?.name, "context7-docs");
  assert.equal(blocked2[0]?.uses, "context7");

  const skippedTask = {
    ...task,
    context: {
      ...task.context,
      mcpSkipContexts: [
        {
          mcpHandle: "context7",
          affectedCapabilityNames: ["context7-docs"],
          skipReason: "User explicitly skipped MCP authorization for this task."
        }
      ]
    }
  } as any as TaskRecord;
  const blockedAfterSkip = classifyMidTaskMcpFailure({
    task: skippedTask,
    capabilities,
    declaredMcps,
    refreshedMcpStatuses: refreshedMcpStatuses2
  });
  assert.equal(blockedAfterSkip.length, 0);
});

test("resumeMidTaskBlockedTasks transitions matching failed tasks to pending and retains workspace", () => {
  const task1 = {
    ...mockTask,
    id: "task-1",
    status: "failed",
    context: { recoveryNeeded: true }
  } as any as TaskRecord;

  const task2 = {
    ...mockTask,
    id: "task-2",
    status: "failed",
    context: { recoveryNeeded: true }
  } as any as TaskRecord;

  const clearedBlockers: WorkstreamMcpBlocker[] = [
    {
      id: "blocker-1",
      kind: "mcp_action_required",
      mcpHandle: "context7",
      affectedCapabilityNames: ["context7-docs"],
      safeReason: "Auth required",
      blockedTaskKind: "implement_plan",
      blockedTaskId: "task-1",
      createdAt: "2026-06-30T11:00:00Z",
      updatedAt: "2026-06-30T11:00:00Z",
      resolutionState: "waiting_for_user"
    }
  ];

  const skipExclusions: WorkstreamMcpScopedExclusion[] = [
    {
      id: "ex-2",
      taskId: "task-2",
      taskKind: "implement_plan",
      mcpHandle: "context7",
      affectedCapabilityNames: ["context7-docs"],
      createdAt: "2026-06-30T11:00:00Z"
    }
  ];

  const result = resumeMidTaskBlockedTasks({
    tasks: [task1, task2],
    clearedBlockers,
    skipExclusionsAppliedThisCycle: skipExclusions,
    now: "2026-07-01T12:00:00Z"
  });

  assert.equal(result.resumedTaskIds.size, 2);
  assert.ok(result.resumedTaskIds.has("task-1"));
  assert.ok(result.resumedTaskIds.has("task-2"));

  const updatedT1 = result.tasks.find(t => t.id === "task-1")!;
  assert.equal(updatedT1.status, "pending");
  assert.equal(updatedT1.context.recoveryNeeded, false);
  assert.equal(updatedT1.context.mcpSkipContexts, undefined);

  const updatedT2 = result.tasks.find(t => t.id === "task-2")!;
  assert.equal(updatedT2.status, "pending");
  assert.equal(updatedT2.context.recoveryNeeded, false);
  assert.equal(updatedT2.context.mcpSkipContexts?.length, 1);
  assert.equal(updatedT2.context.mcpSkipContexts?.[0]?.mcpHandle, "context7");
  assert.deepEqual(updatedT2.context.mcpSkipContexts?.[0]?.affectedCapabilityNames, ["context7-docs"]);
});

test("runDispatchWithMergePrepLifecycle surfaces first-time pre-dispatch MCP blockers once with authorize and skip instructions", async (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => ({
    kind,
    role: "implementation",
    modelClass: "cheap",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    sourceKinds: ["issue"],
    requiredCapabilityNames: ["context7-docs"]
  }));

  const stateWrites: WorkstreamRecord[][] = [];
  const mockStateStore = {
    load: async () => ({}),
    writeTaskState: async () => {},
    writeExecutionState: async () => {},
    writeMcpStatusState: async () => {},
    writeWorkstreamState: async (workstreams: WorkstreamRecord[]) => {
      stateWrites.push(workstreams);
    },
    writeJobAgentAssignmentState: async () => {},
    writeProviderSessionState: async () => {},
    loadWorkspaceRecoveryState: async () => [],
    writeWorkspaceRecoveryState: async () => {},
  } as any;

  const comments: string[] = [];
  const githubGateway = {
    async postIssueComment(input: { body: string }) {
      comments.push(input.body);
      return { id: `comment-${comments.length}`, url: `https://example.test/comment-${comments.length}` };
    }
  } as any;

  const task = {
    ...mockTask,
    sourceKind: "issue",
    sourceId: "issue:eladav/agents-over-github:310",
    sourceUrl: "https://github.com/eladav/agents-over-github/issues/310",
    repoName: "agents-over-github",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    }
  } as any as TaskRecord;
  const workstream = { ...mockWorkstream, mcpBlockers: [], mcpSkipExclusions: [] } as any as WorkstreamRecord;
  const mcpStatuses: McpStatusRecord[] = [
    {
      handle: "context7",
      providerId: "smithery",
      providerMcpId: "context7",
      status: "action_required",
      lastCheckedAt: "2026-07-07T10:00:00Z",
      actionRequired: {
        reason: "Authorize at https://smithery.example/setup?token=supersecret"
      }
    }
  ];

  const { runDispatchWithMergePrepLifecycle } = await import("../src/cli/run.js");
  const runInput = {
    tasks: [task],
    executions: [],
    agents: [{ id: "mock-agent", provider: "codex", modelClass: "cheap", roles: ["implementation"], command: "node", enabled: true }],
    enabledRepos: [{ id: "repo-1", owner: "eladav", name: "agents-over-github" }],
    codeRoot: "/tmp/code",
    logDir: "/tmp/log",
    stateStore: mockStateStore,
    agentRunner: { dispatch: async () => { throw new Error("blocked task must not dispatch"); } },
    failureNotifier: undefined,
    reviewPublisher: undefined,
    planBreakdownPublisher: undefined,
    waveAssessmentPublisher: undefined,
    lifecycleNotifier: undefined,
    jobMemoryRuntime: undefined,
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    promptsConfig: undefined,
    managementRoot: undefined,
    mergePrepService: {
      refreshPersistentWorktreeBeforeDispatch: async () => ({ status: "succeeded", message: "ok" })
    },
    githubGateway,
    backburnerGitToolService: {} as any,
    commandRunner: {} as any,
    gitGateway: {} as any,
    workspaceRecoveryService: {
      isRecoveryNeeded: () => false,
      resolveTaskWorkspacePath: () => undefined,
      recoverWorkspace: async () => ({ outcome: "skipped", reason: "not needed" })
    },
    worktrees: [],
    workstreams: [workstream],
    capabilityValidation: {
      valid: [],
      blocked: [{ ...mockBlockedCapability, message: "Needs auth" }]
    },
    mcpStatuses,
    declaredMcps: [{ handle: "context7", smitheryId: "context7" }],
    capabilitiesConfig: {
      sensors: [{ name: "context7-docs", uses: "context7", observes: "package-docs", scope: "task-context", cadence: "on-demand", tools: [] }],
      controllers: []
    }
  } as any;

  const firstRun = await runDispatchWithMergePrepLifecycle(runInput);

  assert.equal(comments.length, 1);
  assert.match(comments[0]!, /MCP capability blocked/);
  assert.match(comments[0]!, /Complete the required setup/);
  assert.match(comments[0]!, /mcp-skip: task-1 context7/);
  assert.match(comments[0]!, /context7-docs/);
  assert.match(comments[0]!, /find a workaround or report/);
  assert.ok(!comments[0]!.includes("supersecret"));
  assert.ok(!comments[0]!.includes("https://smithery.example"));
  assert.equal(firstRun.tasks[0]?.status, "pending");
  const blocker = firstRun.workstreams[0]?.mcpBlockers?.[0];
  assert.ok(blocker?.surfacedAt);
  assert.ok(!blocker.safeReason.includes("supersecret"));
  assert.ok(!blocker.safeReason.includes("https://smithery.example"));
  assert.ok(stateWrites.length >= 2);

  const secondRun = await runDispatchWithMergePrepLifecycle({
    ...runInput,
    workstreams: firstRun.workstreams
  });

  assert.equal(comments.length, 1);
  assert.equal(secondRun.workstreams[0]?.mcpBlockers?.[0]?.surfacedAt, blocker.surfacedAt);
});

test("runDispatchWithMergePrepLifecycle classifies mid-task MCP action_required failures before generic recovery", async (t) => {
  t.mock.method(workflowRegistry, "getDefinition", (kind: any) => ({
    kind,
    role: "implementation",
    modelClass: "cheap",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    sourceKinds: ["issue"],
    requiredCapabilityNames: ["context7-docs"]
  }));

  const task = {
    ...mockTask,
    sourceKind: "issue",
    sourceId: "issue:eladav/agents-over-github:310",
    sourceUrl: "https://github.com/eladav/agents-over-github/issues/310",
    repoName: "agents-over-github",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    context: {
      recoveryNeeded: false,
      localRepoPath: "/tmp/code/agents-over-github",
      branchName: "agent/issue-310"
    }
  } as any as TaskRecord;

  const comments: string[] = [];
  const genericFailureComments: string[] = [];
  const mcpStatusWrites: McpStatusRecord[][] = [];
  const taskStateWrites: TaskRecord[][] = [];
  const stateStore = {
    load: async () => ({}),
    writeTaskState: async (tasks: TaskRecord[]) => {
      taskStateWrites.push(tasks);
    },
    writeExecutionState: async () => {},
    writeMcpStatusState: async (statuses: McpStatusRecord[]) => {
      mcpStatusWrites.push(statuses);
    },
    writeWorkstreamState: async () => {},
    writeJobAgentAssignmentState: async () => {},
    writeProviderSessionState: async () => {},
    loadWorkspaceRecoveryState: async () => [],
    writeWorkspaceRecoveryState: async () => {},
  } as any;
  const failedExecution = {
    id: "exec-mid-task-mcp",
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: "failed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "mock-agent",
    agentProvider: "codex",
    command: { executable: "mock", args: [], cwd: "/tmp/code/agents-over-github", timeoutMs: 1000 },
    promptArtifactPath: "/tmp/log/prompt.md",
    stdoutArtifactPath: "/tmp/log/stdout.txt",
    stderrArtifactPath: "/tmp/log/stderr.txt",
    promptPacketPath: "/tmp/log/prompt-packet.json",
    startedAt: "2026-07-07T10:00:00Z",
    endedAt: "2026-07-07T10:01:00Z",
    exitCode: 1,
    errorMessage: "MCP tool unavailable"
  } as any;
  const refreshedStatuses: McpStatusRecord[] = [
    {
      handle: "context7",
      providerId: "smithery",
      providerMcpId: "context7",
      status: "action_required",
      lastCheckedAt: "2026-07-07T10:01:00Z",
      actionRequired: {
        reason: "authorization_required"
      }
    }
  ];

  const { runDispatchWithMergePrepLifecycle } = await import("../src/cli/run.js");
  const result = await runDispatchWithMergePrepLifecycle({
    tasks: [task],
    executions: [],
    agents: [{ id: "mock-agent", provider: "codex", modelClass: "cheap", roles: ["implementation"], command: "node", enabled: true }],
    enabledRepos: [{ id: "repo-1", owner: "eladav", name: "agents-over-github" }],
    codeRoot: "/tmp/code",
    logDir: "/tmp/log",
    stateStore,
    agentRunner: {
      async dispatch() {
        return {
          taskStatus: "failed",
          execution: failedExecution
        };
      }
    } as any,
    failureNotifier: {
      async notifyFailure(_failedTask: TaskRecord, _execution: unknown, customMessage?: string) {
        genericFailureComments.push(customMessage ?? "generic-failure");
        return "generic-comment-id";
      }
    } as any,
    reviewPublisher: undefined,
    planBreakdownPublisher: undefined,
    waveAssessmentPublisher: undefined,
    lifecycleNotifier: undefined,
    jobMemoryRuntime: undefined,
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    promptsConfig: undefined,
    managementRoot: undefined,
    mergePrepService: {
      refreshPersistentWorktreeBeforeDispatch: async () => ({ status: "succeeded", message: "ok" })
    },
    githubGateway: {
      async postIssueComment(input: { body: string }) {
        comments.push(input.body);
        return { id: `mcp-comment-${comments.length}`, url: `https://example.test/mcp-comment-${comments.length}` };
      }
    } as any,
    backburnerGitToolService: {} as any,
    commandRunner: {} as any,
    gitGateway: {} as any,
    workspaceRecoveryService: {
      isRecoveryNeeded: () => false,
      resolveTaskWorkspacePath: () => undefined,
      recoverWorkspace: async () => ({ outcome: "skipped", reason: "not needed" })
    },
    worktrees: [
      {
        id: "wt-1",
        repoId: "repo-1",
        repoSlug: "eladav/agents-over-github",
        repoName: "agents-over-github",
        path: "/tmp/code/agents-over-github",
        branchName: "agent/issue-310",
        status: "implementing",
        packet: {
          parentWorkstreamId: "ws-1",
          packetId: "packet-1",
          waveIndex: 1,
          parentIntegrationBranch: "main"
        }
      } as any
    ],
    workstreams: [{ ...mockWorkstream, mcpBlockers: [], mcpSkipExclusions: [] } as any as WorkstreamRecord],
    capabilityValidation: {
      valid: [{ name: "context7-docs", kind: "sensor", uses: "context7", mcpStatus: "ready" }],
      blocked: []
    },
    mcpStatuses: [{ ...mockMcpStatus, status: "ready", actionRequired: undefined }],
    declaredMcps: [{ handle: "context7", smitheryId: "context7" }],
    capabilitiesConfig: {
      sensors: [{ name: "context7-docs", uses: "context7", observes: "package-docs", scope: "task-context", cadence: "on-demand", tools: [] }],
      controllers: []
    },
    refreshMcpStatuses: async () => refreshedStatuses
  } as any);

  const resultTask = result.tasks[0]!;
  assert.equal(resultTask.status, "failed");
  assert.equal(resultTask.context.recoveryNeeded, false);
  assert.equal(genericFailureComments.length, 0);
  assert.equal(comments.length, 1);
  assert.match(comments[0]!, /mcp-skip: task-1 context7/);
  assert.equal(mcpStatusWrites.length, 1);
  assert.equal(mcpStatusWrites[0]?.[0]?.status, "action_required");
  const blocker = result.workstreams[0]?.mcpBlockers?.[0];
  assert.equal(blocker?.blockedTaskId, task.id);
  assert.equal(blocker?.packetId, "packet-1");
  assert.ok(blocker?.surfacedAt);
  assert.ok(taskStateWrites.some((tasks) => tasks[0]?.context.recoveryNeeded === false));
});

test("runDispatchWithMergePrepLifecycle rehydrates persisted MCP skip exclusions before projection and broker scoping", async () => {
  const task = {
    id: "task-review",
    workstreamId: "ws-1",
    repoId: "repo-1",
    repoName: "agents-over-github",
    repoSlug: "eladav/agents-over-github",
    sourceKind: "pull_request",
    sourceId: "pull_request:eladav/agents-over-github:311",
    sourceUrl: "https://github.com/eladav/agents-over-github/pull/311",
    kind: "review_pr",
    status: "pending",
    executionPermission: "read-only",
    handoffPolicy: {
      expectsPushableHandoff: false,
      orchestratorOwnsPush: false,
      remotePublishOwner: "agent"
    },
    relevant: true,
    reason: "Review requested",
    summary: "Review PR",
    createdAt: "2026-07-07T10:00:00Z",
    updatedAt: "2026-07-07T10:00:00Z",
    context: {
      recoveryNeeded: false
    }
  } as any as TaskRecord;
  const workstream = {
    ...mockWorkstream,
    mcpBlockers: [],
    mcpSkipExclusions: [
      {
        id: "mcp-exclusion:ws-1:context7:task-review",
        taskId: "task-review",
        taskKind: "review_pr",
        mcpHandle: "context7",
        affectedCapabilityNames: ["context7-docs"],
        createdAt: "2026-07-07T10:00:00Z"
      }
    ]
  } as any as WorkstreamRecord;
  const capabilities = {
    sensors: [
      {
        name: "context7-docs",
        uses: "context7",
        observes: "package-docs",
        tools: ["context7.resolve-library-id"]
      }
    ],
    controllers: [],
    blocked: []
  };

  let capturedContextCapabilities: any;
  const bindCalls: string[][] = [];
  const stateStore = {
    load: async () => ({}),
    writeTaskState: async () => {},
    writeExecutionState: async () => {},
    writeMcpStatusState: async () => {},
    writeWorkstreamState: async () => {},
    writeJobAgentAssignmentState: async () => {},
    writeProviderSessionState: async () => {},
    loadWorkspaceRecoveryState: async () => [],
    writeWorkspaceRecoveryState: async () => {},
  } as any;

  const { runDispatchWithMergePrepLifecycle } = await import("../src/cli/run.js");
  const result = await runDispatchWithMergePrepLifecycle({
    tasks: [task],
    executions: [],
    agents: [{ id: "reviewer", provider: "codex", modelClass: "strong", roles: ["review"], command: "node", enabled: true }],
    enabledRepos: [{ id: "repo-1", owner: "eladav", name: "agents-over-github" }],
    codeRoot: "/tmp/code",
    logDir: "/tmp/log",
    stateStore,
    agentRunner: {
      async dispatch(dispatchedTask: TaskRecord, context: any) {
        capturedContextCapabilities = context.capabilities;
        return {
          taskStatus: "completed",
          execution: {
            id: "exec-review",
            taskId: dispatchedTask.id,
            taskKind: dispatchedTask.kind,
            taskStatus: "completed",
            repoId: dispatchedTask.repoId,
            repoSlug: dispatchedTask.repoSlug,
            agentId: "reviewer",
            agentProvider: "codex",
            command: { executable: "mock", args: [], cwd: "/tmp/code", timeoutMs: 1000 },
            promptArtifactPath: "/tmp/log/prompt.md",
            stdoutArtifactPath: "/tmp/log/stdout.txt",
            stderrArtifactPath: "/tmp/log/stderr.txt",
            promptPacketPath: "/tmp/log/prompt-packet.json",
            startedAt: "2026-07-07T10:00:00Z",
            endedAt: "2026-07-07T10:01:00Z",
            exitCode: 0
          }
        };
      }
    } as any,
    failureNotifier: undefined,
    reviewPublisher: undefined,
    planBreakdownPublisher: undefined,
    waveAssessmentPublisher: undefined,
    lifecycleNotifier: undefined,
    jobMemoryRuntime: undefined,
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    promptsConfig: undefined,
    managementRoot: undefined,
    mergePrepService: {
      refreshPersistentWorktreeBeforeDispatch: async () => ({ status: "succeeded", message: "ok" })
    },
    githubGateway: { postIssueComment: async () => ({ id: "unused", url: "https://example.test/unused" }) } as any,
    backburnerGitToolService: {} as any,
    commandRunner: {} as any,
    gitGateway: {} as any,
    workspaceRecoveryService: {
      isRecoveryNeeded: () => false,
      resolveTaskWorkspacePath: () => undefined,
      recoverWorkspace: async () => ({ outcome: "skipped", reason: "not needed" })
    },
    worktrees: [],
    workstreams: [workstream],
    capabilityValidation: {
      valid: [{ name: "context7-docs", kind: "sensor", uses: "context7", mcpStatus: "ready" }],
      blocked: []
    },
    mcpStatuses: [{ ...mockMcpStatus, status: "ready", actionRequired: undefined }],
    declaredMcps: [{ handle: "context7", smitheryId: "context7" }],
    capabilitiesConfig: {
      sensors: [{ name: "context7-docs", uses: "context7", observes: "package-docs", scope: "task-context", cadence: "on-demand", tools: [] }],
      controllers: []
    },
    capabilitiesByProvider: new Map([["codex", capabilities]]),
    providerBrokerToolAllowLists: new Map([["codex", ["get_issue", "context7.resolve-library-id"]]]),
    brokerToolScope: {
      bindAllowedTools(allowedToolNames: readonly string[]) {
        bindCalls.push([...allowedToolNames]);
      },
      clearAllowedTools() {}
    }
  } as any);

  const resultTask = result.tasks[0]!;
  assert.equal(resultTask.context.mcpSkipContexts?.length, 1);
  assert.equal(resultTask.context.mcpSkipContexts?.[0]?.mcpHandle, "context7");
  assert.deepEqual(resultTask.context.mcpSkipContexts?.[0]?.affectedCapabilityNames, ["context7-docs"]);
  assert.deepEqual(capturedContextCapabilities?.sensors, []);
  assert.equal(capturedContextCapabilities?.blocked?.[0]?.name, "context7-docs");
  assert.equal(capturedContextCapabilities?.blocked?.[0]?.reason, "capability_skipped_by_user");
  assert.deepEqual(bindCalls[0], ["get_issue"]);
});

test("runDispatchWithMergePrepLifecycle prevents duplicate comments and correctly re-classifies resumed tasks that fail again", async () => {
  // Mock StateStore
  const mockStateStore = {
    load: async () => ({}),
    writeTaskState: async () => {},
    writeExecutionState: async () => {},
    writeMcpStatusState: async () => {},
    writeWorkstreamState: async () => {},
    writeJobAgentAssignmentState: async () => {},
    writeProviderSessionState: async () => {},
    loadWorkspaceRecoveryState: async () => [],
    writeWorkspaceRecoveryState: async () => {},
  } as any;

  // Mock WorkspaceRecoveryService
  const mockWorkspaceRecoveryService = {
    recoverFailedWorkspaceTasks: async () => ({
      recoveredTaskIds: new Set<string>(),
      skippedTaskIds: new Set<string>(),
      rejectedTaskIds: new Set<string>(),
      failedTaskIds: new Set<string>(),
    }),
    isRecoveryNeeded: () => false,
    resolveTaskWorkspacePath: () => "/path/to/repo",
    recoverWorkspace: async () => ({ outcome: "skipped", reason: "not needed" }),
  } as any;

  // Mock failure notifier to count notifications
  const failureNotifications: string[] = [];
  const mockFailureNotifier = {
    async notifyFailure(failedTask: any, execution: any, customMessage?: string) {
      failureNotifications.push(customMessage || "generic-failure");
      return "mock-comment-id";
    }
  } as any;

  // Mock task that starts failed, gets resumed to pending, but fails again
  const taskToResumeAndFail = {
    id: "task-resumed-and-failed",
    workstreamId: "ws-1",
    repoId: "repo-1",
    repoSlug: "eladav/agents-over-github",
    kind: "implement_plan",
    status: "failed", // starts failed so Phase 2 resume picks it up
    relevant: true,
    createdAt: "2026-06-30T10:00:00Z",
    updatedAt: "2026-06-30T10:00:00Z",
    context: {
      recoveryNeeded: true,
      localRepoPath: "/path/to/repo",
      branchName: "feature-branch"
    }
  } as any as TaskRecord;

  // A blocker that starts as waiting_for_user but is cleared this cycle
  const mockWorkstreamWithClearedBlocker = {
    id: "ws-1",
    owner: "eladav",
    repo: "agents-over-github",
    issueNumber: 310,
    phase: "implementing",
    status: "open",
    mcpBlockers: [
      {
        id: "blocker-1",
        kind: "mcp_action_required",
        mcpHandle: "context7",
        affectedCapabilityNames: ["context7-docs"],
        safeReason: "Auth required",
        blockedTaskKind: "implement_plan",
        blockedTaskId: "task-resumed-and-failed",
        createdAt: "2026-06-30T11:00:00Z",
        updatedAt: "2026-06-30T11:00:00Z",
        resolutionState: "waiting_for_user"
      }
    ],
    mcpSkipExclusions: []
  } as any as WorkstreamRecord;

  // Refreshed status showing blocker is now ready
  const mcpStatuses: McpStatusRecord[] = [
    {
      handle: "context7",
      providerId: "smithery",
      providerMcpId: "context7",
      status: "ready", // cleared!
      lastCheckedAt: "2026-06-30T10:00:00Z"
    }
  ];

  // Mock runner that fails the dispatch
  const mockAgentRunner = {
    async dispatch(task: any) {
      return {
        taskStatus: "failed" as const,
        execution: {
          id: "exec-failed-again",
          taskId: task.id,
          taskKind: task.kind,
          taskStatus: "failed" as const,
          repoId: task.repoId,
          repoSlug: task.repoSlug,
          agentId: "mock-agent",
          agentProvider: "codex",
          command: { executable: "mock", args: [], cwd: "/path" },
          promptArtifactPath: "/path/prompt.md",
          stdoutArtifactPath: "/path/stdout.txt",
          stderrArtifactPath: "/path/stderr.txt",
          promptPacketPath: "/path/prompt-packet.json",
          startedAt: "2026-07-03T10:00:00Z",
          endedAt: "2026-07-03T10:01:00Z",
          exitCode: 1,
          errorMessage: "Failed again",
          result: {
            success: false,
            error: "Failed again"
          }
        }
      };
    }
  } as any;

  const mockLogger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  } as any;

  // Import runDispatchWithMergePrepLifecycle dynamically/normally
  const { runDispatchWithMergePrepLifecycle } = await import("../src/cli/run.js");

  // Run the lifecycle
  const result = await runDispatchWithMergePrepLifecycle({
    tasks: [taskToResumeAndFail],
    executions: [],
    agents: [{ id: "mock-agent", provider: "codex", modelClass: "cheap", roles: ["implementation"], command: "node", enabled: true }],
    enabledRepos: [],
    codeRoot: "/tmp/code",
    logDir: "/tmp/log",
    stateStore: mockStateStore,
    agentRunner: mockAgentRunner,
    failureNotifier: mockFailureNotifier,
    reviewPublisher: undefined,
    planBreakdownPublisher: undefined,
    waveAssessmentPublisher: undefined,
    lifecycleNotifier: undefined,
    jobMemoryRuntime: undefined,
    logger: mockLogger,
    promptsConfig: undefined,
    managementRoot: undefined,
    mergePrepService: {} as any,
    githubGateway: {} as any,
    backburnerGitToolService: {} as any,
    commandRunner: {} as any,
    gitGateway: {} as any,
    workspaceRecoveryService: mockWorkspaceRecoveryService,
    worktrees: [
      {
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
      } as any
    ],
    workstreams: [mockWorkstreamWithClearedBlocker],
    capabilityValidation: {
      valid: [],
      blocked: []
    },
    mcpStatuses,
    declaredMcps: [],
    capabilitiesConfig: {
      sensors: [],
      controllers: []
    }
  });

  // 1. Resumed task status check: it should be "failed" after failing again.
  const taskResult = result.tasks.find(t => t.id === "task-resumed-and-failed");
  assert.ok(taskResult);
  assert.equal(taskResult.status, "failed");

  // 2. Prevent duplicate comments: there should be exactly ONE failure comment posted (ordinary comment because blocker was resolved).
  assert.equal(failureNotifications.length, 1);
  assert.equal(failureNotifications[0], "generic-failure");
});
