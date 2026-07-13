import { describe, it } from "node:test";
import * as assert from "node:assert";
import { PlanBreakdownSessionStore } from "../src/workstreams/plan-breakdown-generator/store.js";
import { PlanBreakdownToolService } from "../src/workstreams/plan-breakdown-generator/tools.js";
import { defaultStderrLogger } from "../src/utils/logger.js";

describe("PlanBreakdownToolService", () => {
  it("should follow a full session lifecycle", async () => {
    const store = new PlanBreakdownSessionStore();
    const service = new PlanBreakdownToolService(store, defaultStderrLogger);

    // 1. Start session
    const startResult = await service.callTool("start_session", {
      title: "My Plan",
      summary: "A great plan"
    });
    assert.strictEqual(startResult.ok, true);
    const sessionId = (startResult as any).result.sessionId;
    assert.ok(sessionId);

    // 2. Add a task
    const addTaskResult = await service.callTool("apply_patch", {
      sessionId,
      patch: {
        op: "add-task",
        task: {
          id: "task-1",
          title: "Task 1",
          summary: "Do things",
          description: "Task 1 description",
          kind: "implement_plan",
          risk: "low",
          dependencies: [],
          dependsOn: [],
          blocks: [],
          canRunInParallelWith: [],
          filesLikelyInvolved: [],
          acceptanceCriteria: [],
          verification: []
        }
      }
    });
    assert.strictEqual(addTaskResult.ok, true, `Add task failed: ${JSON.stringify(addTaskResult)}`);

    // 3. Add a wave
    const addWaveResult = await service.callTool("apply_patch", {
      sessionId,
      patch: {
        op: "add-wave",
        wave: {
          id: "wave-1",
          taskIds: ["task-1"],
          rationale: "First wave",
          validationIssues: []
        }
      }
    });
    assert.strictEqual(addWaveResult.ok, true, `Add wave failed: ${JSON.stringify(addWaveResult)}`);

    // 3b. Set required session fields
    const setRecResult = await service.callTool("apply_patch", {
      sessionId,
      patch: { op: "set-recommended-first-wave", id: "wave-1" }
    });
    assert.strictEqual(setRecResult.ok, true, `Set recommended wave failed: ${JSON.stringify(setRecResult)}`);

    const setNextResult = await service.callTool("apply_patch", {
      sessionId,
      patch: { op: "set-suggested-next-action", value: "Review the plan" }
    });
    assert.strictEqual(setNextResult.ok, true, `Set suggested next action failed: ${JSON.stringify(setNextResult)}`);

    // 4. Inspect
    const inspectResult = await service.callTool("inspect_session", { sessionId });
    assert.strictEqual(inspectResult.ok, true);
    assert.strictEqual((inspectResult as any).result.taskCount, 1);
    assert.strictEqual((inspectResult as any).result.waveCount, 1);

    // 5. Validate
    const validateResult = await service.callTool("validate_session", { sessionId });
    assert.strictEqual(validateResult.ok, true);
    if (!(validateResult as any).result.isValid) {
      console.log('Validation issues:', JSON.stringify((validateResult as any).result.issues, null, 2));
    }
    assert.strictEqual((validateResult as any).result.isValid, true);

    // 6. Export
    const exportResult = await service.callTool("export_session", { sessionId });
    assert.strictEqual(exportResult.ok, true);
    assert.strictEqual((exportResult as any).result.title, "My Plan");
    assert.strictEqual((exportResult as any).result.waves.length, 1);
  });

  it("should fail update-task with malformed nested fields", async () => {
    const store = new PlanBreakdownSessionStore();
    const service = new PlanBreakdownToolService(store, defaultStderrLogger);

    const startResult = await service.callTool("start_session", { title: "P", summary: "S" });
    const sessionId = (startResult as any).result.sessionId;

    await service.callTool("apply_patch", {
      sessionId,
      patch: {
        op: "add-task",
        task: { id: "t1", title: "T", description: "D", dependsOn: [], blocks: [], canRunInParallelWith: [], risk: "low", filesLikelyInvolved: [], acceptanceCriteria: [], verification: [] }
      }
    });

    const updateResult = await service.callTool("apply_patch", {
      sessionId,
      patch: {
        op: "update-task",
        id: "t1",
        patch: { dependsOn: "not-an-array" }
      }
    });

    assert.strictEqual(updateResult.ok, false);
    assert.strictEqual((updateResult as any).error.code, "invalid_arguments");
    assert.ok((updateResult as any).error.message.includes("patch.patch.dependsOn"));
  });

  it("should fail update-wave with malformed nested fields", async () => {
    const store = new PlanBreakdownSessionStore();
    const service = new PlanBreakdownToolService(store, defaultStderrLogger);

    const startResult = await service.callTool("start_session", { title: "P", summary: "S" });
    const sessionId = (startResult as any).result.sessionId;

    await service.callTool("apply_patch", {
      sessionId,
      patch: {
        op: "add-wave",
        wave: { id: "w1", taskIds: [], rationale: "R" }
      }
    });

    const updateResult = await service.callTool("apply_patch", {
      sessionId,
      patch: {
        op: "update-wave",
        id: "w1",
        patch: { taskIds: "not-an-array" }
      }
    });

    assert.strictEqual(updateResult.ok, false);
    assert.strictEqual((updateResult as any).error.code, "invalid_arguments");
    assert.ok((updateResult as any).error.message.includes("patch.patch.taskIds"));
  });

  it("should validate patch operations at runtime", async () => {
    const store = new PlanBreakdownSessionStore();
    const service = new PlanBreakdownToolService(store, defaultStderrLogger);

    const startResult = await service.callTool("start_session", {
      title: "Test Plan",
      summary: "Summary"
    });
    const sessionId = (startResult as any).result.sessionId;

    // Unknown operation
    const unknownOpResult = await service.callTool("apply_patch", {
      sessionId,
      patch: { op: "not-a-real-op" }
    });
    assert.strictEqual(unknownOpResult.ok, false);
    assert.strictEqual((unknownOpResult as any).error.code, "invalid_arguments");
    assert.ok((unknownOpResult as any).error.message.includes("Unknown patch operation"));

    // Missing required field for set-title
    const missingFieldResult = await service.callTool("apply_patch", {
      sessionId,
      patch: { op: "set-title" }
    });
    assert.strictEqual(missingFieldResult.ok, false);
    assert.strictEqual((missingFieldResult as any).error.code, "invalid_arguments");
    assert.ok((missingFieldResult as any).error.message.includes("patch.value"));

    // Malformed task
    const malformedTaskResult = await service.callTool("apply_patch", {
      sessionId,
      patch: {
        op: "add-task",
        task: { id: "task-2" } // Missing title, description, etc.
      }
    });
    assert.strictEqual(malformedTaskResult.ok, false);
    assert.strictEqual((malformedTaskResult as any).error.code, "invalid_arguments");
    assert.ok((malformedTaskResult as any).error.message.includes("patch.task.title"));
  });

  it("should return error for unknown session", async () => {
    const store = new PlanBreakdownSessionStore();
    const service = new PlanBreakdownToolService(store, defaultStderrLogger);

    const result = await service.callTool("inspect_session", { sessionId: "unknown" });
    assert.strictEqual(result.ok, false);
    assert.ok((result as any).error.message.includes("Session not found"));
  });

  it("should return error for export of invalid session", async () => {
    const store = new PlanBreakdownSessionStore();
    const service = new PlanBreakdownToolService(store, defaultStderrLogger);

    const startResult = await service.callTool("start_session", {
      title: "Invalid Plan",
      summary: "Missing waves"
    });
    const sessionId = (startResult as any).result.sessionId;

    const exportResult = await service.callTool("export_session", { sessionId });
    assert.strictEqual(exportResult.ok, false);
    assert.strictEqual((exportResult as any).error.code, "invalid_session");
  });

  it("rejects export when a wave contains dependent tasks", async () => {
    const store = new PlanBreakdownSessionStore();
    const service = new PlanBreakdownToolService(store, defaultStderrLogger);

    const startResult = await service.callTool("start_session", {
      title: "Dependent Plan",
      summary: "A plan with a bad wave"
    });
    const sessionId = (startResult as any).result.sessionId;

    for (const task of [
      { id: "T1", dependsOn: [] },
      { id: "T2", dependsOn: ["T1"] }
    ]) {
      const addTaskResult = await service.callTool("apply_patch", {
        sessionId,
        patch: {
          op: "add-task",
          task: {
            id: task.id,
            title: task.id,
            description: `${task.id} description`,
            dependsOn: task.dependsOn,
            blocks: [],
            canRunInParallelWith: [],
            risk: "low",
            filesLikelyInvolved: [],
            acceptanceCriteria: [],
            verification: []
          }
        }
      });
      assert.strictEqual(addTaskResult.ok, true);
    }

    const addWaveResult = await service.callTool("apply_patch", {
      sessionId,
      patch: {
        op: "add-wave",
        wave: { id: "W1", taskIds: ["T1", "T2"], rationale: "Invalid same-wave dependency" }
      }
    });
    assert.strictEqual(addWaveResult.ok, true);

    await service.callTool("apply_patch", {
      sessionId,
      patch: { op: "set-recommended-first-wave", id: "W1" }
    });
    await service.callTool("apply_patch", {
      sessionId,
      patch: { op: "set-suggested-next-action", value: "Fix waves" }
    });

    const validateResult = await service.callTool("validate_session", { sessionId });
    assert.strictEqual(validateResult.ok, true);
    assert.strictEqual((validateResult as any).result.isValid, false);
    assert.ok(
      (validateResult as any).result.issues.some((issue: any) => issue.code === "same-wave-dependency")
    );

    const exportResult = await service.callTool("export_session", { sessionId });
    assert.strictEqual(exportResult.ok, false);
    assert.strictEqual((exportResult as any).error.code, "invalid_session");
    assert.match((exportResult as any).error.message, /Call validate_session/);
  });
});
