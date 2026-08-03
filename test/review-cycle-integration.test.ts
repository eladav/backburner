import * as assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubPullRequestReviewPublisher } from "../src/agents/review-feedback.js";
import type { RepoConfig } from "../src/config/types.js";
import type { NormalizedPullRequest } from "../src/domain/entities.js";
import type { GitHubGateway } from "../src/github/types.js";
import { ReviewCycleOrchestrator } from "../src/reviews/controller.js";
import { isOrchestratorOwnedReviewComment } from "../src/reviews/comment-ownership.js";
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
const FIXED_HEAD = "b".repeat(40);
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
  assert.equal(receipt.url, "https://github.com/example/repo/pull/7");
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
      if (submitCalls > 0) {
        return [{
          id: "PRR_review-93",
          body: `🤖 Review result: approved\n\n${marker}`,
          author: { login: "example" }
        }];
      }
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
        nodeId: "PRR_review-93",
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
  assert.equal(receipt.id, "PRR_review-93");
  assert.deepEqual(receipt.ownedReviewCommentIds, ["93", "PRR_review-93"]);
});

test("review-cycle ownership uses receipt ID and author, never the robot prefix alone", () => {
  const base = createReviewSession({
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
  const sessions = [{
    ...base,
    publicationReceipts: [{
      id: "receipt-1",
      kind: "review" as const,
      reviewOrdinal: 1,
      headSha: HEAD,
      githubId: "201",
      url: "https://github.com/example/repo/pull/7#pullrequestreview-201",
      marker: "marker",
      publishedAt: NOW,
      authorLogin: "example",
      githubObjectKind: "pull_request_review" as const,
      ownedCommentIds: ["202"]
    }]
  }];
  const comment = (sourceId: string, author: string, body: string) => ({
    id: `comment:${sourceId}`,
    sourceId,
    repoId: "repo-1",
    parentType: "pull_request" as const,
    parentNumber: 7,
    commentKind: "pull_request_review" as const,
    author,
    body
  }) as Parameters<typeof isOrchestratorOwnedReviewComment>[0];

  assert.equal(isOrchestratorOwnedReviewComment(comment("999", "human", "🤖 Please also change this."), sessions), false);
  assert.equal(isOrchestratorOwnedReviewComment(comment("202", "example", "unprefixed owned inline"), sessions), true);
  assert.equal(isOrchestratorOwnedReviewComment(comment("202", "attacker", "copied"), sessions), false);
  assert.equal(isOrchestratorOwnedReviewComment(comment("PRR_201", "example", "marker"), sessions), true);
  assert.equal(isOrchestratorOwnedReviewComment(comment("PRR_201", "attacker", "marker"), sessions), false);
});

test("review-cycle ownership recognizes a submitted review GraphQL alias", () => {
  const base = createReviewSession({
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
  const sessions = [{
    ...base,
    publicationReceipts: [{
      id: "receipt-1",
      kind: "review" as const,
      reviewOrdinal: 1,
      headSha: HEAD,
      githubId: "201",
      url: "https://github.com/example/repo/pull/7#pullrequestreview-201",
      marker: "marker",
      publishedAt: NOW,
      authorLogin: "example",
      githubObjectKind: "pull_request_review" as const,
      ownedCommentIds: ["PRR_review-201"]
    }]
  }];
  const comment = {
    id: "comment:PRR_review-201",
    sourceId: "PRR_review-201",
    repoId: "repo-1",
    parentType: "pull_request" as const,
    parentNumber: 7,
    author: "example",
    body: "unprefixed owned review"
  } as Parameters<typeof isOrchestratorOwnedReviewComment>[0];

  assert.equal(isOrchestratorOwnedReviewComment(comment, sessions), true);
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

test("review, fix, and approval complete in one durable session with one consumed turn", async () => {
  let liveHead = HEAD;
  let commentId = 600;
  const gateway = {
    async getAuthenticatedUser() { return "example"; },
    async getPullRequest() { return { ...livePullRequest(), headSha: liveHead }; },
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
  const worktreeService = {
    async prepareReviewCycleWorkspace() {},
    async finalizeReviewFixHandoff(input: {
      recordPushIntent(intent: {
        headBefore: string;
        headAfter: string;
        commitSha: string;
        filesChanged: string[];
      }): Promise<void>;
    }) {
      const intent = {
        headBefore: HEAD,
        headAfter: FIXED_HEAD,
        commitSha: FIXED_HEAD,
        filesChanged: ["src/fix.ts"]
      };
      await input.recordPushIntent(intent);
      liveHead = FIXED_HEAD;
      return { outcome: "pushed" as const, ...intent };
    }
  } as unknown as ImplementationWorkflowService;
  const orchestrator = new ReviewCycleOrchestrator(
    { async writeReviewSessionState() {}, async writeTaskState() {} } as unknown as StateStore,
    gateway,
    {
      async publishCycleReview(task: TaskRecord) {
        return {
          id: `review-${task.context.reviewCycle?.reviewOrdinal}`,
          url: `https://github.com/example/repo/pull/7#pullrequestreview-${task.context.reviewCycle?.reviewOrdinal}`,
          commentKind: "pull_request_review" as const,
          author: "example",
          ownedReviewCommentIds: []
        };
      }
    },
    worktreeService,
    undefined,
    () => NOW
  );
  let reviewCount = 0;
  const result = await orchestrator.run({
    repos: [repo()],
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
      if (task.kind === "review_pr") {
        reviewCount += 1;
        const execution = reviewExecution(
          task,
          reviewCount === 1 ? "REQUEST_CHANGES" : "APPROVE",
          reviewCount === 1 ? [finding()] : []
        );
        return {
          tasks: tasks.map((candidate): TaskRecord => candidate.id === taskId
            ? { ...candidate, status: "completed", lastExecutionId: execution.id }
            : candidate),
          executions: [...executions, execution]
        };
      }
      const execution: ExecutionRecord = {
        ...reviewExecution(task, "APPROVE", []),
        taskKind: "fix_review_finding",
        result: {
          reviewCycleFix: {
            schemaVersion: 1,
            findingId: "F001",
            disposition: "fixed",
            summary: "Fixed the finding.",
            filesChanged: ["src/fix.ts"],
            checks: [{ command: "npm test", outcome: "passed", durationMs: 10 }],
            relatedFindingIds: [],
            notes: []
          }
        }
      };
      return {
        tasks: tasks.map((candidate): TaskRecord => candidate.id === taskId
          ? { ...candidate, status: "completed", lastExecutionId: execution.id }
          : candidate),
        executions: [...executions, execution]
      };
    }
  });

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.status, "approved");
  assert.equal(result.sessions[0]?.turnsCompleted, 1);
  assert.equal(result.sessions[0]?.reviewOrdinal, 2);
  assert.equal(result.sessions[0]?.startHeadSha, HEAD);
  assert.equal(result.sessions[0]?.terminalHeadSha, FIXED_HEAD);
  assert.equal(result.sessions[0]?.turnHistory[0]?.findings[0]?.commitSha, FIXED_HEAD);
  assert.equal(result.observedPullRequestHeads[pullRequest().id], FIXED_HEAD);
});

test("a blocked completed fix becomes non-resumable and requests workspace recovery", async () => {
  let persistedTasks: TaskRecord[] = [];
  let persistedExecutions: ExecutionRecord[] = [];
  let providerStatus = "active";
  const stateStore = {
    async writeReviewSessionState() {},
    async writeTaskState(tasks: TaskRecord[]) { persistedTasks = tasks; },
    async writeExecutionState(executions: ExecutionRecord[]) { persistedExecutions = executions; },
    async load() {
      return {
        providerSessions: [{
          id: "provider-session-1",
          scope: {
            repoKey: "example/repo",
            workstreamId: workstream().id,
            job: "implementation",
            modelClass: "strong",
            configuredAgentId: "fix-agent",
            provider: "codex",
            localRepoPath: worktree().path,
            branchName: worktree().branchName
          },
          capability: "verified_headless_resume",
          status: "active",
          providerSessionId: "conversation-1",
          createdAt: NOW,
          updatedAt: NOW
        }]
      };
    },
    async writeProviderSessionState(records: Array<{ status: string }>) {
      providerStatus = records[0]?.status ?? "missing";
    }
  } as unknown as StateStore;
  const gateway = {
    async getAuthenticatedUser() { return "example"; },
    async getPullRequest() { return livePullRequest(); },
    async listIssueComments() { return []; },
    async postIssueComment(input: { body: string }) {
      return {
        id: 701,
        url: "https://github.com/example/repo/pull/7#issuecomment-701",
        body: input.body,
        createdAt: NOW,
        updatedAt: NOW,
        author: { login: "example" }
      };
    }
  } as unknown as GitHubGateway;
  const orchestrator = new ReviewCycleOrchestrator(
    stateStore,
    gateway,
    {
      async publishCycleReview() {
        return {
          id: "review-1",
          url: "https://github.com/example/repo/pull/7#pullrequestreview-1",
          commentKind: "pull_request_review" as const,
          author: "example",
          ownedReviewCommentIds: []
        };
      }
    },
    { async prepareReviewCycleWorkspace() {} } as unknown as ImplementationWorkflowService,
    undefined,
    () => NOW
  );
  const result = await orchestrator.run({
    repos: [repo()],
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
      const execution = task.kind === "review_pr"
        ? reviewExecution(task, "REQUEST_CHANGES", [finding()])
        : {
            ...reviewExecution(task, "APPROVE", []),
            taskKind: "fix_review_finding" as const,
            agentId: "fix-agent",
            result: {
              reviewCycleFix: {
                schemaVersion: 1 as const,
                findingId: "F001",
                disposition: "blocked" as const,
                summary: "The safe fix requires human direction.",
                filesChanged: [],
                checks: [{ command: "npm test", outcome: "failed" as const, durationMs: 10 }],
                relatedFindingIds: [],
                notes: []
              }
            }
          };
      return {
        tasks: tasks.map((candidate): TaskRecord => candidate.id === taskId
          ? { ...candidate, status: "completed", lastExecutionId: execution.id }
          : candidate),
        executions: [...executions, execution]
      };
    }
  });

  const failedTask = result.tasks.find((task) => task.kind === "fix_review_finding")!;
  const failedExecution = result.executions.find((execution) => execution.taskId === failedTask.id)!;
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.status, "failed");
  assert.equal(result.sessions[0]?.terminalHeadSha, HEAD);
  assert.equal(failedTask.status, "failed");
  assert.equal(failedTask.context.recoveryNeeded, true);
  assert.equal(failedExecution.taskStatus, "failed");
  assert.equal(providerStatus, "stale");
  assert.equal(persistedTasks.find((task) => task.id === failedTask.id)?.status, "failed");
  assert.equal(persistedExecutions.find((execution) => execution.id === failedExecution.id)?.taskStatus, "failed");
});

test("invalid review-cycle commands receive one marker-indexed explanation", async () => {
  const publishedBodies: string[] = [];
  const gateway = {
    async getAuthenticatedUser() { return "example"; },
    async getPullRequest() { return livePullRequest(); },
    async listIssueComments() { return []; },
    async postIssueComment(input: { body: string }) {
      publishedBodies.push(input.body);
      return {
        id: 801,
        url: "https://github.com/example/repo/pull/7#issuecomment-801",
        body: input.body,
        createdAt: NOW,
        updatedAt: NOW,
        author: { login: "example" }
      };
    }
  } as unknown as GitHubGateway;
  const base = createReviewSession({
    repoId: "repo-1",
    repoSlug: "example/repo",
    pullRequestId: pullRequest().id,
    pullRequestNumber: 7,
    pullRequestUrl: pullRequest().url,
    workstreamId: workstream().id,
    trigger: "label",
    maxTurns: 0,
    headSha: HEAD,
    ordinal: 1,
    now: NOW
  });
  const terminalUrl = "https://github.com/example/repo/pull/7#issuecomment-800";
  const terminal = {
    ...base,
    status: "max_turns" as const,
    currentReview: {
      schemaVersion: 2 as const,
      action: "REQUEST_CHANGES" as const,
      reviewedHeadSha: HEAD,
      summary: "Changes required.",
      findings: [finding()]
    },
    lastReviewedHeadSha: HEAD,
    terminalHeadSha: HEAD,
    terminalAt: NOW,
    terminalComment: {
      commentId: "800",
      url: terminalUrl,
      marker: "terminal-marker",
      publishedAt: NOW,
      authorLogin: "example",
      githubObjectKind: "pull_request_comment" as const
    }
  };
  const orchestrator = new ReviewCycleOrchestrator(
    { async writeReviewSessionState() {}, async writeTaskState() {} } as unknown as StateStore,
    gateway,
    { async publishCycleReview() { throw new Error("not reached"); } },
    { async prepareReviewCycleWorkspace() {} } as unknown as ImplementationWorkflowService,
    undefined,
    () => NOW
  );
  const result = await orchestrator.run({
    repos: [repo()],
    pullRequests: [pullRequest()],
    previousPullRequests: [pullRequest()],
    comments: [{
      id: "comment:retry-wrong-state",
      sourceId: "900",
      repoId: "repo-1",
      repoKey: "example/repo",
      repoOwner: "example",
      repoName: "repo",
      repoSlug: "example/repo",
      kind: "comment",
      commentKind: "pull_request_comment",
      parentType: "pull_request",
      parentNumber: 7,
      parentKey: "example/repo#7",
      url: "https://github.com/example/repo/pull/7#issuecomment-900",
      body: `retry: ${terminalUrl}`,
      author: "example",
      createdAt: NOW,
      updatedAt: NOW
    }],
    previousComments: [],
    workstreams: [workstream()],
    worktrees: [worktree()],
    sessions: [terminal],
    tasks: [],
    executions: [],
    allowedUsers: ["example"],
    async dispatchChild(_taskId, tasks, executions) { return { tasks, executions }; }
  });
  assert.equal(publishedBodies.length, 1);
  assert.match(publishedBodies[0] ?? "", /retry.*failed-run terminal comment/i);
  assert.match(publishedBodies[0] ?? "", /backburner-review-cycle-command:v1/);
  assert.equal(result.sessions[0]?.ownedComments[0]?.commentId, "801");
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
