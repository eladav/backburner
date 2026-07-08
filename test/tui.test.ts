import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { RuntimeStatusTracker } from "../src/cli/tui/tracker.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { RunSummary, shouldUseRuntimeStatusScreen, SerializedCycleRunner } from "../src/cli/run.js";

const sampleTask = (kind: string, id: string): TaskRecord => {
  return {
    id,
    kind: kind as any,
    status: "pending",
    executionPermission: "check_required" as any,
    handoffPolicy: "always" as any,
    repoId: "repo123",
    repoName: "web-api",
    repoSlug: "acme/web-api",
    sourceKind: "issue",
    sourceId: "issue456",
    sourceUrl: "https://github.com/acme/web-api/issues/456",
    relevant: true,
    reason: "test",
    summary: "implement api feature",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    context: {
      repoIdentifier: "acme/web-api",
      labels: [],
      instruction: "do it"
    }
  };
};

const sampleSummary = (): RunSummary => {
  return {
    command: "run",
    codeRoot: "/root",
    managementDir: "/mgmt",
    outputsDir: "/out",
    stateDir: "/state",
    logDir: "/log",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 10,
    pullRequestCount: 5,
    commentCount: 20,
    taskCount: 1,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 1,
    failedTaskCount: 0,
    executionCount: 1,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [],
    tasks: []
  };
};

describe("RuntimeStatusTracker", () => {
  it("initializes with default status and counters", () => {
    const tracker = new RuntimeStatusTracker(3);
    const model = tracker.getModel();

    assert.equal(model.status, "idle");
    assert.equal(model.repos, 3);
    assert.equal(model.readiness, "ok");
    assert.equal(model.cycleNo, "—");
    assert.equal(model.opText, "no active operation");
  });

  it("handles cycle start", () => {
    const tracker = new RuntimeStatusTracker(2);
    tracker.onCycleStart(5);
    const model = tracker.getModel();

    assert.equal(model.status, "syncing");
    assert.equal(model.cycleNo, 5);
    assert.equal(model.opText, "reading GitHub state");
  });

  it("handles repo sync start", () => {
    const tracker = new RuntimeStatusTracker(2);
    tracker.onRepoSyncStart("owner/repo");
    const model = tracker.getModel();

    assert.equal(model.status, "syncing");
    assert.equal(model.opText, "syncing repository");
    assert.equal(model.opTarget, "owner/repo");
  });

  it("handles task start", () => {
    const tracker = new RuntimeStatusTracker(2);
    const task = sampleTask("implement_plan", "task-1");
    tracker.onTaskStart(task);
    const model = tracker.getModel();

    assert.equal(model.status, "executing");
    assert.equal(model.opText, "running implementation agent");
    assert.equal(model.opTarget, "issue #456 · acme/web-api");
  });

  it("handles cycle success with idle state", () => {
    const tracker = new RuntimeStatusTracker(2);
    tracker.onCycleStart(1);
    const summary = sampleSummary();
    tracker.onCycleSuccess(summary, []);
    const model = tracker.getModel();

    assert.equal(model.status, "idle");
    assert.equal(model.readiness, "ok");
    assert.equal(model.cycleGlyph, "✓");
    assert.equal(model.cycleText, "completed 1 task");
  });

  it("handles cycle success with waiting state", () => {
    const tracker = new RuntimeStatusTracker(2);
    tracker.onCycleStart(1);
    const summary = sampleSummary();
    summary.completedTaskCount = 0; // no agents dispatched

    const waitingWorkstream = {
      id: "issue-789",
      repoKey: "acme/web-api",
      origin: { type: "issue", number: 789 } as any,
      linkedIssueNumber: 789,
      linkedPrs: [],
      phase: "plan_feedback" as const,
      attention: "idle" as const,
      status: "open" as const,
      resolution: "unresolved" as const
    };

    tracker.onCycleSuccess(summary, [waitingWorkstream]);
    const model = tracker.getModel();

    assert.equal(model.status, "waiting");
    assert.equal(model.opText, "awaiting plan approval/review");
    assert.equal(model.opTarget, "issue #789 · acme/web-api");
  });

  it("handles cycle failure", () => {
    const tracker = new RuntimeStatusTracker(2);
    tracker.onCycleStart(1);
    const err = new Error("Failed to load config file backburner.json");
    tracker.onCycleFailure(err);
    const model = tracker.getModel();

    assert.equal(model.status, "blocked");
    assert.equal(model.readiness, "blocking problems");
    assert.equal(model.opSub, "Backburner paused — configuration invalid");
    assert.equal(model.cycleGlyph, "✗");
    assert.equal(model.cycleText, "Failed to load config file backburner.json");
  });
});

describe("TUI Command Routing & Lifecycle", () => {
  describe("shouldUseRuntimeStatusScreen", () => {
    it("detects routing correctly based on TTY and flags", () => {
      const originalStdoutTTY = process.stdout.isTTY;
      const originalStdinTTY = process.stdin.isTTY;

      try {
        // Test Case: Both are TTY, no flags -> true
        process.stdout.isTTY = true;
        process.stdin.isTTY = true;
        assert.equal(shouldUseRuntimeStatusScreen([]), true);

        // Test Case: --headless flag -> false
        assert.equal(shouldUseRuntimeStatusScreen(["--headless"]), false);

        // Test Case: --once flag -> false
        assert.equal(shouldUseRuntimeStatusScreen(["--once"]), false);

        // Test Case: Non-TTY stdout -> false
        process.stdout.isTTY = false;
        process.stdin.isTTY = true;
        assert.equal(shouldUseRuntimeStatusScreen([]), false);

        // Test Case: Non-TTY stdin -> false
        process.stdout.isTTY = true;
        process.stdin.isTTY = false;
        assert.equal(shouldUseRuntimeStatusScreen([]), false);

        // Test Case: Both non-TTY -> false
        process.stdout.isTTY = false;
        process.stdin.isTTY = false;
        assert.equal(shouldUseRuntimeStatusScreen([]), false);
      } finally {
        process.stdout.isTTY = originalStdoutTTY;
        process.stdin.isTTY = originalStdinTTY;
      }
    });
  });

  describe("SerializedCycleRunner", () => {
    it("prevents overlapping cycles and runs manual refreshes sequentially", async () => {
      let cycleCount = 0;
      let resolveCycle: any = null;

      const runCycleFn = async () => {
        cycleCount++;
        await new Promise<void>((resolve) => {
          resolveCycle = resolve;
        });
      };

      let nextScheduled = false;
      const scheduleNextCycleFn = () => {
        nextScheduled = true;
      };

      const runner = new SerializedCycleRunner(runCycleFn, scheduleNextCycleFn);

      // 1. Start initial run
      const initialPromise = runner.run("initial");
      assert.equal(cycleCount, 1);
      assert.ok(resolveCycle !== null);

      // 2. Try starting another cycle while running (should be ignored)
      const secondPromise = runner.run("scheduled");
      assert.equal(cycleCount, 1);

      // 3. Request manual refresh while running
      await runner.run("manual"); 
      assert.equal(cycleCount, 1);

      // 4. Complete the first cycle
      const firstResolve = resolveCycle!;
      resolveCycle = null;
      firstResolve();
      await initialPromise;

      // Because refresh was requested, it immediately starts the manual cycle
      assert.equal(cycleCount, 2);
      assert.ok(resolveCycle !== null);

      // Complete the second cycle
      const secondResolve = resolveCycle!;
      resolveCycle = null;
      secondResolve();
      
      // Allow async finally block to complete
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      assert.equal(nextScheduled, true);
    });

    it("clears stale scheduled timers when a cycle runs, when stopped, or when setTimer is called", async () => {
      let cycleCount = 0;
      let resolveCycle: any = null;

      const runCycleFn = async () => {
        cycleCount++;
        await new Promise<void>((resolve) => {
          resolveCycle = resolve;
        });
      };

      let nextScheduledCount = 0;
      const scheduleNextCycleFn = () => {
        nextScheduledCount++;
      };

      const runner = new SerializedCycleRunner(runCycleFn, scheduleNextCycleFn);

      // 1. Initial run and completion
      const p1 = runner.run("initial");
      resolveCycle();
      await p1;

      // Schedule the next cycle
      let timerFired = false;
      const timer = setTimeout(() => {
        timerFired = true;
        void runner.run("scheduled");
      }, 50);
      runner.setTimer(timer);

      // 2. Perform a manual refresh before the scheduled timer fires
      resolveCycle = null;
      const p2 = runner.run("manual"); // This starts the manual run immediately, and should clear the scheduled timer!
      
      // Complete manual run
      resolveCycle();
      await p2;

      // Let's wait more than 50ms to verify the old timer was cleared and doesn't fire
      await new Promise<void>((resolve) => setTimeout(resolve, 60));

      // The old scheduled run should not have fired or incremented cycleCount
      assert.equal(timerFired, false);
      assert.equal(cycleCount, 2); // 1 initial + 1 manual

      // 3. Test setTimer overrides existing timer
      let timer2Fired = false;
      const timer2 = setTimeout(() => {
        timer2Fired = true;
      }, 100);
      runner.setTimer(timer2);

      let timer3Fired = false;
      const timer3 = setTimeout(() => {
        timer3Fired = true;
      }, 100);
      runner.setTimer(timer3); // This should clear timer2!

      await new Promise<void>((resolve) => setTimeout(resolve, 110));
      assert.equal(timer2Fired, false);
      assert.equal(timer3Fired, true);

      // 4. Test stop clears pending timers
      let timer4Fired = false;
      const timer4 = setTimeout(() => {
        timer4Fired = true;
      }, 100);
      runner.setTimer(timer4);
      runner.stop(); // This should clear timer4!

      await new Promise<void>((resolve) => setTimeout(resolve, 110));
      assert.equal(timer4Fired, false);
    });
  });

  describe("tracker wording", () => {
    it("formats wording accurately for completed/dispatched tasks", () => {
      const tracker = new RuntimeStatusTracker(2);
      const summary = sampleSummary();

      // Case 1: completed only
      summary.dispatchedTaskCount = 0;
      summary.completedTaskCount = 3;
      tracker.onCycleSuccess(summary, []);
      assert.equal(tracker.getModel().cycleText, "completed 3 tasks");

      summary.completedTaskCount = 1;
      tracker.onCycleSuccess(summary, []);
      assert.equal(tracker.getModel().cycleText, "completed 1 task");

      // Case 2: dispatched only
      summary.completedTaskCount = 0;
      summary.dispatchedTaskCount = 2;
      tracker.onCycleSuccess(summary, []);
      assert.equal(tracker.getModel().cycleText, "dispatched 2 tasks");

      summary.dispatchedTaskCount = 1;
      tracker.onCycleSuccess(summary, []);
      assert.equal(tracker.getModel().cycleText, "dispatched 1 task");

      // Case 3: both
      summary.dispatchedTaskCount = 2;
      summary.completedTaskCount = 3;
      tracker.onCycleSuccess(summary, []);
      assert.equal(tracker.getModel().cycleText, "dispatched 2 tasks · completed 3 tasks");

      summary.dispatchedTaskCount = 1;
      summary.completedTaskCount = 1;
      tracker.onCycleSuccess(summary, []);
      assert.equal(tracker.getModel().cycleText, "dispatched 1 task · completed 1 task");
    });
  });

  describe("failure status mapping", () => {
    it("maps config failures to blocked / blocking problems", () => {
      const tracker = new RuntimeStatusTracker(2);
      const error = new Error("Failed to load config file backburner.json");
      tracker.onCycleFailure(error);

      const model = tracker.getModel();
      assert.equal(model.status, "blocked");
      assert.equal(model.readiness, "blocking problems");
      assert.ok(model.opSub.includes("invalid"));
    });

    it("maps general cycle failures to failed / warnings", () => {
      const tracker = new RuntimeStatusTracker(2);
      const error = new Error("Network timeout or git error");
      tracker.onCycleFailure(error);

      const model = tracker.getModel();
      assert.equal(model.status, "failed");
      assert.equal(model.readiness, "warnings");
      assert.ok(model.opSub.includes("retry"));
    });
  });

  describe("configs and running tasks tracking", () => {
    it("handles config and status updates", () => {
      const tracker = new RuntimeStatusTracker(2);
      
      const mcps = [{ handle: "cloud7", smitheryId: "smithery-cloud7" }];
      const capabilities = { sensors: [], controllers: [] };
      tracker.setConfigs(mcps, capabilities, 3);
      
      assert.deepEqual(tracker.getMcps(), mcps);
      assert.deepEqual(tracker.getCapabilities(), capabilities);
      assert.equal(tracker.getMaxConcurrent(), 3);
      
      const mcpStatuses = [
        {
          handle: "cloud7",
          providerId: "smithery" as const,
          providerMcpId: "smithery-cloud7",
          status: "ready" as const,
          lastCheckedAt: new Date().toISOString()
        }
      ];
      tracker.setMcpStatuses(mcpStatuses);
      assert.deepEqual(tracker.getMcpStatuses(), mcpStatuses);
    });

    it("tracks start and end of running tasks", () => {
      const tracker = new RuntimeStatusTracker(2);
      const task = sampleTask("implement_plan", "task-1");
      const agent = { provider: "antigravity", enabled: true, roles: [], modelClass: "strong" } as any;

      tracker.onTaskStart(task, agent);
      const runningTasks = tracker.getRunningTasks();
      assert.equal(runningTasks.size, 1);
      assert.ok(runningTasks.has("task-1"));
      
      const entry = runningTasks.get("task-1");
      assert.deepEqual(entry?.task, task);
      assert.deepEqual(entry?.agent, agent);
      assert.ok(entry?.startTime && entry.startTime <= Date.now());

      tracker.onTaskEnd("task-1");
      assert.equal(tracker.getRunningTasks().size, 0);
    });

    it("clears running tasks on cycle success or failure", () => {
      const tracker = new RuntimeStatusTracker(2);
      const task = sampleTask("implement_plan", "task-1");
      tracker.onTaskStart(task);
      assert.equal(tracker.getRunningTasks().size, 1);

      tracker.onCycleSuccess(sampleSummary(), []);
      assert.equal(tracker.getRunningTasks().size, 0);

      tracker.onTaskStart(task);
      assert.equal(tracker.getRunningTasks().size, 1);

      tracker.onCycleFailure(new Error("aborted"));
      assert.equal(tracker.getRunningTasks().size, 0);
    });

    it("clears stale repo-specific sync entries on onRepoSyncStart", () => {
      const tracker = new RuntimeStatusTracker(2);
      tracker.onRepoSyncStart("repo-a");
      assert.ok(tracker.getRunningTasks().has("orchestrator:sync:repo-a"));

      tracker.onRepoSyncStart("repo-b");
      assert.ok(!tracker.getRunningTasks().has("orchestrator:sync:repo-a"));
      assert.ok(tracker.getRunningTasks().has("orchestrator:sync:repo-b"));
    });

    it("tracks and exposes config reload errors", () => {
      const tracker = new RuntimeStatusTracker(2);
      assert.equal(tracker.getConfigReloadError(), null);

      const err = new Error("Failed to load config file");
      tracker.setConfigReloadError(err);
      assert.strictEqual(tracker.getConfigReloadError(), err);

      tracker.setConfigReloadError(null);
      assert.equal(tracker.getConfigReloadError(), null);
    });
  });
});
