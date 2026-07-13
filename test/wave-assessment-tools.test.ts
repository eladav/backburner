import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ComposedBrokerService } from "../src/github/composed.js";
import { defaultStderrLogger } from "../src/utils/logger.js";
import { WaveAssessmentSessionStore } from "../src/workstreams/wave-assessment/store.js";
import { WaveAssessmentToolService } from "../src/workstreams/wave-assessment/tools.js";

const START_ARGS = {
  sessionId: "wave-assessment-workstream-1-wave-1-r1-sha1",
  workstreamId: "workstream-1",
  waveId: "wave-1",
  parentPrNumber: 42,
  assessedParentHeadSha: "sha1",
  originalPlanningSessionId: "planner-session-1",
  currentPlanRevision: "r1",
  planNodeIds: ["task-1", "task-2"]
};

describe("WaveAssessmentToolService", () => {
  it("follows a continue lifecycle and exports a result", async () => {
    const service = createService();

    const startResult = await service.callTool("start_session", START_ARGS);
    assert.equal(startResult.ok, true);
    assert.equal((startResult as any).result.sessionId, START_ARGS.sessionId);

    const completeResult = await service.callTool("complete_session", {
      sessionId: START_ARGS.sessionId,
      decision: "continue",
      summary: "The integrated wave still matches the current plan.",
      currentIdentity: {
        workstreamId: "workstream-1",
        waveId: "wave-1",
        parentPrNumber: 42,
        parentHeadSha: "sha1",
        planRevision: "r1"
      }
    });
    assert.equal(completeResult.ok, true);

    const exportResult = await service.callTool("export_session", {
      sessionId: START_ARGS.sessionId,
      currentIdentity: { parentHeadSha: "sha1", planRevision: "r1" }
    });
    assert.equal(exportResult.ok, true);
    assert.equal((exportResult as any).result.decision, "continue");
    assert.equal((exportResult as any).result.summary, "The integrated wave still matches the current plan.");
    assert.deepEqual((exportResult as any).result.findings, []);
  });

  it("persists pretty-printed session snapshots under the log directory", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "backburner-wave-assessment-"));
    try {
      const store = new WaveAssessmentSessionStore(logDir);
      const service = new WaveAssessmentToolService(store, defaultStderrLogger);

      const startResult = await service.callTool("start_session", START_ARGS);
      assert.equal(startResult.ok, true);

      const filePath = path.join(
        logDir,
        "wave-assessment-sessions",
        `${START_ARGS.sessionId}.json`
      );
      const raw = await readFile(filePath, "utf8");
      assert.ok(raw.includes("\n  \"sessionId\":"));
      assert.ok(raw.endsWith("\n"));

      const restartedStore = new WaveAssessmentSessionStore(logDir);
      const persisted = await restartedStore.getSession(START_ARGS.sessionId);
      assert.equal(persisted?.sessionId, START_ARGS.sessionId);
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("requires at least one finding for a replan decision", async () => {
    const service = createService();
    await service.callTool("start_session", START_ARGS);

    const result = await service.callTool("complete_session", {
      sessionId: START_ARGS.sessionId,
      decision: "replan",
      summary: "The plan needs revision."
    });

    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, "invalid_session");
    assert.match((result as any).error.message, /missing-findings-for-replan/);
  });

  it("rejects findings that reference unknown plan node IDs", async () => {
    const service = createService();
    await service.callTool("start_session", START_ARGS);

    const result = await service.callTool("add_finding", {
      sessionId: START_ARGS.sessionId,
      category: "drift",
      summary: "Integrated code drifted from the next wave assumptions.",
      details: "The next packet depends on a contract that no longer exists.",
      affectedPlanNodeIds: ["unknown-task"]
    });

    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, "unknown_node_reference");
  });

  it("allows replan when a finding references known plan nodes", async () => {
    const service = createService();
    await service.callTool("start_session", START_ARGS);

    const findingResult = await service.callTool("add_finding", {
      sessionId: START_ARGS.sessionId,
      category: "invalid_assumption",
      summary: "Task 2 assumes the old contract.",
      details: "The merged implementation changed the parent API shape.",
      affectedPlanNodeIds: ["task-2"]
    });
    assert.equal(findingResult.ok, true);

    const completeResult = await service.callTool("complete_session", {
      sessionId: START_ARGS.sessionId,
      decision: "replan",
      summary: "Replan the remaining wave around the updated API."
    });
    assert.equal(completeResult.ok, true);

    const exportResult = await service.callTool("export_session", {
      sessionId: START_ARGS.sessionId
    });
    assert.equal(exportResult.ok, true);
    assert.equal((exportResult as any).result.decision, "replan");
    assert.equal((exportResult as any).result.findings.length, 1);
  });

  it("rejects stale current identity arguments on completion and export", async () => {
    const service = createService();
    await service.callTool("start_session", START_ARGS);

    const staleComplete = await service.callTool("complete_session", {
      sessionId: START_ARGS.sessionId,
      decision: "continue",
      summary: "Looks good.",
      currentIdentity: { parentHeadSha: "sha2" }
    });
    assert.equal(staleComplete.ok, false);
    assert.equal((staleComplete as any).error.code, "invalid_session");
    assert.match((staleComplete as any).error.message, /stale-parent-head/);

    const completeResult = await service.callTool("complete_session", {
      sessionId: START_ARGS.sessionId,
      decision: "continue",
      summary: "Looks good.",
      currentIdentity: { parentHeadSha: "sha1" }
    });
    assert.equal(completeResult.ok, true);

    const staleExport = await service.callTool("export_session", {
      sessionId: START_ARGS.sessionId,
      currentIdentity: { planRevision: "r2" }
    });
    assert.equal(staleExport.ok, false);
    assert.equal((staleExport as any).error.code, "invalid_session");
    assert.match((staleExport as any).error.message, /stale-plan-revision/);
  });

  it("rejects start_session reuse when the supplied identity is stale", async () => {
    const service = createService();
    await service.callTool("start_session", START_ARGS);

    const result = await service.callTool("start_session", {
      ...START_ARGS,
      assessedParentHeadSha: "sha2"
    });

    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, "invalid_session");
    assert.match((result as any).error.message, /stale-parent-head/);
  });

  it("is exposed through the composed broker as wave_assessment tools", async () => {
    const service = createService();
    const composed = new ComposedBrokerService([service]);

    assert.deepEqual(
      composed.listTools().map((tool) => tool.name),
      [
        "wave_assessment.start_session",
        "wave_assessment.add_finding",
        "wave_assessment.complete_session",
        "wave_assessment.export_session"
      ]
    );

    const result = await composed.callTool("wave_assessment.start_session", START_ARGS);
    assert.equal(result.ok, true);
    assert.equal(result.tool, "wave_assessment.start_session");
  });
});

function createService(): WaveAssessmentToolService {
  return new WaveAssessmentToolService(
    new WaveAssessmentSessionStore(),
    defaultStderrLogger
  );
}
