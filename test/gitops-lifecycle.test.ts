import { test } from "node:test";
import * as assert from "node:assert/strict";
import { GitOpsLifecycleService } from "../src/git/gitops-lifecycle.js";
import type { GitGateway, BranchSyncComparison } from "../src/git/types.js";

class MockGitGateway implements GitGateway {
  async resetHard() {}
  async cleanUntrackedFiles() {}
  calls: string[] = [];
  isInsideWorkingTreeResult = true;
  isWorkingTreeCleanResult = true;
  getCurrentBranchResult: string | null = "main";
  commitAllResult = true;
  getHeadCommitShaResult = "abc123456789";

  async cloneRepository(): Promise<void> {}
  async fetchRepository(): Promise<void> {}
  async getCurrentBranch(): Promise<string | null> {
    this.calls.push("getCurrentBranch");
    return this.getCurrentBranchResult;
  }
  async getRemoteDefaultBranch(): Promise<string> { return "main"; }
  async isWorkingTreeClean(): Promise<boolean> {
    this.calls.push("isWorkingTreeClean");
    return this.isWorkingTreeCleanResult;
  }
  async ensureDefaultBranchCheckedOut(): Promise<void> {}
  async fastForwardDefaultBranch(): Promise<void> {}
  validatePathWithinCodeRoot(_: string, p: string): string { return p; }
  async compareBranchSyncStatus(): Promise<BranchSyncComparison> {
    throw new Error("not implemented");
  }
  async createWorktree(): Promise<string> { return "path"; }
  async hasCommitsAhead(): Promise<boolean> { return false; }
  async commitAll(_: string, message: string): Promise<boolean> {
    this.calls.push(`commitAll:${message}`);
    return this.commitAllResult;
  }
  async pushBranch(_: string, branch: string): Promise<void> {
    this.calls.push(`pushBranch:${branch}`);
  }
  async checkoutBranch(): Promise<void> {}
  async mergeRemoteBranch(): Promise<void> {}
  async abortMerge(): Promise<void> {}
  async abortRebase(): Promise<void> {}
  async abortCherryPick(): Promise<void> {}
  async abortRevert(): Promise<void> {}
  async isInsideWorkingTree(): Promise<boolean> {
    this.calls.push("isInsideWorkingTree");
    return this.isInsideWorkingTreeResult;
  }
  async pullFastForwardOnly(): Promise<void> {
    this.calls.push("pullFastForwardOnly");
  }
  async getHeadCommitSha(): Promise<string> {
    this.calls.push("getHeadCommitSha");
    return this.getHeadCommitShaResult;
  }

  async cloneRepositoryFromUrl(): Promise<void> {}
  async checkoutBranchAtRemote(_path?: string, _branch?: string, _options?: { skipFetch?: boolean }): Promise<void> {}
  async getAheadBehindVsRemote(): Promise<{ ahead: number; behind: number }> {
    return { ahead: 0, behind: 0 };
  }
  async isAncestorOf(): Promise<boolean> { return true; }
  async countCommitsAheadOf(): Promise<number> { return 0; }
  async getActiveMergeState(): Promise<"none" | "merging" | "rebasing" | "cherry-picking" | "reverting"> {
    return "none";
  }
  async pushWithLease(): Promise<void> {}
  async removeDirectory(): Promise<void> {}
  async getCommitLogSince(): Promise<string> { return ""; }
  async getDiffStatSince(): Promise<string> { return ""; }

  async listWorktrees(): Promise<{ path: string; branch: string }[]> {
    return [];
  }

  async getWorktreeForBranch(): Promise<string | null> {
    return null;
  }
}

test("GitOpsLifecycleService.prepareManagementRoot: skips if not a Git repo", async () => {
  const git = new MockGitGateway();
  git.isInsideWorkingTreeResult = false;
  const service = new GitOpsLifecycleService(git);
  const result = await service.prepareManagementRoot("dir");
  assert.equal(result.status, "skipped_not_git");
  assert.deepEqual(git.calls, ["isInsideWorkingTree"]);
});

test("GitOpsLifecycleService.prepareManagementRoot: pulls if clean", async () => {
  const git = new MockGitGateway();
  const service = new GitOpsLifecycleService(git);
  const result = await service.prepareManagementRoot("dir");
  assert.equal(result.status, "pulled");
  assert.deepEqual(git.calls, ["isInsideWorkingTree", "isWorkingTreeClean", "pullFastForwardOnly"]);
});

test("GitOpsLifecycleService.prepareManagementRoot: throws if dirty", async () => {
  const git = new MockGitGateway();
  git.isWorkingTreeCleanResult = false;
  const service = new GitOpsLifecycleService(git);
  await assert.rejects(service.prepareManagementRoot("dir"), /Management directory is dirty/);
});

test("GitOpsLifecycleService.prepareOutputsRoot: skips if not a Git repo", async () => {
  const git = new MockGitGateway();
  git.isInsideWorkingTreeResult = false;
  const service = new GitOpsLifecycleService(git);
  const result = await service.prepareOutputsRoot("dir");
  assert.equal(result.status, "skipped_not_git");
});

test("GitOpsLifecycleService.prepareOutputsRoot: passes if clean", async () => {
  const git = new MockGitGateway();
  const service = new GitOpsLifecycleService(git);
  const result = await service.prepareOutputsRoot("dir");
  assert.equal(result.status, "clean_before_run");
});

test("GitOpsLifecycleService.prepareOutputsRoot: throws if dirty", async () => {
  const git = new MockGitGateway();
  git.isWorkingTreeCleanResult = false;
  const service = new GitOpsLifecycleService(git);
  await assert.rejects(service.prepareOutputsRoot("dir"), /Outputs directory is dirty/);
});

test("GitOpsLifecycleService.finalizeOutputsRoot: skips if prepared as skipped", async () => {
  const git = new MockGitGateway();
  const service = new GitOpsLifecycleService(git);
  const result = await service.finalizeOutputsRoot("dir", "now", { status: "skipped_not_git" });
  assert.equal(result.status, "skipped_not_git");
  assert.equal(git.calls.length, 0);
});

test("GitOpsLifecycleService.finalizeOutputsRoot: commits and pushes if changes exist", async () => {
  const git = new MockGitGateway();
  const service = new GitOpsLifecycleService(git);
  const result = await service.finalizeOutputsRoot("dir", "2026-05-24", { status: "clean_before_run" });
  assert.equal(result.status, "pushed");
  assert.equal(result.commitSha, "abc123456789");
  assert.deepEqual(git.calls, [
    "getCurrentBranch",
    "commitAll:Record orchestrator run 2026-05-24",
    "getHeadCommitSha",
    "pushBranch:main"
  ]);
});

test("GitOpsLifecycleService.finalizeOutputsRoot: returns no_changes if nothing to commit", async () => {
  const git = new MockGitGateway();
  git.commitAllResult = false;
  const service = new GitOpsLifecycleService(git);
  const result = await service.finalizeOutputsRoot("dir", "2026-05-24", { status: "clean_before_run" });
  assert.equal(result.status, "no_changes");
  assert.deepEqual(git.calls, [
    "getCurrentBranch",
    "commitAll:Record orchestrator run 2026-05-24"
  ]);
});

test("GitOpsLifecycleService.finalizeOutputsRoot: throws on detached HEAD", async () => {
  const git = new MockGitGateway();
  git.getCurrentBranchResult = null;
  const service = new GitOpsLifecycleService(git);
  await assert.rejects(
    service.finalizeOutputsRoot("dir", "now", { status: "clean_before_run" }),
    /Outputs directory is in a detached HEAD state/
  );
});
