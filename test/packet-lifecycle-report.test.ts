import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPacketLifecycleWorkstreamReport,
  formatPacketLifecycleReport,
  type BuildLifecycleWorkstreamReportInput
} from "../src/workstreams/packet-lifecycle-report.js";

test("formatter: multiple waves with mixed statuses", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:146",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 1,
        waves: [["T1"], ["T2", "T3"], ["T4"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 },
          T2: { id: "T2", status: "pr_open", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 205 },
          T3: { id: "T3", status: "planned", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [] },
          T4: { id: "T4", status: "planned", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [] }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:146", repoKey: "owner/repo", parentIntegrationBranch: "agent/issue-146", defaultBranch: "main",
          currentWaveIndex: 1, nextWaveIndex: 2, completedPacketIds: ["T1"], pendingFuturePacketIds: ["T4"]
        },
        branchSyncComparison: { parentBranch: "agent/issue-146", defaultBranch: "main", parentRef: "", defaultRef: "", status: "up_to_date", message: "" }
      }
    ]
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("Current wave: 1 / 3"));
  assert.ok(formatted.includes("Wave 0 - complete"));
  assert.ok(formatted.includes("- T1 - merged_to_parent - PR #201"));
  assert.ok(formatted.includes("Wave 1 - current"));
  assert.ok(formatted.includes("- T2 - pr_open - PR #205"));
  assert.ok(formatted.includes("- T3 - planned - no PR yet"));
  assert.ok(formatted.includes("Wave 2 - future"));
  assert.ok(formatted.includes("- T4 - planned - no PR yet"));
  assert.ok(formatted.includes("Next expected action:\n- run orchestrator again to create current-wave packet PRs"));
});

test("formatter: behind_default with ahead/behind counts", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:181",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 0,
        waves: [["T1"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:181", repoKey: "owner/repo", parentIntegrationBranch: "agent/issue-181", defaultBranch: "main",
          currentWaveIndex: 0, nextWaveIndex: 1, completedPacketIds: [], pendingFuturePacketIds: []
        },
        branchSyncComparison: {
          parentBranch: "agent/issue-181", defaultBranch: "main", parentRef: "", defaultRef: "",
          status: "behind_default", message: "", parentAheadCount: 5, parentBehindCount: 10
        }
      }
    ],
    agentSyncParentBranchLabel: "custom-sync-label"
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("Parent branch sync:"));
  assert.ok(formatted.includes("- Parent branch: `agent/issue-181`"));
  assert.ok(formatted.includes("- Default branch: `main`"));
  assert.ok(formatted.includes("- Status: `behind_default` (behind 10, ahead 5)"));
  assert.ok(formatted.includes("add `custom-sync-label` to the parent PR to authorize merging default into the parent branch"));
  assert.ok(formatted.includes("- Action label: `custom-sync-label`"));
});

test("formatter: diverged with conflict-aware recommendation", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:181",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 0,
        waves: [["T1"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:181", repoKey: "owner/repo", parentIntegrationBranch: "agent/issue-181", defaultBranch: "main",
          currentWaveIndex: 0, nextWaveIndex: 1, completedPacketIds: [], pendingFuturePacketIds: []
        },
        branchSyncComparison: {
          parentBranch: "agent/issue-181", defaultBranch: "main", parentRef: "", defaultRef: "",
          status: "diverged", message: "", parentAheadCount: 2, parentBehindCount: 3
        }
      }
    ]
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("- Status: `diverged` (behind 3, ahead 2)"));
  assert.ok(formatted.includes("authorizes one conflict-aware merge attempt"));
  assert.ok(formatted.includes("If conflicts occur, they will be reported as blocked"));
});

test("formatter: missing_parent_branch", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:181",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 0,
        waves: [["T1"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:181", repoKey: "owner/repo", parentIntegrationBranch: "agent/issue-181", defaultBranch: "main",
          currentWaveIndex: 0, nextWaveIndex: 1, completedPacketIds: [], pendingFuturePacketIds: []
        },
        branchSyncComparison: {
          parentBranch: "agent/issue-181", defaultBranch: "main", parentRef: "", defaultRef: "",
          status: "missing_parent_branch", message: ""
        }
      }
    ],
    agentSyncParentBranchLabel: "agent-sync-parent-branch"
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("- Status: `missing_parent_branch`"));
  assert.ok(formatted.includes("sync is blocked because required branch refs are missing"));
  assert.ok(!formatted.includes("Action label:"), "Should NOT include Action label when blocked/missing refs");
});

test("formatter: missing_local_path", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:181",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 0,
        waves: [["T1"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:181", repoKey: "owner/repo", parentIntegrationBranch: "agent/issue-181", defaultBranch: "main",
          currentWaveIndex: 0, nextWaveIndex: 1, completedPacketIds: [], pendingFuturePacketIds: []
        },
        branchSyncComparisonSkippedReason: "missing_local_path"
      }
    ]
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("- Status: unavailable (missing local repository path)"));
  assert.ok(formatted.includes("parent branch sync status is unavailable or unknown"));
});

test("formatter: advancement event and packet PR creation", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:146",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 1,
        waves: [["T1"], ["T2", "T3"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 },
          T2: { id: "T2", status: "pr_open", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 205 },
          T3: { id: "T3", status: "planned", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [] }
        }
      }
    },
    packetPrsCreatedThisRun: [
      { workstreamId: "owner/repo:issue:146", repoKey: "owner/repo", packetId: "T2", waveIndex: 1, branchName: "b", prNumber: 205 }
    ],
    waveAdvancementsThisRun: [
      { workstreamId: "owner/repo:issue:146", repoKey: "owner/repo", fromWaveIndex: 0, toWaveIndex: 1, completedPacketIds: ["T1"], newlyCurrentPacketIds: ["T2", "T3"] }
    ],
    blockedThisRun: [],
    parentBranchSyncPreflights: []
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("- Advanced from wave 0 to wave 1."));
  assert.ok(formatted.includes("- Created packet PR #205 for T2."));
  assert.ok(formatted.includes("- Deferred packet PR creation for newly advanced packets until the next run: T3."));
});

test("formatter: blocked/waiting event", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:146",
      repoKey: "owner/repo",
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 0,
        waves: [["T1"]],
        packets: {
          T1: { id: "T1", status: "pr_open", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [] }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [
      { workstreamId: "owner/repo:issue:146", repoKey: "owner/repo", reason: "current_wave_incomplete", incompletePacketIds: ["T1"] }
    ]
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("Blocked / waiting:"));
  assert.ok(formatted.includes("- current_wave_incomplete"));
});

test("formatter: wave complete but branch sync not ready", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:146",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 0,
        waves: [["T1"], ["T2"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 },
          T2: { id: "T2", status: "planned", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [] }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:146", repoKey: "owner/repo", parentIntegrationBranch: "agent/issue-146", defaultBranch: "main",
          currentWaveIndex: 0, nextWaveIndex: 1, completedPacketIds: ["T1"], pendingFuturePacketIds: ["T2"]
        },
        branchSyncComparison: { parentBranch: "agent/issue-146", defaultBranch: "main", parentRef: "", defaultRef: "", status: "behind_default", message: "" }
      }
    ]
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("Next expected action:\n- follow branch sync recommendation"));
});

test("formatter: final wave complete (no future wave, no preflight)", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:146",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 0,
        waves: [["T1"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [],
    parentBranchSyncPreflights: [] // No preflight data
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("Current wave: 0 / 1"));
  assert.ok(formatted.includes("Wave 0 - current"));
  assert.ok(formatted.includes("- T1 - merged_to_parent - PR #201"));
  assert.ok(formatted.includes("Next expected action:\n- complete or verify final parent PR state"));
});

test("formatter: up_to_date section rendering", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:181",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 0,
        waves: [["T1"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:181", repoKey: "owner/repo", parentIntegrationBranch: "agent/issue-181", defaultBranch: "main",
          currentWaveIndex: 0, nextWaveIndex: 1, completedPacketIds: [], pendingFuturePacketIds: []
        },
        branchSyncComparison: {
          parentBranch: "agent/issue-181", defaultBranch: "main", parentRef: "", defaultRef: "",
          status: "up_to_date", message: ""
        }
      }
    ],
    agentSyncParentBranchLabel: "agent-sync-parent-branch"
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("- Status: `up_to_date`"));
  assert.ok(formatted.includes("up to date with default"));
  assert.ok(!formatted.includes("Action label:"), "Should NOT include Action label when up_to_date even if provided");
});

test("formatter: unknown/absent comparison", () => {
  const input: BuildLifecycleWorkstreamReportInput = {
    workstream: {
      id: "owner/repo:issue:181",
      repoKey: "owner/repo",
      integration: { prNumber: 123 },
      packetPlan: {
        status: "in_progress",
        currentWaveIndex: 0,
        waves: [["T1"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], prNumber: 201 }
        }
      }
    },
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:181", repoKey: "owner/repo", parentIntegrationBranch: "agent/issue-181", defaultBranch: "main",
          currentWaveIndex: 0, nextWaveIndex: 1, completedPacketIds: [], pendingFuturePacketIds: []
        }
      }
    ]
  };

  const report = buildPacketLifecycleWorkstreamReport(input);
  if (!report) throw new Error("Expected report");
  const formatted = formatPacketLifecycleReport(report);

  assert.ok(formatted.includes("- Status: unknown"));
  assert.ok(formatted.includes("parent branch sync status is unavailable or unknown"));
});
