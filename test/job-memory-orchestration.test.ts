import * as assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { dispatchPendingTasks } from "../src/agents/service.js";
import { resolveJobMemoryScope, getJobMemoryBankId } from "../src/memory/scope.js";
import { JsonJobMemoryStore } from "../src/memory/json-store.js";
import { JobMemoryToolService } from "../src/memory/tool-service.js";
import { DefaultContextBuilder } from "../src/context/types.js";
import { workflowRegistry } from "../src/workflows/registry.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { AgentConfig } from "../src/config/types.js";
import type { BuiltContext } from "../src/context/types.js";

describe("Job Memory Orchestration", () => {
  let tmpDir: string;
  let stateStore: any;
  let memoryStore: JsonJobMemoryStore;
  let toolService: JobMemoryToolService;

  const agent: AgentConfig = {
    id: "agent-1",
    provider: "codex",
    modelClass: "strong",
    roles: ["planning"],
    enabled: true,
    command: "run"
  };

  const task: TaskRecord = {
    id: "task-1",
    kind: "write_plan",
    repoSlug: "owner/repo",
    workstreamId: "ws-1",
    status: "pending",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: "repo-1",
    repoName: "repo",
    sourceKind: "issue",
    sourceId: "issue-1",
    sourceUrl: "url",
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: "owner/repo",
      labels: [],
      instruction: "do it"
    },
    createdAt: "2026-05-24T12:00:00Z",
    updatedAt: "2026-05-24T12:00:00Z"
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-orch-memory-test-"));
    stateStore = {
      load: async () => ({ jobAgentAssignments: [] } as any),
      writeTaskState: async () => {},
      writeExecutionState: async () => {},
      writeJobAgentAssignmentState: async () => {}
    };
    memoryStore = new JsonJobMemoryStore({ filePath: path.join(tmpDir, "memory.json") });
    toolService = new JobMemoryToolService(memoryStore, { info: () => {}, warn: () => {} });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("dispatch binds scope and injects memory into prompt", async () => {
    // 1. Add some memory manually first
    const scope = { repoKey: "owner/repo", workstreamId: "ws-1", job: "planning", modelClass: "strong" } as any;
    await memoryStore.add(scope, "backburner:repo:owner/repo:workstream:ws-1:job:planning:model:strong", "prior-task", {
      type: "decision",
      text: "Prior decision"
    });

    let capturedContext: BuiltContext | undefined;
    const agentRunner = {
      async dispatch(t: TaskRecord, context: BuiltContext) {
        capturedContext = context;
        return {
          taskStatus: "completed",
          execution: { id: "exec-1", endedAt: "now" }
        } as any;
      }
    };

    await dispatchPendingTasks({
      tasks: [task],
      agents: [agent],
      existingExecutions: [],
      stateStore,
      logDir: tmpDir,
      agentRunner,
      jobMemoryRuntime: { store: memoryStore, toolService }
    });

    assert.ok(capturedContext);
    assert.ok(capturedContext.memoryBackground?.includes("Prior decision"));
    assert.ok(capturedContext.memoryBackground?.includes("Current GitHub and repository state are authoritative"));
  });

  test("memory tools can be used during dispatch", async () => {
    const agentRunner = {
      async dispatch(t: TaskRecord, context: BuiltContext) {
        // Try to use the tool service while bound
        await toolService.callTool("memory_add", { type: "fact", text: "New fact" });
        return {
          taskStatus: "completed",
          execution: { id: "exec-1", endedAt: "now" }
        } as any;
      }
    };

    await dispatchPendingTasks({
      tasks: [task],
      agents: [agent],
      existingExecutions: [],
      stateStore,
      logDir: tmpDir,
      agentRunner,
      jobMemoryRuntime: { store: memoryStore, toolService }
    });

    // Verify memory was added
    const bankId = "backburner:repo:owner/repo:workstream:ws-1:job:planning:model:strong";
    const entries = await memoryStore.search(bankId, { query: "New fact" });
    assert.equal(entries.length, 1);
  });

  test("different scope task does not see memory", async () => {
    // 1. Add memory for scope 1
    const scope1 = { repoKey: "owner/repo", workstreamId: "ws-1", job: "planning", modelClass: "strong" } as any;
    await memoryStore.add(scope1, "backburner:repo:owner/repo:workstream:ws-1:job:planning:model:strong", "prior-task", {
      type: "decision",
      text: "Scope 1 memory"
    });

    // 2. Dispatch task for scope 2 (different workstream)
    const task2 = { ...task, id: "task-2", workstreamId: "ws-2" };

    let capturedContext: BuiltContext | undefined;
    const agentRunner = {
      async dispatch(t: TaskRecord, context: BuiltContext) {
        capturedContext = context;
        return {
          taskStatus: "completed",
          execution: { id: "exec-2", endedAt: "now" }
        } as any;
      }
    };

    await dispatchPendingTasks({
      tasks: [task2],
      agents: [agent],
      existingExecutions: [],
      stateStore,
      logDir: tmpDir,
      agentRunner,
      jobMemoryRuntime: { store: memoryStore, toolService }
    });

    assert.ok(capturedContext);
    assert.equal(capturedContext.memoryBackground, undefined);
  });

  test("does not automatically capture stdout into memory", async () => {
    const agentRunner = {
      async dispatch() {
        // This task does NOT call memory_add
        return {
          taskStatus: "completed",
          execution: { id: "exec-1", endedAt: "now" }
        } as any;
      }
    };

    await dispatchPendingTasks({
      tasks: [task],
      agents: [agent],
      existingExecutions: [],
      stateStore,
      logDir: tmpDir,
      agentRunner,
      jobMemoryRuntime: { store: memoryStore, toolService }
    });

    const results = await memoryStore.search(getJobMemoryBankId(resolveJobMemoryScope(task, agent)), {});
    assert.equal(results.length, 0);
  });
});
