import * as assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubPullRequestReviewPublisher } from "../src/agents/review-feedback.js";
import type { RepoConfig } from "../src/config/types.js";
import type { NormalizedPullRequest } from "../src/domain/entities.js";
import type { GitHubGateway } from "../src/github/types.js";
import { ReviewCycleOrchestrator } from "../src/reviews/controller.js";
import { createReviewSession } from "../src/reviews/session.js";
import { buildReviewCycleReviewTask } from "../src/reviews/task-builders.js";
import type { StateStore } from "../src/state/loader.js";
import type {
  ExecutionRecord,
  WorkstreamRecord,
  WorktreeRecord
} from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { ImplementationWorkflowService } from "../src/worktrees/service.js";

const HEAD = "a".repeat(40);
const NOW = "2026-08-03T10:00:00.000Z";

test("automatic review publication is marker-idempotent and indexes owned inline comments", async () => {
  const task = buildReviewCycleReviewTask({
    identity: {
      sessionId: "review-session:repo-1:pr-7:1",
      workstreamId: "workstream:repo-1:pr-7",
      reviewOrdinal: 1,
      expectedHeadSha: HEAD
    },
    pullRequest: pullRequest(),
    now: NOW
  });
  const execution = reviewExecution(task, "APPROVE", []);
  let submitCalls = 0;
  const marker = "<!-- backburner-review-cycle:v1 session=review-session:repo-1:pr-7:1 kind=review ordinal=1 -->";
  const gateway = {
    async getAuthenticatedUser() {
      return "example";
    },
    async getPullRequest() {
      return livePullRequest();
    },
    async listPullRequestReviews() {
      return [{
        id: "91",
        url: "https://github.com/example/repo/pull/7#pullrequestreview-91",
        body: `🤖 Review result: approved\n\n${marker}`,
        author: { login: "example" }
      }];
    },
    async listIssueComments() {
      return [];
    },
    async listPullRequestReviewComments() {
      return [{
        id: 92,
        body: `🤖 F001\n\n${marker}`,
        user: { login: "example" },
        created_at: NOW,
        updated_at: NOW
      }];
    },
    async submitPullRequestReview() {
      submitCalls += 1;
      throw new Error("an existing marked review must be reused");
    }
  } as unknown as GitHubGateway;

  const receipt = await new GitHubPullRequestReviewPublisher(gateway, [repo()])
    .publishCycleReview(task, execution);

  assert.equal(submitCalls, 0);
  assert.equal(receipt.id, "91");
  assert.deepEqual(receipt.ownedReviewCommentIds, ["92"]);
});

test("automatic review publication ignores a copied marker from another author", async () => {
  const task = buildReviewCycleReviewTask({
    identity: {
      sessionId: "review-session:repo-1:pr-7:1",
      workstreamId: "workstream:repo-1:pr-7",
      reviewOrdinal: 1,
      expectedHeadSha: HEAD
    },
    pullRequest: pullRequest(),
    now: NOW
  });
  const execution = reviewExecution(task, "APPROVE", []);
  const marker = "<!-- backburner-review-cycle:v1 session=review-session:repo-1:pr-7:1 kind=review ordinal=1 -->";
  let submitCalls = 0;
  const gateway = {
    async getAuthenticatedUser() { return "example"; },
    async getPullRequest() { return livePullRequest(); },
    async listPullRequestReviews() {
      return [{
        id: "91",
        url: "https://github.com/example/repo/pull/7#pullrequestreview-91",
        body: marker,
        author: { login: "attacker" }
      }];
    },
    async listIssueComments() {
      return [{
        id: "92",
        url: "https://github.com/example/repo/pull/7#issuecomment-92",
        body: marker,
        author: { login: "attacker" }
      }];
    },
    async listPullRequestChangedFiles() { return []; },
    async listPullRequestReviewComments() { return []; },
    async submitPullRequestReview() {
      submitCalls += 1;
      return {
        id: 93,
        url: "https://github.com/example/repo/pull/7#pullrequestreview-93",
        body: "approved",
        state: "COMMENTED",
        submittedAt: NOW,
        author: { login: "example" }
      };
    }
  } as unknown as GitHubGateway;

  const receipt = await new GitHubPullRequestReviewPublisher(gateway, [repo()])
    .publishCycleReview(task, execution);

  assert.equal(submitCalls, 1);
  assert.equal(receipt.id, "93");
});

test("maxTurns zero publishes the review and a terminal timeline without dispatching a fix", async () => {
  const publishedBodies: string[] = [];
  const gateway = {
    async getAuthenticatedUser() {
      return "example";
    },
    async getPullRequest() {
      return livePullRequest();
    },
    async listIssueComments() {
      return [];
    },
    async postIssueComment(input: { body: string }) {
      publishedBodies.push(input.body);
      return {
        id: 301,
        url: "https://github.com/example/repo/pull/7#issuecomment-301",
        body: input.body,
        createdAt: NOW,
        updatedAt: NOW,
        author: { login: "example" }
      };
    }
  } as unknown as GitHubGateway;
  const stateStore = {
    async writeReviewSessionState() {},
    async writeTaskState() {}
  } as unknown as StateStore;
  const reviewPublisher = {
    async publishCycleReview() {
      return {
        id: "201",
        url: "https://github.com/example/repo/pull/7#pullrequestreview-201",
        commentKind: "pull_request_review" as const,
        author: "example",
        ownedReviewCommentIds: ["202"]
      };
    }
  };
  const worktreeService = {
    async prepareReviewCycleWorkspace() {}
  } as unknown as ImplementationWorkflowService;
  const orchestrator = new ReviewCycleOrchestrator(
    stateStore,
    gateway,
    reviewPublisher,
    worktreeService,
    undefined,
    () => NOW
  );

  let fixTaskDispatched = false;
  const result = await orchestrator.run({
    repos: [{ ...repo(), reviewAutomation: { maxTurns: 0 } }],
    pullRequests: [pullRequest()],
    previousPullRequests: [],
    comments: [],
    previousComments: [],
    workstreams: [workstream()],
    worktrees: [worktree()],
    sessions: [],
    tasks: [],
    executions: [],
    allowedUsers: ["example"],
    async dispatchChild(taskId, tasks, executions) {
      const task = tasks.find((candidate) => candidate.id === taskId)!;
      if (task.kind === "fix_review_finding") fixTaskDispatched = true;
      const execution = reviewExecution(task, "REQUEST_CHANGES", [finding()]);
      return {
        tasks: tasks.map((candidate): TaskRecord => candidate.id === taskId
          ? { ...candidate, status: "completed", lastExecutionId: execution.id }
          : candidate),
        executions: [...executions, execution]
      };
    }
  });

  assert.equal(fixTaskDispatched, false);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.status, "max_turns");
  assert.equal(result.sessions[0]?.terminalHeadSha, HEAD);
  assert.equal(result.sessions[0]?.terminalComment?.commentId, "301");
  assert.match(publishedBodies[0] ?? "", /reached its 0-turn limit/);
  assert.match(publishedBodies[0] ?? "", /continue: <this comment URL>/);
});

test("a newly applied persistent label creates only one session when its review fails", async () => {
  let dispatchCount = 0;
  let terminalCommentCount = 0;
  const gateway = {
    async getAuthenticatedUser() {
      return "example";
    },
    async getPullRequest() {
      return livePullRequest();
    },
    async listIssueComments() {
      return [];
    },
    async postIssueComment(input: { body: string }) {
      terminalCommentCount += 1;
      return {
        id: 401,
        url: "https://github.com/example/repo/pull/7#issuecomment-401",
        body: input.body,
        createdAt: NOW,
        updatedAt: NOW,
        author: { login: "example" }
      };
    }
  } as unknown as GitHubGateway;
  const orchestrator = new ReviewCycleOrchestrator(
    {
      async writeReviewSessionState() {},
      async writeTaskState() {}
    } as unknown as StateStore,
    gateway,
    { async publishCycleReview() { throw new Error("failed reviews are not published"); } },
    { async prepareReviewCycleWorkspace() {} } as unknown as ImplementationWorkflowService,
    undefined,
    () => NOW
  );

  const result = await orchestrator.run({
    repos: [repo()],
    pullRequests: [pullRequest()],
    previousPullRequests: [{ ...pullRequest(), labels: [] }],
    comments: [],
    previousComments: [],
    workstreams: [workstream()],
    worktrees: [worktree()],
    sessions: [],
    tasks: [],
    executions: [],
    allowedUsers: ["example"],
    async dispatchChild(taskId, tasks, executions) {
      dispatchCount += 1;
      const task = tasks.find((candidate) => candidate.id === taskId)!;
      const execution = {
        ...reviewExecution(task, "APPROVE", []),
        taskStatus: "failed" as const,
        errorMessage: "review contract was invalid"
      };
      return {
        tasks: tasks.map((candidate): TaskRecord => candidate.id === taskId
          ? { ...candidate, status: "failed", lastExecutionId: execution.id }
          : candidate),
        executions: [...executions, execution]
      };
    }
  });

  assert.equal(dispatchCount, 1);
  assert.equal(terminalCommentCount, 1);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.status, "failed");
});

test("an unexpected head starts a fresh session instead of suppressing that head", async () => {
  const newHead = "b".repeat(40);
  let commentId = 500;
  let clockTick = 0;
  const nextNow = () => new Date(Date.parse(NOW) + (++clockTick)).toISOString();
  const gateway = {
    async getAuthenticatedUser() { return "example"; },
    async getPullRequest() { return { ...livePullRequest(), headSha: newHead }; },
    async listIssueComments() { return []; },
    async postIssueComment(input: { body: string }) {
      commentId += 1;
      return {
        id: commentId,
        url: `https://github.com/example/repo/pull/7#issuecomment-${commentId}`,
        body: input.body,
        createdAt: NOW,
        updatedAt: NOW,
        author: { login: "example" }
      };
    }
  } as unknown as GitHubGateway;
  const orchestrator = new ReviewCycleOrchestrator(
    { async writeReviewSessionState() {}, async writeTaskState() {} } as unknown as StateStore,
    gateway,
    {
      async publishCycleReview() {
        return {
          id: "review-new",
          url: "https://github.com/example/repo/pull/7#pullrequestreview-new",
          commentKind: "pull_request_review" as const,
          author: "example",
          ownedReviewCommentIds: []
        };
      }
    },
    { async prepareReviewCycleWorkspace() {} } as unknown as ImplementationWorkflowService,
    undefined,
    nextNow
  );
  const initialSession = createReviewSession({
    repoId: "repo-1",
    repoSlug: "example/repo",
    pullRequestId: pullRequest().id,
    pullRequestNumber: 7,
    pullRequestUrl: pullRequest().url,
    workstreamId: workstream().id,
    trigger: "label",
    maxTurns: 5,
    headSha: HEAD,
    ordinal: 1,
    now: NOW
  });

  const result = await orchestrator.run({
    repos: [repo()],
    pullRequests: [pullRequest()],
    previousPullRequests: [pullRequest()],
    comments: [],
    previousComments: [],
    workstreams: [workstream()],
    worktrees: [worktree()],
    sessions: [initialSession],
    tasks: [],
    executions: [],
    allowedUsers: ["example"],
    async dispatchChild(taskId, tasks, executions) {
      const task = tasks.find((candidate) => candidate.id === taskId)!;
      const execution = reviewExecution(task, "APPROVE", []);
      return {
        tasks: tasks.map((candidate): TaskRecord => candidate.id === taskId
          ? { ...candidate, status: "completed", lastExecutionId: execution.id }
          : candidate),
        executions: [...executions, execution]
      };
    }
  });

  assert.equal(result.sessions.length, 2);
  const superseded = result.sessions.find((session) => session.id === initialSession.id)!;
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.terminalHeadSha, HEAD);
  const successor = result.sessions.find((session) => session.id !== initialSession.id)!;
  assert.equal(successor.trigger, "head_changed");
  assert.equal(successor.startHeadSha, newHead);
  assert.equal(successor.status, "approved");
  assert.equal(successor.terminalHeadSha, newHead);
});

function repo(): RepoConfig {
  return {
    id: "repo-1",
    owner: "example",
    name: "repo",
    defaultBranch: "main",
    localPath: "example/repo",
    enabled: true,
    labels: {
      agentInProgress: "backburner:in-progress",
      agentProductApproved: "backburner:product-approved",
      agentPlanApproved: "backburner:plan-approved",
      agentReview: "backburner:review",
      planBreakdownNeeded: "backburner:plan-breakdown-needed",
      agentSyncParentBranch: "backburner:sync-parent-branch",
      prepareForMerge: "backburner:prepare-for-merge"
    },
    reviewAutomation: { maxTurns: 5 }
  };
}

function pullRequest(): NormalizedPullRequest {
  return {
    id: "pull_request:example/repo:7",
    kind: "pull_request",
    repoId: "repo-1",
    repoKey: "example/repo",
    repoOwner: "example",
    repoName: "repo",
    repoSlug: "example/repo",
    number: 7,
    key: "example/repo#7",
    sourceId: "PR_kwDO7",
    url: "https://github.com/example/repo/pull/7",
    title: "Automatic review",
    body: "",
    labels: ["backburner:review"],
    author: "example",
    state: "open",
    headBranch: "agent/review",
    headSha: HEAD,
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function livePullRequest() {
  return {
    id: "PR_kwDO7",
    number: 7,
    title: "Automatic review",
    body: "",
    url: "https://github.com/example/repo/pull/7",
    state: "OPEN" as const,
    createdAt: NOW,
    updatedAt: NOW,
    author: { login: "example" },
    labels: [{ name: "backburner:review" }],
    headRefName: "agent/review",
    headSha: HEAD,
    baseRefName: "main",
    isDraft: false
  };
}

function workstream(): WorkstreamRecord {
  return {
    id: "workstream:repo-1:pr-7",
    repoKey: "example/repo",
    origin: { type: "pr", number: 7 },
    linkedPrs: [{ number: 7, status: "open" }],
    activePrNumber: 7,
    activeWorktreeId: "worktree:repo-1:pr-7",
    phase: "pr_review",
    attention: "review_requested",
    status: "open",
    resolution: "unresolved"
  };
}

function worktree(): WorktreeRecord {
  return {
    id: "worktree:repo-1:pr-7",
    repoId: "repo-1",
    repoSlug: "example/repo",
    repoName: "repo",
    prId: "pull_request:example/repo:7",
    prNumber: 7,
    prUrl: "https://github.com/example/repo/pull/7",
    branchName: "agent/review",
    path: "/tmp/review-worktree",
    planDocumentPath: "/tmp/review-worktree/plan.md",
    logDocumentPath: "/tmp/review-worktree/log.md",
    status: "implementation_done",
    createdAt: NOW,
    updatedAt: NOW
  };
}

function finding() {
  return {
    id: "F001",
    title: "Persist the result",
    category: "correctness" as const,
    severity: "blocking" as const,
    actionable: true,
    evidence: "The result is currently dropped.",
    impact: "The workflow cannot advance.",
    instruction: "Persist the result before advancing.",
    acceptanceCriteria: ["The result survives restart."],
    verification: ["Run the state tests."],
    dependsOn: [],
    overlapsWith: []
  };
}

function reviewExecution(
  task: TaskRecord,
  action: "APPROVE" | "REQUEST_CHANGES",
  findings: ReturnType<typeof finding>[]
): ExecutionRecord {
  return {
    id: `execution:${task.id}`,
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: "completed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "review-agent",
    agentProvider: "codex",
    command: {
      executable: "codex",
      args: [],
      cwd: "/tmp/review-worktree",
      timeoutMs: 600_000
    },
    promptArtifactPath: "",
    stdoutArtifactPath: "",
    stderrArtifactPath: "",
    promptPacketPath: "",
    startedAt: NOW,
    endedAt: NOW,
    exitCode: 0,
    result: {
      reviewCycleReview: {
        schemaVersion: 2,
        action,
        reviewedHeadSha: task.context.reviewCycle?.targetHeadSha ?? HEAD,
        summary: action === "APPROVE" ? "Looks good." : "One change is required.",
        findings
      }
    }
  };
}
