import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  applyPlanBreakdownResultsToWorkstreams,
  advanceReadyWorkstreamPacketWaves,
  buildPacketPlanFromPlanBreakdown,
  buildPacketWaveAdvancePreview,
  advancePacketPlanToNextWave,
  advanceWorkstreamPacketPlanToNextWave,
  buildParentBranchSyncPreflight,
  getCurrentWaveIndex,
  getCurrentWavePacketIds,
  getUndispatchedCurrentWavePackets,
  hasFutureWave,
  isCurrentWaveComplete,
  isParentSyncNeededBeforeNextWave,
  markMergedPacketPullRequests,
  markPacketPlanningPrOpen,
  validatePacketPlan
} from "../src/workstreams/packet-plan.js";
import type { NormalizedPullRequest } from "../src/domain/entities.js";
import type {
  ExecutionRecord,
  PlanBreakdownResult,
  TaskRecord,
  WorkstreamPacketPlan,
  WorkstreamRecord,
  WorktreeRecord,
  WorkstreamPacket
} from "../src/state/types.js";

describe("packet-plan", () => {
  const validPlanBreakdown: PlanBreakdownResult = {
    title: "Test Plan",
    summary: "A test plan breakdown",
    tasks: [
      {
        id: "T1",
        title: "Task 1",
        description: "Summary 1",
        dependsOn: [],
        blocks: ["T2"],
        canRunInParallelWith: [],
        risk: "low",
        filesLikelyInvolved: ["file1.ts"],
        acceptanceCriteria: ["AC1"],
        verification: ["V1"]
      },
      {
        id: "T2",
        title: "Task 2",
        description: "Summary 2",
        dependsOn: ["T1"],
        blocks: [],
        canRunInParallelWith: [],
        risk: "medium",
        filesLikelyInvolved: ["file2.ts"],
        acceptanceCriteria: ["AC2"],
        verification: ["V2"]
      },
      {
        id: "T3",
        title: "Task 3",
        description: "Summary 3",
        dependsOn: [],
        blocks: [],
        canRunInParallelWith: [],
        risk: "high",
        filesLikelyInvolved: ["file3.ts"],
        acceptanceCriteria: ["AC3"],
        verification: ["V3"]
      }
    ],
    waves: [
      { id: "W1", taskIds: ["T1"], rationale: "R1" },
      { id: "W2", taskIds: ["T2", "T3"], rationale: "R2" }
    ],
    recommendedFirstWaveId: "W1",
    graphConcerns: [],
    humanDecisionsNeeded: [],
    suggestedNextAction: "Proceed"
  };

  it("converts PlanBreakdownResult to WorkstreamPacketPlan", () => {
    const packetPlan = buildPacketPlanFromPlanBreakdown({
      workstreamId: "repo:issue:1",
      planBreakdown: validPlanBreakdown,
      generatedAt: "2024-01-01T00:00:00Z"
    });

    assert.strictEqual(packetPlan.status, "proposed");
    assert.strictEqual(packetPlan.currentWaveIndex, 0);
    assert.strictEqual(packetPlan.source?.kind, "plan_breakdown_result");
    assert.strictEqual(packetPlan.source?.workstreamId, "repo:issue:1");
    assert.strictEqual(packetPlan.source?.generatedAt, "2024-01-01T00:00:00Z");
    assert.deepStrictEqual(packetPlan.waves, [["T1"], ["T2", "T3"]]);

    const t1 = packetPlan.packets["T1"];
    assert.ok(t1);
    assert.strictEqual(t1.id, "T1");
    assert.strictEqual(t1.summary, "Summary 1");
    assert.deepStrictEqual(t1.filesLikelyTouched, ["file1.ts"]);
    assert.strictEqual(t1.status, "planned");

    const t2 = packetPlan.packets["T2"];
    assert.ok(t2);
    assert.deepStrictEqual(t2.dependsOn, ["T1"]);
  });

  it("throws when plan breakdown has duplicate task IDs", () => {
    const invalidPlan: PlanBreakdownResult = {
      ...validPlanBreakdown,
      tasks: [
        ...validPlanBreakdown.tasks,
        { ...validPlanBreakdown.tasks[0]!, id: "T1" }
      ]
    };

    assert.throws(() => {
      buildPacketPlanFromPlanBreakdown({
        workstreamId: "repo:issue:1",
        planBreakdown: invalidPlan
      });
    }, {
      message: /Duplicate task ID/
    });
  });

  it("throws when plan breakdown has empty task IDs", () => {
    const invalidPlan: PlanBreakdownResult = {
      ...validPlanBreakdown,
      tasks: [
        ...validPlanBreakdown.tasks,
        { ...validPlanBreakdown.tasks[0]!, id: "" }
      ]
    };

    assert.throws(() => {
      buildPacketPlanFromPlanBreakdown({
        workstreamId: "repo:issue:1",
        planBreakdown: invalidPlan
      });
    }, {
      message: /Task ID must not be empty/
    });
  });

  describe("validation", () => {
    const buildValidPacketPlan = (): WorkstreamPacketPlan => ({
      status: "proposed",
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
          status: "planned"
        },
        T2: {
          id: "T2",
          title: "T2",
          summary: "S2",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: ["T1"],
          canRunInParallelWith: [],
          blocks: [],
          status: "planned"
        }
      },
      waves: [["T1"], ["T2"]],
      currentWaveIndex: 0
    });

    it("accepts a valid plan", () => {
      const errors = validatePacketPlan(buildValidPacketPlan());
      assert.strictEqual(errors.length, 0);
    });

    it("rejects unknown wave packet ID", () => {
      const plan = buildValidPacketPlan();
      plan.waves[0]!.push("UNKNOWN");
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('references unknown packet ID: "UNKNOWN"')));
    });

    it("rejects duplicate packet ID across two waves", () => {
      const plan = buildValidPacketPlan();
      plan.waves[1]!.push("T1");
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet ID "T1" appears in more than one wave')));
    });

    it("rejects duplicate packet ID inside one wave", () => {
      const plan = buildValidPacketPlan();
      plan.waves[0]!.push("T1");
      // Note: seenInWaves will catch this as "appears in more than one wave"
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet ID "T1" appears in more than one wave')));
    });

    it("rejects packet missing from all waves", () => {
      const plan = buildValidPacketPlan();
      plan.waves = [["T1"]];
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet ID "T2" is missing from all waves')));
    });

    it("rejects empty waves", () => {
      const plan = buildValidPacketPlan();
      plan.waves = [];
      const errors = validatePacketPlan(plan);
      assert.ok(errors.includes("Waves must be a non-empty array"));
    });

    it("rejects empty wave", () => {
      const plan = buildValidPacketPlan();
      plan.waves.push([]);
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes("must be a non-empty array")));
    });

    it("rejects self dependency", () => {
      const plan = buildValidPacketPlan();
      plan.packets["T1"]!.dependsOn = ["T1"];
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet "T1" has a self-reference in dependsOn')));
    });

    it("rejects unknown dependsOn", () => {
      const plan = buildValidPacketPlan();
      plan.packets["T1"]!.dependsOn = ["UNKNOWN"];
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet "T1" references unknown packet ID "UNKNOWN" in dependsOn')));
    });

    it("rejects unknown blocks", () => {
      const plan = buildValidPacketPlan();
      plan.packets["T1"]!.blocks = ["UNKNOWN"];
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet "T1" references unknown packet ID "UNKNOWN" in blocks')));
    });

    it("rejects unknown canRunInParallelWith", () => {
      const plan = buildValidPacketPlan();
      plan.packets["T1"]!.canRunInParallelWith = ["UNKNOWN"];
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet "T1" references unknown packet ID "UNKNOWN" in canRunInParallelWith')));
    });

    it("rejects duplicate IDs inside each dependency array type", () => {
      const plan = buildValidPacketPlan();
      plan.packets["T2"]!.dependsOn = ["T1", "T1"];
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet "T2" has duplicate reference "T1" in dependsOn')));
    });

    it("rejects dependency on a later-wave packet", () => {
      const plan = buildValidPacketPlan();
      plan.packets["T1"]!.dependsOn = ["T2"];
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet "T1" (wave 0) depends on "T2" which is in a later wave (1)')));
    });

    it("rejects dependency on a same-wave packet", () => {
      const plan = buildValidPacketPlan();
      plan.waves = [["T1", "T2"]];
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet "T2" (wave 0) depends on "T1" in the same wave')));
    });

    it("rejects dictionary key that does not match packet.id", () => {
      const plan = buildValidPacketPlan();
      plan.packets["WRONG_KEY"] = plan.packets["T1"]!;
      delete plan.packets["T1"];
      plan.waves[0]![0] = "WRONG_KEY";
      const errors = validatePacketPlan(plan);
      assert.ok(errors.some(e => e.includes('Packet ID mismatch: dictionary key "WRONG_KEY" does not match packet.id "T1"')));
    });
  });

  describe("helpers", () => {
    const packetPlan: WorkstreamPacketPlan = {
      status: "proposed",
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
          status: "planned"
        },
        T2: {
          id: "T2",
          title: "T2",
          summary: "S2",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: ["T1"],
          canRunInParallelWith: [],
          blocks: [],
          status: "planned"
        },
        T3: {
          id: "T3",
          title: "T3",
          summary: "S3",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "planned"
        }
      },
      waves: [["T1", "T2"], ["T3"]],
      currentWaveIndex: 0
    };

    it("getCurrentWaveIndex defaults to 0", () => {
      assert.strictEqual(getCurrentWaveIndex({ ...packetPlan, currentWaveIndex: undefined }), 0);
    });

    it("getCurrentWavePacketIds returns correct packet IDs", () => {
      assert.deepStrictEqual(getCurrentWavePacketIds(packetPlan), ["T1", "T2"]);
      assert.deepStrictEqual(getCurrentWavePacketIds({ ...packetPlan, currentWaveIndex: 1 }), ["T3"]);
    });

    it("getCurrentWavePacketIds returns [] for out of range index", () => {
      assert.strictEqual(getCurrentWaveIndex({ ...packetPlan, currentWaveIndex: 2 }), 2); // Helper only defaults if undefined
      assert.deepStrictEqual(getCurrentWavePacketIds({ ...packetPlan, currentWaveIndex: 2 }), []);
    });

    describe("isCurrentWaveComplete", () => {
      it("returns true when all current-wave packets are merged_to_parent", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          packets: {
            ...packetPlan.packets,
            T1: { ...packetPlan.packets["T1"]!, status: "merged_to_parent" },
            T2: { ...packetPlan.packets["T2"]!, status: "merged_to_parent" }
          }
        };

        assert.strictEqual(isCurrentWaveComplete(plan), true);
      });

      it("ignores future waves", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          packets: {
            ...packetPlan.packets,
            T1: { ...packetPlan.packets["T1"]!, status: "merged_to_parent" },
            T2: { ...packetPlan.packets["T2"]!, status: "merged_to_parent" },
            T3: { ...packetPlan.packets["T3"]!, status: "planned" }
          }
        };

        assert.strictEqual(isCurrentWaveComplete(plan), true);
      });

      it("defaults currentWaveIndex to zero", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          currentWaveIndex: undefined,
          packets: {
            ...packetPlan.packets,
            T1: { ...packetPlan.packets["T1"]!, status: "merged_to_parent" },
            T2: { ...packetPlan.packets["T2"]!, status: "merged_to_parent" }
          }
        };

        assert.strictEqual(isCurrentWaveComplete(plan), true);
      });

      it("returns false when any current-wave packet is not merged_to_parent", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          packets: {
            ...packetPlan.packets,
            T1: { ...packetPlan.packets["T1"]!, status: "merged_to_parent" },
            T2: { ...packetPlan.packets["T2"]!, status: "planned" }
          }
        };

        assert.strictEqual(isCurrentWaveComplete(plan), false);
      });

      it("returns false for missing current-wave packet id", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          waves: [["T1", "MISSING"], ["T3"]],
          packets: {
            ...packetPlan.packets,
            T1: { ...packetPlan.packets["T1"]!, status: "merged_to_parent" }
          }
        };

        assert.strictEqual(isCurrentWaveComplete(plan), false);
      });

      it("returns false for empty current wave", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          waves: [[], ["T3"]]
        };

        assert.strictEqual(isCurrentWaveComplete(plan), false);
      });

      it("returns false for out-of-range currentWaveIndex", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          currentWaveIndex: 2
        };

        assert.strictEqual(isCurrentWaveComplete(plan), false);
      });
    });

    describe("hasFutureWave", () => {
      it("returns true when currentWaveIndex is before the final wave", () => {
        assert.strictEqual(hasFutureWave(packetPlan), true);
      });

      it("defaults missing currentWaveIndex to zero", () => {
        assert.strictEqual(hasFutureWave({ ...packetPlan, currentWaveIndex: undefined }), true);
      });

      it("returns false for the final wave", () => {
        assert.strictEqual(hasFutureWave({ ...packetPlan, currentWaveIndex: 1 }), false);
      });

      it("returns false for negative currentWaveIndex", () => {
        assert.strictEqual(hasFutureWave({ ...packetPlan, currentWaveIndex: -1 }), false);
      });

      it("returns false for out-of-range currentWaveIndex", () => {
        assert.strictEqual(hasFutureWave({ ...packetPlan, currentWaveIndex: 2 }), false);
      });
    });

    describe("isParentSyncNeededBeforeNextWave", () => {
      it("returns true when current wave is complete and a future wave exists", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          packets: {
            ...packetPlan.packets,
            T1: { ...packetPlan.packets["T1"]!, status: "merged_to_parent" },
            T2: { ...packetPlan.packets["T2"]!, status: "merged_to_parent" }
          }
        };
        assert.strictEqual(isParentSyncNeededBeforeNextWave(plan), true);
      });

      it("returns false when current wave is incomplete and a future wave exists", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          packets: {
            ...packetPlan.packets,
            T1: { ...packetPlan.packets["T1"]!, status: "merged_to_parent" },
            T2: { ...packetPlan.packets["T2"]!, status: "planned" }
          }
        };
        assert.strictEqual(isParentSyncNeededBeforeNextWave(plan), false);
      });

      it("returns false when current wave is complete but no future wave exists", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          currentWaveIndex: 1,
          packets: {
            ...packetPlan.packets,
            T3: { ...packetPlan.packets["T3"]!, status: "merged_to_parent" }
          }
        };
        assert.strictEqual(isParentSyncNeededBeforeNextWave(plan), false);
      });

      it("defaults missing currentWaveIndex to zero", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          currentWaveIndex: undefined,
          packets: {
            ...packetPlan.packets,
            T1: { ...packetPlan.packets["T1"]!, status: "merged_to_parent" },
            T2: { ...packetPlan.packets["T2"]!, status: "merged_to_parent" }
          }
        };
        assert.strictEqual(isParentSyncNeededBeforeNextWave(plan), true);
      });

      it("returns false for out-of-range currentWaveIndex", () => {
        const plan: WorkstreamPacketPlan = {
          ...packetPlan,
          currentWaveIndex: 2
        };
        assert.strictEqual(isParentSyncNeededBeforeNextWave(plan), false);
      });
    });

    describe("buildParentBranchSyncPreflight", () => {
      const baseWorkstream: WorkstreamRecord = {
        id: "owner/repo:issue:123",
        repoKey: "owner/repo",
        origin: { type: "issue", number: 123 },
        linkedIssueNumber: 123,
        linkedPrs: [],
        phase: "implementation_ready",
        attention: "idle",
        status: "open",
        resolution: "unresolved",
        integration: {
          branchName: "agent/owner-repo/issue-123",
          prNumber: 77
        },
        packetPlan: {
          status: "approved",
          packets: {
            T1: { id: "T1", title: "T1", summary: "S1", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "merged_to_parent" },
            T2: { id: "T2", title: "T2", summary: "S2", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "merged_to_parent" },
            T3: { id: "T3", title: "T3", summary: "S3", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" },
            T4: { id: "T4", title: "T4", summary: "S4", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" },
            T5: { id: "T5", title: "T5", summary: "S5", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" }
          },
          waves: [["T1", "T2"], ["T3"], ["T4", "T5"]],
          currentWaveIndex: 0
        }
      };

      it("returns a preflight object for completed current wave with at least one future wave", () => {
        const result = buildParentBranchSyncPreflight({
          workstream: baseWorkstream,
          defaultBranch: "main"
        });

        assert.ok(result);
        assert.strictEqual(result.workstreamId, "owner/repo:issue:123");
        assert.strictEqual(result.repoKey, "owner/repo");
        assert.strictEqual(result.parentIntegrationBranch, "agent/owner-repo/issue-123");
        assert.strictEqual(result.parentPrNumber, 77);
        assert.strictEqual(result.defaultBranch, "main");
        assert.strictEqual(result.currentWaveIndex, 0);
        assert.strictEqual(result.nextWaveIndex, 1);
        assert.deepStrictEqual(result.completedPacketIds, ["T1", "T2"]);
        assert.deepStrictEqual(result.pendingFuturePacketIds, ["T3", "T4", "T5"]);
      });

      it("returns undefined when current wave is incomplete", () => {
        const workstream = structuredClone(baseWorkstream);
        workstream.packetPlan!.packets["T2"]!.status = "planned";

        const result = buildParentBranchSyncPreflight({
          workstream,
          defaultBranch: "main"
        });

        assert.strictEqual(result, undefined);
      });

      it("returns undefined when current wave is complete but it is the final wave", () => {
        const workstream = structuredClone(baseWorkstream);
        workstream.packetPlan!.currentWaveIndex = 2;
        workstream.packetPlan!.packets["T4"]!.status = "merged_to_parent";
        workstream.packetPlan!.packets["T5"]!.status = "merged_to_parent";

        const result = buildParentBranchSyncPreflight({
          workstream,
          defaultBranch: "main"
        });

        assert.strictEqual(result, undefined);
      });

      it("returns undefined when parent integration branch is missing", () => {
        const workstream = structuredClone(baseWorkstream);
        delete workstream.integration;

        const result = buildParentBranchSyncPreflight({
          workstream,
          defaultBranch: "main"
        });

        assert.strictEqual(result, undefined);
      });

      it("returns undefined when defaultBranch is missing", () => {
        const result = buildParentBranchSyncPreflight({
          workstream: baseWorkstream,
          defaultBranch: undefined
        });

        assert.strictEqual(result, undefined);
      });

      it("defaults missing currentWaveIndex to 0", () => {
        const workstream = structuredClone(baseWorkstream);
        delete workstream.packetPlan!.currentWaveIndex;

        const result = buildParentBranchSyncPreflight({
          workstream,
          defaultBranch: "main"
        });

        assert.ok(result);
        assert.strictEqual(result.currentWaveIndex, 0);
        assert.strictEqual(result.nextWaveIndex, 1);
      });

      it("preserves future packet order across multiple future waves", () => {
        const result = buildParentBranchSyncPreflight({
          workstream: baseWorkstream,
          defaultBranch: "main"
        });

        assert.ok(result);
        assert.deepStrictEqual(result.pendingFuturePacketIds, ["T3", "T4", "T5"]);
      });

      it("does not mutate the input workstream or packet plan", () => {
        const workstream = structuredClone(baseWorkstream);
        const before = structuredClone(workstream);

        const result = buildParentBranchSyncPreflight({
          workstream,
          defaultBranch: "main"
        });

        assert.ok(result);
        assert.deepStrictEqual(workstream, before);

        // Assert returned arrays are not the same reference
        assert.notStrictEqual(result.completedPacketIds, workstream.packetPlan!.waves[0]);
        assert.notStrictEqual(result.pendingFuturePacketIds, workstream.packetPlan!.waves[1]);
      });

      it("returns an object without parentPrNumber when workstream.integration.prNumber is absent", () => {
        const workstream = structuredClone(baseWorkstream);
        delete workstream.integration!.prNumber;

        const result = buildParentBranchSyncPreflight({
          workstream,
          defaultBranch: "main"
        });

        assert.ok(result);
        assert.strictEqual(result.parentPrNumber, undefined);
        assert.ok(!("parentPrNumber" in result));
      });
    });

    it("getUndispatchedCurrentWavePackets skips packets with branchName or prNumber", () => {
      const plan: WorkstreamPacketPlan = {
        ...packetPlan,
        packets: {
          ...packetPlan.packets,
          T1: { ...packetPlan.packets["T1"]!, branchName: "branch-1" },
          T2: { ...packetPlan.packets["T2"]!, prNumber: 123 }
        }
      };
      assert.deepStrictEqual(getUndispatchedCurrentWavePackets(plan), []);

      const plan2: WorkstreamPacketPlan = {
        ...packetPlan,
        packets: {
          ...packetPlan.packets,
          T1: { ...packetPlan.packets["T1"]!, branchName: "branch-1" }
        }
      };
      assert.deepStrictEqual(getUndispatchedCurrentWavePackets(plan2).map(p => p.id), ["T2"]);
    });

    it("getUndispatchedCurrentWavePackets skips packets with dispatched status even if branchName/prNumber are missing", () => {
      const plan: WorkstreamPacketPlan = {
        ...packetPlan,
        packets: {
          ...packetPlan.packets,
          T1: { ...packetPlan.packets["T1"]!, status: "branch_created" },
          T2: { ...packetPlan.packets["T2"]!, status: "pr_open" }
        }
      };
      assert.deepStrictEqual(getUndispatchedCurrentWavePackets(plan), []);
    });

    it("markPacketPlanningPrOpen updates packet status and PR info while preserving others", () => {
      const updated = markPacketPlanningPrOpen({
        packetPlan: { ...packetPlan, currentWaveIndex: 1 },
        packetId: "T1",
        branchName: "branch-1",
        prNumber: 123,
        updatedAt: "2024-01-01T00:00:00Z"
      });

      assert.strictEqual(updated.packets["T1"]?.status, "pr_open");
      assert.strictEqual(updated.packets["T1"]?.branchName, "branch-1");
      assert.strictEqual(updated.packets["T1"]?.prNumber, 123);
      assert.strictEqual(updated.packets["T1"]?.updatedAt, "2024-01-01T00:00:00Z");

      // Preserves others
      assert.strictEqual(updated.packets["T2"]?.status, "planned");
      assert.strictEqual(updated.currentWaveIndex, 1);
      assert.deepStrictEqual(updated.waves, packetPlan.waves);

      // Original is not mutated
      assert.strictEqual(packetPlan.packets["T1"]?.status, "planned");
      assert.strictEqual(packetPlan.packets["T1"]?.branchName, undefined);
    });

    it("markMergedPacketPullRequests marks a packet merged by PR number", () => {
      const plan: WorkstreamPacketPlan = {
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
            status: "pr_open",
            prNumber: 101,
            branchName: "branch-1"
          }
        },
        waves: [["T1"]],
        currentWaveIndex: 0
      };

      const packetWorktree: WorktreeRecord = {
        id: "wt-1",
        repoId: "repo-1",
        repoSlug: "owner/repo",
        repoName: "repo",
        branchName: "branch-1",
        prNumber: 101,
        packet: {
          parentWorkstreamId: "parent-1",
          packetId: "T1",
          waveIndex: 0,
          parentIntegrationBranch: "integration-branch"
        },
        path: "/path",
        planDocumentPath: "/plan",
        logDocumentPath: "/log",
        status: "implementing",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const mergedPr: NormalizedPullRequest = {
        id: "pr-1",
        kind: "pull_request",
        repoId: "repo-1",
        repoKey: "owner/repo",
        repoOwner: "owner",
        repoName: "repo",
        repoSlug: "owner/repo",
        number: 101,
        key: "owner/repo#101",
        sourceId: "pr:101",
        url: "url",
        title: "PR 101",
        body: "body",
        labels: [],
        author: "author",
        state: "merged",
        headBranch: "branch-1",
        headSha: "sha",
        baseBranch: "integration-branch",
        defaultBranch: "main",
        baseClassification: "non_default_parent",
        isDraft: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const updated = markMergedPacketPullRequests({
        packetPlan: plan,
        parentWorkstreamId: "parent-1",
        repoId: "repo-1",
        packetWorktrees: [packetWorktree],
        pullRequests: [mergedPr]
      });

      assert.strictEqual(updated.packets["T1"]?.status, "merged_to_parent");
      assert.strictEqual(updated.packets["T1"]?.prNumber, 101);
      assert.strictEqual(updated.packets["T1"]?.branchName, "branch-1");
      assert.deepStrictEqual(updated.waves, plan.waves);
    });

    it("markMergedPacketPullRequests marks a packet merged by branch when prNumber is absent in worktree", () => {
      const plan: WorkstreamPacketPlan = {
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
            status: "branch_created",
            branchName: "branch-1"
          }
        },
        waves: [["T1"]],
        currentWaveIndex: 0
      };

      const packetWorktree: WorktreeRecord = {
        id: "wt-1",
        repoId: "repo-1",
        repoSlug: "owner/repo",
        repoName: "repo",
        branchName: "branch-1",
        // prNumber is undefined
        packet: {
          parentWorkstreamId: "parent-1",
          packetId: "T1",
          waveIndex: 0,
          parentIntegrationBranch: "integration-branch"
        },
        path: "/path",
        planDocumentPath: "/plan",
        logDocumentPath: "/log",
        status: "implementing",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const mergedPr: NormalizedPullRequest = {
        id: "pr-1",
        kind: "pull_request",
        repoId: "repo-1",
        repoKey: "owner/repo",
        repoOwner: "owner",
        repoName: "repo",
        repoSlug: "owner/repo",
        number: 101,
        key: "owner/repo#101",
        sourceId: "pr:101",
        url: "url",
        title: "PR 101",
        body: "body",
        labels: [],
        author: "author",
        state: "merged",
        headBranch: "branch-1",
        headSha: "sha",
        baseBranch: "integration-branch",
        defaultBranch: "main",
        baseClassification: "non_default_parent",
        isDraft: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const updated = markMergedPacketPullRequests({
        packetPlan: plan,
        parentWorkstreamId: "parent-1",
        repoId: "repo-1",
        packetWorktrees: [packetWorktree],
        pullRequests: [mergedPr]
      });

      assert.strictEqual(updated.packets["T1"]?.status, "merged_to_parent");
      assert.strictEqual(updated.packets["T1"]?.prNumber, 101);
      assert.strictEqual(updated.packets["T1"]?.branchName, "branch-1");
    });

    it("markMergedPacketPullRequests falls back to branch when prNumber does not match a current PR", () => {
      const plan: WorkstreamPacketPlan = {
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
            status: "pr_open",
            prNumber: 999,
            branchName: "branch-1"
          }
        },
        waves: [["T1"]],
        currentWaveIndex: 0
      };

      const packetWorktree: WorktreeRecord = {
        id: "wt-1",
        repoId: "repo-1",
        repoSlug: "owner/repo",
        repoName: "repo",
        branchName: "branch-1",
        prNumber: 999,
        packet: {
          parentWorkstreamId: "parent-1",
          packetId: "T1",
          waveIndex: 0,
          parentIntegrationBranch: "integration-branch"
        },
        path: "/path",
        planDocumentPath: "/plan",
        logDocumentPath: "/log",
        status: "implementing",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const mergedPrWithDifferentNumber: NormalizedPullRequest = {
        id: "pr-1",
        kind: "pull_request",
        repoId: "repo-1",
        repoKey: "owner/repo",
        repoOwner: "owner",
        repoName: "repo",
        repoSlug: "owner/repo",
        number: 101,
        key: "owner/repo#101",
        sourceId: "pr:101",
        url: "url",
        title: "PR 101",
        body: "body",
        labels: [],
        author: "author",
        state: "merged",
        headBranch: "branch-1", // Same branch
        headSha: "sha",
        baseBranch: "integration-branch",
        defaultBranch: "main",
        baseClassification: "non_default_parent",
        isDraft: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const updated = markMergedPacketPullRequests({
        packetPlan: plan,
        parentWorkstreamId: "parent-1",
        repoId: "repo-1",
        packetWorktrees: [packetWorktree],
        pullRequests: [mergedPrWithDifferentNumber]
      });

      assert.strictEqual(updated.packets["T1"]?.status, "merged_to_parent");
      assert.strictEqual(updated.packets["T1"]?.prNumber, 101);
      assert.strictEqual(updated.packets["T1"]?.branchName, "branch-1");
      // Original remains unchanged
      assert.strictEqual(plan.packets["T1"]?.status, "pr_open");
    });

    it("markMergedPacketPullRequests ignores closed but unmerged PR", () => {
      const plan: WorkstreamPacketPlan = {
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
            status: "pr_open",
            prNumber: 101,
            branchName: "branch-1"
          }
        },
        waves: [["T1"]],
        currentWaveIndex: 0
      };

      const packetWorktree: WorktreeRecord = {
        id: "wt-1",
        repoId: "repo-1",
        repoSlug: "owner/repo",
        repoName: "repo",
        branchName: "branch-1",
        prNumber: 101,
        packet: {
          parentWorkstreamId: "parent-1",
          packetId: "T1",
          waveIndex: 0,
          parentIntegrationBranch: "integration-branch"
        },
        path: "/path",
        planDocumentPath: "/plan",
        logDocumentPath: "/log",
        status: "implementing",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const closedPr: NormalizedPullRequest = {
        id: "pr-1",
        kind: "pull_request",
        repoId: "repo-1",
        repoKey: "owner/repo",
        repoOwner: "owner",
        repoName: "repo",
        repoSlug: "owner/repo",
        number: 101,
        key: "owner/repo#101",
        sourceId: "pr:101",
        url: "url",
        title: "PR 101",
        body: "body",
        labels: [],
        author: "author",
        state: "closed",
        headBranch: "branch-1",
        headSha: "sha",
        baseBranch: "integration-branch",
        defaultBranch: "main",
        baseClassification: "non_default_parent",
        isDraft: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const updated = markMergedPacketPullRequests({
        packetPlan: plan,
        parentWorkstreamId: "parent-1",
        repoId: "repo-1",
        packetWorktrees: [packetWorktree],
        pullRequests: [closedPr]
      });

      assert.strictEqual(updated, plan);
    });

    it("markMergedPacketPullRequests does not fall back from wrong-base prNumber match to branch match", () => {
      const plan: WorkstreamPacketPlan = {
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
            status: "pr_open",
            prNumber: 999,
            branchName: "branch-1"
          }
        },
        waves: [["T1"]],
        currentWaveIndex: 0
      };

      const packetWorktree: WorktreeRecord = {
        id: "wt-1",
        repoId: "repo-1",
        repoSlug: "owner/repo",
        repoName: "repo",
        branchName: "branch-1",
        prNumber: 999,
        packet: {
          parentWorkstreamId: "parent-1",
          packetId: "T1",
          waveIndex: 0,
          parentIntegrationBranch: "integration-branch"
        },
        path: "/path",
        planDocumentPath: "/plan",
        logDocumentPath: "/log",
        status: "implementing",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const wrongBasePr: NormalizedPullRequest = {
        id: "pr-999",
        kind: "pull_request",
        repoId: "repo-1",
        repoKey: "owner/repo",
        repoOwner: "owner",
        repoName: "repo",
        repoSlug: "owner/repo",
        number: 999,
        key: "owner/repo#999",
        sourceId: "pr:999",
        url: "url",
        title: "PR 999",
        body: "body",
        labels: [],
        author: "author",
        state: "merged",
        headBranch: "some-other-branch",
        headSha: "sha",
        baseBranch: "main", // Wrong base branch
        defaultBranch: "main",
        baseClassification: "top_level",
        isDraft: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const correctBranchPr: NormalizedPullRequest = {
        id: "pr-101",
        kind: "pull_request",
        repoId: "repo-1",
        repoKey: "owner/repo",
        repoOwner: "owner",
        repoName: "repo",
        repoSlug: "owner/repo",
        number: 101,
        key: "owner/repo#101",
        sourceId: "pr:101",
        url: "url",
        title: "PR 101",
        body: "body",
        labels: [],
        author: "author",
        state: "merged",
        headBranch: "branch-1", // Correct branch
        headSha: "sha",
        baseBranch: "integration-branch", // Correct base
        defaultBranch: "main",
        baseClassification: "non_default_parent",
        isDraft: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const updated = markMergedPacketPullRequests({
        packetPlan: plan,
        parentWorkstreamId: "parent-1",
        repoId: "repo-1",
        packetWorktrees: [packetWorktree],
        pullRequests: [wrongBasePr, correctBranchPr]
      });

      assert.strictEqual(updated, plan);
      assert.strictEqual(updated.packets["T1"]?.status, "pr_open");
      assert.strictEqual(updated.packets["T1"]?.prNumber, 999);
    });

    it("markMergedPacketPullRequests is repo-scoped", () => {
      const plan: WorkstreamPacketPlan = {
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
            status: "pr_open",
            prNumber: 101,
            branchName: "branch-1"
          }
        },
        waves: [["T1"]],
        currentWaveIndex: 0
      };

      const packetWorktree: WorktreeRecord = {
        id: "wt-1",
        repoId: "repo-1",
        repoSlug: "owner/repo-1",
        repoName: "repo-1",
        branchName: "branch-1",
        prNumber: 101,
        packet: {
          parentWorkstreamId: "parent-1",
          packetId: "T1",
          waveIndex: 0,
          parentIntegrationBranch: "integration-branch"
        },
        path: "/path",
        planDocumentPath: "/plan",
        logDocumentPath: "/log",
        status: "implementing",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const mergedPrInOtherRepo: NormalizedPullRequest = {
        id: "pr-2",
        kind: "pull_request",
        repoId: "repo-2",
        repoKey: "owner/repo-2",
        repoOwner: "owner",
        repoName: "repo-2",
        repoSlug: "owner/repo-2",
        number: 101,
        key: "owner/repo-2#101",
        sourceId: "pr:101",
        url: "url",
        title: "PR 101",
        body: "body",
        labels: [],
        author: "author",
        state: "merged",
        headBranch: "branch-1",
        headSha: "sha",
        baseBranch: "integration-branch",
        defaultBranch: "main",
        baseClassification: "non_default_parent",
        isDraft: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const updated = markMergedPacketPullRequests({
        packetPlan: plan,
        parentWorkstreamId: "parent-1",
        repoId: "repo-1",
        packetWorktrees: [packetWorktree],
        pullRequests: [mergedPrInOtherRepo]
      });

      assert.strictEqual(updated, plan);
    });

    it("markMergedPacketPullRequests preserves other packet statuses and waves", () => {
      const plan: WorkstreamPacketPlan = {
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
            status: "pr_open",
            prNumber: 101,
            branchName: "branch-1"
          },
          T2: {
            id: "T2",
            title: "T2",
            summary: "S2",
            acceptanceCriteria: [],
            filesLikelyTouched: [],
            dependsOn: ["T1"],
            canRunInParallelWith: [],
            blocks: [],
            status: "planned"
          }
        },
        waves: [["T1"], ["T2"]],
        currentWaveIndex: 0
      };

      const packetWorktree: WorktreeRecord = {
        id: "wt-1",
        repoId: "repo-1",
        repoSlug: "owner/repo",
        repoName: "repo",
        branchName: "branch-1",
        prNumber: 101,
        packet: {
          parentWorkstreamId: "parent-1",
          packetId: "T1",
          waveIndex: 0,
          parentIntegrationBranch: "integration-branch"
        },
        path: "/path",
        planDocumentPath: "/plan",
        logDocumentPath: "/log",
        status: "implementing",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const mergedPr: NormalizedPullRequest = {
        id: "pr-1",
        kind: "pull_request",
        repoId: "repo-1",
        repoKey: "owner/repo",
        repoOwner: "owner",
        repoName: "repo",
        repoSlug: "owner/repo",
        number: 101,
        key: "owner/repo#101",
        sourceId: "pr:101",
        url: "url",
        title: "PR 101",
        body: "body",
        labels: [],
        author: "author",
        state: "merged",
        headBranch: "branch-1",
        headSha: "sha",
        baseBranch: "integration-branch",
        defaultBranch: "main",
        baseClassification: "non_default_parent",
        isDraft: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z"
      };

      const updated = markMergedPacketPullRequests({
        packetPlan: plan,
        parentWorkstreamId: "parent-1",
        repoId: "repo-1",
        packetWorktrees: [packetWorktree],
        pullRequests: [mergedPr]
      });

      assert.strictEqual(updated.packets["T1"]?.status, "merged_to_parent");
      assert.strictEqual(updated.packets["T2"]?.status, "planned");
      assert.strictEqual(updated.currentWaveIndex, 0);
      assert.deepStrictEqual(updated.waves, plan.waves);
    });
  });

  describe("buildPacketWaveAdvancePreview", () => {
    const baseAdvancePacketPlan = (): WorkstreamPacketPlan => ({
      status: "approved",
      packets: {
        T1: { id: "T1", title: "T1", summary: "S1", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "merged_to_parent" },
        T2: { id: "T2", title: "T2", summary: "S2", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "merged_to_parent" },
        T3: { id: "T3", title: "T3", summary: "S3", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" },
        T4: { id: "T4", title: "T4", summary: "S4", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" },
        T5: { id: "T5", title: "T5", summary: "S5", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" }
      },
      waves: [["T1", "T2"], ["T3", "T4"], ["T5"]],
      currentWaveIndex: 0
    });

    it("returns canAdvance true for completed current wave with a next wave", () => {
      const packetPlan = baseAdvancePacketPlan();
      const result = buildPacketWaveAdvancePreview({ packetPlan });

      assert.strictEqual(result.canAdvance, true);
      assert.strictEqual(result.blockedReason, undefined);
      assert.strictEqual(result.currentWaveIndex, 0);
      assert.strictEqual(result.nextWaveIndex, 1);
      assert.deepStrictEqual(result.currentWavePacketIds, ["T1", "T2"]);
      assert.deepStrictEqual(result.completedCurrentWavePacketIds, ["T1", "T2"]);
      assert.deepStrictEqual(result.incompleteCurrentWavePacketIds, []);
      assert.deepStrictEqual(result.nextWavePacketIds, ["T3", "T4"]);
      assert.deepStrictEqual(result.remainingFuturePacketIds, ["T5"]);
    });

    it("preserves packet order in all returned arrays", () => {
      const packetPlan = baseAdvancePacketPlan();
      packetPlan.waves = [["T2", "T1"], ["T4", "T3"], ["T5", "T6"]];
      packetPlan.packets["T6"] = { ...packetPlan.packets["T5"]!, id: "T6" };
      const result = buildPacketWaveAdvancePreview({ packetPlan });

      assert.deepStrictEqual(result.currentWavePacketIds, ["T2", "T1"]);
      assert.deepStrictEqual(result.completedCurrentWavePacketIds, ["T2", "T1"]);
      assert.deepStrictEqual(result.nextWavePacketIds, ["T4", "T3"]);
      assert.deepStrictEqual(result.remainingFuturePacketIds, ["T5", "T6"]);
    });

    it("returns current_wave_incomplete with incomplete packet IDs", () => {
      const packetPlan = baseAdvancePacketPlan();
      packetPlan.packets["T2"]!.status = "planned";
      const result = buildPacketWaveAdvancePreview({ packetPlan });

      assert.strictEqual(result.canAdvance, false);
      assert.strictEqual(result.blockedReason, "current_wave_incomplete");
      assert.deepStrictEqual(result.completedCurrentWavePacketIds, ["T1"]);
      assert.deepStrictEqual(result.incompleteCurrentWavePacketIds, ["T2"]);
      assert.deepStrictEqual(result.nextWavePacketIds, ["T3", "T4"]);
    });

    it("returns no_future_wave when current wave is complete and final", () => {
      const packetPlan = baseAdvancePacketPlan();
      packetPlan.currentWaveIndex = 2;
      packetPlan.packets["T5"]!.status = "merged_to_parent";
      const result = buildPacketWaveAdvancePreview({ packetPlan });

      assert.strictEqual(result.canAdvance, false);
      assert.strictEqual(result.blockedReason, "no_future_wave");
      assert.deepStrictEqual(result.currentWavePacketIds, ["T5"]);
      assert.deepStrictEqual(result.completedCurrentWavePacketIds, ["T5"]);
      assert.deepStrictEqual(result.nextWavePacketIds, []);
      assert.deepStrictEqual(result.remainingFuturePacketIds, []);
    });

    it("returns invalid_current_wave_index for out-of-range current wave index", () => {
      const packetPlan = baseAdvancePacketPlan();
      packetPlan.currentWaveIndex = 99;
      const result = buildPacketWaveAdvancePreview({ packetPlan });

      assert.strictEqual(result.canAdvance, false);
      assert.strictEqual(result.blockedReason, "invalid_current_wave_index");
      assert.deepStrictEqual(result.currentWavePacketIds, []);
    });

    it("defaults missing currentWaveIndex to 0", () => {
      const packetPlan = baseAdvancePacketPlan();
      delete packetPlan.currentWaveIndex;
      const result = buildPacketWaveAdvancePreview({ packetPlan });

      assert.strictEqual(result.canAdvance, true);
      assert.strictEqual(result.currentWaveIndex, 0);
      assert.strictEqual(result.nextWaveIndex, 1);
    });

    it("does not mutate the input packet plan", () => {
      const packetPlan = baseAdvancePacketPlan();
      const before = structuredClone(packetPlan);
      const result = buildPacketWaveAdvancePreview({ packetPlan });

      assert.deepStrictEqual(packetPlan, before);
      assert.notStrictEqual(result.currentWavePacketIds, packetPlan.waves[0]);
      assert.notStrictEqual(result.nextWavePacketIds, packetPlan.waves[1]);
    });

    it("reuses existing completion semantics for packet statuses", () => {
      const packetPlan = baseAdvancePacketPlan();
      packetPlan.packets["T1"]!.status = "approved";
      const result = buildPacketWaveAdvancePreview({ packetPlan });

      assert.strictEqual(result.canAdvance, false);
      assert.strictEqual(result.blockedReason, "current_wave_incomplete");

      packetPlan.packets["T1"]!.status = "merged_to_parent";
      const result2 = buildPacketWaveAdvancePreview({ packetPlan });
      assert.strictEqual(result2.canAdvance, true);
    });

    it("returns no_packet_plan when packetPlan is missing", () => {
      const result = buildPacketWaveAdvancePreview({ packetPlan: undefined });
      assert.strictEqual(result.canAdvance, false);
      assert.strictEqual(result.blockedReason, "no_packet_plan");
    });

    it("treats empty current wave as invalid_current_wave_index", () => {
      const packetPlan = baseAdvancePacketPlan();
      packetPlan.waves[0] = [];
      const result = buildPacketWaveAdvancePreview({ packetPlan });
      assert.strictEqual(result.canAdvance, false);
      assert.strictEqual(result.blockedReason, "invalid_current_wave_index");
    });
  });

  describe("advancePacketPlanToNextWave", () => {
    const baseAdvancePacketPlan = (): WorkstreamPacketPlan => ({
      status: "approved",
      packets: {
        T1: { id: "T1", title: "T1", summary: "S1", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "merged_to_parent" },
        T2: { id: "T2", title: "T2", summary: "S2", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "merged_to_parent" },
        T3: { id: "T3", title: "T3", summary: "S3", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" },
        T4: { id: "T4", title: "T4", summary: "S4", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" },
        T5: { id: "T5", title: "T5", summary: "S5", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" }
      },
      waves: [["T1", "T2"], ["T3", "T4"], ["T5"]],
      currentWaveIndex: 0
    });

    it("1. Missing packet plan returns blocked result", () => {
      const result = advancePacketPlanToNextWave({ packetPlan: undefined });
      assert.strictEqual(result.advanced, false);
      assert.strictEqual(result.preview.canAdvance, false);
      assert.strictEqual(result.preview.blockedReason, "no_packet_plan");
      assert.strictEqual(result.packetPlan, undefined);
    });

    it("2. Invalid current wave index does not advance", () => {
      const originalPacketPlan = baseAdvancePacketPlan();
      originalPacketPlan.currentWaveIndex = 99;
      const before = structuredClone(originalPacketPlan);

      const result = advancePacketPlanToNextWave({ packetPlan: originalPacketPlan });

      assert.strictEqual(result.advanced, false);
      assert.strictEqual(result.preview.blockedReason, "invalid_current_wave_index");
      assert.strictEqual(result.packetPlan, originalPacketPlan);
      assert.strictEqual(originalPacketPlan.currentWaveIndex, 99);
      assert.deepStrictEqual(originalPacketPlan, before);
    });

    it("3. Incomplete current wave does not advance", () => {
      const originalPacketPlan = baseAdvancePacketPlan();
      originalPacketPlan.packets["T2"]!.status = "planned";
      const before = structuredClone(originalPacketPlan);

      const result = advancePacketPlanToNextWave({ packetPlan: originalPacketPlan });

      assert.strictEqual(result.advanced, false);
      assert.strictEqual(result.preview.blockedReason, "current_wave_incomplete");
      assert.deepStrictEqual(result.preview.incompleteCurrentWavePacketIds, ["T2"]);
      assert.strictEqual(result.packetPlan, originalPacketPlan);
      assert.strictEqual(originalPacketPlan.currentWaveIndex, 0);
      assert.deepStrictEqual(originalPacketPlan, before);
    });

    it("4. Final wave does not advance", () => {
      const originalPacketPlan = baseAdvancePacketPlan();
      originalPacketPlan.currentWaveIndex = 2;
      originalPacketPlan.packets["T5"]!.status = "merged_to_parent";
      const before = structuredClone(originalPacketPlan);

      const result = advancePacketPlanToNextWave({ packetPlan: originalPacketPlan });

      assert.strictEqual(result.advanced, false);
      assert.strictEqual(result.preview.blockedReason, "no_future_wave");
      assert.strictEqual(result.packetPlan, originalPacketPlan);
      assert.strictEqual(originalPacketPlan.currentWaveIndex, 2);
      assert.deepStrictEqual(originalPacketPlan, before);
    });

    it("5. Advances completed current wave to next wave", () => {
      const originalPacketPlan = baseAdvancePacketPlan();
      const result = advancePacketPlanToNextWave({ packetPlan: originalPacketPlan });

      assert.strictEqual(result.advanced, true);
      assert.strictEqual(result.preview.canAdvance, true);
      assert.strictEqual(result.preview.currentWaveIndex, 0);
      assert.strictEqual(result.preview.nextWaveIndex, 1);
      assert.ok(result.packetPlan);
      assert.strictEqual(result.packetPlan.currentWaveIndex, 1);
      assert.notStrictEqual(result.packetPlan, originalPacketPlan);
      assert.strictEqual(result.packetPlan.status, originalPacketPlan.status);
      assert.strictEqual(result.packetPlan.packets, originalPacketPlan.packets);
      assert.strictEqual(result.packetPlan.waves, originalPacketPlan.waves);
      assert.strictEqual(originalPacketPlan.currentWaveIndex, 0);
    });

    it("6. Defaults missing currentWaveIndex to 0 and advances to 1", () => {
      const originalPacketPlan = baseAdvancePacketPlan();
      delete originalPacketPlan.currentWaveIndex;

      const result = advancePacketPlanToNextWave({ packetPlan: originalPacketPlan });

      assert.strictEqual(result.advanced, true);
      assert.strictEqual(result.preview.currentWaveIndex, 0);
      assert.strictEqual(result.preview.nextWaveIndex, 1);
      assert.ok(result.packetPlan);
      assert.strictEqual(result.packetPlan.currentWaveIndex, 1);
    });

    it("7. Advances from middle wave to next wave", () => {
      const originalPacketPlan = baseAdvancePacketPlan();
      originalPacketPlan.currentWaveIndex = 1;
      originalPacketPlan.packets["T3"]!.status = "merged_to_parent";
      originalPacketPlan.packets["T4"]!.status = "merged_to_parent";

      const result = advancePacketPlanToNextWave({ packetPlan: originalPacketPlan });

      assert.strictEqual(result.advanced, true);
      assert.strictEqual(result.preview.currentWaveIndex, 1);
      assert.strictEqual(result.preview.nextWaveIndex, 2);
      assert.ok(result.packetPlan);
      assert.strictEqual(result.packetPlan.currentWaveIndex, 2);
      assert.deepStrictEqual(result.preview.nextWavePacketIds, ["T5"]);
      assert.deepStrictEqual(result.preview.remainingFuturePacketIds, []);
    });

    it("8. Does not mutate input on successful advance", () => {
      const originalPacketPlan = baseAdvancePacketPlan();
      const before = structuredClone(originalPacketPlan);

      const result = advancePacketPlanToNextWave({ packetPlan: originalPacketPlan });

      assert.strictEqual(result.advanced, true);
      assert.deepStrictEqual(originalPacketPlan, before);
      assert.notStrictEqual(result.packetPlan, originalPacketPlan);
    });

    it("9. Does not mutate input on blocked advance", () => {
      const originalPacketPlan = baseAdvancePacketPlan();
      originalPacketPlan.packets["T2"]!.status = "planned";
      const before = structuredClone(originalPacketPlan);

      const result = advancePacketPlanToNextWave({ packetPlan: originalPacketPlan });

      assert.strictEqual(result.advanced, false);
      assert.deepStrictEqual(originalPacketPlan, before);
      assert.strictEqual(result.packetPlan, originalPacketPlan);
    });

    it("10. Preserves packet statuses exactly", () => {
      const originalPacketPlan = baseAdvancePacketPlan();
      originalPacketPlan.packets["T3"]!.status = "planned";
      originalPacketPlan.packets["T4"]!.status = "pr_open";

      const result = advancePacketPlanToNextWave({ packetPlan: originalPacketPlan });

      assert.strictEqual(result.advanced, true);
      assert.ok(result.packetPlan);
      assert.strictEqual(result.packetPlan.packets["T3"]?.status, "planned");
      assert.strictEqual(result.packetPlan.packets["T4"]?.status, "pr_open");
    });
  });

  describe("advanceWorkstreamPacketPlanToNextWave", () => {
    function basePacketPlan(overrides?: Partial<WorkstreamPacketPlan>): WorkstreamPacketPlan {
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
            status: "planned"
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
          },
          T3: {
            id: "T3",
            title: "T3",
            summary: "S3",
            acceptanceCriteria: [],
            filesLikelyTouched: [],
            dependsOn: [],
            canRunInParallelWith: [],
            blocks: [],
            status: "planned"
          }
        },
        waves: [["T1", "T2"], ["T3"]],
        currentWaveIndex: 0,
        ...overrides
      };
    }

    function baseWorkstream(overrides?: Partial<WorkstreamRecord>): WorkstreamRecord {
      return {
        id: "owner/repo:issue:128",
        repoKey: "owner/repo",
        origin: { type: "issue", number: 128 },
        linkedIssueNumber: 128,
        linkedPrs: [{ number: 77, status: "open", role: "implementation" }],
        activePrNumber: 77,
        activeWorktreeId: "wt-128",
        phase: "implementation_ready",
        attention: "review_requested",
        status: "open",
        resolution: "unresolved",
        integration: { branchName: "agent/owner-repo/issue-128", prNumber: 77 },
        packetPlan: basePacketPlan(),
        ...overrides
      };
    }

    it("1. Workstream without packet plan does not advance", () => {
      const workstream = baseWorkstream();
      delete workstream.packetPlan;
      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, false);
      assert.strictEqual(result.packetPlanResult.advanced, false);
      assert.strictEqual(result.packetPlanResult.preview.blockedReason, "no_packet_plan");
      assert.strictEqual(result.workstream, workstream);
    });

    it("2. Workstream with incomplete current wave does not advance", () => {
      const workstream = baseWorkstream();
      workstream.packetPlan!.packets["T1"]!.status = "merged_to_parent";
      workstream.packetPlan!.packets["T2"]!.status = "planned";
      const before = structuredClone(workstream);

      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, false);
      assert.strictEqual(result.packetPlanResult.preview.blockedReason, "current_wave_incomplete");
      assert.strictEqual(result.workstream, workstream);
      assert.strictEqual(result.workstream.packetPlan, workstream.packetPlan);
      assert.deepStrictEqual(workstream, before);
    });

    it("3. Workstream at final wave does not advance", () => {
      const workstream = baseWorkstream();
      workstream.packetPlan!.currentWaveIndex = 1;
      workstream.packetPlan!.packets["T3"]!.status = "merged_to_parent";
      const before = structuredClone(workstream);

      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, false);
      assert.strictEqual(result.packetPlanResult.preview.blockedReason, "no_future_wave");
      assert.strictEqual(result.workstream, workstream);
      assert.deepStrictEqual(workstream, before);
    });

    it("4. Workstream advances when packet plan can advance", () => {
      const workstream = baseWorkstream();
      workstream.packetPlan!.packets["T1"]!.status = "merged_to_parent";
      workstream.packetPlan!.packets["T2"]!.status = "merged_to_parent";
      const originalPacketPlan = workstream.packetPlan;

      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, true);
      assert.strictEqual(result.packetPlanResult.advanced, true);
      assert.notStrictEqual(result.workstream, workstream);
      assert.notStrictEqual(result.workstream.packetPlan, originalPacketPlan);
      assert.strictEqual(result.workstream.packetPlan?.currentWaveIndex, 1);
      assert.strictEqual(originalPacketPlan?.currentWaveIndex, 0);
    });

    it("5. Workstream preserves all non-packet-plan fields", () => {
      const workstream = baseWorkstream();
      workstream.packetPlan!.packets["T1"]!.status = "merged_to_parent";
      workstream.packetPlan!.packets["T2"]!.status = "merged_to_parent";

      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, true);
      assert.strictEqual(result.workstream.id, workstream.id);
      assert.strictEqual(result.workstream.repoKey, workstream.repoKey);
      assert.strictEqual(result.workstream.origin, workstream.origin);
      assert.strictEqual(result.workstream.linkedPrs, workstream.linkedPrs);
      assert.strictEqual(result.workstream.activePrNumber, workstream.activePrNumber);
      assert.strictEqual(result.workstream.activeWorktreeId, workstream.activeWorktreeId);
      assert.strictEqual(result.workstream.phase, workstream.phase);
      assert.strictEqual(result.workstream.attention, workstream.attention);
      assert.strictEqual(result.workstream.status, workstream.status);
      assert.strictEqual(result.workstream.resolution, workstream.resolution);
      assert.strictEqual(result.workstream.integration, workstream.integration);
    });

    it("6. Does not clear or mutate attention", () => {
      const workstream = baseWorkstream({ attention: "review_requested" });
      workstream.packetPlan!.packets["T1"]!.status = "merged_to_parent";
      workstream.packetPlan!.packets["T2"]!.status = "merged_to_parent";

      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, true);
      assert.strictEqual(result.workstream.attention, "review_requested");
      assert.strictEqual(result.workstream.attention, workstream.attention);
    });

    it("7. Does not mutate input workstream on successful advance", () => {
      const workstream = baseWorkstream();
      workstream.packetPlan!.packets["T1"]!.status = "merged_to_parent";
      workstream.packetPlan!.packets["T2"]!.status = "merged_to_parent";
      const before = structuredClone(workstream);

      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, true);
      assert.deepStrictEqual(workstream, before);
      assert.notStrictEqual(result.workstream, workstream);
    });

    it("8. Does not mutate input workstream on blocked advance", () => {
      const workstream = baseWorkstream();
      workstream.packetPlan!.packets["T1"]!.status = "planned"; // Incomplete wave
      const before = structuredClone(workstream);

      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, false);
      assert.deepStrictEqual(workstream, before);
      assert.strictEqual(result.workstream, workstream);
    });

    it("9. Preserves nested packet-plan references from packet-plan transition", () => {
      const workstream = baseWorkstream();
      workstream.packetPlan!.packets["T1"]!.status = "merged_to_parent";
      workstream.packetPlan!.packets["T2"]!.status = "merged_to_parent";

      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, true);
      assert.strictEqual(result.workstream.packetPlan?.packets, workstream.packetPlan?.packets);
      assert.strictEqual(result.workstream.packetPlan?.waves, workstream.packetPlan?.waves);
    });

    it("10. Exposes packet-plan preview details to callers", () => {
      const workstream = baseWorkstream();
      workstream.packetPlan!.packets["T1"]!.status = "merged_to_parent";
      workstream.packetPlan!.packets["T2"]!.status = "merged_to_parent";

      const result = advanceWorkstreamPacketPlanToNextWave(workstream);

      assert.strictEqual(result.advanced, true);
      assert.strictEqual(result.packetPlanResult.preview.currentWaveIndex, 0);
      assert.strictEqual(result.packetPlanResult.preview.nextWaveIndex, 1);
      assert.deepStrictEqual(result.packetPlanResult.preview.nextWavePacketIds, ["T3"]);
    });
  });

  describe("applyPlanBreakdownResultsToWorkstreams", () => {
    const baseTask: TaskRecord = {
      id: "task-1",
      kind: "plan_breakdown",
      status: "completed",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      repoId: "repo-1",
      repoName: "repo",
      repoSlug: "owner/repo",
      sourceKind: "pull_request",
      sourceId: "issue:owner/repo:123",
      sourceUrl: "https://github.com/owner/repo/issues/123",
      workstreamId: "owner/repo:issue:123",
      relevant: true,
      reason: "needed",
      summary: "Plan Breakdown",
      context: {
        repoIdentifier: "owner/repo",
        labels: [],
        instruction: "Break down the plan"
      },
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z"
    };

    const baseExecution: ExecutionRecord = {
      id: "exec-1",
      taskId: "task-1",
      taskKind: "plan_breakdown",
      taskStatus: "completed",
      repoId: "repo-1",
      repoSlug: "owner/repo",
      agentId: "agent-1",
      agentProvider: "codex",
      command: {
        executable: "echo",
        args: [],
        cwd: ".",
        timeoutMs: 1000
      },
      promptArtifactPath: "",
      stdoutArtifactPath: "",
      stderrArtifactPath: "",
      promptPacketPath: "",
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:00:05Z",
      exitCode: 0,
      result: {
        planBreakdown: validPlanBreakdown
      }
    };

    const baseWorkstream: WorkstreamRecord = {
      id: "owner/repo:issue:123",
      repoKey: "owner/repo",
      origin: { type: "issue", number: 123 },
      linkedIssueNumber: 123,
      linkedPrs: [],
      phase: "planning",
      attention: "idle",
      status: "open",
      resolution: "unresolved"
    };

    it("applies plan breakdown to issue workstream", () => {
      const workstreams = [baseWorkstream];
      const tasks = [baseTask];
      const executions = [baseExecution];

      const result = applyPlanBreakdownResultsToWorkstreams({ workstreams, tasks, executions });

      assert.strictEqual(result.length, 1);
      assert.ok(result[0]!.packetPlan);
      assert.strictEqual(result[0]!.packetPlan.source?.workstreamId, "owner/repo:issue:123");
    });

    it("applies plan breakdown to PR workstream when no issue is linked", () => {
      const prTask: TaskRecord = {
        ...baseTask,
        id: "task-pr",
        sourceId: "pull_request:owner/repo:456",
        workstreamId: "owner/repo:pr:456"
      };
      const prExecution: ExecutionRecord = {
        ...baseExecution,
        id: "exec-pr",
        taskId: "task-pr"
      };
      const prWorkstream: WorkstreamRecord = {
        id: "owner/repo:pr:456",
        repoKey: "owner/repo",
        origin: { type: "pr", number: 456 },
        linkedPrs: [{ number: 456 }],
        activePrNumber: 456,
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved"
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [prWorkstream],
        tasks: [prTask],
        executions: [prExecution]
      });

      assert.strictEqual(result.length, 1);
      assert.ok(result[0]!.packetPlan);
      assert.strictEqual(result[0]!.packetPlan.source?.workstreamId, "owner/repo:pr:456");
    });

    it("applies plan breakdown to linked issue workstream when task source is PR", () => {
      const prTask: TaskRecord = {
        ...baseTask,
        id: "task-pr",
        sourceId: "pull_request:owner/repo:456",
        workstreamId: "owner/repo:issue:123"
      };
      const prExecution: ExecutionRecord = {
        ...baseExecution,
        id: "exec-pr",
        taskId: "task-pr"
      };

      // This workstream is an issue workstream that has PR 456 linked
      const issueWorkstream: WorkstreamRecord = {
        id: "owner/repo:issue:123",
        repoKey: "owner/repo",
        origin: { type: "issue", number: 123 },
        linkedIssueNumber: 123,
        linkedPrs: [{ number: 456 }],
        activePrNumber: 456,
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved"
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [issueWorkstream],
        tasks: [prTask],
        executions: [prExecution]
      });

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.id, "owner/repo:issue:123");
      assert.ok(result[0]!.packetPlan);
      assert.strictEqual(result[0]!.packetPlan?.source?.workstreamId, "owner/repo:issue:123");
    });

    it("ignores plan breakdown when workstreamId is missing on task", () => {
      const taskNoWsId: TaskRecord = {
        ...baseTask,
        workstreamId: undefined
      };
      const execution: ExecutionRecord = {
        ...baseExecution,
        taskId: taskNoWsId.id
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [baseWorkstream],
        tasks: [taskNoWsId],
        executions: [execution]
      });

      assert.strictEqual(result[0]!.packetPlan, undefined);
    });

    it("ignores plan breakdown when workstreamId on task does not match any workstream", () => {
      const taskWrongWsId: TaskRecord = {
        ...baseTask,
        workstreamId: "nonexistent:ws"
      };
      const execution: ExecutionRecord = {
        ...baseExecution,
        taskId: taskWrongWsId.id
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [baseWorkstream],
        tasks: [taskWrongWsId],
        executions: [execution]
      });

      assert.strictEqual(result[0]!.packetPlan, undefined);
    });

    it("applies plan breakdown even if sourceId is malformed if workstreamId is correct", () => {
      const weirdTask: TaskRecord = {
        ...baseTask,
        sourceId: "MALFORMED_SOURCE_ID"
      };
      const execution: ExecutionRecord = {
        ...baseExecution,
        taskId: weirdTask.id
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [baseWorkstream],
        tasks: [weirdTask],
        executions: [execution]
      });

      assert.ok(result[0]!.packetPlan);
      assert.strictEqual(result[0]!.packetPlan.source?.workstreamId, "owner/repo:issue:123");
    });

    it("preserves existing packetPlan when generatedAt is missing", () => {
      const existingPlan: WorkstreamPacketPlan = {
        status: "proposed",
        packets: {},
        waves: [],
        source: {
          kind: "plan_breakdown_result",
          workstreamId: baseWorkstream.id
          // generatedAt is missing
        }
      };
      const workstream: WorkstreamRecord = {
        ...baseWorkstream,
        packetPlan: existingPlan
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [workstream],
        tasks: [baseTask],
        executions: [baseExecution]
      });

      assert.strictEqual(result[0]!.packetPlan, existingPlan);
    });

    it("overwrites existing packetPlan if new execution is strictly newer", () => {
      const existingPlan: WorkstreamPacketPlan = {
        status: "proposed",
        packets: {},
        waves: [],
        source: {
          kind: "plan_breakdown_result",
          workstreamId: baseWorkstream.id,
          generatedAt: "2024-01-01T00:00:00Z"
        }
      };
      const workstream: WorkstreamRecord = {
        ...baseWorkstream,
        packetPlan: existingPlan
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [workstream],
        tasks: [baseTask],
        executions: [baseExecution] // endedAt is 2024-01-01T00:00:05Z
      });

      assert.notStrictEqual(result[0]!.packetPlan, existingPlan);
      assert.strictEqual(result[0]!.packetPlan?.source?.generatedAt, baseExecution.endedAt);
    });

    it("preserves existing packetPlan if new execution is older", () => {
      const existingPlan: WorkstreamPacketPlan = {
        status: "proposed",
        packets: {},
        waves: [],
        source: {
          kind: "plan_breakdown_result",
          workstreamId: baseWorkstream.id,
          generatedAt: "2024-01-01T00:00:10Z"
        }
      };
      const workstream: WorkstreamRecord = {
        ...baseWorkstream,
        packetPlan: existingPlan
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [workstream],
        tasks: [baseTask],
        executions: [baseExecution] // endedAt is 2024-01-01T00:00:05Z
      });

      assert.strictEqual(result[0]!.packetPlan, existingPlan);
    });

    it("ignores failed breakdown", () => {
      const failedExecution: ExecutionRecord = {
        ...baseExecution,
        id: "exec-failed",
        taskStatus: "failed"
      };
      delete (failedExecution as any).result;
      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [baseWorkstream],
        tasks: [baseTask],
        executions: [failedExecution]
      });
      assert.strictEqual(result[0]!.packetPlan, undefined);
    });

    it("ignores completed missing-result breakdown", () => {
      const missingResultExecution: ExecutionRecord = {
        ...baseExecution,
        id: "exec-missing",
        result: {} // No planBreakdown
      };
      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [baseWorkstream],
        tasks: [baseTask],
        executions: [missingResultExecution]
      });
      assert.strictEqual(result[0]!.packetPlan, undefined);
    });

    it("ignores invalid exported breakdown and preserves existing valid packet plan", () => {
      const existingPlan: WorkstreamPacketPlan = {
        status: "proposed",
        packets: {},
        waves: [],
        source: {
          kind: "plan_breakdown_result",
          workstreamId: baseWorkstream.id,
          generatedAt: "2024-01-01T00:00:00Z"
        }
      };
      const workstream: WorkstreamRecord = {
        ...baseWorkstream,
        packetPlan: existingPlan
      };

      const invalidBreakdown: PlanBreakdownResult = {
        ...validPlanBreakdown,
        tasks: [] // Invalid because waves reference tasks
      };

      const invalidExecution: ExecutionRecord = {
        ...baseExecution,
        id: "exec-invalid",
        endedAt: "2024-01-01T00:00:10Z",
        result: {
          planBreakdown: invalidBreakdown
        }
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [workstream],
        tasks: [baseTask],
        executions: [invalidExecution]
      });

      assert.strictEqual(result[0]!.packetPlan, existingPlan);
    });

    it("selects latest valid execution per workstream", () => {
      const exec1: ExecutionRecord = {
        ...baseExecution,
        id: "exec-1",
        endedAt: "2024-01-01T00:00:01Z",
        result: {
          planBreakdown: { ...validPlanBreakdown, title: "Plan 1" }
        }
      };
      const exec2: ExecutionRecord = {
        ...baseExecution,
        id: "exec-2",
        endedAt: "2024-01-01T00:00:02Z",
        result: {
          planBreakdown: { ...validPlanBreakdown, title: "Plan 2" }
        }
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [baseWorkstream],
        tasks: [baseTask],
        executions: [exec1, exec2]
      });

      assert.strictEqual(result[0]!.packetPlan?.source?.generatedAt, "2024-01-01T00:00:02Z");
    });

    it("applies completed wave_plan_replanning results as a packet plan replacement", () => {
      const existingPlan: WorkstreamPacketPlan = {
        status: "approved",
        packets: {
          OLD: {
            id: "OLD",
            title: "Old packet",
            summary: "Old packet",
            acceptanceCriteria: [],
            filesLikelyTouched: [],
            dependsOn: [],
            canRunInParallelWith: [],
            blocks: [],
            status: "planned"
          }
        },
        waves: [["OLD"]],
        currentWaveIndex: 0,
        source: {
          kind: "plan_breakdown_result",
          workstreamId: baseWorkstream.id,
          generatedAt: "2024-01-01T00:00:00Z"
        },
        waveAssessments: [
          {
            id: "assessment-replan",
            sessionId: "assessment-replan",
            checkpoint: {
              id: "checkpoint-1",
              sessionId: "checkpoint-1",
              identity: {
                repoKey: "owner/repo",
                workstreamId: baseWorkstream.id,
                waveId: "wave-0",
                parentPrNumber: 123,
                parentHeadSha: "abc",
                parentIntegrationBranch: "agent/owner-repo/issue-123",
                defaultBranch: "main",
                planRevision: "2024-01-01T00:00:00Z",
                originalPlanningSessionId: "planner-session-1",
                currentWaveIndex: 0,
                nextWaveIndex: 1,
                completedPacketIds: ["OLD"],
                pendingFuturePacketIds: [],
                planNodeIds: ["OLD"]
              }
            },
            decision: "replan",
            summary: "Replan required.",
            findings: [],
            status: "finalized",
            finalizedAt: "2024-01-01T00:00:03Z"
          }
        ]
      };
      const workstream: WorkstreamRecord = {
        ...baseWorkstream,
        packetPlan: existingPlan
      };
      const replanningTask: TaskRecord = {
        ...baseTask,
        id: "task-replan",
        kind: "wave_plan_replanning"
      };
      const replanningExecution: ExecutionRecord = {
        ...baseExecution,
        id: "exec-replan",
        taskId: replanningTask.id,
        taskKind: "wave_plan_replanning",
        endedAt: "2024-01-01T00:00:05Z"
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [workstream],
        tasks: [replanningTask],
        executions: [replanningExecution]
      });

      assert.equal(result[0]!.packetPlan?.status, "approved");
      assert.equal(result[0]!.packetPlan?.source?.generatedAt, replanningExecution.endedAt);
      assert.ok(result[0]!.packetPlan?.packets.T1);
      assert.equal(result[0]!.packetPlan?.packets.OLD, undefined);
      assert.deepEqual(result[0]!.packetPlan?.waveAssessments, existingPlan.waveAssessments);
    });

    it("does not apply wave_plan_replanning results when the final task status is failed", () => {
      const existingPlan: WorkstreamPacketPlan = {
        status: "approved",
        packets: {
          OLD: {
            id: "OLD",
            title: "Old packet",
            summary: "Old packet",
            acceptanceCriteria: [],
            filesLikelyTouched: [],
            dependsOn: [],
            canRunInParallelWith: [],
            blocks: [],
            status: "planned"
          }
        },
        waves: [["OLD"]],
        currentWaveIndex: 0,
        source: {
          kind: "plan_breakdown_result",
          workstreamId: baseWorkstream.id,
          generatedAt: "2024-01-01T00:00:00Z"
        }
      };
      const workstream: WorkstreamRecord = {
        ...baseWorkstream,
        packetPlan: existingPlan
      };
      const failedReplanningTask: TaskRecord = {
        ...baseTask,
        id: "task-replan",
        kind: "wave_plan_replanning",
        status: "failed"
      };
      const completedAgentExecution: ExecutionRecord = {
        ...baseExecution,
        id: "exec-replan",
        taskId: failedReplanningTask.id,
        taskKind: "wave_plan_replanning",
        taskStatus: "completed",
        endedAt: "2024-01-01T00:00:05Z"
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [workstream],
        tasks: [failedReplanningTask],
        executions: [completedAgentExecution]
      });

      assert.strictEqual(result[0]!.packetPlan, existingPlan);
    });

    it("does not let an older wave_plan_replanning result overwrite a newer packet plan", () => {
      const existingPlan: WorkstreamPacketPlan = {
        status: "in_progress",
        packets: {
          NEWER: {
            id: "NEWER",
            title: "Newer packet",
            summary: "Newer packet",
            acceptanceCriteria: [],
            filesLikelyTouched: [],
            dependsOn: [],
            canRunInParallelWith: [],
            blocks: [],
            status: "planned"
          }
        },
        waves: [["NEWER"]],
        currentWaveIndex: 0,
        source: {
          kind: "plan_breakdown_result",
          workstreamId: baseWorkstream.id,
          generatedAt: "2024-01-01T00:00:10Z"
        }
      };
      const workstream: WorkstreamRecord = {
        ...baseWorkstream,
        packetPlan: existingPlan
      };
      const replanningTask: TaskRecord = {
        ...baseTask,
        id: "task-replan",
        kind: "wave_plan_replanning"
      };
      const replanningExecution: ExecutionRecord = {
        ...baseExecution,
        id: "exec-replan",
        taskId: replanningTask.id,
        taskKind: "wave_plan_replanning",
        endedAt: "2024-01-01T00:00:05Z"
      };

      const result = applyPlanBreakdownResultsToWorkstreams({
        workstreams: [workstream],
        tasks: [replanningTask],
        executions: [replanningExecution]
      });

      assert.strictEqual(result[0]!.packetPlan, existingPlan);
    });
  });

  describe("advanceReadyWorkstreamPacketWaves", () => {
    function basePacketPlan(overrides?: Partial<WorkstreamPacketPlan>): WorkstreamPacketPlan {
      return {
        status: "approved",
        packets: {
          T1: { id: "T1", title: "T1", summary: "S1", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" },
          T2: { id: "T2", title: "T2", summary: "S2", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" },
          T3: { id: "T3", title: "T3", summary: "S3", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" },
          T4: { id: "T4", title: "T4", summary: "S4", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" }
        },
        waves: [["T1", "T2"], ["T3", "T4"]],
        currentWaveIndex: 0,
        ...overrides
      };
    }

    function baseWorkstream(id: string, overrides?: Partial<WorkstreamRecord>): WorkstreamRecord {
      return {
        id,
        repoKey: "owner/repo",
        origin: { type: "issue", number: parseInt(id.split(":").pop() || "0") },
        linkedPrs: [],
        phase: "implementation_ready",
        attention: "idle",
        status: "open",
        resolution: "unresolved",
        packetPlan: basePacketPlan(),
        ...overrides
      };
    }

    function markCurrentWaveMerged(packetPlan: WorkstreamPacketPlan): WorkstreamPacketPlan {
      const waveIndex = packetPlan.currentWaveIndex ?? 0;
      const wave = packetPlan.waves[waveIndex] ?? [];
      const packets = { ...packetPlan.packets };
      for (const id of wave) {
        packets[id] = { ...packets[id]!, status: "merged_to_parent" };
      }
      return { ...packetPlan, packets };
    }

    it("1. Advances only explicitly ready workstreams", () => {
      const w1 = baseWorkstream("W1");
      w1.packetPlan = markCurrentWaveMerged(w1.packetPlan!);

      const w2 = baseWorkstream("W2");
      w2.packetPlan = markCurrentWaveMerged(w2.packetPlan!); // could advance but not ready

      const w3 = baseWorkstream("W3"); // not ready and cannot advance

      const workstreams = { W1: w1, W2: w2, W3: w3 };
      const readyWorkstreamIds = ["W1"];

      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds });

      assert.strictEqual(result.advanced.length, 1);
      assert.strictEqual(result.advanced[0]?.workstreamId, "W1");
      assert.strictEqual(result.skipped.length, 2);
      assert.ok(result.skipped.some(s => s.workstreamId === "W2"));
      assert.ok(result.skipped.some(s => s.workstreamId === "W3"));
      assert.strictEqual(result.blocked.length, 0);

      assert.notStrictEqual(result.workstreams["W1"], w1);
      assert.strictEqual(result.workstreams["W1"]?.packetPlan?.currentWaveIndex, 1);
      assert.strictEqual(result.workstreams["W2"], w2);
      assert.strictEqual(result.workstreams["W3"], w3);
    });

    it("2. Ready but blocked workstream is reported as blocked", () => {
      const w1 = baseWorkstream("W1"); // incomplete wave
      const workstreams = { W1: w1 };
      const readyWorkstreamIds = ["W1"];

      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds });

      assert.strictEqual(result.advanced.length, 0);
      assert.strictEqual(result.skipped.length, 0);
      assert.strictEqual(result.blocked.length, 1);
      assert.strictEqual(result.blocked[0]?.workstreamId, "W1");
      assert.strictEqual(result.blocked[0]?.reason, "current_wave_incomplete");
      assert.strictEqual(result.workstreams["W1"], w1);
    });

    it("3. Ready workstream without packet plan is blocked with no_packet_plan", () => {
      const w1 = baseWorkstream("W1");
      delete w1.packetPlan;
      const workstreams = { W1: w1 };
      const readyWorkstreamIds = ["W1"];

      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds });

      assert.strictEqual(result.blocked.length, 1);
      assert.strictEqual(result.blocked[0]?.reason, "no_packet_plan");
      assert.strictEqual(result.workstreams["W1"], w1);
    });

    it("4. Ready final-wave workstream is blocked with no_future_wave", () => {
      const w1 = baseWorkstream("W1");
      w1.packetPlan!.currentWaveIndex = 1;
      w1.packetPlan!.packets["T3"]!.status = "merged_to_parent";
      w1.packetPlan!.packets["T4"]!.status = "merged_to_parent";

      const workstreams = { W1: w1 };
      const readyWorkstreamIds = ["W1"];

      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds });

      assert.strictEqual(result.blocked.length, 1);
      assert.strictEqual(result.blocked[0]?.reason, "no_future_wave");
      assert.strictEqual(result.workstreams["W1"], w1);
    });

    it("5. Returns a new top-level workstreams collection without mutating input", () => {
      const w1 = baseWorkstream("W1");
      w1.packetPlan = markCurrentWaveMerged(w1.packetPlan!);
      const workstreams = { W1: w1 };
      const before = structuredClone(workstreams);

      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds: ["W1"] });

      assert.notStrictEqual(result.workstreams, workstreams);
      assert.deepStrictEqual(workstreams, before);
    });

    it("6. Advanced item includes transition details", () => {
      const w1 = baseWorkstream("W1");
      w1.packetPlan = markCurrentWaveMerged(w1.packetPlan!);
      const workstreams = { W1: w1 };

      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds: ["W1"] });

      const item = result.advanced[0];
      assert.ok(item);
      assert.strictEqual(item.workstreamId, "W1");
      assert.strictEqual(item.fromWaveIndex, 0);
      assert.strictEqual(item.toWaveIndex, 1);
      assert.deepStrictEqual(item.nextWavePacketIds, ["T3", "T4"]);
      assert.strictEqual(item.result.advanced, true);
    });

    it("7. Preserves deterministic workstream order in result arrays", () => {
      const w1 = baseWorkstream("W1");
      w1.packetPlan = markCurrentWaveMerged(w1.packetPlan!);
      const w2 = baseWorkstream("W2");
      w2.packetPlan = markCurrentWaveMerged(w2.packetPlan!);
      const w3 = baseWorkstream("W3");
      w3.packetPlan = markCurrentWaveMerged(w3.packetPlan!);

      // insertion order: W2, W1, W3
      const workstreams: Record<string, WorkstreamRecord> = {};
      workstreams["W2"] = w2;
      workstreams["W1"] = w1;
      workstreams["W3"] = w3;

      const readyWorkstreamIds = ["W1", "W2", "W3"];
      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds });

      assert.deepStrictEqual(result.advanced.map(a => a.workstreamId), ["W2", "W1", "W3"]);
    });

    it("8. Empty readiness set advances nothing", () => {
      const w1 = baseWorkstream("W1");
      w1.packetPlan = markCurrentWaveMerged(w1.packetPlan!);
      const w2 = baseWorkstream("W2");
      w2.packetPlan = markCurrentWaveMerged(w2.packetPlan!);

      const workstreams = { W1: w1, W2: w2 };
      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds: [] });

      assert.strictEqual(result.advanced.length, 0);
      assert.strictEqual(result.skipped.length, 2);
      assert.strictEqual(result.workstreams["W1"], w1);
      assert.strictEqual(result.workstreams["W2"], w2);
    });

    it("9. Unknown ready ID is ignored safely", () => {
      const w1 = baseWorkstream("W1");
      const workstreams = { W1: w1 };

      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds: ["missing-id"] });

      assert.strictEqual(result.advanced.length, 0);
      assert.strictEqual(result.blocked.length, 0);
      assert.strictEqual(result.skipped.length, 1);
      assert.strictEqual(result.skipped[0]?.workstreamId, "W1");
    });

    it("10. Multiple ready workstreams can advance independently", () => {
      const w1 = baseWorkstream("W1");
      w1.packetPlan = markCurrentWaveMerged(w1.packetPlan!);

      const w2 = baseWorkstream("W2");
      w2.packetPlan!.currentWaveIndex = 1;
      w2.packetPlan!.packets["T3"]!.status = "merged_to_parent";
      w2.packetPlan!.packets["T4"]!.status = "merged_to_parent";
      w2.packetPlan!.waves.push(["T5"]);
      w2.packetPlan!.packets["T5"] = { id: "T5", title: "T5", summary: "S5", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" };

      const w3 = baseWorkstream("W3");

      const workstreams = { W1: w1, W2: w2, W3: w3 };
      const readyWorkstreamIds = ["W1", "W2"];

      const result = advanceReadyWorkstreamPacketWaves({ workstreams, readyWorkstreamIds });

      assert.strictEqual(result.advanced.length, 2);
      assert.strictEqual(result.workstreams["W1"]?.packetPlan?.currentWaveIndex, 1);
      assert.strictEqual(result.workstreams["W2"]?.packetPlan?.currentWaveIndex, 2);
      assert.strictEqual(result.workstreams["W3"], w3);
    });
  });
});
