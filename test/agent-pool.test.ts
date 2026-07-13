import * as assert from "node:assert/strict";
import { test } from "node:test";
import { AgentPool, KeyedLock, Mutex, deriveExecutionLockKeys } from "../src/agents/pool.js";
import type { TaskRecord } from "../src/tasks/types.js";

// ── Mutex ────────────────────────────────────────────────────────────────────

test("Mutex: runExclusive serializes concurrent calls", async () => {
  const mutex = new Mutex();
  const order: number[] = [];

  const task = (id: number, delayMs: number) =>
    mutex.runExclusive(async () => {
      order.push(id);
      await sleep(delayMs);
      order.push(-id);
    });

  // Start concurrently; task 1 enters first (faster by 1 tick)
  await Promise.all([task(1, 10), task(2, 0), task(3, 0)]);

  // Each task must complete before the next starts
  assert.equal(order[0], 1);
  assert.equal(order[1], -1);
  assert.equal(order[2], 2);
  assert.equal(order[3], -2);
  assert.equal(order[4], 3);
  assert.equal(order[5], -3);
});

test("Mutex: releases on thrown error", async () => {
  const mutex = new Mutex();

  await assert.rejects(
    () => mutex.runExclusive(async () => { throw new Error("boom"); }),
    /boom/
  );

  // Mutex must be released so a second call can proceed
  let ran = false;
  await mutex.runExclusive(async () => { ran = true; });
  assert.ok(ran);
});

// ── AgentPool ────────────────────────────────────────────────────────────────

test("AgentPool: isConcurrent is false when maxConcurrent=1", () => {
  const pool = new AgentPool(1);
  assert.equal(pool.isConcurrent, false);
  assert.equal(pool.maxConcurrent, 1);
});

test("AgentPool: isConcurrent is true when maxConcurrent>1", () => {
  const pool = new AgentPool(3);
  assert.equal(pool.isConcurrent, true);
  assert.equal(pool.maxConcurrent, 3);
});

test("AgentPool: clamps maxConcurrent to minimum of 1", () => {
  const pool = new AgentPool(0);
  assert.equal(pool.maxConcurrent, 1);
});

test("AgentPool: semaphore limits concurrent slots", async () => {
  const pool = new AgentPool(2);
  let active = 0;
  let peakActive = 0;

  const runTask = () =>
    pool.runWithSlot(async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await sleep(20);
      active -= 1;
    });

  await Promise.all([runTask(), runTask(), runTask(), runTask()]);

  assert.equal(peakActive, 2, "No more than 2 tasks should run simultaneously");
  assert.equal(active, 0, "All tasks should have finished");
});

test("AgentPool: all tasks eventually complete despite slot limit", async () => {
  const pool = new AgentPool(2);
  const completed: number[] = [];

  await Promise.all(
    [1, 2, 3, 4, 5].map(id =>
      pool.runWithSlot(async () => {
        await sleep(5);
        completed.push(id);
      })
    )
  );

  assert.deepEqual(completed.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("AgentPool: slot is released on error", async () => {
  const pool = new AgentPool(1);
  let errorCaught = false;

  try {
    await pool.runWithSlot(async () => { throw new Error("task error"); });
  } catch {
    errorCaught = true;
  }

  assert.ok(errorCaught);

  // Slot must be free; this should not deadlock
  let ran = false;
  await pool.runWithSlot(async () => { ran = true; });
  assert.ok(ran);
});

test("AgentPool: cap=1 produces sequential ordering", async () => {
  const pool = new AgentPool(1);
  const order: number[] = [];

  await Promise.all(
    [1, 2, 3].map(id =>
      pool.runWithSlot(async () => {
        order.push(id);
        await sleep(5);
      })
    )
  );

  // With cap=1 tasks run one at a time in the order they were submitted
  assert.deepEqual(order, [1, 2, 3]);
});

test("AgentPool: stateMutex is shared across all tasks using the pool", async () => {
  const pool = new AgentPool(3);
  const events: string[] = [];

  const task = (id: string) =>
    pool.runWithSlot(() =>
      pool.stateMutex.runExclusive(async () => {
        events.push(`enter:${id}`);
        await sleep(10);
        events.push(`exit:${id}`);
      })
    );

  await Promise.all([task("a"), task("b"), task("c")]);

  // Pairs must never interleave
  for (let i = 0; i < events.length; i += 2) {
    const enter = events[i]!;
    const exit = events[i + 1]!;
    const id = enter.split(":")[1];
    assert.equal(enter, `enter:${id}`);
    assert.equal(exit, `exit:${id}`);
  }
});

// ── KeyedLock ────────────────────────────────────────────────────────────────

test("KeyedLock: same key serializes callers", async () => {
  const lock = new KeyedLock();
  const events: string[] = [];

  const run = async (id: string) => {
    const release = await lock.acquire("shared");
    try {
      events.push(`enter:${id}`);
      await sleep(10);
      events.push(`exit:${id}`);
    } finally {
      release();
    }
  };

  await Promise.all([run("a"), run("b"), run("c")]);

  // Each enter must be immediately followed by the matching exit
  for (let i = 0; i < events.length; i += 2) {
    const enter = events[i]!;
    const exit = events[i + 1]!;
    const id = enter.split(":")[1];
    assert.equal(enter, `enter:${id}`);
    assert.equal(exit, `exit:${id}`);
  }
});

test("KeyedLock: different keys do not block each other", async () => {
  const lock = new KeyedLock();
  let maxConcurrent = 0;
  let active = 0;

  const run = async (key: string) => {
    const release = await lock.acquire(key);
    try {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await sleep(20);
      active -= 1;
    } finally {
      release();
    }
  };

  // Three different keys: all should run concurrently
  await Promise.all([run("key-a"), run("key-b"), run("key-c")]);

  assert.equal(maxConcurrent, 3, "All three tasks with different keys should run concurrently");
});

test("KeyedLock: acquireAll releases on error", async () => {
  const lock = new KeyedLock();

  const release = await lock.acquireAll(["x", "y"]);

  // Both x and y should now be held; new acquirer should wait
  let xAcquired = false;
  const pending = lock.acquire("x").then(() => { xAcquired = true; return () => {}; });

  // Release all at once
  release();
  await pending;
  assert.ok(xAcquired, "Lock on x should be acquirable after release");
});

test("KeyedLock: acquireAll deduplicates keys", async () => {
  const lock = new KeyedLock();
  const events: string[] = [];

  // acquireAll with duplicate keys should not deadlock
  const release = await lock.acquireAll(["a", "a", "b", "b"]);
  events.push("acquired");
  release();
  events.push("released");

  assert.deepEqual(events, ["acquired", "released"]);
});

test("KeyedLock: acquireAll sorted order prevents deadlock", async () => {
  // Task 1 wants [a, b], task 2 wants [b, a] — without sorting, classic deadlock.
  // acquireAll must sort alphabetically so both always acquire a→b.
  const lock = new KeyedLock();
  const completed: number[] = [];

  const run = async (id: number, keys: string[]) => {
    const release = await lock.acquireAll(keys);
    try {
      await sleep(10);
      completed.push(id);
    } finally {
      release();
    }
  };

  // Opposite key order to maximise deadlock probability if sorting is broken
  await Promise.all([run(1, ["a", "b"]), run(2, ["b", "a"])]);
  assert.deepEqual(completed.sort(), [1, 2]);
});

// ── deriveExecutionLockKeys ───────────────────────────────────────────────────

test("deriveExecutionLockKeys: read-only task with no workstream/branch/path yields empty keys", () => {
  const task = makeTask({ workstreamId: undefined, branchName: undefined, localRepoPath: undefined });
  assert.deepEqual(deriveExecutionLockKeys(task), []);
});

test("deriveExecutionLockKeys: workstream-only task yields workstream key", () => {
  const task = makeTask({ workstreamId: "ws-123", branchName: undefined, localRepoPath: undefined });
  assert.deepEqual(deriveExecutionLockKeys(task), ["workstream:ws-123"]);
});

test("deriveExecutionLockKeys: all three fields yield three keys", () => {
  const task = makeTask({
    workstreamId: "ws-1",
    branchName: "feature/foo",
    localRepoPath: "/tmp/repo"
  });
  const keys = deriveExecutionLockKeys(task);
  assert.ok(keys.includes("workstream:ws-1"));
  assert.ok(keys.includes("branch:test-repo:feature/foo"));
  assert.ok(keys.includes("workspace:/tmp/repo"));
});

test("deriveExecutionLockKeys: executionCwdByTaskId overrides localRepoPath for workspace key", () => {
  const task = makeTask({ workstreamId: undefined, branchName: undefined, localRepoPath: "/original" });
  const overrides = new Map([["task-1", "/override"]]);
  const keys = deriveExecutionLockKeys(task, overrides);
  assert.ok(keys.includes("workspace:/override"));
  assert.ok(!keys.includes("workspace:/original"));
});

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeTask(overrides: {
  workstreamId?: string | undefined;
  branchName?: string | undefined;
  localRepoPath?: string | undefined;
}): TaskRecord {
  return {
    id: "task-1",
    kind: "triage_issue",
    status: "pending",
    repoId: "repo-1",
    repoSlug: "test-repo",
    relevant: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...(overrides.workstreamId !== undefined ? { workstreamId: overrides.workstreamId } : {}),
    context: {
      ...(overrides.branchName !== undefined ? { branchName: overrides.branchName } : {}),
      ...(overrides.localRepoPath !== undefined ? { localRepoPath: overrides.localRepoPath } : {})
    }
  } as unknown as TaskRecord;
}
