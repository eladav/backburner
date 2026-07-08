import * as assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultContextBuilder } from "../src/context/types.js";
import type { RepoConfig } from "../src/config/types.js";
import type { NormalizedComment, NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import { deriveTasks } from "../src/tasks/derive.js";
import { deriveWorkstreams } from "../src/workstreams/derive.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { workflowRegistry } from "../src/workflows/registry.js";
import type {
  AttentionRecord,
  PersistedState,
  RepoSyncRecord,
  WorkstreamRecord,
  WorktreeRecord
} from "../src/state/types.js";

test("deriveTasks creates deterministic task packets for new issues, PRs, comments, and labels", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const newIssueTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [baseIssue()],
    currentPullRequests: [],
    currentComments: [],
    contextBuilder: builder,
    now
  });
  assert.equal(newIssueTasks.length, 1);
  assert.equal(newIssueTasks[0]?.kind, "product_discovery");
  assert.equal(newIssueTasks[0]?.relevant, true);
  assert.equal(newIssueTasks[0]?.executionPermission, "read-only");
  assert.equal(newIssueTasks[0]?.handoffPolicy.expectsPushableHandoff, false);
  assert.equal(newIssueTasks[0]?.reason, "Issue is newly seen and needs Product Discovery before implementation approval.");
  assert.match(newIssueTasks[0]?.context.instruction ?? "", /Product Manager presenting product analysis/);
  assert.equal(newIssueTasks[0]?.context.issueTitle, "Need a workflow");
  assert.equal(newIssueTasks[0]?.context.issueBody, "Please figure out the next step.");

  const newPrTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [basePullRequest({ labels: ["agent-review"] })],
    currentComments: [],
    contextBuilder: builder,
    now
  });
  assert.equal(newPrTasks.length, 1);
  assert.equal(newPrTasks[0]?.kind, "review_pr");
  assert.equal(newPrTasks[0]?.relevant, true);
  assert.equal(newPrTasks[0]?.executionPermission, "read-only");
  assert.equal(newPrTasks[0]?.context.pullRequestUrl, "https://github.com/eladaviv/repo-one/pull/21");

  const issueCommentTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [baseIssue()]
    },
    currentIssues: [baseIssue()],
    currentPullRequests: [],
    currentComments: [baseIssueComment()],
    contextBuilder: builder,
    now
  });
  assert.equal(issueCommentTasks.length, 1);
  assert.equal(issueCommentTasks[0]?.kind, "respond_issue_comment");
  assert.equal(issueCommentTasks[0]?.relevant, true);
  assert.equal(issueCommentTasks[0]?.context.commentUrl, "https://github.com/eladaviv/repo-one/issues/11#issuecomment-5001");
  assert.equal(issueCommentTasks[0]?.context.issueTitle, "Need a workflow");
  assert.equal(issueCommentTasks[0]?.context.issueBody, "Please figure out the next step.");

  const prCommentTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [basePullRequest()]
    },
    currentIssues: [],
    currentPullRequests: [basePullRequest()],
    currentComments: [basePrComment()],
    contextBuilder: builder,
    now
  });
  assert.equal(prCommentTasks.length, 1);
  assert.equal(prCommentTasks[0]?.kind, "respond_pr_comment");
  assert.equal(prCommentTasks[0]?.relevant, true);
  assert.equal(prCommentTasks[0]?.executionPermission, "workspace-write");
  assert.equal(prCommentTasks[0]?.handoffPolicy.expectsPushableHandoff, true);
  assert.match(prCommentTasks[0]?.reason ?? "", /newly seen/);

  const managementPrTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      managementPrs: [
        {
          id: "mgmt-1",
          proposalId: "prop-1",
          mode: "pull_request",
          status: "opened",
          prNumber: 42,
          repoSlug: "eladaviv/repo-one",
          changedArtifactPaths: [],
          detectedAt: now
        }
      ]
    },
    currentIssues: [],
    currentPullRequests: [
      basePullRequest({
        number: 42,
        labels: ["agent-review", "agent-prepare-for-merge"]
      })
    ],
    currentComments: [
      basePrComment({
        parentNumber: 42
      })
    ],
    contextBuilder: builder,
    now
  });
  // Should NOT create review_pr, prepare_pr_for_merge, or respond_pr_comment for management PR #42
  assert.equal(managementPrTasks.length, 0);

  const implementTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [basePullRequest()]
    },
    currentIssues: [],
    currentPullRequests: [basePullRequest({ labels: ["agent-plan-approved"] })],
    currentComments: [],
    contextBuilder: builder,
    now
  });
  assert.equal(implementTasks.length, 1);
  assert.equal(implementTasks[0]?.kind, "implement_plan");
  assert.equal(implementTasks[0]?.relevant, true);

  const writePlanTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [basePullRequest()],
      worktrees: [
        baseWorktree({
          status: "planning",
          prId: "pull_request:eladaviv/repo-one:21",
          prNumber: 21
        })
      ]
    },
    currentIssues: [],
    currentPullRequests: [basePullRequest({ labels: ["agent-in-progress"] })],
    currentComments: [],
    worktrees: [
      baseWorktree({
        status: "planning",
        prId: "pull_request:eladaviv/repo-one:21",
        prNumber: 21
      })
    ],
    contextBuilder: builder,
    now
  });
  assert.equal(writePlanTasks.length, 1);
  assert.equal(writePlanTasks[0]?.kind, "write_plan");
  assert.equal(writePlanTasks[0]?.relevant, true);
  assert.equal(writePlanTasks[0]?.executionPermission, "workspace-write");
});

test("product discovery is the default new issue phase and task", () => {
  const now = "2026-06-28T10:00:00.000Z";
  const repo = baseRepo();
  const issue = baseIssue();
  const state = emptyState();
  const workstreams = deriveWorkstreams({
    repos: [repo],
    currentIssues: [issue],
    currentPullRequests: [],
    previousPullRequests: [],
    worktrees: [],
    previousWorkstreams: []
  });

  assert.equal(workstreams[0]?.phase, "product_discovery");
  assert.equal(workstreams[0]?.product?.status, "in_discovery");

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [baseRepoSync()],
    previousState: state,
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams,
    attention: [
      baseAttention({
        needsAction: true,
        reasons: ["new_issue"],
        issueNumber: issue.number,
        lastObservedAt: now
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.deepEqual(tasks.map((task) => task.kind), ["product_discovery"]);
  assert.equal(tasks.some((task) => task.kind === "triage_issue"), false);
});

test("migrated Product Discovery workstream derives Product Discovery task for previously seen issue", () => {
  const now = "2026-06-29T05:00:00.000Z";
  const repo = baseRepo();
  const issue = baseIssue();
  const workstream = baseIssueWorkstream({
    phase: "product_discovery",
    product: { status: "in_discovery", approvalLabel: "agent-product-approved" }
  });
  const previousWorkstream: WorkstreamRecord = {
    ...workstream,
    phase: "issue_triage"
  };
  delete previousWorkstream.product;

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      workstreams: [previousWorkstream]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.deepEqual(tasks.map((task) => task.kind), ["product_discovery"]);
  assert.equal(tasks[0]?.workstreamId, workstream.id);
});

test("migrated Product Discovery workstream does not duplicate existing Product Discovery task", () => {
  const now = "2026-06-29T05:00:00.000Z";
  const issue = baseIssue();
  const workstream = baseIssueWorkstream({
    phase: "product_discovery",
    product: { status: "in_discovery", approvalLabel: "agent-product-approved" }
  });
  const previousWorkstream: WorkstreamRecord = {
    ...workstream,
    phase: "issue_triage"
  };
  delete previousWorkstream.product;
  const existingTask: TaskRecord = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:11", "write_plan"),
    kind: "product_discovery",
    status: "pending",
    executionPermission: "read-only",
    handoffPolicy: workflowRegistry.resolveTaskExecutionPolicy("product_discovery").handoffPolicy,
    sourceKind: "issue",
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: workstream.id,
    context: {
      repoIdentifier: issue.repoSlug,
      issueUrl: issue.url,
      labels: issue.labels,
      instruction: "Product Discovery."
    }
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [existingTask],
      workstreams: [previousWorkstream]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.deepEqual(tasks.map((task) => task.id), [existingTask.id]);
  assert.equal(tasks[0]?.status, "pending");
});

test("deriveTasks preserves queued provider-limit tasks across cycles", () => {
  const now = "2026-07-07T09:00:00.000Z";
  const pullRequest = basePullRequest({ labels: ["agent-in-progress"] });
  const queuedTask: TaskRecord = {
    ...baseTaskRecord("task:write_plan:pull_request:eladaviv/repo-one:21", "write_plan"),
    status: "queued",
    waitingOnProvider: "claude",
    context: {
      ...baseTaskRecord("task:write_plan:pull_request:eladaviv/repo-one:21", "write_plan").context,
      notifiedQueued: true
    }
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      prs: [pullRequest],
      tasks: [queuedTask]
    },
    currentIssues: [],
    currentPullRequests: [pullRequest],
    currentComments: [],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  const carried = tasks.find((task) => task.id === queuedTask.id);
  assert.ok(carried, "queued task should be carried forward");
  assert.equal(carried.status, "queued");
  assert.equal(carried.waitingOnProvider, "claude");
  assert.equal(carried.context.notifiedQueued, true);
});

test("pre-approved new issue skips Product Discovery task and enters Product Specification", () => {
  const repo = baseRepo();
  const issue = baseIssue({ labels: ["agent-product-approved"] });
  const workstreams = deriveWorkstreams({
    repos: [repo],
    currentIssues: [issue],
    currentPullRequests: [],
    previousPullRequests: [],
    worktrees: [],
    previousWorkstreams: [],
    attention: [
      baseAttention({
        needsAction: true,
        reasons: ["new_issue", "product_approval_observed"],
        issueNumber: issue.number
      })
    ]
  });

  assert.equal(workstreams[0]?.phase, "product_specification");
  assert.equal(workstreams[0]?.product?.status, "approved_for_spec");

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [baseRepoSync()],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams,
    attention: [
      baseAttention({
        needsAction: true,
        reasons: ["new_issue", "product_approval_observed"],
        issueNumber: issue.number
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-06-28T10:00:00.000Z"
  });

  assert.equal(tasks.some((task) => task.kind === "product_discovery"), false);
  assert.equal(tasks.some((task) => task.kind === "triage_issue"), false);
});

test("Product Specification worktree derives write_product_spec before write_plan", () => {
  const now = "2026-06-28T10:00:00.000Z";
  const repo = baseRepo();
  const issue = baseIssue({ labels: ["agent-product-approved"] });
  const worktree = baseWorktree({
    status: "product_specification",
    issueId: issue.id,
    issueNumber: issue.number,
    productSpecDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11/docs/agents/feature-tasks/issue-11-product-spec.md"
  });
  const workstream = baseIssueWorkstream({
    phase: "product_specification",
    activeWorktreeId: worktree.id,
    product: {
      status: "approved_for_spec",
      approvalLabel: "agent-product-approved"
    }
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      worktrees: [worktree],
      workstreams: [workstream]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [
      baseAttention({
        needsAction: true,
        reasons: ["product_approval_observed"],
        issueNumber: issue.number
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.deepEqual(tasks.map((task) => task.kind), ["write_product_spec"]);
  assert.equal(tasks[0]?.context.productSpecDocumentPath, worktree.productSpecDocumentPath);
});

test("Product Specification reopens completed write_product_spec when spec artifact is still missing", () => {
  const now = "2026-06-29T14:10:00.000Z";
  const repo = baseRepo();
  const issue = baseIssue({ labels: ["agent-product-approved"] });
  const worktree = baseWorktree({
    status: "product_specification",
    issueId: issue.id,
    issueNumber: issue.number,
    productSpecDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11/docs/agents/feature-tasks/issue-11-product-spec.md"
  });
  const workstream = baseIssueWorkstream({
    phase: "product_specification",
    activeWorktreeId: worktree.id,
    product: {
      status: "approved_for_spec",
      approvalLabel: "agent-product-approved"
    }
  });
  const completedTask: TaskRecord = {
    ...baseTaskRecord(`task:write_product_spec:worktree:${worktree.id}`, "write_plan"),
    kind: "write_product_spec",
    status: "completed",
    sourceKind: "issue",
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: workstream.id,
    context: new DefaultContextBuilder().build({
      taskKind: "write_product_spec",
      repoIdentifier: issue.repoSlug,
      sourceKind: "issue",
      sourceUrl: issue.url,
      labels: issue.labels,
      localRepoPath: worktree.path,
      branchName: worktree.branchName,
      planDocumentPath: worktree.planDocumentPath,
      productSpecDocumentPath: worktree.productSpecDocumentPath!,
      logDocumentPath: worktree.logDocumentPath,
      issueTitle: issue.title,
      issueBody: issue.body
    })
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [completedTask],
      worktrees: [worktree],
      workstreams: [workstream]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [baseAttention({ reasons: ["product_approval_observed"], issueNumber: issue.number })],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, completedTask.id);
  assert.equal(tasks[0]?.kind, "write_product_spec");
  assert.equal(tasks[0]?.status, "pending");
});

test("Product Discovery issue comments keep respond_issue_comment kind but route to product phase", () => {
  const now = "2026-06-28T10:00:00.000Z";
  const issue = baseIssue();
  const comment = baseIssueComment({ body: "Can we narrow the target user?" });
  const workstream = baseIssueWorkstream({
    phase: "product_discovery",
    product: { status: "in_discovery", approvalLabel: "agent-product-approved" }
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      workstreams: [workstream]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [comment],
    workstreams: [workstream],
    attention: [
      baseAttention({
        needsAction: true,
        reasons: ["issue_comment_added"],
        issueNumber: issue.number,
        commentIds: [comment.id]
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.equal(tasks[0]?.kind, "respond_issue_comment");
  assert.equal(tasks[0]?.workflowPhase, "product_discovery");
  assert.match(tasks[0]?.context.instruction ?? "", /Product Discovery/);
});

test("stale Product Discovery issue comment tasks are not carried into planning", () => {
  const now = "2026-06-28T10:00:00.000Z";
  const issue = baseIssue({ labels: ["agent-product-approved"] });
  const comment = baseIssueComment({ body: "Can we narrow the target user?" });
  const workstream = baseIssueWorkstream({
    phase: "planning",
    product: { status: "spec_written", approvalLabel: "agent-product-approved" }
  });
  const staleTask = {
    id: `task:respond_issue_comment:${comment.id}`,
    kind: "respond_issue_comment" as const,
    status: "pending" as const,
    executionPermission: "read-only" as const,
    handoffPolicy: { expectsPushableHandoff: false, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" as const },
    repoId: issue.repoId,
    repoName: issue.repoName,
    repoSlug: issue.repoSlug,
    sourceKind: "comment" as const,
    sourceId: comment.id,
    sourceUrl: comment.url,
    parentSourceKind: "issue" as const,
    parentSourceId: issue.id,
    relevant: true,
    reason: "New issue comment needs a response.",
    summary: "Respond to issue comment",
    workstreamId: workstream.id,
    workflowPhase: "product_discovery" as const,
    context: {
      repoIdentifier: issue.repoSlug,
      issueUrl: issue.url,
      instruction: "Product Discovery",
      labels: []
    },
    createdAt: now,
    updatedAt: now
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      comments: [comment],
      tasks: [staleTask],
      workstreams: [workstream]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [comment],
    workstreams: [workstream],
    attention: [],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.equal(tasks.some((task) => task.id === staleTask.id), false);
});

test("stale Product Specification issue comment tasks are not carried into planning", () => {
  const now = "2026-06-28T10:00:00.000Z";
  const issue = baseIssue({ labels: ["agent-product-approved"] });
  const comment = baseIssueComment({ body: "Can we adjust the Product Spec wording?" });
  const workstream = baseIssueWorkstream({
    phase: "planning",
    product: { status: "spec_written", approvalLabel: "agent-product-approved" }
  });
  const staleTask: TaskRecord = {
    id: `task:respond_issue_comment:${comment.id}`,
    kind: "respond_issue_comment",
    status: "pending",
    executionPermission: "read-only",
    handoffPolicy: { expectsPushableHandoff: false, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
    repoId: issue.repoId,
    repoName: issue.repoName,
    repoSlug: issue.repoSlug,
    sourceKind: "comment",
    sourceId: comment.id,
    sourceUrl: comment.url,
    parentSourceKind: "issue",
    parentSourceId: issue.id,
    relevant: true,
    reason: "New issue comment needs a response.",
    summary: "Respond to issue comment",
    workstreamId: workstream.id,
    workflowPhase: "product_specification",
    context: {
      repoIdentifier: issue.repoSlug,
      issueUrl: issue.url,
      instruction: "Product Specification PM instruction",
      labels: []
    },
    createdAt: now,
    updatedAt: now
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      comments: [comment],
      tasks: [staleTask],
      workstreams: [workstream]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [comment],
    workstreams: [workstream],
    attention: [],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.equal(tasks.some((task) => task.id === staleTask.id), false);
});

test("old triage_issue tasks are not carried into migrated Product Discovery workstreams", () => {
  const now = "2026-06-29T04:45:00.000Z";
  const issue = baseIssue();
  const workstream = baseIssueWorkstream({
    phase: "product_discovery",
    product: { status: "in_discovery", approvalLabel: "agent-product-approved" }
  });
  const staleTask: TaskRecord = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:11", "write_plan"),
    kind: "triage_issue",
    status: "pending",
    sourceKind: "issue",
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: workstream.id,
    context: {
      repoIdentifier: issue.repoSlug,
      issueUrl: issue.url,
      labels: issue.labels,
      instruction: "Legacy triage task from before Product Discovery."
    },
    createdAt: "2026-06-28T09:00:00.000Z",
    updatedAt: "2026-06-28T09:00:00.000Z"
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [staleTask],
      workstreams: [workstream]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.equal(tasks.some((task) => task.id === staleTask.id), false);
  assert.equal(tasks.some((task) => task.kind === "triage_issue"), false);
});

test("written Product Spec allows write_plan and carries Product Spec context", () => {
  const now = "2026-06-28T10:00:00.000Z";
  const issue = baseIssue({ labels: ["agent-product-approved"] });
  const productSpecDocumentPath = "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11/docs/agents/feature-tasks/issue-11-product-spec.md";
  const worktree = baseWorktree({
    status: "planning",
    issueId: issue.id,
    issueNumber: issue.number,
    productSpecDocumentPath,
    productSpecWrittenAt: now
  });
  const workstream = baseIssueWorkstream({
    phase: "planning",
    activeWorktreeId: worktree.id,
    product: {
      status: "spec_written",
      approvalLabel: "agent-product-approved"
    }
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      worktrees: [worktree],
      workstreams: [workstream]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [baseAttention({ reasons: ["product_approval_observed"], issueNumber: issue.number })],
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  assert.deepEqual(tasks.map((task) => task.kind), ["write_plan"]);
  assert.equal(tasks[0]?.context.productSpecDocumentPath, productSpecDocumentPath);
  assert.match(tasks[0]?.context.instruction, /Product Spec is the product source of truth/);
});

test("deriveTasks ignores bot-authored comments for follow-up task creation but keeps human comments actionable", () => {
  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [baseIssue()],
      prs: [basePullRequest()]
    },
    currentIssues: [baseIssue()],
    currentPullRequests: [basePullRequest()],
    currentComments: [
      baseIssueComment({
        id: "comment:eladaviv/repo-one:issue_comment:bot-1",
        sourceId: "bot-1",
        body: "🤖 I already answered this.",
        url: "https://github.com/eladaviv/repo-one/issues/11#issuecomment-bot-1"
      }),
      basePrComment({
        id: "comment:eladaviv/repo-one:pull_request_comment:human-1",
        sourceId: "human-1",
        body: "Please update the plan.",
        url: "https://github.com/eladaviv/repo-one/pull/21#issuecomment-human-1"
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.deepEqual(
    tasks.map((task) => task.id),
    ["task:respond_pr_comment:comment:eladaviv/repo-one:pull_request_comment:human-1"]
  );
});

test("deriveTasks uses the PR worktree path for PR comment follow-up tasks when available", () => {
  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      prs: [basePullRequest()]
    },
    currentIssues: [],
    currentPullRequests: [basePullRequest()],
    currentComments: [basePrComment()],
    worktrees: [
      {
        id: "worktree:eladaviv/repo-one:issue:21",
        repoId: "repo-1",
        repoSlug: "eladaviv/repo-one",
        repoName: "repo-one",
        issueId: "issue:eladaviv/repo-one:11",
        issueNumber: 11,
        baseBranch: "main",
        branchName: "feature/tasks",
        path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-21",
        planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-21/docs/agents/feature-tasks/issue-11-agent-plan.md",
        logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-21/docs/agents/feature-tasks/issue-11-agent-log.md",
        status: "planning",
        createdAt: "2026-04-18T09:00:00.000Z",
        updatedAt: "2026-04-18T09:00:00.000Z"
      }
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.equal(
    tasks[0]?.context.localRepoPath,
    "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-21"
  );
});

test("deriveTasks keeps unresolved comment tasks alive across identical runs", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-plan-approved"] });
  const issueComment = baseIssueComment();
  const prComment = basePrComment();

  const firstRunTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [issueComment, prComment],
    contextBuilder: builder,
    now
  });

  assert.deepEqual(
    firstRunTasks.map((task) => task.id),
    [
      "task:implement_plan:pull_request:eladaviv/repo-one:21",
      "task:respond_issue_comment:comment:eladaviv/repo-one:issue_comment:5001",
      "task:respond_pr_comment:comment:eladaviv/repo-one:pull_request_comment:6001"
    ]
  );

  const secondRunTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr],
      comments: [issueComment, prComment],
      tasks: firstRunTasks
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [issueComment, prComment],
    contextBuilder: builder,
    now: "2026-04-18T10:05:00.000Z"
  });

  assert.equal(secondRunTasks.length, 3);
  assert.deepEqual(secondRunTasks.map((task) => task.id), [
    "task:implement_plan:pull_request:eladaviv/repo-one:21",
    "task:respond_issue_comment:comment:eladaviv/repo-one:issue_comment:5001",
    "task:respond_pr_comment:comment:eladaviv/repo-one:pull_request_comment:6001"
  ]);
  assert.deepEqual(secondRunTasks.map((task) => task.status), ["pending", "pending", "pending"]);
  assert.equal(secondRunTasks[0]?.updatedAt, firstRunTasks[0]?.updatedAt);
});

test("deriveTasks keeps completed tasks terminal across repeated runs until the task meaning changes", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const pr = basePullRequest({ labels: ["agent-plan-approved"] });
  const completedTask = {
    ...deriveTasks({
      repos: [repo],
      repoSyncRecords: [repoSync],
      previousState: {
        ...emptyState(),
        prs: [pr]
      },
      currentIssues: [],
      currentPullRequests: [pr],
      currentComments: [],
      contextBuilder: builder,
      now
    })[0]!,
    status: "completed" as const,
    lastExecutionId: "exec:previous"
  };

  const repeatedTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [pr],
      tasks: [completedTask]
    },
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    contextBuilder: builder,
    now: "2026-04-18T10:10:00.000Z"
  });

  assert.equal(repeatedTasks.length, 1);
  assert.equal(repeatedTasks[0]?.status, "completed");
  assert.equal(repeatedTasks[0]?.lastExecutionId, "exec:previous");
});

test("deriveTasks keeps completed tasks terminal when only context labels change", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const approvedPr = basePullRequest({ labels: ["agent-plan-approved"] });
  const completedTask = {
    ...deriveTasks({
      repos: [repo],
      repoSyncRecords: [repoSync],
      previousState: {
        ...emptyState(),
        prs: [approvedPr]
      },
      currentIssues: [],
      currentPullRequests: [approvedPr],
      currentComments: [],
      contextBuilder: builder,
      now
    })[0]!,
    status: "completed" as const,
    lastExecutionId: "exec:previous"
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [approvedPr],
      tasks: [completedTask]
    },
    currentIssues: [],
    currentPullRequests: [
      basePullRequest({ labels: ["agent-plan-approved", "agent-review-needed"] })
    ],
    currentComments: [],
    contextBuilder: builder,
    now: "2026-04-18T10:10:00.000Z"
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.kind, "implement_plan");
  assert.equal(tasks[0]?.status, "completed");
  assert.equal(tasks[0]?.lastExecutionId, "exec:previous");
  assert.deepEqual(tasks[0]?.context.labels, ["agent-plan-approved", "agent-review-needed"]);
});

test("deriveTasks reopens a completed issue-comment task when the enriched parent issue context changes the packet", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const issue = baseIssue({
    title: "just answer to this issue",
    body: "do not create a pr there is no plan to be made. I expect a response on this issue."
  });
  const comment = baseIssueComment({ body: "come on" });
  const completedLegacyTask = {
    ...deriveTasks({
      repos: [repo],
      repoSyncRecords: [repoSync],
      previousState: {
        ...emptyState(),
        issues: [issue]
      },
      currentIssues: [issue],
      currentPullRequests: [],
      currentComments: [comment],
      contextBuilder: builder,
      now
    })[0]!,
    status: "completed" as const,
    lastExecutionId: "exec:legacy",
    context: {
      repoIdentifier: "eladaviv/repo-one",
      localRepoPath: "/tmp/code-root/repo-one",
      labels: [],
      issueUrl: issue.url,
      commentUrl: comment.url,
      relevantCommentText: "come on",
      instruction:
        "Read the parent issue and the new comment, then post a GitHub issue comment through the configured broker MCP. Answer in the context of the active workstream phase. Do not return a JSON routing decision, and do not use answer_only or start_implementation. Implementation authorization comes from explicit workflow labels, not from issue-comment follow-up decisions."
    }
  };

  const rerunTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [completedLegacyTask]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [comment],
    contextBuilder: builder,
    now: "2026-04-18T10:10:00.000Z"
  });

  assert.equal(rerunTasks.length, 1);
  assert.equal(rerunTasks[0]?.kind, "respond_issue_comment");
  assert.equal(rerunTasks[0]?.status, "pending");
  assert.equal(rerunTasks[0]?.lastExecutionId, "exec:legacy");
  assert.equal(rerunTasks[0]?.context.issueTitle, "just answer to this issue");
  assert.match(rerunTasks[0]?.context.issueBody ?? "", /do not create a pr/);
});

test("deriveTasks prioritizes agent-review over agent-plan-approved and agent-in-progress", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const prWithBothLabels = basePullRequest({
    labels: ["agent-review", "agent-plan-approved", "agent-in-progress"]
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [prWithBothLabels],
    currentComments: [],
    contextBuilder: builder,
    now: "2026-04-20T12:00:00.000Z"
  });

  // Should only have the review task
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.kind, "review_pr");
  assert.equal(tasks[0]?.sourceId, prWithBothLabels.id);
});

test("deriveTasks removes label-driven tasks when the controlling label is removed", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const prWithoutApproval = basePullRequest({ labels: [] });
  const staleImplementTask = {
    ...baseTaskRecord("task:implement_plan:pull_request:eladaviv/repo-one:21", "implement_plan"),
    status: "completed" as const
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [basePullRequest({ labels: ["agent-plan-approved"] })],
      tasks: [staleImplementTask]
    },
    currentIssues: [],
    currentPullRequests: [prWithoutApproval],
    currentComments: [],
    contextBuilder: builder,
    now: "2026-04-18T10:20:00.000Z"
  });

  assert.deepEqual(tasks, []);
});

test("deriveTasks suppresses comment response tasks when the parent issue or PR is newly seen", () => {
  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: emptyState(),
    currentIssues: [baseIssue()],
    currentPullRequests: [basePullRequest()],
    currentComments: [baseIssueComment(), basePrComment()],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.deepEqual(
    tasks.map((task) => task.kind),
    ["product_discovery"]
  );
});

test("deriveTasks routes an implementation-ready issue workstream with linked approved PR to implement_plan", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-plan-approved"] });
  const worktree = baseWorktree({
    issueId: issue.id,
    issueNumber: issue.number,
    prId: pr.id,
    prNumber: pr.number,
    status: "implementation_ready"
  });
  const workstream = baseIssueWorkstream({
    linkedIssueNumber: issue.number,
    linkedPrs: [{ number: pr.number, role: "implementation", status: "open" }],
    activePrNumber: pr.number,
    activeWorktreeId: worktree.id,
    phase: "implementation_ready"
  });
  const attention = baseAttention({
    workstreamId: workstream.id,
    issueNumber: issue.number,
    pullRequestNumbers: [pr.number],
    reasons: ["plan_approved"],
    needsAction: true
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.deepEqual(tasks.map((task) => task.kind), ["implement_plan"]);
  assert.equal(tasks[0]?.sourceId, pr.id);
  assert.equal(tasks[0]?.context.localRepoPath, worktree.path);
});

test("deriveTasks keeps early plan approval on a planning worktree in write_plan", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-plan-approved"] });
  const worktree = baseWorktree({
    issueId: issue.id,
    issueNumber: issue.number,
    prId: pr.id,
    prNumber: pr.number,
    status: "planning",
    productSpecWrittenAt: "2026-04-18T10:03:00.000Z"
  });
  const workstream = baseIssueWorkstream({
    linkedIssueNumber: issue.number,
    linkedPrs: [{ number: pr.number, role: "implementation", status: "open" }],
    activePrNumber: pr.number,
    activeWorktreeId: worktree.id,
    phase: "planning",
    product: {
      status: "spec_written",
      approvalLabel: "agent-product-approved",
      approvedAt: "2026-04-18T10:02:00.000Z"
    }
  });
  const attention = baseAttention({
    workstreamId: workstream.id,
    issueNumber: issue.number,
    pullRequestNumbers: [pr.number],
    reasons: ["plan_approved"],
    needsAction: true
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.deepEqual(tasks.map((task) => task.kind), ["write_plan"]);
  assert.equal(tasks[0]?.sourceId, issue.id);
  assert.equal(tasks[0]?.context.localRepoPath, worktree.path);
});

test("deriveTasks does NOT derive implement_plan for an abandoned workstream even when attention includes plan_approved", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-plan-approved"], state: "open" });
  const worktree = baseWorktree({ issueId: issue.id, issueNumber: issue.number, prId: pr.id, prNumber: pr.number });
  const workstream = baseIssueWorkstream({
    linkedIssueNumber: issue.number,
    linkedPrs: [{ number: pr.number, role: "implementation", status: "open" }],
    activePrNumber: pr.number,
    activeWorktreeId: worktree.id,
    phase: "abandoned"
  });
  const attention = baseAttention({
    workstreamId: workstream.id,
    issueNumber: issue.number,
    pullRequestNumbers: [pr.number],
    reasons: ["plan_approved"],
    needsAction: true
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  const implementTasks = tasks.filter((t) => t.kind === "implement_plan");
  assert.equal(implementTasks.length, 0, "abandoned workstream must not produce an implement_plan task");
});

test("deriveTasks does NOT derive normal implement_plan after implementation_done", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-plan-approved"], state: "open" });
  const worktree = baseWorktree({
    issueId: issue.id,
    issueNumber: issue.number,
    prId: pr.id,
    prNumber: pr.number,
    status: "implementation_done"
  });
  const workstream = baseIssueWorkstream({
    linkedIssueNumber: issue.number,
    linkedPrs: [{ number: pr.number, role: "implementation", status: "open" }],
    activePrNumber: pr.number,
    activeWorktreeId: worktree.id,
    phase: "implementation_done"
  });
  const attention = baseAttention({
    workstreamId: workstream.id,
    issueNumber: issue.number,
    pullRequestNumbers: [pr.number],
    reasons: ["plan_approved"],
    needsAction: true
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  const implementTasks = tasks.filter((t) => t.kind === "implement_plan");
  assert.equal(implementTasks.length, 0, "implementation_done workstream must not produce another implement_plan task");
});

test("deriveTasks still derives respond_pr_comment after implementation_done", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-plan-approved"], state: "open" });
  const comment = basePrComment({ parentNumber: pr.number, parentKey: pr.key });
  const worktree = baseWorktree({
    issueId: issue.id,
    issueNumber: issue.number,
    prId: pr.id,
    prNumber: pr.number,
    status: "implementation_done"
  });
  const workstream = baseIssueWorkstream({
    linkedIssueNumber: issue.number,
    linkedPrs: [{ number: pr.number, role: "implementation", status: "open" }],
    activePrNumber: pr.number,
    activeWorktreeId: worktree.id,
    phase: "implementation_done"
  });
  const attention = baseAttention({
    workstreamId: workstream.id,
    issueNumber: issue.number,
    pullRequestNumbers: [pr.number],
    commentIds: [comment.id],
    reasons: ["pr_comment_added"],
    needsAction: true
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [comment],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  const commentTask = tasks.find((t) => t.kind === "respond_pr_comment");
  assert.ok(commentTask);
  assert.equal(commentTask.context.localRepoPath, worktree.path);
  assert.equal(tasks.some((t) => t.kind === "implement_plan"), false);
});

test("deriveTasks still derives review_pr after implementation_done phase moves to pr_review", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-plan-approved", "agent-review"], state: "open", headSha: "head-after-implementation" });
  const worktree = baseWorktree({
    issueId: issue.id,
    issueNumber: issue.number,
    prId: pr.id,
    prNumber: pr.number,
    status: "implementation_done"
  });
  const workstream = baseIssueWorkstream({
    linkedIssueNumber: issue.number,
    linkedPrs: [{ number: pr.number, role: "implementation", status: "open" }],
    activePrNumber: pr.number,
    activeWorktreeId: worktree.id,
    phase: "pr_review"
  });
  const attention = baseAttention({
    workstreamId: workstream.id,
    issueNumber: issue.number,
    pullRequestNumbers: [pr.number],
    reasons: ["pr_review_requested"],
    needsAction: true,
    currentPullRequestHeadSha: pr.headSha
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  const reviewTask = tasks.find((t) => t.kind === "review_pr");
  assert.ok(reviewTask);
  assert.equal(reviewTask.context.localRepoPath, worktree.path);
  assert.equal(tasks.some((t) => t.kind === "implement_plan"), false);
});

test("deriveTasks does NOT derive implement_plan when activePullRequest.state is merged", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-plan-approved"], state: "merged" });
  const worktree = baseWorktree({ issueId: issue.id, issueNumber: issue.number, prId: pr.id, prNumber: pr.number });
  const workstream = baseIssueWorkstream({
    linkedIssueNumber: issue.number,
    linkedPrs: [{ number: pr.number, role: "implementation", status: "open" }],
    activePrNumber: pr.number,
    activeWorktreeId: worktree.id,
    phase: "planning"
  });
  const attention = baseAttention({
    workstreamId: workstream.id,
    issueNumber: issue.number,
    pullRequestNumbers: [pr.number],
    reasons: ["plan_approved"],
    needsAction: true
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  const implementTasks = tasks.filter((t) => t.kind === "implement_plan");
  assert.equal(implementTasks.length, 0, "merged PR must not produce an implement_plan task");
});

test("deriveTasks maps PR comment attention on a planning workstream to respond_pr_comment on the same workstream", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-in-progress"] });
  const comment = basePrComment();
  const worktree = baseWorktree({ issueId: issue.id, issueNumber: issue.number, prId: pr.id, prNumber: pr.number });
  const workstream = baseIssueWorkstream({
    linkedIssueNumber: issue.number,
    linkedPrs: [{ number: pr.number, role: "implementation", status: "open" }],
    activePrNumber: pr.number,
    activeWorktreeId: worktree.id,
    phase: "plan_feedback"
  });
  const attention = baseAttention({
    workstreamId: workstream.id,
    issueNumber: issue.number,
    pullRequestNumbers: [pr.number],
    commentIds: [comment.id],
    reasons: ["pr_comment_added"],
    needsAction: true
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [comment],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.deepEqual(tasks.map((task) => task.kind).sort(), ["respond_pr_comment", "write_plan"]);
  const prCommentTask = tasks.find((task) => task.kind === "respond_pr_comment");
  assert.equal(prCommentTask?.parentSourceId, pr.id);
  assert.equal(prCommentTask?.context.localRepoPath, worktree.path);
});

test("deriveTasks does not duplicate write_plan tasks when workstream and raw entities point to the same implementation flow", () => {
  const issue = baseIssue();
  const pr = basePullRequest({ labels: ["agent-in-progress"] });
  const worktree = baseWorktree({ issueId: issue.id, issueNumber: issue.number, prId: pr.id, prNumber: pr.number });
  const workstream = baseIssueWorkstream({
    linkedIssueNumber: issue.number,
    linkedPrs: [{ number: pr.number, role: "implementation", status: "open" }],
    activePrNumber: pr.number,
    activeWorktreeId: worktree.id,
    phase: "planning"
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [pr]
    },
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    workstreams: [workstream],
    attention: [baseAttention({ workstreamId: workstream.id, issueNumber: issue.number, pullRequestNumbers: [pr.number] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.deepEqual(tasks.map((task) => task.id), [`task:write_plan:worktree:${worktree.id}`]);
});

test("deriveTasks requeues the latest failed task when a human retry comment is present", () => {
  const issue = baseIssue();
  const failedTask = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:11", "write_plan"),
    kind: "product_discovery" as const,
    status: "failed" as const,
    sourceKind: "issue" as const,
    sourceId: issue.id,
    sourceUrl: issue.url,
    lastFailureCommentId: "9999",
    context: {
      repoIdentifier: issue.repoSlug,
      issueUrl: issue.url,
      labels: issue.labels,
      instruction: "Present Product Discovery analysis."
    },
    reason: "Initial Product Discovery failed."
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [failedTask]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [baseIssueComment({ body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-9999" })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, failedTask.id);
  assert.equal(tasks[0]?.kind, "product_discovery");
  assert.equal(tasks[0]?.status, "pending");
  assert.match(tasks[0]?.reason ?? "", /Retry requested/);
});

test("deriveTasks ignores retry: <url> when the comment ID does not match any failed task", () => {
  const issue = baseIssue();
  const failedTask = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:11", "write_plan"),
    kind: "product_discovery" as const,
    status: "failed" as const,
    sourceKind: "issue" as const,
    sourceId: issue.id,
    sourceUrl: issue.url,
    lastFailureCommentId: "9999",
    context: {
      repoIdentifier: issue.repoSlug,
      issueUrl: issue.url,
      labels: issue.labels,
      instruction: "Present Product Discovery analysis."
    },
    reason: "Initial Product Discovery failed."
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [failedTask]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [
      baseIssueComment({ body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-0000" })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  const retried = tasks.find(t => t.id === failedTask.id);
  assert.ok(retried, "failed task should still be carried forward");
  assert.equal(retried?.status, "failed", "task should remain failed — no matching comment ID");
});

test("deriveTasks processes feedback comment in the same window as a retry comment", () => {
  const issue = baseIssue();
  const failedTask = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:11", "write_plan"),
    kind: "product_discovery" as const,
    status: "failed" as const,
    sourceKind: "issue" as const,
    sourceId: issue.id,
    sourceUrl: issue.url,
    lastFailureCommentId: "9999",
    context: {
      repoIdentifier: issue.repoSlug,
      issueUrl: issue.url,
      labels: issue.labels,
      instruction: "Present Product Discovery analysis."
    },
    reason: "Initial Product Discovery failed."
  };

  const retryComment = baseIssueComment({
    id: "comment:eladaviv/repo-one:issue_comment:5001",
    body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-9999"
  });
  const feedbackComment = baseIssueComment({
    id: "comment:eladaviv/repo-one:issue_comment:5002",
    sourceId: "5002",
    url: "https://github.com/eladaviv/repo-one/issues/11#issuecomment-5002",
    body: "Please also fix the deployment step."
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [failedTask]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [retryComment, feedbackComment],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  const retried = tasks.find((t) => t.id === failedTask.id);
  assert.ok(retried, "failed task should be requeued");
  assert.equal(retried?.status, "pending");

  const commentTask = tasks.find((t) => t.kind === "respond_issue_comment");
  assert.ok(commentTask, "feedback comment should generate a respond_issue_comment task");
  assert.equal(commentTask?.sourceId, feedbackComment.id);

  const retryResponseTask = tasks.find(
    (t) => t.kind === "respond_issue_comment" && t.sourceId === retryComment.id
  );
  assert.equal(retryResponseTask, undefined, "bare retry comment itself should not generate a respond task");
});

test("deriveTasks requeues all packet prepare_pr_for_merge failures from task-centered retry comments", () => {
  const now = "2026-04-21T08:10:00.000Z";
  const retryNow = "2026-04-21T08:20:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const issue = baseIssue();
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:11",
    phase: "implementing",
    integration: { branchName: "agent/eladaviv-repo-one/issue-11", prNumber: 31 },
    packetPlan: {
      status: "approved",
      packets: {
        T1: { id: "T1", status: "pr_open", prNumber: 101, branchName: "packet/T1" },
        T2: { id: "T2", status: "pr_open", prNumber: 102, branchName: "packet/T2" },
        T3: { id: "T3", status: "pr_open", prNumber: 103, branchName: "packet/T3" }
      },
      waves: [["T1", "T2", "T3"]],
      currentWaveIndex: 0
    } as any
  });
  const packetPrs = ["T1", "T2", "T3"].map((packetId, index) =>
    packetPullRequest(101 + index, packetId, {
      labels: ["prepare-for-merge"],
      headSha: `head-${packetId}`
    })
  );
  const packetWorktrees = ["T1", "T2", "T3"].map((packetId) =>
    baseWorktree({
      id: `worktree:${packetId}`,
      branchName: `packet/${packetId}`,
      path: `/tmp/code-root/_worktrees/eladaviv/repo-one/packet-${packetId}`,
      packet: {
        parentWorkstreamId: workstream.id,
        packetId,
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-11"
      }
    })
  );

  const initialTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: packetPrs,
    currentComments: [],
    worktrees: packetWorktrees,
    workstreams: [workstream],
    contextBuilder: new DefaultContextBuilder(),
    now
  });
  const failedPrepareTasks = packetPrs.map((packetPr, index) => {
    const task = initialTasks.find((candidate) => candidate.id === `task:prepare_pr_for_merge:${packetPr.id}`);
    assert.ok(task, `expected prepare task for packet PR #${packetPr.number}`);
    return {
      ...task,
      status: "failed" as const,
      lastExecutionId: `exec:prepare:${packetPr.number}`,
      lastFailureCommentId: `90${index + 1}`
    };
  });
  const unrelatedFailedTask = {
    ...baseTaskRecord("task:write_plan:pull_request:eladaviv/repo-one:777", "write_plan"),
    status: "failed" as const,
    lastFailureCommentId: "9999"
  };
  const retryComments = packetPrs.map((packetPr, index) =>
    basePrComment({
      id: `comment:eladaviv/repo-one:pull_request_comment:70${index + 1}`,
      sourceId: `70${index + 1}`,
      parentNumber: packetPr.number,
      parentKey: `eladaviv/repo-one:pull_request:${packetPr.number}`,
      url: `${packetPr.url}#issuecomment-70${index + 1}`,
      body: `retry: ${packetPr.url}#issuecomment-90${index + 1}`
    })
  );

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: packetPrs,
      tasks: [...failedPrepareTasks, unrelatedFailedTask]
    },
    currentIssues: [issue],
    currentPullRequests: packetPrs,
    currentComments: retryComments,
    worktrees: packetWorktrees,
    workstreams: [workstream],
    contextBuilder: new DefaultContextBuilder(),
    now: retryNow
  });

  for (const failedTask of failedPrepareTasks) {
    const retried = tasks.find((task) => task.id === failedTask.id);
    assert.ok(retried, `expected ${failedTask.id} to be present`);
    assert.equal(retried.status, "pending");
    assert.equal(retried.context.recoveryNeeded, true);
    assert.equal(retried.lastExecutionId, failedTask.lastExecutionId);
    assert.equal(retried.lastFailureCommentId, failedTask.lastFailureCommentId);
    assert.equal(retried.updatedAt, retryNow);
  }
  assert.notEqual(tasks.find((task) => task.id === unrelatedFailedTask.id)?.status, "pending");
  assert.equal(tasks.some((task) => task.kind === "respond_pr_comment"), false);
});

test("deriveTasks requeues duplicate retry comments once for the matching failed task", () => {
  const issue = baseIssue();
  const failedTask = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:11", "write_plan"),
    kind: "product_discovery" as const,
    status: "failed" as const,
    sourceKind: "issue" as const,
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: "eladaviv/repo-one:issue:11",
    lastFailureCommentId: "9999",
    context: {
      repoIdentifier: issue.repoSlug,
      issueUrl: issue.url,
      labels: issue.labels,
      instruction: "Present Product Discovery analysis."
    }
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [failedTask]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [
      baseIssueComment({
        id: "comment:eladaviv/repo-one:issue_comment:5001",
        sourceId: "5001",
        body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-9999"
      }),
      baseIssueComment({
        id: "comment:eladaviv/repo-one:issue_comment:5002",
        sourceId: "5002",
        url: "https://github.com/eladaviv/repo-one/issues/11#issuecomment-5002",
        body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-9999"
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  assert.equal(tasks.filter((task) => task.id === failedTask.id).length, 1);
  assert.equal(tasks.find((task) => task.id === failedTask.id)?.status, "pending");
});

test("deriveTasks ignores retry targets for completed or pending tasks", () => {
  const issue = baseIssue();
  const completedTask = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:11:completed", "write_plan"),
    kind: "product_discovery" as const,
    status: "completed" as const,
    sourceKind: "issue" as const,
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: "eladaviv/repo-one:issue:11",
    lastFailureCommentId: "9999"
  };
  const pendingTask = {
    ...completedTask,
    id: "task:product_discovery:issue:eladaviv/repo-one:11:pending",
    status: "pending" as const,
    lastFailureCommentId: "8888"
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [completedTask, pendingTask]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [
      baseIssueComment({
        body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-9999"
      }),
      baseIssueComment({
        id: "comment:eladaviv/repo-one:issue_comment:5002",
        sourceId: "5002",
        url: "https://github.com/eladaviv/repo-one/issues/11#issuecomment-5002",
        body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-8888"
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  assert.equal(tasks.find((task) => task.id === completedTask.id)?.context.recoveryNeeded, undefined);
  assert.equal(tasks.find((task) => task.id === pendingTask.id)?.context.recoveryNeeded, undefined);
});

test("deriveTasks scopes retry matching to the current workstream", () => {
  const issue = baseIssue();
  const otherIssue = baseIssue({
    id: "issue:eladaviv/repo-one:99",
    number: 99,
    key: "eladaviv/repo-one:issue:99",
    sourceId: "ISSUE_99",
    url: "https://github.com/eladaviv/repo-one/issues/99"
  });
  const wrongWorkstreamTask = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:99", "write_plan"),
    kind: "product_discovery" as const,
    status: "failed" as const,
    sourceKind: "issue" as const,
    sourceId: otherIssue.id,
    sourceUrl: otherIssue.url,
    workstreamId: "eladaviv/repo-one:issue:99",
    lastFailureCommentId: "9999"
  };
  const matchingTask = {
    ...wrongWorkstreamTask,
    id: "task:product_discovery:issue:eladaviv/repo-one:11",
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: "eladaviv/repo-one:issue:11"
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue, otherIssue],
      tasks: [wrongWorkstreamTask, matchingTask]
    },
    currentIssues: [issue, otherIssue],
    currentPullRequests: [],
    currentComments: [
      baseIssueComment({
        body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-9999"
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  assert.equal(tasks.find((task) => task.id === matchingTask.id)?.status, "pending");
  assert.equal(tasks.find((task) => task.id === wrongWorkstreamTask.id)?.status, "failed");
});

test("deriveTasks uses legacy retryTargetCommentId from persisted attention as fallback", () => {
  const issue = baseIssue();
  const failedTask = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:11", "write_plan"),
    kind: "product_discovery" as const,
    status: "failed" as const,
    sourceKind: "issue" as const,
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: "eladaviv/repo-one:issue:11",
    lastFailureCommentId: "9999"
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      attention: [
        baseAttention({
          reasons: ["retry_requested"],
          retryTargetCommentId: "9999"
        })
      ],
      tasks: [failedTask]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  const retried = tasks.find((task) => task.id === failedTask.id);
  assert.ok(retried);
  assert.equal(retried.status, "pending");
  assert.equal(retried.context.recoveryNeeded, true);
  assert.equal(retried.lastFailureCommentId, "9999");
});

test("deriveTasks warns and skips ambiguous legacy retry matches", () => {
  const issue = baseIssue();
  const firstLegacyTask = {
    ...baseTaskRecord("task:legacy:first", "write_plan"),
    status: "failed" as const,
    sourceKind: "issue" as const,
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: undefined,
    lastFailureCommentId: "9999"
  };
  const secondLegacyTask = {
    ...firstLegacyTask,
    id: "task:legacy:second"
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...optionalParams: unknown[]) => {
    warnings.push([message, ...optionalParams].map(String).join(" "));
  };

  try {
    const tasks = deriveTasks({
      repos: [baseRepo()],
      repoSyncRecords: [baseRepoSync()],
      previousState: {
        ...emptyState(),
        issues: [issue],
        attention: [
          baseAttention({
            reasons: ["retry_requested"],
            retryTargetCommentId: "9999"
          })
        ],
        tasks: [firstLegacyTask, secondLegacyTask]
      },
      currentIssues: [issue],
      currentPullRequests: [],
      currentComments: [],
      contextBuilder: new DefaultContextBuilder(),
      now: "2026-04-21T08:10:00.000Z"
    });

    assert.notEqual(tasks.find((task) => task.id === firstLegacyTask.id)?.status, "pending");
    assert.notEqual(tasks.find((task) => task.id === secondLegacyTask.id)?.status, "pending");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Ignoring ambiguous legacy retry target 9999/);
    assert.match(warnings[0]!, /task:legacy:first/);
    assert.match(warnings[0]!, /task:legacy:second/);
  } finally {
    console.warn = originalWarn;
  }
});

test("deriveTasks warns and retries all duplicate modern retry matches", () => {
  const issue = baseIssue();
  const firstTask = {
    ...baseTaskRecord("task:modern:first", "write_plan"),
    status: "failed" as const,
    sourceKind: "issue" as const,
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: "eladaviv/repo-one:issue:11",
    lastFailureCommentId: "9999"
  };
  const secondTask = {
    ...firstTask,
    id: "task:modern:second"
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...optionalParams: unknown[]) => {
    warnings.push([message, ...optionalParams].map(String).join(" "));
  };

  try {
    const tasks = deriveTasks({
      repos: [baseRepo()],
      repoSyncRecords: [baseRepoSync()],
      previousState: {
        ...emptyState(),
        issues: [issue],
        tasks: [firstTask, secondTask]
      },
      currentIssues: [issue],
      currentPullRequests: [],
      currentComments: [
        baseIssueComment({
          body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-9999"
        })
      ],
      contextBuilder: new DefaultContextBuilder(),
      now: "2026-04-21T08:10:00.000Z"
    });

    assert.equal(tasks.find((task) => task.id === firstTask.id)?.status, "pending");
    assert.equal(tasks.find((task) => task.id === secondTask.id)?.status, "pending");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Multiple modern tasks matched failure comment 9999/);
    assert.match(warnings[0]!, /task:modern:first/);
    assert.match(warnings[0]!, /task:modern:second/);
  } finally {
    console.warn = originalWarn;
  }
});

test("deriveTasks does not accumulate retry reason suffixes across repeated retries", () => {
  const issue = baseIssue();
  const retrySuffix = "Retry requested by a human comment after a technical failure.";
  const failedTask = {
    ...baseTaskRecord("task:product_discovery:issue:eladaviv/repo-one:11", "write_plan"),
    kind: "product_discovery" as const,
    status: "failed" as const,
    sourceKind: "issue" as const,
    sourceId: issue.id,
    sourceUrl: issue.url,
    workstreamId: "eladaviv/repo-one:issue:11",
    lastFailureCommentId: "9999",
    reason: `Original reason. ${retrySuffix} ${retrySuffix}`
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue],
      tasks: [failedTask]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [
      baseIssueComment({
        body: "retry: https://github.com/eladaviv/repo-one/issues/11#issuecomment-9999"
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  assert.equal(
    tasks.find((task) => task.id === failedTask.id)?.reason,
    `Original reason. ${retrySuffix}`
  );
});

test("deriveTasks uses fresh same-cycle prepare_pr_for_merge context when retrying a failed task", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const pr = basePullRequest({
    labels: ["prepare-for-merge"],
    headSha: "old-head"
  });
  const initialTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:00:00.000Z"
  });
  const failedTask = {
    ...initialTasks.find((task) => task.kind === "prepare_pr_for_merge")!,
    status: "failed" as const,
    lastExecutionId: "exec:old",
    lastFailureCommentId: "9999"
  };
  const currentPr = {
    ...pr,
    headSha: "fresh-head"
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [pr],
      tasks: [failedTask]
    },
    currentIssues: [],
    currentPullRequests: [currentPr],
    currentComments: [
      basePrComment({
        body: "retry: https://github.com/eladaviv/repo-one/pull/21#issuecomment-9999"
      })
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  const retried = tasks.find((task) => task.id === failedTask.id);
  assert.ok(retried);
  assert.equal(retried.status, "pending");
  assert.equal(retried.context.prepareForMerge?.headSha, "fresh-head");
  assert.equal(retried.lastExecutionId, "exec:old");
  assert.equal(retried.lastFailureCommentId, "9999");
});

test("deriveTasks generates a respond task for a comment containing 'retry' as a technical term", () => {
  const issue = baseIssue();

  const technicalFeedback = baseIssueComment({
    body: "The retry logic in the deployment step is broken — please fix the backoff."
  });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [technicalFeedback],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  const commentTask = tasks.find((t) => t.kind === "respond_issue_comment");
  assert.ok(commentTask, "feedback mentioning 'retry' as a technical term should not be suppressed");
});

test("deriveTasks generates a respond task for a cancel comment (cancel does not suppress respond tasks)", () => {
  const issue = baseIssue();

  const cancelComment = baseIssueComment({ body: "cancel" });

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      issues: [issue]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [cancelComment],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-21T08:10:00.000Z"
  });

  const commentTask = tasks.find((t) => t.kind === "respond_issue_comment");
  assert.ok(commentTask, "a cancel comment should still generate a respond_issue_comment task");
});


test("deriveTasks handles plan-breakdown-needed derivation", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  // Test issue with plan-breakdown-needed
  const issue = baseIssue({ labels: ["plan-breakdown-needed"] });
  const workstream = baseIssueWorkstream({
    origin: { type: "issue", number: issue.number },
    linkedIssueNumber: issue.number
  });
  const issueTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    workstreams: [workstream],
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    contextBuilder: builder,
    now
  });
  const breakdownTask = issueTasks.find(t => t.kind === 'plan_breakdown');
  assert.ok(breakdownTask, 'Should have derived a plan_breakdown task');
  assert.equal(breakdownTask.kind, "plan_breakdown");
  assert.equal(breakdownTask.workstreamId, workstream.id);

  const completedBreakdownWorkstream = baseIssueWorkstream({
    origin: { type: "issue", number: issue.number },
    linkedIssueNumber: issue.number,
    packetPlan: {
      status: "proposed",
      packets: {
        T1: {
          id: "T1",
          title: "T1",
          summary: "S1",
          status: "planned",
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
        kind: "plan_breakdown_result",
        workstreamId: workstream.id,
        generatedAt: "2026-04-18T09:30:00.000Z"
      }
    }
  });
  const completedBreakdownTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      workstreams: [completedBreakdownWorkstream]
    },
    workstreams: [completedBreakdownWorkstream],
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    contextBuilder: builder,
    now
  });
  assert.equal(
    completedBreakdownTasks.some((t) => t.kind === "plan_breakdown"),
    false,
    "Should not derive another plan_breakdown after a generated packet plan exists"
  );

  // Test PR with plan-breakdown-needed
  const prTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [basePullRequest({ labels: ["plan-breakdown-needed"] })],
    currentComments: [],
    contextBuilder: builder,
    now
  });
    assert.equal(prTasks.length, 1);
    assert.equal(prTasks[0]?.kind, "plan_breakdown");

    const pr = basePullRequest({ labels: ["plan-breakdown-needed"] });
    const generatedPacketPlan = completedBreakdownWorkstream.packetPlan;
    assert.ok(generatedPacketPlan);
    const completedPrBreakdownWorkstream = baseIssueWorkstream({
      activePrNumber: pr.number,
      linkedPrs: [{ number: pr.number, status: "open", role: "implementation" }],
      packetPlan: generatedPacketPlan
    });
    const completedPrBreakdownTasks = deriveTasks({
      repos: [repo],
      repoSyncRecords: [repoSync],
      previousState: {
        ...emptyState(),
        prs: [pr],
        workstreams: [completedPrBreakdownWorkstream]
      },
      workstreams: [completedPrBreakdownWorkstream],
      attention: [
        baseAttention({
          workstreamId: completedPrBreakdownWorkstream.id,
          needsAction: true,
          reasons: ["plan_breakdown_requested"],
          pullRequestNumbers: [pr.number]
        })
      ],
      currentIssues: [],
      currentPullRequests: [pr],
      currentComments: [],
      contextBuilder: builder,
      now
    });
    assert.equal(
      completedPrBreakdownTasks.some((t) => t.kind === "plan_breakdown"),
      false,
      "Should not derive another PR-sourced plan_breakdown after a generated packet plan exists"
    );

    // Test precedence: plan-breakdown-needed wins over agent-plan-approved
    const precedenceApprovedTasks = deriveTasks({
      repos: [repo],
      repoSyncRecords: [repoSync],
      previousState: emptyState(),
      currentIssues: [baseIssue({ labels: ["plan-breakdown-needed", "agent-plan-approved"] })],
      currentPullRequests: [],
      currentComments: [],
      contextBuilder: builder,
      now
    });
    assert.equal(precedenceApprovedTasks.length, 1);
    assert.equal(precedenceApprovedTasks[0]?.kind, "plan_breakdown");

    // Test precedence: plan-breakdown-needed wins over agent-in-progress
    const precedenceInProgressTasks = deriveTasks({
      repos: [repo],
      repoSyncRecords: [repoSync],
      previousState: emptyState(),
      currentIssues: [baseIssue({ labels: ["plan-breakdown-needed", "agent-in-progress"] })],
      currentPullRequests: [],
      currentComments: [],
      contextBuilder: builder,
      now
    });
    assert.equal(precedenceInProgressTasks.length, 1);
    assert.equal(precedenceInProgressTasks[0]?.kind, "plan_breakdown");

    // Test precedence: plan-breakdown-needed wins over agent-review
    const precedenceReviewTasks = deriveTasks({
      repos: [repo],
      repoSyncRecords: [repoSync],
      previousState: emptyState(),
      currentIssues: [baseIssue({ labels: ["plan-breakdown-needed", "agent-review"] })],
      currentPullRequests: [],
      currentComments: [],
      contextBuilder: builder,
      now
    });
    assert.equal(precedenceReviewTasks.length, 1);
    assert.equal(precedenceReviewTasks[0]?.kind, "plan_breakdown");
  });

test("deriveTasks drops a carried-forward plan_breakdown task when breakdown is complete", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ labels: ["plan-breakdown-needed"] });
  const workstream = baseIssueWorkstream({
    origin: { type: "issue", number: issue.number },
    linkedIssueNumber: issue.number
  });

  // First run: derive a plan_breakdown task
  const firstRunTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    workstreams: [workstream],
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    contextBuilder: builder,
    now
  });
  const breakdownTask = firstRunTasks.find((t) => t.kind === "plan_breakdown");
  assert.ok(breakdownTask, "Should have derived a plan_breakdown task in the first run");

  // Now build a workstream where breakdown is complete
  const completedWorkstream = baseIssueWorkstream({
    origin: { type: "issue", number: issue.number },
    linkedIssueNumber: issue.number,
    packetPlan: {
      status: "proposed",
      packets: {
        T1: {
          id: "T1",
          title: "T1",
          summary: "S1",
          status: "planned",
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
        kind: "plan_breakdown_result",
        workstreamId: workstream.id,
        generatedAt: "2026-04-18T09:30:00.000Z"
      }
    }
  });

  // Second run: same issue + label, but the task from the first run is in previousState
  // and the workstream now has a completed packet plan
  const secondRunTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      workstreams: [completedWorkstream],
      tasks: [breakdownTask]
    },
    workstreams: [completedWorkstream],
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    contextBuilder: builder,
    now
  });

  assert.equal(
    secondRunTasks.some((t) => t.kind === "plan_breakdown"),
    false,
    "Should drop the carried-forward plan_breakdown task when breakdown is complete"
  );
});

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

function baseRepoSync(): RepoSyncRecord {
  return {
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    localPath: "/tmp/code-root/repo-one",
    codeRoot: "/tmp/code-root",
    status: "synced",
    existedBeforeSync: true,
    cloned: false,
    fetched: true,
    defaultBranch: "main",
    defaultBranchSource: "github",
    currentBranchBefore: "main",
    currentBranchAfter: "main",
    syncedAt: "2026-04-18T09:55:00.000Z",
    message: "Repository fetched and synchronized to the latest default branch."
  };
}

function baseIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    kind: "issue",
    id: "issue:eladaviv/repo-one:11",
    repoId: "repo-1",
    repoKey: "eladaviv/repo-one",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number: 11,
    key: "eladaviv/repo-one:issue:11",
    sourceId: "ISSUE_11",
    url: "https://github.com/eladaviv/repo-one/issues/11",
    title: "Need a workflow",
    body: "Please figure out the next step.",
    labels: [],
    author: "owner",
    createdAt: "2026-04-18T08:00:00.000Z",
    updatedAt: "2026-04-18T08:10:00.000Z",
    lastSeenAt: "2026-04-18T09:00:00.000Z",
    state: "open",
    ...overrides
  };
}

function basePullRequest(overrides: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  return {
    kind: "pull_request",
    id: "pull_request:eladaviv/repo-one:21",
    repoId: "repo-1",
    repoKey: "eladaviv/repo-one",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number: 21,
    key: "eladaviv/repo-one:pull_request:21",
    sourceId: "PR_21",
    url: "https://github.com/eladaviv/repo-one/pull/21",
    title: "Add orchestrator tasks",
    body: "This PR tracks implementation work.",
    labels: [],
    author: "owner",
    createdAt: "2026-04-18T08:15:00.000Z",
    updatedAt: "2026-04-18T08:20:00.000Z",
    lastSeenAt: "2026-04-18T09:00:00.000Z",
    state: "open",
    headBranch: "feature/tasks",
    headSha: "abc123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false,
    ...overrides
  };
}

function packetPullRequest(
  number: number,
  packetId: string,
  overrides: Partial<NormalizedPullRequest> = {}
): NormalizedPullRequest {
  return basePullRequest({
    id: `pull_request:eladaviv/repo-one:${number}`,
    number,
    key: `eladaviv/repo-one:pull_request:${number}`,
    sourceId: `PR_${number}`,
    url: `https://github.com/eladaviv/repo-one/pull/${number}`,
    title: `Packet ${packetId}`,
    headBranch: `packet/${packetId}`,
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent",
    ...overrides
  });
}

function baseIssueComment(overrides: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    kind: "comment",
    commentKind: "issue_comment",
    id: "comment:eladaviv/repo-one:issue_comment:5001",
    sourceId: "5001",
    repoId: "repo-1",
    repoKey: "eladaviv/repo-one",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    parentType: "issue",
    parentNumber: 11,
    parentKey: "eladaviv/repo-one:issue:11",
    url: "https://github.com/eladaviv/repo-one/issues/11#issuecomment-5001",
    body: "Can you start on this?",
    author: "owner",
    createdAt: "2026-04-18T08:30:00.000Z",
    updatedAt: "2026-04-18T08:30:00.000Z",
    lastSeenAt: "2026-04-18T09:00:00.000Z",
    ...overrides
  };
}

function basePrComment(overrides: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    kind: "comment",
    commentKind: "pull_request_comment",
    id: "comment:eladaviv/repo-one:pull_request_comment:6001",
    sourceId: "6001",
    repoId: "repo-1",
    repoKey: "eladaviv/repo-one",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    parentType: "pull_request",
    parentNumber: 21,
    parentKey: "eladaviv/repo-one:pull_request:21",
    url: "https://github.com/eladaviv/repo-one/pull/21#issuecomment-6001",
    body: "Please update the context packet.",
    author: "reviewer",
    createdAt: "2026-04-18T08:40:00.000Z",
    updatedAt: "2026-04-18T08:40:00.000Z",
    lastSeenAt: "2026-04-18T09:00:00.000Z",
    ...overrides
  };
}

function baseTaskRecord(
  id: string,
  kind: "implement_plan" | "write_plan"
): import("../src/tasks/types.js").TaskRecord {
  const executionPolicy = workflowRegistry.resolveTaskExecutionPolicy(kind);

  return {
    id,
    kind,
    status: "pending",
    executionPermission: executionPolicy.executionPermission,
    handoffPolicy: executionPolicy.handoffPolicy,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    sourceKind: "pull_request",
    sourceId: "pull_request:eladaviv/repo-one:21",
    sourceUrl: "https://github.com/eladaviv/repo-one/pull/21",
    relevant: true,
    reason: "Reason",
    summary: "Summary",
    context: {
      repoIdentifier: "eladaviv/repo-one",
      localRepoPath: "/tmp/code-root/repo-one",
      labels: [],
      pullRequestUrl: "https://github.com/eladaviv/repo-one/pull/21",
      instruction: "Instruction"
    },
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z"
  };
}

function baseWorktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "worktree:eladaviv/repo-one:issue:11",
    repoId: "repo-1",
    repoSlug: "eladaviv/repo-one",
    repoName: "repo-one",
    branchName: "feature/tasks",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11",
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11/docs/agents/feature-tasks/issue-11-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11/docs/agents/feature-tasks/issue-11-agent-log.md",
    status: "planning",
    createdAt: "2026-04-18T09:00:00.000Z",
    updatedAt: "2026-04-18T09:00:00.000Z",
    ...overrides
  };
}

function baseIssueWorkstream(overrides: Partial<WorkstreamRecord> = {}): WorkstreamRecord {
  return {
    id: "eladaviv/repo-one:issue:11",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 11 },
    linkedIssueNumber: 11,
    linkedPrs: [],
    phase: "issue_triage",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    ...overrides
  };
}

function baseAttention(overrides: Partial<AttentionRecord> = {}): AttentionRecord {
  return {
    workstreamId: "eladaviv/repo-one:issue:11",
    repoKey: "eladaviv/repo-one",
    needsAction: false,
    reasons: [],
    lastObservedAt: "2026-04-18T10:00:00.000Z",
    ...overrides
  };
}

function baseSyncPreflightPacketPlan() {
  return {
    status: "approved",
    packets: {
      "T1": { id: "T1", status: "merged_to_parent" },
      "T2": { id: "T2", status: "planned" }
    },
    waves: [["T1"], ["T2"]],
    currentWaveIndex: 0
  };
}

function baseSyncPreflightWorkstream(overrides: Partial<WorkstreamRecord> = {}): WorkstreamRecord {
  return baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:11",
    origin: { type: "issue", number: 11 },
    linkedIssueNumber: 11,
    phase: "implementing",
    integration: { branchName: "agent/eladaviv-repo-one/issue-11", prNumber: 31 },
    packetPlan: baseSyncPreflightPacketPlan() as any,
    ...overrides
  });
}

function baseSyncPreflightAttention(overrides: Partial<AttentionRecord> = {}): AttentionRecord {
  return baseAttention({
    workstreamId: "eladaviv/repo-one:issue:11",
    reasons: ["packet_wave_complete_sync_needed"],
    ...overrides
  });
}

function baseParentPullRequest(overrides: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  return basePullRequest({
    id: "pull_request:eladaviv/repo-one:31",
    number: 31,
    key: "eladaviv/repo-one:pull_request:31",
    sourceId: "PR_31",
    url: "https://github.com/eladaviv/repo-one/pull/31",
    title: "Parent integration PR",
    headBranch: "agent/eladaviv-repo-one/issue-11",
    baseBranch: "main",
    baseClassification: "top_level",
    ...overrides
  });
}

function baseWaveAssessmentExecution(
  decision: "continue" | "replan" | "blocked" = "continue",
  identityOverrides: Partial<{
    repoKey: string;
    workstreamId: string;
    waveId: string;
    parentPrNumber: number;
    parentHeadSha: string;
    parentIntegrationBranch: string;
    defaultBranch: string;
    planRevision: string;
    originalPlanningSessionId: string;
    currentWaveIndex: number;
    nextWaveIndex: number;
    completedPacketIds: string[];
    pendingFuturePacketIds: string[];
    planNodeIds: string[];
  }> = {},
  options: { postedCommentId?: string | undefined } = { postedCommentId: "123" }
) {
  const checkpoint = {
    id: "checkpoint-1",
    sessionId: "checkpoint-1",
    identity: {
      repoKey: "eladaviv/repo-one",
      workstreamId: "eladaviv/repo-one:issue:11",
      waveId: "wave-0",
      parentPrNumber: 31,
      parentHeadSha: "abc123",
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-11",
      defaultBranch: "main",
      planRevision: "0:T1,T2",
      originalPlanningSessionId: "unknown",
      currentWaveIndex: 0,
      nextWaveIndex: 1,
      completedPacketIds: ["T1"],
      pendingFuturePacketIds: ["T2"],
      planNodeIds: ["T1", "T2"],
      ...identityOverrides
    }
  };

  return {
    id: `exec:wave-assessment:${decision}`,
    taskId: "task:wave_plan_assessment:checkpoint-1",
    taskKind: "wave_plan_assessment",
    taskStatus: "completed",
    repoId: "repo-1",
    repoSlug: "eladaviv/repo-one",
    agentId: "agent",
    agentProvider: "codex",
    command: { executable: "codex", args: [], cwd: "/tmp/code-root/repo-one", timeoutMs: 1000 },
    promptArtifactPath: "/tmp/prompt.txt",
    stdoutArtifactPath: "/tmp/stdout.txt",
    stderrArtifactPath: "/tmp/stderr.txt",
    promptPacketPath: "/tmp/packet.json",
    startedAt: "2026-04-18T09:00:00.000Z",
    endedAt: "2026-04-18T09:01:00.000Z",
    exitCode: 0,
    result: {
      waveAssessment: {
        id: `assessment-${decision}`,
        sessionId: checkpoint.sessionId,
        checkpoint,
        decision,
        summary: `${decision} summary`,
        findings: [],
        status: "finalized",
        ...(options.postedCommentId ? { postedCommentId: options.postedCommentId } : {}),
        finalizedAt: "2026-04-18T09:01:00.000Z"
      }
    }
  } as any;
}

test("deriveTasks derives wave_plan_assessment before sync-parent tasks for completed packet wave", () => {
  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: emptyState(),
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest()],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  const assessmentTask = tasks.find((task) => task.kind === "wave_plan_assessment");
  assert.ok(assessmentTask, "Should derive assessment task");
  assert.equal(assessmentTask.sourceKind, "pull_request");
  assert.equal(assessmentTask.sourceId, "pull_request:eladaviv/repo-one:31");
  assert.equal(assessmentTask.context.pullRequestUrl, "https://github.com/eladaviv/repo-one/pull/31");
  assert.equal(assessmentTask.context.issueUrl, "https://github.com/eladaviv/repo-one/issues/11");
  assert.equal(assessmentTask.context.waveAssessmentCheckpoint?.identity.currentWaveIndex, 0);
  assert.ok(!tasks.some((task) => task.kind === "sync_parent_branch_preflight"));
  assert.ok(!tasks.some((task) => task.kind === "sync_parent_branch"));
});

test("deriveTasks derives wave_plan_replanning when finalized assessment requires replan", () => {
  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      executions: [baseWaveAssessmentExecution("replan")]
    },
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest()],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  const replanningTask = tasks.find((task) => task.kind === "wave_plan_replanning");
  assert.ok(replanningTask, "Should derive replanning task");
  assert.equal(replanningTask.context.finalizedWaveAssessment?.decision, "replan");
  assert.ok(!tasks.some((task) => task.kind === "wave_plan_assessment"));
  assert.ok(!tasks.some((task) => task.kind === "sync_parent_branch_preflight"));
});

test("deriveTasks allows sync-parent tasks only after finalized continue assessment is posted", () => {
  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      executions: [baseWaveAssessmentExecution("continue")]
    },
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest({ labels: ["agent-sync-parent-branch"] })],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.ok(tasks.some((task) => task.kind === "sync_parent_branch_preflight"));
  assert.ok(tasks.some((task) => task.kind === "sync_parent_branch"));
  assert.ok(!tasks.some((task) => task.kind === "wave_plan_assessment"));
  assert.ok(!tasks.some((task) => task.kind === "wave_plan_replanning"));
});

test("deriveTasks reopens same-id wave_plan_assessment when finalized continue assessment was not posted", () => {
  const initialTasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: emptyState(),
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest({ labels: ["agent-sync-parent-branch"] })],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T09:50:00.000Z"
  });
  const priorAssessmentTask = initialTasks.find((task) => task.kind === "wave_plan_assessment");
  assert.ok(priorAssessmentTask);

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      tasks: [
        {
          ...priorAssessmentTask,
          status: "completed",
          lastExecutionId: "exec:wave-assessment:continue"
        }
      ],
      executions: [baseWaveAssessmentExecution("continue", {}, { postedCommentId: undefined })]
    },
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest({ labels: ["agent-sync-parent-branch"] })],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  const assessmentTask = tasks.find((task) => task.kind === "wave_plan_assessment");
  assert.ok(assessmentTask);
  assert.equal(assessmentTask.id, priorAssessmentTask.id);
  assert.equal(assessmentTask.status, "pending");
  assert.ok(!tasks.some((task) => task.kind === "sync_parent_branch_preflight"));
  assert.ok(!tasks.some((task) => task.kind === "sync_parent_branch"));
});

test("deriveTasks carries failed wave tasks forward so GitHub retry comments can find them", () => {
  const replanExecution = baseWaveAssessmentExecution("replan");
  const checkpoint = replanExecution.result!.waveAssessment!.checkpoint;
  const executionPolicy = workflowRegistry.resolveTaskExecutionPolicy("wave_plan_assessment");
  const failedAssessmentTask: TaskRecord = {
    id: `task:wave_plan_assessment:${checkpoint.id}`,
    kind: "wave_plan_assessment",
    status: "failed",
    executionPermission: executionPolicy.executionPermission,
    handoffPolicy: executionPolicy.handoffPolicy,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    sourceKind: "pull_request",
    sourceId: "pull_request:eladaviv/repo-one:31",
    sourceUrl: "https://github.com/eladaviv/repo-one/pull/31",
    relevant: true,
    reason: "Assessment failed.",
    summary: "Assess wave",
    workstreamId: "eladaviv/repo-one:issue:11",
    lastFailureCommentId: "999",
    context: {
      repoIdentifier: "eladaviv/repo-one",
      pullRequestUrl: "https://github.com/eladaviv/repo-one/pull/31",
      issueUrl: "https://github.com/eladaviv/repo-one/issues/11",
      labels: [],
      waveAssessmentCheckpoint: checkpoint,
      instruction: "Assess wave."
    },
    createdAt: "2026-04-18T09:00:00.000Z",
    updatedAt: "2026-04-18T09:01:00.000Z"
  };
  const replanPolicy = workflowRegistry.resolveTaskExecutionPolicy("wave_plan_replanning");
  const failedReplanningTask: TaskRecord = {
    ...failedAssessmentTask,
    id: `task:wave_plan_replanning:${checkpoint.id}`,
    kind: "wave_plan_replanning",
    executionPermission: replanPolicy.executionPermission,
    handoffPolicy: replanPolicy.handoffPolicy,
    reason: "Replanning failed.",
    summary: "Replan wave",
    lastFailureCommentId: "1000",
    context: {
      ...failedAssessmentTask.context,
      finalizedWaveAssessment: replanExecution.result!.waveAssessment
    }
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      tasks: [failedAssessmentTask, failedReplanningTask],
      executions: [replanExecution]
    },
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest({ labels: ["agent-sync-parent-branch"] })],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.equal(tasks.find((task) => task.id === failedAssessmentTask.id)?.status, "failed");
  assert.equal(tasks.find((task) => task.id === failedAssessmentTask.id)?.lastFailureCommentId, "999");
  assert.equal(tasks.find((task) => task.id === failedReplanningTask.id)?.status, "failed");
  assert.equal(tasks.find((task) => task.id === failedReplanningTask.id)?.lastFailureCommentId, "1000");
});

test("deriveTasks does not carry forward stale pending wave assessment after parent head changes", () => {
  const previousTasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: emptyState(),
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest({ headSha: "old-head" })],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T09:50:00.000Z"
  });
  const staleAssessmentTask = previousTasks.find((task) => task.kind === "wave_plan_assessment");
  assert.ok(staleAssessmentTask);
  assert.equal(staleAssessmentTask.context.waveAssessmentCheckpoint?.identity.parentHeadSha, "old-head");

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      tasks: [staleAssessmentTask]
    },
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest({ headSha: "new-head" })],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  assert.ok(!tasks.some((task) => task.id === staleAssessmentTask.id));
  const currentAssessmentTask = tasks.find((task) => task.kind === "wave_plan_assessment");
  assert.ok(currentAssessmentTask);
  assert.notEqual(currentAssessmentTask.id, staleAssessmentTask.id);
  assert.equal(currentAssessmentTask.context.waveAssessmentCheckpoint?.identity.parentHeadSha, "new-head");
});

test("deriveTasks derives fresh wave assessment when original planning session changes", () => {
  const previousTasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: emptyState(),
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest()],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T09:50:00.000Z"
  });
  const completedAssessmentTask = previousTasks.find((task) => task.kind === "wave_plan_assessment");
  assert.ok(completedAssessmentTask);
  assert.equal(
    completedAssessmentTask.context.waveAssessmentCheckpoint?.identity.originalPlanningSessionId,
    "unknown"
  );

  const planBreakdownTask: TaskRecord = {
    ...completedAssessmentTask,
    id: "task:plan_breakdown:planner-new",
    kind: "plan_breakdown",
    status: "completed",
    workstreamId: "eladaviv/repo-one:issue:11"
  };

  const tasks = deriveTasks({
    repos: [baseRepo()],
    repoSyncRecords: [baseRepoSync()],
    previousState: {
      ...emptyState(),
      tasks: [
        {
          ...completedAssessmentTask,
          status: "completed"
        },
        planBreakdownTask
      ],
      executions: [
        {
          ...baseWaveAssessmentExecution("continue"),
          id: "exec:plan-breakdown:planner-new",
          taskId: planBreakdownTask.id,
          taskKind: "plan_breakdown",
          taskStatus: "completed",
          endedAt: "2026-04-18T09:55:00.000Z",
          result: {
            planBreakdownSessionId: "planner-new"
          }
        } as any
      ]
    },
    currentIssues: [baseIssue()],
    currentPullRequests: [baseParentPullRequest()],
    currentComments: [],
    workstreams: [baseSyncPreflightWorkstream()],
    attention: [baseSyncPreflightAttention({ needsAction: true, issueNumber: 11, pullRequestNumbers: [31] })],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:00:00.000Z"
  });

  const assessmentTask = tasks.find((task) => task.kind === "wave_plan_assessment");
  assert.ok(assessmentTask);
  assert.notEqual(assessmentTask.id, completedAssessmentTask.id);
  assert.equal(assessmentTask.status, "pending");
  assert.equal(
    assessmentTask.context.waveAssessmentCheckpoint?.identity.originalPlanningSessionId,
    "planner-new"
  );
});

test("deriveTasks derives write_plan tasks for packet worktrees even when parent workstream is in implementing phase", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 90 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:90",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 90 },
    linkedIssueNumber: 90,
    phase: "implementing",
    packetPlan: {
      status: "approved",
      packets: {
        "packet-1": {
          id: "packet-1",
          title: "Packet 1",
          summary: "First packet",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "planned"
        }
      },
      waves: [["packet-1"]],
      currentWaveIndex: 0
    } as any
  });

  const packetWorktree: WorktreeRecord = {
    ...baseWorktree({
      id: "worktree:eladaviv/repo-one:packet:packet-1",
      branchName: "packet/packet-1",
      path: "/tmp/code-root/_worktrees/eladaviv/repo-one/packet-1",
      packet: {
        parentWorkstreamId: workstream.id,
        packetId: "packet-1",
        waveIndex: 0,
        parentIntegrationBranch: "main"
      }
    }),
    status: "planning"
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      workstreams: [workstream],
      worktrees: [packetWorktree]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const packetWritePlanTask = tasks.find(t => t.id === `task:write_plan:worktree:${packetWorktree.id}`);
  assert.ok(packetWritePlanTask, "Should have derived a write_plan task for the packet worktree");
  assert.equal(packetWritePlanTask.kind, "write_plan");
  assert.match(packetWritePlanTask.summary, /packet-1/);
  assert.equal(packetWritePlanTask.context.packetId, "packet-1");
});

test("deriveTasks derives write_plan tasks for packet worktrees even when plan_approved is in attention", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 90 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:90",
    origin: { type: "issue", number: 90 },
    linkedIssueNumber: 90,
    phase: "planning"
  });

  const attention = baseAttention({
    workstreamId: workstream.id,
    reasons: ["plan_approved"]
  });

  const packetWorktree: WorktreeRecord = {
    ...baseWorktree({
      id: "worktree:eladaviv/repo-one:packet:packet-1",
      packet: {
        parentWorkstreamId: workstream.id,
        packetId: "packet-1",
        waveIndex: 0,
        parentIntegrationBranch: "main"
      }
    }),
    status: "planning"
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      workstreams: [workstream],
      worktrees: [packetWorktree],
      attention: [attention]
    },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const packetWritePlanTask = tasks.find(t => t.id === `task:write_plan:worktree:${packetWorktree.id}`);
  assert.ok(packetWritePlanTask, "Should have derived a write_plan task for the packet worktree despite plan_approved attention");
});

test("deriveTasks packet planning task context and stability", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 92 });
  const packetPlan = {
    status: "approved",
    packets: {
      "T1": {
        id: "T1",
        title: "Task 1",
        summary: "First task",
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
  };

  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:92",
    origin: { type: "issue", number: 92 },
    linkedIssueNumber: 92,
    packetPlan: packetPlan as any
  });

  const packetWorktree: WorktreeRecord = {
    ...baseWorktree({
      id: "worktree:eladaviv/repo-one:issue:92:packet:T1",
      branchName: "agent/eladaviv-repo-one/workstream-issue-92/packet-t1",
      path: "/tmp/code-root/_worktrees/eladaviv/repo-one/packet-t1",
      planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/packet-t1/docs/agents/packet-t1/t1-plan.md",
      logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/packet-t1/docs/agents/packet-t1/t1-log.md",
      packet: {
        parentWorkstreamId: workstream.id,
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "main"
      }
    }),
    status: "planning"
  };

  const firstTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const packetTask = firstTasks.find(t => t.id === `task:write_plan:worktree:${packetWorktree.id}`);
  assert.ok(packetTask);
  assert.equal(packetTask.context.localRepoPath, packetWorktree.path);
  assert.equal(packetTask.context.branchName, packetWorktree.branchName);
  assert.equal(packetTask.context.planDocumentPath, packetWorktree.planDocumentPath);
  assert.equal(packetTask.context.logDocumentPath, packetWorktree.logDocumentPath);
  assert.equal(packetTask.context.packetId, "T1");
  assert.match(packetTask.summary, /T1/);
  assert.match(packetTask.summary, /wave 0/i);

  // Repeated derivation is stable
  const secondTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: firstTasks },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now: "2026-04-18T10:05:00.000Z"
  });

  const packetTaskSecond = secondTasks.find(t => t.id === packetTask.id);
  assert.ok(packetTaskSecond);
  assert.equal(packetTaskSecond.createdAt, packetTask.createdAt);
  assert.equal(secondTasks.length, firstTasks.length);

  // Completed packet task remains terminal
  const completedPacketTask = {
    ...packetTask,
    status: "completed" as const,
    lastExecutionId: "exec:1"
  };

  const thirdTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: [completedPacketTask] },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now: "2026-04-18T10:10:00.000Z"
  });


  const packetTaskThird = thirdTasks.find(t => t.id === packetTask.id);
  assert.equal(packetTaskThird?.status, "completed");
  assert.equal(packetTaskThird?.lastExecutionId, "exec:1");
});

test("deriveTasks creates implement_plan for implementation-ready packet worktree", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 96 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:96",
    origin: { type: "issue", number: 96 },
    linkedIssueNumber: 96,
    phase: "implementing",
    packetPlan: {
      status: "approved",
      packets: {
        T1: {
          id: "T1",
          title: "Task 1",
          summary: "First task",
          status: "approved"
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });

  const packetWorktree = baseWorktree({
    id: "worktree:eladaviv/repo-one:issue:96:packet:t1",
    branchName: "agent/eladaviv-repo-one/workstream-issue-96/packet-t1",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/packet-t1",
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/packet-t1/docs/agents/packet-t1/packet-t1-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/packet-t1/docs/agents/packet-t1/packet-t1-agent-log.md",
    packet: {
      parentWorkstreamId: workstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-96"
    },
    status: "implementation_ready"
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const task = tasks.find(t => t.id === `task:implement_plan:worktree:${packetWorktree.id}`);
  assert.ok(task, "Should have derived an implement_plan task for the packet worktree");
  assert.equal(task.kind, "implement_plan");
  assert.equal(task.sourceKind, "issue");
  assert.equal(task.sourceId, issue.id);
  assert.equal(task.context.localRepoPath, packetWorktree.path);
  assert.equal(task.context.branchName, packetWorktree.branchName);
  assert.equal(task.context.packetId, "T1");
  assert.equal(task.context.planDocumentPath, packetWorktree.planDocumentPath);
  assert.equal(task.context.logDocumentPath, packetWorktree.logDocumentPath);
  assert.match(task.summary ?? "", /T1/);
  assert.match(task.summary ?? "", /wave 0/i);
  assert.match(task.reason ?? "", /T1/);
  assert.match(task.reason ?? "", /wave 0/i);
});

test("deriveTasks packet implement_plan uses worktree.prUrl if available", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 96 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:96",
    origin: { type: "issue", number: 96 },
    linkedIssueNumber: 96,
    phase: "implementing",
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", status: "approved" } },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });

  const packetPrUrl = "https://github.com/eladaviv/repo-one/pull/100";
  const packetWorktree = baseWorktree({
    id: "worktree:eladaviv/repo-one:issue:96:packet:t1",
    packet: {
      parentWorkstreamId: workstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-96"
    },
    status: "implementation_ready",
    prUrl: packetPrUrl
  });

  const packetPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:100",
    number: 100,
    key: "eladaviv/repo-one:pull_request:100",
    sourceId: "PR_100",
    url: packetPrUrl
  });

  // 1. Check with PR resolved
  const tasksWithPr = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [packetPr],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const taskWithPr = tasksWithPr.find(t => t.id === `task:implement_plan:worktree:${packetWorktree.id}`);
  assert.ok(taskWithPr);
  assert.equal(taskWithPr.sourceKind, "pull_request");
  assert.equal(taskWithPr.sourceId, packetPr.id);
  assert.equal(taskWithPr.sourceUrl, packetPr.url);
  assert.equal(taskWithPr.context.pullRequestUrl, packetPrUrl);
  assert.equal(taskWithPr.context.issueUrl, issue.url);

  // 2. Check fallback (no PR in scan list)
  const tasksWithoutPr = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const taskWithoutPr = tasksWithoutPr.find(t => t.id === `task:implement_plan:worktree:${packetWorktree.id}`);
  assert.ok(taskWithoutPr);
  assert.equal(taskWithoutPr.sourceKind, "issue");
  assert.equal(taskWithoutPr.sourceUrl, issue.url);
  assert.equal(taskWithoutPr.context.pullRequestUrl, packetPrUrl);
});

test("deriveTasks packet write_plan uses worktree.prUrl if available", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 96 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:96",
    origin: { type: "issue", number: 96 },
    linkedIssueNumber: 96,
    phase: "planning"
  });

  const packetPrUrl = "https://github.com/eladaviv/repo-one/pull/100";
  const packetWorktree = baseWorktree({
    id: "worktree:eladaviv/repo-one:issue:96:packet:t1",
    packet: {
      parentWorkstreamId: workstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-96"
    },
    status: "planning",
    prUrl: packetPrUrl
  });

  const packetPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:100",
    number: 100,
    key: "eladaviv/repo-one:pull_request:100",
    sourceId: "PR_100",
    url: packetPrUrl
  });

  // 1. Check with PR resolved
  const tasksWithPr = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [packetPr],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const taskWithPr = tasksWithPr.find(t => t.id === `task:write_plan:worktree:${packetWorktree.id}`);
  assert.ok(taskWithPr);
  assert.equal(taskWithPr.sourceKind, "pull_request");
  assert.equal(taskWithPr.sourceId, packetPr.id);
  assert.equal(taskWithPr.sourceUrl, packetPr.url);
  assert.equal(taskWithPr.context.pullRequestUrl, packetPrUrl);
  assert.equal(taskWithPr.context.issueUrl, issue.url);

  // 2. Check fallback (no PR in scan list)
  const tasksWithoutPr = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const taskWithoutPr = tasksWithoutPr.find(t => t.id === `task:write_plan:worktree:${packetWorktree.id}`);
  assert.ok(taskWithoutPr);
  assert.equal(taskWithoutPr.sourceKind, "issue");
  assert.equal(taskWithoutPr.sourceUrl, issue.url);
  assert.equal(taskWithoutPr.context.pullRequestUrl, packetPrUrl);
});

test("deriveTasks does not duplicate packet implement_plan across repeated derivation", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 96 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:96",
    origin: { type: "issue", number: 96 },
    linkedIssueNumber: 96,
    phase: "implementing",
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", status: "approved" } },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });

  const packetWorktree = baseWorktree({
    id: "worktree:eladaviv/repo-one:issue:96:packet:t1",
    packet: {
      parentWorkstreamId: workstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "main"
    },
    status: "implementation_ready"
  });

  const firstTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const task = firstTasks.find(t => t.id === `task:implement_plan:worktree:${packetWorktree.id}`);
  assert.ok(task);

  const secondTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: firstTasks },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now: "2026-04-18T10:05:00.000Z"
  });

  const packetTasks = secondTasks.filter(t => t.id === task.id);
  assert.equal(packetTasks.length, 1, "Should have exactly one packet implement_plan task");
  const secondPacketTask = packetTasks[0];
  assert.ok(secondPacketTask);
  assert.equal(secondPacketTask.createdAt, task.createdAt, "Should preserve createdAt");
});

test("deriveTasks keeps completed packet implement_plan terminal when context is unchanged", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 96 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:96",
    origin: { type: "issue", number: 96 },
    linkedIssueNumber: 96,
    phase: "implementing",
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", status: "approved" } },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });

  const packetWorktree = baseWorktree({
    id: "worktree:eladaviv/repo-one:issue:96:packet:t1",
    packet: {
      parentWorkstreamId: workstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "main"
    },
    status: "implementation_ready"
  });

  const firstTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const task = firstTasks.find(t => t.id === `task:implement_plan:worktree:${packetWorktree.id}`);
  assert.ok(task);

  task.status = "completed";
  (task as any).lastExecutionId = "exec-123";

  const secondTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: firstTasks },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now: "2026-04-18T10:05:00.000Z"
  });

  const secondTask = secondTasks.find(t => t.id === task.id);
  assert.ok(secondTask);
  assert.equal(secondTask.status, "completed");
  assert.equal((secondTask as any).lastExecutionId, "exec-123");
});

test("deriveTasks does not create packet implement_plan for planning or awaiting_plan_approval packet worktree", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 96 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:96",
    origin: { type: "issue", number: 96 },
    linkedIssueNumber: 96,
    phase: "implementing",
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", status: "planned" } },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });

  const planningWorktree = baseWorktree({
    id: "worktree:planning",
    packet: { parentWorkstreamId: workstream.id, packetId: "T1", waveIndex: 0, parentIntegrationBranch: "main" },
    status: "planning"
  });

  const awaitingWorktree = baseWorktree({
    id: "worktree:awaiting",
    packet: { parentWorkstreamId: workstream.id, packetId: "T1", waveIndex: 0, parentIntegrationBranch: "main" },
    status: "awaiting_plan_approval"
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [planningWorktree, awaitingWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const implementTasks = tasks.filter(t => t.kind === "implement_plan");
  assert.equal(implementTasks.length, 0, "Should not derive implement_plan for non-ready packet worktrees");

  const writePlanTasks = tasks.filter(t => t.kind === "write_plan");
  assert.equal(writePlanTasks.length, 1, "Should still derive write_plan for planning worktree");
  const writePlanTask = writePlanTasks[0];
  assert.ok(writePlanTask);
  assert.equal(writePlanTask.id, `task:write_plan:worktree:${planningWorktree.id}`);
});

test("deriveTasks ignores packet worktrees whose packet IDs are no longer in the current packet plan", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 196 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:196",
    origin: { type: "issue", number: 196 },
    linkedIssueNumber: 196,
    phase: "implementing",
    packetPlan: {
      status: "approved",
      packets: {
        R1: { id: "R1", title: "R1", summary: "R1", status: "planned" }
      },
      waves: [["R1"]],
      currentWaveIndex: 0
    } as any
  });

  const activePacketWorktree = baseWorktree({
    id: "worktree:active-r1",
    packet: { parentWorkstreamId: workstream.id, packetId: "R1", waveIndex: 0, parentIntegrationBranch: "main" },
    status: "planning"
  });
  const stalePacketWorktree = baseWorktree({
    id: "worktree:stale-t2",
    packet: { parentWorkstreamId: workstream.id, packetId: "T2", waveIndex: 1, parentIntegrationBranch: "main" },
    status: "planning"
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [activePacketWorktree, stalePacketWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  assert.ok(tasks.some((task) => task.id === `task:write_plan:worktree:${activePacketWorktree.id}`));
  assert.ok(!tasks.some((task) => task.id.includes(stalePacketWorktree.id)));
});

test("deriveTasks does not create packet implement_plan after implementation_done", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 96 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:96",
    origin: { type: "issue", number: 96 },
    linkedIssueNumber: 96,
    phase: "implementation_done",
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", status: "approved" } },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });

  const packetWorktree = baseWorktree({
    id: "worktree:eladaviv/repo-one:issue:96:packet:t1",
    packet: { parentWorkstreamId: workstream.id, packetId: "T1", waveIndex: 0, parentIntegrationBranch: "main" },
    status: "implementation_done"
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const implementTasks = tasks.filter(t => t.kind === "implement_plan");
  assert.equal(implementTasks.length, 0, "Should not derive implement_plan for completed packet worktrees");
});

test("deriveTasks does not carry forward pending packet implement_plan after approval label is removed", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 96 });
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:96",
    origin: { type: "issue", number: 96 },
    linkedIssueNumber: 96,
    phase: "planning",
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", status: "approved" } },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });

  const packetWorktree = baseWorktree({
    id: "worktree:eladaviv/repo-one:issue:96:packet:t1",
    branchName: "agent/eladaviv-repo-one/workstream-issue-96/packet-t1",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/packet-t1",
    packet: {
      parentWorkstreamId: workstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-96"
    },
    status: "awaiting_plan_approval"
  });

  const previousImplementTask = {
    id: `task:implement_plan:worktree:${packetWorktree.id}`,
    kind: "implement_plan",
    status: "pending",
    executionPermission: "workspace-write",
    handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
    repoId: repo.id,
    repoName: repo.name,
    repoSlug: `${repo.owner}/${repo.name}`,
    sourceKind: "pull_request",
    sourceId: "pull_request:eladaviv/repo-one:100",
    sourceUrl: "https://github.com/eladaviv/repo-one/pull/100",
    relevant: true,
    reason: "previously approved",
    summary: "Implement packet",
    workstreamId: workstream.id,
    context: {
      repoIdentifier: `${repo.owner}/${repo.name}`,
      localRepoPath: packetWorktree.path,
      branchName: packetWorktree.branchName,
      instruction: "Implement packet."
    },
    createdAt: now,
    updatedAt: now
  } as const;

  const packetPrWithoutApproval = basePullRequest({
    id: "pull_request:eladaviv/repo-one:100",
    number: 100,
    key: "eladaviv/repo-one:pull_request:100",
    sourceId: "PR_100",
    headBranch: packetWorktree.branchName,
    labels: []
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: [previousImplementTask as any] },
    currentIssues: [issue],
    currentPullRequests: [packetPrWithoutApproval],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now: "2026-04-18T10:05:00.000Z"
  });

  assert.equal(
    tasks.some((task) => task.id === previousImplementTask.id),
    false
  );
});

test("DefaultContextBuilder.build for implement_plan with issue sourceKind", () => {
  const builder = new DefaultContextBuilder();
  const context = builder.build({
    taskKind: "implement_plan",
    repoIdentifier: "owner/repo",
    sourceKind: "issue",
    sourceUrl: "https://github.com/owner/repo/issues/1",
    labels: [],
    localRepoPath: "/tmp/repo",
    branchName: "feature",
    planDocumentPath: "docs/plan.md",
    logDocumentPath: "docs/log.md",
  });

  assert.equal(context.issueUrl, "https://github.com/owner/repo/issues/1", "Should have issueUrl");
  assert.equal(context.pullRequestUrl, undefined, "Should NOT have pullRequestUrl when source is an issue");
});

test("DefaultContextBuilder.build for implement_plan with packet PR (sourceKind pull_request, but has issue context)", () => {
  const builder = new DefaultContextBuilder();
  const context = builder.build({
    taskKind: "implement_plan",
    repoIdentifier: "owner/repo",
    sourceKind: "pull_request",
    sourceUrl: "https://github.com/owner/repo/pull/100",
    parentUrl: "https://github.com/owner/repo/issues/1",
    labels: [],
    localRepoPath: "/tmp/repo",
    branchName: "feature",
    planDocumentPath: "docs/plan.md",
    logDocumentPath: "docs/log.md",
    issueTitle: "Original Issue",
    issueBody: "Original Body"
  });

  assert.equal(context.pullRequestUrl, "https://github.com/owner/repo/pull/100", "Should have pullRequestUrl (packet PR)");
  assert.equal(context.issueUrl, "https://github.com/owner/repo/issues/1", "Should have issueUrl (parent issue)");
  assert.equal(context.issueTitle, "Original Issue", "Should have issueTitle");
  assert.equal(context.issueBody, "Original Body", "Should have issueBody");
  assert.doesNotMatch(context.instruction, /Product Spec is the product source of truth/);
  assert.doesNotMatch(context.instruction, /the assigned planning document/);
});

test("DefaultContextBuilder.build includes Product Spec guidance only when a spec path is present", () => {
  const builder = new DefaultContextBuilder();
  const context = builder.build({
    taskKind: "write_plan",
    repoIdentifier: "owner/repo",
    sourceKind: "pull_request",
    sourceUrl: "https://github.com/owner/repo/pull/100",
    labels: [],
    localRepoPath: "/tmp/repo",
    planDocumentPath: "/tmp/repo/docs/plan.md",
    productSpecDocumentPath: "/tmp/repo/docs/product-spec.md",
    logDocumentPath: "/tmp/repo/docs/log.md"
  });

  assert.match(context.instruction, /Product Spec is the product source of truth/);
  assert.match(context.instruction, /docs\/product-spec\.md/);
});



test("deriveTasks handles sync_parent_branch_preflight derivation", () => {
  const now = "2026-05-11T14:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 110 });
  const packetPlan = {
    status: "approved",
    packets: {
      "T1": { id: "T1", status: "merged_to_parent" },
      "T2": { id: "T2", status: "planned" }
    },
    waves: [["T1"], ["T2"]],
    currentWaveIndex: 0
  };

  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:110",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 110 },
    linkedIssueNumber: 110,
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-110",
      prNumber: 111
    },
    packetPlan: packetPlan as any
  });

  const attention = baseAttention({
    workstreamId: workstream.id,
    reasons: ["packet_wave_complete_sync_needed"]
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const task = tasks.find(t => t.kind === "sync_parent_branch_preflight");
  assert.ok(task, "Should have derived a sync_parent_branch_preflight task");
  assert.equal(task.id, `task:sync_parent_branch_preflight:${workstream.id}`);
  assert.equal(task.sourceKind, "issue");
  assert.equal(task.sourceId, issue.id);
  assert.equal(task.executionPermission, "read-only");
  assert.equal(task.handoffPolicy.expectsPushableHandoff, false);

  assert.match(task.summary, /#110/);
  assert.match(task.summary, /wave 1/);
  assert.match(task.reason, /wave 0 is complete/);
  assert.match(task.reason, /Parent integration branch: agent\/eladaviv-repo-one\/issue-110/);
  assert.match(task.reason, /Default branch: main/);
  assert.match(task.reason, /Next wave index: 1/);
  assert.match(task.reason, /Completed packet IDs: T1/);
  assert.match(task.reason, /Pending future packet IDs: T2/);
  assert.match(task.reason, /Parent PR: #111/);

  assert.ok(task.context.preflight, "Task context should have preflight data");
  assert.equal(task.context.preflight.currentWaveIndex, 0);
  assert.equal(task.context.preflight.nextWaveIndex, 1);
  assert.equal(task.context.preflight.parentIntegrationBranch, "agent/eladaviv-repo-one/issue-110");
  assert.equal(task.context.preflight.defaultBranch, "main");
  assert.deepEqual(task.context.preflight.completedPacketIds, ["T1"]);
  assert.deepEqual(task.context.preflight.pendingFuturePacketIds, ["T2"]);
  assert.equal(task.context.preflight.parentPrNumber, 111);

  assert.equal(task.context.issueUrl, issue.url);
  assert.equal(task.context.localRepoPath, repoSync.localPath);
  assert.match(task.context.instruction, /Do not modify files or run git sync commands/);

  // Negative case: missing attention reason
  const noAttentionTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [baseAttention({ workstreamId: workstream.id, reasons: [] })],
    contextBuilder: builder,
    now
  });
  assert.ok(!noAttentionTasks.find(t => t.kind === "sync_parent_branch_preflight"));

  // Negative case: PR-origin workstream
  const prWorkstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:pr:22",
    origin: { type: "pr", number: 22 },
    packetPlan: packetPlan as any
  });
  const prTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [basePullRequest({ number: 22 })],
    currentComments: [],
    workstreams: [prWorkstream],
    attention: [baseAttention({ workstreamId: prWorkstream.id, reasons: ["packet_wave_complete_sync_needed"] })],
    contextBuilder: builder,
    now
  });
  assert.ok(!prTasks.find(t => t.kind === "sync_parent_branch_preflight"));
});

test("shouldCarryForwardUnresolvedTask for sync_parent_branch_preflight", () => {
  const now = "2026-05-11T14:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 110 });
  const packetPlan = {
    status: "approved",
    packets: {
      "T1": { id: "T1", status: "merged_to_parent" },
      "T2": { id: "T2", status: "planned" }
    },
    waves: [["T1"], ["T2"]],
    currentWaveIndex: 0
  };

  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:110",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 110 },
    linkedIssueNumber: 110,
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-110",
      prNumber: 111
    },
    packetPlan: packetPlan as any
  });

  const attention = baseAttention({
    workstreamId: workstream.id,
    reasons: ["packet_wave_complete_sync_needed"]
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const task = tasks.find(t => t.kind === "sync_parent_branch_preflight")!;
  assert.ok(task);

  const input = {
    repoConfigs: new Map([[repo.id, repo]]),
    repoSyncRecords: new Map([[repo.id, repoSync]]),
    currentIssuesById: new Map([[issue.id, issue]]),
    currentPullRequestsById: new Map(),
    attentionByWorkstreamId: new Map([[workstream.id, attention]]),
    workstreamsById: new Map([[workstream.id, workstream]]),
  };

  // 1. Should carry forward if everything is same
  // @ts-ignore - access internal function for testing if exported, but here we test via deriveTasks carry forward
  // Actually, we can just call deriveTasks again with previousState containing the task.
  const prevState = {
    ...emptyState(),
    issues: [issue],
    workstreams: [workstream],
    attention: [attention],
    tasks: [task]
  };

  const carriedTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  assert.equal(carriedTasks.length, 1);
  assert.equal(carriedTasks[0]?.id, task.id);

  // 2. Should NOT carry forward if attention reason is gone
  const noAttention = baseAttention({ workstreamId: workstream.id, reasons: [] });
  const notCarriedDueToAttention = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [noAttention],
    contextBuilder: builder,
    now
  });
  assert.equal(notCarriedDueToAttention.length, 0, "Task should not be carried forward if attention reason is missing");

  // 3. Should NOT carry forward if preflight would change (e.g. wave changed)
  const nextWavePacketPlan = { ...packetPlan, currentWaveIndex: 1 };
  const nextWaveWorkstream = { ...workstream, packetPlan: nextWavePacketPlan };
  const nextWaveAttention = baseAttention({ workstreamId: workstream.id, reasons: ["packet_wave_complete_sync_needed"] });

  const notCarriedDueToChange = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [nextWaveWorkstream as any],
    attention: [nextWaveAttention],
    contextBuilder: builder,
    now
  });
  // It might derive a NEW task, but it should NOT carry forward the OLD one.
  // In deriveTasks, if shouldCarryForward returns false, the old task is dropped.
  // A new one might be created if conditions match.
  const carriedOldTask = notCarriedDueToChange.find(t => t.id === task.id);
  assert.ok(!carriedOldTask, "Old task should not be carried forward if preflight changed");

  // 4. Should NOT carry forward if preflight becomes invalid (e.g. no integration branch)
  const invalidWorkstream = { ...workstream, integration: undefined };
  const notCarriedDueToInvalid = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [invalidWorkstream as any],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  assert.equal(notCarriedDueToInvalid.length, 0, "Task should not be carried forward if preflight becomes invalid");
});

test("sync_parent_branch_preflight equivalent pending task is stable across repeated derivation", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const issue = baseIssue();
  const workstream = baseSyncPreflightWorkstream();
  const attention = baseSyncPreflightAttention();

  const firstNow = "2026-04-18T10:00:00.000Z";
  const firstTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now: firstNow
  });

  const firstTask = firstTasks.find(t => t.kind === "sync_parent_branch_preflight");
  assert.ok(firstTask);
  assert.equal(firstTask.status, "pending");

  const secondNow = "2026-04-18T10:05:00.000Z";
  const secondTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: [firstTask] },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now: secondNow
  });

  const secondTask = secondTasks.find(t => t.kind === "sync_parent_branch_preflight");
  assert.ok(secondTask);
  assert.equal(secondTasks.length, 1);
  assert.equal(secondTask.id, firstTask.id);
  assert.equal(secondTask.createdAt, firstTask.createdAt);
  assert.equal(secondTask.status, "pending");
});

test("sync_parent_branch_preflight equivalent completed task remains completed", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const issue = baseIssue();
  const workstream = baseSyncPreflightWorkstream();
  const attention = baseSyncPreflightAttention();

  const now = "2026-04-18T10:00:00.000Z";
  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const task = tasks.find(t => t.kind === "sync_parent_branch_preflight")!;
  assert.ok(task);

  // Mark as completed
  task.status = "completed";
  task.lastExecutionId = "exec:previous";

  const secondTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: [task] },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const secondTask = secondTasks.find(t => t.kind === "sync_parent_branch_preflight");
  assert.ok(secondTask);
  assert.equal(secondTasks.length, 1);
  assert.equal(secondTask.id, task.id);
  assert.equal(secondTask.status, "completed");
  assert.equal(secondTask.lastExecutionId, "exec:previous");
});

test("sync_parent_branch_preflight meaningful preflight change reopens the completed task", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const issue = baseIssue();
  const workstream = baseSyncPreflightWorkstream({ integration: { branchName: "agent/eladaviv-repo-one/issue-11", prNumber: 31 } });
  const attention = baseSyncPreflightAttention();

  const now = "2026-04-18T10:00:00.000Z";
  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const task = tasks.find(t => t.kind === "sync_parent_branch_preflight")!;
  assert.ok(task);
  task.status = "completed";
  task.lastExecutionId = "exec:previous";

  // Change PR number
  const updatedWorkstream = {
    ...workstream,
    integration: { ...workstream.integration!, prNumber: 32 }
  };

  const secondTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: [task] },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [updatedWorkstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const secondTask = secondTasks.find(t => t.kind === "sync_parent_branch_preflight");
  assert.ok(secondTask);
  assert.equal(secondTasks.length, 1);
  assert.equal(secondTask.id, task.id);
  assert.equal(secondTask.status, "pending", "Task should reopen when preflight changes");
  assert.equal(secondTask.context.preflight?.parentPrNumber, 32);
  assert.match(secondTask.reason ?? "", /Parent PR: #32/);
});

test("sync_parent_branch_preflight task disappears when sync is no longer needed", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const issue = baseIssue();
  const workstream = baseSyncPreflightWorkstream();
  const attention = baseSyncPreflightAttention();

  const now = "2026-04-18T10:00:00.000Z";
  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const task = tasks.find(t => t.kind === "sync_parent_branch_preflight")!;
  assert.ok(task);

  // Remove attention reason
  const noAttention = baseAttention({ workstreamId: workstream.id, reasons: [] });

  const secondTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: [task] },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [noAttention],
    contextBuilder: builder,
    now
  });

  assert.ok(!secondTasks.find(t => t.kind === "sync_parent_branch_preflight"), "Task should disappear when attention is gone");
});

test("sync_parent_branch_preflight missing default branch does not derive or carry forward", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const issue = baseIssue();
  const workstream = baseSyncPreflightWorkstream();
  const attention = baseSyncPreflightAttention();

  const now = "2026-04-18T10:00:00.000Z";

  // Previous valid task
  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  const task = tasks.find(t => t.kind === "sync_parent_branch_preflight")!;
  assert.ok(task);

  // Repo sync missing default branch
  const noDefaultBranchRepoSync = { ...repoSync, defaultBranch: undefined };

  const noDefaultTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [noDefaultBranchRepoSync as any],
    previousState: { ...emptyState(), tasks: [task] },
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  assert.ok(!noDefaultTasks.find(t => t.kind === "sync_parent_branch_preflight"), "Task should not derive or carry forward when default branch is missing");
});
test("deriveTasks derives respond_pr_comment for a human packet PR comment", () => {
  const now = "2026-05-15T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue();
  const parentWorkstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:11",
    repoKey: "eladaviv/repo-one",
    linkedIssueNumber: issue.number,
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-11",
      prNumber: 100
    },
    packetPlan: {
      status: "approved",
      packets: {
        T1: {
          id: "T1",
          title: "Packet one",
          summary: "Packet summary",
          status: "pr_open",
          branchName: "agent/eladaviv-repo-one/issue-11-packet-t1",
          prNumber: 101,
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: []
        }
      },
      waves: [["T1"]]
    } as any
  });

  const packetPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:101",
    number: 101,
    headBranch: "agent/eladaviv-repo-one/issue-11-packet-t1",
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent",
    url: "https://github.com/eladaviv/repo-one/pull/101"
  });

  const packetWorktree = baseWorktree({
    id: "worktree:packet:T1",
    branchName: packetPr.headBranch,
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11-packet-t1",
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11-packet-t1/docs/agents/packet-t1/issue-11-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11-packet-t1/docs/agents/packet-t1/issue-11-agent-log.md",
    packet: {
      parentWorkstreamId: parentWorkstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-11"
    }
  });

  const comment = basePrComment({
    id: "comment:eladaviv/repo-one:pull_request_comment:9001",
    parentNumber: 101,
    url: "https://github.com/eladaviv/repo-one/pull/101#discussion_r9001",
    pullRequestReviewLocation: {
      path: "src/example.ts",
      line: 42,
      side: "RIGHT"
    }
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [packetPr]
    },
    currentIssues: [issue],
    currentPullRequests: [packetPr],
    currentComments: [comment],
    worktrees: [packetWorktree],
    workstreams: [parentWorkstream],
    contextBuilder: builder,
    now
  });

  const task = tasks.find(t => t.kind === "respond_pr_comment");
  assert.ok(task, "Should have derived a respond_pr_comment task");
  assert.equal(task.parentSourceId, packetPr.id);
  assert.equal(task.context.pullRequestUrl, packetPr.url);
  assert.equal(task.context.localRepoPath, packetWorktree.path);
  assert.equal(task.context.branchName, packetWorktree.branchName);
  assert.equal(task.context.planDocumentPath, packetWorktree.planDocumentPath);
  assert.equal(task.context.logDocumentPath, packetWorktree.logDocumentPath);
  assert.equal(task.context.packetId, "T1");
  assert.deepEqual(task.context.pullRequestReviewLocation, {
    path: "src/example.ts",
    line: 42,
    side: "RIGHT"
  });
});

test("deriveTasks ignores agent-authored packet PR comments", () => {
  const now = "2026-05-15T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue();
  const parentWorkstream = baseIssueWorkstream({
    integration: { branchName: "main" },
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", prNumber: 101, status: "pr_open" } },
      waves: [["T1"]]
    } as any
  });

  const packetPr = basePullRequest({
    number: 101,
    baseBranch: "main",
    baseClassification: "non_default_parent"
  });

  const comment = basePrComment({
    parentNumber: 101,
    body: "🤖 I am a bot."
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      prs: [packetPr]
    },
    currentIssues: [issue],
    currentPullRequests: [packetPr],
    currentComments: [comment],
    workstreams: [parentWorkstream],
    contextBuilder: builder,
    now
  });

  assert.ok(!tasks.some(t => t.kind === "respond_pr_comment"));
});

test("deriveTasks derives respond_pr_comment for a human packet PR comment even if PR is not in previousState", () => {
  const now = "2026-05-15T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue();
  const parentWorkstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:11",
    repoKey: "eladaviv/repo-one",
    linkedIssueNumber: issue.number,
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-11",
      prNumber: 100
    },
    packetPlan: {
      status: "approved",
      packets: {
        T1: {
          id: "T1",
          prNumber: 101,
          status: "pr_open"
        }
      },
      waves: [["T1"]]
    } as any
  });

  const packetPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:101",
    number: 101,
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent"
  });

  const comment = basePrComment({
    parentNumber: 101
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      workstreams: [parentWorkstream]
      // packetPr is NOT in prs
    },
    currentIssues: [issue],
    currentPullRequests: [packetPr],
    currentComments: [comment],
    workstreams: [parentWorkstream],
    contextBuilder: builder,
    now
  });

  const task = tasks.find(t => t.kind === "respond_pr_comment");
  assert.ok(task, "Should have derived a respond_pr_comment task even if PR was not in previousState");
  assert.equal(task.parentSourceId, packetPr.id);
});

test("deriveTasks derives review_pr for packet PR with review label", () => {
  const now = "2026-05-15T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue();
  const parentWorkstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:11",
    repoKey: "eladaviv/repo-one",
    linkedIssueNumber: issue.number,
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-11",
      prNumber: 100
    },
    packetPlan: {
      status: "approved",
      packets: {
        T1: {
          id: "T1",
          title: "Packet one",
          summary: "Packet summary",
          status: "pr_open",
          branchName: "agent/eladaviv-repo-one/issue-11-packet-t1",
          prNumber: 101,
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: []
        }
      },
      waves: [["T1"]]
    } as any
  });

  const packetPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:101",
    number: 101,
    labels: [repo.labels.agentReview],
    headSha: "packet-head-a",
    headBranch: "agent/eladaviv-repo-one/issue-11-packet-t1",
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent",
    url: "https://github.com/eladaviv/repo-one/pull/101"
  });

  const packetWorktree = baseWorktree({
    id: "worktree:packet:T1",
    branchName: packetPr.headBranch,
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11-packet-t1",
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11-packet-t1/docs/agents/packet-t1/issue-11-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-11-packet-t1/docs/agents/packet-t1/issue-11-agent-log.md",
    packet: {
      parentWorkstreamId: parentWorkstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-11"
    }
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      issues: [issue],
      workstreams: [parentWorkstream],
      worktrees: [packetWorktree]
    },
    currentIssues: [issue],
    currentPullRequests: [packetPr],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [parentWorkstream],
    contextBuilder: builder,
    now
  });

  const reviewTask = tasks.find(t => t.kind === "review_pr" && t.sourceId === packetPr.id);
  assert.ok(reviewTask, "Should have derived a review_pr task for packet PR");
  assert.equal(reviewTask.sourceId, packetPr.id);
  assert.equal(reviewTask.sourceUrl, packetPr.url);
  assert.equal(reviewTask.context.localRepoPath, packetWorktree.path);
  assert.equal(reviewTask.context.branchName, packetWorktree.branchName);
  assert.equal(reviewTask.context.planDocumentPath, packetWorktree.planDocumentPath);
  assert.equal(reviewTask.context.logDocumentPath, packetWorktree.logDocumentPath);
});

test("deriveTasks does not let parent PR review suppress packet PR review", () => {
  const now = "2026-05-15T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const parentPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:100",
    number: 100,
    labels: [repo.labels.agentReview],
    headSha: "parent-head-a",
    headBranch: "agent/eladaviv-repo-one/issue-11"
  });

  const parentWorkstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:11",
    repoKey: "eladaviv/repo-one",
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-11",
      prNumber: 100
    },
    linkedPrs: [{ number: 100, role: "integration", status: "open" }],
    activePrNumber: 100,
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", prNumber: 101, status: "pr_open" } },
      waves: [["T1"]]
    } as any
  });

  const packetPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:101",
    number: 101,
    labels: [repo.labels.agentReview],
    headSha: "packet-head-a",
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent"
  });

  const completedParentReviewTask: any = {
    id: "task:review_pr:pull_request:eladaviv/repo-one:100",
    kind: "review_pr",
    status: "completed",
    sourceId: parentPr.id,
    updatedAt: now,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one"
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [parentPr],
      tasks: [completedParentReviewTask],
      workstreams: [parentWorkstream]
    },
    currentIssues: [],
    currentPullRequests: [parentPr, packetPr],
    currentComments: [],
    workstreams: [parentWorkstream],
    contextBuilder: builder,
    now
  });

  const packetReviewTask = tasks.find(t => t.kind === "review_pr" && t.sourceId === packetPr.id);
  assert.ok(packetReviewTask, "Should have derived a review_pr task for packet PR even if parent PR review is completed");
  assert.equal(packetReviewTask.status, "pending");
});

test("deriveTasks does not duplicate packet review when packet head is unchanged", () => {
  const now = "2026-05-15T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const parentWorkstream = baseIssueWorkstream({
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-11",
      prNumber: 100
    },
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", prNumber: 101, status: "pr_open" } },
      waves: [["T1"]]
    } as any
  });

  const packetPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:101",
    number: 101,
    labels: [repo.labels.agentReview],
    headSha: "packet-head-a",
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent"
  });

  const completedPacketReviewTask: any = {
    id: "task:review_pr:pull_request:eladaviv/repo-one:101",
    kind: "review_pr",
    status: "completed",
    sourceId: packetPr.id,
    updatedAt: now,
    reason: `Packet pull request has the "agent-review" label and code changed (head: packet-head-a).`,
    summary: `Review packet PR #101: Add orchestrator tasks`,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    context: builder.build({
      taskKind: "review_pr",
      repoIdentifier: "eladaviv/repo-one",
      sourceKind: "pull_request",
      sourceUrl: packetPr.url,
      labels: [repo.labels.agentReview],
      localRepoPath: repoSync.localPath
    })
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [packetPr],
      tasks: [completedPacketReviewTask],
      workstreams: [parentWorkstream]
    },
    currentIssues: [],
    currentPullRequests: [packetPr],
    currentComments: [],
    workstreams: [parentWorkstream],
    contextBuilder: builder,
    now
  });

  const reviewTask = tasks.find(t => t.kind === "review_pr" && t.sourceId === packetPr.id);
  assert.equal(reviewTask?.status, "completed", "Review task should remain completed if head SHA is unchanged");
});

test("deriveTasks re-derives packet review when packet head changes", () => {
  const now = "2026-05-15T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const parentWorkstream = baseIssueWorkstream({
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-11",
      prNumber: 100
    },
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", prNumber: 101, status: "pr_open" } },
      waves: [["T1"]]
    } as any
  });

  const previousPacketPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:101",
    number: 101,
    labels: [repo.labels.agentReview],
    headSha: "packet-head-a",
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent"
  });

  const currentPacketPr = { ...previousPacketPr, headSha: "packet-head-b" };

  const completedPacketReviewTask: any = {
    id: "task:review_pr:pull_request:eladaviv/repo-one:101",
    kind: "review_pr",
    status: "completed",
    sourceId: currentPacketPr.id,
    updatedAt: "2026-05-15T09:00:00.000Z",
    reason: `Packet pull request has the "agent-review" label and code changed (head: packet-head-a).`,
    summary: `Review packet PR #101: Add orchestrator tasks`,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    context: builder.build({
      taskKind: "review_pr",
      repoIdentifier: "eladaviv/repo-one",
      sourceKind: "pull_request",
      sourceUrl: currentPacketPr.url,
      labels: [repo.labels.agentReview],
      localRepoPath: repoSync.localPath
    })
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [previousPacketPr],
      tasks: [completedPacketReviewTask],
      workstreams: [parentWorkstream]
    },
    currentIssues: [],
    currentPullRequests: [currentPacketPr],
    currentComments: [],
    workstreams: [parentWorkstream],
    contextBuilder: builder,
    now
  });

  const reviewTask = tasks.find(t => t.kind === "review_pr" && t.sourceId === currentPacketPr.id);
  assert.ok(reviewTask, "Should have derived a review_pr task");
  assert.equal(reviewTask.status, "pending", "Review task should be pending because head SHA changed");
  assert.match(reviewTask.reason, /head: packet-head-b/);
});

test("deriveTasks keeps sibling packet review state isolated", () => {
  const now = "2026-05-15T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const parentWorkstream = baseIssueWorkstream({
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-11",
      prNumber: 100
    },
    packetPlan: {
      status: "approved",
      packets: {
        T1: { id: "T1", prNumber: 101, status: "pr_open" },
        T2: { id: "T2", prNumber: 102, status: "pr_open" }
      },
      waves: [["T1", "T2"]]
    } as any
  });

  const t1Pr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:101",
    number: 101,
    labels: [repo.labels.agentReview],
    headSha: "t1-head-a",
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent"
  });

  const t2Pr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:102",
    number: 102,
    labels: [repo.labels.agentReview],
    headSha: "t2-head-a",
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent"
  });

  const completedT1ReviewTask: any = {
    id: "task:review_pr:pull_request:eladaviv/repo-one:101",
    kind: "review_pr",
    status: "completed",
    sourceId: t1Pr.id,
    updatedAt: now,
    reason: `Packet pull request has the "agent-review" label and code changed (head: t1-head-a).`,
    summary: `Review packet PR #101: Add orchestrator tasks`,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    context: builder.build({
      taskKind: "review_pr",
      repoIdentifier: "eladaviv/repo-one",
      sourceKind: "pull_request",
      sourceUrl: t1Pr.url,
      labels: [repo.labels.agentReview],
      localRepoPath: repoSync.localPath
    })
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: {
      ...emptyState(),
      prs: [t1Pr, t2Pr],
      tasks: [completedT1ReviewTask],
      workstreams: [parentWorkstream]
    },
    currentIssues: [],
    currentPullRequests: [t1Pr, t2Pr],
    currentComments: [],
    workstreams: [parentWorkstream],
    contextBuilder: builder,
    now
  });

  const t1ReviewTask = tasks.find(t => t.kind === "review_pr" && t.sourceId === t1Pr.id);
  const t2ReviewTask = tasks.find(t => t.kind === "review_pr" && t.sourceId === t2Pr.id);

  assert.equal(t1ReviewTask?.status, "completed", "T1 review should remain completed");
  assert.ok(t2ReviewTask, "Should have derived a review_pr task for T2");
  assert.equal(t2ReviewTask.status, "pending", "T2 review should be pending");
});

test("deriveTasks handles sync_parent_branch derivation", () => {
  const now = "2026-05-11T14:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 110 });
  const parentPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:111",
    number: 111,
    labels: [repo.labels.agentSyncParentBranch],
    url: "https://github.com/eladaviv/repo-one/pull/111"
  });

  const workstream = baseSyncPreflightWorkstream({
    id: "eladaviv/repo-one:issue:110",
    origin: { type: "issue", number: 110 },
    linkedIssueNumber: 110,
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-110",
      prNumber: 111
    }
  });

  const attention = baseSyncPreflightAttention({
    workstreamId: workstream.id
  });
  const continueAssessment = baseWaveAssessmentExecution("continue", {
    workstreamId: workstream.id,
    parentPrNumber: 111,
    parentIntegrationBranch: "agent/eladaviv-repo-one/issue-110"
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), executions: [continueAssessment] },
    currentIssues: [issue],
    currentPullRequests: [parentPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const task = tasks.find(t => t.kind === "sync_parent_branch");
  assert.ok(task, "Should have derived a sync_parent_branch task");
  assert.equal(task.id, `task:sync_parent_branch:${parentPr.id}`);
  assert.equal(task.sourceKind, "pull_request");
  assert.equal(task.sourceId, parentPr.id);
  assert.equal(task.executionPermission, "workspace-write");
  assert.equal(task.handoffPolicy.expectsPushableHandoff, true);
  assert.equal(task.handoffPolicy.orchestratorOwnsPush, true);

  assert.match(task.summary, /#110/);
  assert.match(task.summary, /wave 1/);
  assert.match(task.reason, /Explicit sync requested via label/);
  assert.match(task.reason, /#111/);
  assert.match(task.reason, /Parent integration branch: agent\/eladaviv-repo-one\/issue-110/);

  assert.ok(task.context.preflight, "Task context should have preflight data");
  assert.equal(task.context.preflight.parentPrNumber, 111);
  assert.equal(task.context.pullRequestUrl, parentPr.url);

  // Preflight task should still be derived independently
  assert.ok(tasks.find(t => t.kind === "sync_parent_branch_preflight"));

  // Negative case: missing label on parent PR
  const noLabelPr = { ...parentPr, labels: [] };
  const noLabelTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), executions: [continueAssessment] },
    currentIssues: [issue],
    currentPullRequests: [noLabelPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  assert.ok(!noLabelTasks.find(t => t.kind === "sync_parent_branch"));
  assert.ok(noLabelTasks.find(t => t.kind === "sync_parent_branch_preflight"), "Preflight should still derive without label");

  // Negative case: parent PR is closed
  const closedPr = { ...parentPr, state: "closed" as const };
  const closedTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [closedPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  assert.ok(!closedTasks.find(t => t.kind === "sync_parent_branch"));

  // Negative case: parent PR is missing from currentPullRequests
  const missingPrTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  assert.ok(!missingPrTasks.find(t => t.kind === "sync_parent_branch"));

  // Negative case: missing attention reason
  const noAttentionTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [parentPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [baseAttention({ workstreamId: workstream.id, reasons: [] })],
    contextBuilder: builder,
    now
  });
  assert.ok(!noAttentionTasks.find(t => t.kind === "sync_parent_branch"));
});

test("shouldCarryForwardUnresolvedTask for sync_parent_branch", () => {
  const now = "2026-05-11T14:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const issue = baseIssue({ number: 110 });
  const parentPr = basePullRequest({
    id: "pull_request:eladaviv/repo-one:111",
    number: 111,
    labels: [repo.labels.agentSyncParentBranch]
  });

  const workstream = baseSyncPreflightWorkstream({
    id: "eladaviv/repo-one:issue:110",
    origin: { type: "issue", number: 110 },
    linkedIssueNumber: 110,
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-110",
      prNumber: 111
    }
  });

  const attention = baseSyncPreflightAttention({
    workstreamId: workstream.id
  });
  const continueAssessment = baseWaveAssessmentExecution("continue", {
    workstreamId: workstream.id,
    parentPrNumber: 111,
    parentIntegrationBranch: "agent/eladaviv-repo-one/issue-110"
  });

  const firstTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), executions: [continueAssessment] },
    currentIssues: [issue],
    currentPullRequests: [parentPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });

  const task = firstTasks.find(t => t.kind === "sync_parent_branch")!;
  assert.ok(task);

  const prevState = {
    ...emptyState(),
    issues: [issue],
    prs: [parentPr],
    executions: [continueAssessment],
    workstreams: [workstream],
    attention: [attention],
    tasks: [task]
  };

  // 1. Should carry forward if everything is same
  const carriedTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [issue],
    currentPullRequests: [parentPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  assert.ok(carriedTasks.find(t => t.id === task.id));

  // 2. Should NOT carry forward if label is removed
  const noLabelPr = { ...parentPr, labels: [] };
  const notCarriedDueToLabel = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [issue],
    currentPullRequests: [noLabelPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  assert.ok(!notCarriedDueToLabel.find(t => t.id === task.id));

  // 3. Should NOT carry forward if PR is closed
  const closedPr = { ...parentPr, state: "closed" as const };
  const notCarriedDueToClosed = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [issue],
    currentPullRequests: [closedPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  assert.ok(!notCarriedDueToClosed.find(t => t.id === task.id));

  // 4. Should NOT carry forward if attention reason is gone
  const noAttention = baseAttention({ workstreamId: workstream.id, reasons: [] });
  const notCarriedDueToAttention = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [issue],
    currentPullRequests: [parentPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [noAttention],
    contextBuilder: builder,
    now
  });
  assert.ok(!notCarriedDueToAttention.find(t => t.id === task.id));

  // 5. Should NOT carry forward if issue is closed
  const closedIssue = { ...issue, state: "closed" as const };
  const notCarriedDueToClosedIssue = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [closedIssue],
    currentPullRequests: [parentPr],
    currentComments: [],
    workstreams: [workstream],
    attention: [attention],
    contextBuilder: builder,
    now
  });
  assert.ok(!notCarriedDueToClosedIssue.find(t => t.id === task.id));
});

test("deriveTasks derives prepare_pr_for_merge task when label is present on open PR with matching worktree", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const now = "2026-04-18T10:00:00.000Z";

  const pr = basePullRequest({
    labels: ["prepare-for-merge"],
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    headBranch: "feature/tasks"
  });

  const worktree = baseWorktree({
    repoId: repo.id,
    branchName: "feature/tasks",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/pr-21"
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    contextBuilder: builder,
    now
  });

  const mergeTask = tasks.find((t) => t.kind === "prepare_pr_for_merge");
  assert.ok(mergeTask, "Should have derived a prepare_pr_for_merge task");
  assert.equal(mergeTask.executionPermission, "workspace-write");
  assert.equal(mergeTask.handoffPolicy.expectsPushableHandoff, true);
  assert.equal(mergeTask.context.localRepoPath, worktree.path);
  assert.equal(mergeTask.context.branchName, worktree.branchName);
  assert.equal(mergeTask.context.prepareForMerge?.baseBranch, "main");
  assert.equal(mergeTask.context.prepareForMerge?.headBranch, "feature/tasks");
  assert.equal(mergeTask.context.prepareForMerge?.prNumber, 21);
});

test("deriveTasks derives prepare_pr_for_merge task with non-default base branch", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const now = "2026-04-18T10:00:00.000Z";

  const pr = basePullRequest({
    labels: ["prepare-for-merge"],
    baseBranch: "integration/wave-3",
    defaultBranch: "main",
    baseClassification: "non_default_parent",
    headBranch: "feature/tasks"
  });

  const worktree = baseWorktree({
    branchName: "feature/tasks"
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    contextBuilder: builder,
    now
  });

  const mergeTask = tasks.find((t) => t.kind === "prepare_pr_for_merge");
  assert.ok(mergeTask);
  assert.equal(mergeTask.context.prepareForMerge?.baseBranch, "integration/wave-3");
});

test("deriveTasks does not derive prepare_pr_for_merge task when label is absent", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const now = "2026-04-18T10:00:00.000Z";

  const pr = basePullRequest({ labels: [] });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    contextBuilder: builder,
    now
  });

  assert.ok(!tasks.some((t) => t.kind === "prepare_pr_for_merge"));
});

test("deriveTasks does not derive prepare_pr_for_merge task when PR is closed", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const now = "2026-04-18T10:00:00.000Z";

  const pr = basePullRequest({ labels: ["prepare-for-merge"], state: "closed" });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    contextBuilder: builder,
    now
  });

  assert.ok(!tasks.some((t) => t.kind === "prepare_pr_for_merge"));
});

test("shouldCarryForwardUnresolvedTask for prepare_pr_for_merge", () => {
  const now = "2026-05-11T14:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  const pr = basePullRequest({
    labels: ["prepare-for-merge"],
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    headBranch: "feature/tasks"
  });

  const worktree = baseWorktree({ branchName: "feature/tasks" });

  const firstTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    contextBuilder: builder,
    now
  });

  const task = firstTasks.find((t) => t.kind === "prepare_pr_for_merge")!;
  assert.ok(task);

  const prevState = {
    ...emptyState(),
    prs: [pr],
    tasks: [task]
  };

  // 1. Should carry forward if everything is same
  const carriedTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [worktree],
    contextBuilder: builder,
    now
  });
  assert.ok(carriedTasks.find((t) => t.id === task.id));

  // 2. Should NOT carry forward if label is removed
  const noLabelPr = { ...pr, labels: [] };
  const notCarriedDueToLabel = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [],
    currentPullRequests: [noLabelPr],
    currentComments: [],
    worktrees: [worktree],
    attention: [],
    contextBuilder: builder,
    now
  });
  assert.ok(!notCarriedDueToLabel.find((t) => t.id === task.id));

  // 3. Should NOT carry forward if PR is closed
  const closedPr = { ...pr, state: "closed" as const };
  const notCarriedDueToClosed = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [],
    currentPullRequests: [closedPr],
    currentComments: [],
    worktrees: [worktree],
    attention: [],
    contextBuilder: builder,
    now
  });
  assert.ok(!notCarriedDueToClosed.find((t) => t.id === task.id));

  // 4. Should NOT carry forward if head SHA changes
  const newShaPr = { ...pr, headSha: "newsha123" };
  const notCarriedDueToSha = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [],
    currentPullRequests: [newShaPr],
    currentComments: [],
    worktrees: [worktree],
    attention: [],
    contextBuilder: builder,
    now
  });
  assert.ok(!notCarriedDueToSha.find((t) => t.id === task.id));

  // 5. Should NOT carry forward if base branch changes
  const newBasePr = { ...pr, baseBranch: "develop" };
  const notCarriedDueToBase = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [],
    currentPullRequests: [newBasePr],
    currentComments: [],
    worktrees: [worktree],
    attention: [],
    contextBuilder: builder,
    now
  });
  assert.ok(!notCarriedDueToBase.find((t) => t.id === task.id));

  // 6. Should carry forward even if worktree is missing (it will use a fresh clone)
  const carriedEvenIfMissingWorktree = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: prevState,
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [], // No worktrees
    contextBuilder: builder,
    now
  });
  const taskIfMissing = carriedEvenIfMissingWorktree.find((t) => t.id === task.id);
  assert.ok(taskIfMissing, "Should have carried forward the task even without a persistent worktree");
  assert.equal(taskIfMissing?.status, "pending");
});

test("deriveTasks derives prepare_pr_for_merge for packet PR projections", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const now = "2026-04-18T10:00:00.000Z";

  const issue = baseIssue();
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:11",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 11 },
    linkedIssueNumber: 11,
    phase: "implementing",
    integration: { branchName: "agent/eladaviv-repo-one/issue-11", prNumber: 31 },
    packetPlan: {
      status: "approved",
      packets: {
        "T1": { id: "T1", status: "planned" }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });

  const packetPr = basePullRequest({
    number: 100,
    labels: ["prepare-for-merge"],
    headBranch: "packet/T1",
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent"
  });

  const packetWorktree = baseWorktree({
    id: "worktree:T1",
    branchName: "packet/T1",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/packet-T1",
    packet: {
      parentWorkstreamId: workstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-11"
    }
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [packetPr],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const mergeTask = tasks.find((t) => t.kind === "prepare_pr_for_merge");
  assert.ok(mergeTask, "Should have derived a prepare_pr_for_merge task for the packet PR projection");
  assert.equal(mergeTask.sourceId, packetPr.id);
  assert.equal(mergeTask.context.localRepoPath, packetWorktree.path);
  assert.equal(mergeTask.context.packetId, "T1");
  assert.equal(mergeTask.context.prepareForMerge?.baseBranch, "agent/eladaviv-repo-one/issue-11");
  assert.match(mergeTask.summary, /packet/i);
  assert.match(mergeTask.reason, /packet: T1/);
});

test("deriveTasks derives prepare_pr_for_merge for packet PR projection even without matching worktree", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const now = "2026-04-18T10:00:00.000Z";

  const issue = baseIssue();
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:11",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 11 },
    linkedIssueNumber: 11,
    phase: "implementing",
    integration: { branchName: "agent/eladaviv-repo-one/issue-11", prNumber: 31 },
    packetPlan: {
      status: "approved",
      packets: {
        "T1": { id: "T1", status: "planned", prNumber: 100 }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });

  const packetPr = basePullRequest({
    number: 100,
    labels: ["prepare-for-merge"],
    headBranch: "packet/T1",
    baseBranch: "agent/eladaviv-repo-one/issue-11",
    baseClassification: "non_default_parent"
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [packetPr],
    currentComments: [],
    worktrees: [], // No matching worktree
    workstreams: [workstream],
    contextBuilder: builder,
    now
  });

  const mergeTask = tasks.find((t) => t.kind === "prepare_pr_for_merge");
  assert.ok(mergeTask, "Should have derived a prepare_pr_for_merge task even without matching worktree");
  assert.equal(mergeTask.context.packetId, "T1");
  assert.equal(mergeTask.status, "pending", "Task should be pending because it will use a fresh clone");
});

test("deriveTasks derives pending prepare_pr_for_merge for normal PR without matching worktree", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const now = "2026-04-18T10:00:00.000Z";

  const pr = basePullRequest({
    labels: ["prepare-for-merge"],
    headBranch: "feature/no-worktree"
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [], // No matching worktree
    contextBuilder: builder,
    now
  });

  const mergeTask = tasks.find((t) => t.kind === "prepare_pr_for_merge");
  assert.ok(mergeTask, "Should have derived a prepare_pr_for_merge task for the normal PR");
  assert.equal(mergeTask.context.packetId, undefined);
  assert.equal(mergeTask.status, "pending", "Task should be pending because it will use a fresh clone");
});

test("deriveTasks does not duplicate prepare_pr_for_merge when PR is seen as both normal and packet", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const now = "2026-04-18T10:00:00.000Z";

  const issue = baseIssue();
  const workstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:11",
    linkedIssueNumber: 11,
    activePrNumber: 100
  });

  const pr = basePullRequest({
    number: 100,
    labels: ["prepare-for-merge"],
    headBranch: "packet/T1",
    baseBranch: "main"
  });

  const packetWorktree = baseWorktree({
    id: "worktree:T1",
    branchName: "packet/T1",
    packet: {
      parentWorkstreamId: workstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "main"
    }
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [packetWorktree],
    workstreams: [workstream],
    attention: [baseAttention({ workstreamId: workstream.id, reasons: ["prepare_for_merge_requested"] })],
    contextBuilder: builder,
    now
  });

  const mergeTasks = tasks.filter((t) => t.kind === "prepare_pr_for_merge");
  assert.equal(mergeTasks.length, 1, "Should have exactly one prepare_pr_for_merge task");
});

test("prepare_pr_for_merge completed task is rerun when head SHA changes", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();
  const now = "2026-04-18T10:00:00.000Z";

  const pr1 = basePullRequest({
    labels: ["prepare-for-merge"],
    headSha: "sha-1"
  });

  const worktree = baseWorktree({
    branchName: pr1.headBranch
  });

  const firstState = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr1],
    currentComments: [],
    worktrees: [worktree],
    contextBuilder: builder,
    now
  });

  const task1 = firstState.find((t) => t.kind === "prepare_pr_for_merge")!;
  assert.equal(task1.status, "pending");

  // Complete the task
  task1.status = "completed";
  task1.lastExecutionId = "exec-1";

  // New SHA
  const pr2 = { ...pr1, headSha: "sha-2" };

  const secondState = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: { ...emptyState(), tasks: [task1] },
    currentIssues: [],
    currentPullRequests: [pr2],
    currentComments: [],
    worktrees: [worktree],
    contextBuilder: builder,
    now
  });

  const task2 = secondState.find((t) => t.kind === "prepare_pr_for_merge")!;
  assert.equal(task2.status, "pending", "Task should be reset to pending because headSha changed");
  assert.equal(task2.lastExecutionId, "exec-1", "Should preserve lastExecutionId for reference");
});

test("deriveTasks does not derive planning or implementation tasks for packet worktrees when parent workstream is inactive (abandoned/resolved) or packet PR is closed/merged", () => {
  const now = "2026-04-18T10:00:00.000Z";
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const builder = new DefaultContextBuilder();

  // Test 1: Parent workstream is abandoned
  const issue1 = baseIssue({ number: 97 });
  const abandonedWorkstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:97",
    origin: { type: "issue", number: 97 },
    linkedIssueNumber: 97,
    status: "open",
    phase: "abandoned",
    packetPlan: {
      status: "approved",
      packets: { T1: { id: "T1", status: "planned" } },
      waves: [["T1"]],
      currentWaveIndex: 0
    } as any
  });
  const planningWorktree1 = baseWorktree({
    id: "worktree:abandoned-parent",
    packet: { parentWorkstreamId: abandonedWorkstream.id, packetId: "T1", waveIndex: 0, parentIntegrationBranch: "main" },
    status: "planning"
  });

  // Test 2: Packet PR is closed
  const issue2 = baseIssue({ number: 98 });
  const activeWorkstream = baseIssueWorkstream({
    id: "eladaviv/repo-one:issue:98",
    origin: { type: "issue", number: 98 },
    linkedIssueNumber: 98,
    status: "open",
    phase: "implementing",
    packetPlan: {
      status: "approved",
      packets: { T2: { id: "T2", status: "pr_open", prNumber: 102 } },
      waves: [["T2"]],
      currentWaveIndex: 0
    } as any
  });
  const planningWorktree2 = baseWorktree({
    id: "worktree:closed-packet-pr-planning",
    packet: { parentWorkstreamId: activeWorkstream.id, packetId: "T2", waveIndex: 0, parentIntegrationBranch: "main" },
    status: "planning",
    prNumber: 102
  });
  const readyWorktree2 = baseWorktree({
    id: "worktree:closed-packet-pr-ready",
    packet: { parentWorkstreamId: activeWorkstream.id, packetId: "T2", waveIndex: 0, parentIntegrationBranch: "main" },
    status: "implementation_ready",
    prNumber: 102
  });
  const closedPacketPr = basePullRequest({
    number: 102,
    state: "closed",
    headBranch: planningWorktree2.branchName
  });

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [issue1, issue2],
    currentPullRequests: [closedPacketPr],
    currentComments: [],
    worktrees: [planningWorktree1, planningWorktree2, readyWorktree2],
    workstreams: [abandonedWorkstream, activeWorkstream],
    contextBuilder: builder,
    now
  });

  // No write_plan or implement_plan tasks should be derived for these worktrees
  const relevantTasks = tasks.filter(
    (t) =>
      t.kind === "write_plan" || t.kind === "implement_plan"
  );
  assert.equal(relevantTasks.length, 0, "No planning or implementation tasks should be derived for abandoned parent or closed packet PR");
});
