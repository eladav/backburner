import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { LocalRepoSyncService } from "../src/git/types.js";

const repo = {
  id: "repo-1",
  owner: "owner",
  name: "repo-one",
  localPath: "repo-one",
  defaultBranch: "main",
  enabled: true,
  labels: {
    agentInProgress: "agent-in-progress",
    agentProductApproved: "agent-product-approved",
    agentPlanApproved: "agent-plan-approved",
    agentReview: "agent-review",
    planBreakdownNeeded: "plan-breakdown-needed",
    agentSyncParentBranch: "agent-sync-parent-branch",
    prepareForMerge: "prepare-for-merge"
  }
} as const;

function gitGateway(overrides: Record<string, unknown> = {}) {
  return {
    fetchRepository: async () => {},
    getCurrentBranch: async () => "main",
    isWorkingTreeClean: async () => true,
    ensureDefaultBranchCheckedOut: async () => {},
    fastForwardDefaultBranch: async () => {},
    ...overrides
  };
}

test("LocalRepoSyncService records fetched false when fetch fails", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-sync-"));
  await mkdir(path.join(codeRoot, repo.localPath));
  try {
    const service = new LocalRepoSyncService(
      gitGateway({ fetchRepository: async () => { throw new Error("fetch failed"); } }) as any,
      {} as any
    );

    const result = await service.syncRepository(repo, codeRoot);

    assert.equal(result.status, "failed");
    assert.equal(result.fetched, false);
    assert.equal(result.defaultBranchSyncStatus, "failed");
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("LocalRepoSyncService records fetched true when checkout synchronization fails after fetch", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-sync-"));
  await mkdir(path.join(codeRoot, repo.localPath));
  try {
    const service = new LocalRepoSyncService(
      gitGateway({ isWorkingTreeClean: async () => false }) as any,
      {} as any
    );

    const result = await service.syncRepository(repo, codeRoot);

    assert.equal(result.status, "failed");
    assert.equal(result.fetched, true);
    assert.equal(result.defaultBranchSyncStatus, "blocked_dirty");
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});
