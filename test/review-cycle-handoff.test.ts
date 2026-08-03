import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { RepoConfig } from "../src/config/types.js";
import type { GitGateway } from "../src/git/types.js";
import type { GitHubGateway, GhPullRequestSummary } from "../src/github/types.js";
import type { WorktreeRecord } from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { ImplementationWorkflowService } from "../src/worktrees/service.js";

const OLD_HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const THIRD_HEAD = "c".repeat(40);

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

  let recordedIntent: unknown;
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
      checks: [{ command: "npm test -- fix", outcome: "passed", durationMs: 10 }],
      relatedFindingIds: [],
      notes: []
    },
    async recordPushIntent(intent) { recordedIntent = intent; }
  });

  assert.equal(result.outcome, "pushed");
  assert.equal(result.headAfter, NEW_HEAD);
  assert.equal(pushes, 1);
  assert.deepEqual(recordedIntent, {
    headBefore: OLD_HEAD,
    headAfter: NEW_HEAD,
    commitSha: NEW_HEAD,
    filesChanged: ["src/fix.ts"]
  });
  assert.equal(pullRequestReads, 5);
  assert.deepEqual(delays, [1_000, 1_000]);
});

test("review-fix handoff persists a successful push when GitHub remains stale", async () => {
  let pushes = 0;
  let intents = 0;
  const service = new ImplementationWorkflowService(
    handoffGitGateway({ clean: false, head: NEW_HEAD, push: () => { pushes += 1; } }),
    { async getPullRequest() { return { headSha: OLD_HEAD } as GhPullRequestSummary; } } as unknown as GitHubGateway,
    () => "2026-08-03T10:00:00.000Z",
    async () => {}
  );
  const result = await service.finalizeReviewFixHandoff({
    ...handoffInput(),
    async recordPushIntent() { intents += 1; }
  });
  assert.equal(result.outcome, "push_observation_pending");
  assert.equal(pushes, 1);
  assert.equal(intents, 1);
});

test("review-fix handoff does not credit an agent self-push without durable orchestrator intent", async () => {
  let pushes = 0;
  const service = new ImplementationWorkflowService(
    handoffGitGateway({ clean: true, head: NEW_HEAD, push: () => { pushes += 1; } }),
    { async getPullRequest() { return { headSha: NEW_HEAD } as GhPullRequestSummary; } } as unknown as GitHubGateway
  );
  const result = await service.finalizeReviewFixHandoff({
    ...handoffInput(),
    async recordPushIntent() { throw new Error("must not record after an unowned remote move"); }
  });
  assert.equal(result.outcome, "head_changed");
  assert.equal(pushes, 0);
});

test("review-fix handoff recovers a crash after push only from a matching persisted intent", async () => {
  let pushes = 0;
  const service = new ImplementationWorkflowService(
    handoffGitGateway({ clean: true, head: NEW_HEAD, push: () => { pushes += 1; } }),
    { async getPullRequest() { return { headSha: NEW_HEAD } as GhPullRequestSummary; } } as unknown as GitHubGateway
  );
  const result = await service.finalizeReviewFixHandoff({
    ...handoffInput(),
    pushIntent: {
      headBefore: OLD_HEAD,
      headAfter: NEW_HEAD,
      commitSha: NEW_HEAD,
      filesChanged: ["src/fix.ts"]
    }
  });
  assert.equal(result.outcome, "pushed");
  assert.equal(pushes, 0);
});

test("review-fix handoff reports a third remote SHA instead of accepting its own planned head", async () => {
  let reads = 0;
  const service = new ImplementationWorkflowService(
    handoffGitGateway({ clean: false, head: NEW_HEAD, push: () => {} }),
    {
      async getPullRequest() {
        reads += 1;
        return { headSha: reads <= 2 ? OLD_HEAD : THIRD_HEAD } as GhPullRequestSummary;
      }
    } as unknown as GitHubGateway,
    () => "2026-08-03T10:00:00.000Z",
    async () => {}
  );
  const result = await service.finalizeReviewFixHandoff({
    ...handoffInput(),
    async recordPushIntent() {}
  });
  assert.equal(result.outcome, "head_changed");
  if (result.outcome === "head_changed") assert.equal(result.actual, THIRD_HEAD);
});

test("regular review PRs materialize and reuse an isolated exact-head worktree", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "review-pr-worktree-"));
  try {
    let creates = 0;
    const gitGateway = {
      async fetchRepository() {},
      async getWorktreeForBranch() { return null; },
      validatePathWithinCodeRoot(root: string, relative: string) { return path.join(root, relative); },
      async createWorktree(_repo: string, _root: string, worktreePath: string, branch: string, start: string) {
        creates += 1;
        assert.equal(branch, "feature/review");
        assert.equal(start, "origin/feature/review");
        return worktreePath;
      },
      async getHeadCommitSha() { return OLD_HEAD; }
    } as unknown as GitGateway;
    const service = new ImplementationWorkflowService(gitGateway, {} as GitHubGateway);
    const pullRequest = {
      id: "pull_request:owner/repo:7",
      repoId: "repo-1",
      repoSlug: "owner/repo",
      repoName: "repo",
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      headBranch: "feature/review",
      headSha: OLD_HEAD,
      baseBranch: "main"
    } as Parameters<ImplementationWorkflowService["ensureReviewWorktreeForPullRequest"]>[0]["pullRequest"];
    const first = await service.ensureReviewWorktreeForPullRequest({
      repo: handoffInput().repo,
      repoPath: path.join(codeRoot, "repo"),
      codeRoot,
      pullRequest,
      existingWorktrees: []
    });
    assert.equal(first.created, true);
    assert.equal(first.worktree.prId, pullRequest.id);
    assert.equal(first.worktree.branchName, pullRequest.headBranch);
    assert.match(first.worktree.path, /pr-7$/);

    const second = await service.ensureReviewWorktreeForPullRequest({
      repo: handoffInput().repo,
      repoPath: path.join(codeRoot, "repo"),
      codeRoot,
      pullRequest,
      existingWorktrees: [first.worktree]
    });
    assert.equal(second.created, false);
    assert.equal(creates, 1);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

function handoffGitGateway(input: {
  clean: boolean;
  head: string;
  push: () => void;
}): GitGateway {
  return {
    async getCurrentBranch() { return "agent/review-fix"; },
    async isWorkingTreeClean() { return input.clean; },
    async commitAll() { return true; },
    async getHeadCommitSha() { return input.head; },
    async getChangedPathsSince() { return ["src/fix.ts"]; },
    async isAncestorOf() { return true; },
    async pushBranch() { input.push(); }
  } as unknown as GitGateway;
}

function handoffInput() {
  const worktree = {
    id: "worktree-1",
    path: "/code/_worktrees/repo/review-fix",
    branchName: "agent/review-fix"
  } as WorktreeRecord;
  return {
    repo: {
      id: "repo-1",
      owner: "owner",
      name: "repo",
      localPath: "repo",
      enabled: true,
      labels: {}
    } as RepoConfig,
    pullRequestNumber: 7,
    task: {
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
    } as TaskRecord,
    worktree,
    expectedRemoteHeadSha: OLD_HEAD,
    result: {
      schemaVersion: 1 as const,
      findingId: "F001",
      disposition: "fixed" as const,
      summary: "Fixed the finding.",
      filesChanged: ["src/fix.ts"],
      checks: [{ command: "npm test -- fix", outcome: "passed" as const, durationMs: 10 }],
      relatedFindingIds: [],
      notes: []
    }
  };
}
