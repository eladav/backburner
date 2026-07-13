import * as assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePullRequest } from "../src/github/normalize.js";
import type { GhPullRequestSummary, GitHubRepositoryMetadata } from "../src/github/types.js";
import type { RepoConfig } from "../src/config/types.js";

test("normalizePullRequest derives defaultBranch and baseClassification from repo metadata + PR base branch", () => {
  const repo: RepoConfig = {
    id: "repo-1",
    owner: "example-org",
    name: "example-repo",
    localPath: "example-repo",
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

  const metadata: GitHubRepositoryMetadata = {
    id: "REPO_1",
    owner: "example-org",
    name: "example-repo",
    nameWithOwner: "example-org/example-repo",
    url: "https://github.com/example-org/example-repo",
    defaultBranch: "production"
  };

  const pr: GhPullRequestSummary = {
    id: "PR_81",
    number: 81,
    title: "Update production classifier",
    body: "PR body",
    url: "https://github.com/example-org/example-repo/pull/81",
    state: "OPEN",
    createdAt: "2026-05-08T10:00:00Z",
    updatedAt: "2026-05-08T10:00:00Z",
    author: { login: "example-org" },
    labels: [],
    headRefName: "feature/issue-80",
    headSha: "sha123",
    baseRefName: "production",
    isDraft: false
  };

  const context = {
    repo,
    repoMetadata: metadata,
    seenAt: "2026-05-08T12:00:00Z",
    previousIssues: new Map(),
    previousPullRequests: new Map(),
    previousComments: new Map()
  };

  const result = normalizePullRequest(pr, [], context);

  assert.equal(result.baseBranch, "production");
  assert.equal(result.defaultBranch, "production");
  assert.equal(result.baseClassification, "top_level");
});

test("normalizePullRequest handles non-default-parent case correctly", () => {
  const repo: RepoConfig = {
    id: "repo-1",
    owner: "example-org",
    name: "example-repo",
    localPath: "example-repo",
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

  const metadata: GitHubRepositoryMetadata = {
    id: "REPO_1",
    owner: "example-org",
    name: "example-repo",
    nameWithOwner: "example-org/example-repo",
    url: "https://github.com/example-org/example-repo",
    defaultBranch: "main"
  };

  const pr: GhPullRequestSummary = {
    id: "PR_82",
    number: 82,
    title: "Workstream branch PR",
    body: "PR body",
    url: "https://github.com/example-org/example-repo/pull/82",
    state: "OPEN",
    createdAt: "2026-05-08T10:00:00Z",
    updatedAt: "2026-05-08T10:00:00Z",
    author: { login: "example-org" },
    labels: [],
    headRefName: "feature/fix-bug",
    headSha: "sha456",
    baseRefName: "workstream/issue-72",
    isDraft: false
  };

  const context = {
    repo,
    repoMetadata: metadata,
    seenAt: "2026-05-08T12:00:00Z",
    previousIssues: new Map(),
    previousPullRequests: new Map(),
    previousComments: new Map()
  };

  const result = normalizePullRequest(pr, [], context);

  assert.equal(result.baseBranch, "workstream/issue-72");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.baseClassification, "non_default_parent");
});
