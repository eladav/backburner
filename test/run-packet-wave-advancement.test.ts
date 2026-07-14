import { describe, it, test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPacketProvisioningRepoPathMap,
  buildPacketWaveAdvancementEvaluationForRun,
  runCli,
  type ParentBranchSyncPreflightRunSummary
} from "../src/cli/run.js";
import type { BranchSyncComparison } from "../src/git/types.js";
import type {
  WorkstreamPacketPlan,
  WaveAssessmentResult,
  WorkstreamRecord,
  WorkstreamPacket,
  RepoSyncRecord
} from "../src/state/types.js";
import type { ParentBranchSyncPreflight } from "../src/tasks/types.js";
import type { RepoConfig } from "../src/config/types.js";
import type { WorkstreamRecord as WorkstreamStateRecord } from "../src/state/types.js";
import { buildWaveAssessmentCheckpointForPreflight } from "../src/workstreams/wave-assessment/checkpoint.js";

// Fixture helpers
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
  const slug = id.replace(/[:\/]/g, "-");
  const ws: WorkstreamRecord = {
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
      branchName: `agent/owner-repo/${slug}`,
      prNumber: 100
    },
    ...overrides
  };
  if (ws.packetPlan && !ws.packetPlan.waveAssessments) {
    ws.packetPlan = {
      ...ws.packetPlan,
      waveAssessments: [waveAssessment(preflightForWorkstream(ws))]
    };
  }
  return ws;
}

function preflightForWorkstream(workstream: WorkstreamRecord): ParentBranchSyncPreflight {
  const currentWaveIndex = workstream.packetPlan?.currentWaveIndex ?? 0;
  const packetIds = Object.keys(workstream.packetPlan?.packets ?? {}).sort();
  const preflight: ParentBranchSyncPreflight = {
    workstreamId: workstream.id,
    repoKey: workstream.id.split(":issue:")[0] ?? workstream.repoKey,
    parentIntegrationBranch: workstream.integration?.branchName ?? "agent/owner-repo/issue-1",
    defaultBranch: "main",
    planRevision: `${currentWaveIndex}:${packetIds.join(",")}`,
    currentWaveIndex,
    nextWaveIndex: currentWaveIndex + 1,
    completedPacketIds: workstream.packetPlan?.waves[currentWaveIndex] ?? ["T1"],
    pendingFuturePacketIds: workstream.packetPlan?.waves.slice(currentWaveIndex + 1).flat() ?? ["T2"],
    planNodeIds: packetIds
  };
  if (workstream.integration?.prNumber !== undefined) {
    preflight.parentPrNumber = workstream.integration.prNumber;
  }
  return preflight;
}

function preflight(workstreamId: string): ParentBranchSyncPreflight {
  return {
    workstreamId,
    repoKey: "owner/repo",
    parentIntegrationBranch: "agent/owner-repo/issue-1",
    parentPrNumber: 100,
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

function setLatestAssessmentCurrentIdentity(workstream: WorkstreamRecord, parentHeadSha: string): void {
  const assessment = workstream.packetPlan?.waveAssessments?.[0];
  if (assessment) {
    assessment.checkpoint.identity.parentHeadSha = parentHeadSha;
    assessment.checkpoint.identity.planRevision = `${workstream.packetPlan?.currentWaveIndex ?? 0}:${Object.keys(workstream.packetPlan?.packets ?? {}).sort().join(",")}`;
    assessment.checkpoint.identity.planNodeIds = Object.keys(workstream.packetPlan?.packets ?? {}).sort();
  }
}

function preflightSummary(
  workstreamId: string,
  options: {
    status?: BranchSyncComparison["status"];
    skippedReason?: "missing_local_path";
    omitComparison?: boolean;
  }
): ParentBranchSyncPreflightRunSummary {
  const summary: ParentBranchSyncPreflightRunSummary = {
    preflight: preflight(workstreamId)
  };

  if (!options.omitComparison && options.status) {
    summary.branchSyncComparison = branchComparison(options.status);
  }

  if (options.skippedReason) {
    summary.branchSyncComparisonSkippedReason = options.skippedReason;
  }

  return summary;
}

function repoResult(input: {
  id: string;
  status: RepoSyncRecord["status"];
  fetched: boolean;
  defaultBranchSyncStatus?: RepoSyncRecord["defaultBranchSyncStatus"];
}): RepoSyncRecord {
  return {
    repoId: input.id,
    repoName: input.id,
    repoSlug: `owner/${input.id}`,
    localPath: `/tmp/${input.id}`,
    codeRoot: "/tmp",
    status: input.status,
    existedBeforeSync: true,
    cloned: false,
    fetched: input.fetched,
    defaultBranch: "main",
    defaultBranchSource: "config",
    currentBranchBefore: "main",
    currentBranchAfter: "main",
    syncedAt: "2026-07-14T00:00:00.000Z",
    message: "test",
    ...(input.defaultBranchSyncStatus
      ? { defaultBranchSyncStatus: input.defaultBranchSyncStatus }
      : {})
  };
}

test("packet provisioning accepts fetched repositories even when checkout synchronization failed", () => {
  const paths = buildPacketProvisioningRepoPathMap([
    repoResult({ id: "synced", status: "synced", fetched: true }),
    repoResult({
      id: "dirty-after-fetch",
      status: "failed",
      fetched: true,
      defaultBranchSyncStatus: "blocked_dirty"
    }),
    repoResult({
      id: "other-sync-failure",
      status: "failed",
      fetched: true,
      defaultBranchSyncStatus: "failed"
    }),
    repoResult({ id: "fetch-failed", status: "failed", fetched: false })
  ]);

  assert.equal(paths.get("synced"), "/tmp/synced");
  assert.equal(paths.get("dirty-after-fetch"), "/tmp/dirty-after-fetch");
  assert.equal(paths.has("other-sync-failure"), false);
  assert.equal(paths.has("fetch-failed"), false);
});

describe("buildPacketWaveAdvancementEvaluationForRun", () => {
  it("advances a ready and complete workstream", () => {
    const ws = workstream("W1", { packetPlan: packetPlan() });
    const preflights = [preflightSummary("W1", { status: "up_to_date" })];

    const evaluation = buildPacketWaveAdvancementEvaluationForRun({
      workstreams: [ws],
      parentBranchSyncPreflights: preflights,
      waveAssessments: [waveAssessment(preflights[0]!.preflight)]
    });

    assert.deepEqual(evaluation.readyWorkstreamIds, ["W1"]);
    assert.equal(evaluation.result.advanced.length, 1);
    assert.equal(evaluation.result.advanced[0]!.workstreamId, "W1");
    assert.equal(evaluation.result.advanced[0]!.fromWaveIndex, 0);
    assert.equal(evaluation.result.advanced[0]!.toWaveIndex, 1);
    assert.equal(evaluation.result.workstreams["W1"]?.packetPlan?.currentWaveIndex, 1);

    // Original input workstream should not be mutated
    assert.equal(ws.packetPlan?.currentWaveIndex, 0);
  });

  it("skips a behind_default branch workstream", () => {
    const ws = workstream("W1", { packetPlan: packetPlan() });
    const preflights = [preflightSummary("W1", { status: "behind_default" })];

    const evaluation = buildPacketWaveAdvancementEvaluationForRun({
      workstreams: [ws],
      parentBranchSyncPreflights: preflights
    });

    assert.deepEqual(evaluation.readyWorkstreamIds, []);
    assert.equal(evaluation.result.advanced.length, 0);
    assert.equal(evaluation.result.skipped.length, 1);
    assert.equal(evaluation.result.skipped[0]!.workstreamId, "W1");
    assert.equal(evaluation.result.workstreams["W1"]?.packetPlan?.currentWaveIndex, 0);
  });

  it("does not advance diverged / missing / unknown / missing_local_path states", () => {
    const testCases: Array<{
      status?: BranchSyncComparison["status"];
      skippedReason?: "missing_local_path";
      omitComparison?: boolean;
    }> = [
      { status: "diverged" },
      { status: "missing_parent_branch" },
      { status: "missing_default_branch" },
      { status: "unknown" },
      { omitComparison: true },
      { status: "up_to_date", skippedReason: "missing_local_path" }
    ];

    for (const testCase of testCases) {
      const wsId = `W-${testCase.status ?? "no-status"}-${testCase.skippedReason ?? "no-skipped-reason"}`;
      const ws = workstream(wsId, { packetPlan: packetPlan() });
      const preflights = [preflightSummary(wsId, testCase)];

      const evaluation = buildPacketWaveAdvancementEvaluationForRun({
        workstreams: [ws],
        parentBranchSyncPreflights: preflights
      });

      assert.deepEqual(evaluation.readyWorkstreamIds, [], `failed for ${JSON.stringify(testCase)}`);
      assert.equal(evaluation.result.advanced.length, 0, `failed for ${JSON.stringify(testCase)}`);
    }
  });

  it("blocks advancement if packet plan is incomplete or missing", () => {
    // Case 1: Incomplete current wave
    const wsIncomplete = workstream("W1", {
      packetPlan: packetPlan({
        packets: {
          T1: packet("T1", "planned"), // Not merged
          T2: packet("T2", "planned")
        }
      })
    });

    // Case 2: Missing packet plan
    const wsMissingPlan = workstream("W2");
    // Ensure packetPlan is really missing
    delete (wsMissingPlan as any).packetPlan;

    const preflights = [
      preflightSummary("W1", { status: "up_to_date" }),
      preflightSummary("W2", { status: "up_to_date" })
    ];

    const evaluation = buildPacketWaveAdvancementEvaluationForRun({
      workstreams: [wsIncomplete, wsMissingPlan],
      parentBranchSyncPreflights: preflights,
      waveAssessments: [
        waveAssessment(preflights[0]!.preflight),
        waveAssessment(preflights[1]!.preflight)
      ]
    });

    assert.deepEqual(evaluation.readyWorkstreamIds, ["W1", "W2"]);
    assert.equal(evaluation.result.advanced.length, 0);
    assert.equal(evaluation.result.blocked.length, 2);

    assert.equal(evaluation.result.blocked[0]!.workstreamId, "W1");
    assert.equal(evaluation.result.blocked[0]!.reason, "current_wave_incomplete");

    assert.equal(evaluation.result.blocked[1]!.workstreamId, "W2");
    assert.equal(evaluation.result.blocked[1]!.reason, "no_packet_plan");
  });

  it("maintains deterministic ordering for mixed workstreams", () => {
    const wsReady = workstream("W-READY", { packetPlan: packetPlan() });
    const wsBehind = workstream("W-BEHIND", { packetPlan: packetPlan() });
    const wsBlocked = workstream("W-BLOCKED", {
      packetPlan: packetPlan({
        packets: { T1: packet("T1", "planned"), T2: packet("T2", "planned") }
      })
    });

    // Pass preflights in a different order than workstreams
    const workstreams = [wsBehind, wsReady, wsBlocked];
    const preflights = [
      preflightSummary("W-READY", { status: "up_to_date" }),
      preflightSummary("W-BLOCKED", { status: "up_to_date" }),
      preflightSummary("W-BEHIND", { status: "behind_default" })
    ];

    const evaluation = buildPacketWaveAdvancementEvaluationForRun({
      workstreams,
      parentBranchSyncPreflights: preflights,
      waveAssessments: [
        waveAssessment(preflights[0]!.preflight),
        waveAssessment(preflights[1]!.preflight)
      ]
    });

    // readyWorkstreamIds follows preflight summary order
    assert.deepEqual(evaluation.readyWorkstreamIds, ["W-READY", "W-BLOCKED"]);

    // Result arrays follow workstream collection order (W-BEHIND, W-READY, W-BLOCKED)
    assert.equal(evaluation.result.skipped.length, 1);
    assert.equal(evaluation.result.skipped[0]!.workstreamId, "W-BEHIND");

    assert.equal(evaluation.result.advanced.length, 1);
    assert.equal(evaluation.result.advanced[0]!.workstreamId, "W-READY");

    assert.equal(evaluation.result.blocked.length, 1);
    assert.equal(evaluation.result.blocked[0]!.workstreamId, "W-BLOCKED");

    // Combined workstream map follows workstream collection order
    assert.deepEqual(Object.keys(evaluation.result.workstreams), ["W-BEHIND", "W-READY", "W-BLOCKED"]);
  });

  it("does not mutate inputs", () => {
    const ws = workstream("W1", { packetPlan: packetPlan() });
    const preflights = [preflightSummary("W1", { status: "up_to_date" })];

    const workstreamsInput = [ws];
    const preflightsInput = preflights;

    const workstreamsBefore = structuredClone(workstreamsInput);
    const preflightsBefore = structuredClone(preflightsInput);

    const evaluation = buildPacketWaveAdvancementEvaluationForRun({
      workstreams: workstreamsInput,
      parentBranchSyncPreflights: preflightsInput,
      waveAssessments: [waveAssessment(preflightsInput[0]!.preflight)]
    });

    assert.deepEqual(workstreamsInput, workstreamsBefore);
    assert.deepEqual(preflightsInput, preflightsBefore);

    // Advanced workstream should only appear in evaluation result, not in original fixture
    assert.equal(evaluation.result.workstreams["W1"]?.packetPlan?.currentWaveIndex, 1);
    assert.equal(ws.packetPlan?.currentWaveIndex, 0);
  });
});

describe("runCli persistence of packet-wave advancement", () => {
  async function setup() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-advancement-"));
    const managementDir = path.join(tempDir, "management");
    const stateDir = path.join(managementDir, "state");
    const codeRoot = path.join(tempDir, "code-root");

    await mkdir(stateDir, { recursive: true });

    return { tempDir, managementDir, stateDir, codeRoot };
  }

  async function writeManagementConfig(
    managementDir: string,
    repos: RepoConfig[],
    agents: unknown[] = []
  ): Promise<void> {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["owner", "human"], repos }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({ agents }, null, 2),
      "utf8"
    );
  }

  function baseRepoConfig(id: string, name: string): RepoConfig {
    return {
      id,
      owner: "owner",
      name,
      localPath: name,
      enabled: true,
      defaultBranch: "main",
      labels: {
        agentInProgress: "agent-in-progress",
        agentPlanApproved: "agent-plan-approved",
        agentProductApproved: "agent-product-approved",
        agentReview: "agent-review",
        planBreakdownNeeded: "plan-breakdown-needed",
        agentSyncParentBranch: "agent-sync-parent-branch",
        prepareForMerge: "prepare-for-merge"
      }
    };
  }

  function createRepoResult(
    id: string,
    name: string,
    codeRoot: string,
    status: "synced" | "failed" = "synced"
  ): RepoSyncRecord {
    return {
      repoId: id,
      repoName: name,
      repoSlug: `owner/${name}`,
      localPath: path.join(codeRoot, name),
      codeRoot,
      status,
      existedBeforeSync: true,
      cloned: false,
      fetched: true,
      defaultBranch: "main",
      defaultBranchSource: "github",
      currentBranchBefore: "main",
      currentBranchAfter: "main",
      syncedAt: new Date().toISOString(),
      message: status === "synced" ? "ok" : "failed"
    };
  }

  function createGitGatewayMock(overrides: any = {}) {
    return {
      compareBranchSyncStatus: async () => branchComparison("up_to_date"),
      validatePathWithinCodeRoot: (root: string, p: string) => path.resolve(root, p),
      pushBranch: async () => {},
      createWorktree: async (_repoPath: string, _codeRoot: string, worktreePath: string) => worktreePath,
      getCurrentBranch: async () => "main",
      getRemoteDefaultBranch: async () => "main",
      isWorkingTreeClean: async () => true,
      hasCommitsAhead: async () => false,
      commitAll: async () => true,
      ensureDefaultBranchCheckedOut: async () => {},
      fastForwardDefaultBranch: async () => {},
      isInsideWorkingTree: async () => true,
      pullFastForwardOnly: async () => {},
      getHeadCommitSha: async () => "abc123456789",
      cloneRepositoryFromUrl: async () => {},
      checkoutBranchAtRemote: async () => {},
      getAheadBehindVsRemote: async () => ({ ahead: 0, behind: 0 }),
      isAncestorOf: async () => true,
      countCommitsAheadOf: async () => 0,
      getActiveMergeState: async () => "none",
      pushWithLease: async () => {},
      removeDirectory: async () => {},
      getCommitLogSince: async () => "",
      getDiffStatSince: async () => "",
      fetchRepository: async () => {},
      ...overrides
    };
  }

  function isUnder(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function createGitHubGatewayMock() {
    return {
      findOpenPullRequestByHeadBranch: async () => undefined,
      createPullRequest: async () => ({
        id: "PR_NEW",
        number: 200,
        url: "https://github.com/owner/repo-one/pull/200",
        state: "open",
        author: { login: "owner" }
      })
    };
  }

  test("Ready branch plus complete wave persists advancement", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      const ws = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        packetPlan: packetPlan()
      });
      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [ws] }),
        "utf8"
      );

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: "owner/repo-one:issue:1",
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      const options = {
        managementDir,
        stateDir,
        gitGateway: createGitGatewayMock(),
        gitHubGateway: createGitHubGatewayMock() as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsFile = JSON.parse(
        await readFile(path.join(stateDir, "workstreams.json"), "utf8")
      );
      const advancedWs = workstreamsFile.workstreams.find(
        (w: WorkstreamStateRecord) => w.id === ws.id
      );
      assert.equal(advancedWs.packetPlan.currentWaveIndex, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("Behind-default branch does not persist advancement", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      const ws = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        packetPlan: packetPlan()
      });
      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [ws] }),
        "utf8"
      );

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: "owner/repo-one:issue:1",
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      const options = {
        managementDir,
        stateDir,
        gitGateway: createGitGatewayMock({
          compareBranchSyncStatus: async () => branchComparison("behind_default")
        }),
        gitHubGateway: createGitHubGatewayMock() as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsFile = JSON.parse(
        await readFile(path.join(stateDir, "workstreams.json"), "utf8")
      );
      const unchangedWs = workstreamsFile.workstreams.find(
        (w: WorkstreamStateRecord) => w.id === ws.id
      );
      assert.equal(unchangedWs.packetPlan.currentWaveIndex, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("Attention is derived from advanced workstreams", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      const ws = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        packetPlan: packetPlan()
      });
      // Initial state has sync needed attention
      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [ws] }),
        "utf8"
      );
      await writeFile(
        path.join(stateDir, "attention.json"),
        JSON.stringify({
          attention: [
            {
              id: "att:repo-1:issue:1:packet_wave_complete_sync_needed",
              workstreamId: ws.id,
              reason: "packet_wave_complete_sync_needed"
            }
          ]
        }),
        "utf8"
      );

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: "owner/repo-one:issue:1",
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      const options = {
        managementDir,
        stateDir,
        gitGateway: createGitGatewayMock(),
        gitHubGateway: createGitHubGatewayMock() as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      await runCli(["run", "--code-root", codeRoot], options);

      const attentionFile = JSON.parse(
        await readFile(path.join(stateDir, "attention.json"), "utf8")
      );
      const syncNeededAttention = attentionFile.attention.find(
        (a: any) => a.reason === "packet_wave_complete_sync_needed"
      );
      assert.equal(syncNeededAttention, undefined);

      const workstreamsFile = JSON.parse(
        await readFile(path.join(stateDir, "workstreams.json"), "utf8")
      );
      assert.equal(workstreamsFile.workstreams[0].packetPlan.currentWaveIndex, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("Next-wave packet PRs are not created in the same run", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      const ws = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        packetPlan: packetPlan({
          packets: {
            T1: packet("T1", "merged_to_parent"),
            T2: packet("T2", "planned") // This is wave 1
          }
        })
      });
      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [ws] }),
        "utf8"
      );

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: "owner/repo-one:issue:1",
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      let createWorktreeCalls = 0;
      const options = {
        managementDir,
        stateDir,
        gitGateway: createGitGatewayMock({
          createWorktree: async (_repoPath: string, _codeRoot: string, worktreePath: string) => {
            createWorktreeCalls++;
            return worktreePath;
          }
        }),
        gitHubGateway: createGitHubGatewayMock() as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      await runCli(["run", "--code-root", codeRoot], options);

      assert.equal(createWorktreeCalls, 0);

      const workstreamsFile = JSON.parse(
        await readFile(path.join(stateDir, "workstreams.json"), "utf8")
      );
      const advancedWs = workstreamsFile.workstreams.find(
        (w: WorkstreamStateRecord) => w.id === ws.id
      );
      assert.equal(advancedWs.packetPlan.currentWaveIndex, 1);
      assert.equal(advancedWs.packetPlan.packets.T2.status, "planned");
      assert.equal(advancedWs.packetPlan.packets.T2.branchName, undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("Mixed workstreams advance only eligible ready workstreams", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      const wsReady = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        packetPlan: packetPlan()
      });
      const wsBlockedBranch = workstream("owner/repo-one:issue:2", {
        repoKey: "repo-1",
        packetPlan: packetPlan()
      });
      const wsBlockedIncomplete = workstream("owner/repo-one:issue:3", {
        repoKey: "repo-1",
        packetPlan: packetPlan({
          packets: {
            T1: packet("T1", "planned"),
            T2: packet("T2", "planned")
          }
        })
      });

      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [wsReady, wsBlockedBranch, wsBlockedIncomplete] }),
        "utf8"
      );

      const issues = [1, 2, 3].map((n) => ({
        kind: "issue" as const,
        id: `issue:owner/repo-one:${n}`,
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: n,
        key: `owner/repo-one:issue:${n}`,
        sourceId: `I${n}`,
        url: `https://github.com/owner/repo-one/issues/${n}`,
        title: `Issue ${n}`,
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      }));

      const options = {
        managementDir,
        stateDir,
        gitGateway: createGitGatewayMock({
          compareBranchSyncStatus: async (_path: string, parentBranch: string) => {
            if (parentBranch.includes("issue-2")) {
              return branchComparison("behind_default");
            }
            return branchComparison("up_to_date");
          }
        }),
        gitHubGateway: createGitHubGatewayMock() as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues,
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsFile = JSON.parse(
        await readFile(path.join(stateDir, "workstreams.json"), "utf8")
      );

      const readyWs = workstreamsFile.workstreams.find((w: any) => w.id === wsReady.id);
      const blockedBranchWs = workstreamsFile.workstreams.find((w: any) => w.id === wsBlockedBranch.id);
      const blockedIncompleteWs = workstreamsFile.workstreams.find((w: any) => w.id === wsBlockedIncomplete.id);

      assert.equal(readyWs.packetPlan.currentWaveIndex, 1);
      assert.equal(blockedBranchWs.packetPlan.currentWaveIndex, 0);
      assert.equal(blockedIncompleteWs.packetPlan.currentWaveIndex, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("persisted wave advancement creates next-wave packet PR on the following run", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      const ws = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        packetPlan: packetPlan({
          packets: {
            T1: packet("T1", "merged_to_parent"),
            T2: packet("T2", "planned") // This is wave 1
          }
        })
      });
      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [ws] }),
        "utf8"
      );

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: "owner/repo-one:issue:1",
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      let createWorktreeCalls = 0;
      let createPullRequestCalls = 0;
      const createdWorktreeCalls: Array<{
        worktreePath: string;
        branchName: string;
        startPoint: string;
      }> = [];

      const gitGateway = createGitGatewayMock({
        createWorktree: async (
          _repoPath: string,
          _codeRoot: string,
          worktreePath: string,
          branchName: string,
          startPoint: string
        ) => {
          createWorktreeCalls++;
          createdWorktreeCalls.push({ worktreePath, branchName, startPoint });
          return worktreePath;
        }
      });

      const gitHubGateway = {
        findOpenPullRequestByHeadBranch: async () => undefined,
        createPullRequest: async () => {
          createPullRequestCalls++;
          return {
            id: "PR_T2",
            number: 200,
            url: "https://github.com/owner/repo-one/pull/200",
            state: "open",
            author: { login: "owner" }
          };
        }
      };

      const dirtyAfterFetchRepoResult = {
        ...createRepoResult("repo-1", "repo-one", codeRoot, "failed"),
        defaultBranchSyncStatus: "blocked_dirty" as const
      };

      const options = {
        managementDir,
        stateDir,
        gitGateway,
        gitHubGateway: gitHubGateway as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return dirtyAfterFetchRepoResult;
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [],
              comments: [],
              repoResults: [dirtyAfterFetchRepoResult],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      // --- RUN N ---
      await runCli(["run", "--code-root", codeRoot], options);

      // Run N assertions
      const workstreamsFileN = JSON.parse(
        await readFile(path.join(stateDir, "workstreams.json"), "utf8")
      );
      const advancedWsN = workstreamsFileN.workstreams.find(
        (w: WorkstreamStateRecord) => w.id === ws.id
      );
      assert.equal(advancedWsN.packetPlan.currentWaveIndex, 1);
      assert.equal(advancedWsN.packetPlan.packets.T2.status, "planned");
      assert.equal(advancedWsN.packetPlan.packets.T2.branchName, undefined);
      assert.equal(advancedWsN.packetPlan.packets.T2.prNumber, undefined);
      assert.equal(createWorktreeCalls, 0, "Run N should not create worktrees for the new wave");
      assert.equal(createPullRequestCalls, 0, "Run N should not create PRs for the new wave");

      const worktreesPath = path.join(stateDir, "worktrees.json");
      let worktreesN = { worktrees: [] };
      try {
        worktreesN = JSON.parse(await readFile(worktreesPath, "utf8"));
      } catch (e) {
        // worktrees.json might not exist if no worktrees were created
      }
      assert.equal(worktreesN.worktrees.length, 0);

      // --- RUN N+1 ---
      // Reset counters for the second run
      createWorktreeCalls = 0;
      createPullRequestCalls = 0;
      createdWorktreeCalls.length = 0;

      await runCli(["run", "--code-root", codeRoot], options);

      // Run N+1 assertions
      const workstreamsFileNPlus1 = JSON.parse(
        await readFile(path.join(stateDir, "workstreams.json"), "utf8")
      );
      const advancedWsNPlus1 = workstreamsFileNPlus1.workstreams.find(
        (w: WorkstreamStateRecord) => w.id === ws.id
      );
      assert.equal(advancedWsNPlus1.packetPlan.currentWaveIndex, 1);
      assert.equal(advancedWsNPlus1.packetPlan.packets.T2.status, "pr_open");
      assert.ok(advancedWsNPlus1.packetPlan.packets.T2.branchName);
      assert.equal(advancedWsNPlus1.packetPlan.packets.T2.prNumber, 200);
      assert.equal(createWorktreeCalls, 1, "Run N+1 should create a worktree for T2");
      assert.equal(createPullRequestCalls, 1, "Run N+1 should create a PR for T2");

      const worktreesNPlus1 = JSON.parse(await readFile(worktreesPath, "utf8"));
      assert.equal(worktreesNPlus1.worktrees.length, 1);
      const t2Worktree = worktreesNPlus1.worktrees[0];
      assert.equal(t2Worktree.packet.packetId, "T2");
      assert.equal(t2Worktree.packet.waveIndex, 1);
      assert.equal(t2Worktree.prNumber, 200);
      assert.equal(t2Worktree.packet.parentWorkstreamId, ws.id);

      for (const call of createdWorktreeCalls) {
        assert.ok(
          isUnder(tempDir, call.worktreePath) || isUnder(codeRoot, call.worktreePath),
          `Path ${call.worktreePath} is not under tempDir or codeRoot`
        );
        assert.ok(call.startPoint, "startPoint should be recorded");
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("failed packet PR publication persists the worktree for automatic retry", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    const worktreesPath = path.join(stateDir, "worktrees.json");
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      const ws = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        phase: "planning",
        packetPlan: {
          status: "proposed",
          packets: { T1: packet("T1", "planned") },
          waves: [["T1"]],
          currentWaveIndex: 0
        }
      });
      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [ws] }),
        "utf8"
      );

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: "owner/repo-one:issue:1",
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      let createWorktreeCalls = 0;
      let createPullRequestCalls = 0;
      const options = {
        managementDir,
        stateDir,
        gitGateway: createGitGatewayMock({
          createWorktree: async (
            _repoPath: string,
            _codeRoot: string,
            worktreePath: string
          ) => {
            createWorktreeCalls++;
            return worktreePath;
          }
        }),
        gitHubGateway: {
          findOpenPullRequestByHeadBranch: async () => undefined,
          createPullRequest: async () => {
            createPullRequestCalls++;
            if (createPullRequestCalls === 1) {
              throw new Error("simulated gh pr create failure");
            }
            return {
              id: "PR_T1",
              number: 201,
              url: "https://github.com/owner/repo-one/pull/201",
              state: "open",
              author: { login: "owner" }
            };
          }
        } as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      await assert.rejects(
        runCli(["run", "--code-root", codeRoot], options),
        /simulated gh pr create failure/
      );

      const afterFailure = JSON.parse(await readFile(worktreesPath, "utf8")).worktrees;
      assert.equal(afterFailure.length, 1);
      assert.equal(afterFailure[0].packet.packetId, "T1");
      assert.equal(afterFailure[0].prNumber, undefined);

      await runCli(["run", "--code-root", codeRoot], options);

      const afterRetry = JSON.parse(await readFile(worktreesPath, "utf8")).worktrees;
      assert.equal(createWorktreeCalls, 1, "retry should reuse the persisted packet worktree");
      assert.equal(createPullRequestCalls, 2);
      assert.equal(afterRetry[0].prNumber, 201);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("multi-wave advancement repeats and packet PR creation is idempotent", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    const workstreamsPath = path.join(stateDir, "workstreams.json");
    const worktreesPath = path.join(stateDir, "worktrees.json");

    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      const wsId = "owner/repo-one:issue:1";
      const initialWs = workstream(wsId, {
        repoKey: "repo-1",
        packetPlan: packetPlan({
          packets: {
            T1: packet("T1", "merged_to_parent"),
            T2: packet("T2", "planned"),
            T3: packet("T3", "planned")
          },
          waves: [["T1"], ["T2"], ["T3"]],
          currentWaveIndex: 0
        })
      });

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: wsId,
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      const runLabel = { current: "N" };
      const createdWorktreeCalls: Array<{
        run: string;
        worktreePath: string;
        branchName: string;
        startPoint: string;
      }> = [];
      const createdPullRequestCalls: Array<{
        run: string;
        headBranch: string;
      }> = [];

      const gitGateway = createGitGatewayMock({
        createWorktree: async (
          _repoPath: string,
          _codeRoot: string,
          worktreePath: string,
          branchName: string,
          startPoint: string
        ) => {
          createdWorktreeCalls.push({
            run: runLabel.current,
            worktreePath,
            branchName,
            startPoint
          });
          return worktreePath;
        }
      });

      const gitHubGateway = {
        findOpenPullRequestByHeadBranch: async () => undefined,
        createPullRequest: async (params: { headBranch: string }) => {
          createdPullRequestCalls.push({ run: runLabel.current, headBranch: params.headBranch });
          const headBranchLower = params.headBranch.toLowerCase();
          const prNumber = headBranchLower.includes("t2") ? 200 : 201;
          return {
            id: `PR_${prNumber}`,
            number: prNumber,
            url: `https://github.com/owner/repo-one/pull/${prNumber}`,
            state: "open",
            author: { login: "owner" }
          };
        }
      };

      const options = {
        managementDir,
        stateDir,
        gitGateway,
        gitHubGateway: gitHubGateway as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      // Helpers
      const readWorkstreams = async () => JSON.parse(await readFile(workstreamsPath, "utf8")).workstreams;
      const writeWorkstreams = async (workstreams: any[]) =>
        await writeFile(workstreamsPath, JSON.stringify({ workstreams }, null, 2), "utf8");
      const findWorkstream = (workstreams: any[], id: string) => workstreams.find((w) => w.id === id);
      const readWorktrees = async () => {
        try {
          return JSON.parse(await readFile(worktreesPath, "utf8")).worktrees;
        } catch {
          return [];
        }
      };
      const assertOnePacketWorktree = (
        worktrees: any[],
        packetId: string,
        waveIndex: number,
        prNumber?: number
      ) => {
        const matches = worktrees.filter(
          (wt) => wt.packet.packetId === packetId && wt.packet.parentWorkstreamId === wsId
        );
        assert.equal(matches.length, 1, `Expected exactly one worktree for ${packetId}`);
        assert.equal(matches[0].packet.waveIndex, waveIndex);
        if (prNumber !== undefined) {
          assert.equal(matches[0].prNumber, prNumber);
        }
      };
      const callsForRun = (calls: any[], run: string) => calls.filter((c) => c.run === run);

      // --- INITIAL STATE ---
      await writeWorkstreams([initialWs]);

      // --- RUN N: Advance 0 -> 1 ---
      runLabel.current = "N";
      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsN = await readWorkstreams();
      const wsN = findWorkstream(workstreamsN, wsId);
      assert.equal(wsN.packetPlan.currentWaveIndex, 1);
      assert.equal(wsN.packetPlan.packets.T2.status, "planned");
      assert.equal(wsN.packetPlan.packets.T2.branchName, undefined);
      assert.equal(callsForRun(createdWorktreeCalls, "N").length, 0);
      assert.equal(callsForRun(createdPullRequestCalls, "N").length, 0);
      assert.equal((await readWorktrees()).length, 0);

      // --- RUN N+1: Create Wave 1 Packet PR (T2) ---
      runLabel.current = "N+1";
      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsN1 = await readWorkstreams();
      const wsN1 = findWorkstream(workstreamsN1, wsId);
      assert.equal(wsN1.packetPlan.currentWaveIndex, 1);
      assert.equal(wsN1.packetPlan.packets.T2.status, "pr_open");
      assert.ok(wsN1.packetPlan.packets.T2.branchName);
      assert.equal(wsN1.packetPlan.packets.T2.prNumber, 200);

      const worktreesN1 = await readWorktrees();
      assertOnePacketWorktree(worktreesN1, "T2", 1, 200);
      assert.equal(callsForRun(createdWorktreeCalls, "N+1").length, 1);
      assert.equal(callsForRun(createdPullRequestCalls, "N+1").length, 1);

      // --- SIMULATE WAVE 1 COMPLETION ---
      wsN1.packetPlan.packets.T2.status = "merged_to_parent";
      wsN1.packetPlan.waveAssessments = [
        ...(wsN1.packetPlan.waveAssessments ?? []),
        waveAssessment(preflightForWorkstream(wsN1))
      ];
      await writeWorkstreams(workstreamsN1);

      // --- RUN N+2: Advance 1 -> 2 ---
      runLabel.current = "N+2";
      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsN2 = await readWorkstreams();
      const wsN2 = findWorkstream(workstreamsN2, wsId);
      assert.equal(wsN2.packetPlan.currentWaveIndex, 2);
      assert.equal(wsN2.packetPlan.packets.T2.status, "merged_to_parent");
      assert.equal(wsN2.packetPlan.packets.T3.status, "planned");
      assert.equal(wsN2.packetPlan.packets.T3.branchName, undefined);
      assert.equal(callsForRun(createdWorktreeCalls, "N+2").length, 0);
      assert.equal(callsForRun(createdPullRequestCalls, "N+2").length, 0);

      const worktreesN2 = await readWorktrees();
      assert.equal(worktreesN2.length, 1);
      assertOnePacketWorktree(worktreesN2, "T2", 1, 200);

      // --- RUN N+3: Create Wave 2 Packet PR (T3) ---
      runLabel.current = "N+3";
      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsN3 = await readWorkstreams();
      const wsN3 = findWorkstream(workstreamsN3, wsId);
      assert.equal(wsN3.packetPlan.currentWaveIndex, 2);
      assert.equal(wsN3.packetPlan.packets.T3.status, "pr_open");
      assert.ok(wsN3.packetPlan.packets.T3.branchName);
      assert.equal(wsN3.packetPlan.packets.T3.prNumber, 201);

      const worktreesN3 = await readWorktrees();
      assert.equal(worktreesN3.length, 2);
      assertOnePacketWorktree(worktreesN3, "T2", 1, 200);
      assertOnePacketWorktree(worktreesN3, "T3", 2, 201);
      assert.equal(callsForRun(createdWorktreeCalls, "N+3").length, 1);
      assert.equal(callsForRun(createdPullRequestCalls, "N+3").length, 1);

      // --- RUN N+4: Idempotency check ---
      runLabel.current = "N+4";
      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsN4 = await readWorkstreams();
      const wsN4 = findWorkstream(workstreamsN4, wsId);
      assert.deepEqual(wsN4.packetPlan, wsN3.packetPlan);
      assert.equal(callsForRun(createdWorktreeCalls, "N+4").length, 0);
      assert.equal(callsForRun(createdPullRequestCalls, "N+4").length, 0);

      const worktreesN4 = await readWorktrees();
      assert.equal(worktreesN4.length, 2);
      assertOnePacketWorktree(worktreesN4, "T2", 1, 200);
      assertOnePacketWorktree(worktreesN4, "T3", 2, 201);

      for (const call of createdWorktreeCalls) {
        assert.ok(
          isUnder(tempDir, call.worktreePath) || isUnder(codeRoot, call.worktreePath),
          `Worktree path ${call.worktreePath} is not under tempDir or codeRoot`
        );
        assert.ok(call.startPoint, "startPoint should be recorded");
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("Run-level unauthorized sync (missing label) derives preflight but does not execute sync", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      // Workstream needing sync
      const ws = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        packetPlan: packetPlan({
          packets: { T1: packet("T1", "merged_to_parent"), T2: packet("T2", "planned") },
          waves: [["T1"], ["T2"]],
          currentWaveIndex: 0
        })
      });
      setLatestAssessmentCurrentIdentity(ws, "abc");
      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [ws] }),
        "utf8"
      );

      // Parent PR WITHOUT the sync label
      const parentPr = {
        kind: "pull_request" as const,
        id: "pull_request:owner/repo-one:100",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 100,
        key: "owner/repo-one:pull_request:100",
        sourceId: "PR100",
        url: "https://github.com/owner/repo-one/pull/100",
        title: "Parent PR",
        body: "Body",
        labels: [], // Missing "agent-sync-parent-branch"
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const,
        headBranch: "agent/owner-repo/owner-repo-one-issue-1",
        headSha: "abc",
        baseBranch: "main",
        defaultBranch: "main",
        baseClassification: "top_level" as const,
        isDraft: false
      };

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: "owner/repo-one:issue:1",
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      let syncCalled = false;
      const options = {
        managementDir,
        stateDir,
        gitGateway: createGitGatewayMock({
          compareBranchSyncStatus: async () => branchComparison("behind_default")
        }),
        gitHubGateway: createGitHubGatewayMock() as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [parentPr],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        parentBranchSyncService: {
          async syncParentBranch() {
            syncCalled = true;
            return { status: "success", message: "ok" } as any;
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      await runCli(["run", "--code-root", codeRoot], options);

      assert.equal(syncCalled, false, "Sync should not be called without label");

      const rawTasksJson = await readFile(path.join(stateDir, "tasks.json"), "utf8");
      assert.ok(rawTasksJson.includes('\n  "'), "tasks.json should remain pretty-printed");
      const tasksFile = JSON.parse(rawTasksJson);
      const preflightTask = tasksFile.tasks.find((t: any) => t.kind === "sync_parent_branch_preflight");
      const syncTask = tasksFile.tasks.find((t: any) => t.kind === "sync_parent_branch");

      assert.ok(preflightTask, "Preflight task should be derived");
      assert.ok(!syncTask, "Sync task should NOT be derived without label");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("Run-level authorized sync (with label) executes sync, posts feedback, and defers wave advancement", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      // Workstream needing sync
      const ws = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        packetPlan: packetPlan({
          packets: { T1: packet("T1", "merged_to_parent"), T2: packet("T2", "planned") },
          waves: [["T1"], ["T2"]],
          currentWaveIndex: 0
        })
      });
      setLatestAssessmentCurrentIdentity(ws, "abc");
      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [ws] }),
        "utf8"
      );

      // Parent PR WITH the sync label
      const parentPr = {
        kind: "pull_request" as const,
        id: "pull_request:owner/repo-one:100",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 100,
        key: "owner/repo-one:pull_request:100",
        sourceId: "PR100",
        url: "https://github.com/owner/repo-one/pull/100",
        title: "Parent PR",
        body: "Body",
        labels: ["agent-sync-parent-branch"],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const,
        headBranch: "agent/owner-repo/owner-repo-one-issue-1",
        headSha: "abc",
        baseBranch: "main",
        defaultBranch: "main",
        baseClassification: "top_level" as const,
        isDraft: false
      };

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: "owner/repo-one:issue:1",
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      let syncCalled = false;
      let feedbackBody = "";
      const comparisonStatuses: BranchSyncComparison["status"][] = [
        "behind_default",
        "up_to_date",
        "up_to_date",
        "up_to_date"
      ];
      const options = {
        managementDir,
        stateDir,
        gitGateway: createGitGatewayMock({
          compareBranchSyncStatus: async () =>
            branchComparison(comparisonStatuses.shift() ?? "up_to_date")
        }),
        gitHubGateway: {
          ...createGitHubGatewayMock(),
          listPullRequestComments: async () => [],
          postIssueComment: async (input: any) => {
            if (input.body.includes("Parent Branch Sync Attempt")) {
              feedbackBody = input.body;
            }
          }
        } as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [parentPr],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch() {
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        parentBranchSyncService: {
          async syncParentBranch() {
            syncCalled = true;
            return { status: "synced", message: "Successfully synced" } as any;
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      await runCli(["run", "--code-root", codeRoot], options);

      let rawTasksJson = await readFile(path.join(stateDir, "tasks.json"), "utf8");
      assert.ok(rawTasksJson.includes('\n  "'), "tasks.json should remain pretty-printed");
      let tasksFile = JSON.parse(rawTasksJson);
      let syncTask = tasksFile.tasks.find((t: any) => t.kind === "sync_parent_branch");
      if (syncTask?.status === "failed") {
        const execsFile = JSON.parse(await readFile(path.join(stateDir, "executions.json"), "utf8"));
        const lastExec = execsFile.executions.find((e: any) => e.id === syncTask.lastExecutionId);
        assert.fail(`Sync Task Failed. Error: ${lastExec?.errorMessage}. Context: ${JSON.stringify(syncTask.context, null, 2)}`);
      }

      assert.equal(syncCalled, true, "Sync should be called with label");
      assert.ok(feedbackBody.includes("Parent Branch Sync Attempt"), "Feedback should be posted to PR");
      assert.ok(feedbackBody.includes("behind_default"), "Feedback should report the pre-sync comparison");
      assert.ok(feedbackBody.includes("up_to_date"), "Feedback should report the refreshed comparison");

      rawTasksJson = await readFile(path.join(stateDir, "tasks.json"), "utf8");
      assert.ok(rawTasksJson.includes('\n  "'), "tasks.json should remain pretty-printed after sync");
      tasksFile = JSON.parse(rawTasksJson);
      syncTask = tasksFile.tasks.find((t: any) => t.kind === "sync_parent_branch");
      assert.ok(syncTask, "Sync task should be derived");
      assert.equal(syncTask.status, "completed", "Sync task should be completed");

      const workstreamsFile = JSON.parse(
        await readFile(path.join(stateDir, "workstreams.json"), "utf8")
      );
      const updatedWorkstream = workstreamsFile.workstreams.find((w: any) => w.id === ws.id);
      assert.equal(
        updatedWorkstream.packetPlan.currentWaveIndex,
        0,
        "Wave advancement should wait for a later scan after parent sync refreshes PR metadata"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("Run-level authorized sync conflict reports failure and keeps packet wave blocked", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      await writeManagementConfig(managementDir, [repo]);

      const ws = workstream("owner/repo-one:issue:1", {
        repoKey: "repo-1",
        packetPlan: packetPlan({
          packets: { T1: packet("T1", "merged_to_parent"), T2: packet("T2", "planned") },
          waves: [["T1"], ["T2"]],
          currentWaveIndex: 0
        })
      });
      setLatestAssessmentCurrentIdentity(ws, "abc");
      await writeFile(
        path.join(stateDir, "workstreams.json"),
        JSON.stringify({ workstreams: [ws] }, null, 2),
        "utf8"
      );

      const parentPr = {
        kind: "pull_request" as const,
        id: "pull_request:owner/repo-one:100",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 100,
        key: "owner/repo-one:pull_request:100",
        sourceId: "PR100",
        url: "https://github.com/owner/repo-one/pull/100",
        title: "Parent PR",
        body: "Body",
        labels: ["agent-sync-parent-branch"],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const,
        headBranch: "agent/owner-repo/owner-repo-one-issue-1",
        headSha: "abc",
        baseBranch: "main",
        defaultBranch: "main",
        baseClassification: "top_level" as const,
        isDraft: false
      };

      const issue = {
        kind: "issue" as const,
        id: "issue:owner/repo-one:1",
        repoId: "repo-1",
        repoKey: "owner/repo-one",
        repoOwner: "owner",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        number: 1,
        key: "owner/repo-one:issue:1",
        sourceId: "I1",
        url: "https://github.com/owner/repo-one/issues/1",
        title: "Issue 1",
        body: "Body",
        labels: [],
        author: "owner",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        state: "open" as const
      };

      let syncCalled = false;
      let feedbackBody = "";
      const options = {
        managementDir,
        stateDir,
        gitGateway: createGitGatewayMock({
          compareBranchSyncStatus: async () => branchComparison("diverged")
        }),
        gitHubGateway: {
          ...createGitHubGatewayMock(),
          listPullRequestComments: async () => [],
          postIssueComment: async (input: any) => {
            if (input.body.includes("Parent Branch Sync Attempt")) {
              feedbackBody = input.body;
            }
          }
        } as any,
        syncService: {
          async syncRepository(): Promise<RepoSyncRecord> {
            return createRepoResult("repo-1", "repo-one", codeRoot);
          }
        },
        scanService: {
          async scanRepositories(): Promise<any> {
            return {
              issues: [issue],
              prs: [parentPr],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot)],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch(task: any) {
            assert.notEqual(task.kind, "sync_parent_branch", "Sync action must not be agent-dispatched");
            return { taskStatus: "completed" as const, execution: {} as any };
          }
        },
        parentBranchSyncService: {
          async syncParentBranch() {
            syncCalled = true;
            return {
              status: "conflict",
              message: "Merge conflict occurred while syncing parent branch; merge aborted."
            } as any;
          }
        },
        logger: { info: () => undefined, warn: () => undefined }
      };

      await runCli(["run", "--code-root", codeRoot], options);

      assert.equal(syncCalled, true, "Conflict-aware sync should be attempted when label is present");
      assert.ok(feedbackBody.startsWith("🤖"), "Feedback should be robot-prefixed");
      assert.ok(feedbackBody.includes("conflict"), "Feedback should report the conflict");
      assert.ok(
        feedbackBody.includes("Wave advancement remains blocked"),
        "Feedback should explain that advancement remains blocked"
      );

      const rawTasksJson = await readFile(path.join(stateDir, "tasks.json"), "utf8");
      assert.ok(rawTasksJson.includes('\n  "'), "tasks.json should remain pretty-printed");
      const tasksFile = JSON.parse(rawTasksJson);
      const syncTask = tasksFile.tasks.find((t: any) => t.kind === "sync_parent_branch");
      assert.ok(syncTask, "Sync task should be derived");
      assert.equal(syncTask.status, "failed", "Conflict result should fail the sync action task");

      const rawExecutionsJson = await readFile(path.join(stateDir, "executions.json"), "utf8");
      assert.ok(rawExecutionsJson.includes('\n  "'), "executions.json should remain pretty-printed");
      const executionsFile = JSON.parse(rawExecutionsJson);
      const syncExecution = executionsFile.executions.find((e: any) => e.id === syncTask.lastExecutionId);
      assert.equal(syncExecution.taskStatus, "failed");
      assert.equal(syncExecution.result.parentBranchSync.status, "conflict");

      const workstreamsFile = JSON.parse(
        await readFile(path.join(stateDir, "workstreams.json"), "utf8")
      );
      const updatedWorkstream = workstreamsFile.workstreams.find((w: any) => w.id === ws.id);
      assert.equal(
        updatedWorkstream.packetPlan.currentWaveIndex,
        0,
        "Diverged conflict must not advance the packet wave"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
