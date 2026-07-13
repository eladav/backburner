import * as assert from "node:assert/strict";
import { test } from "node:test";
import { LocalParentBranchSyncService } from "../src/workstreams/parent-branch-sync.js";
import type { BranchSyncComparison, GitGateway } from "../src/git/types.js";

class MockGitGateway implements Partial<GitGateway> {
  public fetchRepositoryCalled = 0;
  public isWorkingTreeCleanValue = true;
  public compareBranchSyncStatusValues: BranchSyncComparison[] = [];
  public currentBranchValue: string | null = "original-branch";
  public checkoutBranchCalls: string[] = [];
  public mergeRemoteBranchCalls: { remote: string; branch: string }[] = [];
  public mergeRemoteBranchError: Error | null = null;
  public abortMergeCalled = 0;
  public pushBranchCalls: string[] = [];

  async fetchRepository(_localPath: string): Promise<void> {
    this.fetchRepositoryCalled++;
  }

  async isWorkingTreeClean(_localPath: string): Promise<boolean> {
    return this.isWorkingTreeCleanValue;
  }

  async compareBranchSyncStatus(
    _localPath: string,
    parentBranch: string,
    defaultBranch: string
  ): Promise<BranchSyncComparison> {
    const value = this.compareBranchSyncStatusValues.shift();
    if (!value) {
      return {
        parentBranch,
        defaultBranch,
        parentRef: `refs/remotes/origin/${parentBranch}`,
        defaultRef: `refs/remotes/origin/${defaultBranch}`,
        status: "unknown",
        message: "Mock: no comparison value set"
      };
    }
    return value;
  }

  async getCurrentBranch(_localPath: string): Promise<string | null> {
    return this.currentBranchValue;
  }

  async checkoutBranch(_localPath: string, branch: string): Promise<void> {
    this.checkoutBranchCalls.push(branch);
    if (this.onCheckoutBranch) {
      this.onCheckoutBranch(branch);
    }
  }

  public onCheckoutBranch?: (branch: string) => void;

  async mergeRemoteBranch(_localPath: string, remote: string, branch: string): Promise<void> {
    this.mergeRemoteBranchCalls.push({ remote, branch });
    if (this.mergeRemoteBranchError) {
      throw this.mergeRemoteBranchError;
    }
  }

  async abortMerge(_localPath: string): Promise<void> {
    this.abortMergeCalled++;
  }

  async getWorktreeForBranch(_localPath: string, _branch: string): Promise<string | null> {
    return null;
  }

  async pushBranch(_localPath: string, branch: string): Promise<void> {
    this.pushBranchCalls.push(branch);
  }
}

test("LocalParentBranchSyncService.syncParentBranch: already_up_to_date", async () => {
  const git = new MockGitGateway();
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "up_to_date",
      message: "Up to date"
    }
  ];
  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "already_up_to_date");
  assert.strictEqual(git.fetchRepositoryCalled, 1);
  assert.strictEqual(git.checkoutBranchCalls.length, 0);
});

test("LocalParentBranchSyncService.syncParentBranch: blocked (dirty tree)", async () => {
  const git = new MockGitGateway();
  git.isWorkingTreeCleanValue = false;
  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "blocked");
  assert.strictEqual(result.message, "Working tree is dirty; refusing to sync parent branch.");
  assert.strictEqual(git.checkoutBranchCalls.length, 0);
});

test("LocalParentBranchSyncService.syncParentBranch: blocked (missing parent)", async () => {
  const git = new MockGitGateway();
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "missing_parent_branch",
      message: "Missing parent"
    }
  ];
  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "blocked");
  assert.strictEqual(result.message, "Missing parent");
  assert.strictEqual(git.checkoutBranchCalls.length, 0);
});

test("LocalParentBranchSyncService.syncParentBranch: synced (happy path)", async () => {
  const git = new MockGitGateway();
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "behind_default",
      message: "Behind"
    },
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "up_to_date",
      message: "Up to date"
    }
  ];
  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "synced");
  assert.deepEqual(git.checkoutBranchCalls, ["parent", "original-branch"]);
  assert.deepEqual(git.mergeRemoteBranchCalls, [
    { remote: "origin", branch: "parent" },
    { remote: "origin", branch: "main" }
  ]);
  assert.deepEqual(git.pushBranchCalls, ["parent"]);
  assert.strictEqual(git.fetchRepositoryCalled, 2);
  assert.strictEqual(git.abortMergeCalled, 0);
});

test("LocalParentBranchSyncService.syncParentBranch: conflict during pre-merge", async () => {
  const git = new MockGitGateway();
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "behind_default",
      message: "Behind"
    }
  ];
  git.mergeRemoteBranchError = new Error("CONFLICT (content): Merge conflict in file.ts");
  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "conflict");
  assert.ok(result.message.includes("pre-merging parent branch from remote"));
  assert.strictEqual(git.abortMergeCalled, 1);
  assert.deepEqual(git.checkoutBranchCalls, ["parent", "original-branch"]);
  assert.deepEqual(git.mergeRemoteBranchCalls, [
    { remote: "origin", branch: "parent" }
  ]);
});

test("LocalParentBranchSyncService.syncParentBranch: conflict during sync merge", async () => {
  const git = new MockGitGateway();
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "diverged",
      message: "Diverged"
    }
  ];

  // We want to succeed on the first merge (origin/parent) but fail on the second (origin/main)
  let callCount = 0;
  git.mergeRemoteBranch = async (_localPath: string, remote: string, branch: string) => {
    git.mergeRemoteBranchCalls.push({ remote, branch });
    callCount++;
    if (callCount === 2) {
      throw new Error("CONFLICT (content): Merge conflict in other-file.ts");
    }
  };

  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "conflict");
  assert.ok(result.message.includes("syncing parent branch with default branch"));
  assert.strictEqual(git.abortMergeCalled, 1);
  assert.deepEqual(git.checkoutBranchCalls, ["parent", "original-branch"]);
  assert.deepEqual(git.mergeRemoteBranchCalls, [
    { remote: "origin", branch: "parent" },
    { remote: "origin", branch: "main" }
  ]);
});

test("LocalParentBranchSyncService.syncParentBranch: non-conflict failure during pre-merge", async () => {
  const git = new MockGitGateway();
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "behind_default",
      message: "Behind"
    }
  ];
  git.mergeRemoteBranchError = new Error("Generic network error");
  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "failed");
  assert.ok(result.message.includes("Merge failed while pre-merging"));
  assert.strictEqual(git.abortMergeCalled, 1);
  assert.deepEqual(git.checkoutBranchCalls, ["parent", "original-branch"]);
});

test("LocalParentBranchSyncService.syncParentBranch: failed (sync didn't result in up_to_date)", async () => {
  const git = new MockGitGateway();
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "behind_default",
      message: "Behind"
    },
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "diverged",
      message: "Still diverged somehow"
    }
  ];
  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "failed");
  assert.ok(result.message.includes("Still diverged somehow"));
  assert.deepEqual(git.checkoutBranchCalls, ["parent", "original-branch"]);
});

test("LocalParentBranchSyncService.syncParentBranch: already on parent branch (no redundant checkout)", async () => {
  const git = new MockGitGateway();
  git.currentBranchValue = "parent";
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "behind_default",
      message: "Behind"
    },
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "up_to_date",
      message: "Up to date"
    }
  ];
  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "synced");
  // No checkout because already on parent
  assert.deepEqual(git.checkoutBranchCalls, []);
});

test("LocalParentBranchSyncService.syncParentBranch: returns failed if working tree is dirty after restoring original branch", async () => {
  const git = new MockGitGateway();
  git.currentBranchValue = "original-branch";
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "behind_default",
      message: "Behind"
    },
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "up_to_date",
      message: "Up to date"
    }
  ];

  // We want to simulate that when we checkout back to original-branch, the tree becomes dirty
  git.onCheckoutBranch = (branch) => {
    if (branch === "original-branch") {
      git.isWorkingTreeCleanValue = false;
    }
  };

  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "failed", "Expected status to be 'failed' because working tree is dirty after cleanup");
  assert.ok(result.message.includes("dirty"), "Expected message to mention dirty working tree");
});

test("LocalParentBranchSyncService.syncParentBranch: blocked if parent branch worktree is dirty", async () => {
  const git = new MockGitGateway();
  git.isWorkingTreeCleanValue = true; // localPath is clean
  git.compareBranchSyncStatusValues = [
    {
      parentBranch: "parent",
      defaultBranch: "main",
      parentRef: "ref",
      defaultRef: "ref",
      status: "behind_default",
      message: "Behind"
    }
  ];

  const parentWorktreePath = "/other/worktree";
  git.getWorktreeForBranch = async (_path, branch) => {
    if (branch === "parent") return parentWorktreePath;
    return null;
  };

  // Mock isWorkingTreeClean to return false only for the parent worktree
  git.isWorkingTreeClean = async (path: string) => {
    if (path === parentWorktreePath) return false;
    return true;
  };

  const service = new LocalParentBranchSyncService(git as any);
  const result = await service.syncParentBranch("/tmp", "parent", "main");

  assert.strictEqual(result.status, "blocked", "Expected status to be 'blocked' because parent worktree is dirty");
  assert.ok(result.message.includes("dirty"), "Expected message to mention dirty working tree");
});
