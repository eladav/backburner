import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoConfig } from "../src/config/types.js";
import type { GitGateway } from "../src/git/types.js";
import type { GitHubGateway, GhPullRequestSummary } from "../src/github/types.js";
import type { WorktreeRecord } from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { ImplementationWorkflowService } from "../src/worktrees/service.js";

const OLD_HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);

test("review-fix handoff tolerates a bounded stale GitHub head after push", async () => {
  let pullRequestReads = 0;
  let pushes = 0;
  const delays: number[] = [];
  const gitGateway = {
    async getCurrentBranch() { return "agent/review-fix"; },
    async isWorkingTreeClean() { return false; },
    async commitAll() { return true; },
    async getHeadCommitSha() { return NEW_HEAD; },
    async getChangedPathsSince() { return ["src/fix.ts"]; },
    async isAncestorOf() { return true; },
    async pushBranch() { pushes += 1; }
  } as unknown as GitGateway;
  const gitHubGateway = {
    async getPullRequest() {
      pullRequestReads += 1;
      // Before handoff and immediately before push both observe the old head.
      // The first two confirmation reads are stale before GitHub catches up.
      const headSha = pullRequestReads < 5 ? OLD_HEAD : NEW_HEAD;
      return { headSha, state: "OPEN", labels: [] } as unknown as GhPullRequestSummary;
    }
  } as unknown as GitHubGateway;
  const service = new ImplementationWorkflowService(
    gitGateway,
    gitHubGateway,
    () => "2026-08-03T10:00:00.000Z",
    async (milliseconds) => { delays.push(milliseconds); }
  );
  const worktree = {
    id: "worktree-1",
    path: "/code/_worktrees/repo/review-fix",
    branchName: "agent/review-fix"
  } as WorktreeRecord;
  const task = {
    id: "task:fix_review_finding:session:F001",
    kind: "fix_review_finding",
    context: {
      localRepoPath: worktree.path,
      reviewCycle: {
        sessionId: "session-1",
        reviewOrdinal: 1,
        turnNumber: 1,
        findingId: "F001",
        targetHeadSha: OLD_HEAD,
        retryScope: "review_session"
      }
    }
  } as TaskRecord;

  const result = await service.finalizeReviewFixHandoff({
    repo: {
      id: "repo-1",
      owner: "owner",
      name: "repo",
      localPath: "repo",
      enabled: true,
      labels: {}
    } as RepoConfig,
    pullRequestNumber: 7,
    task,
    worktree,
    expectedRemoteHeadSha: OLD_HEAD,
    result: {
      schemaVersion: 1,
      findingId: "F001",
      disposition: "fixed",
      summary: "Fixed the finding.",
      filesChanged: ["src/fix.ts"],
      checks: [],
      relatedFindingIds: [],
      notes: []
    }
  });

  assert.equal(result.outcome, "pushed");
  assert.equal(result.headAfter, NEW_HEAD);
  assert.equal(pushes, 1);
  assert.equal(pullRequestReads, 5);
  assert.deepEqual(delays, [1_000, 1_000]);
});
