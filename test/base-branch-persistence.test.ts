import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { RepoConfig } from "../src/config/types.js";
import type { NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import type { GitGateway } from "../src/git/types.js";
import type { GitHubGateway, GhPullRequestSummary, GitHubRepositoryMetadata, GhIssueSummary, GhActor } from "../src/github/types.js";
import {
  ImplementationWorkflowService,
  buildWorktreeId
} from "../src/worktrees/service.js";
import type { WorktreeRecord, WorkstreamRecord } from "../src/state/types.js";

test("ensurePullRequestForWorktree backfills baseBranch from remote PR", async () => {
  const repo = baseRepo();
  const issue = baseIssue();
  const existingRemotePr: GhPullRequestSummary = {
    id: "pr-123",
    number: 123,
    title: "PR Title",
    body: "PR Body",
    url: "https://github.com/eladaviv/repo-one/pull/123",
    state: "OPEN",
    createdAt: "2026-05-10T10:00:00Z",
    updatedAt: "2026-05-10T10:00:00Z",
    author: { login: "owner" },
    labels: [],
    headRefName: "agent/eladaviv-repo-one/issue-17",
    headSha: "abc123",
    baseRefName: "feature/custom-base", // Non-default base
    isDraft: false
  };

  const fakeGitHub = new FakeGitHubGateway();
  fakeGitHub.findOpenPullRequestByHeadBranchResult = existingRemotePr;

  const service = new ImplementationWorkflowService(new FakeGitGateway() as any, fakeGitHub as any);
  const worktree = baseWorktree({}); // baseBranch is omitted
  delete (worktree as any).baseBranch;

  const result = await service.ensurePullRequestForWorktree(repo, issue, worktree);

  assert.equal(result.worktree.baseBranch,
 "feature/custom-base");
});

test("ensurePacketPlanningWorktreesForCurrentWave backfills baseBranch from integrationBranch on reuse", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-base-branch-"));
  const repo = baseRepo();
  const parentWorkstream: WorkstreamRecord = {
    id: "repo-1:issue:17",
    repoKey: "repo-1",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [],
    phase: "planning",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: { branchName: "agent/eladaviv-repo-one/issue-17" },
    packetPlan: {
      status: "proposed",
      packets: {
        T1: {
          id: "T1",
          title: "Task 1",
          summary: "Summary 1",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "planned"
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    }
  };

  try {
    const existingWorktree = baseWorktree({
      path: tempDir,
      planDocumentPath: path.join(tempDir, "docs", "agents", "issue-17-agent-plan.md"),
      logDocumentPath: path.join(tempDir, "docs", "agents", "issue-17-agent-log.md"),
      packet: {
        parentWorkstreamId: parentWorkstream.id,
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      }
    });
    delete (existingWorktree as any).baseBranch;

    const service = new ImplementationWorkflowService(new FakeGitGateway() as any, new FakeGitHubGateway() as any);
    const results = await service.ensurePacketPlanningWorktreesForCurrentWave({
      repo,
      repoPath: "/tmp/repo-one",
      codeRoot: "/tmp/code-root",
      parentWorkstream,
      existingWorktrees: [existingWorktree]
    });

    assert.equal(results[0]?.worktree.baseBranch, "agent/eladaviv-repo-one/issue-17");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ensurePullRequestForPacketWorktree backfills baseBranch from remote PR", async () => {
  const repo = baseRepo();
  const parentWorkstream: WorkstreamRecord = {
    id: "repo-1:issue:17",
    repoKey: "repo-1",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [],
    phase: "planning",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: { branchName: "agent/eladaviv-repo-one/issue-17" },
    packetPlan: {
      status: "proposed",
      packets: {
        T1: {
          id: "T1",
          title: "Task 1",
          summary: "Summary 1",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "planned"
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    }
  };

  const worktree = baseWorktree({
    packet: {
      parentWorkstreamId: parentWorkstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    }
  });
  delete (worktree as any).baseBranch;

  const existingRemotePr: GhPullRequestSummary = {
    id: "pr-456",
    number: 456,
    title: "Packet PR",
    body: "Body",
    url: "https://github.com/eladaviv/repo-one/pull/456",
    state: "OPEN",
    createdAt: "2026-05-10T10:00:00Z",
    updatedAt: "2026-05-10T10:00:00Z",
    author: { login: "owner" },
    labels: [],
    headRefName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1",
    headSha: "def456",
    baseRefName: "agent/eladaviv-repo-one/issue-17",
    isDraft: false
  };

  const fakeGitHub = new FakeGitHubGateway();
  fakeGitHub.findOpenPullRequestByHeadBranchResult = existingRemotePr;

  const service = new ImplementationWorkflowService(new FakeGitGateway() as any, fakeGitHub as any);
  const result = await service.ensurePullRequestForPacketWorktree(repo, parentWorkstream, worktree);

  assert.equal(result.worktree.baseBranch,
 "agent/eladaviv-repo-one/issue-17");
});

test("linkPullRequests backfills baseBranch from NormalizedPullRequest", () => {
  const repo = baseRepo();
  const worktree = baseWorktree({});
  delete (worktree as any).baseBranch;

  const pr: NormalizedPullRequest = {
    kind: "pull_request",
    id: "pr-123",
    repoId: repo.id,
    repoKey: "repo-1",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number: 123,
    key: "eladaviv/repo-one:pr:123",
    sourceId: "PR_123",
    url: "https://github.com/eladaviv/repo-one/pull/123",
    title: "PR Title",
    body: "Body",
    headBranch: "agent/eladaviv-repo-one/issue-17",
    headSha: "abc123",
    baseBranch: "feature/custom-base",
    defaultBranch: "main",
    baseClassification: "non_default_parent",
    labels: [],
    author: "owner",
    createdAt: "2026-05-10T10:00:00Z",
    updatedAt: "2026-05-10T10:00:00Z",
    state: "open",
    isDraft: false
  };

  const service = new ImplementationWorkflowService(new FakeGitGateway() as any, new FakeGitHubGateway() as any);
  const linked = service.linkPullRequests([worktree], [pr], [repo]);

  assert.equal(linked[0]?.baseBranch, "feature/custom-base");
});

// Helpers (minimal versions from worktrees.test.ts)

function baseRepo(): RepoConfig {
  return {
    id: "repo-1",
    owner: "eladaviv",
    name: "repo-one",
    defaultBranch: "main",
    localPath: "/tmp/repo-one",
    enabled: true,
    labels: {
      agentPlanApproved: "agent-plan-approved",
      agentProductApproved: "agent-product-approved",
      agentInProgress: "agent-in-progress",
      agentReview: "agent-review",
      planBreakdownNeeded: "plan-breakdown-needed",
      agentSyncParentBranch: "agent-sync-parent-branch",
      prepareForMerge: "prepare-for-merge"
    }
  };
}

function baseIssue(): NormalizedIssue {
  return {
    kind: "issue",
    id: "issue:eladaviv/repo-one:17",
    repoId: "repo-1",
    repoKey: "repo-1",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number: 17,
    key: "eladaviv/repo-one:issue:17",
    sourceId: "ISSUE_17",
    url: "https://github.com/eladaviv/repo-one/issues/17",
    title: "Issue Title",
    body: "Body",
    labels: [],
    author: "owner",
    createdAt: "2026-05-10T10:00:00Z",
    updatedAt: "2026-05-10T10:00:00Z",
    state: "open"
  };
}

function baseWorktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: buildWorktreeId("eladaviv", "repo-one", 17),
    repoId: "repo-1",
    repoSlug: "eladaviv/repo-one",
    repoName: "repo-one",
    issueNumber: 17,
    branchName: "agent/eladaviv-repo-one/issue-17",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17",
    planDocumentPath: "docs/agents/agent/issue-17-agent-plan.md",
    logDocumentPath: "docs/agents/agent/issue-17-agent-log.md",
    status: "planning",
    createdAt: "2026-05-10T10:00:00Z",
    updatedAt: "2026-05-10T10:00:00Z",
    ...overrides
  };
}

class FakeGitGateway {
  async createWorktree(repoPath: string, codeRoot: string, worktreePath: string, branchName: string, startPoint: string): Promise<string> {
    return worktreePath;
  }
  async commitAll(): Promise<boolean> { return true; }
  async pushBranch(): Promise<void> {}
  async isWorkingTreeClean(): Promise<boolean> { return true; }
  async hasCommitsAhead(): Promise<boolean> { return false; }
  async isInsideWorkingTree(): Promise<boolean> { return true; }
  async pullFastForwardOnly(): Promise<void> {}
  async getHeadCommitSha(): Promise<string> { return "abc123456789"; }
  async listWorktrees(): Promise<{ path: string; branch: string }[]> { return []; }
  async getWorktreeForBranch(): Promise<string | null> { return null; }
  validatePathWithinCodeRoot(codeRoot: string, relativePath: string): string {
    return "/tmp/code-root/" + relativePath;
  }
  async listBranches(): Promise<string[]> { return []; }
  async deleteWorktree(): Promise<void> {}
  async getStatus(): Promise<string> { return ""; }
  async checkoutBranch(): Promise<void> {}
  async pullBranch(): Promise<void> {}
  async mergeBranch(): Promise<void> {}
}

class FakeGitHubGateway {
  findOpenPullRequestByHeadBranchResult: GhPullRequestSummary | null = null;

  async getRepositoryMetadata(): Promise<GitHubRepositoryMetadata> {
    return { id: "repo-1", owner: "eladaviv", name: "repo-one", nameWithOwner: "eladaviv/repo-one", url: "", defaultBranch: "main" };
  }
  async getRepositoryDefaultBranch(): Promise<string> { return "main"; }
  async getIssue(): Promise<GhIssueSummary> { throw new Error("Not implemented"); }
  async getPullRequest(): Promise<GhPullRequestSummary> { throw new Error("Not implemented"); }
  async findOpenPullRequestByHeadBranch(): Promise<GhPullRequestSummary | null> {
    return this.findOpenPullRequestByHeadBranchResult;
  }
  async createPullRequest(input: any): Promise<GhPullRequestSummary> {
    return {
      id: "pr-created",
      number: 999,
      title: input.title,
      body: input.body,
      url: "https://github.com/eladaviv/repo-one/pull/999",
      state: "OPEN",
      createdAt: "2026-05-10T10:00:00Z",
      updatedAt: "2026-05-10T10:00:00Z",
      author: { login: "owner" },
      labels: [],
      headRefName: input.headBranch,
      headSha: "abc",
      baseRefName: input.baseBranch,
      isDraft: false
    };
  }
  async searchCode(): Promise<any> { return { items: [] }; }
  async listOpenPullRequests(): Promise<any[]> { return []; }
  async listIssueComments(): Promise<any[]> { return []; }
  async listPullRequestComments(): Promise<any[]> { return []; }
  async listPullRequestReviews(): Promise<any[]> { return []; }
  async listPullRequestReviewComments(): Promise<any[]> { return []; }
  async listPullRequestChangedFiles(): Promise<any[]> { return []; }
  async postIssueComment(): Promise<any> { return { id: 1, url: "" }; }
  async postPullRequestReviewCommentReply(): Promise<any> { return { id: 1, url: "" }; }
  async submitPullRequestReview(): Promise<any> { return { id: 1, url: "" }; }
  async addReaction(): Promise<void> {}
}
