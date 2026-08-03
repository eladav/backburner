import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoConfig } from "../src/config/types.js";
import type {
  NormalizedComment,
  NormalizedIssue,
  NormalizedPullRequest
} from "../src/domain/entities.js";
import type {
  PersistedState,
  WorkstreamRecord,
  WorktreeRecord
} from "../src/state/types.js";
import { deriveAttentionRecords } from "../src/attention/derive.js";
import { createReviewSession } from "../src/reviews/session.js";

test("deriveAttentionRecords creates attention for a human packet PR comment", () => {
  const issue = baseIssue();
  const workstream = {
    ...issueWorkstream(issue.number),
    packetPlan: {
      status: "approved" as const,
      packets: {
        T1: {
          id: "T1",
          title: "T1",
          summary: "S1",
          status: "pr_open" as const,
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          blocks: [],
          canRunInParallelWith: [],
          prNumber: 101,
          branchName: "packet/t1"
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    },
    integration: {
      branchName: "agent/example-org-repo-one/issue-17",
      prNumber: 100
    }
  };

  const packetPr = basePullRequest({
    number: 101,
    headBranch: "packet/t1",
    baseBranch: "agent/example-org-repo-one/issue-17",
    baseClassification: "non_default_parent"
  });

  const packetWorktree = baseWorktree({
    branchName: "packet/t1",
    packet: {
      parentWorkstreamId: workstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/example-org-repo-one/issue-17"
    }
  });

  const comment = basePrComment({
    parentNumber: 101
  });

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [packetPr]
    },
    currentIssues: [issue],
    currentPullRequests: [packetPr],
    currentComments: [comment],
    worktrees: [packetWorktree],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.deepEqual(attention, [
    {
      workstreamId: workstream.id,
      repoKey: workstream.repoKey,
      needsAction: true,
      reasons: ["pr_comment_added"],
      issueNumber: 17,
      pullRequestNumbers: [101],
      commentIds: [comment.id],
      lastObservedAt: "2026-04-20T10:00:00.000Z"
    }
  ]);
});

test("deriveAttentionRecords creates attention for a new issue workstream", () => {
  const issue = baseIssue();
  const workstream = issueWorkstream(issue.number);

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.deepEqual(attention, [
    {
      workstreamId: workstream.id,
      repoKey: workstream.repoKey,
      needsAction: true,
      reasons: ["new_issue"],
      issueNumber: 17,
      lastObservedAt: "2026-04-20T10:00:00.000Z"
    }
  ]);
});

test("deriveAttentionRecords creates attention for a new PR workstream", () => {
  const pr = basePullRequest({ labels: ["agent-review"] });
  const workstream = prWorkstream(pr.number);

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.deepEqual(attention, [
    {
      workstreamId: workstream.id,
      repoKey: workstream.repoKey,
      needsAction: true,
      reasons: ["new_pr", "pr_review_requested", "workstream_unlinked_pr"],
      pullRequestNumbers: [21],
      lastObservedAt: "2026-04-20T10:00:00.000Z",
      currentPullRequestHeadSha: "head-sha-21",
      gaps: [
        "Review handling is inferred from persisted state; external or unlabeled reviews are not tracked yet."
      ]
    }
  ]);
});

test("deriveAttentionRecords attaches comment-triggered attention to an existing workstream", () => {
  const issue = baseIssue();
  const workstream = issueWorkstream(issue.number);
  const comment = baseIssueComment();

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: {
      ...emptyState(),
      issues: [issue]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [comment],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.deepEqual(attention, [
    {
      workstreamId: workstream.id,
      repoKey: workstream.repoKey,
      needsAction: true,
      reasons: ["issue_comment_added"],
      issueNumber: 17,
      commentIds: [comment.id],
      lastObservedAt: "2026-04-20T10:00:00.000Z"
    }
  ]);
});

test("deriveAttentionRecords allows multiple reasons to coexist on one workstream", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ number: 23, labels: ["agent-plan-approved"] });
  const comment = basePrComment({ parentNumber: 23 });
  const workstream = issueWorkstream(issue.number, [23]);

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [comment],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.deepEqual(attention, [
    {
      workstreamId: workstream.id,
      repoKey: workstream.repoKey,
      needsAction: true,
      reasons: ["new_issue", "new_pr", "plan_approved", "pr_comment_added"],
      issueNumber: 17,
      pullRequestNumbers: [23],
      commentIds: [comment.id],
      lastObservedAt: "2026-04-20T10:00:00.000Z"
    }
  ]);
});

test("deriveAttentionRecords does NOT add plan_approved reason for a merged PR with the agent-plan-approved label", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ number: 23, labels: ["agent-plan-approved"], state: "merged" });
  const workstream = issueWorkstream(issue.number, [23]);

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.equal(attention.length, 1);
  assert.ok(!attention[0]?.reasons.includes("plan_approved"), "plan_approved should not be added for a merged PR");
});

test("deriveAttentionRecords does NOT add plan_breakdown_requested reason for a closed PR with the plan-breakdown-needed label", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ number: 23, labels: ["plan-breakdown-needed"], state: "closed" });
  const workstream = issueWorkstream(issue.number, [23]);

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.equal(attention.length, 1);
  assert.ok(!attention[0]?.reasons.includes("plan_breakdown_requested"), "plan_breakdown_requested should not be added for a closed PR");
});

test("deriveAttentionRecords treats a generated packet plan as satisfying plan-breakdown-needed", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ number: 23, labels: ["plan-breakdown-needed"] });
  const workstream = {
    ...issueWorkstream(issue.number, [23]),
    packetPlan: {
      status: "proposed" as const,
      packets: {
        T1: {
          id: "T1",
          title: "T1",
          summary: "S1",
          status: "planned" as const,
          acceptanceCriteria: ["Done"],
          filesLikelyTouched: [],
          dependsOn: [],
          blocks: [],
          canRunInParallelWith: []
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0,
      source: {
        kind: "plan_breakdown_result" as const,
        workstreamId: `example-org/repo-one:issue:${issue.number}`,
        generatedAt: "2026-04-20T09:30:00.000Z"
      }
    }
  };

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.equal(attention.length, 1);
  assert.ok(!attention[0]?.reasons.includes("plan_breakdown_requested"));
  assert.equal(attention[0]?.needsAction, false);
});

test("deriveAttentionRecords does not create comment-only workstreams", () => {
  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [],
    currentComments: [baseIssueComment()],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.deepEqual(attention, []);
});

test("deriveAttentionRecords is deterministic across repeated identical runs", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ number: 23, labels: ["agent-review", "agent-plan-approved"] });
  const workstream = issueWorkstream(issue.number, [23], "issue_waiting");
  const previousState = {
    ...emptyState(),
    issues: [issue],
    prs: [basePullRequest({ number: 23, labels: ["agent-review"], headSha: "old-head-sha" })],
    tasks: [
      {
        id: "task:review_pr:pull_request:example-org/repo-one:23",
        kind: "review_pr",
        status: "completed",
        executionPermission: "read-only",
        handoffPolicy: {
          expectsPushableHandoff: false,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        },
        repoId: "repo-1",
        repoName: "repo-one",
        repoSlug: "example-org/repo-one",
        sourceKind: "pull_request",
        sourceId: "pull_request:example-org/repo-one:23",
        sourceUrl: "https://github.com/example-org/repo-one/pull/23",
        relevant: true,
        reason: "review",
        summary: "review",
        context: {
          repoIdentifier: "example-org/repo-one",
          labels: ["agent-review"],
          instruction: "review"
        },
        createdAt: "2026-04-19T10:00:00.000Z",
        updatedAt: "2026-04-19T10:00:00.000Z"
      }
    ]
  } satisfies PersistedState;

  const first = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState,
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [basePrComment({ parentNumber: 23 })],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });
  const second = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState,
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [basePrComment({ parentNumber: 23 })],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    {
      workstreamId: workstream.id,
      repoKey: workstream.repoKey,
      needsAction: true,
      reasons: [
        "plan_approved",
        "pr_comment_added",
        "pr_head_changed_since_last_review",
        "pr_review_requested"
      ],
      issueNumber: 17,
      pullRequestNumbers: [23],
      commentIds: ["comment:example-org/repo-one:pull_request_comment:6001"],
      lastObservedAt: "2026-04-20T10:00:00.000Z",
      currentPullRequestHeadSha: "head-sha-23",
      lastHandledReviewHeadSha: "old-head-sha"
    }
  ]);
});

test("deriveAttentionRecords records same-cycle completed review tasks from the current task array", () => {
  const pr = basePullRequest({ number: 23, labels: ["agent-review"], headSha: "newest-head-sha" });
  const workstream = prWorkstream(pr.number);

  const previousState = {
    ...emptyState(),
    prs: [pr],
    tasks: []
  } satisfies PersistedState;

  const completedTask = {
    id: "task:review_pr:pull_request:example-org/repo-one:23",
    kind: "review_pr" as const,
    status: "completed" as const,
    executionPermission: "read-only" as const,
    handoffPolicy: {
      expectsPushableHandoff: false,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator" as const
    },
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    sourceKind: "pull_request" as const,
    sourceId: "pull_request:example-org/repo-one:23",
    sourceUrl: "https://github.com/example-org/repo-one/pull/23",
    relevant: true,
    reason: "review",
    summary: "review",
    context: {
      repoIdentifier: "example-org/repo-one",
      labels: ["agent-review"],
      instruction: "review"
    },
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:01:00.000Z"
  };

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState,
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    tasks: [completedTask],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.deepEqual(attention, [
    {
      workstreamId: workstream.id,
      repoKey: workstream.repoKey,
      needsAction: true,
      reasons: ["pr_review_requested", "workstream_unlinked_pr"],
      pullRequestNumbers: [23],
      lastObservedAt: "2026-04-20T10:00:00.000Z",
      currentPullRequestHeadSha: "newest-head-sha",
      lastHandledReviewHeadSha: "newest-head-sha"
    }
  ]);
});

test("deriveAttentionRecords does not treat a failed review session as a handled head", () => {
  const pr = basePullRequest({ number: 23, labels: ["agent-review"], headSha: "c".repeat(40) });
  const workstream = prWorkstream(pr.number);
  const started = createReviewSession({
    repoId: pr.repoId,
    repoSlug: pr.repoSlug,
    pullRequestId: pr.id,
    pullRequestNumber: pr.number,
    pullRequestUrl: pr.url,
    workstreamId: workstream.id,
    trigger: "label",
    maxTurns: 5,
    headSha: pr.headSha,
    ordinal: 1,
    now: "2026-04-20T09:00:00.000Z"
  });
  const failed = {
    ...started,
    status: "failed" as const,
    terminalHeadSha: pr.headSha,
    terminalAt: "2026-04-20T09:05:00.000Z",
    updatedAt: "2026-04-20T09:05:00.000Z",
    failure: {
      step: "review" as const,
      reason: "reviewer failed",
      failedAt: "2026-04-20T09:05:00.000Z"
    }
  };

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: {
      ...emptyState(),
      prs: [pr],
      reviewSessions: [failed]
    },
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.equal(attention[0]?.lastHandledReviewHeadSha, undefined);
  assert.ok(attention[0]?.reasons.includes("pr_review_requested"));
  assert.ok(attention[0]?.gaps?.some((gap) => gap.includes("Review handling is inferred")));
});

test("deriveAttentionRecords ignores bot-prefixed comments and treats human retry comments as actionable", () => {
  const issue = baseIssue();
  const workstream = issueWorkstream(issue.number);

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: {
      ...emptyState(),
      issues: [issue]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [
      baseIssueComment({
        id: "comment:example-org/repo-one:issue_comment:9999",
        sourceId: "9999",
        body: "🤖 Technical failure. Reply with `retry: <url-of-this-comment>`."
      }),
      baseIssueComment({
        id: "comment:example-org/repo-one:issue_comment:human-1",
        sourceId: "human-1",
        body: "retry: https://github.com/example-org/repo-one/issues/17#issuecomment-9999"
      })
    ],
    tasks: [],
    now: "2026-04-21T08:05:00.000Z"
  });

  assert.deepEqual(attention, [
    {
      workstreamId: workstream.id,
      repoKey: workstream.repoKey,
      needsAction: true,
      reasons: ["issue_comment_added", "retry_requested"],
      issueNumber: 17,
      commentIds: ["comment:example-org/repo-one:issue_comment:human-1"],
      retryTargetCommentId: "9999",
      lastObservedAt: "2026-04-21T08:05:00.000Z"
    }
  ]);
});

test("deriveAttentionRecords keeps all packet retry comments and records the first retry target", () => {
  const issue = baseIssue();
  const workstream = {
    ...issueWorkstream(issue.number),
    phase: "implementing" as const,
    integration: {
      branchName: "agent/example-org-repo-one/issue-17",
      prNumber: 100
    },
    packetPlan: {
      status: "approved" as const,
      packets: {
        T1: { id: "T1", title: "T1", summary: "S1", status: "pr_open" as const, acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [], prNumber: 101, branchName: "packet/t1" },
        T2: { id: "T2", title: "T2", summary: "S2", status: "pr_open" as const, acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [], prNumber: 102, branchName: "packet/t2" },
        T3: { id: "T3", title: "T3", summary: "S3", status: "pr_open" as const, acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [], prNumber: 103, branchName: "packet/t3" }
      },
      waves: [["T1", "T2", "T3"]],
      currentWaveIndex: 0
    }
  };
  const packetPrs = [101, 102, 103].map((number, index) =>
    basePullRequest({
      number,
      headBranch: `packet/t${index + 1}`,
      baseBranch: "agent/example-org-repo-one/issue-17",
      baseClassification: "non_default_parent"
    })
  );
  const packetWorktrees = ["T1", "T2", "T3"].map((packetId, index) =>
    baseWorktree({
      id: `wt:${packetId}`,
      branchName: `packet/t${index + 1}`,
      packet: {
        parentWorkstreamId: workstream.id,
        packetId,
        waveIndex: 0,
        parentIntegrationBranch: "agent/example-org-repo-one/issue-17"
      }
    })
  );
  const comments = [101, 102, 103].map((parentNumber, index) =>
    basePrComment({
      id: `comment:example-org/repo-one:pull_request_comment:70${index + 1}`,
      sourceId: `70${index + 1}`,
      parentNumber,
      body: `retry: https://github.com/example-org/repo-one/pull/${parentNumber}#issuecomment-90${index + 1}`
    })
  );

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: packetPrs
    },
    currentIssues: [issue],
    currentPullRequests: packetPrs,
    currentComments: comments,
    worktrees: packetWorktrees,
    tasks: [],
    now: "2026-04-21T08:05:00.000Z"
  });

  assert.equal(attention.length, 1);
  assert.deepEqual(attention[0]?.reasons, ["pr_comment_added", "retry_requested"]);
  assert.deepEqual(attention[0]?.commentIds, comments.map((comment) => comment.id).sort());
  assert.equal(attention[0]?.retryTargetCommentId, "901");
  assert.equal("retryTargetCommentIds" in attention[0]!, false);
});

function baseRepo(): RepoConfig {
  return {
    id: "repo-1",
    owner: "example-org",
    name: "repo-one",
    localPath: "repo-one",
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
}

function baseIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    kind: "issue",
    id: "issue:example-org/repo-one:17",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    number: 17,
    key: "example-org/repo-one:issue:17",
    sourceId: "ISSUE_17",
    url: "https://github.com/example-org/repo-one/issues/17",
    title: "Need attention records",
    body: "body",
    labels: [],
    author: "owner",
    createdAt: "2026-04-20T09:00:00.000Z",
    updatedAt: "2026-04-20T09:00:00.000Z",
    state: "open",
    ...overrides
  };
}

function basePullRequest(overrides: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  const number = overrides.number ?? 21;
  return {
    kind: "pull_request",
    id: `pull_request:example-org/repo-one:${number}`,
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    number,
    key: `example-org/repo-one:pull_request:${number}`,
    sourceId: `PR_${number}`,
    url: `https://github.com/example-org/repo-one/pull/${number}`,
    title: `PR ${number}`,
    body: "body",
    labels: [],
    author: "owner",
    createdAt: "2026-04-20T09:00:00.000Z",
    updatedAt: "2026-04-20T09:00:00.000Z",
    state: "open",
    headBranch: `feature/pr-${number}`,
    headSha: `head-sha-${number}`,
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false,
    ...overrides
  };
}

function baseWorktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "wt:1",
    repoId: "repo-1",
    repoSlug: "example-org/repo-one",
    repoName: "repo-one",
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

function baseIssueComment(overrides: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    kind: "comment",
    commentKind: "issue_comment",
    id: "comment:example-org/repo-one:issue_comment:5001",
    sourceId: "5001",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    parentType: "issue",
    parentNumber: 17,
    parentKey: "example-org/repo-one:issue:17",
    url: "https://github.com/example-org/repo-one/issues/17#issuecomment-5001",
    body: "Please update this.",
    author: "reviewer",
    createdAt: "2026-04-20T09:10:00.000Z",
    updatedAt: "2026-04-20T09:10:00.000Z",
    ...overrides
  };
}

function basePrComment(overrides: Partial<NormalizedComment> = {}): NormalizedComment {
  const parentNumber = overrides.parentNumber ?? 21;
  return {
    kind: "comment",
    commentKind: "pull_request_comment",
    id: "comment:example-org/repo-one:pull_request_comment:6001",
    sourceId: "6001",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    parentType: "pull_request",
    parentNumber,
    parentKey: `example-org/repo-one:pull_request:${parentNumber}`,
    url: `https://github.com/example-org/repo-one/pull/${parentNumber}#issuecomment-6001`,
    body: "Please address this review note.",
    author: "reviewer",
    createdAt: "2026-04-20T09:10:00.000Z",
    updatedAt: "2026-04-20T09:10:00.000Z",
    ...overrides
  };
}

function issueWorkstream(
  issueNumber: number,
  linkedPrNumbers: number[] = [],
  phase: WorkstreamRecord["phase"] = "issue_triage"
): WorkstreamRecord {
  return {
    id: `example-org/repo-one:issue:${issueNumber}`,
    repoKey: "example-org/repo-one",
    origin: {
      type: "issue",
      number: issueNumber
    },
    linkedIssueNumber: issueNumber,
    linkedPrs: linkedPrNumbers.map((number) => ({ number, status: "open", role: "implementation" })),
    ...(linkedPrNumbers[0] !== undefined ? { activePrNumber: linkedPrNumbers[0] } : {}),
    phase,
    attention: "idle",
    status: "open",
    resolution: "unresolved"
  };
}

function prWorkstream(prNumber: number): WorkstreamRecord {
  return {
    id: `example-org/repo-one:pr:${prNumber}`,
    repoKey: "example-org/repo-one",
    origin: {
      type: "pr",
      number: prNumber
    },
    linkedPrs: [{ number: prNumber, status: "open" }],
    activePrNumber: prNumber,
    phase: "pr_review",
    attention: "review_requested",
    status: "open",
    resolution: "unresolved"
  };
}

function emptyState(): PersistedState {
  return {
    issueMetadata: { partialFailures: [] },
    prMetadata: { partialFailures: [] },
    commentMetadata: { partialFailures: [] },
    issues: [],
    prs: [],
    comments: [],
    tasks: [],
    executions: [],
    worktrees: [],
    workstreams: [],
    attention: [],
    repos: [],
    providerSessions: [],
    jobAgentAssignments: [],
    retrospectiveCandidates: [],
    retrospectiveProblems: [],
    retrospectiveOpportunities: [],
    learningProposals: [],
    managementPrs: [],
    mcpStatuses: [],
    workspaceRecoveries: []
  };
}

test("deriveAttentionRecords surfaces packet_wave_complete_sync_needed for parent issue workstream", () => {
  const issue = baseIssue();
  const workstream: WorkstreamRecord = {
    ...issueWorkstream(issue.number),
    packetPlan: {
      status: "proposed",
      packets: {
        T1: { id: "T1", title: "T1", summary: "S1", status: "merged_to_parent", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [] },
        T2: { id: "T2", title: "T2", summary: "S2", status: "merged_to_parent", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [] },
        T3: { id: "T3", title: "T3", summary: "S3", status: "planned", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [] }
      },
      waves: [["T1", "T2"], ["T3"]],
      currentWaveIndex: 0
    }
  };

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: { ...emptyState(), issues: [issue] },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.ok(attention.some(r => r.reasons.includes("packet_wave_complete_sync_needed") && r.needsAction));
});

test("deriveAttentionRecords does not surface sync reason when wave is incomplete", () => {
  const issue = baseIssue();
  const workstream: WorkstreamRecord = {
    ...issueWorkstream(issue.number),
    packetPlan: {
      status: "proposed",
      packets: {
        T1: { id: "T1", title: "T1", summary: "S1", status: "merged_to_parent", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [] },
        T2: { id: "T2", title: "T2", summary: "S2", status: "planned", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [] },
        T3: { id: "T3", title: "T3", summary: "S3", status: "planned", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [] }
      },
      waves: [["T1", "T2"], ["T3"]],
      currentWaveIndex: 0
    }
  };

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: { ...emptyState(), issues: [issue] },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.ok(!attention.some(r => r.reasons.includes("packet_wave_complete_sync_needed")));
});

test("deriveAttentionRecords does not surface sync reason when no future wave exists", () => {
  const issue = baseIssue();
  const workstream: WorkstreamRecord = {
    ...issueWorkstream(issue.number),
    packetPlan: {
      status: "proposed",
      packets: {
        T3: { id: "T3", title: "T3", summary: "S3", status: "merged_to_parent", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], blocks: [], canRunInParallelWith: [] }
      },
      waves: [["T1", "T2"], ["T3"]],
      currentWaveIndex: 1
    }
  };

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: { ...emptyState(), issues: [issue] },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.ok(!attention.some(r => r.reasons.includes("packet_wave_complete_sync_needed")));
});

test("deriveAttentionRecords surfaces prepare_for_merge_requested when label is present on linked open PR", () => {
  const pr = basePullRequest({ labels: ["prepare-for-merge"] });
  const workstream = prWorkstream(pr.number);

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: { ...emptyState(), prs: [pr] },
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.ok(attention.some(r => r.reasons.includes("prepare_for_merge_requested") && r.needsAction));
});

test("deriveAttentionRecords does not surface prepare_for_merge_requested when label is absent", () => {
  const pr = basePullRequest({ labels: [] });
  const workstream = prWorkstream(pr.number);

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: { ...emptyState(), prs: [pr] },
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.ok(!attention.some(r => r.reasons.includes("prepare_for_merge_requested")));
});

test("deriveAttentionRecords does not surface prepare_for_merge_requested when PR is closed", () => {
  const pr = basePullRequest({ labels: ["prepare-for-merge"], state: "closed" });
  const workstream = prWorkstream(pr.number);

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: { ...emptyState(), prs: [pr] },
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  assert.ok(!attention.some(r => r.reasons.includes("prepare_for_merge_requested")));
});

test("deriveAttentionRecords detects fresh mcp-skip PR comments and populates AttentionRecord", () => {
  const pr = basePullRequest();
  const workstream = {
    ...prWorkstream(pr.number),
    mcpBlockers: [{
      id: "blocker-1",
      kind: "mcp_action_required" as const,
      mcpHandle: "context7",
      affectedCapabilityNames: ["context7-docs"],
      safeReason: "needs setup",
      blockedTaskKind: "implement_plan" as const,
      blockedTaskId: "task-1",
      createdAt: "2026-04-20T09:05:00.000Z",
      updatedAt: "2026-04-20T09:05:00.000Z",
      resolutionState: "waiting_for_user" as const
    }]
  };
  const comment = basePrComment({
    body: "mcp-skip: task-1 context7",
    createdAt: "2026-04-20T09:10:00.000Z",
    updatedAt: "2026-04-20T09:10:00.000Z"
  });

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [comment],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  const record = attention.find(r => r.workstreamId === workstream.id);
  assert.ok(record);
  assert.ok(record.reasons.includes("mcp_skip_requested"));
  assert.equal(record.mcpSkipTargetTaskId, "task-1");
  assert.equal(record.mcpSkipMcpHandle, "context7");
  assert.equal(record.needsAction, true);
});

test("deriveAttentionRecords detects fresh mcp-skip issue comments", () => {
  const issue = baseIssue();
  const workstream = {
    ...issueWorkstream(issue.number),
    mcpBlockers: [{
      id: "blocker-1",
      kind: "mcp_action_required" as const,
      mcpHandle: "context7",
      affectedCapabilityNames: ["context7-docs"],
      safeReason: "needs setup",
      blockedTaskKind: "implement_plan" as const,
      blockedTaskId: "task-1",
      createdAt: "2026-04-20T09:05:00.000Z",
      updatedAt: "2026-04-20T09:05:00.000Z",
      resolutionState: "waiting_for_user" as const
    }]
  };
  const comment = baseIssueComment({
    body: "mcp-skip: task-1 context7",
    createdAt: "2026-04-20T09:10:00.000Z",
    updatedAt: "2026-04-20T09:10:00.000Z"
  });

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [comment],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  const record = attention.find(r => r.workstreamId === workstream.id);
  assert.ok(record);
  assert.ok(record.reasons.includes("mcp_skip_requested"));
  assert.equal(record.mcpSkipTargetTaskId, "task-1");
  assert.equal(record.mcpSkipMcpHandle, "context7");
  assert.equal(record.needsAction, true);
});

test("deriveAttentionRecords ignores stale mcp-skip comments (comment older than blocker)", () => {
  const pr = basePullRequest();
  const workstream = {
    ...prWorkstream(pr.number),
    mcpBlockers: [{
      id: "blocker-1",
      kind: "mcp_action_required" as const,
      mcpHandle: "context7",
      affectedCapabilityNames: ["context7-docs"],
      safeReason: "needs setup",
      blockedTaskKind: "implement_plan" as const,
      blockedTaskId: "task-1",
      createdAt: "2026-04-20T09:15:00.000Z", // Blocker is newer than comment
      updatedAt: "2026-04-20T09:15:00.000Z",
      resolutionState: "waiting_for_user" as const
    }]
  };
  const comment = basePrComment({
    body: "mcp-skip: task-1 context7",
    createdAt: "2026-04-20T09:10:00.000Z",
    updatedAt: "2026-04-20T09:10:00.000Z"
  });

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [comment],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  const record = attention.find(r => r.workstreamId === workstream.id);
  assert.ok(record);
  assert.ok(!record.reasons.includes("mcp_skip_requested"));
  assert.equal(record.mcpSkipTargetTaskId, undefined);
  assert.equal(record.mcpSkipMcpHandle, undefined);
});

test("deriveAttentionRecords detects skip command even if no matching blocker exists", () => {
  const pr = basePullRequest();
  const workstream = prWorkstream(pr.number); // no blockers
  const comment = basePrComment({
    body: "mcp-skip: task-1 context7",
    createdAt: "2026-04-20T09:10:00.000Z",
    updatedAt: "2026-04-20T09:10:00.000Z"
  });

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [comment],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  const record = attention.find(r => r.workstreamId === workstream.id);
  assert.ok(record);
  assert.ok(record.reasons.includes("mcp_skip_requested"));
  assert.equal(record.mcpSkipTargetTaskId, "task-1");
  assert.equal(record.mcpSkipMcpHandle, "context7");
});

test("deriveAttentionRecords ignores agent-authored mcp-skip comments", () => {
  const pr = basePullRequest();
  const workstream = prWorkstream(pr.number);
  const comment = basePrComment({
    body: "🤖 mcp-skip: task-1 context7",
    createdAt: "2026-04-20T09:10:00.000Z",
    updatedAt: "2026-04-20T09:10:00.000Z"
  });

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [comment],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  const record = attention.find(r => r.workstreamId === workstream.id);
  assert.ok(record);
  assert.ok(!record.reasons.includes("mcp_skip_requested"));
});

test("deriveAttentionRecords ignores malformed mcp-skip comments", () => {
  const pr = basePullRequest();
  const workstream = prWorkstream(pr.number);
  const comment = basePrComment({
    body: "mcp-skip: task-1", // missing handle
    createdAt: "2026-04-20T09:10:00.000Z",
    updatedAt: "2026-04-20T09:10:00.000Z"
  });

  const attention = deriveAttentionRecords({
    repos: [baseRepo()],
    workstreams: [workstream],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [comment],
    tasks: [],
    now: "2026-04-20T10:00:00.000Z"
  });

  const record = attention.find(r => r.workstreamId === workstream.id);
  assert.ok(record);
  assert.ok(!record.reasons.includes("mcp_skip_requested"));
});
