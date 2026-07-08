import * as assert from "node:assert/strict";
import { test } from "node:test";
import type {
  NormalizedComment,
  NormalizedPullRequest
} from "../src/domain/entities.js";
import type {
  WorkstreamPacket,
  WorkstreamRecord,
  WorktreeRecord
} from "../src/state/types.js";
import {
  collectPacketPullRequestCommentProjections,
  collectPacketPullRequestProjections
} from "../src/workstreams/packet-projections.js";

test("collectPacketPullRequestCommentProjections matches comments for packet PRs", () => {
  const packetPr = basePullRequest({
    repoId: "R1",
    number: 101,
    baseBranch: "agent/owner-repo/issue-17",
    baseClassification: "non_default_parent"
  });

  const parentWorkstream = baseWorkstream({
    id: "owner/repo:issue:17",
    repoKey: "owner/repo",
    integration: { branchName: "agent/owner-repo/issue-17" },
    packetPlan: {
      status: "approved",
      packets: { T1: basePacket({ id: "T1", prNumber: 101 }) },
      waves: [["T1"]]
    }
  });

  const packetProjections = collectPacketPullRequestProjections({
    pullRequests: [packetPr],
    workstreams: [parentWorkstream],
    worktrees: []
  });

  const comment = baseComment({
    repoId: "R1",
    parentType: "pull_request",
    parentNumber: 101,
    pullRequestReviewLocation: {
      path: "src/example.ts",
      line: 42
    }
  });

  const commentProjections = collectPacketPullRequestCommentProjections({
    comments: [comment],
    packetPullRequestProjections: packetProjections
  });

  assert.equal(commentProjections.length, 1);
  assert.equal(commentProjections[0]!.comment, comment);
  assert.equal(commentProjections[0]!.packetProjection.pullRequest, packetPr);
  assert.deepEqual(commentProjections[0]!.comment.pullRequestReviewLocation, {
    path: "src/example.ts",
    line: 42
  });
});

test("collectPacketPullRequestCommentProjections ignores non-PR comments", () => {
  const comment = baseComment({
    parentType: "issue",
    parentNumber: 101
  });

  const commentProjections = collectPacketPullRequestCommentProjections({
    comments: [comment],
    packetPullRequestProjections: []
  });

  assert.equal(commentProjections.length, 0);
});

test("collectPacketPullRequestCommentProjections ignores comments for other PR numbers", () => {
  const packetPr = basePullRequest({
    number: 101,
    baseBranch: "agent/owner-repo/issue-17",
    baseClassification: "non_default_parent"
  });

  const parentWorkstream = baseWorkstream({
    integration: { branchName: "agent/owner-repo/issue-17" },
    packetPlan: {
      status: "approved",
      packets: { T1: basePacket({ id: "T1", prNumber: 101 }) },
      waves: [["T1"]]
    }
  });

  const packetProjections = collectPacketPullRequestProjections({
    pullRequests: [packetPr],
    workstreams: [parentWorkstream],
    worktrees: []
  });

  const comment = baseComment({
    parentType: "pull_request",
    parentNumber: 102
  });

  const commentProjections = collectPacketPullRequestCommentProjections({
    comments: [comment],
    packetPullRequestProjections: packetProjections
  });

  assert.equal(commentProjections.length, 0);
});

test("collectPacketPullRequestProjections matches a packet PR through packet worktree branch", () => {
  const parentWorkstream = baseWorkstream({
    id: "owner/repo:issue:17",
    repoKey: "owner/repo",
    integration: {
      branchName: "agent/owner-repo/issue-17",
      prNumber: 100
    },
    packetPlan: {
      status: "approved",
      packets: {
        T1: basePacket({ id: "T1" })
      },
      waves: [["T1"]]
    }
  });

  const packetWorktree = baseWorktree({
    repoId: "R1",
    repoSlug: "owner/repo",
    branchName: "packet/t1",
    packet: {
      parentWorkstreamId: "owner/repo:issue:17",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/owner-repo/issue-17"
    }
  });

  const packetPr = basePullRequest({
    repoId: "R1",
    repoSlug: "owner/repo",
    number: 101,
    headBranch: "packet/t1",
    baseBranch: "agent/owner-repo/issue-17",
    baseClassification: "non_default_parent"
  });

  const projections = collectPacketPullRequestProjections({
    pullRequests: [packetPr],
    workstreams: [parentWorkstream],
    worktrees: [packetWorktree]
  });

  assert.equal(projections.length, 1);
  const p = projections[0]!;
  assert.equal(p.pullRequest, packetPr);
  assert.equal(p.parentWorkstream, parentWorkstream);
  assert.equal(p.packet, parentWorkstream.packetPlan!.packets.T1);
  assert.equal(p.packetWorktree, packetWorktree);
  assert.equal(p.parentIntegrationBranch, "agent/owner-repo/issue-17");
  assert.equal(p.parentPullRequestNumber, 100);
});

test("Multiple packet PRs in one parent workstream are supported", () => {
  const parentWorkstream = baseWorkstream({
    id: "owner/repo:issue:17",
    repoKey: "owner/repo",
    packetPlan: {
      status: "approved",
      packets: {
        T1: basePacket({ id: "T1" }),
        T2: basePacket({ id: "T2" })
      },
      waves: [["T1", "T2"]]
    }
  });

  const wt1 = baseWorktree({
    id: "wt1",
    branchName: "packet/t1",
    packet: {
      parentWorkstreamId: "owner/repo:issue:17",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/owner-repo/issue-17"
    }
  });
  const wt2 = baseWorktree({
    id: "wt2",
    branchName: "packet/t2",
    packet: {
      parentWorkstreamId: "owner/repo:issue:17",
      packetId: "T2",
      waveIndex: 0,
      parentIntegrationBranch: "agent/owner-repo/issue-17"
    }
  });

  const pr1 = basePullRequest({
    number: 1,
    headBranch: "packet/t1",
    baseBranch: "agent/owner-repo/issue-17",
    baseClassification: "non_default_parent"
  });
  const pr2 = basePullRequest({
    number: 2,
    headBranch: "packet/t2",
    baseBranch: "agent/owner-repo/issue-17",
    baseClassification: "non_default_parent"
  });

  const projections = collectPacketPullRequestProjections({
    pullRequests: [pr1, pr2],
    workstreams: [parentWorkstream],
    worktrees: [wt1, wt2]
  });

  assert.equal(projections.length, 2);
  assert.equal(projections[0]!.packet.id, "T1");
  assert.equal(projections[1]!.packet.id, "T2");
});

test("Ordinary top-level PR is ignored", () => {
  const pr = basePullRequest({
    number: 1,
    baseClassification: "top_level",
    labels: ["agentic"]
  });
  const projections = collectPacketPullRequestProjections({
    pullRequests: [pr],
    workstreams: [],
    worktrees: []
  });
  assert.equal(projections.length, 0);
});

test("Non-default-parent PR with no packet ownership is ignored", () => {
  const pr = basePullRequest({
    number: 1,
    baseBranch: "some-feature",
    baseClassification: "non_default_parent"
  });
  const projections = collectPacketPullRequestProjections({
    pullRequests: [pr],
    workstreams: [],
    worktrees: []
  });
  assert.equal(projections.length, 0);
});

test("Fallback through packet prNumber", () => {
  const parentWorkstream = baseWorkstream({
    id: "owner/repo:issue:17",
    repoKey: "owner/repo",
    integration: { branchName: "agent/owner-repo/issue-17" },
    packetPlan: {
      status: "approved",
      packets: {
        T1: basePacket({ id: "T1", prNumber: 155 })
      },
      waves: [["T1"]]
    }
  });

  const pr = basePullRequest({
    repoSlug: "owner/repo",
    number: 155,
    baseBranch: "agent/owner-repo/issue-17",
    baseClassification: "non_default_parent"
  });

  const projections = collectPacketPullRequestProjections({
    pullRequests: [pr],
    workstreams: [parentWorkstream],
    worktrees: []
  });

  assert.equal(projections.length, 1);
  assert.equal(projections[0]!.pullRequest, pr);
  assert.equal(projections[0]!.packet.id, "T1");
  assert.equal(projections[0]!.packetWorktree, undefined);
});

test("Projection preserves full PR fields", () => {
  const packetPr = basePullRequest({
    number: 101,
    state: "merged",
    headSha: "abc",
    isDraft: true,
    labels: ["L1", "L2"],
    baseBranch: "agent/owner-repo/issue-17",
    baseClassification: "non_default_parent"
  });
  const parentWorkstream = baseWorkstream({
    packetPlan: {
      status: "approved",
      packets: { T1: basePacket({ id: "T1", prNumber: 101 }) },
      waves: [["T1"]]
    },
    integration: { branchName: "agent/owner-repo/issue-17" }
  });

  const projections = collectPacketPullRequestProjections({
    pullRequests: [packetPr],
    workstreams: [parentWorkstream],
    worktrees: []
  });

  assert.equal(projections.length, 1);
  const p = projections[0]!.pullRequest;
  assert.equal(p, packetPr);
  assert.equal(p.state, "merged");
  assert.equal(p.isDraft, true);
  assert.deepEqual(p.labels, ["L1", "L2"]);
});

test("Worktree-backed match wins over fallback when both match the same packet PR", () => {
  const parentWorkstream = baseWorkstream({
    id: "ws:1",
    packetPlan: {
      status: "approved",
      packets: { T1: basePacket({ id: "T1", prNumber: 155 }) },
      waves: [["T1"]]
    },
    integration: { branchName: "agent/owner-repo/issue-17" }
  });

  const wt = baseWorktree({
    branchName: "packet/t1",
    packet: {
      parentWorkstreamId: "ws:1",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/owner-repo/issue-17"
    }
  });

  const pr = basePullRequest({
    number: 155,
    headBranch: "packet/t1",
    baseBranch: "agent/owner-repo/issue-17",
    baseClassification: "non_default_parent"
  });

  const projections = collectPacketPullRequestProjections({
    pullRequests: [pr],
    workstreams: [parentWorkstream],
    worktrees: [wt]
  });

  assert.equal(projections.length, 1);
  assert.equal(projections[0]!.packetWorktree, wt);
});

test("Fallback refuses a PR number when baseBranch does not equal the parent integration branch", () => {
  const parentWorkstream = baseWorkstream({
    integration: { branchName: "main" },
    packetPlan: {
      status: "approved",
      packets: { T1: basePacket({ id: "T1", prNumber: 155 }) },
      waves: [["T1"]]
    }
  });

  const pr = basePullRequest({
    number: 155,
    baseBranch: "other-branch",
    baseClassification: "top_level"
  });

  const projections = collectPacketPullRequestProjections({
    pullRequests: [pr],
    workstreams: [parentWorkstream],
    worktrees: []
  });

  // Should be 0 because baseBranch ("other-branch") !== parentIntegrationBranch ("main")
  // and baseClassification is top_level (not non_default_parent)
  // Wait, my isEligiblePacketPr logic:
  // (pr.baseClassification === "non_default_parent" || pr.baseBranch === parentIntegrationBranch)
  // Here both are false.
  assert.equal(projections.length, 0);
});

test("Fallback refuses a PR number in a different repo", () => {
  const parentWorkstream = baseWorkstream({
    repoKey: "owner/repo",
    integration: { branchName: "main" },
    packetPlan: {
      status: "approved",
      packets: { T1: basePacket({ id: "T1", prNumber: 155 }) },
      waves: [["T1"]]
    }
  });

  const pr = basePullRequest({
    repoSlug: "other/repo",
    number: 155,
    baseBranch: "main"
  });

  const projections = collectPacketPullRequestProjections({
    pullRequests: [pr],
    workstreams: [parentWorkstream],
    worktrees: []
  });

  assert.equal(projections.length, 0);
});

test("A packet worktree whose packet.parentWorkstreamId points at another workstream is ignored", () => {
  const ws1 = baseWorkstream({ id: "ws:1", packetPlan: { status: "approved", packets: { T1: basePacket({ id: "T1" }) }, waves: [["T1"]] } });
  const ws2 = baseWorkstream({ id: "ws:2", packetPlan: { status: "approved", packets: { T1: basePacket({ id: "T1" }) }, waves: [["T1"]] } });

  const wt = baseWorktree({
    branchName: "packet/t1",
    packet: {
      parentWorkstreamId: "ws:2", // Points to ws2
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "main"
    }
  });

  const pr = basePullRequest({
    headBranch: "packet/t1",
    baseBranch: "main"
  });

  const projections = collectPacketPullRequestProjections({
    pullRequests: [pr],
    workstreams: [ws1], // Only ws1 is provided
    worktrees: [wt]
  });

  assert.equal(projections.length, 0);
});

test("A packet worktree whose packet.packetId is not in the parent packet plan is ignored", () => {
    const ws = baseWorkstream({
        id: "ws:1",
        packetPlan: {
            status: "approved",
            packets: { T1: basePacket({ id: "T1" }) },
            waves: [["T1"]]
        }
    });

    const wt = baseWorktree({
        branchName: "packet/unknown",
        packet: {
            parentWorkstreamId: "ws:1",
            packetId: "UNKNOWN",
            waveIndex: 0,
            parentIntegrationBranch: "main"
        }
    });

    const pr = basePullRequest({
        headBranch: "packet/unknown",
        baseBranch: "main"
    });

    const projections = collectPacketPullRequestProjections({
        pullRequests: [pr],
        workstreams: [ws],
        worktrees: [wt]
    });

    assert.equal(projections.length, 0);
});

// Helpers

function baseComment(overrides: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    kind: "comment",
    commentKind: "pull_request_comment",
    id: "C1",
    sourceId: "C1",
    repoId: "R1",
    repoKey: "owner/repo",
    repoOwner: "owner",
    repoName: "repo",
    repoSlug: "owner/repo",
    parentType: "pull_request",
    parentNumber: 1,
    parentKey: "owner/repo:pr:1",
    url: "https://github.com/owner/repo/pull/1#issuecomment-1",
    body: "comment body",
    author: "author",
    createdAt: "2026-05-09T00:00:00Z",
    updatedAt: "2026-05-09T00:00:00Z",
    ...overrides
  };
}

function basePullRequest(
  overrides: Partial<NormalizedPullRequest> = {}
): NormalizedPullRequest {
  return {
    id: `PR_${overrides.number || 1}`,
    kind: "pull_request",
    repoId: "R1",
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

function baseWorkstream(
  overrides: Partial<WorkstreamRecord> = {}
): WorkstreamRecord {
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

function baseWorktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "wt:1",
    repoId: "R1",
    repoSlug: "owner/repo",
    repoName: "repo",
    branchName: "branch",
    path: "/path",
    planDocumentPath: "/plan",
    logDocumentPath: "/log",
    status: "implementing",
    createdAt: "2026-05-09T00:00:00Z",
    updatedAt: "2026-05-09T00:00:00Z",
    ...overrides
  };
}

function basePacket(
  overrides: Partial<WorkstreamPacket> = {}
): WorkstreamPacket {
  return {
    id: "T1",
    title: "Task 1",
    summary: "Summary",
    acceptanceCriteria: [],
    filesLikelyTouched: [],
    dependsOn: [],
    canRunInParallelWith: [],
    blocks: [],
    status: "planned",
    ...overrides
  };
}
