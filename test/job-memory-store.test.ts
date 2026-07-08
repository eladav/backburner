import * as assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { resolveJobMemoryScope, getJobMemoryBankId } from "../src/memory/scope.js";
import { JsonJobMemoryStore } from "../src/memory/json-store.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { AgentConfig } from "../src/config/types.js";
import type { JobMemoryScope } from "../src/memory/types.js";

describe("Job Memory Scope", () => {
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
    context: { repoIdentifier: "owner/repo", labels: [], instruction: "do it" },
    createdAt: "now",
    updatedAt: "now"
  };

  const agentConfig: AgentConfig = {
    id: "agent-1",
    provider: "codex",
    modelClass: "strong",
    roles: ["planning"],
    enabled: true,
    command: "run"
  };

  test("resolves scope correctly", () => {
    const scope = resolveJobMemoryScope(task, agentConfig);
    assert.deepEqual(scope, {
      repoKey: "owner/repo",
      workstreamId: "ws-1",
      job: "planning",
      modelClass: "strong"
    });
  });

  test("fails if workstreamId is missing", () => {
    const taskWithoutWs = { ...task, workstreamId: undefined };
    assert.throws(() => resolveJobMemoryScope(taskWithoutWs, agentConfig), {
      message: /Memory access requires a workstreamId/
    });
  });

  test("fails if model class mismatches", () => {
    const cheapAgent = { ...agentConfig, modelClass: "cheap" as const };
    // task.kind is "write_plan" which expects "strong"
    assert.throws(() => resolveJobMemoryScope(task, cheapAgent), {
      message: /Model class mismatch for task task-1: agent model class is cheap, but workflow definition requires strong/
    });
  });

  test("generates canonical bank ID", () => {
    const scope: JobMemoryScope = {
      repoKey: "owner/repo",
      workstreamId: "ws-1",
      job: "planning",
      modelClass: "strong"
    };
    const bankId = getJobMemoryBankId(scope);
    assert.equal(bankId, "backburner:repo:owner/repo:workstream:ws-1:job:planning:model:strong");
  });
});

describe("JsonJobMemoryStore", () => {
  let tmpDir: string;
  let filePath: string;
  let store: JsonJobMemoryStore;

  const scope1: JobMemoryScope = {
    repoKey: "owner/repo",
    workstreamId: "ws-1",
    job: "planning",
    modelClass: "strong"
  };
  const bank1 = getJobMemoryBankId(scope1);

  const scope2: JobMemoryScope = {
    repoKey: "owner/repo",
    workstreamId: "ws-2",
    job: "implementation",
    modelClass: "cheap"
  };
  const bank2 = getJobMemoryBankId(scope2);

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aog-memory-test-"));
    filePath = path.join(tmpDir, "memory.json");
    store = new JsonJobMemoryStore({
      filePath,
      generateId: () => "id-1",
      now: () => "2026-05-24T12:00:00Z"
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("adds and searches memory", async () => {
    await store.add(scope1, bank1, "task-1", {
      type: "decision",
      text: "Use XState for workstreams"
    });

    const results = await store.search(bank1, { query: "XState" });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.text, "Use XState for workstreams");
    assert.equal(results[0]!.type, "decision");
    assert.equal(results[0]!.bankId, bank1);
    assert.deepEqual(results[0]!.scope, scope1);
  });

  test("isolates memory by bank", async () => {
    await store.add(scope1, bank1, "task-1", {
      type: "decision",
      text: "Memory for bank 1"
    });

    await store.add(scope2, bank2, "task-2", {
      type: "fact",
      text: "Memory for bank 2"
    });

    const results1 = await store.search(bank1, {});
    assert.equal(results1.length, 1);
    assert.equal(results1[0]!.text, "Memory for bank 1");

    const results2 = await store.search(bank2, {});
    assert.equal(results2.length, 1);
    assert.equal(results2[0]!.text, "Memory for bank 2");
  });

  test("filters by type", async () => {
    await store.add(scope1, bank1, "task-1", { type: "decision", text: "T1" });
    await store.add(scope1, bank1, "task-1", { type: "risk", text: "T2" });

    const results = await store.search(bank1, { type: "decision" });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.text, "T1");
  });

  test("limits results and sorts by recency", async () => {
    let count = 0;
    const timeStore = new JsonJobMemoryStore({
      filePath,
      now: () => `2026-05-24T12:00:0${count++}Z`
    });

    await timeStore.add(scope1, bank1, "task-1", { type: "decision", text: "Oldest" });
    await timeStore.add(scope1, bank1, "task-1", { type: "decision", text: "Middle" });
    await timeStore.add(scope1, bank1, "task-1", { type: "decision", text: "Newest" });

    const results = await timeStore.search(bank1, { limit: 2 });
    assert.equal(results.length, 2);
    assert.equal(results[0]!.text, "Newest");
    assert.equal(results[1]!.text, "Middle");
  });

  test("persists to file", async () => {
    await store.add(scope1, bank1, "task-1", { type: "decision", text: "Persisted" });

    const newStore = new JsonJobMemoryStore({ filePath });
    const results = await newStore.search(bank1, {});
    assert.equal(results.length, 1);
    assert.equal(results[0]!.text, "Persisted");
  });
});
