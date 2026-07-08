import { describe, it, test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "../src/cli/run.js";
import type {
  ExecutionRecord,
  PlanBreakdownResult,
  RepoSyncRecord,
  TaskRecord,
  WorkstreamRecord
} from "../src/state/types.js";
import type { RepoConfig } from "../src/config/types.js";

describe("runCli plan_breakdown integration", () => {
  async function setup() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-breakdown-run-"));
    const managementDir = path.join(tempDir, "management");
    const stateDir = path.join(managementDir, "state");
    const codeRoot = path.join(tempDir, "code-root");

    await mkdir(stateDir, { recursive: true });

    return { tempDir, managementDir, stateDir, codeRoot };
  }

  async function writeManagementConfig(
    managementDir: string,
    repos: RepoConfig[],
    agents: any[] = []
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

  const validBreakdown: PlanBreakdownResult = {
    title: "Test Plan",
    summary: "This is a test plan.",
    tasks: [
      {
        id: "T1",
        title: "Task 1",
        description: "Desc 1",
        dependsOn: [],
        blocks: [],
        canRunInParallelWith: [],
        risk: "low",
        filesLikelyInvolved: ["src/file1.ts"],
        acceptanceCriteria: ["Criteria 1"],
        verification: ["Verify 1"]
      }
    ],
    waves: [
      {
        id: "W1",
        taskIds: ["T1"],
        rationale: "Wave 1 rationale"
      }
    ],
    recommendedFirstWaveId: "W1",
    graphConcerns: [],
    humanDecisionsNeeded: [],
    suggestedNextAction: "Next action"
  };

  const wsId = "owner/repo-one:issue:1";

  const existingPacketPlan = {
    status: "approved" as const,
    packets: {
      OLD: {
        id: "OLD",
        title: "Old Task",
        summary: "Old Summary",
        acceptanceCriteria: [],
        filesLikelyTouched: [],
        dependsOn: [],
        canRunInParallelWith: [],
        blocks: [],
        status: "planned" as const
      }
    },
    waves: [["OLD"]],
    currentWaveIndex: 0,
    source: {
      kind: "plan_breakdown_result" as const,
      workstreamId: wsId,
      generatedAt: new Date(Date.now() - 10000).toISOString()
    }
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
    key: wsId,
    sourceId: "I1",
    url: "https://github.com/owner/repo-one/issues/1",
    title: "Issue 1",
    body: "Body",
    labels: ["plan-breakdown-needed"],
    author: "owner",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    state: "open" as const
  };

  function createDefaultOptions(
    codeRoot: string,
    agentRunnerMock?: any
  ) {
    return {
      gitGateway: {
        resetHard: async () => {},
        cleanUntrackedFiles: async () => {},
        compareBranchSyncStatus: async () => ({
          status: "up_to_date" as const,
          parentBranch: "parent",
          defaultBranch: "main",
          parentRef: "ref1",
          defaultRef: "ref2",
          message: "ok"
        }),
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
        cloneRepository: async () => {},
        fetchRepository: async () => {},
        isInsideWorkingTree: async () => true,
        pullFastForwardOnly: async () => {},
        getHeadCommitSha: async () => "abc123456789",
        checkoutBranch: async () => {},
        mergeRemoteBranch: async () => {},
        abortMerge: async () => {},
        abortRebase: async () => {},
        abortCherryPick: async () => {},
        abortRevert: async () => {},
        listWorktrees: async () => [],
        getWorktreeForBranch: async () => null,
        cloneRepositoryFromUrl: async () => {},
        checkoutBranchAtRemote: async () => {},
        getAheadBehindVsRemote: async () => ({ ahead: 0, behind: 0 }),
        isAncestorOf: async () => true,
        countCommitsAheadOf: async () => 0,
        getActiveMergeState: async () => "none" as const,
        pushWithLease: async () => {},
        removeDirectory: async () => {},
        getCommitLogSince: async () => "",
        getDiffStatSince: async () => ""
        },
      gitHubGateway: {
        findOpenPullRequestByHeadBranch: async () => undefined,
        createPullRequest: async () => ({ id: "PR1", number: 101, url: "url", state: "open", author: { login: "owner" } }),
        postIssueComment: async () => ({ id: 1 })
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
      agentRunner: agentRunnerMock || {
        async dispatch() {
          throw new Error("agentRunner.dispatch not implemented in mock");
        }
      },
      logger: { info: () => undefined, warn: () => undefined }
    };
  }

  test("exported breakdown result is applied to workstream in the same run", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      const agent = {
        id: "agent-1",
        provider: "codex",
        modelClass: "strong",
        roles: ["implementation_manager"],
        command: "echo",
        enabled: true
      };
      await writeManagementConfig(managementDir, [repo], [agent]);

      const ws: WorkstreamRecord = {
        id: wsId,
        repoKey: "repo-1",
        origin: { type: "issue", number: 1 },
        linkedIssueNumber: 1,
        linkedPrs: [],
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved"
      };

      const task: TaskRecord = {
        id: "task:plan_breakdown:issue:owner/repo-one:1",
        kind: "plan_breakdown",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: {
          expectsPushableHandoff: true,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        repoId: "repo-1",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        sourceKind: "issue",
        sourceId: "issue:owner/repo-one:1",
        sourceUrl: "https://github.com/owner/repo-one/issues/1",
        relevant: true,
        reason: "needed",
        summary: "plan",
        context: {
          repoIdentifier: "owner/repo-one",
          labels: ["plan-breakdown-needed"],
          instruction: "plan"
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await writeFile(path.join(stateDir, "workstreams.json"), JSON.stringify({ workstreams: [ws] }), "utf8");
      await writeFile(path.join(stateDir, "tasks.json"), JSON.stringify({ tasks: [task] }), "utf8");

      const agentRunnerMock = {
        async dispatch(task: TaskRecord) {
          return {
            taskStatus: "completed" as const,
            execution: {
              id: "exec-1",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "agent-1",
              agentProvider: "codex",
              command: { executable: "echo", args: [], cwd: "/tmp", timeoutMs: 1000 },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              exitCode: 0,
              result: {
                planBreakdown: validBreakdown
              }
            } as ExecutionRecord
          };
        }
      };

      const options = {
        managementDir,
        stateDir,
        ...createDefaultOptions(codeRoot, agentRunnerMock)
      };

      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsFile = JSON.parse(await readFile(path.join(stateDir, "workstreams.json"), "utf8"));
      const updatedWs = workstreamsFile.workstreams.find((w: any) => w.id === wsId);

      assert.ok(updatedWs.packetPlan, "Packet plan should be applied");
      assert.equal(updatedWs.packetPlan.status, "proposed");
      assert.ok(updatedWs.packetPlan.packets.T1, "T1 should be present");
      assert.equal(updatedWs.packetPlan.source.kind, "plan_breakdown_result");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("failed plan_breakdown does not create or replace packetPlan", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      const agent = {
        id: "agent-1",
        provider: "codex",
        modelClass: "strong",
        roles: ["implementation_manager"],
        command: "echo",
        enabled: true
      };
      await writeManagementConfig(managementDir, [repo], [agent]);

      const ws: WorkstreamRecord = {
        id: wsId,
        repoKey: "repo-1",
        origin: { type: "issue", number: 1 },
        linkedIssueNumber: 1,
        linkedPrs: [],
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved"
      };

      const task: TaskRecord = {
        id: "task:plan_breakdown:issue:owner/repo-one:1",
        kind: "plan_breakdown",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: {
          expectsPushableHandoff: true,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        repoId: "repo-1",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        sourceKind: "issue",
        sourceId: "issue:owner/repo-one:1",
        sourceUrl: "https://github.com/owner/repo-one/issues/1",
        relevant: true,
        reason: "needed",
        summary: "plan",
        context: {
          repoIdentifier: "owner/repo-one",
          labels: ["plan-breakdown-needed"],
          instruction: "plan"
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await writeFile(path.join(stateDir, "workstreams.json"), JSON.stringify({ workstreams: [ws] }), "utf8");
      await writeFile(path.join(stateDir, "tasks.json"), JSON.stringify({ tasks: [task] }), "utf8");

      const agentRunnerMock = {
        async dispatch(task: TaskRecord) {
          return {
            taskStatus: "failed" as const,
            execution: {
              id: "exec-1",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "failed",
              errorMessage: "Simulated failure",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "agent-1",
              agentProvider: "codex",
              command: { executable: "echo", args: [], cwd: "/tmp", timeoutMs: 1000 },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              exitCode: 1
            } as ExecutionRecord
          };
        }
      };

      const options = {
        managementDir,
        stateDir,
        ...createDefaultOptions(codeRoot, agentRunnerMock)
      };

      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsFile = JSON.parse(await readFile(path.join(stateDir, "workstreams.json"), "utf8"));
      const updatedWs = workstreamsFile.workstreams.find((w: any) => w.id === wsId);

      assert.strictEqual(updatedWs.packetPlan, undefined, "Packet plan should not be created on failure");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("existing packetPlan is preserved if a newer plan_breakdown fails", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      const agent = {
        id: "agent-1",
        provider: "codex",
        modelClass: "strong",
        roles: ["implementation_manager"],
        command: "echo",
        enabled: true
      };
      await writeManagementConfig(managementDir, [repo], [agent]);

      const ws: WorkstreamRecord = {
        id: wsId,
        repoKey: "repo-1",
        origin: { type: "issue", number: 1 },
        linkedIssueNumber: 1,
        linkedPrs: [],
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved",
        packetPlan: existingPacketPlan
      };

      const task: TaskRecord = {
        id: "task:plan_breakdown:issue:owner/repo-one:1",
        kind: "plan_breakdown",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: {
          expectsPushableHandoff: true,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        repoId: "repo-1",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        sourceKind: "issue",
        sourceId: "issue:owner/repo-one:1",
        sourceUrl: "https://github.com/owner/repo-one/issues/1",
        relevant: true,
        reason: "needed",
        summary: "plan",
        context: {
          repoIdentifier: "owner/repo-one",
          labels: ["plan-breakdown-needed"],
          instruction: "plan"
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await writeFile(path.join(stateDir, "workstreams.json"), JSON.stringify({ workstreams: [ws] }), "utf8");
      await writeFile(path.join(stateDir, "tasks.json"), JSON.stringify({ tasks: [task] }), "utf8");

      const agentRunnerMock = {
        async dispatch(task: TaskRecord) {
          return {
            taskStatus: "failed" as const,
            execution: {
              id: "exec-1",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "failed",
              errorMessage: "Simulated failure",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "agent-1",
              agentProvider: "codex",
              command: { executable: "echo", args: [], cwd: "/tmp", timeoutMs: 1000 },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              exitCode: 1
            } as ExecutionRecord
          };
        }
      };

      const options = {
        managementDir,
        stateDir,
        ...createDefaultOptions(codeRoot, agentRunnerMock)
      };

      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsFile = JSON.parse(await readFile(path.join(stateDir, "workstreams.json"), "utf8"));
      const updatedWs = workstreamsFile.workstreams.find((w: any) => w.id === wsId);

      assert.deepEqual(updatedWs.packetPlan, existingPacketPlan, "Existing packet plan should be preserved on failure");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("existing packetPlan is preserved if a newer plan_breakdown completes with no result", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      const agent = {
        id: "agent-1",
        provider: "codex",
        modelClass: "strong",
        roles: ["implementation_manager"],
        command: "echo",
        enabled: true
      };
      await writeManagementConfig(managementDir, [repo], [agent]);

      const ws: WorkstreamRecord = {
        id: wsId,
        repoKey: "repo-1",
        origin: { type: "issue", number: 1 },
        linkedIssueNumber: 1,
        linkedPrs: [],
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved",
        packetPlan: existingPacketPlan
      };

      const task: TaskRecord = {
        id: "task:plan_breakdown:issue:owner/repo-one:1",
        kind: "plan_breakdown",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: {
          expectsPushableHandoff: true,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        repoId: "repo-1",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        sourceKind: "issue",
        sourceId: "issue:owner/repo-one:1",
        sourceUrl: "https://github.com/owner/repo-one/issues/1",
        relevant: true,
        reason: "needed",
        summary: "plan",
        context: {
          repoIdentifier: "owner/repo-one",
          labels: ["plan-breakdown-needed"],
          instruction: "plan"
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await writeFile(path.join(stateDir, "workstreams.json"), JSON.stringify({ workstreams: [ws] }), "utf8");
      await writeFile(path.join(stateDir, "tasks.json"), JSON.stringify({ tasks: [task] }), "utf8");

      const agentRunnerMock = {
        async dispatch(task: TaskRecord) {
          return {
            taskStatus: "completed" as const,
            execution: {
              id: "exec-1",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "agent-1",
              agentProvider: "codex",
              command: { executable: "echo", args: [], cwd: "/tmp", timeoutMs: 1000 },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              exitCode: 0,
              result: {} // No planBreakdown
            } as ExecutionRecord
          };
        }
      };

      const options = {
        managementDir,
        stateDir,
        ...createDefaultOptions(codeRoot, agentRunnerMock)
      };

      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsFile = JSON.parse(await readFile(path.join(stateDir, "workstreams.json"), "utf8"));
      const updatedWs = workstreamsFile.workstreams.find((w: any) => w.id === wsId);

      assert.deepEqual(updatedWs.packetPlan, existingPacketPlan, "Existing packet plan should be preserved if no result returned");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("existing packetPlan is preserved if a newer plan_breakdown result is invalid", async () => {
    const { tempDir, managementDir, stateDir, codeRoot } = await setup();
    try {
      const repo = baseRepoConfig("repo-1", "repo-one");
      const agent = {
        id: "agent-1",
        provider: "codex",
        modelClass: "strong",
        roles: ["implementation_manager"],
        command: "echo",
        enabled: true
      };
      await writeManagementConfig(managementDir, [repo], [agent]);

      const ws: WorkstreamRecord = {
        id: wsId,
        repoKey: "repo-1",
        origin: { type: "issue", number: 1 },
        linkedIssueNumber: 1,
        linkedPrs: [],
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved",
        packetPlan: existingPacketPlan
      };

      const task: TaskRecord = {
        id: "task:plan_breakdown:issue:owner/repo-one:1",
        kind: "plan_breakdown",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: {
          expectsPushableHandoff: true,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        repoId: "repo-1",
        repoName: "repo-one",
        repoSlug: "owner/repo-one",
        sourceKind: "issue",
        sourceId: "issue:owner/repo-one:1",
        sourceUrl: "https://github.com/owner/repo-one/issues/1",
        relevant: true,
        reason: "needed",
        summary: "plan",
        context: {
          repoIdentifier: "owner/repo-one",
          labels: ["plan-breakdown-needed"],
          instruction: "plan"
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await writeFile(path.join(stateDir, "workstreams.json"), JSON.stringify({ workstreams: [ws] }), "utf8");
      await writeFile(path.join(stateDir, "tasks.json"), JSON.stringify({ tasks: [task] }), "utf8");

      const invalidBreakdown: PlanBreakdownResult = {
        ...validBreakdown,
        waves: [{ id: "W1", taskIds: ["UNKNOWN"], rationale: "rationale" }] // references unknown task
      };

      const agentRunnerMock = {
        async dispatch(task: TaskRecord) {
          return {
            taskStatus: "completed" as const,
            execution: {
              id: "exec-1",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "agent-1",
              agentProvider: "codex",
              command: { executable: "echo", args: [], cwd: "/tmp", timeoutMs: 1000 },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              exitCode: 0,
              result: {
                planBreakdown: invalidBreakdown
              }
            } as ExecutionRecord
          };
        }
      };

      const options = {
        managementDir,
        stateDir,
        ...createDefaultOptions(codeRoot, agentRunnerMock)
      };

      await runCli(["run", "--code-root", codeRoot], options);

      const workstreamsFile = JSON.parse(await readFile(path.join(stateDir, "workstreams.json"), "utf8"));
      const updatedWs = workstreamsFile.workstreams.find((w: any) => w.id === wsId);

      assert.deepEqual(updatedWs.packetPlan, existingPacketPlan, "Existing packet plan should be preserved if newer result is invalid");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
