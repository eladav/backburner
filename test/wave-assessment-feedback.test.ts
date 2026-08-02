import * as assert from "node:assert/strict";
import { test } from "node:test";
import { renderWaveAssessmentComment } from "../src/agents/wave-assessment-feedback.js";
import type { WaveAssessmentResult } from "../src/state/types.js";

function assessment(decision: WaveAssessmentResult["decision"]): WaveAssessmentResult {
  return {
    id: `assessment-${decision}`,
    sessionId: "checkpoint-1",
    checkpoint: {
      id: "checkpoint-1",
      sessionId: "checkpoint-1",
      identity: {
        repoKey: "owner/repo",
        workstreamId: "owner/repo:issue:1",
        waveId: "wave-0",
        parentPrNumber: 1,
        parentHeadSha: "sha1",
        parentIntegrationBranch: "agent/owner-repo/issue-1",
        defaultBranch: "main",
        planRevision: "rev1",
        originalPlanningSessionId: "planner-1",
        currentWaveIndex: 0,
        nextWaveIndex: 1,
        completedPacketIds: ["T1"],
        pendingFuturePacketIds: ["T2"],
        planNodeIds: ["T1", "T2"]
      }
    },
    decision,
    summary: "Assessment summary.",
    findings: [],
    status: "finalized"
  };
}

test("blocked wave feedback documents the exact reassessment recovery command", () => {
  const output = renderWaveAssessmentComment(assessment("blocked"));

  assert.match(output, /## Reassess this checkpoint/);
  assert.match(output, /wave-reassess\nreason: <non-empty reason>/);
  assert.doesNotMatch(output, /issuecomment-/);
});

test("non-blocked wave feedback does not offer reassessment", () => {
  assert.doesNotMatch(renderWaveAssessmentComment(assessment("continue")), /wave-reassess/);
  assert.doesNotMatch(renderWaveAssessmentComment(assessment("replan")), /wave-reassess/);
});
