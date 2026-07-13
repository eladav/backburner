import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  evaluatePacketWaveAdvancement,
  type ParentBranchSyncPreflightEvaluationInput
} from "../src/workstreams/branch-sync.js";
import type { BranchSyncComparison } from "../src/git/types.js";
import type {
  WaveAssessmentResult,
  WorkstreamRecord,
  WorkstreamPacketPlan
} from "../src/state/types.js";
import type { ParentBranchSyncPreflight } from "../src/tasks/types.js";
import { buildWaveAssessmentCheckpointForPreflight } from "../src/workstreams/wave-assessment/checkpoint.js";

function comparison(status: BranchSyncComparison["status"]): BranchSyncComparison {
  return {
    parentBranch: "agent/owner-repo/issue-132",
    defaultBranch: "main",
    parentRef: "refs/remotes/origin/agent/owner-repo/issue-132",
    defaultRef: "refs/remotes/origin/main",
    status,
    message: status
  };
}

function advanceablePacketPlan(): WorkstreamPacketPlan {
  return {
    status: "approved",
    packets: {
      T1: {
        id: "T1",
        title: "T1",
        summary: "S1",
        acceptanceCriteria: [],
        filesLikelyTouched: [],
        dependsOn: [],
        canRunInParallelWith: [],
        blocks: [],
        status: "merged_to_parent"
      },
      T2: {
        id: "T2",
        title: "T2",
        summary: "S2",
        acceptanceCriteria: [],
        filesLikelyTouched: [],
        dependsOn: [],
        canRunInParallelWith: [],
        blocks: [],
        status: "planned"
      }
    },
    waves: [["T1"], ["T2"]],
    currentWaveIndex: 0
  };
}

function workstream(id: string, packetPlan?: WorkstreamPacketPlan): WorkstreamRecord {
  const ws: WorkstreamRecord = {
    id,
    repoKey: "owner/repo",
    origin: { type: "issue", number: parseInt(id.split(":").pop() || "0", 10) },
    linkedIssueNumber: parseInt(id.split(":").pop() || "0", 10),
    linkedPrs: [],
    phase: "implementation_ready",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: {
      branchName: `agent/owner-repo/issue-${id.split(":").pop()}`,
      prNumber: 100
    }
  };

  if (packetPlan) {
    ws.packetPlan = packetPlan;
  }

  return ws;
}

function preflight(workstreamId: string): ParentBranchSyncPreflight {
  return {
    workstreamId,
    repoKey: "owner/repo",
    parentIntegrationBranch: `agent/owner-repo/issue-${workstreamId.split(":").pop()}`,
    defaultBranch: "main",
    currentWaveIndex: 0,
    nextWaveIndex: 1,
    completedPacketIds: ["T1"],
    pendingFuturePacketIds: ["T2"]
  };
}

function waveAssessment(preflightInput: ParentBranchSyncPreflight): WaveAssessmentResult {
  const checkpoint = buildWaveAssessmentCheckpointForPreflight(preflightInput);
  return {
    id: `assessment:${checkpoint.id}`,
    sessionId: checkpoint.sessionId,
    checkpoint,
    decision: "continue",
    summary: "Wave is ready to continue.",
    findings: [],
    status: "finalized",
    postedCommentId: "12345"
  };
}

describe("evaluatePacketWaveAdvancement", () => {
  it("advances a ready and complete workstream", () => {
    const ws = workstream("ws-1", advanceablePacketPlan());
    const preflightInput = preflight("ws-1");
    const input = {
      workstreams: [ws],
      parentBranchSyncPreflights: [
        {
          preflight: preflightInput,
          branchSyncComparison: comparison("up_to_date")
        }
      ],
      waveAssessments: [waveAssessment(preflightInput)]
    };

    const evaluation = evaluatePacketWaveAdvancement(input);

    assert.deepEqual(evaluation.readyWorkstreamIds, ["ws-1"]);
    assert.equal(evaluation.result.advanced.length, 1);
    assert.equal(evaluation.result.advanced[0]!.workstreamId, "ws-1");
    assert.equal(evaluation.result.advanced[0]!.toWaveIndex, 1);
    assert.equal(evaluation.result.workstreams["ws-1"]!.packetPlan?.currentWaveIndex, 1);
  });

  it("advances when a posted assessment includes a known original planning session", () => {
    const ws = workstream("ws-1", advanceablePacketPlan());
    const preflightInput: ParentBranchSyncPreflight = {
      ...preflight("ws-1"),
      originalPlanningSessionId: "planner-session-123"
    };
    const input = {
      workstreams: [ws],
      parentBranchSyncPreflights: [
        {
          preflight: preflightInput,
          branchSyncComparison: comparison("up_to_date")
        }
      ],
      waveAssessments: [waveAssessment(preflightInput)]
    };

    const evaluation = evaluatePacketWaveAdvancement(input);

    assert.deepEqual(evaluation.readyWorkstreamIds, ["ws-1"]);
    assert.equal(evaluation.result.advanced.length, 1);
    assert.equal(evaluation.result.workstreams["ws-1"]!.packetPlan?.currentWaveIndex, 1);
  });

  it("uses the newest matching assessment when an older replan appears before a newer continue", () => {
    const ws = workstream("ws-1", advanceablePacketPlan());
    const preflightInput = preflight("ws-1");
    const olderReplan: WaveAssessmentResult = {
      ...waveAssessment(preflightInput),
      id: "assessment:older-replan",
      decision: "replan",
      summary: "The original assessment required replanning.",
      postedCommentId: "old-comment",
      createdAt: "2026-04-18T09:00:00.000Z",
      finalizedAt: "2026-04-18T09:00:00.000Z",
      updatedAt: "2026-04-18T09:00:00.000Z"
    };
    const newerContinue: WaveAssessmentResult = {
      ...waveAssessment(preflightInput),
      id: "assessment:newer-continue",
      decision: "continue",
      summary: "Replanning completed and the wave can continue.",
      postedCommentId: "new-comment",
      createdAt: "2026-04-18T10:00:00.000Z",
      finalizedAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:00:00.000Z"
    };

    const evaluation = evaluatePacketWaveAdvancement({
      workstreams: [ws],
      parentBranchSyncPreflights: [
        {
          preflight: preflightInput,
          branchSyncComparison: comparison("up_to_date")
        }
      ],
      waveAssessments: [olderReplan, newerContinue]
    });

    assert.deepEqual(evaluation.readyWorkstreamIds, ["ws-1"]);
    assert.equal(evaluation.waveAssessmentGates[0]?.status, "allowed");
    assert.equal(evaluation.waveAssessmentGates[0]?.assessment?.id, newerContinue.id);
    assert.equal(evaluation.result.advanced.length, 1);
    assert.equal(evaluation.result.workstreams["ws-1"]!.packetPlan?.currentWaveIndex, 1);
  });

  it("skips a workstream that needs sync", () => {
    const ws = workstream("ws-1", advanceablePacketPlan());
    const input = {
      workstreams: [ws],
      parentBranchSyncPreflights: [
        {
          preflight: preflight("ws-1"),
          branchSyncComparison: comparison("behind_default")
        }
      ]
    };

    const evaluation = evaluatePacketWaveAdvancement(input);

    assert.deepEqual(evaluation.readyWorkstreamIds, []);
    assert.equal(evaluation.result.advanced.length, 0);
    assert.equal(evaluation.result.skipped.length, 1);
    assert.equal(evaluation.result.skipped[0]!.workstreamId, "ws-1");
  });

  it("blocks a workstream with various non-ready comparison statuses", () => {
    const statuses: BranchSyncComparison["status"][] = [
      "diverged",
      "missing_parent_branch",
      "missing_default_branch",
      "unknown"
    ];

    for (const status of statuses) {
      const ws = workstream(`ws-${status}`, advanceablePacketPlan());
      const evaluation = evaluatePacketWaveAdvancement({
        workstreams: [ws],
        parentBranchSyncPreflights: [
          {
            preflight: preflight(ws.id),
            branchSyncComparison: comparison(status)
          }
        ]
      });

      assert.deepEqual(evaluation.readyWorkstreamIds, [], `failed for ${status}`);
      assert.equal(evaluation.result.advanced.length, 0, `failed for ${status}`);
    }
  });

  it("blocks a workstream with missing_local_path skipped reason", () => {
    const ws = workstream("ws-1", advanceablePacketPlan());
    const evaluation = evaluatePacketWaveAdvancement({
      workstreams: [ws],
      parentBranchSyncPreflights: [
        {
          preflight: preflight("ws-1"),
          branchSyncComparison: comparison("up_to_date"),
          branchSyncComparisonSkippedReason: "missing_local_path"
        }
      ]
    });

    assert.deepEqual(evaluation.readyWorkstreamIds, []);
    assert.equal(evaluation.result.advanced.length, 0);
  });

  it("preserves ordering of workstreams and preflights", () => {
    const ws1 = workstream("ws-1", advanceablePacketPlan());
    const ws2 = workstream("ws-2", advanceablePacketPlan());
    const preflightInput = preflight("ws-1");
    const input = {
      workstreams: [ws2, ws1], // ws2 then ws1
      parentBranchSyncPreflights: [
        {
          preflight: preflightInput, // ws1 is ready
          branchSyncComparison: comparison("up_to_date")
        },
        {
          preflight: preflight("ws-2"), // ws2 is not ready
          branchSyncComparison: comparison("behind_default")
        }
      ],
      waveAssessments: [waveAssessment(preflightInput)]
    };

    const evaluation = evaluatePacketWaveAdvancement(input);

    // readyWorkstreamIds should follow preflight input order
    assert.deepEqual(evaluation.readyWorkstreamIds, ["ws-1"]);

    // result arrays should follow workstream input order
    assert.equal(evaluation.result.skipped[0]!.workstreamId, "ws-2");
    assert.equal(evaluation.result.advanced[0]!.workstreamId, "ws-1");

    const resultWorkstreamIds = Object.keys(evaluation.result.workstreams);
    assert.deepEqual(resultWorkstreamIds, ["ws-2", "ws-1"]);
  });

  it("safely ignores a ready ID for a missing workstream", () => {
    const preflightInput = preflight("ws-missing");
    const input = {
      workstreams: [],
      parentBranchSyncPreflights: [
        {
          preflight: preflightInput,
          branchSyncComparison: comparison("up_to_date")
        }
      ],
      waveAssessments: [waveAssessment(preflightInput)]
    };

    const evaluation = evaluatePacketWaveAdvancement(input);

    assert.deepEqual(evaluation.readyWorkstreamIds, ["ws-missing"]);
    assert.equal(evaluation.result.advanced.length, 0);
    assert.equal(evaluation.result.blocked.length, 0);
    assert.equal(evaluation.result.skipped.length, 0);
  });

  it("reports a blocked reason when packet plan cannot advance", () => {
    const plan = advanceablePacketPlan();
    plan.packets["T1"]!.status = "planned"; // Incomplete

    const ws = workstream("ws-1", plan);
    const preflightInput = preflight("ws-1");
    const evaluation = evaluatePacketWaveAdvancement({
      workstreams: [ws],
      parentBranchSyncPreflights: [
        {
          preflight: preflightInput,
          branchSyncComparison: comparison("up_to_date")
        }
      ],
      waveAssessments: [waveAssessment(preflightInput)]
    });

    assert.deepEqual(evaluation.readyWorkstreamIds, ["ws-1"]);
    assert.equal(evaluation.result.advanced.length, 0);
    assert.equal(evaluation.result.blocked.length, 1);
    assert.equal(evaluation.result.blocked[0]!.workstreamId, "ws-1");
    assert.equal(evaluation.result.blocked[0]!.reason, "current_wave_incomplete");
  });

  it("does not mutate inputs", () => {
    const ws = workstream("ws-1", advanceablePacketPlan());
    const preflights: ParentBranchSyncPreflightEvaluationInput[] = [
      {
        preflight: preflight("ws-1"),
        branchSyncComparison: comparison("up_to_date")
      }
    ];

    const input = {
      workstreams: [ws],
      parentBranchSyncPreflights: preflights
    };

    const wsClone = structuredClone(ws);
    const preflightsClone = structuredClone(preflights);

    evaluatePacketWaveAdvancement(input);

    assert.deepEqual(input.workstreams, [wsClone]);
    assert.deepEqual(input.parentBranchSyncPreflights, preflightsClone);
  });
});
