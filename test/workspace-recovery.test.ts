import * as assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceRecoveryService } from "../src/worktrees/workspace-recovery.js";
import type { GitGateway } from "../src/git/types.js";
import type { TaskRecord } from "../src/tasks/types.js";

function createMockGitGateway(overrides: Partial<GitGateway> = {}): GitGateway {
  return {
    isInsideWorkingTree: async () => true,
    fetchRepository: async () => {},
    getActiveMergeState: async () => "none",
    getCurrentBranch: async () => "feature-1",
    isWorkingTreeClean: async () => true,
    checkoutBranch: async () => {},
    resetHard: async () => {},
    cleanUntrackedFiles: async () => {},
    abortMerge: async () => {},
    abortRebase: async () => {},
    abortCherryPick: async () => {},
    abortRevert: async () => {},
    ...overrides
  } as unknown as GitGateway;
}

function createTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    kind: "implement_plan",
    status: "failed",
    executionPermission: "workspace-write",
    context: {
      localRepoPath: "/code/_worktrees/repo-1",
      branchName: "feature-1"
    },
    ...overrides
  } as TaskRecord;
}

const codeRoot = "/code";

test("resolveTaskWorkspacePath returns path for implement_plan", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({ kind: "implement_plan" });
  assert.equal(service.resolveTaskWorkspacePath(task), "/code/_worktrees/repo-1");
});

test("resolveTaskWorkspacePath returns path for write_plan", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({ kind: "write_plan" });
  assert.equal(service.resolveTaskWorkspacePath(task), "/code/_worktrees/repo-1");
});

test("resolveTaskWorkspacePath returns path for respond_pr_comment", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({ kind: "respond_pr_comment" });
  assert.equal(service.resolveTaskWorkspacePath(task), "/code/_worktrees/repo-1");
});

test("resolveTaskWorkspacePath returns path for prepare_pr_for_merge", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    kind: "prepare_pr_for_merge",
    context: {
      prepareForMerge: {
        persistentWorktreePath: "/code/_worktrees/merge-1"
      }
    } as any
  });
  assert.equal(service.resolveTaskWorkspacePath(task), "/code/_worktrees/merge-1");
});

test("resolveTaskWorkspacePath returns null for prepare_pr_for_merge without persistent path", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    kind: "prepare_pr_for_merge",
    context: {
      prepareForMerge: {}
    } as any
  });
  assert.equal(service.resolveTaskWorkspacePath(task), null);
});

test("resolveTaskWorkspacePath returns null for read-only tasks", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({ kind: "triage_issue", executionPermission: "read-only" });
  assert.equal(service.resolveTaskWorkspacePath(task), null);
});

test("isRecoveryNeeded returns true for task with recoveryNeeded flag", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    status: "failed",
    context: {
      localRepoPath: "/code/_worktrees/repo-1",
      recoveryNeeded: true
    } as any
  });
  assert.equal(service.isRecoveryNeeded(task), true);
});

test("isRecoveryNeeded returns true for pending task with recoveryNeeded flag", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    status: "pending",
    context: {
      localRepoPath: "/code/_worktrees/repo-1",
      recoveryNeeded: true
    } as any
  });
  assert.equal(service.isRecoveryNeeded(task), true);
});

test("isRecoveryNeeded returns true for failed task without recoveryNeeded flag", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    status: "failed",
    context: {
      localRepoPath: "/code/_worktrees/repo-1"
      // recoveryNeeded missing
    } as any
  });
  assert.equal(service.isRecoveryNeeded(task), true);
});

test("isRecoveryNeeded returns false for task already recovered (one-shot)", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    status: "failed",
    context: {
      localRepoPath: "/code/_worktrees/repo-1",
      recoveryNeeded: false
    } as any
  });
  assert.equal(service.isRecoveryNeeded(task), false);
});

test("isRecoveryNeeded returns true for task with recoveryNeeded: true even if no workspace path", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    kind: "triage_issue",
    status: "failed",
    context: {
      recoveryNeeded: true
    } as any
  });
  assert.equal(service.isRecoveryNeeded(task), true);
});

test("isRecoveryNeeded returns false for failed task without recoveryNeeded: true and without workspace path", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    kind: "triage_issue",
    status: "failed",
    context: {} as any
  });
  assert.equal(service.isRecoveryNeeded(task), false);
});

test("isRecoveryNeeded returns false for pending task without recoveryNeeded flag", () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    status: "pending",
    context: {
      localRepoPath: "/code/_worktrees/repo-1"
    } as any
  });
  assert.equal(service.isRecoveryNeeded(task), false);
});

test("recoverWorkspace recovers a dirty workspace", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    fetchRepository: async () => { calls.push("fetch"); },
    resetHard: async (_path, ref) => { calls.push(`resetHard:${ref}`); },
    cleanUntrackedFiles: async () => { calls.push("clean"); }
  });
  const service = new WorkspaceRecoveryService(() => "2026-06-09T14:00:00Z");
  const task = createTask();

  const result = await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.equal(result.outcome, "recovered");
  assert.equal(result.workspacePath, "/code/_worktrees/repo-1");
  assert.deepEqual(calls, ["fetch", "resetHard:origin/feature-1", "clean"]);
});

test("recoverWorkspace resolves branch for prepare_pr_for_merge from prepareForMerge.headBranch", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    resetHard: async (_path, ref) => { calls.push(`resetHard:${ref}`); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    kind: "prepare_pr_for_merge",
    context: {
      prepareForMerge: {
        persistentWorktreePath: "/code/_worktrees/merge-1",
        headBranch: "pr-head-branch"
      }
    } as any
  });

  await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.ok(calls.includes("resetHard:origin/pr-head-branch"));
});

test("recoverWorkspace aborts merge if in progress", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    getActiveMergeState: async () => "merging",
    abortMerge: async () => { calls.push("abortMerge"); },
    resetHard: async () => { calls.push("resetHard"); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask();

  await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.ok(calls.includes("abortMerge"));
  assert.ok(calls.indexOf("abortMerge") < calls.indexOf("resetHard"));
});

test("recoverWorkspace aborts rebase if in progress", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    getActiveMergeState: async () => "rebasing",
    abortRebase: async () => { calls.push("abortRebase"); },
    resetHard: async () => { calls.push("resetHard"); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask();

  await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.ok(calls.includes("abortRebase"));
  assert.ok(calls.indexOf("abortRebase") < calls.indexOf("resetHard"));
});

test("recoverWorkspace aborts cherry-pick if in progress", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    getActiveMergeState: async () => "cherry-picking",
    abortCherryPick: async () => { calls.push("abortCherryPick"); },
    resetHard: async () => { calls.push("resetHard"); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask();

  await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.ok(calls.includes("abortCherryPick"));
  assert.ok(calls.indexOf("abortCherryPick") < calls.indexOf("resetHard"));
});

test("recoverWorkspace aborts revert if in progress", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    getActiveMergeState: async () => "reverting",
    abortRevert: async () => { calls.push("abortRevert"); },
    resetHard: async () => { calls.push("resetHard"); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask();

  await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.ok(calls.includes("abortRevert"));
  assert.ok(calls.indexOf("abortRevert") < calls.indexOf("resetHard"));
});

test("recoverWorkspace checkouts the correct branch if needed", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    getCurrentBranch: async () => "wrong-branch",
    checkoutBranch: async (_path, branch) => { calls.push(`checkout:${branch}`); },
    resetHard: async () => { calls.push("resetHard"); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask();

  await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.deepEqual(calls, ["checkout:feature-1", "resetHard"]);
});

test("recoverWorkspace rejects path outside codeRoot", async () => {
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    context: {
      localRepoPath: "/etc/passwd",
      branchName: "feature-1"
    } as any
  });
  const gitGateway = createMockGitGateway();

  const result = await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.equal(result.outcome, "rejected");
  assert.match(result.reason, /not within an orchestrator-owned workspace root/);
});

test("recoverWorkspace handles non-git directory", async () => {
  const gitGateway = createMockGitGateway({
    isInsideWorkingTree: async () => false
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask();

  const result = await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /is not a git working tree/);
});

test("recoverWorkspace handles git error", async () => {
  const gitGateway = createMockGitGateway({
    fetchRepository: async () => { throw new Error("Git fetch failed"); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask();

  const result = await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.equal(result.outcome, "failed");
  assert.equal(result.reason, "Git fetch failed");
});

test("recoverWorkspace falls back to current branch when task has no branchName", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    getCurrentBranch: async () => "main",
    resetHard: async (_path, ref) => { calls.push(`resetHard:${ref}`); },
    checkoutBranch: async (_path, branch) => { calls.push(`checkout:${branch}`); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    context: { localRepoPath: "/code/_worktrees/repo-1" } as any
  });

  const result = await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.equal(result.outcome, "recovered");
  assert.deepEqual(calls, ["resetHard:origin/main"]); // No checkout since currentBranch === fallback branch
});

test("recoverWorkspace fails explicitly on detached HEAD with no branchName", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    getCurrentBranch: async () => null,
    resetHard: async () => { calls.push("resetHard"); },
    cleanUntrackedFiles: async () => { calls.push("clean"); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    context: { localRepoPath: "/code/_worktrees/repo-1" } as any
  });

  const result = await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /detached HEAD/);
  assert.ok(!calls.includes("resetHard"));
  assert.ok(!calls.includes("clean"));
});

test("recoverWorkspace fails when fallback branch has no remote ref", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    getCurrentBranch: async () => "main",
    resetHard: async () => {
      throw new Error("unknown revision or path not in the working tree: origin/main");
    },
    cleanUntrackedFiles: async () => { calls.push("clean"); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    context: { localRepoPath: "/code/_worktrees/repo-1" } as any
  });

  const result = await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /unknown revision/);
  assert.ok(!calls.includes("clean"));
});

test("recoverWorkspace falls back to current branch for prepare_pr_for_merge without headBranch", async () => {
  const calls: string[] = [];
  const gitGateway = createMockGitGateway({
    getCurrentBranch: async () => "pr-head-branch",
    resetHard: async (_path, ref) => { calls.push(`resetHard:${ref}`); }
  });
  const service = new WorkspaceRecoveryService();
  const task = createTask({
    kind: "prepare_pr_for_merge",
    context: {
      prepareForMerge: {
        persistentWorktreePath: "/code/_worktrees/merge-1"
      }
    } as any
  });

  const result = await service.recoverWorkspace({ task, codeRoot, gitGateway });

  assert.equal(result.outcome, "recovered");
  assert.ok(calls.includes("resetHard:origin/pr-head-branch"));
});
