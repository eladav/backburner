import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoConfig } from "../src/config/types.js";
import type { NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import type { AttentionRecord, WorkstreamRecord, WorktreeRecord } from "../src/state/types.js";
import { deriveWorkstreams } from "../src/workstreams/derive.js";

test("deriveWorkstreams creates one issue-originated workstream for a relevant normalized issue", () => {
  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [baseIssue()],
    currentPullRequests: [],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.deepEqual(workstreams, [
    {
      id: "eladaviv/repo-one:issue:17",
      repoKey: "eladaviv/repo-one",
      origin: {
        type: "issue",
        number: 17
      },
      linkedIssueNumber: 17,
      linkedPrs: [],
      phase: "product_discovery",
      attention: "idle",
      status: "open",
      resolution: "unresolved",
      product: {
        status: "in_discovery",
        approvalLabel: "agent-product-approved"
      }
    }
  ]);
});

test("deriveWorkstreams lets an issue-originated workstream accumulate multiple linked PRs", () => {
  const issue = baseIssue();
  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [
      basePullRequest({
        number: 21,
        headBranch: "agent/eladaviv-repo-one/issue-17",
        labels: ["agent-in-progress"]
      }),
      basePullRequest({
        number: 22,
        headBranch: "agent/eladaviv-repo-one/issue-17-followup",
        labels: ["agent-plan-approved"]
      })
    ],
    worktrees: [
      baseWorktree({
        id: "worktree:eladaviv/repo-one:issue:17",
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: "agent/eladaviv-repo-one/issue-17",
        prNumber: 21
      }),
      baseWorktree({
        id: "worktree:eladaviv/repo-one:issue:17:followup",
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: "agent/eladaviv-repo-one/issue-17-followup",
        prNumber: 22,
        status: "awaiting_plan_approval",
        updatedAt: "2026-04-20T10:05:00.000Z"
      })
    ],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.deepEqual(workstreams[0]?.linkedPrs, [
    { number: 21, status: "open", role: "implementation" },
    { number: 22, status: "open", role: "implementation" }
  ]);
  assert.equal(workstreams[0]?.activePrNumber, 22);
  assert.equal(workstreams[0]?.activeWorktreeId, "worktree:eladaviv/repo-one:issue:17:followup");
  assert.equal(workstreams[0]?.phase, "implementation_ready");
});

test("deriveWorkstreams creates a PR-originated workstream for an unrelated PR", () => {
  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [basePullRequest({ number: 23, labels: ["agent-review"] })],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.deepEqual(workstreams, [
    {
      id: "eladaviv/repo-one:pr:23",
      repoKey: "eladaviv/repo-one",
      origin: {
        type: "pr",
        number: 23
      },
      linkedPrs: [{ number: 23, status: "open" }],
      activePrNumber: 23,
      phase: "pr_review",
      attention: "review_requested",
      status: "open",
      resolution: "unresolved",
      integration: {
        branchName: "feature/pr",
        prNumber: 23
      }
    }
  ]);
});

test("deriveWorkstreams suppresses standalone workstream for matched packet PR", () => {
  const parentPr = basePullRequest({
    number: 100,
    headBranch: "workstream/issue-84",
    labels: ["agent-review"]
  });

  const packetPr = basePullRequest({
    number: 101,
    baseBranch: "workstream/issue-84",
    baseClassification: "non_default_parent",
    headBranch: "packet/t1",
    labels: ["agent-review"]
  });

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [parentPr, packetPr],
    worktrees: [],
    previousWorkstreams: []
  });

  // PR 100 should be a workstream
  assert.ok(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:100"));
  // PR 101 should NOT be a workstream
  assert.equal(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:101"), undefined);
});

test("deriveWorkstreams preserves orphan non-default PR behavior", () => {
  const pr = basePullRequest({
    number: 102,
    baseBranch: "some/manual-base",
    baseClassification: "non_default_parent",
    labels: ["agent-review"]
  });

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [pr],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.id, "eladaviv/repo-one:pr:102");
});

test("deriveWorkstreams suppresses previous stale PR workstream for now-matched packet PR", () => {
  const parentPr = basePullRequest({
    number: 100,
    headBranch: "workstream/issue-84",
    labels: ["agent-review"]
  });

  const packetPr = basePullRequest({
    number: 101,
    baseBranch: "workstream/issue-84",
    baseClassification: "non_default_parent",
    headBranch: "packet/t1",
    labels: ["agent-review"]
  });

  const previousWorkstream: WorkstreamRecord = {
    id: "eladaviv/repo-one:pr:101",
    repoKey: "eladaviv/repo-one",
    origin: { type: "pr", number: 101 },
    linkedPrs: [{ number: 101, status: "open" }],
    activePrNumber: 101,
    phase: "pr_review",
    attention: "review_requested",
    status: "open",
    resolution: "unresolved"
  };

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [parentPr, packetPr],
    worktrees: [],
    previousWorkstreams: [previousWorkstream]
  });

  assert.ok(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:100"));
  assert.equal(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:101"), undefined);
});

test("deriveWorkstreams packet matching is repo-scoped", () => {
  const repoA = baseRepo();
  const repoB = { ...baseRepo(), id: "repo-2", name: "repo-two" };

  const parentPrA = basePullRequest({
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    repoKey: "eladaviv/repo-one",
    number: 100,
    headBranch: "workstream/shared",
    labels: ["agent-review"]
  });

  const packetPrB = basePullRequest({
    repoId: "repo-2",
    repoName: "repo-two",
    repoSlug: "eladaviv/repo-two",
    repoKey: "eladaviv/repo-two",
    number: 101,
    baseBranch: "workstream/shared",
    baseClassification: "non_default_parent",
    headBranch: "packet/t1",
    labels: ["agent-review"]
  });

  const workstreams = deriveWorkstreams({
    repos: [repoA, repoB],
    currentIssues: [],
    currentPullRequests: [parentPrA, packetPrB],
    worktrees: [],
    previousWorkstreams: []
  });

  // PR 101 in Repo B should NOT be suppressed by PR 100 in Repo A
  assert.ok(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:100"));
  assert.ok(workstreams.find(ws => ws.id === "eladaviv/repo-two:pr:101"));
});

test("deriveWorkstreams packet matching does not hard-code main", () => {
  const repo = { ...baseRepo(), defaultBranch: "production" };
  const parentPr = basePullRequest({
    number: 200,
    baseBranch: "production",
    defaultBranch: "production",
    headBranch: "workstream/prod-parent",
    labels: ["agent-review"]
  });

  const packetPr = basePullRequest({
    number: 201,
    baseBranch: "workstream/prod-parent",
    defaultBranch: "production",
    baseClassification: "non_default_parent",
    headBranch: "packet/t1",
    labels: ["agent-review"]
  });

  const workstreams = deriveWorkstreams({
    repos: [repo],
    currentIssues: [],
    currentPullRequests: [parentPr, packetPr],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.ok(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:200"));
  assert.equal(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:201"), undefined);
});

test("deriveWorkstreams does NOT assign integration metadata to PR-originated workstreams targeting non-default branch", () => {
  const pr = basePullRequest({
    number: 100,
    baseBranch: "develop",
    defaultBranch: "main",
    baseClassification: "non_default_parent",
    labels: ["agent-review"]
  });

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [pr],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.id, "eladaviv/repo-one:pr:100");
  assert.equal(workstreams[0]?.integration, undefined);
});

test("deriveWorkstreams does not create workstreams for non-default parent PRs without relevance", () => {
  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [
      basePullRequest({
        number: 123,
        baseBranch: "workstream/issue-72",
        baseClassification: "non_default_parent",
        labels: [] // No agent labels
      })
    ],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 0);
});

test("deriveWorkstreams attaches a linked implementation PR to the issue workstream when worktree linkage exists", () => {
  const issue = baseIssue();
  const pr = basePullRequest({
    number: 24,
    headBranch: "agent/eladaviv-repo-one/issue-17",
    labels: ["agent-plan-approved"]
  });

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [pr],
    worktrees: [
      baseWorktree({
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: pr.headBranch,
        status: "awaiting_plan_approval"
      })
    ],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.id, "eladaviv/repo-one:issue:17");
  assert.deepEqual(workstreams[0]?.linkedPrs, [
    { number: 24, status: "open", role: "implementation" }
  ]);
  assert.equal(workstreams[0]?.phase, "implementation_ready");
});

test("deriveWorkstreams does not create workstreams from comments alone", () => {
  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.deepEqual(workstreams, []);
});

test("deriveWorkstreams preserves prior workstream links across repeated runs", () => {
  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [],
    worktrees: [],
    previousWorkstreams: [
      {
        id: "eladaviv/repo-one:issue:17",
        repoKey: "eladaviv/repo-one",
        origin: {
          type: "issue",
          number: 17
        },
        linkedIssueNumber: 17,
        linkedPrs: [
          {
            number: 21,
            status: "merged",
            role: "implementation"
          }
        ],
        activePrNumber: 21,
        activeWorktreeId: "worktree:eladaviv/repo-one:issue:17",
        phase: "resolved",
        attention: "idle",
        status: "merged",
        resolution: "merged"
      }
    ]
  });

  assert.deepEqual(workstreams, [
    {
      id: "eladaviv/repo-one:issue:17",
      repoKey: "eladaviv/repo-one",
      origin: {
        type: "issue",
        number: 17
      },
      linkedIssueNumber: 17,
      linkedPrs: [
        {
          number: 21,
          status: "merged",
          role: "implementation"
        }
      ],
      activePrNumber: 21,
      activeWorktreeId: "worktree:eladaviv/repo-one:issue:17",
      phase: "resolved",
      attention: "idle",
      status: "merged",
      resolution: "merged"
    }
  ]);
});

test("deriveWorkstreams moves triage to planning when an implementation worktree appears", () => {
  const issue = baseIssue();

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [],
    worktrees: [baseWorktree({ issueId: issue.id, issueNumber: issue.number })],
    previousWorkstreams: [
      {
        id: "eladaviv/repo-one:issue:17",
        repoKey: "eladaviv/repo-one",
        origin: { type: "issue", number: 17 },
        linkedIssueNumber: 17,
        linkedPrs: [],
        phase: "issue_triage",
        attention: "idle",
        status: "open",
        resolution: "unresolved"
      }
    ]
  });

  assert.equal(workstreams[0]?.phase, "planning");
});

test("deriveWorkstreams moves planning to implementation_ready when approval appears", () => {
  const issue = baseIssue();
  const pr = basePullRequest({
    number: 24,
    headBranch: "agent/eladaviv-repo-one/issue-17",
    labels: ["agent-plan-approved"]
  });

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [pr],
    worktrees: [
      baseWorktree({
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: pr.headBranch,
        prId: pr.id,
        prNumber: pr.number,
        status: "implementation_ready"
      })
    ],
    previousWorkstreams: [
      {
        id: "eladaviv/repo-one:issue:17",
        repoKey: "eladaviv/repo-one",
        origin: { type: "issue", number: 17 },
        linkedIssueNumber: 17,
        linkedPrs: [{ number: 24, status: "open", role: "implementation" }],
        activePrNumber: 24,
        activeWorktreeId: "worktree:eladaviv/repo-one:issue:17",
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved"
      }
    ]
  });

  assert.equal(workstreams[0]?.phase, "implementation_ready");
});

test("deriveWorkstreams moves implementation_ready to implementing when worktree execution starts", () => {
  const issue = baseIssue();
  const pr = basePullRequest({
    number: 24,
    headBranch: "agent/eladaviv-repo-one/issue-17",
    labels: ["agent-plan-approved"]
  });

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [pr],
    worktrees: [
      baseWorktree({
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: pr.headBranch,
        prId: pr.id,
        prNumber: pr.number,
        status: "implementing"
      })
    ],
    previousWorkstreams: [
      {
        id: "eladaviv/repo-one:issue:17",
        repoKey: "eladaviv/repo-one",
        origin: { type: "issue", number: 17 },
        linkedIssueNumber: 17,
        linkedPrs: [{ number: 24, status: "open", role: "implementation" }],
        activePrNumber: 24,
        activeWorktreeId: "worktree:eladaviv/repo-one:issue:17",
        phase: "implementation_ready",
        attention: "idle",
        status: "open",
        resolution: "unresolved"
      }
    ]
  });

  assert.equal(workstreams[0]?.phase, "implementing");
});

test("deriveWorkstreams uses feedback phases for planning and implementing comment attention", () => {
  const issue = baseIssue();
  const pr = basePullRequest({
    number: 24,
    headBranch: "agent/eladaviv-repo-one/issue-17",
    labels: ["agent-plan-approved"]
  });
  const planningAttention: AttentionRecord = {
    workstreamId: "eladaviv/repo-one:issue:17",
    repoKey: "eladaviv/repo-one",
    needsAction: true,
    reasons: ["pr_comment_added"],
    lastObservedAt: "2026-04-20T10:10:00.000Z"
  };
  const implementationAttention: AttentionRecord = {
    ...planningAttention,
    reasons: ["issue_comment_added"]
  };

  const planningWorkstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [basePullRequest({ number: 24, headBranch: pr.headBranch, labels: ["agent-in-progress"] })],
    worktrees: [
      baseWorktree({
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: pr.headBranch,
        prId: pr.id,
        prNumber: pr.number,
        status: "awaiting_plan_approval"
      })
    ],
    previousWorkstreams: [],
    attention: [planningAttention]
  });
  assert.equal(planningWorkstreams[0]?.phase, "plan_feedback");

  const implementingWorkstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [pr],
    worktrees: [
      baseWorktree({
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: pr.headBranch,
        prId: pr.id,
        prNumber: pr.number,
        status: "implementing"
      })
    ],
    previousWorkstreams: [],
    attention: [implementationAttention]
  });
  assert.equal(implementingWorkstreams[0]?.phase, "implementation_feedback");
});

test("deriveWorkstreams exposes resolved and abandoned scaffolding", () => {
  const resolved = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [basePullRequest({ number: 30, state: "merged", labels: ["agent-review"] })],
    worktrees: [],
    previousWorkstreams: []
  });
  assert.equal(resolved[0]?.phase, "resolved");

  const abandoned = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [],
    worktrees: [],
    previousWorkstreams: [
      {
        id: "eladaviv/repo-one:issue:99",
        repoKey: "eladaviv/repo-one",
        origin: { type: "issue", number: 99 },
        linkedIssueNumber: 99,
        linkedPrs: [],
        phase: "planning",
        attention: "idle",
        status: "closed",
        resolution: "closed"
      }
    ]
  });
  assert.equal(abandoned[0]?.phase, "abandoned");
});

test("deriveWorkstreams creates a PR-originated workstream for a standalone PR with only plan-breakdown-needed", () => {
  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [
      basePullRequest({
        number: 63,
        labels: ["plan-breakdown-needed"]
      })
    ],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.id, "eladaviv/repo-one:pr:63");
  assert.equal(workstreams[0]?.origin.type, "pr");
  assert.deepEqual(workstreams[0]?.linkedPrs, [{ number: 63, status: "open" }]);
});

test("deriveWorkstreams creates a PR-originated workstream for a standalone PR with only prepare-for-merge", () => {
  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [
      basePullRequest({
        number: 64,
        labels: ["prepare-for-merge"]
      })
    ],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.id, "eladaviv/repo-one:pr:64");
  assert.equal(workstreams[0]?.attention, "prepare_for_merge_requested");
});

test("deriveWorkstreams surfaces prepare_for_merge_requested attention for issue workstream", () => {
  const issue = baseIssue();
  const pr = basePullRequest({
    number: 21,
    labels: ["prepare-for-merge"]
  });

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [pr],
    worktrees: [
      baseWorktree({
        issueId: issue.id,
        issueNumber: issue.number,
        prNumber: 21
      })
    ],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.attention, "prepare_for_merge_requested");
});

test("deriveWorkstreams preserves packetPlan for issue-originated workstreams", () => {
  const issue = baseIssue();
  const packetPlan: NonNullable<WorkstreamRecord["packetPlan"]> = {
    status: "proposed",
    packets: {},
    waves: [],
    currentWaveIndex: 0
  };

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [],
    worktrees: [],
    previousWorkstreams: [
      {
        id: "eladaviv/repo-one:issue:17",
        repoKey: "eladaviv/repo-one",
        origin: { type: "issue", number: 17 },
        linkedIssueNumber: 17,
        linkedPrs: [],
        phase: "issue_triage",
        attention: "idle",
        status: "open",
        resolution: "unresolved",
        packetPlan
      }
    ]
  });

  assert.deepEqual(workstreams[0]?.packetPlan, packetPlan);
});

test("deriveWorkstreams preserves packetPlan for PR-originated workstreams", () => {
  const pr = basePullRequest({ number: 63, labels: ["plan-breakdown-needed"] });
  const packetPlan: NonNullable<WorkstreamRecord["packetPlan"]> = {
    status: "proposed",
    packets: {},
    waves: [],
    currentWaveIndex: 0
  };

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [pr],
    worktrees: [],
    previousWorkstreams: [
      {
        id: "eladaviv/repo-one:pr:63",
        repoKey: "eladaviv/repo-one",
        origin: { type: "pr", number: 63 },
        linkedPrs: [{ number: 63, status: "open" }],
        activePrNumber: 63,
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved",
        packetPlan
      }
    ]
  });

  assert.deepEqual(workstreams[0]?.packetPlan, packetPlan);
});

test("deriveWorkstreams filters out packet worktrees from active worktree selection", () => {
  const issue = baseIssue();

  // Integration worktree (older)
  const integrationWorktree = baseWorktree({
    id: "worktree:integration",
    issueId: issue.id,
    issueNumber: issue.number,
    updatedAt: "2026-04-20T10:00:00.000Z"
  });

  // Packet worktree (newer)
  const packetWorktree = baseWorktree({
    id: "worktree:packet",
    packet: {
      parentWorkstreamId: "eladaviv/repo-one:issue:17",
      packetId: "p1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    },
    updatedAt: "2026-04-20T11:00:00.000Z" // Newer
  });
  // Manually remove issueId/issueNumber to ensure it's a pure packet worktree
  delete packetWorktree.issueId;
  delete packetWorktree.issueNumber;

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [],
    worktrees: [integrationWorktree, packetWorktree],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  // Should pick integration worktree despite being older
  assert.equal(workstreams[0]?.activeWorktreeId, "worktree:integration");
});

test("deriveWorkstreams parent integration branch remains stable when packet worktrees exist", () => {
  const issue = baseIssue();
  const integrationBranch = "agent/eladaviv-repo-one/issue-17";

  const previousWorkstream: WorkstreamRecord = {
    id: "eladaviv/repo-one:issue:17",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [{ number: 100, status: "open", role: "implementation" }],
    activePrNumber: 100,
    activeWorktreeId: "worktree:integration",
    phase: "implementing",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: {
      branchName: integrationBranch,
      prNumber: 100
    }
  };

  const previousPacketWorkstream: WorkstreamRecord = {
    id: "eladaviv/repo-one:pr:101",
    repoKey: "eladaviv/repo-one",
    origin: { type: "pr", number: 101 },
    linkedPrs: [{ number: 101, status: "open" }],
    activePrNumber: 101,
    phase: "pr_review",
    attention: "review_requested",
    status: "open",
    resolution: "unresolved"
  };

  const packetWorktree = baseWorktree({
    id: "worktree:packet",
    packet: {
      parentWorkstreamId: "eladaviv/repo-one:issue:17",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: integrationBranch
    },
    baseBranch: integrationBranch,
    branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
    prNumber: 101,
    updatedAt: "2026-04-20T11:00:00.000Z"
  });
  delete packetWorktree.issueId;
  delete packetWorktree.issueNumber;

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [
      basePullRequest({ number: 100, headBranch: integrationBranch }),
      basePullRequest({
        number: 101,
        baseBranch: integrationBranch,
        baseClassification: "non_default_parent",
        headBranch: packetWorktree.branchName
      })
    ],
    worktrees: [
      baseWorktree({
        id: "worktree:integration",
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: integrationBranch,
        prNumber: 100
      }),
      packetWorktree
    ],
    previousWorkstreams: [previousWorkstream, previousPacketWorkstream]
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.integration?.branchName, integrationBranch);
  assert.equal(workstreams[0]?.integration?.prNumber, 100);
  assert.equal(workstreams[0]?.activePrNumber, 100);
  assert.equal(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:101"), undefined);
});

test("deriveWorkstreams does not pick any active worktree if only packet worktrees exist", () => {
  const issue = baseIssue();

  const packetWorktree = baseWorktree({
    id: "worktree:packet",
    packet: {
      parentWorkstreamId: "eladaviv/repo-one:issue:17",
      packetId: "p1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    }
  });
  delete packetWorktree.issueId;
  delete packetWorktree.issueNumber;

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [],
    worktrees: [packetWorktree],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.activeWorktreeId, undefined);
});

test("deriveWorkstreams keeps parent active worktree when approved packet is implementation_ready", () => {
  const repo = baseRepo();
  const issue = baseIssue();
  const integrationBranch = "agent/eladaviv-repo-one/issue-17";

  const parentPr = basePullRequest({
    number: 100,
    headBranch: integrationBranch,
    labels: ["agent-in-progress"]
  });

  const packetWorktree = baseWorktree({
    id: "worktree:packet",
    packet: {
      parentWorkstreamId: "eladaviv/repo-one:issue:17",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: integrationBranch
    },
    baseBranch: integrationBranch,
    branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
    status: "implementation_ready",
    prNumber: 101,
    updatedAt: "2026-04-20T11:00:00.000Z" // Newer than integration worktree
  });
  delete packetWorktree.issueId;
  delete packetWorktree.issueNumber;

  const packetPr = basePullRequest({
    number: 101,
    baseBranch: integrationBranch,
    baseClassification: "non_default_parent",
    headBranch: packetWorktree.branchName,
    labels: [repo.labels.agentPlanApproved]
  });

  const integrationWorktree = baseWorktree({
    id: "worktree:integration",
    issueId: issue.id,
    issueNumber: issue.number,
    branchName: integrationBranch,
    prNumber: 100,
    status: "implementing",
    updatedAt: "2026-04-20T10:00:00.000Z"
  });

  const workstreams = deriveWorkstreams({
    repos: [repo],
    currentIssues: [issue],
    currentPullRequests: [parentPr, packetPr],
    worktrees: [integrationWorktree, packetWorktree],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.id, "eladaviv/repo-one:issue:17");
  assert.equal(workstreams[0]?.activeWorktreeId, "worktree:integration");
  assert.equal(workstreams[0]?.activePrNumber, 100);
  assert.equal(workstreams[0]?.integration?.branchName, integrationBranch);

  // Ensure packet PR is still suppressed from being a standalone workstream
  assert.equal(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:101"), undefined);
});

test("deriveWorkstreams updates the parent workstream packet plan but does not resolve or advance it", () => {
  const issue = baseIssue();
  const integrationBranch = "agent/eladaviv-repo-one/issue-17";

  const packetPlan: WorkstreamRecord["packetPlan"] = {
    status: "approved",
    packets: {
      T1: {
        id: "T1",
        title: "T1",
        summary: "S1",
        acceptanceCriteria: [],
        filesLikelyTouched: [],
        dependsOn: [],
        canRunInParallelWith: [],
        blocks: [],
        status: "pr_open",
        prNumber: 101,
        branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d"
      }
    },
    waves: [["T1"]],
    currentWaveIndex: 0
  };

  const previousWorkstream: WorkstreamRecord = {
    id: "eladaviv/repo-one:issue:17",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [{ number: 100, status: "open", role: "implementation" }],
    activePrNumber: 100,
    activeWorktreeId: "worktree:integration",
    phase: "implementing",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: {
      branchName: integrationBranch,
      prNumber: 100
    },
    packetPlan
  };

  const previousPacketWorkstream: WorkstreamRecord = {
    id: "eladaviv/repo-one:pr:101",
    repoKey: "eladaviv/repo-one",
    origin: { type: "pr", number: 101 },
    linkedPrs: [{ number: 101, status: "open" }],
    activePrNumber: 101,
    phase: "pr_review",
    attention: "review_requested",
    status: "open",
    resolution: "unresolved"
  };

  const packetWorktree = baseWorktree({
    id: "worktree:packet",
    packet: {
      parentWorkstreamId: "eladaviv/repo-one:issue:17",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: integrationBranch
    },
    baseBranch: integrationBranch,
    branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
    prNumber: 101,
    updatedAt: "2026-04-20T11:00:00.000Z"
  });
  delete packetWorktree.issueId;
  delete packetWorktree.issueNumber;

  const mergedPacketPr = basePullRequest({
    number: 101,
    state: "merged",
    baseBranch: integrationBranch,
    baseClassification: "non_default_parent",
    headBranch: packetWorktree.branchName
  });

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [
      basePullRequest({ number: 100, headBranch: integrationBranch }),
      mergedPacketPr
    ],
    worktrees: [
      baseWorktree({
        id: "worktree:integration",
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: integrationBranch,
        prNumber: 100
      }),
      packetWorktree
    ],
    previousWorkstreams: [previousWorkstream, previousPacketWorkstream]
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.packetPlan?.packets.T1?.status, "merged_to_parent");
  assert.equal(workstreams[0]?.status, "open");
  assert.equal(workstreams[0]?.resolution, "unresolved");
  assert.equal(workstreams[0]?.packetPlan?.currentWaveIndex, 0);

  // Ensure packet PR is still suppressed from being a standalone workstream
  assert.equal(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:101"), undefined);
});

test("deriveWorkstreams: All current-wave packets merged does not advance waves", () => {
  const issue = baseIssue();
  const integrationBranch = "agent/eladaviv-repo-one/issue-17";

  const packetPlan: WorkstreamRecord["packetPlan"] = {
    status: "approved",
    packets: {
      T1: {
        id: "T1",
        title: "T1",
        summary: "S1",
        acceptanceCriteria: [],
        filesLikelyTouched: [],
        dependsOn: [],
        canRunInParallelWith: [],
        blocks: [],
        status: "pr_open",
        prNumber: 101,
        branchName: "packet-t1"
      },
      T2: {
        id: "T2",
        title: "T2",
        summary: "S2",
        acceptanceCriteria: [],
        filesLikelyTouched: [],
        dependsOn: [],
        canRunInParallelWith: [],
        blocks: [],
        status: "pr_open",
        prNumber: 102,
        branchName: "packet-t2"
      }
    },
    waves: [["T1", "T2"], ["T3"]],
    currentWaveIndex: 0
  };
  // Adding T3 just to have another wave
  packetPlan.packets.T3 = {
    id: "T3",
    title: "T3",
    summary: "S3",
    acceptanceCriteria: [],
    filesLikelyTouched: [],
    dependsOn: ["T1", "T2"],
    canRunInParallelWith: [],
    blocks: [],
    status: "planned"
  };

  const previousWorkstream: WorkstreamRecord = {
    id: "eladaviv/repo-one:issue:17",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [{ number: 100, status: "open", role: "implementation" }],
    activePrNumber: 100,
    activeWorktreeId: "worktree:integration",
    phase: "implementing",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: {
      branchName: integrationBranch,
      prNumber: 100
    },
    packetPlan
  };

  const previousPacketWorkstream1: WorkstreamRecord = {
    id: "eladaviv/repo-one:pr:101",
    repoKey: "eladaviv/repo-one",
    origin: { type: "pr", number: 101 },
    linkedPrs: [{ number: 101, status: "open" }],
    activePrNumber: 101,
    phase: "pr_review",
    attention: "review_requested",
    status: "open",
    resolution: "unresolved"
  };

  const previousPacketWorkstream2: WorkstreamRecord = {
    id: "eladaviv/repo-one:pr:102",
    repoKey: "eladaviv/repo-one",
    origin: { type: "pr", number: 102 },
    linkedPrs: [{ number: 102, status: "open" }],
    activePrNumber: 102,
    phase: "pr_review",
    attention: "review_requested",
    status: "open",
    resolution: "unresolved"
  };

  const worktree1 = baseWorktree({
    id: "wt-p1",
    packet: { parentWorkstreamId: previousWorkstream.id, packetId: "T1", waveIndex: 0, parentIntegrationBranch: integrationBranch },
    branchName: "packet-t1",
    prNumber: 101
  });
  const worktree2 = baseWorktree({
    id: "wt-p2",
    packet: { parentWorkstreamId: previousWorkstream.id, packetId: "T2", waveIndex: 0, parentIntegrationBranch: integrationBranch },
    branchName: "packet-t2",
    prNumber: 102
  });
  delete worktree1.issueId; delete worktree1.issueNumber;
  delete worktree2.issueId; delete worktree2.issueNumber;

  const pr1 = basePullRequest({ number: 101, state: "merged", baseBranch: integrationBranch, baseClassification: "non_default_parent", headBranch: "packet-t1" });
  const pr2 = basePullRequest({ number: 102, state: "merged", baseBranch: integrationBranch, baseClassification: "non_default_parent", headBranch: "packet-t2" });

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [issue],
    currentPullRequests: [
      basePullRequest({ number: 100, headBranch: integrationBranch }),
      pr1, pr2
    ],
    worktrees: [
      baseWorktree({ id: "wt-int", issueId: issue.id, issueNumber: issue.number, branchName: integrationBranch, prNumber: 100 }),
      worktree1, worktree2
    ],
    previousWorkstreams: [previousWorkstream, previousPacketWorkstream1, previousPacketWorkstream2]
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.packetPlan?.packets.T1?.status, "merged_to_parent");
  assert.equal(workstreams[0]?.packetPlan?.packets.T2?.status, "merged_to_parent");
  assert.equal(workstreams[0]?.packetPlan?.currentWaveIndex, 0); // Should NOT advance
  assert.equal(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:101"), undefined);
  assert.equal(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:102"), undefined);
});

test("deriveWorkstreams ignores stale packet PRs from previous linkedPrs when marking packet merged", () => {
  const repo = baseRepo();
  const issue = baseIssue();
  const integrationBranch = "agent/eladaviv-repo-one/issue-17";

  const parentPr = basePullRequest({
    number: 100,
    headBranch: integrationBranch,
    labels: ["agent-in-progress"]
  });

  const packetPr = basePullRequest({
    number: 101,
    baseBranch: integrationBranch,
    baseClassification: "non_default_parent",
    headBranch: "packet-branch",
    labels: ["agent-review"],
    state: "merged"
  });

  const previousWorkstream: WorkstreamRecord = {
    id: "eladaviv/repo-one:issue:17",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [
      { number: 100, status: "open", role: "implementation" },
      { number: 101, status: "open", role: "implementation" }
    ],
    activePrNumber: 100,
    activeWorktreeId: "wt-int",
    phase: "implementing",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: {
      branchName: integrationBranch,
      prNumber: 100
    },
    packetPlan: {
      status: "approved",
      currentWaveIndex: 0,
      waves: [["T1"]],
      packets: {
        T1: {
          id: "T1",
          title: "Task 1",
          summary: "Task 1 summary",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "pr_open",
          prNumber: 101,
          branchName: "packet-branch"
        }
      }
    }
  };

  const workstreams = deriveWorkstreams({
    repos: [repo],
    currentIssues: [issue],
    currentPullRequests: [parentPr, packetPr],
    worktrees: [
      baseWorktree({
        id: "wt-int",
        issueId: issue.id,
        issueNumber: issue.number,
        branchName: integrationBranch,
        prNumber: 100
      }),
      baseWorktree({
        id: "wt-packet-t1",
        packet: {
          parentWorkstreamId: previousWorkstream.id,
          packetId: "T1",
          waveIndex: 0,
          parentIntegrationBranch: integrationBranch
        },
        branchName: "packet-branch",
        prNumber: 101
      })
    ],
    previousWorkstreams: [previousWorkstream]
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.id, "eladaviv/repo-one:issue:17");
  assert.equal(workstreams[0]?.packetPlan?.packets.T1?.status, "merged_to_parent");
  assert.equal(workstreams[0]?.status, "open");
  assert.equal(workstreams[0]?.resolution, "unresolved");
  assert.equal(workstreams[0]?.integration?.branchName, integrationBranch);
  assert.equal(workstreams[0]?.integration?.prNumber, 100);
  assert.equal(workstreams[0]?.linkedPrs.map((pr) => pr.number).includes(101), false);
  assert.equal(workstreams.find(ws => ws.id === "eladaviv/repo-one:pr:101"), undefined);
  assert.equal(workstreams[0]?.packetPlan?.currentWaveIndex, 0);
});

test("deriveWorkstreams marks a previously-open issue workstream as abandoned when the issue is absent from the current scan", () => {
  // Issue closed on GitHub: listOpenIssues no longer returns it, so currentIssues is empty.
  // The workstream should detect that and transition to abandoned rather than staying in planning.
  const previousWorkstream: WorkstreamRecord = {
    id: "eladaviv/repo-one:issue:17",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [],
    phase: "planning",
    attention: "idle",
    status: "open",
    resolution: "unresolved"
  };

  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [],
    worktrees: [],
    previousWorkstreams: [previousWorkstream]
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.id, "eladaviv/repo-one:issue:17");
  assert.equal(workstreams[0]?.status, "closed");
  assert.equal(workstreams[0]?.phase, "abandoned");
});

test("deriveWorkstreams does not abandon a workstream whose issue was never seen (no previous status)", () => {
  // A brand-new workstream seeded from a worktree, not yet seen as open, should not be closed.
  const workstreams = deriveWorkstreams({
    repos: [baseRepo()],
    currentIssues: [],
    currentPullRequests: [],
    worktrees: [
      baseWorktree({
        id: "worktree:eladaviv/repo-one:issue:17",
        issueNumber: 17,
        branchName: "agent/eladaviv-repo-one/issue-17",
        status: "planning"
      })
    ],
    previousWorkstreams: []
  });

  assert.equal(workstreams.length, 1);
  assert.equal(workstreams[0]?.status, "open");
  assert.notEqual(workstreams[0]?.phase, "abandoned");
});

test("deriveWorkstreams packetPlan status transitions", () => {
  const issue = baseIssue();
  const basePacketPlan = {
    status: "proposed" as const,
    packets: {
      T1: { id: "T1", title: "Task 1", summary: "Summary", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [], status: "planned" as const }
    },
    waves: [["T1"]],
    currentWaveIndex: 0,
    source: { kind: "plan_breakdown_result" as const, workstreamId: issue.key }
  };

  const prevWorkstream: WorkstreamRecord = {
    id: issue.key,
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [],
    phase: "planning",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    packetPlan: basePacketPlan
  };

  // Case 1: all packets merged -> complete
  {
    const prev = {
      ...prevWorkstream,
      packetPlan: {
        ...basePacketPlan,
        packets: {
          T1: { ...basePacketPlan.packets.T1, status: "merged_to_parent" as const }
        }
      }
    };
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [],
      previousWorkstreams: [prev]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "complete");
  }

  // Case 2: packets started (pr_open) -> in_progress
  {
    const prev = {
      ...prevWorkstream,
      packetPlan: {
        ...basePacketPlan,
        packets: {
          T1: { ...basePacketPlan.packets.T1, status: "pr_open" as const }
        }
      }
    };
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [],
      previousWorkstreams: [prev]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "in_progress");
  }

  // Case 3: nextPhase === implementing -> in_progress
  {
    const wt = baseWorktree({ status: "implementing" });
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [wt],
      previousWorkstreams: [prevWorkstream]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "in_progress");
  }

  // Case 4: hasApproval (via reason plan_approved) -> approved
  {
    const attention: AttentionRecord = {
      workstreamId: issue.key,
      repoKey: "eladaviv/repo-one",
      needsAction: true,
      reasons: ["plan_approved"],
      lastObservedAt: new Date().toISOString()
    };
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [],
      previousWorkstreams: [prevWorkstream],
      attention: [attention]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "approved");
  }

  // Case 5: wasApproved is true, still planning -> preserved as approved
  {
    const prev = {
      ...prevWorkstream,
      packetPlan: {
        ...basePacketPlan,
        status: "approved" as const
      }
    };
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [],
      previousWorkstreams: [prev]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "approved");
  }

  // Case 6: wasApproved is true, phase transitions from implementing/implementation_ready to planning, and no hasApproval -> proposed (lostApproval)
  {
    const prev = {
      ...prevWorkstream,
      phase: "implementation_ready" as const,
      packetPlan: {
        ...basePacketPlan,
        status: "approved" as const
      }
    };
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [],
      previousWorkstreams: [prev]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "proposed");
  }

  // Case 7: nextPhase === "implementation_ready" -> status is approved (approved branch via phase signal)
  {
    const wt = baseWorktree({ status: "implementation_ready" });
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [wt],
      previousWorkstreams: [prevWorkstream]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "approved");
  }

  // Case 8: wasApproved is true, previous phase was implementing, transitions to planning, and no hasApproval -> proposed (lostApproval)
  {
    const prev = {
      ...prevWorkstream,
      phase: "implementing" as const,
      packetPlan: {
        ...basePacketPlan,
        status: "approved" as const
      }
    };
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [],
      previousWorkstreams: [prev]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "proposed");
  }

  // Case 9: wasApproved is false (status was in_progress), no packets started, and no hasApproval -> proposed (demoted from in_progress)
  {
    const prev = {
      ...prevWorkstream,
      packetPlan: {
        ...basePacketPlan,
        status: "in_progress" as const
      }
    };
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [],
      previousWorkstreams: [prev]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "proposed");
  }

  // Case 10: wasApproved is true, previous phase is implementation_done, nextPhase is implementation_done, and no packets started -> stays approved
  {
    const wt = baseWorktree({ status: "implementation_done" });
    const prev = {
      ...prevWorkstream,
      phase: "implementation_done" as const,
      packetPlan: {
        ...basePacketPlan,
        status: "approved" as const
      }
    };
    const workstreams = deriveWorkstreams({
      repos: [baseRepo()],
      currentIssues: [issue],
      currentPullRequests: [],
      worktrees: [wt],
      previousWorkstreams: [prev]
    });
    assert.equal(workstreams[0]?.packetPlan?.status, "approved");
  }
});

function baseRepo(): RepoConfig {
  return {
    id: "repo-1",
    owner: "eladaviv",
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

function baseIssue(): NormalizedIssue {
  return {
    kind: "issue",
    id: "issue:eladaviv/repo-one:17",
    repoId: "repo-1",
    repoKey: "eladaviv/repo-one",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number: 17,
    key: "eladaviv/repo-one:issue:17",
    sourceId: "ISSUE_17",
    url: "https://github.com/eladaviv/repo-one/issues/17",
    title: "Need deterministic workstreams",
    body: "body",
    labels: [],
    author: "owner",
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    state: "open"
  };
}

function basePullRequest(
  overrides: Partial<NormalizedPullRequest> = {}
): NormalizedPullRequest {
  const number = overrides.number ?? 21;
  return {
    kind: "pull_request",
    id: `pull_request:eladaviv/repo-one:${number}`,
    repoId: "repo-1",
    repoKey: "eladaviv/repo-one",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number,
    key: `eladaviv/repo-one:pull_request:${number}`,
    sourceId: `PR_${number}`,
    url: `https://github.com/eladaviv/repo-one/pull/${number}`,
    title: `PR ${number}`,
    body: "body",
    labels: [],
    author: "owner",
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    state: "open",
    headBranch: "feature/pr",
    headSha: "abc123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false,
    ...overrides
  };
}

function baseWorktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "worktree:eladaviv/repo-one:issue:17",
    repoId: "repo-1",
    repoSlug: "eladaviv/repo-one",
    repoName: "repo-one",
    issueId: "issue:eladaviv/repo-one:17",
    issueNumber: 17,
    prNumber: 24,
    branchName: "agent/eladaviv-repo-one/issue-17",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17",
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-log.md",
    status: "planning",
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides
  };
}
