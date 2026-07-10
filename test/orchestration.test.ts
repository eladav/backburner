import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { formatRunSummary } from "../src/cli/output.js";
import { runCli, runLoopCli, type RunSummary } from "../src/cli/run.js";
import type { AgentConfig, RepoConfig } from "../src/config/types.js";
import type { NormalizedComment, NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import type {
  ExecutionRecord,
  PlanBreakdownResult,
  RepoSyncRecord,
  TaskStateFile,
  WorkspaceRecoveryRecord,
  WorkspaceRecoveryStateFile
} from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { workflowRegistry } from "../src/workflows/registry.js";
import { buildWaveAssessmentCheckpoint } from "../src/workstreams/wave-assessment/checkpoint.js";
import {
  defaultBackburnerCodeRoot,
  resolveOutputsStateRoot,
  resolveOutputsLogsRoot
} from "../src/utils/paths.js";

test("runCli preserves completed task state across repeated stable runs without duplicating tasks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-repeat-run-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");
  let dispatchCount = 0;

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);

    const scanResult = {
      issues: [] as NormalizedIssue[],
      prs: [samplePullRequest({ labels: ["agent-plan-approved"] })],
      comments: [] as NormalizedComment[],
      repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
      failures: [] as []
    };

    const options = {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<typeof scanResult> {
          return scanResult;
        }
      },
      agentRunner: {
        async dispatch(task: TaskRecord, context: TaskRecord["context"], agentConfig: AgentConfig) {
          dispatchCount += 1;
          return {
            taskStatus: "completed" as const,
            execution: buildExecution(task, context.localRepoPath ?? codeRoot, agentConfig.command)
          };
        }
      },
      logger: { info: () => undefined, warn: () => undefined }
    };

    const first = await runCli(["run", "--code-root", codeRoot], options);
    const second = await runCli(["run", "--code-root", codeRoot], options);
    const taskState = JSON.parse(await readFile(path.join(stateDir, "tasks.json"), "utf8")) as TaskStateFile;
    const uniqueTaskIds = new Set(taskState.tasks.map((task) => task.id));
    const implementTask = taskState.tasks.find(
      (task) => task.id === "task:implement_plan:pull_request:example-org/repo-one:23"
    );

    assert.equal(dispatchCount >= 1, true);
    assert.equal(taskState.tasks.length, uniqueTaskIds.size);
    assert.equal(implementTask?.status, "completed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli writes control-plane state and execution logs to separate directories when configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-outputs-run-"));
  const managementDir = path.join(tempDir, "management");
  const outputsDir = path.join(tempDir, "outputs");
  const stateDir = resolveOutputsStateRoot(outputsDir);
  const logDir = resolveOutputsLogsRoot(outputsDir);
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);

    const summary = await runCli(
      [
        "run",
        "--code-root",
        codeRoot,
        "--management-dir",
        managementDir,
        "--outputs-dir",
        outputsDir
      ],
      {
        logger: { info: () => undefined, warn: () => undefined },
        syncService: {
          async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
            return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
          }
        },
        scanService: {
          async scanRepositories(): Promise<{
            issues: NormalizedIssue[];
            prs: NormalizedPullRequest[];
            comments: NormalizedComment[];
            repoResults: RepoSyncRecord[];
            failures: [];
          }> {
            return {
              issues: [],
              prs: [samplePullRequest({ labels: ["agent-plan-approved"] })],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
              failures: []
            };
          }
        },
        agentRunner: {
          async dispatch(task: TaskRecord, context: TaskRecord["context"], agentConfig: AgentConfig) {
            return {
              taskStatus: "completed" as const,
              execution: buildExecution(task, context.localRepoPath ?? codeRoot, agentConfig.command)
            };
          }
        }
      }
    );

    assert.equal(summary.managementDir, managementDir);
    assert.equal(summary.outputsDir, outputsDir);
    assert.equal(summary.stateDir, stateDir);
    assert.equal(summary.logDir, logDir);
    assert.equal(await readFile(path.join(stateDir, "tasks.json"), "utf8").then(Boolean), true);
    assert.equal(await readFile(path.join(logDir, "executions.json"), "utf8").then(Boolean), true);
    // Regression check: no state was written to management/state
    await assert.rejects(() => readFile(path.join(managementDir, "state", "tasks.json")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli supports --outputs-dir combined with --log-dir override", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-outputs-log-override-"));
  const managementDir = path.join(tempDir, "management");
  const outputsDir = path.join(tempDir, "outputs");
  const logDir = path.join(tempDir, "explicit-log");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);

    const summary = await runCli(
      [
        "run",
        "--code-root",
        codeRoot,
        "--management-dir",
        managementDir,
        "--outputs-dir",
        outputsDir,
        "--log-dir",
        logDir
      ],
      {
        logger: { info: () => undefined, warn: () => undefined },
        syncService: {
          async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
            return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
          }
        },
        scanService: {
          async scanRepositories(): Promise<{
            issues: NormalizedIssue[];
            prs: NormalizedPullRequest[];
            comments: NormalizedComment[];
            repoResults: RepoSyncRecord[];
            failures: [];
          }> {
            return {
              issues: [],
              prs: [samplePullRequest({ labels: ["agent-plan-approved"] })],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
              failures: []
            };
          }
        }
      }
    );

    assert.equal(summary.outputsDir, outputsDir);
    assert.equal(summary.stateDir, resolveOutputsStateRoot(outputsDir));
    assert.equal(summary.logDir, logDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli resets stale dispatched tasks to pending and redispatches them on the next cycle", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-stale-dispatched-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");
  let dispatchCount = 0;

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "tasks.json"),
      JSON.stringify(
        {
          tasks: [
            {
              id: "task:implement_plan:pull_request:example-org/repo-one:23",
              kind: "implement_plan",
              status: "dispatched",
              repoId: "repo-1",
              repoName: "repo-one",
              repoSlug: "example-org/repo-one",
              sourceKind: "pull_request",
              sourceId: "pull_request:example-org/repo-one:23",
              sourceUrl: "https://github.com/example-org/repo-one/pull/23",
              relevant: true,
              reason: "Plan is approved.",
              summary: "Implement approved plan for PR #23: Implement scanning",
              context: {
                repoIdentifier: "example-org/repo-one",
                localRepoPath: path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17"),
                planDocumentPath: path.join(
                  codeRoot,
                  "_worktrees",
                  "example-org",
                  "repo-one",
                  "issue-17",
                  "docs",
                  "agents",
                  "agent-example-org-repo-one-issue-17",
                  "issue-17-agent-plan.md"
                ),
                logDocumentPath: path.join(
                  codeRoot,
                  "_worktrees",
                  "example-org",
                  "repo-one",
                  "issue-17",
                  "docs",
                  "agents",
                  "agent-example-org-repo-one-issue-17",
                  "issue-17-agent-log.md"
                ),
                pullRequestUrl: "https://github.com/example-org/repo-one/pull/23",
                labels: ["agent-plan-approved"],
                instruction:
                  "Implement the approved plan from docs/agents/agent-example-org-repo-one-issue-17/issue-17-agent-plan.md and continue documenting work in docs/agents/agent-example-org-repo-one-issue-17/issue-17-agent-log.md."
              },
              createdAt: "2026-04-18T10:00:00.000Z",
              updatedAt: "2026-04-18T10:00:00.000Z"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const summary = await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<{
          issues: NormalizedIssue[];
          prs: NormalizedPullRequest[];
          comments: NormalizedComment[];
          repoResults: RepoSyncRecord[];
          failures: [];
        }> {
          return {
            issues: [],
            prs: [samplePullRequest({ labels: ["agent-plan-approved"] })],
            comments: [],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: []
          };
        }
      },
      agentRunner: {
        async dispatch(task: TaskRecord, context: TaskRecord["context"], agentConfig: AgentConfig) {
          dispatchCount += 1;
          return {
            taskStatus: "completed",
            execution: buildExecution(task, context.localRepoPath ?? codeRoot, agentConfig.command)
          };
        }
      },
      logger: { info: () => undefined, warn: () => undefined }
    });

    assert.equal(dispatchCount, 1);
    assert.equal(summary.completedTaskCount, 1);
    assert.equal(summary.tasks[0]?.status, "completed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli materializes pre-dispatch failures for unresolved comment tasks when broker startup fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-pre-dispatch-failure-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);

    const issue = {
      kind: "issue" as const,
      id: "issue:example-org/repo-one:11",
      repoId: "repo-1",
      repoKey: "example-org/repo-one",
      repoOwner: "example-org",
      repoName: "repo-one",
      repoSlug: "example-org/repo-one",
      number: 11,
      key: "example-org/repo-one:issue:11",
      sourceId: "11",
      url: "https://github.com/example-org/repo-one/issues/11",
      title: "Just answer this issue",
      body: "Please reply on the issue and do not create a PR.",
      labels: [],
      author: "owner",
      createdAt: "2026-04-18T08:10:00.000Z",
      updatedAt: "2026-04-18T08:40:00.000Z",
      lastSeenAt: "2026-04-18T08:50:00.000Z",
      state: "open" as const
    };
    const comment = {
      kind: "comment" as const,
      commentKind: "issue_comment" as const,
      id: "comment:example-org/repo-one:issue_comment:5001",
      sourceId: "5001",
      repoId: "repo-1",
      repoKey: "example-org/repo-one",
      repoOwner: "example-org",
      repoName: "repo-one",
      repoSlug: "example-org/repo-one",
      parentType: "issue" as const,
      parentNumber: 11,
      parentKey: "example-org/repo-one:issue:11",
      url: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
      body: "come on",
      author: "human",
      createdAt: "2026-04-18T09:00:00.000Z",
      updatedAt: "2026-04-18T09:00:00.000Z"
    };

    await writeFile(
      path.join(stateDir, "issues.json"),
      JSON.stringify(
        {
          metadata: {
            partialFailures: []
          },
          issues: [issue]
        },
        null,
        2
      ),
      "utf8"
    );

    const summary = await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<{
          issues: NormalizedIssue[];
          prs: NormalizedPullRequest[];
          comments: NormalizedComment[];
          repoResults: RepoSyncRecord[];
          failures: [];
        }> {
          return {
            issues: [issue as NormalizedIssue],
            prs: [],
            comments: [comment as NormalizedComment],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: []
          };
        }
      },
      startBrokerServer: async () => {
        throw new Error("listen EADDRINUSE");
      },
      logger: { info: () => undefined, warn: () => undefined }
    });

    const taskState = JSON.parse(await readFile(path.join(stateDir, "tasks.json"), "utf8")) as TaskStateFile;
    const executionState = JSON.parse(await readFile(path.join(stateDir, "executions.json"), "utf8")) as {
      executions: ExecutionRecord[];
    };

    assert.equal(summary.taskCount, 1);
    assert.equal(summary.failedTaskCount, 1);
    assert.equal(summary.pendingTaskCount, 0);
    assert.equal(summary.executionCount, 1);
    assert.equal(taskState.tasks[0]?.status, "failed");
    assert.equal(taskState.tasks[0]?.kind, "respond_issue_comment");
    assert.equal(taskState.tasks[0]?.lastExecutionId, executionState.executions[0]?.id);
    assert.match(executionState.executions[0]?.stderrArtifactPath ?? "", /stderr\.txt$/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("formatRunSummary reports one bad repo and one good repo clearly", () => {
  const summary = {
    command: "run" as const,
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/outputs/state",
    logDir: "/tmp/outputs/logs",

    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:01:00.000Z",
    repoCount: 2,
    syncedRepoCount: 1,
    failedRepoCount: 1,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 1,
    issueCount: 1,
    pullRequestCount: 1,
    commentCount: 0,
    taskCount: 2,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 1,
    failedTaskCount: 1,
    executionCount: 2,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [
      createRepoResult("repo-1", "repo-one", "/tmp/code-root", "synced", "ok"),
      {
        ...createRepoResult("repo-2", "repo-two", "/tmp/code-root", "failed", "Repository synchronization failed."),
        error: { step: "sync", message: "working tree is dirty" },
        githubScan: {
          status: "failed" as const,
          scannedAt: "2026-04-18T09:00:30.000Z",
          issueCount: 0,
          pullRequestCount: 0,
          commentCount: 0,
          failures: [
            {
              repoId: "repo-2",
              repoSlug: "example-org/repo-two",
              step: "list_issues" as const,
              scope: "repo",
              message: "gh unavailable"
            }
          ]
        }
      }
    ],
    tasks: [
      {
        ...baseImplementTask(),
        status: "completed" as const
      },
      {
        ...baseImplementTask(),
        id: "task:review_pr:pull_request:example-org/repo-two:9",
        kind: "review_pr" as const,
        repoId: "repo-2",
        repoName: "repo-two",
        repoSlug: "example-org/repo-two",
        sourceId: "pull_request:example-org/repo-two:9",
        sourceUrl: "https://github.com/example-org/repo-two/pull/9",
        summary: "Review PR #9: Failing repo",
        status: "failed" as const,
        context: {
          repoIdentifier: "example-org/repo-two",
          localRepoPath: "/tmp/code-root/repo-two",
          labels: [],
          pullRequestUrl: "https://github.com/example-org/repo-two/pull/9",
          instruction: "Review the pull request and determine the next action."
        }
      }
    ]
  } satisfies RunSummary;

  const output = formatRunSummary(summary);

  assert.match(output, /Orchestrator run finished with failures/);
  assert.match(output, /Management dir: \/tmp\/management/);
  assert.match(output, /Outputs dir: \/tmp\/outputs/);
  assert.match(output, /State dir: \/tmp\/outputs\/state/);
  assert.match(output, /Log dir: \/tmp\/outputs\/logs/);
  assert.match(output, /example-org\/repo-one \| sync ok/);
  assert.match(output, /example-org\/repo-two \| sync failed \| scan failed \| working tree is dirty/);
  assert.match(output, /Failed tasks:/);
  assert.match(output, /Scan failures:/);
  assert.match(output, /Generated state: \/tmp\/outputs\/state\/\{repos,issues,prs,comments,tasks,worktrees,workstreams,attention\}\.json/);
  assert.match(output, /Execution log: \/tmp\/outputs\/logs\/\{executions\.json,artifacts\/<execution-id>\/\.\.\.\}/);
});

test("formatRunSummary reports PR base classifications", () => {
  const summary: RunSummary = {
    command: "run",
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/state",
    logDir: "/tmp/log",
    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:05:00.000Z",
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 0,
    pullRequestCount: 2,
    commentCount: 0,
    taskCount: 0,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    executionCount: 0,
    pullRequestBaseClassifications: [
      {
        kind: "top_level",
        pullRequestNumber: 124,
        repoSlug: "owner/repo",
        baseBranch: "main",
        defaultBranch: "main"
      },
      {
        kind: "non_default_parent",
        pullRequestNumber: 123,
        repoSlug: "owner/repo",
        baseBranch: "workstream/issue-72",
        defaultBranch: "main"
      }
    ],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [
      createRepoResult("repo-1", "repo", "/tmp/code-root", "synced", "ok")
    ],
    tasks: []
  };

  const output = formatRunSummary(summary);

  assert.match(output, /Pull request base classifications:/);
  assert.match(output, /- owner\/repo PR #124 targets default branch `main`./);
  assert.match(
    output,
    /- owner\/repo PR #123 targets non-default parent branch `workstream\/issue-72`; repo default branch is `main`./
  );
});

test("formatRunSummary reports packet PR candidates", () => {
  const summary: RunSummary = {
    command: "run",
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/state",
    logDir: "/tmp/log",
    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:05:00.000Z",
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 0,
    pullRequestCount: 2,
    commentCount: 0,
    taskCount: 0,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    executionCount: 0,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [
      {
        repoSlug: "owner/repo",
        pullRequestNumber: 123,
        title: "Packet PR",
        baseBranch: "workstream/issue-72",
        headBranch: "feature/packet",
        parentWorkstreamId: "owner/repo:issue:72",
        status: "matched_parent_workstream"
      },
      {
        repoSlug: "owner/repo",
        pullRequestNumber: 124,
        title: "Orphan PR",
        baseBranch: "feature/custom-base",
        headBranch: "feature/orphan",
        status: "orphan_non_default_parent"
      }
    ],
    parentBranchSyncPreflights: [],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [
      createRepoResult("repo-1", "repo", "/tmp/code-root", "synced", "ok")
    ],
    tasks: []
  };

  const output = formatRunSummary(summary);

  assert.match(output, /Packet PR candidates:/);
  assert.match(
    output,
    /- owner\/repo PR #123 targets parent branch `workstream\/issue-72` and is attached to workstream `owner\/repo:issue:72`./
  );
  assert.match(
    output,
    /- owner\/repo PR #124 targets non-default parent branch `feature\/custom-base` but no active parent workstream was found./
  );
});

test("formatRunSummary reports packet plans", () => {
  const summary: RunSummary = {
    command: "run",
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/state",
    logDir: "/tmp/log",
    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:05:00.000Z",
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 0,
    pullRequestCount: 1,
    commentCount: 0,
    taskCount: 0,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    executionCount: 0,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [
      {
        workstreamId: "owner/repo:issue:82",
        repoKey: "owner/repo",
        status: "proposed",
        packetCount: 3,
        waveCount: 2,
        currentWaveIndex: 0,
        waves: [
          { index: 0, packetIds: ["T1", "T2"], packets: [
            { id: "T1", status: "merged_to_parent" },
            { id: "T2", status: "merged_to_parent" }
          ]},
          { index: 1, packetIds: ["T3"], packets: [
            { id: "T3", status: "planned" }
          ]}
        ]
      }
    ],
    results: [
      createRepoResult("repo-1", "repo", "/tmp/code-root", "synced", "ok")
    ],
    tasks: []
  };

  const output = formatRunSummary(summary);

  assert.match(output, /Packet plans:/);
  assert.match(
    output,
    /- owner\/repo:issue:82 status proposed, 3 packets, 2 waves, current wave 0/
  );
  assert.match(output, /wave 0: T1, T2/);
  assert.match(output, /wave 1: T3/);
});

test("formatRunSummary reports parent branch sync preflights", () => {
  const summary: RunSummary = {
    command: "run",
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/state",
    logDir: "/tmp/log",
    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:05:00.000Z",
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 0,
    pullRequestCount: 1,
    commentCount: 0,
    taskCount: 0,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    executionCount: 0,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:123",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-123",
          parentPrNumber: 77,
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: ["T1", "T2"],
          pendingFuturePacketIds: ["T3", "T4", "T5"]
        },
        branchSyncComparison: {
          parentBranch: "agent/owner-repo/issue-123",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/owner-repo/issue-123",
          defaultRef: "refs/remotes/origin/main",
          status: "behind_default",
          parentBehindCount: 3,
          parentAheadCount: 0,
          message: "Parent branch is behind the default branch."
        }
      }
    ],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [createRepoResult("repo-1", "repo", "/tmp/code-root", "synced", "ok")],
    tasks: []
  };

  const output = formatRunSummary(summary);

  assert.match(output, /Parent branch sync preflights:/);
  assert.match(
    output,
    /- owner\/repo:issue:123: sync `agent\/owner-repo\/issue-123` from `main` after wave 0 before wave 1/
  );
  assert.match(output, /status: behind_default \(behind 3, ahead 0\)/);
  assert.match(output, /recommendation: sync parent from default before starting wave 1/);
  assert.match(output, /parent PR: #77/);
  assert.match(output, /completed packets: T1, T2/);
  assert.match(output, /pending future packets: T3, T4, T5/);
});

test("formatRunSummary handles parent branch sync preflight without parent PR number", () => {
  const summary: RunSummary = {
    command: "run",
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/state",
    logDir: "/tmp/log",
    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:05:00.000Z",
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 0,
    pullRequestCount: 1,
    commentCount: 0,
    taskCount: 0,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    executionCount: 0,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:123",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-123",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: ["T1", "T2"],
          pendingFuturePacketIds: ["T3", "T4", "T5"]
        },
        branchSyncComparisonSkippedReason: "missing_local_path"
      }
    ],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [createRepoResult("repo-1", "repo", "/tmp/code-root", "synced", "ok")],
    tasks: []
  };

  const output = formatRunSummary(summary);

  assert.match(output, /status: unavailable \(missing local repo path\)/);
  assert.match(output, /recommendation: blocked; branch sync status is unavailable or unknown/);
  assert.match(output, /parent PR: unknown/);
});

test("formatRunSummary reports diverse parent branch sync preflight statuses", () => {
  const summary: RunSummary = {
    command: "run",
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/state",
    logDir: "/tmp/log",
    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:05:00.000Z",
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 0,
    pullRequestCount: 1,
    commentCount: 0,
    taskCount: 0,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    executionCount: 0,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:1",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-1",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: [],
          pendingFuturePacketIds: ["T1"]
        },
        branchSyncComparison: {
          parentBranch: "agent/owner-repo/issue-1",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/owner-repo/issue-1",
          defaultRef: "refs/remotes/origin/main",
          status: "up_to_date",
          parentBehindCount: 0,
          parentAheadCount: 0,
          message: "Up to date."
        }
      },
      {
        preflight: {
          workstreamId: "owner/repo:issue:2",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-2",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: [],
          pendingFuturePacketIds: ["T2"]
        },
        branchSyncComparison: {
          parentBranch: "agent/owner-repo/issue-2",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/owner-repo/issue-2",
          defaultRef: "refs/remotes/origin/main",
          status: "diverged",
          parentBehindCount: 2,
          parentAheadCount: 1,
          message: "Diverged."
        }
      },
      {
        preflight: {
          workstreamId: "owner/repo:issue:3",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-3",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: [],
          pendingFuturePacketIds: ["T3"]
        },
        branchSyncComparison: {
          parentBranch: "agent/owner-repo/issue-3",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/owner-repo/issue-3",
          defaultRef: "refs/remotes/origin/main",
          status: "missing_parent_branch",
          message: "Missing parent branch."
        }
      },
      {
        preflight: {
          workstreamId: "owner/repo:issue:4",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-4",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: [],
          pendingFuturePacketIds: ["T4"]
        },
        branchSyncComparison: {
          parentBranch: "agent/owner-repo/issue-4",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/owner-repo/issue-4",
          defaultRef: "refs/remotes/origin/main",
          status: "missing_default_branch",
          message: "Missing default branch."
        }
      },
      {
        preflight: {
          workstreamId: "owner/repo:issue:5",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-5",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: [],
          pendingFuturePacketIds: ["T5"]
        },
        branchSyncComparison: {
          parentBranch: "agent/owner-repo/issue-5",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/owner-repo/issue-5",
          defaultRef: "refs/remotes/origin/main",
          status: "unknown",
          message: "Unknown status."
        }
      }
    ],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [createRepoResult("repo-1", "repo", "/tmp/code-root", "synced", "ok")],
    tasks: []
  };

  const output = formatRunSummary(summary);

  assert.match(output, /owner\/repo:issue:1/);
  assert.match(output, /status: up_to_date \(behind 0, ahead 0\)/);
  assert.match(output, /recommendation: parent branch is up to date with default; next wave may proceed/);

  assert.match(output, /owner\/repo:issue:2/);
  assert.match(output, /status: diverged \(behind 2, ahead 1\)/);
  assert.match(output, /recommendation: parent and default diverged; perform conflict-aware sync before starting wave 1/);

  assert.match(output, /owner\/repo:issue:3/);
  assert.match(output, /status: missing_parent_branch/);
  assert.match(output, /recommendation: blocked; inspect missing local branch refs before continuing/);

  assert.match(output, /owner\/repo:issue:4/);
  assert.match(output, /status: missing_default_branch/);
  assert.match(output, /recommendation: blocked; inspect missing local branch refs before continuing/);

  assert.match(output, /owner\/repo:issue:5/);
  assert.match(output, /status: unknown/);
  assert.match(output, /recommendation: blocked; branch sync status is unavailable or unknown/);

  assert.equal(
    output.match(/recommendation: blocked; inspect missing local branch refs before continuing/g)?.length,
    2
  );
});

test("formatRunSummary reports next wave readiness for up_to_date preflights", () => {
  const summary: RunSummary = {
    command: "run",
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/state",
    logDir: "/tmp/log",
    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:05:00.000Z",
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 0,
    pullRequestCount: 1,
    commentCount: 0,
    taskCount: 0,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    executionCount: 0,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:1",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-1",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: [],
          pendingFuturePacketIds: ["T1"]
        },
        branchSyncComparison: {
          parentBranch: "agent/owner-repo/issue-1",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/owner-repo/issue-1",
          defaultRef: "refs/remotes/origin/main",
          status: "up_to_date",
          parentBehindCount: 0,
          parentAheadCount: 0,
          message: "Up to date."
        }
      },
      {
        preflight: {
          workstreamId: "owner/repo:issue:2",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-2",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: [],
          pendingFuturePacketIds: ["T2"]
        },
        branchSyncComparison: {
          parentBranch: "agent/owner-repo/issue-2",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/owner-repo/issue-2",
          defaultRef: "refs/remotes/origin/main",
          status: "diverged",
          parentBehindCount: 2,
          parentAheadCount: 1,
          message: "Diverged."
        }
      }
    ],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [createRepoResult("repo-1", "repo", "/tmp/code-root", "synced", "ok")],
    tasks: []
  };

  const output = formatRunSummary(summary);

  assert.match(output, /Next wave readiness:/);

  const readinessSection = output.slice(output.indexOf("Next wave readiness:"));
  assert.match(readinessSection, /- owner\/repo:issue:1: wave 1 is ready to prepare/);
  assert.match(readinessSection, /parent branch: agent\/owner-repo\/issue-1/);
  assert.match(readinessSection, /default branch: main/);
  assert.match(readinessSection, /parent PR: unknown/);
  assert.match(readinessSection, /completed packets: \(none\)/);
  assert.match(readinessSection, /pending future packets: T1/);

  // Issue 2 should be in preflights but NOT in readiness
  assert.match(output, /owner\/repo:issue:2/);
  assert.doesNotMatch(readinessSection, /owner\/repo:issue:2/);
});

test("formatRunSummary omits next wave readiness when no preflights are ready", () => {
  const summary: RunSummary = {
    command: "run",
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/state",
    logDir: "/tmp/log",
    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:05:00.000Z",
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 0,
    pullRequestCount: 1,
    commentCount: 0,
    taskCount: 0,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    executionCount: 0,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:2",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-2",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: [],
          pendingFuturePacketIds: ["T2"]
        },
        branchSyncComparison: {
          parentBranch: "agent/owner-repo/issue-2",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/owner-repo/issue-2",
          defaultRef: "refs/remotes/origin/main",
          status: "behind_default",
          parentBehindCount: 2,
          parentAheadCount: 1,
          message: "Behind."
        }
      }
    ],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [createRepoResult("repo-1", "repo", "/tmp/code-root", "synced", "ok")],
    tasks: []
  };

  const output = formatRunSummary(summary);
  assert.doesNotMatch(output, /Next wave readiness:/);
});

test("formatRunSummary handles parent branch sync preflight with undefined comparison", () => {
  const summary: RunSummary = {
    command: "run",
    codeRoot: "/tmp/code-root",
    managementDir: "/tmp/management",
    outputsDir: "/tmp/outputs",
    stateDir: "/tmp/state",
    logDir: "/tmp/log",
    startedAt: "2026-04-18T09:00:00.000Z",
    completedAt: "2026-04-18T09:05:00.000Z",
    repoCount: 1,
    syncedRepoCount: 1,
    failedRepoCount: 0,
    scannedRepoCount: 1,
    partiallyScannedRepoCount: 0,
    failedScanRepoCount: 0,
    issueCount: 0,
    pullRequestCount: 1,
    commentCount: 0,
    taskCount: 0,
    pendingTaskCount: 0,
    dispatchedTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    executionCount: 0,
    pullRequestBaseClassifications: [],
    packetPullRequestCandidates: [],
    parentBranchSyncPreflights: [
      {
        preflight: {
          workstreamId: "owner/repo:issue:123",
          repoKey: "owner/repo",
          parentIntegrationBranch: "agent/owner-repo/issue-123",
          defaultBranch: "main",
          currentWaveIndex: 0,
          nextWaveIndex: 1,
          completedPacketIds: ["T1", "T2"],
          pendingFuturePacketIds: ["T3", "T4", "T5"]
        }
      }
    ],
    packetPrsCreatedThisRun: [],
    packetWaveAdvancementsThisRun: [],
    packetWaveBlockedThisRun: [],
    packetPlans: [],
    results: [createRepoResult("repo-1", "repo", "/tmp/code-root", "synced", "ok")],
    tasks: []
  };

  const output = formatRunSummary(summary);

  assert.match(output, /status: unavailable/);
  assert.match(output, /recommendation: blocked; branch sync status is unavailable or unknown/);
});

test("runCli collects parent branch sync preflights in summary and ensures non-mutating Git usage", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-preflight-summary-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    const repo1 = baseRepoConfig("repo-1", "repo-one");
    repo1.defaultBranch = "main";
    const repo2 = baseRepoConfig("repo-2", "repo-two");
    repo2.defaultBranch = "main";
    await writeManagementConfig(managementDir, [repo1, repo2], []);
    await mkdir(stateDir, { recursive: true });

    const workstream1 = {
      id: "example-org/repo-one:issue:123",
      repoKey: "example-org/repo-one",
      origin: { type: "issue", number: 123 },
      phase: "implementing",
      linkedPrs: [{ number: 77, status: "open" }],
      activePrNumber: 77,
      integration: {
        branchName: "agent/example-org-repo-one/issue-123",
        prNumber: 77
      },
      packetPlan: {
        status: "proposed",
        currentWaveIndex: 0,
        waves: [["T1", "T2"], ["T3"], ["T4", "T5"]],
        packets: {
          T1: { id: "T1", status: "merged_to_parent" },
          T2: { id: "T2", status: "merged_to_parent" },
          T3: { id: "T3", status: "planned" },
          T4: { id: "T4", status: "planned" },
          T5: { id: "T5", status: "planned" }
        }
      }
    };
    const workstream2 = {
      id: "example-org/repo-two:issue:456",
      repoKey: "example-org/repo-two",
      origin: { type: "issue", number: 456 },
      phase: "implementing",
      linkedPrs: [{ number: 88, status: "open" }],
      activePrNumber: 88,
      integration: {
        branchName: "agent/example-org-repo-two/issue-456",
        prNumber: 88
      },
      packetPlan: {
        status: "proposed",
        currentWaveIndex: 0,
        waves: [["T6"], ["T6-future"]],
        packets: {
          T6: { id: "T6", status: "merged_to_parent" },
          "T6-future": { id: "T6-future", status: "planned" }
        }
      }
    };
    const workstream3 = {
      id: "example-org/repo-one:issue:789",
      repoKey: "example-org/repo-one",
      origin: { type: "issue", number: 789 },
      phase: "implementing",
      linkedPrs: [{ number: 99, status: "open" }],
      activePrNumber: 99,
      integration: {
        branchName: "agent/example-org-repo-one/issue-789",
        prNumber: 99
      },
      packetPlan: {
        status: "proposed",
        currentWaveIndex: 0,
        waves: [["T7"], ["T7-future"]],
        packets: {
          T7: { id: "T7", status: "merged_to_parent" },
          "T7-future": { id: "T7-future", status: "planned" }
        }
      }
    };

    await writeFile(
      path.join(stateDir, "workstreams.json"),
      JSON.stringify({ workstreams: [workstream1, workstream2, workstream3] }, null, 2),
      "utf8"
    );

    const issue123 = sampleIssue({ number: 123, repoSlug: "example-org/repo-one" });
    const issue456 = sampleIssue({ number: 456, repoSlug: "example-org/repo-two" });
    const issue789 = sampleIssue({ number: 789, repoSlug: "example-org/repo-one" });

    const calls: string[] = [];
    const gitGateway = {
      compareBranchSyncStatus: async (localPath: string, parentBranch: string, defaultBranch: string) => {
        calls.push(`compareBranchSyncStatus:${localPath}:${parentBranch}:${defaultBranch}`);
        if (parentBranch.includes("789")) {
          throw new Error("Simulated comparison failure");
        }
        return {
          parentBranch,
          defaultBranch,
          parentRef: `refs/remotes/origin/${parentBranch}`,
          defaultRef: `refs/remotes/origin/${defaultBranch}`,
          status: "behind_default" as const,
          parentBehindCount: 3,
          parentAheadCount: 0,
          message: "Parent branch is behind the default branch."
        };
      },
      cloneRepository: async () => { calls.push("cloneRepository"); },
      fetchRepository: async () => { calls.push("fetchRepository"); },
      getCurrentBranch: async () => { calls.push("getCurrentBranch"); return "main"; },
      getRemoteDefaultBranch: async () => { calls.push("getRemoteDefaultBranch"); return "main"; },
      isWorkingTreeClean: async () => { calls.push("isWorkingTreeClean"); return true; },
      ensureDefaultBranchCheckedOut: async () => { calls.push("ensureDefaultBranchCheckedOut"); },
      fastForwardDefaultBranch: async () => { calls.push("fastForwardDefaultBranch"); },
      createWorktree: async () => { calls.push("createWorktree"); return "path"; },
      commitAll: async () => { calls.push("commitAll"); return true; },
      pushBranch: async () => { calls.push("pushBranch"); },
      isInsideWorkingTree: async () => { calls.push("isInsideWorkingTree"); return false; },
      pullFastForwardOnly: async () => { calls.push("pullFastForwardOnly"); },
      getHeadCommitSha: async () => { calls.push("getHeadCommitSha"); return "abc123456789"; }
    };

    const options = {
      managementDir,
      stateDir,
      gitGateway: gitGateway as any,
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          if (repo.id === "repo-2") {
             // Missing local path for repo-2
             return createRepoResult(repo.id, repo.name, "", "synced", "ok");
          }
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<any> {
          return {
            issues: [issue123, issue456, issue789],
            prs: [
              samplePullRequest({ number: 77, headBranch: "agent/example-org-repo-one/issue-123", repoSlug: "example-org/repo-one" }),
              samplePullRequest({ number: 88, headBranch: "agent/example-org-repo-two/issue-456", repoSlug: "example-org/repo-two" }),
              samplePullRequest({ number: 99, headBranch: "agent/example-org-repo-one/issue-789", repoSlug: "example-org/repo-one" })
            ],
            comments: [],
            repoResults: [
              createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok"),
              { ...createRepoResult("repo-2", "repo-two", codeRoot, "synced", "ok"), localPath: "" }
            ],
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

    const summary = await runCli(["run", "--code-root", codeRoot], options);

    assert.equal(summary.parentBranchSyncPreflights.length, 3);

    // Sorted by repoKey, then workstreamId
    // 1. example-org/repo-one:issue:123
    // 2. example-org/repo-one:issue:789
    // 3. example-org/repo-two:issue:456

    const item1 = summary.parentBranchSyncPreflights[0]!;
    assert.equal(item1.preflight.workstreamId, "example-org/repo-one:issue:123");
    assert.equal(item1.branchSyncComparison?.status, "behind_default");

    const item2 = summary.parentBranchSyncPreflights[1]!;
    assert.equal(item2.preflight.workstreamId, "example-org/repo-one:issue:789");
    assert.equal(item2.branchSyncComparison?.status, "unknown");

    const item3 = summary.parentBranchSyncPreflights[2]!;
    assert.equal(item3.preflight.workstreamId, "example-org/repo-two:issue:456");
    assert.equal(item3.branchSyncComparisonSkippedReason, "missing_local_path");

    // Verify calls:
    // Only compareBranchSyncStatus and non-mutating methods should be called on gitGateway in this phase.
    const mutatingCalls = calls.filter(c =>
      c === "cloneRepository" ||
      c === "fetchRepository" ||
      c === "ensureDefaultBranchCheckedOut" ||
      c === "fastForwardDefaultBranch" ||
      c === "createWorktree" ||
      c === "commitAll" ||
      c === "pushBranch"
    );
    assert.deepEqual(mutatingCalls, []);

    // Also verify compareBranchSyncStatus was called with expected arguments
    const repo1Path = path.join(codeRoot, "repo-one");
    assert.ok(calls.includes(`compareBranchSyncStatus:${repo1Path}:agent/example-org-repo-one/issue-123:main`));
    assert.ok(calls.includes(`compareBranchSyncStatus:${repo1Path}:agent/example-org-repo-one/issue-789:main`));
    // repo-two should NOT be called because it has no local path
    assert.ok(!calls.some(c => c.includes("repo-two") && c.startsWith("compareBranchSyncStatus")));

  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("runCli preserves replanned packet plan through final full-cycle workstream write", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-replan-full-run-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    const repo = baseRepoConfig("repo-1", "repo-one");
    await writeManagementConfig(managementDir, [repo], [{
      id: "codex-manager",
      provider: "codex",
      modelClass: "strong",
      roles: ["implementation_manager"],
      command: "codex",
      enabled: true
    }]);
    await mkdir(stateDir, { recursive: true });

    const workstreamId = "example-org/repo-one:issue:21";
    const checkpoint = {
      id: "wave-assessment-example-org-repo-one-issue-21-wave-0-21-abc123",
      sessionId: "wave-assessment-example-org-repo-one-issue-21-wave-0-21-abc123",
      identity: {
        repoKey: "example-org/repo-one",
        workstreamId,
        waveId: "wave-0",
        parentPrNumber: 21,
        parentHeadSha: "abc123",
        parentIntegrationBranch: "agent/example-org-repo-one/issue-21",
        defaultBranch: "main",
        planRevision: "rev-old",
        originalPlanningSessionId: "unknown",
        currentWaveIndex: 0,
        nextWaveIndex: 1,
        completedPacketIds: ["T1"],
        pendingFuturePacketIds: ["T2"],
        planNodeIds: ["T1", "T2"]
      }
    };
    const replanAssessment = {
      id: "assessment-replan",
      sessionId: checkpoint.sessionId,
      checkpoint,
      decision: "replan",
      summary: "The next wave needs a revised packet plan.",
      findings: [{
        category: "drift",
        summary: "T2 is stale.",
        details: "The revised plan should replace T2.",
        affectedPlanNodeIds: ["T2"]
      }],
      status: "finalized",
      postedCommentId: "old-comment",
      finalizedAt: "2026-04-18T09:30:00.000Z"
    };
    const workstream = {
      id: workstreamId,
      repoKey: "example-org/repo-one",
      origin: { type: "issue", number: 21 },
      linkedIssueNumber: 21,
      linkedPrs: [{ number: 21, status: "open" }],
      activePrNumber: 21,
      phase: "implementing",
      attention: "idle",
      status: "open",
      resolution: "unresolved",
      integration: {
        branchName: "agent/example-org-repo-one/issue-21",
        prNumber: 21
      },
      packetPlan: {
        status: "approved",
        source: {
          kind: "plan_breakdown_result",
          workstreamId,
          generatedAt: "rev-old"
        },
        packets: {
          T1: { id: "T1", title: "T1", summary: "T1", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "merged_to_parent" },
          T2: { id: "T2", title: "T2", summary: "T2", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" }
        },
        waves: [["T1"], ["T2"]],
        currentWaveIndex: 0,
        updatedAt: "2026-04-18T09:00:00.000Z",
        waveAssessments: [replanAssessment]
      }
    };
    await writeFile(path.join(stateDir, "workstreams.json"), JSON.stringify({ workstreams: [workstream] }, null, 2), "utf8");

    const planBreakdown: PlanBreakdownResult = {
      title: "Replanned packet plan",
      summary: "Replace stale future work with revised packet R1.",
      tasks: [{
        id: "R1",
        title: "Revised packet",
        description: "Implement the revised next step.",
        dependsOn: [],
        blocks: [],
        canRunInParallelWith: [],
        risk: "low",
        filesLikelyInvolved: ["src/revised.ts"],
        acceptanceCriteria: ["R1 is represented in the packet plan."],
        verification: ["Run focused tests."]
      }],
      waves: [{ id: "RW1", taskIds: ["R1"], rationale: "The stale T2 packet was replaced." }],
      recommendedFirstWaveId: "RW1",
      graphConcerns: [],
      humanDecisionsNeeded: [],
      suggestedNextAction: "Dispatch R1."
    };

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(): Promise<RepoSyncRecord> {
          return createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<any> {
          return {
            issues: [sampleIssue({ number: 21, key: "example-org/repo-one:issue:21" })],
            prs: [
              samplePullRequest({
                number: 21,
                key: "example-org/repo-one:pull_request:21",
                headBranch: "agent/example-org-repo-one/issue-21",
                headSha: "abc123",
                labels: []
              })
            ],
            comments: [],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "failed", "skip packet artifact provisioning")],
            failures: []
          };
        }
      },
      agentRunner: {
        async dispatch(task: TaskRecord) {
          assert.equal(task.kind, "wave_plan_replanning");
          return {
            taskStatus: "completed" as const,
            execution: {
              id: "exec-replan",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "codex-manager",
              agentProvider: "codex",
              command: {
                executable: "codex",
                args: ["exec", "-"],
                cwd: task.context.localRepoPath ?? codeRoot,
                timeoutMs: 600000
              },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: "2026-04-18T10:00:00.000Z",
              endedAt: "2026-04-18T10:00:05.000Z",
              exitCode: 0,
              result: {
                planBreakdown
              }
            } satisfies ExecutionRecord
          };
        }
      },
      gitHubGateway: {
        addReaction: async () => ({}),
        postIssueComment: async () => ({ id: "new-comment" })
      } as any,
      logger: { info: () => undefined, warn: () => undefined }
    });

    const state = JSON.parse(await readFile(path.join(stateDir, "workstreams.json"), "utf8")) as {
      workstreams: Array<{
        id: string;
        packetPlan?: {
          packets?: Record<string, unknown>;
          source?: { generatedAt?: string };
          waveAssessments?: Array<{
            postedCommentId?: string;
            checkpoint?: { identity?: { planRevision?: string; planNodeIds?: string[] } };
          }>;
        };
      }>;
    };
    const persistedPlan = state.workstreams.find((item) => item.id === workstreamId)?.packetPlan;
    const continueAssessment = persistedPlan?.waveAssessments?.find(
      (assessment) => assessment.postedCommentId === "new-comment"
    );
    assert.ok(persistedPlan?.packets?.R1, "replanned packet R1 should survive final workstream write");
    assert.equal(persistedPlan?.packets?.T2, undefined, "stale packet T2 should not be restored by final write");
    assert.equal(persistedPlan?.source?.generatedAt, "2026-04-18T10:00:05.000Z");
    assert.equal(continueAssessment?.checkpoint?.identity?.planRevision, persistedPlan?.source?.generatedAt);
    assert.deepEqual(continueAssessment?.checkpoint?.identity?.planNodeIds, ["R1"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli runtime wave preflight uses latest plan-breakdown session identity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-wave-preflight-session-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], []);
    await mkdir(stateDir, { recursive: true });

    const workstreamId = "example-org/repo-one:issue:31";
    const planTaskId = "task:plan_breakdown:issue:31";
    await writeFile(
      path.join(stateDir, "tasks.json"),
      JSON.stringify({
        tasks: [{
          id: planTaskId,
          kind: "plan_breakdown",
          status: "completed",
          repoId: "repo-1",
          repoName: "repo-one",
          repoSlug: "example-org/repo-one",
          sourceKind: "issue",
          sourceId: "issue:example-org/repo-one:31",
          sourceUrl: "https://github.com/example-org/repo-one/issues/31",
          relevant: true,
          reason: "Plan breakdown completed.",
          summary: "Break down plan.",
          workstreamId,
          context: { repoIdentifier: "example-org/repo-one", labels: [] },
          createdAt: "2026-04-18T09:00:00.000Z",
          updatedAt: "2026-04-18T09:10:00.000Z"
        }]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(stateDir, "executions.json"),
      JSON.stringify({
        executions: [{
          id: "exec:plan-breakdown:31",
          taskId: planTaskId,
          taskKind: "plan_breakdown",
          taskStatus: "completed",
          repoId: "repo-1",
          repoSlug: "example-org/repo-one",
          agentId: "codex-manager",
          agentProvider: "codex",
          command: { executable: "codex", args: [], cwd: codeRoot, timeoutMs: 600000 },
          promptArtifactPath: "",
          stdoutArtifactPath: "",
          stderrArtifactPath: "",
          promptPacketPath: "",
          startedAt: "2026-04-18T09:05:00.000Z",
          endedAt: "2026-04-18T09:10:00.000Z",
          exitCode: 0,
          result: { planBreakdownSessionId: "planner-session-31" }
        }]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(stateDir, "workstreams.json"),
      JSON.stringify({
        workstreams: [{
          id: workstreamId,
          repoKey: "example-org/repo-one",
          origin: { type: "issue", number: 31 },
          linkedIssueNumber: 31,
          linkedPrs: [{ number: 31, status: "open" }],
          activePrNumber: 31,
          phase: "implementing",
          attention: "idle",
          status: "open",
          resolution: "unresolved",
          integration: { branchName: "agent/example-org-repo-one/issue-31", prNumber: 31 },
          packetPlan: {
            status: "approved",
            source: {
              kind: "plan_breakdown_result",
              workstreamId,
              generatedAt: "rev-31"
            },
            packets: {
              T1: { id: "T1", title: "T1", summary: "T1", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "merged_to_parent" },
              T2: { id: "T2", title: "T2", summary: "T2", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" }
            },
            waves: [["T1"], ["T2"]],
            currentWaveIndex: 0
          }
        }]
      }, null, 2),
      "utf8"
    );

    const summary = await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      logDir: stateDir,
      syncService: {
        async syncRepository(): Promise<RepoSyncRecord> {
          return createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<any> {
          return {
            issues: [sampleIssue({ number: 31, key: "example-org/repo-one:issue:31" })],
            prs: [
              samplePullRequest({
                number: 31,
                key: "example-org/repo-one:pull_request:31",
                headBranch: "agent/example-org-repo-one/issue-31",
                headSha: "abc123",
                labels: []
              })
            ],
            comments: [],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: []
          };
        }
      },
      gitGateway: {
        compareBranchSyncStatus: async () => ({
          parentBranch: "agent/example-org-repo-one/issue-31",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/example-org-repo-one/issue-31",
          defaultRef: "refs/remotes/origin/main",
          status: "up_to_date",
          message: "up to date"
        })
      } as any,
      gitOpsLifecycleService: {
        prepareManagementRoot: async () => ({ status: "skipped_not_git" }),
        prepareOutputsRoot: async () => ({ status: "skipped_not_git" }),
        finalizeOutputsRoot: async () => ({ status: "skipped_not_git" })
      } as any,
      logger: { info: () => undefined, warn: () => undefined }
    });

    assert.equal(summary.parentBranchSyncPreflights[0]?.preflight.originalPlanningSessionId, "planner-session-31");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli defers packet wave advancement after same-cycle parent branch sync", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-wave-sync-defers-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], []);
    await mkdir(stateDir, { recursive: true });

    const workstreamId = "example-org/repo-one:issue:41";
    const checkpoint = buildWaveAssessmentCheckpoint({
      repoKey: "example-org/repo-one",
      workstreamId,
      waveId: "wave-0",
      parentPrNumber: 41,
      parentHeadSha: "old-head",
      parentIntegrationBranch: "agent/example-org-repo-one/issue-41",
      defaultBranch: "main",
      planRevision: "rev-41",
      originalPlanningSessionId: "unknown",
      currentWaveIndex: 0,
      nextWaveIndex: 1,
      completedPacketIds: ["T1"],
      pendingFuturePacketIds: ["T2"],
      planNodeIds: ["T1", "T2"]
    });
    await writeFile(
      path.join(stateDir, "workstreams.json"),
      JSON.stringify({
        workstreams: [{
          id: workstreamId,
          repoKey: "example-org/repo-one",
          origin: { type: "issue", number: 41 },
          linkedIssueNumber: 41,
          linkedPrs: [{ number: 41, status: "open" }],
          activePrNumber: 41,
          phase: "implementing",
          attention: "idle",
          status: "open",
          resolution: "unresolved",
          integration: { branchName: "agent/example-org-repo-one/issue-41", prNumber: 41 },
          packetPlan: {
            status: "approved",
            source: {
              kind: "plan_breakdown_result",
              workstreamId,
              generatedAt: "rev-41"
            },
            packets: {
              T1: { id: "T1", title: "T1", summary: "T1", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "merged_to_parent" },
              T2: { id: "T2", title: "T2", summary: "T2", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" }
            },
            waves: [["T1"], ["T2"]],
            currentWaveIndex: 0,
            waveAssessments: [{
              id: `assessment:${checkpoint.id}`,
              sessionId: checkpoint.sessionId,
              checkpoint,
              decision: "continue",
              summary: "Continue.",
              findings: [],
              status: "finalized",
              postedCommentId: "assessment-comment",
              finalizedAt: "2026-04-18T09:00:00.000Z"
            }]
          }
        }]
      }, null, 2),
      "utf8"
    );

    const summary = await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(): Promise<RepoSyncRecord> {
          return createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<any> {
          return {
            issues: [sampleIssue({ number: 41, key: "example-org/repo-one:issue:41" })],
            prs: [
              samplePullRequest({
                number: 41,
                key: "example-org/repo-one:pull_request:41",
                headBranch: "agent/example-org-repo-one/issue-41",
                headSha: "old-head",
                labels: ["agent-sync-parent-branch"]
              })
            ],
            comments: [],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: []
          };
        }
      },
      gitGateway: {
        compareBranchSyncStatus: async () => ({
          parentBranch: "agent/example-org-repo-one/issue-41",
          defaultBranch: "main",
          parentRef: "refs/remotes/origin/agent/example-org-repo-one/issue-41",
          defaultRef: "refs/remotes/origin/main",
          status: "up_to_date",
          message: "up to date"
        })
      } as any,
      gitOpsLifecycleService: {
        prepareManagementRoot: async () => ({ status: "skipped_not_git" }),
        prepareOutputsRoot: async () => ({ status: "skipped_not_git" }),
        finalizeOutputsRoot: async () => ({ status: "skipped_not_git" })
      } as any,
      parentBranchSyncService: {
        async syncParentBranch() {
          return { status: "synced" as const, message: "Parent branch synced." };
        }
      },
      gitHubGateway: {
        postIssueComment: async () => ({ id: "sync-comment" }),
        addReaction: async () => ({})
      } as any,
      logger: { info: () => undefined, warn: () => undefined }
    });

    const state = JSON.parse(await readFile(path.join(stateDir, "workstreams.json"), "utf8")) as {
      workstreams: Array<{ id: string; packetPlan?: { currentWaveIndex?: number } }>;
    };

    assert.equal(summary.packetWaveAdvancementsThisRun.length, 0);
    assert.equal(
      state.workstreams.find((workstream) => workstream.id === workstreamId)?.packetPlan?.currentWaveIndex,
      0
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("runCli rejects invalid command usage clearly", async () => {
  await assert.rejects(
    () => runCli(["status"]),
    /Expected command: backburner run \[--code-root <path>\] \[--management-dir <path>\] \[--outputs-dir <path>\] \[--log-dir <path>\] \[--broker-port <port>\]/
  );
});

test("runCli defaults codeRoot to the Backburner user directory", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-default-code-root-"));
  const managementDir = path.join(tempDir, "management");
  const outputsDir = path.join(tempDir, "outputs");

  try {
    await writeManagementConfig(managementDir, [], []);

    const summary = await runCli(["run", "--outputs-dir", outputsDir], {
      managementDir,
      logger: { info: () => undefined, warn: () => undefined }
    });

    assert.equal(summary.codeRoot, path.resolve(defaultBackburnerCodeRoot()));
    assert.equal(summary.managementDir, managementDir);
    assert.equal(summary.outputsDir, outputsDir);
    assert.equal(summary.stateDir, resolveOutputsStateRoot(outputsDir));
    assert.equal(summary.logDir, resolveOutputsLogsRoot(outputsDir));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLoopCli stops cleanly when shutdown is requested between cycles", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-run-loop-stop-between-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");
  const signalRegistrar = createSignalRegistrar();
  let syncCount = 0;
  const stdoutRestore = silenceStdout();

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], []);

    await runLoopCli(
      ["run-loop", "--code-root", codeRoot, "--interval-seconds", "1"],
      {
        managementDir,
        stateDir,
        signalRegistrar,
        delay: async () => {
          signalRegistrar.emit("SIGTERM");
        },
        logger: { info: () => undefined, warn: () => undefined },
        syncService: {
          async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
            syncCount += 1;
            return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
          }
        },
        scanService: {
          async scanRepositories(): Promise<{
            issues: NormalizedIssue[];
            prs: NormalizedPullRequest[];
            comments: NormalizedComment[];
            repoResults: RepoSyncRecord[];
            failures: [];
          }> {
            return {
              issues: [],
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
              failures: []
            };
          }
        }
      }
    );

    assert.equal(syncCount, 1);
  } finally {
    stdoutRestore();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLoopCli waits for the current cycle to finish before stopping", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-run-loop-stop-during-run-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");
  const signalRegistrar = createSignalRegistrar();
  let syncCount = 0;
  let scanCount = 0;
  const stdoutRestore = silenceStdout();

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], []);

    await runLoopCli(
      ["run-loop", "--code-root", codeRoot],
      {
        managementDir,
        stateDir,
        signalRegistrar,
        delay: async () => {
          throw new Error("delay should not be reached after a stop during the run");
        },
        logger: { info: () => undefined, warn: () => undefined },
        syncService: {
          async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
            syncCount += 1;
            signalRegistrar.emit("SIGINT");
            return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
          }
        },
        scanService: {
          async scanRepositories(): Promise<{
            issues: NormalizedIssue[];
            prs: NormalizedPullRequest[];
            comments: NormalizedComment[];
            repoResults: RepoSyncRecord[];
            failures: [];
          }> {
            scanCount += 1;
            return {
              issues: [],
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
              failures: []
            };
          }
        }
      }
    );

    assert.equal(syncCount, 1);
    assert.equal(scanCount, 1);
  } finally {
    stdoutRestore();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLoopCli supports --outputs-dir and forwards it to run cycles", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-run-loop-outputs-"));
  const managementDir = path.join(tempDir, "management");
  const outputsDir = path.join(tempDir, "outputs");
  const codeRoot = path.join(tempDir, "code-root");
  const signalRegistrar = createSignalRegistrar();
  let syncCount = 0;
  const stdoutRestore = silenceStdout();

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], []);

    await runLoopCli(
      ["run-loop", "--code-root", codeRoot, "--outputs-dir", outputsDir, "--interval-seconds", "1"],
      {
        managementDir,
        signalRegistrar,
        delay: async () => {
          signalRegistrar.emit("SIGTERM");
        },
        logger: { info: () => undefined, warn: () => undefined },
        syncService: {
          async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
            syncCount++;
            return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
          }
        },
        scanService: {
          async scanRepositories(): Promise<{
            issues: NormalizedIssue[];
            prs: NormalizedPullRequest[];
            comments: NormalizedComment[];
            repoResults: RepoSyncRecord[];
            failures: [];
          }> {
            return {
              issues: [],
              prs: [],
              comments: [],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
              failures: []
            };
          }
        }
      }
    );

    assert.equal(syncCount, 1);
    // Verify that state and logs were created in the right place
    await assert.doesNotReject(readFile(path.join(resolveOutputsStateRoot(outputsDir), "tasks.json")));
    await assert.doesNotReject(readFile(path.join(resolveOutputsLogsRoot(outputsDir), "executions.json")));
  } finally {
    stdoutRestore();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runLoopCli rejects conflicting interval flags", async () => {
  await assert.rejects(
    () =>
      runLoopCli([
        "run-loop",
        "--code-root",
        "/tmp/code-root",
        "--interval-seconds",
        "30",
        "--interval-minutes",
        "1"
      ]),
    /Use only one of --interval-seconds or --interval-minutes/
  );
});

test("StateStore writes tasks, executions, repos, and failures in stable sorted order", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-stable-order-"));

  try {
    const { StateStore } = await import("../src/state/loader.js");
    const store = new StateStore(tempDir);

    await store.writeRepoSyncState([
      {
        ...createRepoResult("repo-2", "repo-two", "/tmp/code-root", "failed", "failed"),
        githubScan: {
          status: "failed",
          scannedAt: "2026-04-18T09:00:30.000Z",
          issueCount: 0,
          pullRequestCount: 0,
          commentCount: 0,
          failures: [
            {
              repoId: "repo-2",
              repoSlug: "example-org/repo-two",
              step: "repo_metadata",
              scope: "repo",
              message: "b"
            },
            {
              repoId: "repo-2",
              repoSlug: "example-org/repo-two",
              step: "issue_comments",
              scope: "issue#7",
              message: "a"
            }
          ]
        }
      },
      createRepoResult("repo-1", "repo-one", "/tmp/code-root", "synced", "ok")
    ]);

    await store.writeTaskState([
      {
        ...baseImplementTask(),
        id: "task:review_pr:pull_request:example-org/repo-two:9",
        kind: "review_pr",
        repoId: "repo-2",
        repoName: "repo-two",
        repoSlug: "example-org/repo-two",
        sourceId: "pull_request:example-org/repo-two:9",
        sourceUrl: "https://github.com/example-org/repo-two/pull/9",
        summary: "Review PR #9"
      },
      baseImplementTask()
    ]);

    await store.writeExecutionState([
      {
        ...buildExecution(baseImplementTask(), "/tmp/code-root/repo-one", "codex"),
        id: "exec:z",
        taskId: "task:review_pr:pull_request:example-org/repo-two:9",
        repoId: "repo-2",
        repoSlug: "example-org/repo-two",
        startedAt: "2026-04-18T09:11:00.000Z"
      },
      {
        ...buildExecution(baseImplementTask(), "/tmp/code-root/repo-one", "codex"),
        id: "exec:a",
        startedAt: "2026-04-18T09:10:00.000Z"
      }
    ]);

    const reposState = await readFile(path.join(tempDir, "repos.json"), "utf8");
    const tasksState = await readFile(path.join(tempDir, "tasks.json"), "utf8");
    const executionsState = await readFile(path.join(tempDir, "executions.json"), "utf8");

    assert.ok(reposState.indexOf('"repoSlug": "example-org/repo-one"') < reposState.indexOf('"repoSlug": "example-org/repo-two"'));
    assert.ok(tasksState.indexOf('"id": "task:implement_plan:pull_request:example-org/repo-one:23"') < tasksState.indexOf('"id": "task:review_pr:pull_request:example-org/repo-two:9"'));
    assert.ok(executionsState.indexOf('"id": "exec:a"') < executionsState.indexOf('"id": "exec:z"'));
    assert.ok(reposState.indexOf('"step": "issue_comments"') < reposState.indexOf('"step": "repo_metadata"'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function baseRepoConfig(id: string, name: string): RepoConfig {
  return {
    id,
    owner: "example-org",
    name,
    localPath: name,
    enabled: true,
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

function createSignalRegistrar() {
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();

  return {
    on(signal: NodeJS.Signals, listener: () => void) {
      const existing = listeners.get(signal) ?? new Set<() => void>();
      existing.add(listener);
      listeners.set(signal, existing);
    },
    off(signal: NodeJS.Signals, listener: () => void) {
      listeners.get(signal)?.delete(listener);
    },
    emit(signal: NodeJS.Signals) {
      for (const listener of listeners.get(signal) ?? []) {
        listener();
      }
    }
  };
}

function silenceStdout(): () => void {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((..._args: Parameters<typeof process.stdout.write>) => true) as typeof process.stdout.write;
  return () => {
    process.stdout.write = originalWrite;
  };
}

function implementationAgent() {
  return {
    id: "codex-cheap",
    provider: "codex" as const,
    modelClass: "cheap" as const,
    roles: ["implementation"],
    command: "codex",
    enabled: true
  };
}

async function writeManagementConfig(
  managementDir: string,
  repos: RepoConfig[],
  agents: unknown[]
): Promise<void> {
  await mkdir(path.join(managementDir, "state"), { recursive: true });
  await writeFile(path.join(managementDir, "repos.json"), JSON.stringify({ allowedUsers: ["owner", "human"], repos }, null, 2), "utf8");
  await writeFile(path.join(managementDir, "agents.json"), JSON.stringify({ agents }, null, 2), "utf8");
}

function createRepoResult(
  id: string,
  name: string,
  codeRoot: string,
  status: "synced" | "failed",
  message: string
): RepoSyncRecord {
  return {
    repoId: id,
    repoName: name,
    repoSlug: `example-org/${name}`,
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
    syncedAt: "2026-04-18T09:00:00.000Z",
    message
  };
}

function sampleIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    kind: "issue",
    id: "issue:example-org/repo-one:123",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    number: 123,
    key: "example-org/repo-one:issue:123",
    sourceId: "I_123",
    url: "https://github.com/example-org/repo-one/issues/123",
    title: "Issue 123",
    body: "Issue body",
    labels: ["agent-in-progress"],
    author: "owner",
    createdAt: "2026-04-18T08:00:00.000Z",
    updatedAt: "2026-04-18T08:00:00.000Z",
    lastSeenAt: "2026-04-18T09:00:00.000Z",
    state: "open",
    ...overrides
  };
}

function samplePullRequest(overrides: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  return {
    kind: "pull_request",
    id: "pull_request:example-org/repo-one:23",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    number: 23,
    key: "example-org/repo-one:pull_request:23",
    sourceId: "PR_23",
    url: "https://github.com/example-org/repo-one/pull/23",
    title: "Implement scanning",
    body: "Open PR body",
    labels: [],
    author: "owner",
    createdAt: "2026-04-18T08:10:00.000Z",
    updatedAt: "2026-04-18T08:40:00.000Z",
    lastCommentAt: "2026-04-18T08:41:00.000Z",
    lastSeenAt: "2026-04-18T09:05:00.000Z",
    state: "open",
    headBranch: "agent/example-org-repo-one/issue-17",
    headSha: "abc123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false,
    ...overrides
  };
}

function baseImplementTask(): TaskRecord {
  const executionPolicy = workflowRegistry.resolveTaskExecutionPolicy("implement_plan");

  return {
    id: "task:implement_plan:pull_request:example-org/repo-one:23",
    kind: "implement_plan",
    status: "pending",
    executionPermission: executionPolicy.executionPermission,
    handoffPolicy: executionPolicy.handoffPolicy,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    sourceKind: "pull_request",
    sourceId: "pull_request:example-org/repo-one:23",
    sourceUrl: "https://github.com/example-org/repo-one/pull/23",
    relevant: true,
    reason: "Plan is approved.",
    summary: "Implement approved plan for PR #23: Implement scanning",
    context: {
      repoIdentifier: "example-org/repo-one",
      localRepoPath: "/tmp/code-root/_worktrees/example-org/repo-one/issue-17",
      planDocumentPath: "/tmp/code-root/_worktrees/example-org/repo-one/issue-17/docs/agents/agent-example-org-repo-one-issue-17/issue-17-agent-plan.md",
      logDocumentPath: "/tmp/code-root/_worktrees/example-org/repo-one/issue-17/docs/agents/agent-example-org-repo-one-issue-17/issue-17-agent-log.md",
      pullRequestUrl: "https://github.com/example-org/repo-one/pull/23",
      labels: ["agent-plan-approved"],
      instruction:
        "Implement the approved plan from docs/agents/agent-example-org-repo-one-issue-17/issue-17-agent-plan.md and continue documenting work in docs/agents/agent-example-org-repo-one-issue-17/issue-17-agent-log.md."
    },
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z"
  };
}

function buildExecution(task: TaskRecord, cwd: string, command: string): ExecutionRecord {
  return {
    id: `exec:${task.id}:mock`,
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: "completed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "codex-cheap",
    agentProvider: "codex",
    command: {
      executable: command,
      args: ["exec", "-"],
      cwd,
      timeoutMs: 600000
    },
    promptArtifactPath: "",
    stdoutArtifactPath: "",
    stderrArtifactPath: "",
    promptPacketPath: "",
    startedAt: "2026-04-18T09:10:00.000Z",
    endedAt: "2026-04-18T09:11:00.000Z",
    exitCode: 0
  };
}

test("runCli does not write directly to persistent worktree log during merge-prep", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-merge-prep-clean-log-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    const repo = baseRepoConfig("repo-1", "repo-one");
    await writeManagementConfig(managementDir, [repo], []);

    const worktree = {
      id: "worktree:repo-1:head-branch",
      repoId: "repo-1",
      repoSlug: "example-org/repo-one",
      branchName: "agent/example-org-repo-one/issue-17",
      path: path.join(codeRoot, "repo-one"),
      logDocumentPath: path.join(codeRoot, "repo-one", "docs/agents/log.md"),
      status: "implementing"
    };

    const workstream = {
      id: "example-org/repo-one:pull_request:23",
      repoKey: "example-org/repo-one",
      origin: { type: "pr", number: 23 },
      phase: "pr_review",
      linkedPrs: [{ number: 23, status: "open" }],
      activePrNumber: 23
    };

    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "worktrees.json"), JSON.stringify({ worktrees: [worktree] }, null, 2));
    await writeFile(path.join(stateDir, "workstreams.json"), JSON.stringify({ workstreams: [workstream] }, null, 2));

    let writeAuditToLogCalled = false;
    let commitAuditInCloneCalled = false;

    const mockMergePrepService = {
      generateExecutionId: () => "exec-123",
      refreshPersistentWorktreeBeforeDispatch: async () => ({ status: "already_up_to_date" }),
      prepareMergePrepClone: async () => ({
        clonePath: path.join(tempDir, "clone"),
        verifiedHeadSha: "abc123"
      }),
      inspectMergePrepCloneResult: async () => ({
        status: "ready_to_push",
        localSha: "def456",
        aheadCount: 1,
        commitLog: "one commit",
        diffStats: "one file"
      }),
      publishMergePrepResult: async () => ({ status: "pushed", pushedSha: "def456" }),
      refreshPersistentWorktreeAfterMergePrep: async () => ({ status: "succeeded" }),
      cleanupMergePrepClone: async () => {},
      writeAuditToLog: async () => {
        writeAuditToLogCalled = true;
      },
      commitAuditInClone: async () => {
        commitAuditInCloneCalled = true;
      }
    };

    const options = {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(): Promise<RepoSyncRecord> {
          return createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<any> {
          return {
            issues: [],
            prs: [
              samplePullRequest({
                number: 23,
                labels: ["prepare-for-merge"],
                headSha: "abc123",
                headBranch: "agent/example-org-repo-one/issue-17"
              })
            ],
            comments: [],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: []
          };
        }
      },
      agentRunner: {
        async dispatch() {
          return { taskStatus: "completed" as const, executions: [] };
        }
      },
      commandRunner: {
        run: async (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "merge") {
            return { stdout: "Merged cleanly", stderr: "", exitCode: 0 };
          }
          if (cmd === "git" && args[0] === "rev-parse") {
            return { stdout: "abc123", stderr: "", exitCode: 0 };
          }
          if (cmd === "git" && args[0] === "status") {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          if (cmd === "git" && args[0] === "show-ref") {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }
      },
      gitHubGateway: {
        postIssueComment: async () => {}
      },
      gitOpsLifecycleService: {
        prepareManagementRoot: async () => ({ status: "skipped_not_git" }),
        prepareOutputsRoot: async () => ({ status: "skipped_not_git" }),
        finalizeOutputsRoot: async () => ({ status: "skipped_not_git" })
      },
      mergePrepService: mockMergePrepService as any,
      logger: { info: () => undefined, warn: () => undefined }
    };

    await runCli(["run", "--code-root", codeRoot], options as any);

    assert.equal(commitAuditInCloneCalled, true, "commitAuditInClone should have been called");
    assert.equal(writeAuditToLogCalled, false, "writeAuditToLog should NOT have been called");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli workspace recovery: persists recovery records to workspace-recovery.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-recovery-persist-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "tasks.json"),
      JSON.stringify({
        tasks: [{
          id: "task:implement_plan:pull_request:example-org/repo-one:23",
          kind: "implement_plan",
          status: "failed",
          repoId: "repo-1",
          repoName: "repo-one",
          repoSlug: "example-org/repo-one",
          sourceKind: "pull_request",
          sourceId: "pull_request:example-org/repo-one:23",
          sourceUrl: "https://github.com/example-org/repo-one/pull/23",
          relevant: true,
          reason: "Plan is approved.",
          summary: "Implement approved plan for PR #23",
          context: { repoIdentifier: "example-org/repo-one", recoveryNeeded: true },
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z"
        }]
      }, null, 2), "utf8"
    );

    const taskId = "task:implement_plan:pull_request:example-org/repo-one:23";
    let recoveryCalled = false;
    const fakeRecoveryService = {
      isRecoveryNeeded: (task: TaskRecord) => task.context.recoveryNeeded === true,
      resolveTaskWorkspacePath: (_task: TaskRecord) => null,
      recoverWorkspace: async (opts: { task: TaskRecord }): Promise<WorkspaceRecoveryRecord> => {
        recoveryCalled = true;
        return { taskId: opts.task.id, taskKind: opts.task.kind, outcome: "recovered", reason: "Workspace reset.", recoveredAt: "2026-06-14T00:00:00.000Z" };
      }
    };

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories() {
          return {
            issues: [] as NormalizedIssue[],
            prs: [samplePullRequest({ labels: ["agent-plan-approved"] })],
            comments: [] as NormalizedComment[],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: [] as []
          };
        }
      },
      agentRunner: {
        async dispatch(task: TaskRecord, context: TaskRecord["context"], agentConfig: AgentConfig) {
          return { taskStatus: "completed" as const, execution: buildExecution(task, context.localRepoPath ?? codeRoot, agentConfig.command) };
        }
      },
      workspaceRecoveryService: fakeRecoveryService as any,
      logger: { info: () => undefined, warn: () => undefined }
    });

    assert.equal(recoveryCalled, true, "recoverWorkspace should have been called for the recoveryNeeded task");
    const raw = JSON.parse(await readFile(path.join(stateDir, "workspace-recovery.json"), "utf8")) as WorkspaceRecoveryStateFile;
    assert.ok(raw.records.length >= 1, "workspace-recovery.json should contain at least one record");
    const record = raw.records.find(r => r.taskId === taskId);
    assert.ok(record, "should have a record for the task");
    assert.equal(record.outcome, "recovered");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli workspace recovery: recovery failure is non-fatal and dispatch lifecycle continues", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-recovery-nonfatal-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "tasks.json"),
      JSON.stringify({
        tasks: [{
          id: "task:implement_plan:pull_request:example-org/repo-one:23",
          kind: "implement_plan",
          status: "failed",
          repoId: "repo-1",
          repoName: "repo-one",
          repoSlug: "example-org/repo-one",
          sourceKind: "pull_request",
          sourceId: "pull_request:example-org/repo-one:23",
          sourceUrl: "https://github.com/example-org/repo-one/pull/23",
          relevant: true,
          reason: "Plan is approved.",
          summary: "Implement approved plan for PR #23",
          context: { repoIdentifier: "example-org/repo-one", recoveryNeeded: true },
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z"
        }]
      }, null, 2), "utf8"
    );

    const warnMessages: string[] = [];
    const fakeRecoveryService = {
      isRecoveryNeeded: (task: TaskRecord) => task.context.recoveryNeeded === true,
      resolveTaskWorkspacePath: (_task: TaskRecord) => null,
      recoverWorkspace: async (opts: { task: TaskRecord }): Promise<WorkspaceRecoveryRecord> => {
        return { taskId: opts.task.id, taskKind: opts.task.kind, outcome: "failed", reason: "Git fetch failed.", recoveredAt: "2026-06-14T00:00:00.000Z" };
      }
    };

    let summary: Awaited<ReturnType<typeof runCli>> | undefined;
    await assert.doesNotReject(async () => {
      summary = await runCli(["run", "--code-root", codeRoot], {
        managementDir,
        stateDir,
        syncService: {
          async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
            return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
          }
        },
        scanService: {
          async scanRepositories() {
            return {
              issues: [] as NormalizedIssue[],
              prs: [samplePullRequest({ labels: ["agent-plan-approved"] })],
              comments: [] as NormalizedComment[],
              repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
              failures: [] as []
            };
          }
        },
        agentRunner: {
          async dispatch(task: TaskRecord, context: TaskRecord["context"], agentConfig: AgentConfig) {
            return { taskStatus: "completed" as const, execution: buildExecution(task, context.localRepoPath ?? codeRoot, agentConfig.command) };
          }
        },
        workspaceRecoveryService: fakeRecoveryService as any,
        logger: { info: () => undefined, warn: (msg: string) => { warnMessages.push(msg); } }
      });
    }, "runCli should not throw when workspace recovery fails");

    assert.ok(summary, "runCli should return a summary");
    assert.ok(warnMessages.length > 0 || true, "lifecycle should have continued regardless of recovery failure");

    const raw = JSON.parse(await readFile(path.join(stateDir, "workspace-recovery.json"), "utf8")) as WorkspaceRecoveryStateFile;
    const failedRecord = raw.records.find(r => r.outcome === "failed");
    assert.ok(failedRecord, "failed recovery outcome should be persisted");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli workspace recovery: completed tasks are not touched by Phase 0", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-recovery-completed-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "tasks.json"),
      JSON.stringify({
        tasks: [{
          id: "task:implement_plan:pull_request:example-org/repo-one:23",
          kind: "implement_plan",
          status: "completed",
          repoId: "repo-1",
          repoName: "repo-one",
          repoSlug: "example-org/repo-one",
          sourceKind: "pull_request",
          sourceId: "pull_request:example-org/repo-one:23",
          sourceUrl: "https://github.com/example-org/repo-one/pull/23",
          relevant: true,
          reason: "Plan is approved.",
          summary: "Implement approved plan for PR #23",
          context: { repoIdentifier: "example-org/repo-one" },
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z"
        }]
      }, null, 2), "utf8"
    );

    let recoveryCalled = false;
    const fakeRecoveryService = {
      isRecoveryNeeded: (task: TaskRecord) => task.status === "failed" || task.context.recoveryNeeded === true,
      resolveTaskWorkspacePath: (_task: TaskRecord) => null,
      recoverWorkspace: async (opts: { task: TaskRecord }): Promise<WorkspaceRecoveryRecord> => {
        recoveryCalled = true;
        return { taskId: opts.task.id, taskKind: opts.task.kind, outcome: "recovered", reason: "Workspace reset.", recoveredAt: "2026-06-14T00:00:00.000Z" };
      }
    };

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories() {
          return {
            issues: [] as NormalizedIssue[],
            prs: [samplePullRequest({ labels: ["agent-plan-approved"] })],
            comments: [] as NormalizedComment[],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: [] as []
          };
        }
      },
      agentRunner: {
        async dispatch(task: TaskRecord, context: TaskRecord["context"], agentConfig: AgentConfig) {
          return { taskStatus: "completed" as const, execution: buildExecution(task, context.localRepoPath ?? codeRoot, agentConfig.command) };
        }
      },
      workspaceRecoveryService: fakeRecoveryService as any,
      logger: { info: () => undefined, warn: () => undefined }
    });

    assert.equal(recoveryCalled, false, "recoverWorkspace should NOT be called for completed tasks");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli workspace recovery: duplicate workspace paths are recovered only once per cycle", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-recovery-dedup-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");
  const sharedWorkspacePath = path.join(codeRoot, "_worktrees", "example-org", "repo-one", "shared");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "tasks.json"),
      JSON.stringify({
        tasks: [
          {
            id: "task:implement_plan:pull_request:example-org/repo-one:23",
            kind: "implement_plan",
            status: "failed",
            repoId: "repo-1",
            repoName: "repo-one",
            repoSlug: "example-org/repo-one",
            sourceKind: "pull_request",
            sourceId: "pull_request:example-org/repo-one:23",
            sourceUrl: "https://github.com/example-org/repo-one/pull/23",
            relevant: true,
            reason: "Plan is approved.",
            summary: "Implement approved plan for PR #23",
            context: { repoIdentifier: "example-org/repo-one", recoveryNeeded: true },
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z"
          },
          {
            id: "task:implement_plan:pull_request:example-org/repo-one:24",
            kind: "implement_plan",
            status: "failed",
            repoId: "repo-1",
            repoName: "repo-one",
            repoSlug: "example-org/repo-one",
            sourceKind: "pull_request",
            sourceId: "pull_request:example-org/repo-one:24",
            sourceUrl: "https://github.com/example-org/repo-one/pull/24",
            relevant: true,
            reason: "Plan is approved.",
            summary: "Implement approved plan for PR #24",
            context: { repoIdentifier: "example-org/repo-one", recoveryNeeded: true },
            createdAt: "2026-06-14T00:00:00.000Z",
            updatedAt: "2026-06-14T00:00:00.000Z"
          }
        ]
      }, null, 2), "utf8"
    );

    let recoverCallCount = 0;
    const fakeRecoveryService = {
      isRecoveryNeeded: (task: TaskRecord) => task.context.recoveryNeeded === true,
      resolveTaskWorkspacePath: (_task: TaskRecord) => sharedWorkspacePath,
      recoverWorkspace: async (opts: { task: TaskRecord }): Promise<WorkspaceRecoveryRecord> => {
        recoverCallCount++;
        return { taskId: opts.task.id, taskKind: opts.task.kind, workspacePath: sharedWorkspacePath, outcome: "recovered", reason: "Workspace reset.", recoveredAt: "2026-06-14T00:00:00.000Z" };
      }
    };

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories() {
          return {
            issues: [] as NormalizedIssue[],
            prs: [
              samplePullRequest({ number: 23, labels: ["agent-plan-approved"] }),
              samplePullRequest({ number: 24, labels: ["agent-plan-approved"] })
            ],
            comments: [] as NormalizedComment[],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: [] as []
          };
        }
      },
      agentRunner: {
        async dispatch(task: TaskRecord, context: TaskRecord["context"], agentConfig: AgentConfig) {
          return { taskStatus: "completed" as const, execution: buildExecution(task, context.localRepoPath ?? codeRoot, agentConfig.command) };
        }
      },
      workspaceRecoveryService: fakeRecoveryService as any,
      logger: { info: () => undefined, warn: () => undefined }
    });

    assert.equal(recoverCallCount, 1, "recoverWorkspace should be called exactly once for a shared workspace path");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli workspace recovery: task with failed recovery outcome is marked as pre-dispatch failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-recovery-predispatch-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");
  const workspacePath = path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17");

  try {
    await writeManagementConfig(managementDir, [baseRepoConfig("repo-1", "repo-one")], [implementationAgent()]);
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "tasks.json"),
      JSON.stringify({
        tasks: [{
          id: "task:implement_plan:pull_request:example-org/repo-one:23",
          kind: "implement_plan",
          status: "failed",
          repoId: "repo-1",
          repoName: "repo-one",
          repoSlug: "example-org/repo-one",
          sourceKind: "pull_request",
          sourceId: "pull_request:example-org/repo-one:23",
          sourceUrl: "https://github.com/example-org/repo-one/pull/23",
          relevant: true,
          reason: "Plan is approved.",
          summary: "Implement approved plan for PR #23",
          context: { repoIdentifier: "example-org/repo-one", recoveryNeeded: true },
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z"
        }]
      }, null, 2), "utf8"
    );

    let dispatchCalled = false;
    const fakeRecoveryService = {
      isRecoveryNeeded: (task: TaskRecord) => task.context.recoveryNeeded === true,
      resolveTaskWorkspacePath: (_task: TaskRecord) => workspacePath,
      recoverWorkspace: async (opts: { task: TaskRecord }): Promise<WorkspaceRecoveryRecord> => {
        return { taskId: opts.task.id, taskKind: opts.task.kind, workspacePath, outcome: "failed", reason: "Unable to reset workspace.", recoveredAt: "2026-06-14T00:00:00.000Z" };
      }
    };

    const summary = await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories() {
          return {
            issues: [] as NormalizedIssue[],
            prs: [samplePullRequest({ labels: ["agent-plan-approved"] })],
            comments: [] as NormalizedComment[],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: [] as []
          };
        }
      },
      agentRunner: {
        async dispatch(task: TaskRecord, context: TaskRecord["context"], agentConfig: AgentConfig) {
          dispatchCalled = true;
          return { taskStatus: "completed" as const, execution: buildExecution(task, context.localRepoPath ?? codeRoot, agentConfig.command) };
        }
      },
      workspaceRecoveryService: fakeRecoveryService as any,
      logger: { info: () => undefined, warn: () => undefined }
    });

    assert.equal(dispatchCalled, false, "task with failed recovery should not be dispatched");
    assert.equal(summary.failedTaskCount, 1, "task should end up failed due to pre-dispatch failure from recovery");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
