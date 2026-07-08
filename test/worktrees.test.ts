import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { RepoConfig } from "../src/config/types.js";
import type { NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import type { BranchSyncComparison, GitGateway } from "../src/git/types.js";
import type { GitHubGateway, GhComment, GhIssueCommentMutationResult, GhIssueSummary, GhPullRequestReview, GhPullRequestReviewComment, GhPullRequestChangedFile, GhPullRequestReviewCommentReplyResult, GhPullRequestReviewSubmissionResult, GhPullRequestSummary, GhSearchCodeResult, GitHubRepositoryMetadata, GhIssueEvent, GhCheckRun } from "../src/github/types.js";
import { StateStore } from "../src/state/loader.js";
import type { PersistedState, RepoSyncRecord, WorktreeRecord } from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { deriveTasks } from "../src/tasks/derive.js";
import { workflowRegistry } from "../src/workflows/registry.js";
import { DefaultContextBuilder } from "../src/context/types.js";
import { TriageFollowUpService } from "../src/workflows/triage.js";
import {
  buildWorktreeBranchName,
  buildWorktreeRelativePath,
  buildPacketWorktreeBranchName,
  buildPacketWorktreeRelativePath,
  buildPacketWorktreeId,
  buildWorktreeProductSpecTaskRecord,
  ImplementationWorkflowService
} from "../src/worktrees/service.js";
import type { WorkstreamRecord } from "../src/state/types.js";

test("worktree helpers generate deterministic branch names and code-root-safe paths", () => {
  const repo = baseRepo();

  assert.equal(buildWorktreeBranchName(repo, 17), "agent/eladaviv-repo-one/issue-17");
  assert.equal(
    buildWorktreeRelativePath(repo, 17),
    path.join("_worktrees", "eladaviv", "repo-one", "issue-17")
  );
});

test("packet worktree helpers generate deterministic branch names and paths", () => {
  const repo = baseRepo();
  const workstream: WorkstreamRecord = {
    id: "repo-1:issue:17",
    repoKey: "repo-1",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [],
    phase: "planning",
    attention: "idle",
    status: "open",
    resolution: "unresolved"
  };

  assert.equal(
    buildPacketWorktreeBranchName({ repo, parentWorkstream: workstream, packetId: "T1" }),
    "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d"
  );
  assert.equal(
    buildPacketWorktreeBranchName({ repo, parentWorkstream: workstream, packetId: "FE-1: auth UI" }),
    "agent/eladaviv-repo-one/workstream-issue-17/packet-fe-1-auth-ui-47ac303b"
  );
  assert.equal(
    buildPacketWorktreeRelativePath({ repo, parentWorkstream: workstream, packetId: "T1" }),
    path.join("_worktrees", "eladaviv", "repo-one", "workstream-issue-17", "packet-t1-1f93603d")
  );
  assert.equal(
    buildPacketWorktreeRelativePath({ repo, parentWorkstream: workstream, packetId: "FE-1: auth UI" }),
    path.join("_worktrees", "eladaviv", "repo-one", "workstream-issue-17", "packet-fe-1-auth-ui-47ac303b")
  );
  assert.equal(
    buildPacketWorktreeId({ repo, parentWorkstream: workstream, packetId: "T1" }),
    "worktree:eladaviv/repo-one:issue:17:packet:t1-1f93603d"
  );
  assert.equal(
    buildPacketWorktreeId({ repo, parentWorkstream: workstream, packetId: "FE-1: auth UI" }),
    "worktree:eladaviv/repo-one:issue:17:packet:fe-1-auth-ui-47ac303b"
  );
});

test("ensurePacketPlanningWorktreesForCurrentWave creates worktrees for undispatched packets", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-packet-worktrees-"));
  const codeRoot = path.join(tempDir, "code-root");
  const repoPath = path.join(codeRoot, "repo-one");
  await mkdir(repoPath, { recursive: true });

  try {
    const repo = baseRepo();
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const workstream: WorkstreamRecord = {
      id: "repo-1:issue:17",
      repoKey: "repo-1",
      origin: { type: "issue", number: 17 },
      linkedIssueNumber: 17,
      linkedPrs: [],
      phase: "planning",
      attention: "idle",
      status: "open",
      resolution: "unresolved",
      integration: { branchName: "agent/eladaviv-repo-one/issue-17" },
      packetPlan: {
        status: "proposed",
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
            status: "planned"
          },
          T2: {
            id: "T2",
            title: "T2",
            summary: "S2",
            acceptanceCriteria: [],
            filesLikelyTouched: [],
            dependsOn: ["T1"],
            canRunInParallelWith: [],
            blocks: [],
            status: "planned"
          }
        },
        waves: [["T1"], ["T2"]],
        currentWaveIndex: 0
      }
    };

    const results = await service.ensurePacketPlanningWorktreesForCurrentWave({
      repo,
      repoPath,
      codeRoot,
      parentWorkstream: workstream,
      existingWorktrees: []
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.worktree.packet?.packetId, "T1");
    assert.equal(results[0]?.worktree.branchName, "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d");
    assert.equal(results[0]?.worktree.baseBranch, "agent/eladaviv-repo-one/issue-17");
    assert.equal(results[0]?.created, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ensurePacketPlanningWorktreesForCurrentWave reuses existing packet worktree", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-packet-worktrees-reuse-"));
  const codeRoot = path.join(tempDir, "code-root");
  const repoPath = path.join(codeRoot, "repo-one");
  await mkdir(repoPath, { recursive: true });

  try {
    const repo = baseRepo();
    const gitGateway = new RecordingGitGateway();
    const service = new ImplementationWorkflowService(gitGateway, new FakeGitHubGateway());
    const workstream = baseIssueWorkstreamWithPlan();

    const existingWorktree: WorktreeRecord = {
      ...baseWorktree({
        id: "worktree:eladaviv/repo-one:issue:17:packet:t1-1f93603d",
        branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
        planDocumentPath: path.join(codeRoot, "legacy", "packet-plan.md"),
        logDocumentPath: path.join(codeRoot, "legacy", "packet-log.md"),
        packet: {
          parentWorkstreamId: "repo-1:issue:17",
          packetId: "T1",
          waveIndex: 0,
          parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
        }
      })
    };

    const results = await service.ensurePacketPlanningWorktreesForCurrentWave({
      repo,
      repoPath,
      codeRoot,
      parentWorkstream: workstream,
      existingWorktrees: [existingWorktree]
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.created, false);
    assert.equal(results[0]?.worktree.packet?.packetId, "T1");
    assert.equal(results[0]?.worktree.packet?.parentIntegrationBranch, "agent/eladaviv-repo-one/issue-17");
    assert.equal(results[0]?.worktree.planDocumentPath, existingWorktree.planDocumentPath);
    assert.equal(results[0]?.worktree.logDocumentPath, existingWorktree.logDocumentPath);
    assert.equal(gitGateway.createWorktreeCalls, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("new packet documents do not collide when long branch names differ after slug truncation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-packet-document-scope-"));
  const codeRoot = path.join(tempDir, "code-root");
  const repoPath = path.join(codeRoot, "agents-over-github");
  await mkdir(repoPath, { recursive: true });

  try {
    const repo: RepoConfig = {
      ...baseRepo(),
      owner: "eladav",
      name: "agents-over-github"
    };
    const createWorkstream = (issueNumber: number): WorkstreamRecord => ({
      ...baseIssueWorkstreamWithPlan(),
      id: `eladav/agents-over-github:issue:${issueNumber}`,
      origin: { type: "issue", number: issueNumber },
      linkedIssueNumber: issueNumber,
      integration: { branchName: `agent/eladav-agents-over-github/issue-${issueNumber}` }
    });
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());

    const first = await service.ensurePacketPlanningWorktreesForCurrentWave({
      repo,
      repoPath,
      codeRoot,
      parentWorkstream: createWorkstream(153),
      existingWorktrees: []
    });
    const second = await service.ensurePacketPlanningWorktreesForCurrentWave({
      repo,
      repoPath,
      codeRoot,
      parentWorkstream: createWorkstream(204),
      existingWorktrees: []
    });

    assert.notEqual(first[0]?.worktree.planDocumentPath, second[0]?.worktree.planDocumentPath);
    assert.match(
      await readFile(second[0]!.worktree.planDocumentPath, "utf8"),
      /Parent workstream: eladav\/agents-over-github:issue:204/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ensurePacketPlanningWorktreesForCurrentWave recovers packet metadata by branch name", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-packet-worktrees-recovery-"));
  const codeRoot = path.join(tempDir, "code-root");
  const repoPath = path.join(codeRoot, "repo-one");
  await mkdir(repoPath, { recursive: true });

  try {
    const repo = baseRepo();
    const gitGateway = new RecordingGitGateway();
    const service = new ImplementationWorkflowService(gitGateway, new FakeGitHubGateway());
    const workstream = baseIssueWorkstreamWithPlan();

    // Worktree exists but missing packet metadata (e.g. state loss)
    const existingWorktree: WorktreeRecord = {
      ...baseWorktree({
        id: "some-other-id",
        branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d"
      })
    };

    const results = await service.ensurePacketPlanningWorktreesForCurrentWave({
      repo,
      repoPath,
      codeRoot,
      parentWorkstream: workstream,
      existingWorktrees: [existingWorktree]
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.created, false);
    assert.ok(results[0]?.worktree.packet, "Gained packet metadata");
    assert.equal(results[0]?.worktree.packet?.packetId, "T1");
    assert.equal(results[0]?.worktree.packet?.parentIntegrationBranch, "agent/eladaviv-repo-one/issue-17");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("product approval label creates Product Specification worktree metadata and task", async () => {

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-worktrees-"));
  const codeRoot = path.join(tempDir, "code-root");
  const repoPath = path.join(codeRoot, "repo-one");
  await mkdir(repoPath, { recursive: true });

  try {
    const repo = baseRepo();
    const issue: NormalizedIssue = { ...baseIssue(), labels: ["agent-product-approved"] };
    const service = new TriageFollowUpService(new FakeGitGateway(), new FakeGitHubGateway());
    const result = await service.materializeStartImplementation({
      repos: [repo],
      issues: [issue],
      repoPaths: new Map([[repo.id, repoPath]]),
      codeRoot,
      state: {
        ...emptyState(),
        issues: [issue]
      },
      tasks: []
    });

    assert.equal(result.worktrees.length, 1);
    assert.equal(result.worktrees[0]?.branchName, "agent/eladaviv-repo-one/issue-17");
    assert.match(result.worktrees[0]?.path ?? "", /_worktrees\/eladaviv\/repo-one\/issue-17$/);
    assert.equal(result.worktrees[0]?.prNumber, 101);
    assert.equal(result.worktrees[0]?.status, "product_specification");
    assert.equal(result.tasks.some((task) => task.kind === "write_product_spec"), true);
    assert.equal(result.tasks.some((task) => task.kind === "write_plan"), false);
    const writePlanTask = result.tasks.find((task) => task.kind === "write_product_spec");
    assert.equal(
      writePlanTask?.context.productSpecDocumentPath?.endsWith(
        "docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-product-spec.md"
      ),
      true
    );
    assert.equal(
      writePlanTask?.context.logDocumentPath?.endsWith(
        "docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-log.md"
      ),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("product approval retries PR creation for existing worktree without PR metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-worktrees-pr-retry-"));
  const codeRoot = path.join(tempDir, "code-root");
  const repoPath = path.join(codeRoot, "repo-one");
  await mkdir(repoPath, { recursive: true });

  try {
    const repo = baseRepo();
    const issue: NormalizedIssue = { ...baseIssue(), labels: ["agent-product-approved"] };
    const gitHubGateway = new FailingOnceGitHubGateway();
    const service = new TriageFollowUpService(new FakeGitGateway(), gitHubGateway);
    const firstResult = await service.materializeStartImplementation({
      repos: [repo],
      issues: [issue],
      repoPaths: new Map([[repo.id, repoPath]]),
      codeRoot,
      state: {
        ...emptyState(),
        issues: [issue]
      },
      tasks: []
    });

    assert.equal(gitHubGateway.createPullRequestCalls, 1);
    assert.equal(firstResult.worktrees.length, 1);
    assert.equal(firstResult.worktrees[0]?.prNumber, undefined);
    assert.equal(firstResult.tasks.some((task) => task.kind === "write_product_spec"), false);

    const secondResult = await service.materializeStartImplementation({
      repos: [repo],
      issues: [issue],
      repoPaths: new Map([[repo.id, repoPath]]),
      codeRoot,
      state: {
        ...emptyState(),
        issues: [issue],
        worktrees: firstResult.worktrees
      },
      tasks: [
        {
          ...buildWorktreeProductSpecTaskRecord(firstResult.worktrees[0]!, issue, "2026-04-18T10:00:00.000Z"),
          status: "pending"
        }
      ]
    });

    assert.equal(gitHubGateway.createPullRequestCalls, 2);
    assert.equal(secondResult.worktrees[0]?.prNumber, 101);
    assert.equal(secondResult.worktrees[0]?.prUrl, "https://github.com/eladaviv/repo-one/pull/101");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Product Spec worktree task construction compacts issue body and uses full spec guidance", () => {
  const longBody = `${"A".repeat(2400)} final text that should be truncated`;
  const worktree = baseWorktree({
    status: "product_specification",
    productSpecDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-product-spec.md"
  });
  delete worktree.packet;

  const task = buildWorktreeProductSpecTaskRecord(
    worktree,
    { ...baseIssue(), body: longBody },
    "2026-04-18T10:00:00.000Z"
  );

  assert.equal(task.kind, "write_product_spec");
  assert.equal(task.context.issueBody?.length, 2000);
  assert.doesNotMatch(task.context.issueBody ?? "", /final text that should be truncated/);
  assert.match(task.context.instruction, /problem statement, product decision summary, goals, non-goals/);
  assert.match(task.context.instruction, /downstream planner, implementer, and reviewer must read this spec/);
});

test("comment-originated Product Discovery replies do not create implementation worktrees", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-worktrees-comment-owned-"));
  const codeRoot = path.join(tempDir, "code-root");
  const repoPath = path.join(codeRoot, "repo-one");
  await mkdir(repoPath, { recursive: true });

  try {
    const repo = baseRepo();
    const issue = baseIssue();
    const service = new TriageFollowUpService(new FakeGitGateway(), new FakeGitHubGateway());
    const result = await service.materializeStartImplementation({
      repos: [repo],
      issues: [issue],
      repoPaths: new Map([[repo.id, repoPath]]),
      codeRoot,
      state: {
        ...emptyState()
      },
      tasks: [
        {
          id: "task:respond_issue_comment:comment:eladaviv/repo-one:issue_comment:5001",
          kind: "respond_issue_comment",
          status: "completed",
          executionPermission: workflowRegistry.resolveTaskExecutionPolicy("respond_issue_comment").executionPermission,
          handoffPolicy: workflowRegistry.resolveTaskExecutionPolicy("respond_issue_comment").handoffPolicy,
          repoId: repo.id,
          repoName: repo.name,
          repoSlug: "eladaviv/repo-one",
          sourceKind: "comment",
          sourceId: "comment:eladaviv/repo-one:issue_comment:5001",
          sourceUrl: "https://github.com/eladaviv/repo-one/issues/11#issuecomment-5001",
          parentSourceKind: "issue",
          parentSourceId: issue.id,
          relevant: false,
          reason: "Comment is newly seen and needs a response path for issue #11.",
          summary: "Respond to issue comment on #11: Need plan-first workflow",
          context: {
            repoIdentifier: "eladaviv/repo-one",
            localRepoPath: repoPath,
            labels: [],
            issueUrl: issue.url,
            commentUrl: "https://github.com/eladaviv/repo-one/issues/11#issuecomment-5001",
            relevantCommentText: "Please implement the plan-first workflow for this issue.",
            instruction:
              'Read the issue and comment, then return a JSON decision with "answer_only" or "start_implementation".'
          },
          createdAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:01:00.000Z"
        }
      ]
    });

    assert.equal(result.worktrees.length, 0);
    assert.equal(result.tasks.some((task) => task.kind === "write_plan"), false);
    assert.equal(result.tasks.some((task) => task.kind === "write_product_spec"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore persists worktree metadata as readable JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-worktree-state-"));

  try {
    const store = new StateStore(tempDir);
    const record: WorktreeRecord = {
      id: "worktree:eladaviv/repo-one:issue:17",
      repoId: "repo-1",
      repoSlug: "eladaviv/repo-one",
      repoName: "repo-one",
      issueId: "issue:eladaviv/repo-one:17",
      issueNumber: 17,
      branchName: "agent/eladaviv-repo-one/issue-17",
      path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17",
      planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-plan.md",
      logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-log.md",
      status: "planning",
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:00:00.000Z"
    };

    await store.writeWorktreeState([record]);

    const persisted = await readFile(path.join(tempDir, "worktrees.json"), "utf8");
    assert.match(persisted, /"branchName": "agent\/eladaviv-repo-one\/issue-17"/);
    assert.match(persisted, /"planDocumentPath":/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("product approval reuses an existing PR for the branch instead of creating another one", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-worktrees-existing-pr-"));
  const codeRoot = path.join(tempDir, "code-root");
  const repoPath = path.join(codeRoot, "repo-one");
  await mkdir(repoPath, { recursive: true });

  try {
    const issue: NormalizedIssue = { ...baseIssue(), labels: ["agent-product-approved"] };
    const gitHubGateway = new RecordingGitHubGateway({
      existingPullRequest: {
        id: "pull_request:eladaviv/repo-one:88",
        number: 88,
        title: "agent: plan for issue #17 - Need plan-first workflow",
        body: "body",
        url: "https://github.com/eladaviv/repo-one/pull/88",
        state: "OPEN",
        createdAt: "2026-04-18T10:00:00.000Z",
        updatedAt: "2026-04-18T10:00:00.000Z",
        author: { login: "owner" },
        labels: [],
        headRefName: "agent/eladaviv-repo-one/issue-17",
        headSha: "abc123",
        baseRefName: "main",
        isDraft: false
      }
    });
    const service = new TriageFollowUpService(new FakeGitGateway(), gitHubGateway);
    const result = await service.materializeStartImplementation({
      repos: [baseRepo()],
      issues: [issue],
      repoPaths: new Map([["repo-1", repoPath]]),
      codeRoot,
      state: {
        ...emptyState(),
        issues: [issue]
      },
      tasks: []
    });

    assert.equal(result.worktrees[0]?.prNumber, 88);
    assert.equal(gitHubGateway.createPullRequestCalls, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("deriveTasks attaches worktree plan docs to implement_plan once the approval label is present", () => {
  const repo = baseRepo();
  const repoSync = baseRepoSync();
  const pr: NormalizedPullRequest = {
    kind: "pull_request",
    id: "pull_request:eladaviv/repo-one:23",
    repoId: repo.id,
    repoKey: "eladaviv/repo-one",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number: 23,
    key: "eladaviv/repo-one:pull_request:23",
    sourceId: "PR_23",
    url: "https://github.com/eladaviv/repo-one/pull/23",
    title: "Implement workflow",
    body: "Body",
    labels: ["agent-plan-approved"],
    author: "owner",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z",
    lastSeenAt: "2026-04-18T10:00:00.000Z",
    state: "open",
    headBranch: "agent/eladaviv-repo-one/issue-17",
    headSha: "abc123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false
  };

  const tasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: [repoSync],
    previousState: emptyState(),
    currentIssues: [],
    currentPullRequests: [pr],
    currentComments: [],
    worktrees: [
      {
        id: "worktree:eladaviv/repo-one:issue:17",
        repoId: repo.id,
        repoSlug: "eladaviv/repo-one",
        repoName: "repo-one",
        issueId: "issue:eladaviv/repo-one:17",
        issueNumber: 17,
        prId: pr.id,
        prNumber: pr.number,
        prUrl: pr.url,
        branchName: pr.headBranch,
        path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17",
        planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-plan.md",
        logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-log.md",
        status: "awaiting_plan_approval",
        createdAt: "2026-04-18T10:00:00.000Z",
        updatedAt: "2026-04-18T10:00:00.000Z"
      }
    ],
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T10:05:00.000Z"
  });

  assert.equal(tasks.length, 1);
  const implementTask = tasks.find((task) => task.kind === "implement_plan");
  assert.equal(implementTask?.context.localRepoPath, "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17");
  assert.equal(
    implementTask?.context.planDocumentPath,
    "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-plan.md"
  );
});

test("linkPullRequests downgrades implementation-ready worktrees when plan approval is removed", () => {
  const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
  const repo = baseRepo();
  const worktree: WorktreeRecord = {
    id: "worktree:eladaviv/repo-one:issue:17",
    repoId: repo.id,
    repoSlug: "eladaviv/repo-one",
    repoName: "repo-one",
    issueId: "issue:eladaviv/repo-one:17",
    issueNumber: 17,
    prId: "pull_request:eladaviv/repo-one:23",
    prNumber: 23,
    prUrl: "https://github.com/eladaviv/repo-one/pull/23",
    branchName: "agent/eladaviv-repo-one/issue-17",
    path: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17",
    planDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/eladaviv/repo-one/issue-17/docs/agents/agent-eladaviv-repo-one-issue-17/issue-17-agent-log.md",
    status: "implementation_ready",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:05:00.000Z"
  };
  const pr: NormalizedPullRequest = {
    kind: "pull_request",
    id: "pull_request:eladaviv/repo-one:23",
    repoId: repo.id,
    repoKey: "eladaviv/repo-one",
    repoOwner: "eladaviv",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    number: 23,
    key: "eladaviv/repo-one:pull_request:23",
    sourceId: "PR_23",
    url: "https://github.com/eladaviv/repo-one/pull/23",
    title: "Implement workflow",
    body: "Body",
    headBranch: "agent/eladaviv-repo-one/issue-17",
    headSha: "abc123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    labels: [],
    author: "owner",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z",
    lastSeenAt: "2026-04-18T10:00:00.000Z",
    state: "open",
    isDraft: false
  };

  const linked = service.linkPullRequests([worktree], [pr], [repo]);

  assert.equal(linked[0]?.status, "awaiting_plan_approval");
  });

test("linkPullRequests preserves implementation_done despite lingering plan approval label", () => {
  const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
  const repo = baseRepo();
  const worktree = baseWorktree({
    status: "implementation_done",
    branchName: "agent/eladaviv-repo-one/issue-17"
  });
  const pr: NormalizedPullRequest = {
    ...basePullRequestForWorktree(worktree, repo),
    labels: [repo.labels.agentPlanApproved]
  };

  const linked = service.linkPullRequests([worktree], [pr], [repo]);

  assert.equal(linked[0]?.status, "implementation_done");
});

test("linkPullRequests keeps Product Specification worktree until Product Spec is written", () => {
  const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
  const repo = baseRepo();
  const worktree = baseWorktree({
    status: "product_specification",
    branchName: "agent/eladaviv-repo-one/issue-17"
  });
  delete worktree.packet;
  const pr: NormalizedPullRequest = {
    ...basePullRequestForWorktree(worktree, repo),
    labels: [repo.labels.agentPlanApproved]
  };

  const linked = service.linkPullRequests([worktree], [pr], [repo]);

  assert.equal(linked[0]?.status, "product_specification");
});

test("linkPullRequests promotes Product Specification worktree after Product Spec is written", () => {
  const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
  const repo = baseRepo();
  const worktree = baseWorktree({
    status: "product_specification",
    branchName: "agent/eladaviv-repo-one/issue-17",
    productSpecWrittenAt: "2026-04-18T10:03:00.000Z"
  });
  delete worktree.packet;
  const pr: NormalizedPullRequest = {
    ...basePullRequestForWorktree(worktree, repo),
    labels: [repo.labels.agentPlanApproved]
  };

  const linked = service.linkPullRequests([worktree], [pr], [repo]);

  assert.equal(linked[0]?.status, "awaiting_plan_approval");
});

test("linkPullRequests ignores early plan approval until a plan has been written", () => {
  const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
  const repo = baseRepo();
  const worktree = baseWorktree({
    status: "planning",
    branchName: "agent/eladaviv-repo-one/issue-17",
    productSpecWrittenAt: "2026-04-18T10:03:00.000Z"
  });
  delete worktree.packet;
  const pr: NormalizedPullRequest = {
    ...basePullRequestForWorktree(worktree, repo),
    labels: [repo.labels.agentPlanApproved]
  };

  const linked = service.linkPullRequests([worktree], [pr], [repo]);

  assert.equal(linked[0]?.status, "planning");
});

  test("ensurePullRequestForPacketWorktree reuses existing PR info from worktree", async () => {
  const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
  const repo = baseRepo();
  const worktree: WorktreeRecord = {
    ...baseWorktree({
      prNumber: 500,
      prId: "pull_request:500",
      prUrl: "https://github.com/eladaviv/repo-one/pull/500",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      }
    })
  };
  const result = await service.ensurePullRequestForPacketWorktree(
    repo,
    baseIssueWorkstreamWithPlan(),
    worktree
  );

  assert.equal(result.worktree.prNumber,
 500);
});

test("ensurePullRequestForPacketWorktree reuses existing remote PR", async () => {
  const github = new RecordingGitHubGateway({
    existingPullRequest: {
      ...baseGhPullRequest(600),
      headRefName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d"
    }
  });
  const service = new ImplementationWorkflowService(new FakeGitGateway(), github);
  const repo = baseRepo();
  const worktree = baseWorktree({
    branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
    packet: {
      parentWorkstreamId: "repo-1:issue:17",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    }
  });

  const result = await service.ensurePullRequestForPacketWorktree(
    repo,
    baseIssueWorkstreamWithPlan(),
    worktree
  );

  assert.equal(result.worktree.prNumber,
 600);
  assert.equal(result.worktree.prId,
 "pull_request:600");
  assert.equal(result.worktree.prUrl,
 "https://github.com/eladaviv/repo-one/pull/600");
  assert.equal(github.createPullRequestCalls, 0);
});

test("ensurePullRequestForPacketWorktree creates new PR if none exists", async () => {
  const github = new RecordingGitHubGateway();
  const service = new ImplementationWorkflowService(new FakeGitGateway(), github);
  const repo = baseRepo();
  const worktree = baseWorktree({
    branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
    packet: {
      parentWorkstreamId: "repo-1:issue:17",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    }
  });

  const result = await service.ensurePullRequestForPacketWorktree(
    repo,
    baseIssueWorkstreamWithPlan(),
    worktree
  );

  assert.equal(result.worktree.prNumber,
 101);
  assert.equal(github.createPullRequestCalls, 1);
  assert.equal(github.lastCreatePullRequestOptions?.baseBranch, "agent/eladaviv-repo-one/issue-17");
  assert.equal(result.worktree.baseBranch,
 "agent/eladaviv-repo-one/issue-17");
  });

  test("linkPullRequests backfills metadata but does NOT mark approved packet worktree implementation_ready", () => {
  const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
  const repo = baseRepo();
  const packetMetadata = {
    parentWorkstreamId: "repo-1:issue:17",
    packetId: "T1",
    waveIndex: 0,
    parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
  };
  const worktree: WorktreeRecord = {
    ...baseWorktree({
      id: "packet-wt-1",
      packet: packetMetadata,
      baseBranch: "agent/eladaviv-repo-one/issue-17",
      prId: "pull_request:105",
      prNumber: 105,
      prUrl: "https://github.com/eladaviv/repo-one/pull/105",
      branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
      status: "planning"
    })
  };
  const pr: NormalizedPullRequest = {
    ...basePullRequestForWorktree(worktree, repo),
    labels: [repo.labels.agentPlanApproved]
  };

  const linked = service.linkPullRequests([worktree], [pr], [repo]);

  assert.equal(linked[0]?.status, "planning");
  assert.deepEqual(linked[0]?.packet, packetMetadata);
  assert.equal(linked[0]?.baseBranch, "agent/eladaviv-repo-one/issue-17");
  });

  test("linkPullRequests backfills approved packet PR metadata by branch but stays planning", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const repo = baseRepo();
    const worktree: WorktreeRecord = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
      status: "planning"
    });
    // Manually remove PR metadata to test backfill
    delete worktree.prId;
    delete worktree.prNumber;
    delete worktree.prUrl;

    const pr: NormalizedPullRequest = {
      ...basePullRequestForWorktree(worktree, repo),
      id: "pull_request:200",
      number: 200,
      url: "https://github.com/eladaviv/repo-one/pull/200",
      labels: [repo.labels.agentPlanApproved]
    };

    const linked = service.linkPullRequests([worktree], [pr], [repo]);

    assert.equal(linked[0]?.prId, "pull_request:200");
    assert.equal(linked[0]?.prNumber, 200);
    assert.equal(linked[0]?.prUrl, "https://github.com/eladaviv/repo-one/pull/200");
    assert.equal(linked[0]?.status, "planning");
  });

  test("linkPullRequests backfills packet baseBranch from approved packet PR but stays planning", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const repo = baseRepo();
    const worktree: WorktreeRecord = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
      status: "planning"
    });
    delete worktree.baseBranch;

    const pr: NormalizedPullRequest = {
      ...basePullRequestForWorktree(worktree, repo),
      baseBranch: "agent/eladaviv-repo-one/issue-17",
      labels: [repo.labels.agentPlanApproved]
    };

    const linked = service.linkPullRequests([worktree], [pr], [repo]);

    assert.equal(linked[0]?.baseBranch, "agent/eladaviv-repo-one/issue-17");
    assert.equal(linked[0]?.status, "planning");
  });

  test("reconcilePacketWorktreeReadinessFromProjections transitions approved packet worktree", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const repo = baseRepo();
    const packetWorktree = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "planning"
    });

    const pr: NormalizedPullRequest = {
      ...basePullRequestForWorktree(packetWorktree, repo),
      labels: [repo.labels.agentPlanApproved]
    };

    const projection: import("../src/workstreams/packet-projections.js").PacketPullRequestProjection = {
      pullRequest: pr,
      parentWorkstream: baseIssueWorkstreamWithPlan(),
      packet: baseIssueWorkstreamWithPlan().packetPlan!.packets["T1"]!,
      packetWorktree,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    };

    const reconciled = service.reconcilePacketWorktreeReadinessFromProjections(
      [packetWorktree],
      [projection],
      [repo]
    );

    assert.equal(reconciled[0]?.status, "implementation_ready");
    assert.equal(reconciled[0]?.prNumber, pr.number);
  });

  test("reconcilePacketWorktreeReadinessFromProjections does NOT transition non-approved packet PR", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const repo = baseRepo();
    const packetWorktree = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "planning"
    });

    const pr: NormalizedPullRequest = {
      ...basePullRequestForWorktree(packetWorktree, repo),
      labels: [] // No approval label
    };

    const projection: import("../src/workstreams/packet-projections.js").PacketPullRequestProjection = {
      pullRequest: pr,
      parentWorkstream: baseIssueWorkstreamWithPlan(),
      packet: baseIssueWorkstreamWithPlan().packetPlan!.packets["T1"]!,
      packetWorktree,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    };

    const reconciled = service.reconcilePacketWorktreeReadinessFromProjections(
      [packetWorktree],
      [projection],
      [repo]
    );

    assert.equal(reconciled[0]?.status, "planning");
  });

  test("reconcilePacketWorktreeReadinessFromProjections downgrades ready packet when approval label is absent", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const repo = baseRepo();
    const packetWorktree = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "implementation_ready"
    });

    const pr: NormalizedPullRequest = {
      ...basePullRequestForWorktree(packetWorktree, repo),
      labels: []
    };

    const projection: import("../src/workstreams/packet-projections.js").PacketPullRequestProjection = {
      pullRequest: pr,
      parentWorkstream: baseIssueWorkstreamWithPlan(),
      packet: baseIssueWorkstreamWithPlan().packetPlan!.packets["T1"]!,
      packetWorktree,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    };

    const reconciled = service.reconcilePacketWorktreeReadinessFromProjections(
      [packetWorktree],
      [projection],
      [repo]
    );

    assert.equal(reconciled[0]?.status, "awaiting_plan_approval");
  });

  test("reconcilePacketWorktreeReadinessFromProjections leaves ready packet unchanged without a current projection", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const repo = baseRepo();
    const packetWorktree = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "implementation_ready"
    });

    const reconciled = service.reconcilePacketWorktreeReadinessFromProjections(
      [packetWorktree],
      [],
      [repo]
    );

    assert.equal(reconciled[0]?.status, "implementation_ready");
  });

  test("reconcilePacketWorktreeReadinessFromProjections preserves implementation_done with approval label", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const repo = baseRepo();
    const packetWorktree = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "implementation_done"
    });

    const pr: NormalizedPullRequest = {
      ...basePullRequestForWorktree(packetWorktree, repo),
      labels: [repo.labels.agentPlanApproved]
    };

    const projection: import("../src/workstreams/packet-projections.js").PacketPullRequestProjection = {
      pullRequest: pr,
      parentWorkstream: baseIssueWorkstreamWithPlan(),
      packet: baseIssueWorkstreamWithPlan().packetPlan!.packets["T1"]!,
      packetWorktree,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    };

    const reconciled = service.reconcilePacketWorktreeReadinessFromProjections(
      [packetWorktree],
      [projection],
      [repo]
    );

    assert.equal(reconciled[0]?.status, "implementation_done");
  });

  test("reconcilePacketWorktreeReadinessFromProjections recovers approved packet implementing state when task was pruned", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const repo = baseRepo();
    const packetWorktree = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "implementing"
    });

    const pr: NormalizedPullRequest = {
      ...basePullRequestForWorktree(packetWorktree, repo),
      labels: [repo.labels.agentPlanApproved]
    };

    const projection: import("../src/workstreams/packet-projections.js").PacketPullRequestProjection = {
      pullRequest: pr,
      parentWorkstream: baseIssueWorkstreamWithPlan(),
      packet: baseIssueWorkstreamWithPlan().packetPlan!.packets["T1"]!,
      packetWorktree,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    };

    const reconciled = service.reconcilePacketWorktreeReadinessFromProjections(
      [packetWorktree],
      [projection],
      [repo]
    );

    assert.equal(reconciled[0]?.status, "implementation_ready");
  });

  test("linkPullRequests keeps non-approved packet worktree out of implementation_ready", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const repo = baseRepo();
    const worktree: WorktreeRecord = baseWorktree({
      branchName: "agent/eladaviv-repo-one/workstream-issue-17/packet-t1-1f93603d",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "planning"
    });
    const pr: NormalizedPullRequest = {
      ...basePullRequestForWorktree(worktree, repo),
      labels: []
    };

    const linked = service.linkPullRequests([worktree], [pr], [repo]);

    assert.equal(linked[0]?.status, "planning");
  });

  test("reconcileTaskState is conservative before packet projection approval is reapplied", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const worktree: WorktreeRecord = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "implementation_ready"
    });
    const writePlanTask: TaskRecord = {
      id: "task:write_plan:worktree:packet-wt-1",
      kind: "write_plan",
      status: "completed",
      executionPermission: "workspace-write",
      handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
      repoId: "repo-1",
      repoName: "repo-one",
      repoSlug: "eladaviv/repo-one",
      sourceKind: "issue",
      sourceId: "issue:eladaviv/repo-one:17",
      sourceUrl: "https://github.com/eladaviv/repo-one/issues/17",
      relevant: true,
      reason: "reason",
      summary: "summary",
      context: {
        repoIdentifier: "eladaviv/repo-one",
        instruction: "instruction",
        labels: []
      },
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:01:00.000Z"
    };

    const taskReconciled = service.reconcileTaskState([worktree], [writePlanTask]);
    assert.equal(taskReconciled[0]?.status, "awaiting_plan_approval");

    const repo = baseRepo();
    const pr: NormalizedPullRequest = {
      ...basePullRequestForWorktree(worktree, repo),
      labels: [repo.labels.agentPlanApproved]
    };
    const projection: import("../src/workstreams/packet-projections.js").PacketPullRequestProjection = {
      pullRequest: pr,
      parentWorkstream: baseIssueWorkstreamWithPlan(),
      packet: baseIssueWorkstreamWithPlan().packetPlan!.packets["T1"]!,
      packetWorktree: worktree,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
    };

    const projectionReconciled = service.reconcilePacketWorktreeReadinessFromProjections(
      taskReconciled,
      [projection],
      [repo],
      [writePlanTask]
    );

    assert.equal(projectionReconciled[0]?.status, "implementation_ready");
  });

  test("reconcileTaskState still moves completed non-packet write plan to awaiting approval", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const worktree: WorktreeRecord = baseWorktree({
      id: "issue-wt-1",
      status: "planning"
    });
    delete worktree.packet;

    const writePlanTask: TaskRecord = {
      id: "task:write_plan:worktree:issue-wt-1",
      kind: "write_plan",
      status: "completed",
      executionPermission: "workspace-write",
      handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
      repoId: "repo-1",
      repoName: "repo-one",
      repoSlug: "eladaviv/repo-one",
      sourceKind: "issue",
      sourceId: "issue:eladaviv/repo-one:17",
      sourceUrl: "https://github.com/eladaviv/repo-one/issues/17",
      relevant: true,
      reason: "reason",
      summary: "summary",
      context: {
        repoIdentifier: "eladaviv/repo-one",
        instruction: "instruction",
        labels: []
      },
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:01:00.000Z"
    };

    const reconciled = service.reconcileTaskState([worktree], [writePlanTask]);

    assert.equal(reconciled[0]?.status, "awaiting_plan_approval");
    });

  test("reconcileTaskState keeps Product Specification blocked until the spec artifact exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-product-spec-gate-"));
    try {
      const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
      const specPath = path.join(tempDir, "issue-17-product-spec.md");
      const worktree: WorktreeRecord = baseWorktree({
        id: "issue-wt-1",
        status: "product_specification",
        productSpecDocumentPath: specPath
      });
      delete worktree.packet;
      const task = completedProductSpecTask(worktree);

      const reconciled = service.reconcileTaskState([worktree], [task]);

      assert.equal(reconciled[0]?.status, "product_specification");
      assert.equal(reconciled[0]?.productSpecWrittenAt, undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reconcileTaskState clears stale Product Spec timestamp and reopens the spec task when artifact is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-product-spec-stale-"));
    try {
      const repo = baseRepo();
      const repoSync = baseRepoSync();
      const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
      const specPath = path.join(tempDir, "issue-17-product-spec.md");
      const worktree: WorktreeRecord = baseWorktree({
        id: "issue-wt-1",
        status: "product_specification",
        productSpecDocumentPath: specPath,
        productSpecWrittenAt: "2026-04-18T10:01:00.000Z"
      });
      delete worktree.packet;
      const completedTask = completedProductSpecTask(worktree);

      const reconciled = service.reconcileTaskState([worktree], [completedTask]);
      const reconciledWorktree = reconciled[0]!;

      assert.equal(reconciledWorktree.status, "product_specification");
      assert.equal(reconciledWorktree.productSpecWrittenAt, undefined);

      const tasks = deriveTasks({
        repos: [repo],
        repoSyncRecords: [repoSync],
        previousState: {
          ...emptyState(),
          issues: [baseIssue()],
          tasks: [completedTask],
          worktrees: [reconciledWorktree],
          workstreams: [
            {
              id: "repo-1:issue:17",
              repoKey: "repo-1",
              origin: { type: "issue", number: 17 },
              linkedIssueNumber: 17,
              linkedPrs: [{ number: 24, status: "open", role: "implementation" }],
              phase: "product_specification",
              attention: "idle",
              status: "open",
              resolution: "unresolved",
              integration: { branchName: worktree.branchName }
            }
          ]
        },
        currentIssues: [baseIssue()],
        currentPullRequests: [],
        currentComments: [],
        contextBuilder: new DefaultContextBuilder(),
        now: "2026-04-18T10:05:00.000Z"
      });

      const reopenedTask = tasks.find((task) => task.kind === "write_product_spec");
      assert.equal(reopenedTask?.status, "pending");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reconcileTaskState promotes Product Specification after the spec artifact exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-product-spec-written-"));
    try {
      const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
      const specPath = path.join(tempDir, "issue-17-product-spec.md");
      await writeFile(specPath, "# Product Spec\n\nApproved direction.\n", "utf8");
      const worktree: WorktreeRecord = baseWorktree({
        id: "issue-wt-1",
        status: "product_specification",
        productSpecDocumentPath: specPath
      });
      delete worktree.packet;
      const task = completedProductSpecTask(worktree);

      const reconciled = service.reconcileTaskState([worktree], [task]);

      assert.equal(reconciled[0]?.status, "planning");
      assert.equal(reconciled[0]?.productSpecWrittenAt, task.updatedAt);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reconcileTaskState preserves written Product Spec state after the completed spec task ages out", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-product-spec-durable-"));
    try {
      const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
      const specPath = path.join(tempDir, "issue-17-product-spec.md");
      await writeFile(specPath, "# Product Spec\n\nApproved direction.\n", "utf8");
      const worktree: WorktreeRecord = baseWorktree({
        id: "issue-wt-1",
        status: "awaiting_plan_approval",
        productSpecDocumentPath: specPath,
        productSpecWrittenAt: "2026-04-18T10:01:00.000Z"
      });
      delete worktree.packet;
      const writePlanTask: TaskRecord = {
        ...completedProductSpecTask(worktree),
        id: `task:write_plan:worktree:${worktree.id}`,
        kind: "write_plan",
        status: "completed"
      };

      const reconciled = service.reconcileTaskState([worktree], [writePlanTask]);

      assert.equal(reconciled[0]?.status, "awaiting_plan_approval");
      assert.equal(reconciled[0]?.productSpecWrittenAt, "2026-04-18T10:01:00.000Z");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

    test("reconcileTaskState associates worktree-scoped implement_plan task and moves status to implementing", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const worktree: WorktreeRecord = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "implementation_ready"
    });

    const implementTask: TaskRecord = {
      id: "task:implement_plan:worktree:packet-wt-1",
      kind: "implement_plan",
      status: "dispatched", // or "completed" or "failed"
      executionPermission: "workspace-write",
      handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
      repoId: "repo-1",
      repoName: "repo-one",
      repoSlug: "eladaviv/repo-one",
      sourceKind: "issue",
      sourceId: "issue:eladaviv/repo-one:17",
      sourceUrl: "https://github.com/eladaviv/repo-one/issues/17",
      relevant: true,
      reason: "reason",
      summary: "summary",
      context: {
        repoIdentifier: "eladaviv/repo-one",
        instruction: "instruction",
        labels: []
      },
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:01:00.000Z"
    };

    const reconciled = service.reconcileTaskState([worktree], [implementTask]);

    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.id, worktree.id);
    assert.equal(reconciled[0]?.status, "implementing", "Dispatched implement_plan task should move worktree to implementing");
    });

    test("reconcileTaskState moves completed packet implement_plan task to implementation_done", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const worktree: WorktreeRecord = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "implementing"
    });

    const implementTask: TaskRecord = {
      id: "task:implement_plan:worktree:packet-wt-1",
      kind: "implement_plan",
      status: "completed",
      executionPermission: "workspace-write",
      handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
      repoId: "repo-1",
      repoName: "repo-one",
      repoSlug: "eladaviv/repo-one",
      sourceKind: "issue",
      sourceId: "issue:eladaviv/repo-one:17",
      sourceUrl: "https://github.com/eladaviv/repo-one/issues/17",
      relevant: true,
      reason: "reason",
      summary: "summary",
      context: {
        repoIdentifier: "eladaviv/repo-one",
        localRepoPath: worktree.path,
        instruction: "instruction",
        labels: []
      },
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:01:00.000Z"
    };

    const reconciled = service.reconcileTaskState([worktree], [implementTask]);

    assert.equal(reconciled[0]?.status, "implementation_done");
    });

    test("reconcileTaskState moves completed normal PR implement_plan task to implementation_done by worktree path", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const worktree: WorktreeRecord = baseWorktree({
      id: "issue-wt-1",
      status: "implementing"
    });
    delete worktree.packet;

    const implementTask: TaskRecord = {
      id: "task:implement_plan:pull_request:eladaviv/repo-one:23",
      kind: "implement_plan",
      status: "completed",
      executionPermission: "workspace-write",
      handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
      repoId: "repo-1",
      repoName: "repo-one",
      repoSlug: "eladaviv/repo-one",
      sourceKind: "pull_request",
      sourceId: "pull_request:eladaviv/repo-one:23",
      sourceUrl: "https://github.com/eladaviv/repo-one/pull/23",
      relevant: true,
      reason: "reason",
      summary: "summary",
      context: {
        repoIdentifier: "eladaviv/repo-one",
        localRepoPath: worktree.path,
        instruction: "instruction",
        labels: []
      },
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:01:00.000Z"
    };

    const reconciled = service.reconcileTaskState([worktree], [implementTask]);

    assert.equal(reconciled[0]?.status, "implementation_done");
    });

    test("reconcileTaskState keeps failed implement_plan task retryable and not implementation_done", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const worktree: WorktreeRecord = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "implementing"
    });

    const implementTask: TaskRecord = {
      id: "task:implement_plan:worktree:packet-wt-1",
      kind: "implement_plan",
      status: "failed",
      executionPermission: "workspace-write",
      handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
      repoId: "repo-1",
      repoName: "repo-one",
      repoSlug: "eladaviv/repo-one",
      sourceKind: "issue",
      sourceId: "issue:eladaviv/repo-one:17",
      sourceUrl: "https://github.com/eladaviv/repo-one/issues/17",
      relevant: true,
      reason: "reason",
      summary: "summary",
      context: {
        repoIdentifier: "eladaviv/repo-one",
        localRepoPath: worktree.path,
        instruction: "instruction",
        labels: []
      },
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:01:00.000Z"
    };

    const reconciled = service.reconcileTaskState([worktree], [implementTask]);

    assert.equal(reconciled[0]?.status, "implementing");
    });

    test("reconcileTaskState associates worktree-scoped implement_plan task and keeps status implementation_ready when pending", () => {
    const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
    const worktree: WorktreeRecord = baseWorktree({
      id: "packet-wt-1",
      packet: {
        parentWorkstreamId: "repo-1:issue:17",
        packetId: "T1",
        waveIndex: 0,
        parentIntegrationBranch: "agent/eladaviv-repo-one/issue-17"
      },
      status: "implementation_ready"
    });

    const implementTask: TaskRecord = {
      id: "task:implement_plan:worktree:packet-wt-1",
      kind: "implement_plan",
      status: "pending",
      executionPermission: "workspace-write",
      handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
      repoId: "repo-1",
      repoName: "repo-one",
      repoSlug: "eladaviv/repo-one",
      sourceKind: "issue",
      sourceId: "issue:eladaviv/repo-one:17",
      sourceUrl: "https://github.com/eladaviv/repo-one/issues/17",
      relevant: true,
      reason: "reason",
      summary: "summary",
      context: {
        repoIdentifier: "eladaviv/repo-one",
        instruction: "instruction",
        labels: []
      },
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:01:00.000Z"
    };

    const reconciled = service.reconcileTaskState([worktree], [implementTask]);

    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.id, worktree.id);
    assert.equal(reconciled[0]?.status, "implementation_ready", "Pending implement_plan task should keep worktree in implementation_ready");
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
    syncedAt: "2026-04-18T10:00:00.000Z",
    message: "ok"
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
    title: "Need plan-first workflow",
    body: "Plan first",
    labels: [],
    author: "owner",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z",
    lastSeenAt: "2026-04-18T10:00:00.000Z",
    state: "open"
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

function completedProductSpecTask(worktree: WorktreeRecord): TaskRecord {
  return {
    id: `task:write_product_spec:worktree:${worktree.id}`,
    kind: "write_product_spec",
    status: "completed",
    executionPermission: "workspace-write",
    handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
    repoId: worktree.repoId,
    repoName: worktree.repoName,
    repoSlug: worktree.repoSlug,
    sourceKind: "issue",
    sourceId: worktree.issueId ?? "issue:eladaviv/repo-one:17",
    sourceUrl: "https://github.com/eladaviv/repo-one/issues/17",
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: worktree.repoSlug,
      localRepoPath: worktree.path,
      ...(worktree.productSpecDocumentPath ? { productSpecDocumentPath: worktree.productSpecDocumentPath } : {}),
      instruction: "instruction",
      labels: []
    },
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:01:00.000Z"
  };
}

function baseIssueWorkstreamWithPlan(): WorkstreamRecord {
  return {
    id: "repo-1:issue:17",
    repoKey: "repo-1",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [],
    phase: "planning",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: { branchName: "agent/eladaviv-repo-one/issue-17" },
    packetPlan: {
      status: "proposed",
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
          status: "planned"
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    }
  };
}

function baseGhPullRequest(number: number): GhPullRequestSummary {
  return {
    id: `pull_request:${number}`,
    number,
    title: `PR ${number}`,
    body: "body",
    url: `https://github.com/eladaviv/repo-one/pull/${number}`,
    state: "OPEN",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z",
    author: { login: "owner" },
    labels: [],
    headRefName: "feature",
    headSha: "abc123",
    baseRefName: "main",
    isDraft: false
  };
}

function basePullRequestForWorktree(
  worktree: WorktreeRecord,
  repo: RepoConfig
): NormalizedPullRequest {
  return {
    kind: "pull_request",
    id: worktree.prId ?? "pull_request:101",
    repoId: repo.id,
    repoKey: `${repo.owner}/${repo.name}`,
    repoOwner: repo.owner,
    repoName: repo.name,
    repoSlug: `${repo.owner}/${repo.name}`,
    number: worktree.prNumber ?? 101,
    key: `${repo.owner}/${repo.name}:pull_request:${worktree.prNumber ?? 101}`,
    sourceId: "PR_101",
    url: worktree.prUrl ?? `https://github.com/${repo.owner}/${repo.name}/pull/101`,
    title: "PR Title",
    body: "PR Body",
    labels: [],
    author: "owner",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z",
    lastSeenAt: "2026-04-18T10:00:00.000Z",
    state: "open",
    headBranch: worktree.branchName,
    headSha: "abc123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false
  };
}

class FakeGitGateway implements GitGateway {
  async resetHard() {}
  async cleanUntrackedFiles() {}
  async cloneRepository(): Promise<void> {}
  async fetchRepository(): Promise<void> {}
  async getCurrentBranch(): Promise<string | null> {
    return "main";
  }
  async getRemoteDefaultBranch(): Promise<string> {
    return "main";
  }
  async isWorkingTreeClean(): Promise<boolean> {
    return true;
  }
  async ensureDefaultBranchCheckedOut(): Promise<void> {}
  async fastForwardDefaultBranch(): Promise<void> {}
  validatePathWithinCodeRoot(codeRoot: string, candidatePath: string): string {
    const resolved = path.resolve(codeRoot, candidatePath);
    const relative = path.relative(path.resolve(codeRoot), resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("escape");
    }
    return resolved;
  }
  async createWorktree(
    _repoPath: string,
    codeRoot: string,
    worktreePath: string
  ): Promise<string> {
    const resolved = this.validatePathWithinCodeRoot(codeRoot, worktreePath);
    await mkdir(resolved, { recursive: true });
    return resolved;
  }
  async hasCommitsAhead(): Promise<boolean> {
    return false;
  }
  async commitAll(_localRepoPath: string, _message: string): Promise<boolean> {
    return true;
  }
  async pushBranch(): Promise<void> {}
  async checkoutBranch(): Promise<void> {}
  async mergeRemoteBranch(): Promise<void> {}
  async abortMerge(): Promise<void> {}
  async abortRebase(): Promise<void> {}
  async abortCherryPick(): Promise<void> {}
  async abortRevert(): Promise<void> {}
  async isInsideWorkingTree(): Promise<boolean> {
    return true;
  }
  async pullFastForwardOnly(): Promise<void> {}
  async getHeadCommitSha(): Promise<string> {
    return "abc123456789";
  }

  async cloneRepositoryFromUrl(): Promise<void> {}
  async checkoutBranchAtRemote(_path?: string, _branch?: string, _options?: { skipFetch?: boolean }): Promise<void> {}
  async getAheadBehindVsRemote(): Promise<{ ahead: number; behind: number }> {
    return { ahead: 0, behind: 0 };
  }
  async isAncestorOf(): Promise<boolean> { return true; }
  async countCommitsAheadOf(): Promise<number> { return 0; }
  async getActiveMergeState(): Promise<"none" | "merging" | "rebasing" | "cherry-picking" | "reverting"> {
    return "none";
  }
  async pushWithLease(): Promise<void> {}
  async removeDirectory(): Promise<void> {}
  async getCommitLogSince(): Promise<string> { return ""; }
  async getDiffStatSince(): Promise<string> { return ""; }

  async listWorktrees(_repoPath: string): Promise<{ path: string; branch: string }[]> {
    return [];
  }

  async getWorktreeForBranch(_repoPath: string, _branch: string): Promise<string | null> {
    return null;
  }

  async compareBranchSyncStatus(
    _localPath: string,
    parentBranch: string,
    defaultBranch: string
  ): Promise<BranchSyncComparison> {
    return {
      parentBranch,
      defaultBranch,
      parentRef: `refs/remotes/origin/${parentBranch}`,
      defaultRef: `refs/remotes/origin/${defaultBranch}`,
      status: "up_to_date",
      parentAheadCount: 0,
      parentBehindCount: 0,
      message: "Parent branch contains the default branch."
    };
  }
}

class RecordingGitGateway extends FakeGitGateway {
  createWorktreeCalls = 0;
  override async createWorktree(
    _repoPath: string,
    codeRoot: string,
    worktreePath: string
  ): Promise<string> {
    this.createWorktreeCalls += 1;
    return super.createWorktree(_repoPath, codeRoot, worktreePath);
  }
}

class FakeGitHubGateway implements GitHubGateway {
  async getRepositoryMetadata(): Promise<GitHubRepositoryMetadata> {
    return {
      id: "repo-meta",
      owner: "eladaviv",
      name: "repo-one",
      nameWithOwner: "eladaviv/repo-one",
      url: "https://github.com/eladaviv/repo-one",
      defaultBranch: "main"
    };
  }
  async getRepositoryDefaultBranch(): Promise<string> {
    return "main";
  }
  async getIssue(_owner: string, _name: string, issueNumber: number): Promise<GhIssueSummary> {
    return {
      id: `issue:${issueNumber}`,
      number: issueNumber,
      title: "Issue",
      body: "Body",
      url: `https://github.com/eladaviv/repo-one/issues/${issueNumber}`,
      state: "OPEN",
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:00:00.000Z",
      author: { login: "owner" },
      labels: []
    };
  }
  async getPullRequest(_owner: string, _name: string, prNumber: number): Promise<GhPullRequestSummary> {
    return {
      id: `pull_request:${prNumber}`,
      number: prNumber,
      title: "PR",
      body: "Body",
      url: `https://github.com/eladaviv/repo-one/pull/${prNumber}`,
      state: "OPEN",
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:00:00.000Z",
      author: { login: "owner" },
      labels: [],
      headRefName: "feature/test",
      headSha: "abc123",
      baseRefName: "main",
      isDraft: false
    };
  }
  async findOpenPullRequestByHeadBranch(): Promise<GhPullRequestSummary | null> {
    return null;
  }
  async createPullRequest(options: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<GhPullRequestSummary> {
    return {
      id: "pull_request:eladaviv/repo-one:101",
      number: 101,
      title: options.title,
      body: options.body,
      url: "https://github.com/eladaviv/repo-one/pull/101",
      state: "OPEN",
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:00:00.000Z",
      author: { login: "owner" },
      labels: [],
      headRefName: options.headBranch,
      headSha: "",
      baseRefName: options.baseBranch,
      isDraft: false
    };
  }
  async listOpenIssues(): Promise<GhIssueSummary[]> {
    return [];
  }
  async searchCode(): Promise<GhSearchCodeResult> {
    return {
      totalCount: 0,
      incompleteResults: false,
      items: []
    };
  }
  async postIssueComment(): Promise<GhIssueCommentMutationResult> {
    return {
      id: 1,
      url: "https://github.com/eladaviv/repo-one/issues/17#issuecomment-1",
      body: "comment",
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:00:00.000Z",
      author: { login: "owner" }
    };
  }
  async updateIssueComment(input: { body: string }): Promise<GhIssueCommentMutationResult> {
    return {
      id: 1,
      url: "https://github.com/eladaviv/repo-one/issues/17#issuecomment-1",
      body: input.body,
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:00:00.000Z",
      author: { login: "owner" }
    };
  }
  async postPullRequestReviewCommentReply(): Promise<GhPullRequestReviewCommentReplyResult> {
    return {
      id: 2,
      url: "https://github.com/eladaviv/repo-one/pull/17#discussion_r2",
      body: "🤖 reply",
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:00:00.000Z",
      author: { login: "owner" }
    };
  }
  async submitPullRequestReview(): Promise<GhPullRequestReviewSubmissionResult> {
    return {
      id: 3,
      url: "https://github.com/eladaviv/repo-one/pull/17#pullrequestreview-3",
      body: "🤖 Review submitted.",
      state: "COMMENTED",
      submittedAt: "2026-04-18T10:00:00.000Z",
      author: { login: "owner" }
    };
  }
  async listOpenPullRequests(): Promise<GhPullRequestSummary[]> {
    return [];
  }
  async listIssueComments(): Promise<GhComment[]> {
    return [];
  }
  async listPullRequestComments(): Promise<GhComment[]> {
    return [];
  }
  async listPullRequestReviews(): Promise<GhPullRequestReview[]> {
    return [];
  }
  async listPullRequestReviewComments(): Promise<GhPullRequestReviewComment[]> {
    return [];
  }
  async listPullRequestChangedFiles(): Promise<GhPullRequestChangedFile[]> {
    return [];
  }
  async listIssueEvents(): Promise<GhIssueEvent[]> {
    return [];
  }
  async listPullRequestCheckRuns(): Promise<GhCheckRun[]> {
    return [];
  }
  async addReaction(): Promise<void> {}
}

test("finalizePushableHandoffs skips completed prepare_pr_for_merge tasks", async () => {
  const gitGateway = new CountingGitGateway();
  const service = new ImplementationWorkflowService(gitGateway, new FakeGitHubGateway());

  const worktree: WorktreeRecord = baseWorktree({
    id: "wt-prepare",
    path: "/tmp/code-root/repo-one/prepare",
    branchName: "feature/prepare",
    prNumber: 42
  });

  const task: TaskRecord = {
    id: "task:prepare:42",
    kind: "prepare_pr_for_merge",
    status: "completed",
    executionPermission: "workspace-write",
    handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    sourceKind: "pull_request",
    sourceId: "pr:42",
    sourceUrl: "https://github.com/eladaviv/repo-one/pull/42",
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: "eladaviv/repo-one",
      localRepoPath: worktree.path,
      branchName: worktree.branchName,
      instruction: "instruction",
      labels: []
    },
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:01:00.000Z"
  };

  // Simulate dirty working tree
  gitGateway.clean = false;

  const result = await service.finalizePushableHandoffs([worktree], [task]);

  assert.equal(gitGateway.commitCalls, 0, "Should NOT commit merge-prep tasks in finalizePushableHandoffs");
  assert.equal(gitGateway.pushCalls, 0, "Should NOT push merge-prep tasks in finalizePushableHandoffs");
  assert.equal(result[0]?.branchPushedAt, undefined);
});

class CountingGitGateway extends FakeGitGateway {
  commitCalls = 0;
  pushCalls = 0;
  lastCommitMessage = "";
  clean = true;

  override async isWorkingTreeClean(): Promise<boolean> {
    return this.clean;
  }

  override async commitAll(_repoPath: string, message: string): Promise<boolean> {
    this.commitCalls += 1;
    this.lastCommitMessage = message;
    return true;
  }

  override async pushBranch(): Promise<void> {
    this.pushCalls += 1;
  }

  override async hasCommitsAhead(): Promise<boolean> {
    return true;
  }
}

class RecordingGitHubGateway extends FakeGitHubGateway {
  createPullRequestCalls = 0;
  lastCreatePullRequestOptions?: Parameters<GitHubGateway["createPullRequest"]>[0];
  updateIssueCommentCalls = 0;
  lastUpdateIssueCommentOptions?: Parameters<GitHubGateway["updateIssueComment"]>[0];

  constructor(
    private readonly fixtures: {
      existingPullRequest?: GhPullRequestSummary;
    } = {}
  ) {
    super();
  }

  override async findOpenPullRequestByHeadBranch(): Promise<GhPullRequestSummary | null> {
    return this.fixtures.existingPullRequest ?? null;
  }

  override async createPullRequest(options: Parameters<GitHubGateway["createPullRequest"]>[0]): Promise<GhPullRequestSummary> {
    this.createPullRequestCalls += 1;
    this.lastCreatePullRequestOptions = options;
    return super.createPullRequest(options);
  }

  override async updateIssueComment(options: Parameters<GitHubGateway["updateIssueComment"]>[0]): Promise<GhIssueCommentMutationResult> {
    this.updateIssueCommentCalls += 1;
    this.lastUpdateIssueCommentOptions = options;
    return super.updateIssueComment(options);
  }
}

class FailingOnceGitHubGateway extends RecordingGitHubGateway {
  private shouldFailCreatePullRequest = true;

  override async createPullRequest(options: Parameters<GitHubGateway["createPullRequest"]>[0]): Promise<GhPullRequestSummary> {
    if (this.shouldFailCreatePullRequest) {
      this.shouldFailCreatePullRequest = false;
      this.createPullRequestCalls += 1;
      this.lastCreatePullRequestOptions = options;
      throw new Error("temporary PR creation failure");
    }

    return super.createPullRequest(options);
  }
}

test("reconcilePacketWorktreeReadinessFromProjections closes packet worktree if parent workstream is inactive (abandoned/resolved) or linked packet PR is closed/merged", () => {
  const service = new ImplementationWorkflowService(new FakeGitGateway(), new FakeGitHubGateway());
  const repo = baseRepo();

  // Test 1: Parent workstream is abandoned
  const packetWorktree1 = baseWorktree({
    id: "packet-wt-1",
    packet: {
      parentWorkstreamId: "eladaviv/repo-one:issue:97",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-97"
    },
    status: "planning"
  });
  const abandonedWorkstream = baseIssueWorkstreamWithPlan();
  abandonedWorkstream.id = "eladaviv/repo-one:issue:97";
  abandonedWorkstream.phase = "abandoned";

  const reconciled1 = service.reconcilePacketWorktreeReadinessFromProjections(
    [packetWorktree1],
    [],
    [repo],
    [],
    [abandonedWorkstream],
    []
  );
  assert.equal(reconciled1[0]?.status, "closed", "Should close worktree when parent is abandoned");

  // Test 2: Linked packet PR is closed (projection state closed)
  const packetWorktree2 = baseWorktree({
    id: "packet-wt-2",
    packet: {
      parentWorkstreamId: "eladaviv/repo-one:issue:98",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-98"
    },
    status: "planning"
  });
  const activeWorkstream = baseIssueWorkstreamWithPlan();
  activeWorkstream.id = "eladaviv/repo-one:issue:98";
  activeWorkstream.phase = "planning";

  const closedPr: NormalizedPullRequest = {
    ...basePullRequestForWorktree(packetWorktree2, repo),
    number: 102,
    state: "closed"
  };
  const projection: import("../src/workstreams/packet-projections.js").PacketPullRequestProjection = {
    pullRequest: closedPr,
    parentWorkstream: activeWorkstream,
    packet: activeWorkstream.packetPlan!.packets["T1"]!,
    packetWorktree: packetWorktree2,
    parentIntegrationBranch: "agent/eladaviv-repo-one/issue-98"
  };

  const reconciled2 = service.reconcilePacketWorktreeReadinessFromProjections(
    [packetWorktree2],
    [projection],
    [repo],
    [],
    [activeWorkstream],
    []
  );
  assert.equal(reconciled2[0]?.status, "closed", "Should close worktree when linked packet PR projection is closed");

  // Test 3: Linked packet PR is closed (absent from pullRequests list)
  const packetWorktree3 = baseWorktree({
    id: "packet-wt-3",
    packet: {
      parentWorkstreamId: "eladaviv/repo-one:issue:99",
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: "agent/eladaviv-repo-one/issue-99"
    },
    status: "planning",
    prNumber: 103
  });
  const activeWorkstream2 = baseIssueWorkstreamWithPlan();
  activeWorkstream2.id = "eladaviv/repo-one:issue:99";
  activeWorkstream2.phase = "planning";

  const reconciled3 = service.reconcilePacketWorktreeReadinessFromProjections(
    [packetWorktree3],
    [],
    [repo],
    [],
    [activeWorkstream2],
    [] // Empty scan list of open PRs (so prNumber 103 is absent/closed)
  );
  assert.equal(reconciled3[0]?.status, "closed", "Should close worktree when prNumber is defined but absent from scan list");
});
