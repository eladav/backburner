import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { BranchSyncComparison } from "../src/git/types.js";
import type {
  WaveAssessmentResult,
  WorkstreamPacket,
  WorkstreamPacketPlan,
  WorkstreamRecord
} from "../src/state/types.js";
import type { ParentBranchSyncPreflight } from "../src/tasks/types.js";
import { evaluatePacketWaveAdvancement } from "../src/workstreams/branch-sync.js";
import {
  buildWaveAssessmentCheckpoint,
  buildWaveAssessmentCheckpointForPreflight,
  buildWaveAssessmentCheckpointIdentity
} from "../src/workstreams/wave-assessment/checkpoint.js";

function branchComparison(status: BranchSyncComparison["status"]): BranchSyncComparison {
  return {
    parentBranch: "agent/owner-repo/issue-1",
    defaultBranch: "main",
    parentRef: "refs/remotes/origin/agent/owner-repo/issue-1",
    defaultRef: "refs/remotes/origin/main",
    status,
    message: status
  };
}

function packet(id: string, status: WorkstreamPacket["status"]): WorkstreamPacket {
  return {
    id,
    title: `Packet ${id}`,
    summary: `Summary ${id}`,
    acceptanceCriteria: [],
    filesLikelyTouched: [],
    dependsOn: [],
    canRunInParallelWith: [],
    blocks: [],
    status
  };
}

function packetPlan(overrides?: Partial<WorkstreamPacketPlan>): WorkstreamPacketPlan {
  return {
    status: "approved",
    packets: {
      T1: packet("T1", "merged_to_parent"),
      T2: packet("T2", "planned")
    },
    waves: [["T1"], ["T2"]],
    currentWaveIndex: 0,
    ...overrides
  };
}

function workstream(id: string, overrides?: Partial<WorkstreamRecord>): WorkstreamRecord {
  return {
    id,
    repoKey: "owner/repo",
    origin: { type: "issue", number: 1 },
    linkedIssueNumber: 1,
    linkedPrs: [],
    phase: "implementation_ready",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: {
      branchName: "agent/owner-repo/issue-1",
      prNumber: 100
    },
    packetPlan: packetPlan(),
    ...overrides
  };
}

function preflight(workstreamId: string): ParentBranchSyncPreflight {
  return {
    workstreamId,
    repoKey: "owner/repo",
    parentIntegrationBranch: "agent/owner-repo/issue-1",
    defaultBranch: "main",
    currentWaveIndex: 0,
    nextWaveIndex: 1,
    completedPacketIds: ["T1"],
    pendingFuturePacketIds: ["T2"]
  };
}

function waveAssessment(
  preflightInput: ParentBranchSyncPreflight,
  overrides?: Partial<WaveAssessmentResult>
): WaveAssessmentResult {
  const checkpoint = buildWaveAssessmentCheckpointForPreflight(preflightInput);
  return {
    id: `assessment:${checkpoint.id}`,
    sessionId: checkpoint.sessionId,
    checkpoint,
    decision: "continue",
    summary: "Wave is ready to continue.",
    findings: [],
    status: "finalized",
    postedCommentId: "12345",
    ...overrides
  };
}

describe("packet wave assessment checkpoint gating", () => {
  it("uses distinct session ids when full checkpoint identity fields change", () => {
    const baseIdentity = buildWaveAssessmentCheckpointIdentity(preflight("W1"), {
      parentHeadSha: "sha1",
      planRevision: "rev1",
      originalPlanningSessionId: "planner-1",
      planNodeIds: ["T1", "T2"]
    });
    const original = buildWaveAssessmentCheckpoint(baseIdentity);
    const changedPlanningSession = buildWaveAssessmentCheckpoint({
      ...baseIdentity,
      originalPlanningSessionId: "planner-2"
    });
    const changedPlanNodes = buildWaveAssessmentCheckpoint({
      ...baseIdentity,
      planNodeIds: ["T1", "T2", "T3"]
    });

    assert.notEqual(changedPlanningSession.sessionId, original.sessionId);
    assert.notEqual(changedPlanNodes.sessionId, original.sessionId);
  });

  it("keeps session ids bounded when plan node ids are long", () => {
    const planNodeIds = Array.from({ length: 100 }, (_, index) =>
      `packet-${index}-${"x".repeat(80)}`
    );
    const checkpoint = buildWaveAssessmentCheckpoint(
      buildWaveAssessmentCheckpointIdentity(
        {
          ...preflight("owner/repo:issue:with-a-very-long-workstream-name"),
          completedPacketIds: planNodeIds.slice(0, 50),
          pendingFuturePacketIds: planNodeIds.slice(50),
          planNodeIds
        },
        {
          parentHeadSha: "sha1",
          planRevision: "rev1",
          originalPlanningSessionId: "planner-1",
          planNodeIds
        }
      )
    );

    assert.equal(checkpoint.identity.planNodeIds.length, 100);
    assert.ok(checkpoint.sessionId.length < 180);
  });

  it("does not advance a complete up_to_date wave without assessment", () => {
    const preflightInput = preflight("W1");
    const evaluation = evaluatePacketWaveAdvancement({
      workstreams: [workstream("W1")],
      parentBranchSyncPreflights: [
        { preflight: preflightInput, branchSyncComparison: branchComparison("up_to_date") }
      ]
    });

    assert.deepEqual(evaluation.readyWorkstreamIds, []);
    assert.equal(evaluation.waveAssessmentGates[0]?.status, "gated");
    assert.equal(evaluation.waveAssessmentGates[0]?.reason, "assessment_missing");
    assert.equal(evaluation.result.advanced.length, 0);
    assert.equal(evaluation.result.workstreams["W1"]?.packetPlan?.currentWaveIndex, 0);
  });

  it("advances with a matching finalized continue assessment and posted comment", () => {
    const preflightInput = preflight("W1");
    const evaluation = evaluatePacketWaveAdvancement({
      workstreams: [workstream("W1")],
      parentBranchSyncPreflights: [
        { preflight: preflightInput, branchSyncComparison: branchComparison("up_to_date") }
      ],
      waveAssessments: [waveAssessment(preflightInput)]
    });

    assert.deepEqual(evaluation.readyWorkstreamIds, ["W1"]);
    assert.equal(evaluation.waveAssessmentGates[0]?.status, "allowed");
    assert.equal(evaluation.result.advanced.length, 1);
    assert.equal(evaluation.result.workstreams["W1"]?.packetPlan?.currentWaveIndex, 1);
  });

  it("does not advance replan, blocked, unposted, or stale assessments", () => {
    const cases: Array<{
      name: string;
      assessment: (preflightInput: ParentBranchSyncPreflight) => WaveAssessmentResult;
      reason: string;
      status: string;
    }> = [
      {
        name: "replan",
        assessment: (preflightInput) => waveAssessment(preflightInput, { decision: "replan" }),
        reason: "assessment_requires_replan",
        status: "gated"
      },
      {
        name: "blocked",
        assessment: (preflightInput) => waveAssessment(preflightInput, { decision: "blocked" }),
        reason: "assessment_blocked",
        status: "gated"
      },
      {
        name: "unposted",
        assessment: (preflightInput) => {
          const assessment = waveAssessment(preflightInput);
          delete assessment.postedCommentId;
          return assessment;
        },
        reason: "assessment_comment_missing",
        status: "gated"
      },
      {
        name: "stale",
        assessment: (preflightInput) =>
          waveAssessment({
            ...preflightInput,
            pendingFuturePacketIds: ["DIFFERENT"]
          }),
        reason: "assessment_checkpoint_stale",
        status: "stale"
      }
    ];

    for (const testCase of cases) {
      const wsId = `W-${testCase.name}`;
      const preflightInput = preflight(wsId);
      const evaluation = evaluatePacketWaveAdvancement({
        workstreams: [workstream(wsId)],
        parentBranchSyncPreflights: [
          { preflight: preflightInput, branchSyncComparison: branchComparison("up_to_date") }
        ],
        waveAssessments: [testCase.assessment(preflightInput)]
      });

      assert.deepEqual(evaluation.readyWorkstreamIds, [], testCase.name);
      assert.equal(evaluation.waveAssessmentGates[0]?.status, testCase.status, testCase.name);
      assert.equal(evaluation.waveAssessmentGates[0]?.reason, testCase.reason, testCase.name);
      assert.equal(evaluation.result.advanced.length, 0, testCase.name);
      assert.equal(evaluation.result.workstreams[wsId]?.packetPlan?.currentWaveIndex, 0, testCase.name);
    }
  });
});
