import * as assert from "node:assert/strict";
import { test, describe, mock } from "node:test";
import * as path from "node:path";
import { rm, mkdir } from "node:fs/promises";
import {
  executeParentBranchSyncActions,
  type ParentBranchSyncActionOptions
} from "../src/workstreams/parent-branch-sync-action.js";
import type { TaskRecord } from "../src/state/types.js";
import type { ParentBranchSyncService, ParentBranchSyncResult } from "../src/workstreams/parent-branch-sync.js";
import type { GitGateway, BranchSyncComparison } from "../src/git/types.js";
import type { GitHubGateway } from "../src/github/types.js";
import type { StateStore } from "../src/state/loader.js";

const TEMP_LOG_DIR = path.join(process.cwd(), "test-logs-sync-action");

async function setup() {
  await rm(TEMP_LOG_DIR, { recursive: true, force: true });
  await mkdir(TEMP_LOG_DIR, { recursive: true });
}

async function teardown() {
  await rm(TEMP_LOG_DIR, { recursive: true, force: true });
}

describe("executeParentBranchSyncActions", () => {
  test("ignores non-sync_parent_branch/non-pending/irrelevant tasks", async () => {
    await setup();
    const tasks: TaskRecord[] = [
      {
        id: "t1",
        kind: "respond_issue_comment",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "r",
        repoSlug: "o/r",
        sourceKind: "comment",
        sourceId: "c1",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: {} as any,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01"
      },
      {
        id: "t2",
        kind: "sync_parent_branch",
        status: "completed",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "r",
        repoSlug: "o/r",
        sourceKind: "comment",
        sourceId: "c2",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: {} as any,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01"
      },
      {
        id: "t3",
        kind: "sync_parent_branch",
        status: "pending",
        relevant: false,
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "r",
        repoSlug: "o/r",
        sourceKind: "comment",
        sourceId: "c3",
        sourceUrl: "url",
        reason: "r",
        summary: "s",
        context: {} as any,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01"
      },
    ];

    const service: ParentBranchSyncService = {
      syncParentBranch: mock.fn(async () => ({ status: "synced", message: "ok" }))
    };

    const options: ParentBranchSyncActionOptions = {
      tasks,
      executions: [],
      parentBranchSyncService: service,
      gitGateway: {} as any,
      gitHubGateway: {} as any,
      stateStore: {
        writeExecutionState: mock.fn(),
        writeTaskState: mock.fn()
      } as any,
      logDir: TEMP_LOG_DIR,
    };

    const result = await executeParentBranchSyncActions(options);

    assert.strictEqual((service.syncParentBranch as any).mock.callCount(), 0);
    assert.strictEqual(result.tasks.length, 3);
    assert.deepEqual(result.executions, []);
    await teardown();
  });

  test("refuses malformed tasks (missing preflight, missing local path) without calling sync service", async () => {
    await setup();
    const tasks: TaskRecord[] = [
      {
        id: "t1",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "r",
        repoSlug: "o/r",
        sourceKind: "comment",
        sourceId: "c1",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: {} as any,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01"
      },
      {
        id: "t2",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "r",
        repoSlug: "o/r",
        sourceKind: "comment",
        sourceId: "c2",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: { preflight: {} } as any,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01"
      },
    ];

    const service: ParentBranchSyncService = {
      syncParentBranch: mock.fn()
    };

    const options: ParentBranchSyncActionOptions = {
      tasks,
      executions: [],
      parentBranchSyncService: service,
      gitGateway: {} as any,
      gitHubGateway: {} as any,
      stateStore: {
        writeExecutionState: mock.fn(),
        writeTaskState: mock.fn()
      } as any,
      logDir: TEMP_LOG_DIR,
    };

    const result = await executeParentBranchSyncActions(options);

    assert.strictEqual((service.syncParentBranch as any).mock.callCount(), 0);
    assert.strictEqual(result.tasks[0]?.status, "failed");
    assert.strictEqual(result.tasks[1]?.status, "failed");
    assert.strictEqual(result.executions.length, 2);
    await teardown();
  });

  test("invokes ParentBranchSyncService exactly once for a valid task", async () => {
    await setup();
    const tasks: TaskRecord[] = [
      {
        id: "t1",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "r",
        repoSlug: "o/r",
        sourceKind: "comment",
        sourceId: "c1",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: {
          localRepoPath: "/tmp/repo",
          preflight: {
            parentIntegrationBranch: "feature",
            defaultBranch: "main",
            parentPrNumber: 123
          }
        } as any,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01"
      },
    ];

    const service: ParentBranchSyncService = {
      syncParentBranch: mock.fn(async () => ({ status: "synced", message: "ok" }))
    };

    const gitGateway: GitGateway = {
      compareBranchSyncStatus: mock.fn(async () => ({} as any))
    } as any;

    const gitHubGateway: GitHubGateway = {
      postIssueComment: mock.fn(async () => ({} as any))
    } as any;

    const options: ParentBranchSyncActionOptions = {
      tasks,
      executions: [],
      parentBranchSyncService: service,
      gitGateway,
      gitHubGateway,
      stateStore: {
        writeExecutionState: mock.fn(),
        writeTaskState: mock.fn()
      } as any,
      logDir: TEMP_LOG_DIR,
    };

    await executeParentBranchSyncActions(options);

    assert.strictEqual((service.syncParentBranch as any).mock.callCount(), 1);
    const call = (service.syncParentBranch as any).mock.calls[0];
    assert.deepEqual(call.arguments, ["/tmp/repo", "feature", "main"]);
    await teardown();
  });

  test("persists completed for synced/already_up_to_date and failed for others", async () => {
    await setup();
    const tasks: TaskRecord[] = [
      {
        id: "t1",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "r1",
        repoSlug: "o/r1",
        sourceKind: "comment",
        sourceId: "c1",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: { localRepoPath: "/tmp/r1", preflight: { parentIntegrationBranch: "p", defaultBranch: "d", parentPrNumber: 123 } } as any,
        createdAt: "1",
        updatedAt: "1"
      },
      {
        id: "t2",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r2",
        repoName: "r2",
        repoSlug: "o/r2",
        sourceKind: "comment",
        sourceId: "c2",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: { localRepoPath: "/tmp/r2", preflight: { parentIntegrationBranch: "p", defaultBranch: "d", parentPrNumber: 123 } } as any,
        createdAt: "1",
        updatedAt: "1"
      },
      {
        id: "t3",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r3",
        repoName: "r3",
        repoSlug: "o/r3",
        sourceKind: "comment",
        sourceId: "c3",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: { localRepoPath: "/tmp/r3", preflight: { parentIntegrationBranch: "p", defaultBranch: "d", parentPrNumber: 123 } } as any,
        createdAt: "1",
        updatedAt: "1"
      },
    ];

    const serviceResults: ParentBranchSyncResult[] = [
      { status: "synced", message: "ok" },
      { status: "already_up_to_date", message: "ok" },
      { status: "conflict", message: "ouch" },
    ];

    const service: ParentBranchSyncService = {
      syncParentBranch: mock.fn(async () => serviceResults.shift()!)
    };

    const options: ParentBranchSyncActionOptions = {
      tasks,
      executions: [],
      parentBranchSyncService: service,
      gitGateway: { compareBranchSyncStatus: mock.fn(async () => ({} as any)) } as any,
      gitHubGateway: { postIssueComment: mock.fn(async () => ({} as any)) } as any,
      stateStore: {
        writeExecutionState: mock.fn(),
        writeTaskState: mock.fn()
      } as any,
      logDir: TEMP_LOG_DIR,
    };

    const result = await executeParentBranchSyncActions(options);

    assert.strictEqual(result.tasks[0]?.status, "completed");
    assert.strictEqual(result.tasks[1]?.status, "completed");
    assert.strictEqual(result.tasks[2]?.status, "failed");
    await teardown();
  });

  test("captures before/after comparisons and verifies comment body", async () => {
    await setup();
    const beforeComparison: BranchSyncComparison = {
      parentBranch: "feature",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "behind_default",
      parentAheadCount: 0,
      parentBehindCount: 5,
      message: "Behind by 5"
    };
    const afterComparison: BranchSyncComparison = {
      parentBranch: "feature",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "up_to_date",
      parentAheadCount: 0,
      parentBehindCount: 0,
      message: "Up to date"
    };

    const tasks: TaskRecord[] = [
      {
        id: "t1",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "repo",
        repoSlug: "owner/repo",
        sourceKind: "comment",
        sourceId: "c1",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: {
          localRepoPath: "/tmp/repo",
          preflight: {
            parentIntegrationBranch: "feature",
            defaultBranch: "main",
            parentPrNumber: 42
          }
        } as any,
        createdAt: "1",
        updatedAt: "1"
      },
    ];

    const service: ParentBranchSyncService = {
      syncParentBranch: mock.fn(async () => ({ status: "synced", message: "Successfully synced" }))
    };

    let callCount = 0;
    const gitGateway: GitGateway = {
      compareBranchSyncStatus: mock.fn(async () => {
        callCount++;
        return callCount === 1 ? beforeComparison : afterComparison;
      })
    } as any;

    const gitHubGateway: GitHubGateway = {
      postIssueComment: mock.fn(async () => ({} as any))
    } as any;

    const options: ParentBranchSyncActionOptions = {
      tasks,
      executions: [],
      parentBranchSyncService: service,
      gitGateway,
      gitHubGateway,
      stateStore: {
        writeExecutionState: mock.fn(),
        writeTaskState: mock.fn()
      } as any,
      logDir: TEMP_LOG_DIR,
    };

    await executeParentBranchSyncActions(options);

    assert.strictEqual((gitGateway.compareBranchSyncStatus as any).mock.callCount(), 2);
    assert.strictEqual((gitHubGateway.postIssueComment as any).mock.callCount(), 1);

    const commentCall = (gitHubGateway.postIssueComment as any).mock.calls[0];
    const body = commentCall.arguments[0].body;
    assert.ok(body.startsWith("🤖"));
    assert.ok(body.includes("Attempted to merge the default branch (`main`) into the parent branch (`feature`) through the git sync service, with no rebase or force push."));
    assert.ok(body.includes("Pre-attempt status"));
    assert.ok(body.includes("behind_default"));
    assert.ok(body.includes("Post-attempt status"));
    assert.ok(body.includes("up_to_date"));
    assert.ok(body.includes("Successfully synced"));
    await teardown();
  });

  test("reports unknown post-attempt status when after-comparison fails", async () => {
    await setup();
    const tasks: TaskRecord[] = [
      {
        id: "t1",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "repo",
        repoSlug: "owner/repo",
        sourceKind: "comment",
        sourceId: "c1",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: {
          localRepoPath: "/tmp/repo",
          preflight: {
            parentIntegrationBranch: "feature",
            defaultBranch: "main",
            parentPrNumber: 42
          }
        } as any,
        createdAt: "1",
        updatedAt: "1"
      },
    ];

    const service: ParentBranchSyncService = {
      syncParentBranch: mock.fn(async () => ({ status: "synced", message: "ok" }))
    };

    const gitGateway: GitGateway = {
      compareBranchSyncStatus: mock.fn(async (path, branch) => {
        if (branch === "feature") {
          throw new Error("Compare failed");
        }
        return {} as any;
      })
    } as any;

    const gitHubGateway: GitHubGateway = {
      postIssueComment: mock.fn(async () => ({} as any))
    } as any;

    const options: ParentBranchSyncActionOptions = {
      tasks,
      executions: [],
      parentBranchSyncService: service,
      gitGateway,
      gitHubGateway,
      stateStore: {
        writeExecutionState: mock.fn(),
        writeTaskState: mock.fn()
      } as any,
      logDir: TEMP_LOG_DIR,
    };

    await executeParentBranchSyncActions(options);

    const commentCall = (gitHubGateway.postIssueComment as any).mock.calls[0];
    const body = commentCall.arguments[0].body;
    assert.ok(body.includes("- **Post-attempt status**: `unknown` (comparison failed or unavailable)"));
    assert.ok(body.includes("Wave advancement remains blocked because the branch status could not be verified after the attempt."));
    await teardown();
  });

  test("confirming a GitHub publication failure does not discard a recorded outcome", async () => {
    await setup();
    const tasks: TaskRecord[] = [
      {
        id: "t1",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "r",
        repoSlug: "o/r",
        sourceKind: "comment",
        sourceId: "c1",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: {
          localRepoPath: "/tmp/repo",
          preflight: {
            parentIntegrationBranch: "feature",
            defaultBranch: "main",
            parentPrNumber: 123
          }
        } as any,
        createdAt: "1",
        updatedAt: "1"
      },
    ];

    const service: ParentBranchSyncService = {
      syncParentBranch: mock.fn(async () => ({ status: "synced", message: "ok" }))
    };

    const gitHubGateway: GitHubGateway = {
      postIssueComment: mock.fn(async () => {
        throw new Error("GitHub is down");
      })
    } as any;

    const stateStore: StateStore = {
      writeExecutionState: mock.fn(),
      writeTaskState: mock.fn()
    } as any;

    const options: ParentBranchSyncActionOptions = {
      tasks,
      executions: [],
      parentBranchSyncService: service,
      gitGateway: { compareBranchSyncStatus: mock.fn(async () => ({} as any)) } as any,
      gitHubGateway,
      stateStore,
      logDir: TEMP_LOG_DIR,
    };

    const result = await executeParentBranchSyncActions(options);

    assert.strictEqual(result.tasks[0]?.status, "completed");
    assert.strictEqual(result.executions.length, 1);
    assert.strictEqual((stateStore.writeTaskState as any).mock.callCount(), 1);
    assert.strictEqual((stateStore.writeExecutionState as any).mock.callCount(), 1);
    assert.strictEqual((gitHubGateway.postIssueComment as any).mock.callCount(), 1);
    await teardown();
  });

  test("reports unknown post-attempt status and blocked advancement when local path is missing", async () => {
    await setup();
    const tasks: TaskRecord[] = [
      {
        id: "t1",
        kind: "sync_parent_branch",
        status: "pending",
        executionPermission: "workspace-write",
        handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
        repoId: "r1",
        repoName: "repo",
        repoSlug: "owner/repo",
        sourceKind: "comment",
        sourceId: "c1",
        sourceUrl: "url",
        relevant: true,
        reason: "r",
        summary: "s",
        context: {
          // missing localRepoPath
          preflight: {
            parentIntegrationBranch: "feature",
            defaultBranch: "main",
            parentPrNumber: 42
          }
        } as any,
        createdAt: "1",
        updatedAt: "1"
      },
    ];

    const gitHubGateway: GitHubGateway = {
      postIssueComment: mock.fn(async () => ({} as any))
    } as any;

    const options: ParentBranchSyncActionOptions = {
      tasks,
      executions: [],
      parentBranchSyncService: {} as any,
      gitGateway: {} as any,
      gitHubGateway,
      stateStore: {
        writeExecutionState: mock.fn(),
        writeTaskState: mock.fn()
      } as any,
      logDir: TEMP_LOG_DIR,
    };

    await executeParentBranchSyncActions(options);

    const commentCall = (gitHubGateway.postIssueComment as any).mock.calls[0];
    const body = commentCall.arguments[0].body;
    assert.ok(body.includes("- **Action**: Could not attempt merge (precondition failed)"));
    assert.ok(body.includes("- **Post-attempt status**: `unknown` (comparison failed or unavailable)"));
    assert.ok(body.includes("Wave advancement remains blocked because the branch status could not be verified after the attempt."));
    await teardown();
  });
});
