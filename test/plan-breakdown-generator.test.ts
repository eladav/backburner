import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createSession } from "../src/workstreams/plan-breakdown-generator/session.js";
import { applyPatches } from "../src/workstreams/plan-breakdown-generator/patch.js";
import { inspectSession } from "../src/workstreams/plan-breakdown-generator/inspect.js";
import { exportSession } from "../src/workstreams/plan-breakdown-generator/export.js";
import { GeneratorTask, GeneratorWave } from "../src/workstreams/plan-breakdown-generator/types.js";


test("Plan Breakdown Generator", async (t) => {
  await t.test("can create a session", () => {
    const session = createSession({ title: "Test Plan", summary: "A test summary" });
    assert.strictEqual(session.title, "Test Plan");
    assert.strictEqual(session.summary, "A test summary");
    assert.ok(session.id);
  });

  await t.test("can apply patches", () => {
    let session = createSession();
    const task: GeneratorTask = {
      id: "T1",
      title: "Task 1",
      description: "Desc 1",
      dependsOn: [],
      blocks: [],
      canRunInParallelWith: [],
      risk: "low",
      filesLikelyInvolved: [],
      acceptanceCriteria: [],
      verification: ["npm test"]
    };
    const wave: GeneratorWave = {
      id: "W1",
      taskIds: ["T1"],
      rationale: "Wave 1"
    };

    session = applyPatches(session, [
      { op: "set-title", value: "New Title" },
      { op: "add-task", task },
      { op: "add-wave", wave }
    ]);

    assert.strictEqual(session.title, "New Title");
    assert.strictEqual(session.tasks["T1"]?.title, "Task 1");
    assert.strictEqual(session.waves["W1"]?.id, "W1");
    assert.deepStrictEqual(session.waveOrder, ["W1"]);
  });

  await t.test("validation reports issues", () => {
    const session = createSession();
    // Missing title, summary, tasks, waves, recommendedFirstWaveId, suggestedNextAction
    const inspection = inspectSession(session);
    assert.strictEqual(inspection.isValid, false);
    assert.ok(inspection.validationIssues.some(i => i.code === "missing-title"));
    assert.ok(inspection.validationIssues.some(i => i.code === "missing-summary"));
    assert.ok(inspection.validationIssues.some(i => i.code === "no-tasks"));
    assert.ok(inspection.validationIssues.some(i => i.code === "no-waves"));
    assert.ok(inspection.validationIssues.some(i => i.code === "missing-recommended-first-wave"));
    assert.ok(inspection.validationIssues.some(i => i.code === "missing-suggested-next-action"));
  });

  await t.test("can export a valid session", () => {
    let session = createSession({ title: "Valid Plan", summary: "Summary" });
    const task: GeneratorTask = {
      id: "T1",
      title: "Task 1",
      description: "Desc 1",
      dependsOn: [],
      blocks: [],
      canRunInParallelWith: [],
      risk: "low",
      filesLikelyInvolved: [],
      acceptanceCriteria: ["Done"],
      verification: ["npm test"]
    };
    const wave: GeneratorWave = {
      id: "W1",
      taskIds: ["T1"],
      rationale: "Wave 1"
    };

    session = applyPatches(session, [
      { op: "add-task", task },
      { op: "add-wave", wave },
      { op: "set-recommended-first-wave", id: "W1" },
      { op: "set-suggested-next-action", value: "Start implementation" }
    ]);

    const result = exportSession(session);
    assert.strictEqual(result.title, "Valid Plan");
    assert.strictEqual(result.tasks.length, 1);
    assert.strictEqual(result.waves.length, 1);
    assert.strictEqual(result.recommendedFirstWaveId, "W1");
  });

  await t.test("allows large detailed waves without arbitrary size warnings", () => {
    let session = createSession({ title: "Large Plan", summary: "Summary" });
    const taskIds = Array.from({ length: 12 }, (_, index) => `T${index + 1}`);

    for (const taskId of taskIds) {
      session = applyPatches(session, [
        {
          op: "add-task",
          task: {
            id: taskId,
            title: `Task ${taskId}`,
            description: "Detailed implementation guidance for a weaker downstream implementation agent.",
            dependsOn: [],
            blocks: [],
            canRunInParallelWith: [],
            risk: "medium",
            filesLikelyInvolved: [`src/${taskId}.ts`],
            acceptanceCriteria: Array.from({ length: 12 }, (_, index) => `Criterion ${index + 1}`),
            verification: ["npm test"]
          }
        }
      ]);
    }

    session = applyPatches(session, [
      {
        op: "add-wave",
        wave: {
          id: "W1",
          taskIds,
          rationale: "These independent packets can be planned in the same wave."
        }
      },
      { op: "set-recommended-first-wave", id: "W1" },
      { op: "set-suggested-next-action", value: "Create packet planning PRs." }
    ]);

    const inspection = inspectSession(session);
    assert.equal(inspection.isValid, true);
    assert.deepEqual(
      inspection.validationIssues.filter((issue) =>
        issue.code === "large-wave" ||
        issue.code === "large-task" ||
        issue.code === "complex-task"
      ),
      []
    );
  });

  await t.test("rejects forward dependencies", () => {
    let session = createSession({ title: "Invalid Plan", summary: "Summary" });
    const t1: GeneratorTask = {
      id: "T1",
      title: "Task 1",
      description: "Desc 1",
      dependsOn: ["T2"], // Forward ref
      blocks: [],
      canRunInParallelWith: [],
      risk: "low",
      filesLikelyInvolved: [],
      acceptanceCriteria: [],
      verification: ["npm test"]
    };
    const t2: GeneratorTask = {
      id: "T2",
      title: "Task 2",
      description: "Desc 2",
      dependsOn: [],
      blocks: [],
      canRunInParallelWith: [],
      risk: "low",
      filesLikelyInvolved: [],
      acceptanceCriteria: [],
      verification: ["npm test"]
    };
    const w1: GeneratorWave = { id: "W1", taskIds: ["T1"], rationale: "Wave 1" };
    const w2: GeneratorWave = { id: "W2", taskIds: ["T2"], rationale: "Wave 2" };

    session = applyPatches(session, [
      { op: "add-task", task: t1 },
      { op: "add-task", task: t2 },
      { op: "add-wave", wave: w1 },
      { op: "add-wave", wave: w2 }
    ]);

    const inspection = inspectSession(session);
    assert.strictEqual(inspection.isValid, false);
    assert.ok(inspection.tasks.some(t => t.id === "T1" && t.validationIssues.some(i => i.code === "forward-dependency")));
  });

  await t.test("reorder-waves works correctly", () => {
    let session = createSession();
    const w1: GeneratorWave = { id: "W1", taskIds: [], rationale: "W1" };
    const w2: GeneratorWave = { id: "W2", taskIds: [], rationale: "W2" };

    session = applyPatches(session, [
      { op: "add-wave", wave: w1 },
      { op: "add-wave", wave: w2 }
    ]);
    assert.deepStrictEqual(session.waveOrder, ["W1", "W2"]);

    session = applyPatches(session, [
      { op: "reorder-waves", waveIds: ["W2", "W1"] }
    ]);
    assert.deepStrictEqual(session.waveOrder, ["W2", "W1"]);

    // Fails if partial reorder
    assert.throws(() => {
      applyPatches(session, [
        { op: "reorder-waves", waveIds: ["W1"] }
      ]);
    }, /reorder-waves must include all existing waves/);

    // Fails if duplicate IDs
    assert.throws(() => {
      applyPatches(session, [
        { op: "reorder-waves", waveIds: ["W1", "W1"] }
      ]);
    }, /Duplicate wave ID W1 in reorder/);
  });

  await t.test("remove-task removes from waves", () => {
    let session = createSession();
    const task: GeneratorTask = { id: "T1", title: "T1", description: "", dependsOn: [], blocks: [], canRunInParallelWith: [], risk: "low", filesLikelyInvolved: [], acceptanceCriteria: [], verification: [] };
    const wave: GeneratorWave = { id: "W1", taskIds: ["T1"], rationale: "W1" };

    session = applyPatches(session, [
      { op: "add-task", task },
      { op: "add-wave", wave }
    ]);
    assert.ok(session.waves["W1"]?.taskIds.includes("T1"));

    session = applyPatches(session, [
      { op: "remove-task", id: "T1" }
    ]);
    assert.ok(!(session.waves["W1"]?.taskIds.includes("T1")));
    assert.ok(!session.tasks["T1"]);
  });

  await t.test("reports duplicate task IDs", () => {
    let session = createSession();
    const t1: GeneratorTask = { id: "T1", title: "T1", description: "", dependsOn: [], blocks: [], canRunInParallelWith: [], risk: "low", filesLikelyInvolved: [], acceptanceCriteria: [], verification: [] };
    const t2: GeneratorTask = { id: "T1", title: "T1 Duplicate", description: "", dependsOn: [], blocks: [], canRunInParallelWith: [], risk: "low", filesLikelyInvolved: [], acceptanceCriteria: [], verification: [] };

    session = applyPatches(session, [
      { op: "add-task", task: t1 }
    ]);

    assert.throws(() => {
      applyPatches(session, [
        { op: "add-task", task: t2 }
      ]);
    }, /Task ID T1 already exists/);
  });

  await t.test("reports duplicate wave IDs", () => {
    let session = createSession();
    const w1: GeneratorWave = { id: "W1", taskIds: [], rationale: "W1" };
    const w2: GeneratorWave = { id: "W1", taskIds: [], rationale: "W1 Duplicate" };

    session = applyPatches(session, [
      { op: "add-wave", wave: w1 }
    ]);

    assert.throws(() => {
      applyPatches(session, [
        { op: "add-wave", wave: w2 }
      ]);
    }, /Wave ID W1 already exists/);
  });

  await t.test("applyPatches preserves validationIssues from previous calls", () => {
    let session = createSession();
    const t1: GeneratorTask = { id: "T1", title: "T1", description: "", dependsOn: [], blocks: [], canRunInParallelWith: [], risk: "low", filesLikelyInvolved: [], acceptanceCriteria: [], verification: [] };

    // Add a manual validation issue to test preservation
    session.validationIssues.push({
      severity: "error",
      code: "manual-issue",
      message: "Manual issue",
      path: []
    });

    assert.strictEqual(session.validationIssues.length, 1, "Should have 1 validation issue");

    // Second call with unrelated patch
    session = applyPatches(session, [
      { op: "set-title", value: "New Title" }
    ]);

    assert.strictEqual(session.validationIssues.length, 1, "Should STILL have 1 validation issue after unrelated patch");
    assert.strictEqual(session.validationIssues[0]?.code, "manual-issue");
  });

  await t.test("add-task does not overwrite existing tasks", () => {
    let session = createSession();
    const t1: GeneratorTask = { id: "T1", title: "Original Title", description: "", dependsOn: [], blocks: [], canRunInParallelWith: [], risk: "low", filesLikelyInvolved: [], acceptanceCriteria: [], verification: [] };
    const t2: GeneratorTask = { id: "T1", title: "New Title", description: "", dependsOn: [], blocks: [], canRunInParallelWith: [], risk: "low", filesLikelyInvolved: [], acceptanceCriteria: [], verification: [] };

    session = applyPatches(session, [
      { op: "add-task", task: t1 }
    ]);
    assert.strictEqual(session.tasks["T1"]?.title, "Original Title");

    assert.throws(() => {
      applyPatches(session, [
        { op: "add-task", task: t2 }
      ]);
    }, /Task ID T1 already exists/);

    assert.strictEqual(session.tasks["T1"]?.title, "Original Title", "Should NOT have overwritten the task");
  });

  await t.test("removing a task clears its validation issues", () => {
    let session = createSession();
    const t1: GeneratorTask = { id: "T1", title: "T1", description: "", dependsOn: [], blocks: [], canRunInParallelWith: [], risk: "low", filesLikelyInvolved: [], acceptanceCriteria: [], verification: [] };

    session = applyPatches(session, [
      { op: "add-task", task: t1 }
    ]);

    // Manually add a validation issue for this task
    session.validationIssues.push({
      severity: "error",
      code: "some-error",
      message: "Error",
      path: ["tasks", "T1"]
    });

    session = applyPatches(session, [
      { op: "remove-task", id: "T1" }
    ]);
    assert.ok(!session.validationIssues.some(i => i.path?.[0] === "tasks" && i.path?.[1] === "T1"));
  });

  await t.test("throws for non-existent updates/removals", () => {
    let session = createSession();

    assert.throws(() => applyPatches(session, [{ op: "update-task", id: "T1", patch: {} }]), /Task T1 not found/);
    assert.throws(() => applyPatches(session, [{ op: "remove-task", id: "T1" }]), /Task T1 not found/);
    assert.throws(() => applyPatches(session, [{ op: "update-wave", id: "W1", patch: {} }]), /Wave W1 not found/);
    assert.throws(() => applyPatches(session, [{ op: "remove-wave", id: "W1" }]), /Wave W1 not found/);
    assert.throws(() => applyPatches(session, [{ op: "set-recommended-first-wave", id: "W1" }]), /Wave W1 not found/);
    assert.throws(() => applyPatches(session, [{ op: "reorder-waves", waveIds: ["W1"] }]), /reorder-waves must include all existing waves/);
  });

  await t.test("reports missing task id and description", () => {
    let session = createSession();
    const task: GeneratorTask = {
      id: "", // EMPTY ID
      title: "Task 1",
      description: "", // EMPTY DESCRIPTION
      dependsOn: [],
      blocks: [],
      canRunInParallelWith: [],
      risk: "low",
      filesLikelyInvolved: [],
      acceptanceCriteria: [],
      verification: []
    };

    session = applyPatches(session, [
      { op: "add-task", task }
    ]);

    const inspection = inspectSession(session);
    assert.ok(inspection.validationIssues.some(i => i.code === "missing-task-id"));
    assert.ok(inspection.validationIssues.some(i => i.code === "missing-task-description"));
  });

  await t.test("reports missing wave id and rationale", () => {
    let session = createSession();
    const wave: GeneratorWave = {
      id: "", // EMPTY ID
      taskIds: [],
      rationale: "" // EMPTY RATIONALE
    };

    session = applyPatches(session, [
      { op: "add-wave", wave }
    ]);

    const inspection = inspectSession(session);
    assert.ok(inspection.validationIssues.some(i => i.code === "missing-wave-id"));
    assert.ok(inspection.validationIssues.some(i => i.code === "missing-wave-rationale"));
  });

  await t.test("rejects non-string scalar fields", () => {
    const session = createSession({ title: 123 as any, summary: "Summary" });
    (session as any).suggestedNextAction = true;
    const inspection = inspectSession(session);
    assert.strictEqual(inspection.isValid, false);
    assert.ok(inspection.validationIssues.some(i => i.code === "invalid-title"));
    assert.ok(inspection.validationIssues.some(i => i.code === "invalid-suggested-next-action"));
  });

  await t.test("handles malformed tasks and waves objects", () => {
    const session = createSession({ title: "Title", summary: "Summary" });
    (session as any).tasks = null;
    (session as any).waves = [];

    const inspection = inspectSession(session);
    assert.strictEqual(inspection.isValid, false);
    assert.ok(inspection.validationIssues.some(i => i.code === "invalid-tasks"));
    assert.ok(inspection.validationIssues.some(i => i.code === "invalid-waves"));

    assert.throws(() => exportSession(session), /tasks must be an object/);
  });
});
