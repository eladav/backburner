import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedPullRequest } from "../src/domain/entities.js";
import type { WorkstreamRecord } from "../src/state/types.js";
import { collectPacketPullRequestCandidates } from "../src/workstreams/packet-candidates.js";

test("collectPacketPullRequestCandidates ignores top-level PRs", () => {
  const pr = basePullRequest({
    number: 1,
    baseClassification: "top_level"
  });
  const candidates = collectPacketPullRequestCandidates({
    pullRequests: [pr],
    workstreams: []
  });
  assert.equal(candidates.length, 0);
});

test("collectPacketPullRequestCandidates matches non-default PR to active parent workstream", () => {
  const pr = basePullRequest({
    number: 100,
    title: "Packet PR",
    baseBranch: "feature/parent",
    baseClassification: "non_default_parent",
    repoSlug: "owner/repo"
  });
  const workstream: WorkstreamRecord = baseWorkstream({
    id: "owner/repo:issue:72",
    repoKey: "owner/repo",
    status: "open",
    resolution: "unresolved",
    integration: {
      branchName: "feature/parent",
      prNumber: 50
    }
  });

  const candidates = collectPacketPullRequestCandidates({
    pullRequests: [pr],
    workstreams: [workstream]
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    repoSlug: "owner/repo",
    pullRequestNumber: 100,
    title: "Packet PR",
    baseBranch: "feature/parent",
    headBranch: "feature/pr",
    parentWorkstreamId: "owner/repo:issue:72",
    parentIntegrationBranch: "feature/parent",
    parentPullRequestNumber: 50,
    status: "matched_parent_workstream"
  });
});

test("collectPacketPullRequestCandidates reports orphan non-default parent PR", () => {
  const pr = basePullRequest({
    number: 101,
    title: "Orphan PR",
    baseBranch: "feature/unknown",
    baseClassification: "non_default_parent",
    repoSlug: "owner/repo"
  });

  const candidates = collectPacketPullRequestCandidates({
    pullRequests: [pr],
    workstreams: []
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    repoSlug: "owner/repo",
    pullRequestNumber: 101,
    title: "Orphan PR",
    baseBranch: "feature/unknown",
    headBranch: "feature/pr",
    status: "orphan_non_default_parent"
  });
});

test("collectPacketPullRequestCandidates does not match closed or resolved workstreams", () => {
  const pr = basePullRequest({
    baseBranch: "feature/parent",
    baseClassification: "non_default_parent"
  });
  const closedWorkstream = baseWorkstream({
    status: "closed",
    integration: { branchName: "feature/parent" }
  });
  const resolvedWorkstream = baseWorkstream({
    status: "open",
    resolution: "merged",
    integration: { branchName: "feature/parent" }
  });

  const candidates = collectPacketPullRequestCandidates({
    pullRequests: [pr],
    workstreams: [closedWorkstream, resolvedWorkstream]
  });

  assert.equal(candidates[0]?.status, "orphan_non_default_parent");
});

test("collectPacketPullRequestCandidates is repo-scoped", () => {
  const pr = basePullRequest({
    repoSlug: "owner/repo-a",
    baseBranch: "feature/parent",
    baseClassification: "non_default_parent"
  });
  const otherRepoWorkstream = baseWorkstream({
    repoKey: "owner/repo-b",
    integration: { branchName: "feature/parent" }
  });

  const candidates = collectPacketPullRequestCandidates({
    pullRequests: [pr],
    workstreams: [otherRepoWorkstream]
  });

  assert.equal(candidates[0]?.status, "orphan_non_default_parent");
});

test("collectPacketPullRequestCandidates sorts by repoSlug then PR number", () => {
  const pr1 = basePullRequest({ repoSlug: "b/repo", number: 10, baseClassification: "non_default_parent" });
  const pr2 = basePullRequest({ repoSlug: "a/repo", number: 20, baseClassification: "non_default_parent" });
  const pr3 = basePullRequest({ repoSlug: "a/repo", number: 5, baseClassification: "non_default_parent" });

  const candidates = collectPacketPullRequestCandidates({
    pullRequests: [pr1, pr2, pr3],
    workstreams: []
  });

  assert.equal(candidates[0]?.repoSlug, "a/repo");
  assert.equal(candidates[0]?.pullRequestNumber, 5);
  assert.equal(candidates[1]?.repoSlug, "a/repo");
  assert.equal(candidates[1]?.pullRequestNumber, 20);
  assert.equal(candidates[2]?.repoSlug, "b/repo");
  assert.equal(candidates[2]?.pullRequestNumber, 10);
});

function basePullRequest(overrides: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  return {
    kind: "pull_request",
    id: "pr:1",
    repoId: "repo:1",
    repoKey: "owner/repo",
    repoOwner: "owner",
    repoName: "repo",
    repoSlug: "owner/repo",
    number: 1,
    key: "owner/repo:pr:1",
    sourceId: "PR_1",
    url: "https://github.com/owner/repo/pull/1",
    title: "PR title",
    body: "body",
    labels: [],
    author: "author",
    createdAt: "2026-05-09T00:00:00Z",
    updatedAt: "2026-05-09T00:00:00Z",
    state: "open",
    headBranch: "feature/pr",
    headSha: "sha",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false,
    ...overrides
  };
}

function baseWorkstream(overrides: Partial<WorkstreamRecord> = {}): WorkstreamRecord {
  return {
    id: "ws:1",
    repoKey: "owner/repo",
    origin: { type: "issue", number: 1 },
    linkedPrs: [],
    phase: "implementing",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    ...overrides
  };
}
