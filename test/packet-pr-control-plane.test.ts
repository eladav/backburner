import * as assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultContextBuilder } from "../src/context/types.js";
import type { RepoConfig } from "../src/config/types.js";
import type { NormalizedComment, NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import { deriveAttentionRecords } from "../src/attention/derive.js";
import { deriveTasks } from "../src/tasks/derive.js";
import { deriveWorkstreams } from "../src/workstreams/derive.js";
import { ImplementationWorkflowService } from "../src/worktrees/service.js";
import { collectPacketPullRequestProjections } from "../src/workstreams/packet-projections.js";
import type {
  AttentionRecord,
  PersistedState,
  RepoSyncRecord,
  WorkstreamRecord,
  WorktreeRecord,
  ExecutionRecord
} from "../src/state/types.js";
import type { GitGateway } from "../src/git/types.js";
import type { GitHubGateway } from "../src/github/types.js";

// --- Fixture Builders ---

function baseRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    id: "repo-1",
    owner: "eladaviv",
    name: "repo-one",
    defaultBranch: "main",
    localPath: "/tmp/code-root/repo-one",
    enabled: true,
    labels: {
      agentInProgress: "agent-in-progress",
      agentPlanApproved: "agent-plan-approved",
      agentProductApproved: "agent-product-approved",
      agentReview: "agent-review",
      planBreakdownNeeded: "plan-breakdown-needed",
      agentSyncParentBranch: "agent-sync-parent-branch",
      prepareForMerge: "prepare-for-merge"
    },
    ...overrides
  };
}

function baseRepoSync(overrides: Partial<RepoSyncRecord> = {}): RepoSyncRecord {
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
    defaultBranchSource: "config",
    currentBranchBefore: "main",
    currentBranchAfter: "main",
    syncedAt: "2026-04-18T10:00:00.000Z",
    message: "Synced",
    ...overrides
  };
}

function baseIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    kind: "issue",
    id: "issue:eladaviv/repo-one:17",
    repoId: "repo-1",
    repoKey: "repo-1",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number: 17,
    key: "issue:eladaviv/repo-one:17",
    sourceId: "issue-17-id",
    title: "Need a workflow",
    body: "Please figure out the next step.",
    state: "open",
    labels: [],
    author: "eladaviv",
    createdAt: "2026-04-18T09:00:00.000Z",
    updatedAt: "2026-04-18T09:00:00.000Z",
    url: "https://github.com/eladaviv/repo-one/issues/17",
    ...overrides
  };
}

function basePullRequest(overrides: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  const number = overrides.number ?? 100;
  return {
    kind: "pull_request",
    id: `pull_request:eladaviv/repo-one:${number}`,
    repoId: "repo-1",
    repoKey: "repo-1",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number,
    key: `pull_request:eladaviv/repo-one:${number}`,
    sourceId: `pr-${number}-id`,
    title: "Implement workflow",
    body: "Working on it.",
    state: "open",
    labels: [],
    author: "eladaviv",
    createdAt: "2026-04-18T09:30:00.000Z",
    updatedAt: "2026-04-18T09:30:00.000Z",
    url: `https://github.com/eladaviv/repo-one/pull/${number}`,
    headSha: "head-1",
    headBranch: "agent/eladaviv-repo-one/issue-17",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false,
    ...overrides
  };
}

function basePrComment(overrides: Partial<NormalizedComment> = {}): NormalizedComment {
  const prNumber = overrides.parentNumber ?? 101;
  return {
    kind: "comment",
    commentKind: "pull_request_comment",
    id: `pull_request_comment:eladaviv/repo-one:${prNumber}:1`,
    sourceId: `comment-1-id`,
    repoId: "repo-1",
    repoKey: "repo-1",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    parentType: "pull_request",
    parentNumber: prNumber,
    parentKey: `pull_request:eladaviv/repo-one:${prNumber}`,
    body: "Looks good!",
    author: "human",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z",
    url: `https://github.com/eladaviv/repo-one/pull/${prNumber}#issuecomment-1`,
    ...overrides
  };
}

function baseWorktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  const now = "2026-04-18T10:00:00.000Z";
  return {
    id: "worktree:eladaviv/repo-one:issue:17",
    repoId: "repo-1",
    repoSlug: "eladaviv/repo-one",
    repoName: "repo-one",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-parent",
    branchName: "agent/eladaviv-repo-one/issue-17",
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-parent/docs/agents/issue-17/issue-17-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-parent/docs/agents/issue-17/issue-17-agent-log.md",
    status: "implementation_ready",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function baseParentWorkstream(overrides: Partial<WorkstreamRecord> = {}): WorkstreamRecord {
  return {
    id: "eladaviv/repo-one:issue:17",
    repoKey: "repo-1",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [{ number: 100, role: "integration", status: "open" }],
    activePrNumber: 100,
    integration: {
      branchName: "agent/eladaviv-repo-one/issue-17",
      prNumber: 100
    },
    phase: "implementing",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    ...overrides
  };
}

function emptyState(overrides: Partial<PersistedState> = {}): PersistedState {
  const metadata = { partialFailures: [] };
  return {
    issueMetadata: metadata,
    prMetadata: metadata,
    commentMetadata: metadata,
    issues: [],
    prs: [],
    comments: [],
    workstreams: [],
    worktrees: [],
    tasks: [],
    executions: [],
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
    workspaceRecoveries: [],
    ...overrides
  };
}

// --- Fake Gateways ---

class FakeGitGateway {
  async getBranchHead(repoPath: string, branchName: string): Promise<string> {
    return "fake-head";
  }
  async isWorkingTreeClean(): Promise<boolean> { return true; }
  async commitAll(): Promise<boolean> { return true; }
  async pushBranch(): Promise<void> {}
  async isInsideWorkingTree(): Promise<boolean> { return true; }
  async pullFastForwardOnly(): Promise<void> {}
  async getHeadCommitSha(): Promise<string> { return "abc123456789"; }
  async listWorktrees(): Promise<{ path: string; branch: string }[]> { return []; }
  async getWorktreeForBranch(): Promise<string | null> { return null; }
}

class FakeGitHubGateway implements Partial<GitHubGateway> {
  // Methods can throw if called unexpectedly as per plan
}

// --- Pipeline Helper ---

function runPacketPipeline(input: {
  repos: RepoConfig[];
  previousState: PersistedState;
  currentIssues: NormalizedIssue[];
  currentPullRequests: NormalizedPullRequest[];
  currentComments: NormalizedComment[];
  initialWorktrees: WorktreeRecord[];
  now?: string;
}) {
  const {
    repos,
    previousState,
    currentIssues,
    currentPullRequests,
    currentComments,
    initialWorktrees,
    now = "2026-04-18T10:00:00.000Z"
  } = input;

  const repoSyncRecords = repos.map(repo => baseRepoSync({ repoId: repo.id }));
  const implementationWorkflowService = new ImplementationWorkflowService(
    new FakeGitGateway() as any,
    new FakeGitHubGateway() as any
  );

  // 1. Link Pull Requests to worktrees
  const baseLinkedWorktrees = implementationWorkflowService.linkPullRequests(
    previousState.worktrees.length > 0 ? previousState.worktrees : initialWorktrees,
    currentPullRequests,
    repos
  );

  // 2. Initial workstream derivation (without attention)
  const initialWorkstreams = deriveWorkstreams({
    repos,
    currentIssues,
    currentPullRequests,
    worktrees: baseLinkedWorktrees,
    previousWorkstreams: previousState.workstreams,
    attention: []
  });

  // 3. Collect packet PR projections
  const packetPullRequestProjections = collectPacketPullRequestProjections({
    pullRequests: currentPullRequests,
    workstreams: initialWorkstreams,
    worktrees: baseLinkedWorktrees
  });

  const linkedWorktrees = implementationWorkflowService.reconcilePacketWorktreeReadinessFromProjections(
    baseLinkedWorktrees,
    packetPullRequestProjections,
    repos,
    previousState.tasks,
    initialWorkstreams,
    currentPullRequests
  );

  // 5. Derive attention
  const attention = deriveAttentionRecords({
    repos,
    workstreams: initialWorkstreams,
    previousState,
    currentIssues,
    currentPullRequests,
    currentComments,
    tasks: previousState.tasks,
    worktrees: linkedWorktrees,
    now
  });

  // 6. Phase-aware workstream derivation
  const phaseAwareWorkstreams = deriveWorkstreams({
    repos,
    currentIssues,
    currentPullRequests,
    worktrees: linkedWorktrees,
    previousWorkstreams: initialWorkstreams,
    attention
  });

  // 7. Derive tasks
  const tasks = deriveTasks({
    repos,
    repoSyncRecords,
    previousState,
    currentIssues,
    currentPullRequests,
    currentComments,
    worktrees: linkedWorktrees,
    workstreams: phaseAwareWorkstreams,
    attention,
    contextBuilder: new DefaultContextBuilder(),
    now
  });

  return {
    baseLinkedWorktrees,
    initialWorkstreams,
    packetPullRequestProjections,
    linkedWorktrees,
    attention,
    phaseAwareWorkstreams,
    tasks
  };
}

// --- Tests ---

test("packet PR approval comment and review signals derive packet-scoped state and tasks together", () => {
  const repo = baseRepo();
  const parentWorkstream = baseParentWorkstream({
    packetPlan: {
      status: "proposed",
      packets: {
        T1: {
          id: "T1",
          title: "Task 1",
          summary: "First task",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "pr_open",
          branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1",
          prNumber: 101
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    }
  });

  const packetWorktree: WorktreeRecord = {
    id: "worktree:eladaviv/repo-one:issue:17:packet:t1",
    repoId: "repo-1",
    repoSlug: "eladaviv/repo-one",
    repoName: "repo-one",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-packet-t1",
    branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1",
    status: "planning",
    packet: {
      parentWorkstreamId: parentWorkstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    },
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-packet-t1/docs/agents/packet-t1/issue-17-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-packet-t1/docs/agents/packet-t1/issue-17-agent-log.md",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z"
  };

  const packetPr = basePullRequest({
    number: 101,
    labels: ["agent-plan-approved", "agent-review"],
    headSha: "packet-head-a",
    headBranch: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1",
    baseBranch: "agent/eladaviv-repo-one/issue-17",
    baseClassification: "non_default_parent"
  });

  const packetComment = basePrComment({
    parentNumber: 101,
    body: "Please check this detail."
  });

  const previousState = emptyState({
    issues: [baseIssue()],
    prs: [basePullRequest(), packetPr],
    workstreams: [parentWorkstream],
    worktrees: [baseWorktree(), packetWorktree]
  });

  const result = runPacketPipeline({
    repos: [repo],
    previousState,
    currentIssues: [baseIssue()],
    currentPullRequests: [basePullRequest(), packetPr],
    currentComments: [packetComment],
    initialWorktrees: [baseWorktree(), packetWorktree]
  });

  // Assertions
  assert.equal(result.packetPullRequestProjections.length, 1);
  assert.equal(result.packetPullRequestProjections[0]!.pullRequest.number, 101);

  const reconciledPacketWorktree = result.linkedWorktrees.find(w => w.id === packetWorktree.id);
  assert.ok(reconciledPacketWorktree);
  assert.equal(reconciledPacketWorktree.status, "implementation_ready");
  assert.equal(reconciledPacketWorktree.prNumber, 101);

  const parentAttention = result.attention.find(a => a.workstreamId === parentWorkstream.id);
  assert.ok(parentAttention);
  assert.ok(parentAttention.reasons.includes("pr_comment_added"));

  // Check tasks
  const implementTask = result.tasks.find(t => t.kind === "implement_plan" && t.context.localRepoPath === packetWorktree.path);
  assert.ok(implementTask, "Should have implement_plan task for packet worktree");
  assert.equal(implementTask.id, `task:implement_plan:worktree:${packetWorktree.id}`);

  const commentTask = result.tasks.find(t => t.kind === "respond_pr_comment" && t.context.pullRequestUrl === packetPr.url);
  assert.ok(commentTask, "Should have respond_pr_comment task for packet PR");
  assert.equal(commentTask.context.localRepoPath, packetWorktree.path);
  assert.equal(commentTask.context.planDocumentPath, packetWorktree.planDocumentPath);

  const reviewTask = result.tasks.find(t => t.kind === "review_pr" && t.context.pullRequestUrl === packetPr.url);
  assert.ok(reviewTask, "Should have review_pr task for packet PR");
  assert.equal(reviewTask.context.localRepoPath, packetWorktree.path);
  assert.equal(reviewTask.context.planDocumentPath, packetWorktree.planDocumentPath);

  // Exclusion assertions
  const phaseAwareParentWorkstream = result.phaseAwareWorkstreams.find(ws => ws.id === parentWorkstream.id);
  assert.ok(phaseAwareParentWorkstream);
  const linkedPrNumbers = phaseAwareParentWorkstream.linkedPrs.map(p => p.number);
  assert.ok(!linkedPrNumbers.includes(101), "Packet PR should be excluded from parent linkedPrs");

  const standalonePrWorkstream = result.phaseAwareWorkstreams.find(ws => ws.id === "repo-1:pr:101");
  assert.ok(!standalonePrWorkstream, "Should not create standalone workstream for packet PR");
});

test("approved packet PR with implementation_done does not derive another implement_plan", () => {
  const repo = baseRepo();
  const parentWorkstream = baseParentWorkstream({
    phase: "implementation_done",
    packetPlan: {
      status: "approved",
      packets: {
        T1: {
          id: "T1",
          title: "Task 1",
          summary: "First task",
          status: "approved",
          acceptanceCriteria: ["Done"],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: []
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    }
  });

  const packetWorktree: WorktreeRecord = {
    id: "worktree:eladaviv/repo-one:issue:17:packet:t1",
    repoId: "repo-1",
    repoSlug: "eladaviv/repo-one",
    repoName: "repo-one",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-packet-t1",
    branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1",
    status: "implementation_done",
    packet: {
      parentWorkstreamId: parentWorkstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    },
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-packet-t1/docs/agents/packet-t1/issue-17-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-packet-t1/docs/agents/packet-t1/issue-17-agent-log.md",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z"
  };

  const packetPr = basePullRequest({
    number: 101,
    labels: ["agent-plan-approved"],
    headSha: "packet-head-a",
    headBranch: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1",
    baseBranch: "agent/eladaviv-repo-one/issue-17",
    baseClassification: "non_default_parent"
  });

  const previousState = emptyState({
    issues: [baseIssue()],
    prs: [basePullRequest(), packetPr],
    workstreams: [parentWorkstream],
    worktrees: [baseWorktree({ status: "implementation_done" }), packetWorktree]
  });

  const result = runPacketPipeline({
    repos: [repo],
    previousState,
    currentIssues: [baseIssue()],
    currentPullRequests: [basePullRequest(), packetPr],
    currentComments: [],
    initialWorktrees: [baseWorktree(), packetWorktree]
  });

  const reconciledPacketWorktree = result.linkedWorktrees.find(w => w.id === packetWorktree.id);
  assert.ok(reconciledPacketWorktree);
  assert.equal(reconciledPacketWorktree.status, "implementation_done");
  assert.equal(
    result.tasks.filter(t => t.kind === "implement_plan" && t.context.localRepoPath === packetWorktree.path).length,
    0
  );
});

test("packet PR review freshness remains scoped to the packet PR head in the integrated flow", () => {
  const repo = baseRepo();
  const parentWorkstream = baseParentWorkstream({
    packetPlan: {
      status: "proposed",
      packets: {
        T1: {
          id: "T1",
          title: "Task 1",
          summary: "First task",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "pr_open",
          branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1",
          prNumber: 101
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    }
  });

  const packetWorktree: WorktreeRecord = {
    id: "worktree:eladaviv/repo-one:issue:17:packet:t1",
    repoId: "repo-1",
    repoSlug: "eladaviv/repo-one",
    repoName: "repo-one",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-packet-t1",
    branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1",
    status: "implementation_ready",
    packet: {
      parentWorkstreamId: parentWorkstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    },
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-packet-t1/docs/agents/packet-t1/issue-17-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17-packet-t1/docs/agents/packet-t1/issue-17-agent-log.md",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z"
  };

  const parentPr = basePullRequest({ number: 100, labels: ["agent-review"], headSha: "parent-head" });
  const packetPr = basePullRequest({
    number: 101,
    labels: ["agent-review"],
    headSha: "packet-head-a",
    headBranch: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1",
    baseBranch: "agent/eladaviv-repo-one/issue-17",
    baseClassification: "non_default_parent"
  });

  // Case A: parent completed review does not suppress packet review
  {
    const completedParentReviewTask = {
      id: "task:review_pr:pull_request:eladaviv/repo-one:100",
      kind: "review_pr",
      sourceId: parentPr.id,
      status: "completed",
      relevant: true,
      lastHandledHeadSha: "parent-head"
    } as any;

    const previousState = emptyState({
      issues: [baseIssue()],
      prs: [parentPr, packetPr],
      workstreams: [parentWorkstream],
      worktrees: [baseWorktree(), packetWorktree],
      tasks: [completedParentReviewTask]
    });

    const result = runPacketPipeline({
      repos: [repo],
      previousState,
      currentIssues: [baseIssue()],
      currentPullRequests: [parentPr, packetPr],
      currentComments: [],
      initialWorktrees: [baseWorktree(), packetWorktree]
    });

    const packetReviewTask = result.tasks.find(t => t.sourceId === packetPr.id && t.kind === "review_pr");
    assert.ok(packetReviewTask, "Packet review task should exist");
    assert.equal(packetReviewTask.status, "pending", "Packet review should be pending even if parent review is completed");
  }

  // Case B: unchanged packet head does not duplicate review
  {
    const completedPacketReviewTask = {
      id: "task:review_pr:pull_request:eladaviv/repo-one:101",
      kind: "review_pr",
      sourceId: packetPr.id,
      status: "completed",
      relevant: true,
      lastHandledHeadSha: "packet-head-a"
    } as any;

    const previousState = emptyState({
      issues: [baseIssue()],
      prs: [parentPr, packetPr],
      workstreams: [parentWorkstream],
      worktrees: [baseWorktree(), packetWorktree],
      tasks: [completedPacketReviewTask]
    });

    const result = runPacketPipeline({
      repos: [repo],
      previousState,
      currentIssues: [baseIssue()],
      currentPullRequests: [parentPr, packetPr],
      currentComments: [],
      initialWorktrees: [baseWorktree(), packetWorktree]
    });

    const packetReviewTasks = result.tasks.filter(t => t.sourceId === packetPr.id && t.kind === "review_pr");
    assert.equal(packetReviewTasks.length, 1);
    assert.equal(packetReviewTasks[0]!.status, "completed", "Packet review should remain completed if head SHA is unchanged");
  }

  // Case C: changed packet head allows review rerun
  {
    const completedPacketReviewTask = {
      id: "task:review_pr:pull_request:eladaviv/repo-one:101",
      kind: "review_pr",
      sourceId: packetPr.id,
      status: "completed",
      relevant: true,
      lastHandledHeadSha: "packet-head-a"
    } as any;

    const updatedPacketPr = { ...packetPr, headSha: "packet-head-b" };

    const previousState = emptyState({
      issues: [baseIssue()],
      prs: [parentPr, packetPr],
      workstreams: [parentWorkstream],
      worktrees: [baseWorktree(), packetWorktree],
      tasks: [completedPacketReviewTask]
    });

    const result = runPacketPipeline({
      repos: [repo],
      previousState,
      currentIssues: [baseIssue()],
      currentPullRequests: [parentPr, updatedPacketPr],
      currentComments: [],
      initialWorktrees: [baseWorktree(), packetWorktree]
    });

    const packetReviewTask = result.tasks.find(t => t.sourceId === packetPr.id && t.kind === "review_pr");
    assert.ok(packetReviewTask, "Packet review task should exist");
    assert.equal(packetReviewTask.status, "pending", "Packet review should be reset to pending if head SHA changed");
    assert.match(packetReviewTask.reason || "", /packet-head-b/);
  }
});
