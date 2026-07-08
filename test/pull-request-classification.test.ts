import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyManagementPullRequest,
  classifyPullRequestBase,
} from "../src/github/pr-classification.js";

describe("classifyPullRequestBase", () => {
  it("classifies as top_level when base branch matches default branch", () => {
    const input = {
      pullRequestNumber: 123,
      repoSlug: "owner/repo",
      baseBranch: "main",
      defaultBranch: "main",
    };
    const result = classifyPullRequestBase(input);
    assert.deepStrictEqual(result, {
      kind: "top_level",
      pullRequestNumber: 123,
      repoSlug: "owner/repo",
      baseBranch: "main",
      defaultBranch: "main",
    });
  });

  it("classifies as top_level when base branch matches default branch (master)", () => {
    const input = {
      pullRequestNumber: 124,
      repoSlug: "owner/repo",
      baseBranch: "master",
      defaultBranch: "master",
    };
    const result = classifyPullRequestBase(input);
    assert.deepStrictEqual(result, {
      kind: "top_level",
      pullRequestNumber: 124,
      repoSlug: "owner/repo",
      baseBranch: "master",
      defaultBranch: "master",
    });
  });

  it("classifies as top_level when base branch matches default branch (production)", () => {
    const input = {
      pullRequestNumber: 128,
      repoSlug: "owner/repo",
      baseBranch: "production",
      defaultBranch: "production",
    };
    const result = classifyPullRequestBase(input);
    assert.deepStrictEqual(result, {
      kind: "top_level",
      pullRequestNumber: 128,
      repoSlug: "owner/repo",
      baseBranch: "production",
      defaultBranch: "production",
    });
  });

  it("classifies as non_default_parent when base branch does not match default branch", () => {
    const input = {
      pullRequestNumber: 125,
      repoSlug: "owner/repo",
      baseBranch: "workstream/issue-72",
      defaultBranch: "main",
    };
    const result = classifyPullRequestBase(input);
    assert.deepStrictEqual(result, {
      kind: "non_default_parent",
      pullRequestNumber: 125,
      repoSlug: "owner/repo",
      baseBranch: "workstream/issue-72",
      defaultBranch: "main",
    });
  });

  it("trims branch names before comparison", () => {
    const input = {
      pullRequestNumber: 126,
      repoSlug: "owner/repo",
      baseBranch: " main ",
      defaultBranch: "main",
    };
    const result = classifyPullRequestBase(input);
    assert.strictEqual(result.kind, "top_level");
  });

  it("trims default branch name before comparison", () => {
    const input = {
      pullRequestNumber: 127,
      repoSlug: "owner/repo",
      baseBranch: "main",
      defaultBranch: " main ",
    };
    const result = classifyPullRequestBase(input);
    assert.strictEqual(result.kind, "top_level");
  });
});

describe("classifyManagementPullRequest", () => {
  const defaultInput = {
    repoId: "repo-1",
    repoSlug: "owner/repo",
    pullRequestNumber: 1,
    managementRepo: { repoId: "repo-1", repoSlug: "owner/repo" },
  };

  it("classifies as management when PR matches ManagementPrRecord", () => {
    const result = classifyManagementPullRequest({
      ...defaultInput,
      managementPrs: [
        {
          id: "mpr-1",
          proposalId: "prop-1",
          mode: "pull_request",
          repoId: "repo-1",
          prNumber: 1,
          changedArtifactPaths: [],
          status: "opened",
          detectedAt: "2026-01-01T00:00:00Z"
        }
      ]
    });
    assert.strictEqual(result.kind, "management");
    if (result.kind === "management") {
      assert.strictEqual(result.managementPrRecordId, "mpr-1");
    }
  });

  it("classifies as management when PR is in management repo with prefix", () => {
    const result = classifyManagementPullRequest({
      ...defaultInput,
      headBranch: "agent/management-learning/fix",
    });
    assert.strictEqual(result.kind, "management");
  });

  it("classifies as operational when PR has prefix but is not in management repo", () => {
    const result = classifyManagementPullRequest({
      ...defaultInput,
      repoId: "repo-2",
      repoSlug: "owner/other",
      headBranch: "agent/management-learning/fix",
    });
    assert.strictEqual(result.kind, "operational");
  });

  it("returns unknown when management repo identity is missing", () => {
    const result = classifyManagementPullRequest({
      repoId: "repo-1",
      repoSlug: "owner/repo",
      pullRequestNumber: 1,
    });
    assert.strictEqual(result.kind, "unknown");
  });
});
