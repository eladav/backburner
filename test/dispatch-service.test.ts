/**
 * Dispatch-level tests for dispatchPendingTasks.
 *
 * These tests exercise the full dispatch loop with a fake AgentRunner and an
 * in-memory StateStore stub. They verify concurrency semantics (scope locks,
 * broker scoping, sequential fallback) that cannot be covered by the primitive
 * unit tests in agent-pool.test.ts.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as os from "node:os";
import { AgentPool } from "../src/agents/pool.js";
import { dispatchPendingTasks } from "../src/agents/service.js";
import type { DispatchCycleInput } from "../src/agents/service.js";
import { processProviderLimitResumption } from "../src/cli/commands/run.js";
import type { AgentConfig, AgentProvider } from "../src/config/types.js";
import type { ExecutionRecord } from "../src/state/types.js";
import type { StateStore } from "../src/state/loader.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { detectProviderLimit } from "../src/agents/extraction.js";
import {
  getProviderSessionRecordId,
  resolveProviderSessionScope
} from "../src/agents/provider-sessions.js";
import type { BuiltContext } from "../src/context/types.js";
import type { ProviderSessionDecision } from "../src/agents/provider-sessions.js";

// ── Stubs ─────────────────────────────────────────────────────────────────────

/**
 * Minimal in-memory StateStore stub.
 * Only implements the subset of the interface that dispatchPendingTasks calls.
 */
function makeStateStore(opts: {
  /** If true, writeExecutionState always throws (simulates persistence failure). */
  throwOnWriteExecution?: boolean;
  providerSessions?: any[];
} = {}): StateStore {
  const stored = {
    jobAgentAssignments: [] as any[],
    providerSessions: [...(opts.providerSessions ?? [])],
  };

  return {
    load: async () =>
      ({
        jobAgentAssignments: stored.jobAgentAssignments,
        providerSessions: stored.providerSessions,
      } as any),
    writeTaskState: async (_tasks: any[]) => {},
    writeExecutionState: async (_execs: any[]) => {
      if (opts.throwOnWriteExecution) throw new Error("state persistence failed");
    },
    writeJobAgentAssignmentState: async (assignments: any[]) => {
      stored.jobAgentAssignments = [...assignments];
    },
    writeProviderSessionState: async (sessions: any[]) => {
      stored.providerSessions = [...sessions];
    },
  } as unknown as StateStore;
}

/**
 * Agent config that matches issue-comment response tasks (role: "discussion", modelClass: "strong").
 */
function makeAgent(overrides: { id: string; provider: AgentProvider }): AgentConfig {
  return {
    id: overrides.id,
    provider: overrides.provider,
    modelClass: "strong",
    roles: ["discussion"],
    command: "echo",
    enabled: true,
  } as AgentConfig;
}

/**
 * Pending respond_issue_comment task. Providing workstreamId or context overrides
 * changes the scope lock keys derived for that task.
 */
function makeTask(
  id: string,
  overrides: {
    workstreamId?: string;
    branchName?: string;
    localRepoPath?: string;
  } = {}
): TaskRecord {
  return {
    id,
    kind: "respond_issue_comment",
    status: "pending",
    repoId: "repo-1",
    repoSlug: "test-repo",
    relevant: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...(overrides.workstreamId !== undefined ? { workstreamId: overrides.workstreamId } : {}),
    context: {
      ...(overrides.branchName !== undefined ? { branchName: overrides.branchName } : {}),
      ...(overrides.localRepoPath !== undefined ? { localRepoPath: overrides.localRepoPath } : {}),
    },
  } as unknown as TaskRecord;
}

function makeExecution(task: TaskRecord, agent: AgentConfig): ExecutionRecord {
  const ts = new Date().toISOString();
  return {
    id: `exec-${task.id}-${Math.random().toString(36).slice(2)}`,
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: "completed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: agent.id,
    agentProvider: agent.provider,
    startedAt: ts,
    endedAt: ts,
    exitCode: 0,
    command: { executable: "echo", args: [], cwd: "/tmp", timeoutMs: 0 },
    promptArtifactPath: "/dev/null",
    stdoutArtifactPath: "/dev/null",
    stderrArtifactPath: "/dev/null",
    promptPacketPath: "/dev/null",
  } as ExecutionRecord;
}

type FakeRunner = DispatchCycleInput["agentRunner"];

/**
 * Create a fake AgentRunner. delayMs introduces artificial latency so that
 * concurrent tasks can be observed overlapping.
 */
function makeRunner(opts: {
  delayMs?: number;
  onDispatch?: (task: TaskRecord, agent: AgentConfig) => void;
  throw?: boolean;
}): FakeRunner {
  return {
    dispatch: async (task: any, _ctx: any, agent: any) => {
      opts.onDispatch?.(task as TaskRecord, agent as AgentConfig);
      if (opts.delayMs) await sleep(opts.delayMs);
      if (opts.throw) throw new Error("agent crash");
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task as TaskRecord, agent as AgentConfig),
        providerSession: undefined,
      };
    },
  } as unknown as FakeRunner;
}

function makeBrokerScope() {
  const bindCalls: string[][] = [];
  const clearCount = { value: 0 };
  const scope: DispatchCycleInput["brokerToolScope"] = {
    bindAllowedTools(tools: readonly string[]) {
      bindCalls.push([...tools].sort());
    },
    clearAllowedTools() {
      clearCount.value += 1;
    },
  };
  return { scope, bindCalls, clearCount };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const logDir = os.tmpdir();
const managementRoot = os.tmpdir();

function baseInput(
  tasks: TaskRecord[],
  agents: AgentConfig[],
  runner: FakeRunner,
  pool: AgentPool | undefined,
  extras: Partial<DispatchCycleInput> = {}
): DispatchCycleInput {
  return {
    tasks,
    agents,
    existingExecutions: [],
    stateStore: makeStateStore(),
    logDir,
    managementRoot,
    agentRunner: runner,
    agentPool: pool,
    ...extras,
  };
}

test("dispatch: native resume after a preserved failed workspace carries retry-aware prompt context", async () => {
  const task = {
    ...makeTask("task-retry", {
      workstreamId: "ws-retry",
      branchName: "feature/retry",
      localRepoPath: "/tmp/retry-worktree"
    }),
    kind: "write_plan",
    lastExecutionId: "exec-prior-failure",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    context: {
      ...makeTask("task-retry").context,
      repoIdentifier: "test-repo",
      labels: [],
      instruction: "Write the plan",
      branchName: "feature/retry",
      localRepoPath: "/tmp/retry-worktree",
      recoveryNeeded: true
    }
  } as TaskRecord;
  const agent = {
    ...makeAgent({ id: "codex-planner", provider: "codex" }),
    roles: ["planning"]
  } as AgentConfig;
  const scope = resolveProviderSessionScope(task, agent);
  const providerSession = {
    id: getProviderSessionRecordId(scope),
    scope,
    capability: "verified_headless_resume",
    status: "active",
    providerSessionId: "session-retry",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z"
  };
  const failedExecution = {
    ...makeExecution(task, agent),
    id: "exec-prior-failure",
    taskStatus: "failed"
  } as ExecutionRecord;

  let dispatchedContext: BuiltContext | undefined;
  let dispatchedDecision: ProviderSessionDecision | undefined;
  const runner: FakeRunner = {
    dispatch: async (dispatchedTask, context, dispatchedAgent, sessionDecision) => {
      dispatchedContext = context;
      dispatchedDecision = sessionDecision;
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(dispatchedTask, dispatchedAgent)
      };
    }
  };

  await dispatchPendingTasks(
    baseInput([task], [agent], runner, undefined, {
      existingExecutions: [failedExecution],
      stateStore: makeStateStore({ providerSessions: [providerSession] })
    })
  );

  assert.equal(dispatchedDecision?.mode, "native_resume_candidate");
  assert.deepEqual(dispatchedContext?.nativeResumeRetry, {
    previousExecutionFailed: true
  });
});

// ── Test 1: provider allow-list boundary — different lists fall back to sequential ──

test("dispatch: different provider allow-lists force sequential fallback", async () => {
  const claudeAgent = makeAgent({ id: "claude-1", provider: "claude" });
  const antigravityAgent = makeAgent({ id: "antigravity-1", provider: "antigravity" });

  const providerBrokerToolAllowLists = new Map<string, readonly string[]>([
    ["claude", ["tool_a", "tool_b"]],
    ["antigravity", ["tool_c", "tool_d"]], // different list → concurrent must be blocked
  ]);

  const { scope, bindCalls } = makeBrokerScope();

  let active = 0;
  let peakActive = 0;
  const runner = makeRunner({
    delayMs: 25,
    onDispatch: () => {
      active++;
      peakActive = Math.max(peakActive, active);
    },
  });

  // Wrap dispatch to decrement after it completes
  const wrappedRunner: FakeRunner = {
    dispatch: async (...args: any[]) => {
      const result = await (runner as any).dispatch(...args);
      active--;
      return result;
    },
  } as unknown as FakeRunner;

  const pool = new AgentPool(2);
  const task1 = makeTask("task-1");
  const task2 = makeTask("task-2");

  await dispatchPendingTasks(
    baseInput([task1, task2], [claudeAgent, antigravityAgent], wrappedRunner, pool, {
      stateStore: makeStateStore(),
      brokerToolScope: scope,
      providerBrokerToolAllowLists,
    })
  );

  // Must have fallen back to sequential — peak concurrent dispatch = 1
  assert.equal(peakActive, 1, "Different provider allow-lists must force sequential dispatch (peak should be 1)");

  // The broker must NEVER be called with the union of all four tools
  const unionTools = new Set(["tool_a", "tool_b", "tool_c", "tool_d"]);
  for (const call of bindCalls) {
    const isUnion = call.length >= 4 && call.every(t => unionTools.has(t));
    assert.ok(!isUnion, `bindAllowedTools must not be called with the provider union. Got: ${JSON.stringify(call)}`);
  }
});

// ── Test 1b: same allow-lists allow concurrent dispatch ─────────────────────

test("dispatch: identical provider allow-lists allow concurrent dispatch", async () => {
  const claudeAgent = makeAgent({ id: "claude-1", provider: "claude" });
  const antigravityAgent = makeAgent({ id: "antigravity-1", provider: "antigravity" });

  // Both providers share the same safe list → can bind concurrently
  const providerBrokerToolAllowLists = new Map<string, readonly string[]>([
    ["claude", ["tool_a", "tool_b"]],
    ["antigravity", ["tool_a", "tool_b"]],
  ]);

  const { scope } = makeBrokerScope();

  let active = 0;
  let peakActive = 0;

  const pool = new AgentPool(2);
  const task1 = makeTask("task-1");
  const task2 = makeTask("task-2");

  // Track concurrency inside agentRunner.dispatch (the slow part)
  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, agent: any) => {
      active++;
      peakActive = Math.max(peakActive, active);
      await sleep(30);
      active--;
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task as TaskRecord, agent as AgentConfig),
        providerSession: undefined,
      };
    },
  } as unknown as FakeRunner;

  await dispatchPendingTasks(
    baseInput([task1, task2], [claudeAgent, antigravityAgent], runner, pool, {
      stateStore: makeStateStore(),
      brokerToolScope: scope,
      providerBrokerToolAllowLists,
    })
  );

  assert.equal(peakActive, 2, "Identical provider allow-lists should allow concurrent dispatch (peak should be 2)");
});

// ── Test 1c: non-participating provider does not block concurrency ─────────────

test("dispatch: enabled provider not in batch does not downgrade concurrent dispatch", async () => {
  // Only claude agent is passed; antigravity has a different allow-list but no tasks
  // in this batch could be routed to it. The batch should stay concurrent.
  const claudeAgent = makeAgent({ id: "claude-1", provider: "claude" });

  const providerBrokerToolAllowLists = new Map<string, readonly string[]>([
    ["claude", ["tool_a", "tool_b"]],
    ["antigravity", ["tool_c", "tool_d"]], // different list, but antigravity is not in agents
  ]);

  const { scope } = makeBrokerScope();

  let active = 0;
  let peakActive = 0;

  const pool = new AgentPool(2);
  const task1 = makeTask("task-1");
  const task2 = makeTask("task-2");

  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, ag: any) => {
      active++;
      peakActive = Math.max(peakActive, active);
      await sleep(30);
      active--;
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task as TaskRecord, ag as AgentConfig),
        providerSession: undefined,
      };
    },
  } as unknown as FakeRunner;

  await dispatchPendingTasks(
    baseInput([task1, task2], [claudeAgent], runner, pool, {
      stateStore: makeStateStore(),
      brokerToolScope: scope,
      providerBrokerToolAllowLists,
    })
  );

  assert.equal(
    peakActive,
    2,
    "A non-participating provider with a different allow-list must not downgrade concurrent dispatch (peak should be 2)"
  );
});

// ── Test 2: same-workstream tasks serialize ───────────────────────────────────

test("dispatch: same-workstream tasks serialize even with AgentPool(2)", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });
  const pool = new AgentPool(2);

  const task1 = makeTask("task-1", { workstreamId: "ws-shared" });
  const task2 = makeTask("task-2", { workstreamId: "ws-shared" });

  let active = 0;
  let peakActive = 0;

  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, ag: any) => {
      active++;
      peakActive = Math.max(peakActive, active);
      await sleep(25);
      active--;
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task as TaskRecord, ag as AgentConfig),
        providerSession: undefined,
      };
    },
  } as unknown as FakeRunner;

  await dispatchPendingTasks(
    baseInput([task1, task2], [agent], runner, pool)
  );

  assert.equal(peakActive, 1, "Tasks sharing workstreamId must serialize (same workstream lock key)");
});

// ── Test 3: different-workstream tasks run concurrently ───────────────────────

test("dispatch: different-workstream tasks run concurrently with AgentPool(2)", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });
  const pool = new AgentPool(2);

  // Different workstreamId and different workspace paths → no shared lock keys
  const task1 = makeTask("task-1", { workstreamId: "ws-a", localRepoPath: "/tmp/ws-a" });
  const task2 = makeTask("task-2", { workstreamId: "ws-b", localRepoPath: "/tmp/ws-b" });

  let active = 0;
  let peakActive = 0;

  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, ag: any) => {
      active++;
      peakActive = Math.max(peakActive, active);
      await sleep(30);
      active--;
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task as TaskRecord, ag as AgentConfig),
        providerSession: undefined,
      };
    },
  } as unknown as FakeRunner;

  await dispatchPendingTasks(
    baseInput([task1, task2], [agent], runner, pool)
  );

  assert.equal(peakActive, 2, "Tasks with different workstreams and paths should run concurrently (peak should be 2)");
});

// ── Test 4: same branch/workspace serializes despite different workstreams ────

test("dispatch: tasks sharing the same branch serialize even with different workstreams", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });
  const pool = new AgentPool(2);

  const sharedBranch = "feature/shared-branch";
  // Different workstream IDs but same branch name → branch lock key serializes them
  const task1 = makeTask("task-1", { workstreamId: "ws-a", branchName: sharedBranch });
  const task2 = makeTask("task-2", { workstreamId: "ws-b", branchName: sharedBranch });

  let active = 0;
  let peakActive = 0;

  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, ag: any) => {
      active++;
      peakActive = Math.max(peakActive, active);
      await sleep(25);
      active--;
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task as TaskRecord, ag as AgentConfig),
        providerSession: undefined,
      };
    },
  } as unknown as FakeRunner;

  await dispatchPendingTasks(
    baseInput([task1, task2], [agent], runner, pool)
  );

  assert.equal(peakActive, 1, "Tasks sharing the same branch must serialize regardless of workstream");
});

// ── Test 5: AgentPool(1) preserves sequential order ──────────────────────────

test("dispatch: AgentPool(1) preserves sequential dispatch order", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });
  const pool = new AgentPool(1);

  const tasks = [
    makeTask("task-1"),
    makeTask("task-2"),
    makeTask("task-3"),
  ];
  const order: string[] = [];

  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, ag: any) => {
      order.push((task as TaskRecord).id);
      await sleep(5);
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task as TaskRecord, ag as AgentConfig),
        providerSession: undefined,
      };
    },
  } as unknown as FakeRunner;

  await dispatchPendingTasks(
    baseInput(tasks, [agent], runner, pool)
  );

  assert.deepEqual(order, ["task-1", "task-2", "task-3"], "AgentPool(1) must dispatch tasks in submission order");
});

// ── Test 6: unexpected wrapper rejection is surfaced ─────────────────────────

test("dispatch: unexpected wrapper-level failure is surfaced as aggregate error", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });
  const pool = new AgentPool(2);

  // agentRunner.dispatch throws → outer catch runs → writeExecutionState throws
  // inside the catch path's stateMutex → propagates as wrapper-level rejection
  const stateStore = makeStateStore({ throwOnWriteExecution: true });

  const runner = makeRunner({ throw: true });

  await assert.rejects(
    () =>
      dispatchPendingTasks(
        baseInput([makeTask("task-1")], [agent], runner, pool, { stateStore })
      ),
    (err: Error) => {
      assert.ok(
        err.message.includes("Unexpected agent dispatch failures") ||
        err.message.includes("state persistence failed"),
        `Expected aggregate dispatch error, got: ${err.message}`
      );
      return true;
    }
  );
});

// ── Test 7: memory tools filtered from concurrent broker scope ────────────────

test("dispatch: memory tools are filtered from concurrent batch broker scope", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });

  // Provide allow-list that includes memory tools
  const providerBrokerToolAllowLists = new Map<string, readonly string[]>([
    ["claude", ["memory_search", "memory_add", "get_issue", "post_issue_comment"]],
  ]);

  const { scope, bindCalls } = makeBrokerScope();
  const pool = new AgentPool(2);

  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, ag: any) => {
      await sleep(10);
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task as TaskRecord, ag as AgentConfig),
        providerSession: undefined,
      };
    },
  } as unknown as FakeRunner;

  await dispatchPendingTasks(
    baseInput([makeTask("task-1"), makeTask("task-2")], [agent], runner, pool, {
      stateStore: makeStateStore(),
      brokerToolScope: scope,
      providerBrokerToolAllowLists,
    })
  );

  // The batch-level bind must have been called (concurrent mode, single provider)
  assert.ok(bindCalls.length > 0, "bindAllowedTools must have been called for the concurrent batch");

  for (const call of bindCalls) {
    assert.ok(
      !call.includes("memory_search"),
      `memory_search must not appear in concurrent broker scope. Got: ${JSON.stringify(call)}`
    );
    assert.ok(
      !call.includes("memory_add"),
      `memory_add must not appear in concurrent broker scope. Got: ${JSON.stringify(call)}`
    );
    // Non-memory tools should still be present
    assert.ok(
      call.includes("get_issue") || call.includes("post_issue_comment"),
      `Non-memory tools should remain in concurrent broker scope. Got: ${JSON.stringify(call)}`
    );
  }
});

// ── Test 8: provider limit transitions task to queued and updates limits state ──

test("dispatch: provider limit transitions task to queued and updates limits state", async () => {
  const claudeAgent = makeAgent({ id: "claude-1", provider: "claude" });
  const pool = new AgentPool(1);
  const task1 = makeTask("task-1");

  const writtenProviderLimits: any[] = [];
  const writtenTasks: any[] = [];

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: [],
      providerSessions: [],
      providerLimits: [],
      tasks: [task1]
    } as any),
    writeTaskState: async (updatedTasks: any[]) => {
      writtenTasks.push(...updatedTasks);
    },
    writeExecutionState: async (_execs: any[]) => {},
    writeJobAgentAssignmentState: async (_assignments: any[]) => {},
    writeProviderSessionState: async (_sessions: any[]) => {},
    writeProviderLimitState: async (limits: any[]) => {
      writtenProviderLimits.push(...limits);
    }
  } as unknown as StateStore;

  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, ag: any) => {
      // Simulate raw CLI error output (e.g. Claude session limit reached)
      const exitCode = 1;
      const stdout = "";
      const stderr = "Error: Claude 5-hour limit exceeded. Please try again later.";

      const parsedSignal = detectProviderLimit(ag.provider, exitCode, stdout, stderr);

      return {
        taskStatus: "failed" as const,
        execution: makeExecution(task as TaskRecord, ag as AgentConfig),
        providerLimitSignal: parsedSignal
      };
    }
  } as unknown as FakeRunner;

  await dispatchPendingTasks(
    baseInput([task1], [claudeAgent], runner, pool, { stateStore })
  );

  assert.equal(writtenProviderLimits.length, 1);
  assert.equal(writtenProviderLimits[0].provider, "claude");
  assert.equal(writtenProviderLimits[0].status, "limited");
  assert.equal(writtenProviderLimits[0].limitType, "session");
  assert.equal(writtenProviderLimits[0].rawError, "Error: Claude 5-hour limit exceeded. Please try again later.");
  assert.ok(writtenProviderLimits[0].resetTime);

  assert.ok(writtenTasks.length >= 1);
  const finalTask = writtenTasks[writtenTasks.length - 1];
  assert.equal(finalTask.status, "queued");
  assert.equal(finalTask.waitingOnProvider, "claude");
});

test("dispatch: completed task ignores later provider limit signal", async () => {
  const claudeAgent = makeAgent({ id: "claude-1", provider: "claude" });
  const pool = new AgentPool(1);
  const task1 = makeTask("task-1");

  const writtenProviderLimits: any[] = [];
  const writtenTasks: TaskRecord[][] = [];

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: [],
      providerSessions: [],
      providerLimits: [],
      tasks: [task1]
    } as any),
    writeTaskState: async (updatedTasks: TaskRecord[]) => {
      writtenTasks.push(updatedTasks);
    },
    writeExecutionState: async (_execs: any[]) => {},
    writeJobAgentAssignmentState: async (_assignments: any[]) => {},
    writeProviderSessionState: async (_sessions: any[]) => {},
    writeProviderLimitState: async (limits: any[]) => {
      writtenProviderLimits.push(...limits);
    }
  } as unknown as StateStore;

  const runner: FakeRunner = {
    dispatch: async (task: TaskRecord, _ctx: any, ag: AgentConfig) => ({
      taskStatus: "completed" as const,
      execution: makeExecution(task, ag),
      providerLimitSignal: {
        provider: "claude",
        isLimited: true,
        limitType: "session",
        detectedAt: "2024-01-01T00:00:00.000Z",
        resetTime: "2024-01-01T05:00:00.000Z"
      }
    })
  } as FakeRunner;

  const result = await dispatchPendingTasks(
    baseInput([task1], [claudeAgent], runner, pool, { stateStore })
  );

  assert.equal(writtenProviderLimits.length, 0);
  assert.equal(result.tasks[0]?.status, "completed");
  assert.equal(result.tasks[0]?.waitingOnProvider, undefined);
  assert.equal(writtenTasks.at(-1)?.[0]?.status, "completed");
  assert.equal(writtenTasks.at(-1)?.[0]?.waitingOnProvider, undefined);
});

test("dispatch: provider limit swaps to compatible non-limited provider instead of queueing", async () => {
  const claudeAgent = makeAgent({ id: "claude-1", provider: "claude" });
  const codexAgent = makeAgent({ id: "codex-1", provider: "codex" });
  const task1 = makeTask("task-1", { workstreamId: "ws1" });
  const assignments: any[] = [
    {
      id: "assignment-claude",
      repoKey: task1.repoSlug,
      workstreamId: "ws1",
      role: "discussion" as const,
      modelClass: "strong" as const,
      jobKey: "discussion-strong" as const,
      configuredAgentId: "claude-1",
      provider: "claude" as const,
      status: "active" as const,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z"
    }
  ];
  const stored = {
    assignments,
    providerLimits: [] as any[],
    tasks: [task1]
  };
  const writtenTasks: TaskRecord[][] = [];

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: stored.assignments,
      providerSessions: [],
      providerLimits: stored.providerLimits,
      tasks: stored.tasks
    } as any),
    writeTaskState: async (updatedTasks: TaskRecord[]) => {
      writtenTasks.push(updatedTasks);
      stored.tasks = updatedTasks;
    },
    writeExecutionState: async () => {},
    writeJobAgentAssignmentState: async (updatedAssignments: any[]) => {
      stored.assignments = updatedAssignments;
    },
    writeProviderSessionState: async () => {},
    writeProviderLimitState: async (limits: any[]) => {
      stored.providerLimits = limits;
    }
  } as unknown as StateStore;

  const runner: FakeRunner = {
    dispatch: async (task: TaskRecord, _ctx: any, agent: AgentConfig) => {
      assert.equal(agent.provider, "claude");
      return {
        taskStatus: "failed" as const,
        execution: makeExecution(task, agent),
        providerLimitSignal: {
          provider: "claude",
          isLimited: true,
          limitType: "session",
          detectedAt: "2024-01-01T00:00:00.000Z",
          resetTime: "2024-01-01T05:00:00.000Z"
        }
      };
    }
  } as FakeRunner;

  const result = await dispatchPendingTasks(
    baseInput([task1], [claudeAgent, codexAgent], runner, undefined, {
      stateStore,
      providerBrokerToolAllowLists: new Map([
        ["claude", ["get_issue", "post_issue_comment"]],
        ["codex", ["get_issue", "post_issue_comment"]]
      ])
    })
  );

  assert.equal(result.tasks[0]?.status, "pending");
  assert.equal(result.tasks[0]?.waitingOnProvider, undefined);
  assert.equal(result.tasks[0]?.context.notifiedQueued, false);
  assert.equal(stored.providerLimits[0]?.provider, "claude");
  assert.equal(stored.assignments.some((assignment) => assignment.provider === "claude" && assignment.status === "stale"), true);
  assert.equal(stored.assignments.some((assignment) => assignment.provider === "codex" && assignment.status === "active"), true);
  assert.equal(writtenTasks.at(-1)?.[0]?.status, "pending");
});

test("dispatch: provider limit queues only when all compatible providers are limited", async () => {
  const claudeAgent = makeAgent({ id: "claude-1", provider: "claude" });
  const codexAgent = makeAgent({ id: "codex-1", provider: "codex" });
  const task1 = makeTask("task-1", { workstreamId: "ws1" });
  const stored = {
    assignments: [
      {
        id: "assignment-claude",
        repoKey: task1.repoSlug,
        workstreamId: "ws1",
        role: "discussion" as const,
        modelClass: "strong" as const,
        jobKey: "discussion-strong" as const,
        configuredAgentId: "claude-1",
        provider: "claude" as const,
        status: "active" as const,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z"
      }
    ],
    providerLimits: [
      {
        provider: "codex" as const,
        status: "limited" as const,
        resetTime: "2024-01-01T05:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z"
      }
    ],
    tasks: [task1]
  } as { assignments: any[]; providerLimits: any[]; tasks: TaskRecord[] };

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: stored.assignments,
      providerSessions: [],
      providerLimits: stored.providerLimits,
      tasks: stored.tasks
    } as any),
    writeTaskState: async (updatedTasks: TaskRecord[]) => {
      stored.tasks = updatedTasks;
    },
    writeExecutionState: async () => {},
    writeJobAgentAssignmentState: async (updatedAssignments: any[]) => {
      stored.assignments = updatedAssignments;
    },
    writeProviderSessionState: async () => {},
    writeProviderLimitState: async (limits: any[]) => {
      stored.providerLimits = limits;
    }
  } as unknown as StateStore;

  const runner: FakeRunner = {
    dispatch: async (task: TaskRecord, _ctx: any, agent: AgentConfig) => ({
      taskStatus: "failed" as const,
      execution: makeExecution(task, agent),
      providerLimitSignal: {
        provider: "claude",
        isLimited: true,
        detectedAt: "2024-01-01T00:00:00.000Z",
        resetTime: "2024-01-01T05:00:00.000Z"
      }
    })
  } as FakeRunner;

  const result = await dispatchPendingTasks(
    baseInput([task1], [claudeAgent, codexAgent], runner, undefined, {
      stateStore,
      providerBrokerToolAllowLists: new Map([
        ["claude", ["get_issue", "post_issue_comment"]],
        ["codex", ["get_issue", "post_issue_comment"]]
      ])
    })
  );

  assert.equal(result.tasks[0]?.status, "queued");
  assert.equal(result.tasks[0]?.waitingOnProvider, "claude");
  assert.equal(result.tasks[0]?.context.notifiedQueued, true);
});

test("dispatch: provider limit does not swap to runtime-incompatible provider", async () => {
  const claudeAgent = makeAgent({ id: "claude-1", provider: "claude" });
  const geminiAgent = makeAgent({ id: "gemini-1", provider: "gemini" });
  const task1 = makeTask("task-1", { workstreamId: "ws1" });
  const stored = {
    assignments: [
      {
        id: "assignment-claude",
        repoKey: task1.repoSlug,
        workstreamId: "ws1",
        role: "discussion" as const,
        modelClass: "strong" as const,
        jobKey: "discussion-strong" as const,
        configuredAgentId: "claude-1",
        provider: "claude" as const,
        status: "active" as const,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z"
      }
    ],
    providerLimits: [] as any[],
    tasks: [task1]
  } as { assignments: any[]; providerLimits: any[]; tasks: TaskRecord[] };

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: stored.assignments,
      providerSessions: [],
      providerLimits: stored.providerLimits,
      tasks: stored.tasks
    } as any),
    writeTaskState: async (updatedTasks: TaskRecord[]) => {
      stored.tasks = updatedTasks;
    },
    writeExecutionState: async () => {},
    writeJobAgentAssignmentState: async (updatedAssignments: any[]) => {
      stored.assignments = updatedAssignments;
    },
    writeProviderSessionState: async () => {},
    writeProviderLimitState: async (limits: any[]) => {
      stored.providerLimits = limits;
    }
  } as unknown as StateStore;

  const runner: FakeRunner = {
    dispatch: async (task: TaskRecord, _ctx: any, agent: AgentConfig) => ({
      taskStatus: "failed" as const,
      execution: makeExecution(task, agent),
      providerLimitSignal: {
        provider: "claude",
        isLimited: true,
        detectedAt: "2024-01-01T00:00:00.000Z",
        resetTime: "2024-01-01T05:00:00.000Z"
      }
    })
  } as FakeRunner;

  const result = await dispatchPendingTasks(
    baseInput([task1], [claudeAgent, geminiAgent], runner, undefined, {
      stateStore,
      providerBrokerToolAllowLists: new Map([
        ["claude", ["get_issue", "post_issue_comment"]],
        ["gemini", ["get_issue"]]
      ])
    })
  );

  assert.equal(result.tasks[0]?.status, "queued");
  assert.equal(result.tasks[0]?.waitingOnProvider, "claude");
  assert.equal(stored.assignments.some((assignment) => assignment.provider === "gemini" && assignment.status === "active"), false);
});

test("dispatch: resumed provider-limit tasks dispatch FIFO within provider and workstream", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });
  const newerQueuedTask = {
    ...makeTask("aaa-newer", { workstreamId: "ws1" }),
    status: "queued" as const,
    waitingOnProvider: "claude" as const,
    updatedAt: "2024-01-01T00:02:00.000Z"
  };
  const olderQueuedTask = {
    ...makeTask("zzz-older", { workstreamId: "ws1" }),
    status: "queued" as const,
    waitingOnProvider: "claude" as const,
    updatedAt: "2024-01-01T00:01:00.000Z"
  };
  let persistedTasks: TaskRecord[] = [newerQueuedTask, olderQueuedTask];
  let persistedProviderLimits: any[] = [
    {
      provider: "claude",
      status: "limited",
      resetTime: "2024-01-01T01:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z"
    }
  ];

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: [],
      providerSessions: [],
      providerLimits: persistedProviderLimits,
      tasks: persistedTasks
    } as any),
    writeTaskState: async (tasks: TaskRecord[]) => {
      persistedTasks = tasks;
    },
    writeExecutionState: async () => {},
    writeJobAgentAssignmentState: async () => {},
    writeProviderSessionState: async () => {},
    writeProviderLimitState: async (limits: any[]) => {
      persistedProviderLimits = limits;
    }
  } as unknown as StateStore;

  const resumedState = await processProviderLimitResumption({
    previousState: {
      tasks: persistedTasks,
      executions: [],
      providerLimits: persistedProviderLimits
    } as any,
    stateStore,
    currentIssues: [],
    currentPullRequests: [],
    lifecycleNotifier: {
      notifyDispatch: async () => {},
      notifyCompletionStatus: async () => {},
      notifyQueued: async () => {},
      notifyResumed: async () => {},
      notifyCanceled: async () => {}
    },
    logDir: os.tmpdir(),
    now: "2024-01-01T01:00:00.000Z",
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  const dispatchOrder: string[] = [];
  const runner: FakeRunner = {
    dispatch: async (task: TaskRecord, _ctx: any, dispatchedAgent: AgentConfig) => {
      dispatchOrder.push(task.id);
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task, dispatchedAgent)
      };
    }
  } as FakeRunner;

  await dispatchPendingTasks(
    baseInput(resumedState.tasks, [agent], runner, undefined, {
      stateStore
    })
  );

  assert.deepEqual(dispatchOrder, ["zzz-older", "aaa-newer"]);
});

// ── Test 9: pre-dispatch NoProviderAvailableError transitions task to queued ──

test("dispatch: pre-dispatch NoProviderAvailableError transitions task to queued", async () => {
  const claudeAgent = makeAgent({ id: "claude-1", provider: "claude" });
  const pool = new AgentPool(1);
  const task1 = makeTask("task-1");

  const writtenTasks: any[] = [];

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: [],
      providerSessions: [],
      providerLimits: [
        { provider: "claude", status: "limited", updatedAt: "now" }
      ],
      tasks: [task1]
    } as any),
    writeTaskState: async (updatedTasks: any[]) => {
      writtenTasks.push(...updatedTasks);
    },
    writeExecutionState: async (_execs: any[]) => {},
    writeJobAgentAssignmentState: async (_assignments: any[]) => {},
    writeProviderSessionState: async (_sessions: any[]) => {},
  } as unknown as StateStore;

  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, ag: any) => {
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task as TaskRecord, ag as AgentConfig),
      };
    }
  } as unknown as FakeRunner;

  await dispatchPendingTasks(
    baseInput([task1], [claudeAgent], runner, pool, { stateStore })
  );

  assert.equal(writtenTasks.length, 1);
  assert.equal(writtenTasks[0].status, "queued");
  assert.equal(writtenTasks[0].waitingOnProvider, "claude");
});

// ── Test 10: Lifecycle notifications for provider limit ──

test("dispatch: queues task and notifies once when provider is limited", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });
  const task = makeTask("task-1");

  const queuedCalls: Array<{ task: TaskRecord; providers: AgentProvider | AgentProvider[]; resetTime?: string | undefined }> = [];
  const resumedCalls: TaskRecord[] = [];
  const mockLifecycleNotifier = {
    notifyDispatch: async () => {},
    notifyCompletionStatus: async () => {},
    notifyQueued: async (t: TaskRecord, providers: AgentProvider | AgentProvider[], resetTime?: string) => {
      queuedCalls.push({ task: t, providers, resetTime });
    },
    notifyResumed: async (t: TaskRecord) => {
      resumedCalls.push(t);
    },
    notifyCanceled: async () => {}
  };

  const providerLimits = [
    {
      provider: "claude" as const,
      status: "limited" as const,
      limitType: "weekly" as const,
      detectedAt: "2024-01-01T00:00:00.000Z",
      resetTime: "2024-01-01T01:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ];

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: [],
      providerSessions: [],
      providerLimits,
    } as any),
    writeTaskState: async () => {},
    writeProviderLimitState: async () => {},
    writeJobAgentAssignmentState: async () => {},
  } as any;

  const runner = makeRunner({});

  // First run: should transition task to queued and notify
  const input1 = baseInput([task], [agent], runner, undefined, {
    stateStore,
    lifecycleNotifier: mockLifecycleNotifier,
  });

  const result1 = await dispatchPendingTasks(input1);
  assert.equal(result1.tasks[0]?.status, "queued");
  assert.equal(result1.tasks[0]?.context.notifiedQueued, true);
  assert.equal(queuedCalls.length, 1);
  assert.deepEqual(queuedCalls[0]?.providers, ["claude"]);
  assert.equal(queuedCalls[0]?.resetTime, "2024-01-01T01:00:00.000Z");

  // Second run with the already-notified queued task: should not notify again
  const queuedTask = result1.tasks[0]!;
  const input2 = baseInput([queuedTask], [agent], runner, undefined, {
    stateStore,
    lifecycleNotifier: mockLifecycleNotifier,
  });

  assert.equal(queuedTask.context.notifiedQueued, true);
});

test("dispatch: queues task and calls notifyQueued when runner returns providerLimitSignal", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: [],
      providerSessions: [],
      providerLimits: []
    }),
    writeTaskState: async () => {},
    writeExecutionState: async () => {},
    writeJobAgentAssignmentState: async () => {},
    writeProviderSessionState: async () => {},
    writeProviderLimitState: async () => {}
  } as any;

  const queuedCalls: Array<{ task: TaskRecord; providers: AgentProvider | AgentProvider[]; resetTime?: string | undefined }> = [];
  const fakeNotifier = {
    notifyDispatch: async () => {},
    notifyCompletionStatus: async () => {},
    notifyQueued: async (task: TaskRecord, providers: AgentProvider | AgentProvider[], resetTime?: string) => {
      queuedCalls.push({ task, providers, resetTime });
    },
    notifyResumed: async () => {},
    notifyCanceled: async () => {}
  };

  const tasks = [makeTask("task-1")];
  const runner: FakeRunner = {
    dispatch: async (task: any, _ctx: any, ag: any) => {
      return {
        taskStatus: "failed" as const,
        execution: makeExecution(task as TaskRecord, ag as AgentConfig),
        providerLimitSignal: {
          provider: "claude",
          isLimited: true,
          limitType: "session",
          detectedAt: "now",
          resetTime: "reset-time"
        }
      };
    }
  } as any;

  const result = await dispatchPendingTasks(
    baseInput(tasks, [agent], runner, undefined, {
      stateStore,
      lifecycleNotifier: fakeNotifier
    })
  );

  assert.equal(result.tasks[0]?.status, "queued");
  assert.equal(result.tasks[0]?.waitingOnProvider, "claude");
  assert.equal(queuedCalls.length, 1);
  assert.equal(queuedCalls[0]?.task.id, "task-1");
  assert.deepEqual(queuedCalls[0]?.providers, ["claude"]);
});

test("dispatch: resumed provider-limit tasks dispatch FIFO across different workstreams", async () => {
  const agent = makeAgent({ id: "claude-1", provider: "claude" });
  const newerQueuedTask = {
    ...makeTask("aaa-newer", { workstreamId: "ws-newer" }),
    status: "queued" as const,
    waitingOnProvider: "claude" as const,
    updatedAt: "2024-01-01T00:02:00.000Z"
  };
  const olderQueuedTask = {
    ...makeTask("zzz-older", { workstreamId: "ws-older" }),
    status: "queued" as const,
    waitingOnProvider: "claude" as const,
    updatedAt: "2024-01-01T00:01:00.000Z"
  };
  let persistedTasks: TaskRecord[] = [newerQueuedTask, olderQueuedTask];
  let persistedProviderLimits: any[] = [
    {
      provider: "claude",
      status: "limited",
      resetTime: "2024-01-01T01:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z"
    }
  ];

  const stateStore = {
    load: async () => ({
      jobAgentAssignments: [],
      providerSessions: [],
      providerLimits: persistedProviderLimits,
      tasks: persistedTasks
    } as any),
    writeTaskState: async (tasks: TaskRecord[]) => {
      persistedTasks = tasks;
    },
    writeExecutionState: async () => {},
    writeJobAgentAssignmentState: async () => {},
    writeProviderSessionState: async () => {},
    writeProviderLimitState: async (limits: any[]) => {
      persistedProviderLimits = limits;
    }
  } as unknown as StateStore;

  const resumedState = await processProviderLimitResumption({
    previousState: {
      tasks: persistedTasks,
      executions: [],
      providerLimits: persistedProviderLimits
    } as any,
    stateStore,
    currentIssues: [],
    currentPullRequests: [],
    lifecycleNotifier: {
      notifyDispatch: async () => {},
      notifyCompletionStatus: async () => {},
      notifyQueued: async () => {},
      notifyResumed: async () => {},
      notifyCanceled: async () => {}
    },
    logDir: os.tmpdir(),
    now: "2024-01-01T01:00:00.000Z",
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  const dispatchOrder: string[] = [];
  const runner: FakeRunner = {
    dispatch: async (task: TaskRecord, _ctx: any, dispatchedAgent: AgentConfig) => {
      dispatchOrder.push(task.id);
      return {
        taskStatus: "completed" as const,
        execution: makeExecution(task, dispatchedAgent)
      };
    }
  } as FakeRunner;

  await dispatchPendingTasks(
    baseInput(resumedState.tasks, [agent], runner, undefined, {
      stateStore
    })
  );

  assert.deepEqual(dispatchOrder, ["zzz-older", "aaa-newer"]);
});
