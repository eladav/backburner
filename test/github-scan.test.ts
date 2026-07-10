import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DefaultContextBuilder } from "../src/context/types.js";
import type { NormalizedComment, NormalizedPullRequest } from "../src/domain/entities.js";
import { deriveAttentionRecords } from "../src/attention/derive.js";
import { normalizeIssue, normalizeIssueComments, createCommentId, createEntityId, createEntityKey } from "../src/github/normalize.js";
import { GitHubScanService } from "../src/github/service.js";
import { SecurityFilteredGitHubGateway } from "../src/github/security.js";
import { StateStore } from "../src/state/loader.js";
import type { PersistedState, RepoScanFailure, RepoSyncRecord, WorkstreamRecord, WorktreeRecord } from "../src/state/types.js";
import { deriveTasks } from "../src/tasks/derive.js";
import { deriveWorkstreams } from "../src/workstreams/derive.js";
import type {
  GhComment,
  GhIssueCommentMutationResult,
  GhIssueSummary,
  GhPullRequestReview,
  GhPullRequestReviewCommentReplyResult,
  GhPullRequestReviewSubmissionResult,
  GhPullRequestReviewComment,
  GhPullRequestChangedFile,
  GhPullRequestSummary,
  GhSearchCodeResult,
  GitHubGateway,
  GitHubRepositoryMetadata,
  GhIssueEvent,
  GhCheckRun
} from "../src/github/types.js";
import type { RepoConfig } from "../src/config/types.js";

test("normalization generates repo-qualified ids and carries local timestamps", () => {
  const repo = baseRepo();
  const metadata = baseMetadata();
  const previousState = baseState();
  const seenAt = "2026-04-18T09:00:00.000Z";
  const issue = sampleIssue();
  const issueComments = normalizeIssueComments(
    [sampleIssueComment()],
    issue.number,
    "issue",
    "issue_comment",
    {
      repo,
      repoMetadata: metadata,
      seenAt,
      previousIssues: new Map([
        [
          createEntityId("issue", metadata.nameWithOwner, issue.number),
          {
            ...previousState.issues[0]!,
            id: createEntityId("issue", metadata.nameWithOwner, issue.number)
          }
        ]
      ]),
      previousPullRequests: new Map(),
      previousComments: new Map([
        [
          createCommentId(metadata.nameWithOwner, "issue_comment", "3001"),
          {
            ...previousState.comments[0]!,
            id: createCommentId(metadata.nameWithOwner, "issue_comment", "3001")
          }
        ]
      ])
    }
  );

  const normalizedIssue = normalizeIssue(issue, issueComments, {
    repo,
    repoMetadata: metadata,
    seenAt,
    previousIssues: new Map([
      [
        createEntityId("issue", metadata.nameWithOwner, issue.number),
        {
          ...previousState.issues[0]!,
          id: createEntityId("issue", metadata.nameWithOwner, issue.number)
        }
      ]
    ]),
    previousPullRequests: new Map(),
    previousComments: new Map()
  });

  assert.equal(createEntityKey("issue", metadata.nameWithOwner, 7), "example-org/repo-one:issue:7");
  assert.equal(issueComments[0]?.id, "comment:example-org/repo-one:issue_comment:3001");
  assert.equal(issueComments[0]?.lastHandledAt, "2026-04-18T07:10:00.000Z");
  assert.equal(normalizedIssue.id, "issue:example-org/repo-one:7");
  assert.equal(normalizedIssue.lastHandledAt, "2026-04-18T07:00:00.000Z");
  assert.equal(normalizedIssue.lastCommentAt, "2026-04-18T08:30:00.000Z");
});

test("PR top-level comments normalize with numeric reactionTargetId from REST source", () => {
  const repo = baseRepo();
  const metadata = baseMetadata();
  const seenAt = "2026-05-03T12:00:00Z";

  const rawComments: GhComment[] = [
    {
      id: "12345", // numeric REST ID as string
      url: "https://github.com/owner/repo/pull/13#issuecomment-12345",
      body: "PR top-level comment",
      createdAt: "2026-05-03T10:00:00Z",
      updatedAt: "2026-05-03T10:00:00Z",
      author: { login: "commenter" }
    }
  ];

  const normalized = normalizeIssueComments(
    rawComments,
    13,
    "pull_request",
    "pull_request_comment",
    {
      repo,
      repoMetadata: metadata,
      seenAt,
      previousIssues: new Map(),
      previousPullRequests: new Map(),
      previousComments: new Map()
    }
  );

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.reactionTargetId, "12345");
  assert.equal(normalized[0]?.sourceId, "12345");
});

test("GitHubScanService handles empty results and per-repo failures without aborting", async () => {
  const repoOne = baseRepo();
  const repoTwo = {
    ...baseRepo(),
    id: "repo-2",
    name: "repo-two",
    localPath: "repo-two"
  };

  const repoResults = [baseRepoResult(repoOne), baseRepoResult(repoTwo)];
  const gateway = new FakeGitHubGateway({
    repoMetadata: new Map([
      ["example-org/repo-one", baseMetadata()],
      [
        "example-org/repo-two",
        {
          ...baseMetadata(),
          id: "REPO_2",
          name: "repo-two",
          nameWithOwner: "example-org/repo-two",
          url: "https://github.com/example-org/repo-two"
        }
      ]
    ]),
    issues: new Map([
      ["example-org/repo-one", [sampleIssue()]],
      ["example-org/repo-two", []]
    ]),
    pullRequests: new Map([
      ["example-org/repo-one", [samplePullRequest()]],
      ["example-org/repo-two", []]
    ]),
    issueComments: new Map([["example-org/repo-one#7", []]]),
    pullRequestComments: new Map([["example-org/repo-one#13", [samplePullRequestComment()]]]),
    pullRequestReviews: new Map([["example-org/repo-one#13", [samplePullRequestReview()]]]),
    pullRequestReviewComments: new Map(),
    failures: [
      {
        repoSlug: "example-org/repo-two",
        step: "list_issues",
        message: "gh issue list failed"
      }
    ]
  });

  const securedGateway = new SecurityFilteredGitHubGateway(gateway, ["owner", "reviewer"]);
  const service = new GitHubScanService(securedGateway, () => "2026-04-18T09:10:00.000Z");
  const result = await service.scanRepositories([repoOne, repoTwo], repoResults, baseState());

  assert.equal(result.issues.length, 1);
  assert.equal(result.prs.length, 1);
  assert.equal(result.comments.length, 2);
  assert.equal(result.repoResults[0]?.githubScan?.status, "scanned");
  assert.equal(result.repoResults[1]?.githubScan?.status, "failed");
  assert.equal(result.failures.length, 1);
});

test("SecurityFilteredGitHubGateway filters out labels applied by unauthorized actors", async () => {
  const repo = baseRepo();
  const metadata = baseMetadata();
  const pr = {
    ...samplePullRequest(),
    labels: [
      { name: "agent-plan-approved" },
      { name: "other-label" }
    ]
  };

  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([[metadata.nameWithOwner, metadata]]),
    pullRequests: new Map([[metadata.nameWithOwner, [pr]]])
  });

  gateway.listIssueEvents = async (owner, name, issueNumber) => {
    return [
      {
        event: "labeled",
        createdAt: "2026-04-18T08:15:00.000Z",
        actor: { login: "malicious-user" },
        label: { name: "agent-plan-approved" }
      },
      {
        event: "labeled",
        createdAt: "2026-04-18T08:20:00.000Z",
        actor: { login: "owner" },
        label: { name: "other-label" }
      }
    ];
  };

  const securedGateway = new SecurityFilteredGitHubGateway(gateway, ["owner"]);
  
  const filteredPr = await securedGateway.getPullRequest(metadata.owner, metadata.name, pr.number);
  
  assert.equal(filteredPr.labels.length, 1);
  assert.equal(filteredPr.labels[0]?.name, "other-label");
});

test("GitHubScanService populates defaultBranch and baseClassification for pull requests", async () => {
  const repo = baseRepo();
  const metadata = {
    ...baseMetadata(),
    defaultBranch: "production"
  };
  const pr = {
    ...samplePullRequest(),
    baseRefName: "production"
  };

  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([[metadata.nameWithOwner, metadata]]),
    pullRequests: new Map([[metadata.nameWithOwner, [pr]]])
  });

  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");
  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], baseState());

  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0]?.baseBranch, "production");
  assert.equal(result.prs[0]?.defaultBranch, "production");
  assert.equal(result.prs[0]?.baseClassification, "top_level");
});

test("GitHubScanService handles non-default branch pull requests correctly", async () => {
  const repo = baseRepo();
  const metadata = baseMetadata(); // defaultBranch is "main"
  const pr = {
    ...samplePullRequest(),
    baseRefName: "workstream/issue-72"
  };

  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([[metadata.nameWithOwner, metadata]]),
    pullRequests: new Map([[metadata.nameWithOwner, [pr]]])
  });

  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");
  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], baseState());

  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0]?.baseBranch, "workstream/issue-72");
  assert.equal(result.prs[0]?.defaultBranch, "main");
  assert.equal(result.prs[0]?.baseClassification, "non_default_parent");
});

test("GitHubScanService direct-fetches tracked packet PRs missing from open PR scan", async () => {
  const repo = baseRepo();
  const metadata = baseMetadata();
  const parentPr = {
    ...samplePullRequest(),
    number: 100,
    id: "PR_100",
    url: "https://github.com/example-org/repo-one/pull/100",
    headRefName: "agent/example-org-repo-one/issue-7"
  };
  const mergedPacketPr = {
    ...samplePullRequest(),
    number: 101,
    id: "PR_101",
    url: "https://github.com/example-org/repo-one/pull/101",
    state: "MERGED" as const,
    headRefName: "agent/example-org-repo-one/workstream-issue-7/packet-t1",
    baseRefName: "agent/example-org-repo-one/issue-7"
  };
  const unrelatedMergedPr = {
    ...samplePullRequest(),
    number: 202,
    id: "PR_202",
    url: "https://github.com/example-org/repo-one/pull/202",
    state: "MERGED" as const,
    headRefName: "untracked/merged"
  };
  const previousState = stateWithTrackedPacketPullRequest(101);
  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([[metadata.nameWithOwner, metadata]]),
    pullRequests: new Map([[metadata.nameWithOwner, [parentPr, mergedPacketPr, unrelatedMergedPr]]])
  });

  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");
  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.deepEqual(gateway.getPullRequestCalls, [{ repoSlug: "example-org/repo-one", prNumber: 101 }]);
  assert.deepEqual(result.prs.map((pr) => pr.number), [100, 101]);
  assert.equal(result.prs.find((pr) => pr.number === 101)?.state, "merged");
  assert.equal(result.prs.find((pr) => pr.number === 101)?.baseBranch, "agent/example-org-repo-one/issue-7");
});

test("GitHubScanService does not direct-fetch untracked closed pull requests", async () => {
  const repo = baseRepo();
  const metadata = baseMetadata();
  const closedUntrackedPr = {
    ...samplePullRequest(),
    number: 202,
    id: "PR_202",
    state: "CLOSED" as const,
    headRefName: "untracked/closed"
  };
  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([[metadata.nameWithOwner, metadata]]),
    pullRequests: new Map([[metadata.nameWithOwner, [closedUntrackedPr]]])
  });

  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");
  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], baseState());

  assert.deepEqual(gateway.getPullRequestCalls, []);
  assert.deepEqual(result.prs, []);
});

test("GitHubScanService does not direct-fetch packet PRs already marked merged_to_parent", async () => {
  const repo = baseRepo();
  const metadata = baseMetadata();
  const alreadyMergedPr = {
    ...samplePullRequest(),
    number: 101,
    id: "PR_101",
    state: "MERGED" as const,
    headRefName: "agent/example-org-repo-one/workstream-issue-7/packet-t1"
  };
  const previousState = stateWithTrackedPacketPullRequest(101);
  previousState.workstreams[0]!.packetPlan!.packets.T1!.status = "merged_to_parent";
  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([[metadata.nameWithOwner, metadata]]),
    pullRequests: new Map([[metadata.nameWithOwner, [alreadyMergedPr]]])
  });

  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");
  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.deepEqual(gateway.getPullRequestCalls, []);
  assert.deepEqual(result.prs.map((pr) => pr.number), []);
});

test("GitHubScanService records failure for tracked missing PR direct-fetch without aborting scan", async () => {
  const repo = baseRepo();
  const metadata = baseMetadata();
  const previousState = stateWithTrackedPacketPullRequest(101);
  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([[metadata.nameWithOwner, metadata]]),
    failures: [
      {
        repoSlug: metadata.nameWithOwner,
        step: "get_pull_request",
        scope: "pull_request#101",
        message: "not found"
      }
    ]
  });

  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");
  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.deepEqual(gateway.getPullRequestCalls, [{ repoSlug: "example-org/repo-one", prNumber: 101 }]);
  assert.equal(result.prs.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.step, "get_pull_request");
  assert.equal(result.repoResults[0]?.githubScan?.status, "failed");
});

test("GitHubScanService carries forward repo entities when repository metadata fails", async () => {
  const repo = baseRepo();
  const previousState = stateWithPullRequest();
  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    failures: [{ repoSlug: "example-org/repo-one", step: "repo_metadata", message: "repo metadata failed" }]
  });
  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");

  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.deepEqual(result.issues.map((issue) => issue.id), previousState.issues.map((issue) => issue.id));
  assert.deepEqual(result.prs.map((pr) => pr.id), previousState.prs.map((pr) => pr.id));
  assert.deepEqual(result.comments.map((comment) => comment.id), previousState.comments.map((comment) => comment.id));
  assert.equal(result.repoResults[0]?.githubScan?.status, "failed");
  assert.equal(result.failures[0]?.step, "repo_metadata");
});

test("GitHubScanService carries forward previous issues and issue comments when issue listing fails", async () => {
  const repo = baseRepo();
  const previousState = baseState();
  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    failures: [{ repoSlug: "example-org/repo-one", step: "list_issues", message: "issue list failed" }]
  });
  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");

  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.deepEqual(result.issues.map((issue) => issue.id), previousState.issues.map((issue) => issue.id));
  assert.deepEqual(result.comments.map((comment) => comment.id), previousState.comments.map((comment) => comment.id));
  assert.equal(result.repoResults[0]?.githubScan?.status, "partial");
  assert.equal(result.failures[0]?.step, "list_issues");
});

test("GitHubScanService carries forward only issue comments for the issue whose comment fetch failed", async () => {
  const repo = baseRepo();
  const previousState = {
    ...baseState(),
    comments: [
      ...baseState().comments,
      {
        ...baseState().comments[0]!,
        id: "comment:example-org/repo-one:issue_comment:unrelated",
        sourceId: "unrelated",
        parentNumber: 99,
        parentKey: "example-org/repo-one:issue:99"
      }
    ]
  };
  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    issues: new Map([["example-org/repo-one", [sampleIssue()]]]),
    failures: [
      {
        repoSlug: "example-org/repo-one",
        step: "issue_comments",
        scope: "issue#7",
        message: "issue comments failed"
      }
    ]
  });
  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");

  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.equal(result.issues[0]?.sourceId, "ISSUE_7");
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0]?.id, "comment:example-org/repo-one:issue_comment:3001");
  assert.equal(result.repoResults[0]?.githubScan?.status, "partial");
});

test("GitHubScanService carries forward previous PRs and PR comments when PR listing fails", async () => {
  const repo = baseRepo();
  const previousState = stateWithPullRequest();
  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    failures: [{ repoSlug: "example-org/repo-one", step: "list_pull_requests", message: "pr list failed" }]
  });
  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");

  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.deepEqual(result.prs.map((pr) => pr.id), previousState.prs.map((pr) => pr.id));
  assert.deepEqual(
    result.comments.filter((comment) => comment.parentType === "pull_request").map((comment) => comment.id),
    previousState.comments.filter((comment) => comment.parentType === "pull_request").map((comment) => comment.id)
  );
  assert.equal(result.repoResults[0]?.githubScan?.status, "partial");
});

test("GitHubScanService merges fresh and carried PR comments when a PR comment scope fails", async () => {
  const repo = baseRepo();
  const previousState = stateWithPullRequest();
  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    pullRequests: new Map([["example-org/repo-one", [samplePullRequest()]]]),
    pullRequestComments: new Map([["example-org/repo-one#13", [samplePullRequestComment()]]]),
    failures: [
      {
        repoSlug: "example-org/repo-one",
        step: "pull_request_review_comments",
        scope: "pull_request#13",
        message: "review comments failed"
      }
    ]
  });
  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");

  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.equal(result.prs[0]?.sourceId, "PR_13");
  assert.deepEqual(
    result.comments.filter((comment) => comment.parentType === "pull_request").map((comment) => comment.id).sort(),
    [
      "comment:example-org/repo-one:pull_request_comment:4001",
      "comment:example-org/repo-one:pull_request_review_comment:5001"
    ]
  );
  assert.equal(result.repoResults[0]?.githubScan?.status, "partial");
});

test("GitHubScanService direct-fetches tracked packet PRs missing from the open PR scan and includes merged state", async () => {
  const repo = baseRepo();
  const integrationBranch = "agent/example-org-repo-one/issue-17";
  const parentPr = basePullRequest({
    number: 100,
    headBranch: integrationBranch,
    labels: ["agent-in-progress"]
  });
  const mergedPacketPr = basePullRequest({
    number: 101,
    state: "merged",
    baseBranch: integrationBranch,
    baseClassification: "non_default_parent",
    headBranch: "agent/example-org-repo-one/workstream-issue-17/packet-t1",
    labels: ["agent-review"]
  });
  const parentWorkstream = baseIssueWorkstream({
    packetPlan: {
      status: "approved",
      packets: {
        T1: {
          id: "T1",
          title: "Packet 1",
          summary: "Packet summary",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "pr_open",
          prNumber: 101,
          branchName: "agent/example-org-repo-one/workstream-issue-17/packet-t1"
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    },
    integration: {
      branchName: integrationBranch,
      prNumber: 100
    },
    linkedPrs: [
      { number: 100, status: "open", role: "implementation" },
      { number: 101, status: "open", role: "implementation" }
    ],
    activePrNumber: 100
  });
  const parentWorktree = baseWorktree({
    id: "worktree:example-org/repo-one:issue:17",
    issueId: "issue:example-org/repo-one:17",
    issueNumber: 17,
    branchName: integrationBranch,
    prNumber: 100
  });
  const packetWorktree = baseWorktree({
    id: "worktree:example-org/repo-one:issue:17:packet:t1",
    packet: {
      parentWorkstreamId: parentWorkstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: integrationBranch
    },
    branchName: "agent/example-org-repo-one/workstream-issue-17/packet-t1",
    prNumber: 101
  });
  delete parentWorktree.issueId;
  delete parentWorktree.issueNumber;
  delete packetWorktree.issueId;
  delete packetWorktree.issueNumber;

  const previousState = {
    ...baseState(),
    prs: [parentPr, mergedPacketPr],
    workstreams: [parentWorkstream],
    worktrees: [parentWorktree, packetWorktree]
  };

  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    issues: new Map([["example-org/repo-one", [sampleIssue()]]]),
    pullRequests: new Map([["example-org/repo-one", [ghPullRequestSummary(parentPr), ghPullRequestSummary(mergedPacketPr)]]])
  });
  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");
  const scan = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.equal(scan.prs.map((pr) => pr.number).sort((a, b) => a - b).join(","), "100,101");
  assert.equal(scan.prs.find((pr) => pr.number === 101)?.state, "merged");
  assert.deepEqual(gateway.getPullRequestCalls, [{ repoSlug: "example-org/repo-one", prNumber: 101 }]);

  const workstreams = deriveWorkstreams({
    repos: [repo],
    currentIssues: scan.issues,
    currentPullRequests: scan.prs,
    previousPullRequests: previousState.prs,
    worktrees: previousState.worktrees,
    previousWorkstreams: previousState.workstreams
  });

  assert.equal(workstreams[0]?.packetPlan?.packets.T1?.status, "merged_to_parent");
  assert.equal(workstreams.find((ws) => ws.id === "example-org/repo-one:pr:101"), undefined);
});

test("GitHubScanService direct-fetches a tracked packet PR that is closed but not merged without marking it merged_to_parent", async () => {
  const repo = baseRepo();
  const integrationBranch = "agent/example-org-repo-one/issue-17";
  const parentPr = basePullRequest({
    number: 100,
    headBranch: integrationBranch,
    labels: ["agent-in-progress"]
  });
  const closedPacketPr = basePullRequest({
    number: 101,
    state: "closed",
    baseBranch: integrationBranch,
    baseClassification: "non_default_parent",
    headBranch: "agent/example-org-repo-one/workstream-issue-17/packet-t1",
    labels: ["agent-review"]
  });
  const parentWorkstream = baseIssueWorkstream({
    packetPlan: {
      status: "approved",
      packets: {
        T1: {
          id: "T1",
          title: "Packet 1",
          summary: "Packet summary",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "pr_open",
          prNumber: 101,
          branchName: "agent/example-org-repo-one/workstream-issue-17/packet-t1"
        }
      },
      waves: [["T1"]],
      currentWaveIndex: 0
    },
    integration: {
      branchName: integrationBranch,
      prNumber: 100
    },
    linkedPrs: [
      { number: 100, status: "open", role: "implementation" },
      { number: 101, status: "open", role: "implementation" }
    ],
    activePrNumber: 100
  });
  const parentWorktree = baseWorktree({
    id: "worktree:example-org/repo-one:issue:17",
    issueId: "issue:example-org/repo-one:17",
    issueNumber: 17,
    branchName: integrationBranch,
    prNumber: 100
  });
  const packetWorktree = baseWorktree({
    id: "worktree:example-org/repo-one:issue:17:packet:t1",
    packet: {
      parentWorkstreamId: parentWorkstream.id,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: integrationBranch
    },
    branchName: "agent/example-org-repo-one/workstream-issue-17/packet-t1",
    prNumber: 101
  });
  delete parentWorktree.issueId;
  delete parentWorktree.issueNumber;
  delete packetWorktree.issueId;
  delete packetWorktree.issueNumber;

  const previousState = {
    ...baseState(),
    prs: [parentPr, closedPacketPr],
    workstreams: [parentWorkstream],
    worktrees: [parentWorktree, packetWorktree]
  };

  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    issues: new Map([["example-org/repo-one", [sampleIssue()]]]),
    pullRequests: new Map([["example-org/repo-one", [ghPullRequestSummary(parentPr), ghPullRequestSummary(closedPacketPr)]]])
  });
  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");
  const scan = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.equal(scan.prs.find((pr) => pr.number === 101)?.state, "closed");

  const workstreams = deriveWorkstreams({
    repos: [repo],
    currentIssues: scan.issues,
    currentPullRequests: scan.prs,
    previousPullRequests: previousState.prs,
    worktrees: previousState.worktrees,
    previousWorkstreams: previousState.workstreams
  });

  assert.equal(workstreams[0]?.packetPlan?.packets.T1?.status, "pr_open");
  assert.equal(workstreams.find((ws) => ws.id === "example-org/repo-one:pr:101"), undefined);
});

test("GitHubScanService does not direct-fetch unrelated closed non-packet PRs from prior state", async () => {
  const repo = baseRepo();
  const unrelatedClosedPr = basePullRequest({
    number: 201,
    state: "closed",
    baseClassification: "top_level",
    headBranch: "feature/old-work",
    labels: []
  });

  const previousState = {
    ...baseState(),
    prs: [unrelatedClosedPr],
    workstreams: [
      {
        id: "example-org/repo-one:pr:201",
        repoKey: "example-org/repo-one",
        origin: { type: "pr" as const, number: 201 },
        linkedPrs: [{ number: 201, status: "closed" as const }],
        activePrNumber: 201,
        phase: "pr_review" as const,
        attention: "idle" as const,
        status: "closed" as const,
        resolution: "closed" as const
      }
    ],
    worktrees: [
      baseWorktree({
        id: "worktree:example-org/repo-one:pr:201",
        branchName: "feature/old-work",
        prNumber: 201
      })
    ]
  };

  const gateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    issues: new Map([["example-org/repo-one", [sampleIssue()]]]),
    pullRequests: new Map([["example-org/repo-one", []]])
  });
  const service = new GitHubScanService(gateway, () => "2026-04-18T09:10:00.000Z");

  await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.deepEqual(gateway.getPullRequestCalls, []);
});

test("partial scan carry-forward prevents old comments from being reclassified as new", async () => {
  const repo = baseRepo();
  const cycleAState = {
    ...baseState(),
    workstreams: [issueWorkstream()]
  };
  const failureGateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    issues: new Map([["example-org/repo-one", [sampleIssue()]]]),
    failures: [
      {
        repoSlug: "example-org/repo-one",
        step: "issue_comments",
        scope: "issue#7",
        message: "issue comments failed"
      }
    ]
  });
  const failureScan = await new GitHubScanService(failureGateway, () => "2026-04-18T09:10:00.000Z")
    .scanRepositories([repo], [baseRepoResult(repo)], cycleAState);
  const cycleBWorkstreams = deriveWorkstreams({
    repos: [repo],
    currentIssues: failureScan.issues,
    currentPullRequests: failureScan.prs,
    previousPullRequests: cycleAState.prs,
    worktrees: [],
    previousWorkstreams: cycleAState.workstreams
  });
  const cycleBAttention = deriveAttentionRecords({
    repos: [repo],
    workstreams: cycleBWorkstreams,
    previousState: cycleAState,
    currentIssues: failureScan.issues,
    currentPullRequests: failureScan.prs,
    currentComments: failureScan.comments,
    tasks: cycleAState.tasks,
    now: "2026-04-18T09:10:00.000Z"
  });
  const cycleBTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: failureScan.repoResults,
    previousState: cycleAState,
    currentIssues: failureScan.issues,
    currentPullRequests: failureScan.prs,
    currentComments: failureScan.comments,
    workstreams: cycleBWorkstreams,
    attention: cycleBAttention,
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T09:10:00.000Z"
  });

  assert.equal(cycleBAttention[0]?.needsAction, false);
  assert.deepEqual(cycleBTasks.map((task) => task.kind), []);

  const cycleBState = {
    ...cycleAState,
    issues: failureScan.issues,
    comments: failureScan.comments,
    workstreams: cycleBWorkstreams,
    attention: cycleBAttention,
    tasks: cycleBTasks
  };
  const successGateway = new FakeGitHubGateway({
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    issues: new Map([["example-org/repo-one", [sampleIssue()]]]),
    issueComments: new Map([["example-org/repo-one#7", [sampleIssueComment()]]])
  });
  const successScan = await new GitHubScanService(successGateway, () => "2026-04-18T09:20:00.000Z")
    .scanRepositories([repo], [baseRepoResult(repo)], cycleBState);
  const cycleCWorkstreams = deriveWorkstreams({
    repos: [repo],
    currentIssues: successScan.issues,
    currentPullRequests: successScan.prs,
    previousPullRequests: cycleBState.prs,
    worktrees: [],
    previousWorkstreams: cycleBState.workstreams
  });
  const cycleCAttention = deriveAttentionRecords({
    repos: [repo],
    workstreams: cycleCWorkstreams,
    previousState: cycleBState,
    currentIssues: successScan.issues,
    currentPullRequests: successScan.prs,
    currentComments: successScan.comments,
    tasks: cycleBState.tasks,
    now: "2026-04-18T09:20:00.000Z"
  });
  const cycleCTasks = deriveTasks({
    repos: [repo],
    repoSyncRecords: successScan.repoResults,
    previousState: cycleBState,
    currentIssues: successScan.issues,
    currentPullRequests: successScan.prs,
    currentComments: successScan.comments,
    workstreams: cycleCWorkstreams,
    attention: cycleCAttention,
    contextBuilder: new DefaultContextBuilder(),
    now: "2026-04-18T09:20:00.000Z"
  });

  assert.equal(cycleCAttention[0]?.needsAction, false);
  assert.deepEqual(cycleCTasks.map((task) => task.kind), []);
});

test("StateStore writes readable entity snapshots", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-entity-state-"));

  try {
    const store = new StateStore(tempDir);
    await store.writeEntityState({
      issueMetadata: {
        generatedAt: "2026-04-18T09:00:00.000Z",
        repoCount: 1,
        entityCount: 1,
        partialFailures: []
      },
      prMetadata: {
        generatedAt: "2026-04-18T09:00:00.000Z",
        repoCount: 1,
        entityCount: 0,
        partialFailures: []
      },
      commentMetadata: {
        generatedAt: "2026-04-18T09:00:00.000Z",
        repoCount: 1,
        entityCount: 0,
        partialFailures: []
      },
      issues: [
        {
          kind: "issue",
          id: "issue:example-org/repo-one:7",
          repoId: "repo-1",
          repoKey: "example-org/repo-one",
          repoOwner: "example-org",
          repoName: "repo-one",
          repoSlug: "example-org/repo-one",
          number: 7,
          key: "example-org/repo-one:issue:7",
          sourceId: "ISSUE_7",
          url: "https://github.com/example-org/repo-one/issues/7",
          title: "Track work",
          body: "Issue body",
          labels: ["agent-in-progress"],
          author: "owner",
          createdAt: "2026-04-18T08:00:00.000Z",
          updatedAt: "2026-04-18T08:05:00.000Z",
          lastSeenAt: "2026-04-18T09:00:00.000Z",
          state: "open"
        }
      ],
      prs: [],
      comments: []
    });

    const issuesState = await readFile(path.join(tempDir, "issues.json"), "utf8");
    assert.equal(
      issuesState,
      '{\n' +
        '  "metadata": {\n' +
        '    "generatedAt": "2026-04-18T09:00:00.000Z",\n' +
        '    "repoCount": 1,\n' +
        '    "entityCount": 1,\n' +
        '    "partialFailures": []\n' +
        '  },\n' +
        '  "issues": [\n' +
        '    {\n' +
        '      "kind": "issue",\n' +
        '      "id": "issue:example-org/repo-one:7",\n' +
        '      "repoId": "repo-1",\n' +
        '      "repoKey": "example-org/repo-one",\n' +
        '      "repoOwner": "example-org",\n' +
        '      "repoName": "repo-one",\n' +
        '      "repoSlug": "example-org/repo-one",\n' +
        '      "number": 7,\n' +
        '      "key": "example-org/repo-one:issue:7",\n' +
        '      "sourceId": "ISSUE_7",\n' +
        '      "url": "https://github.com/example-org/repo-one/issues/7",\n' +
        '      "title": "Track work",\n' +
        '      "body": "Issue body",\n' +
        '      "labels": [\n' +
        '        "agent-in-progress"\n' +
        '      ],\n' +
        '      "author": "owner",\n' +
        '      "createdAt": "2026-04-18T08:00:00.000Z",\n' +
        '      "updatedAt": "2026-04-18T08:05:00.000Z",\n' +
        '      "lastSeenAt": "2026-04-18T09:00:00.000Z",\n' +
        '      "state": "open"\n' +
        '    }\n' +
        '  ]\n' +
        '}\n'
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitHubScanService re-fetches a non-packet (integration) worktree PR when it disappears from the open PR list", async () => {
  // The integration PR was merged and no longer returned by listOpenPullRequests.
  // The scanner should re-fetch it so the workstream can detect the merged state.
  const repo = baseRepo();
  const integrationBranch = "agent/example-org-repo-one/issue-17";
  const integrationPr = basePullRequest({
    number: 100,
    state: "merged",
    headBranch: integrationBranch
  });
  const integrationWorktree: WorktreeRecord = {
    id: "worktree:example-org/repo-one:issue:17",
    repoId: "repo-1",
    repoSlug: "example-org/repo-one",
    repoName: "repo-one",
    issueNumber: 17,
    branchName: integrationBranch,
    path: "/tmp/repo-one/issue-17",
    planDocumentPath: "/tmp/repo-one/issue-17/plan.md",
    logDocumentPath: "/tmp/repo-one/issue-17/log.md",
    status: "awaiting_plan_approval",
    prNumber: 100,
    createdAt: "2026-04-18T08:00:00.000Z",
    updatedAt: "2026-04-18T08:00:00.000Z"
  };
  const previousState: PersistedState = {
    ...baseState(),
    prs: [integrationPr],
    worktrees: [integrationWorktree],
    workstreams: []
  };

  const gatewayFixtures = {
    ...emptyFixtures(),
    repoMetadata: new Map([["example-org/repo-one", baseMetadata()]]),
    issues: new Map([["example-org/repo-one", []]]),
    pullRequests: new Map([["example-org/repo-one", [toGhPullRequest(integrationPr)]]]) // includes merged PR for getPullRequest
  };
  const gateway = new FakeGitHubGateway(gatewayFixtures);
  const service = new GitHubScanService(new SecurityFilteredGitHubGateway(gateway, ["example-org"]), () => "2026-04-18T09:00:00.000Z");

  const result = await service.scanRepositories([repo], [baseRepoResult(repo)], previousState);

  assert.deepEqual(gateway.getPullRequestCalls, [{ repoSlug: "example-org/repo-one", prNumber: 100 }]);
  const fetchedPr = result.prs.find((pr) => pr.number === 100);
  assert.ok(fetchedPr, "integration PR should be present in scan results");
  assert.equal(fetchedPr?.state, "merged");
});

function toGhPullRequest(pr: NormalizedPullRequest): GhPullRequestSummary {
  return {
    id: pr.sourceId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: pr.url,
    state: pr.state === "merged" ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN",
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    author: { login: pr.author },
    labels: pr.labels.map((name) => ({ name })),
    headRefName: pr.headBranch,
    headSha: pr.headSha,
    baseRefName: pr.baseBranch,
    isDraft: pr.isDraft
  };
}

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

function baseMetadata(): GitHubRepositoryMetadata {
  return {
    id: "REPO_1",
    owner: "example-org",
    name: "repo-one",
    nameWithOwner: "example-org/repo-one",
    url: "https://github.com/example-org/repo-one",
    defaultBranch: "main"
  };
}

function baseRepoResult(repo: RepoConfig): RepoSyncRecord {
  return {
    repoId: repo.id,
    repoName: repo.name,
    repoSlug: `${repo.owner}/${repo.name}`,
    localPath: `/tmp/${repo.localPath}`,
    codeRoot: "/tmp",
    status: "synced",
    existedBeforeSync: true,
    cloned: false,
    fetched: true,
    defaultBranch: "main",
    defaultBranchSource: "github",
    currentBranchBefore: "main",
    currentBranchAfter: "main",
    syncedAt: "2026-04-18T09:00:00.000Z",
    message: "Repository fetched and synchronized to the latest default branch."
  };
}

function baseState(): PersistedState {
  return {
    issueMetadata: { partialFailures: [] },
    prMetadata: { partialFailures: [] },
    commentMetadata: { partialFailures: [] },
    issues: [
      {
        kind: "issue",
        id: "issue:example-org/repo-one:7",
        repoId: "repo-1",
        repoKey: "example-org/repo-one",
        repoOwner: "example-org",
        repoName: "repo-one",
        repoSlug: "example-org/repo-one",
        number: 7,
        key: "example-org/repo-one:issue:7",
        sourceId: "ISSUE_7",
        url: "https://github.com/example-org/repo-one/issues/7",
        title: "Track work",
        body: "Issue body",
        labels: [],
        author: "owner",
        createdAt: "2026-04-18T07:00:00.000Z",
        updatedAt: "2026-04-18T07:10:00.000Z",
        lastSeenAt: "2026-04-18T07:20:00.000Z",
        lastHandledAt: "2026-04-18T07:00:00.000Z",
        state: "open"
      }
    ],
    prs: [],
    comments: [
      {
        kind: "comment",
        commentKind: "issue_comment",
        id: "comment:example-org/repo-one:issue_comment:3001",
        sourceId: "3001",
        repoId: "repo-1",
        repoKey: "example-org/repo-one",
        repoOwner: "example-org",
        repoName: "repo-one",
        repoSlug: "example-org/repo-one",
        parentType: "issue",
        parentNumber: 7,
        parentKey: "example-org/repo-one:issue:7",
        url: "https://github.com/example-org/repo-one/issues/7#issuecomment-3001",
        body: "Existing comment",
        author: "owner",
        createdAt: "2026-04-18T08:30:00.000Z",
        updatedAt: "2026-04-18T08:30:00.000Z",
        lastSeenAt: "2026-04-18T07:20:00.000Z",
        lastHandledAt: "2026-04-18T07:10:00.000Z"
      }
    ],
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

function stateWithPullRequest(): PersistedState {
  const pullRequest: NormalizedPullRequest = {
    kind: "pull_request",
    id: "pull_request:example-org/repo-one:13",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    number: 13,
    key: "example-org/repo-one:pull_request:13",
    sourceId: "PR_13",
    url: "https://github.com/example-org/repo-one/pull/13",
    title: "Implement scanner",
    body: "PR body",
    labels: ["agent-plan-approved"],
    author: "owner",
    createdAt: "2026-04-18T08:10:00.000Z",
    updatedAt: "2026-04-18T08:40:00.000Z",
    lastSeenAt: "2026-04-18T08:45:00.000Z",
    state: "open",
    headBranch: "feature/scanner",
    headSha: "abc123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false
  };
  const prComment: NormalizedComment = {
    kind: "comment",
    commentKind: "pull_request_comment",
    id: "comment:example-org/repo-one:pull_request_comment:4001",
    sourceId: "4001",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    parentType: "pull_request",
    parentNumber: 13,
    parentKey: "example-org/repo-one:pull_request:13",
    url: "https://github.com/example-org/repo-one/pull/13#issuecomment-4001",
    body: "General PR comment",
    author: "reviewer",
    createdAt: "2026-04-18T08:41:00.000Z",
    updatedAt: "2026-04-18T08:41:00.000Z",
    lastSeenAt: "2026-04-18T08:45:00.000Z"
  };
  const reviewComment: NormalizedComment = {
    ...prComment,
    commentKind: "pull_request_review_comment",
    id: "comment:example-org/repo-one:pull_request_review_comment:5001",
    sourceId: "5001",
    url: "https://github.com/example-org/repo-one/pull/13#discussion_r5001",
    body: "Inline review comment",
    reactionTargetId: "5001"
  };

  return {
    ...baseState(),
    prs: [pullRequest],
    comments: [prComment, reviewComment]
  };
}

function stateWithTrackedPacketPullRequest(prNumber: number): PersistedState {
  const parentWorkstreamId = "example-org/repo-one:issue:7";
  const packetBranch = "agent/example-org-repo-one/workstream-issue-7/packet-t1";
  const parentBranch = "agent/example-org-repo-one/issue-7";
  const packetWorktree: WorktreeRecord = {
    id: "worktree:example-org/repo-one:issue:7:packet:t1",
    repoId: "repo-1",
    repoSlug: "example-org/repo-one",
    repoName: "repo-one",
    packet: {
      parentWorkstreamId,
      packetId: "T1",
      waveIndex: 0,
      parentIntegrationBranch: parentBranch
    },
    baseBranch: parentBranch,
    branchName: packetBranch,
    path: "/tmp/repo-one/packet-t1",
    planDocumentPath: "/tmp/repo-one/packet-t1/docs/agents/packet-t1/plan.md",
    logDocumentPath: "/tmp/repo-one/packet-t1/docs/agents/packet-t1/log.md",
    status: "implementing",
    prNumber,
    prId: `pull_request:example-org/repo-one:${prNumber}`,
    prUrl: `https://github.com/example-org/repo-one/pull/${prNumber}`,
    createdAt: "2026-04-18T08:00:00.000Z",
    updatedAt: "2026-04-18T08:00:00.000Z"
  };
  const workstream: WorkstreamRecord = {
    id: parentWorkstreamId,
    repoKey: "example-org/repo-one",
    origin: { type: "issue", number: 7 },
    linkedIssueNumber: 7,
    linkedPrs: [{ number: 100, status: "open", role: "implementation" }],
    activePrNumber: 100,
    activeWorktreeId: "worktree:example-org/repo-one:issue:7",
    phase: "planning",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    integration: {
      branchName: parentBranch,
      prNumber: 100
    },
    packetPlan: {
      status: "proposed",
      packets: {
        T1: {
          id: "T1",
          title: "T1",
          summary: "Packet T1",
          acceptanceCriteria: [],
          filesLikelyTouched: [],
          dependsOn: [],
          canRunInParallelWith: [],
          blocks: [],
          status: "pr_open",
          prNumber,
          branchName: packetBranch
        }
      },
      waves: [["T1"], ["T2"]],
      currentWaveIndex: 0
    }
  };

  return {
    ...baseState(),
    worktrees: [packetWorktree],
    workstreams: [workstream]
  };
}

function issueWorkstream() {
  return {
    id: "example-org/repo-one:issue:7",
    repoKey: "example-org/repo-one",
    origin: { type: "issue" as const, number: 7 },
    linkedIssueNumber: 7,
    linkedPrs: [],
    phase: "issue_waiting" as const,
    attention: "idle" as const,
    status: "open" as const,
    resolution: "unresolved" as const
  };
}

function baseIssueWorkstream(overrides: Partial<WorkstreamRecord> = {}): WorkstreamRecord {
  return {
    ...issueWorkstream(),
    ...overrides
  };
}

function emptyFixtures(): ConstructorParameters<typeof FakeGitHubGateway>[0] {
  return {
    repoMetadata: new Map(),
    issues: new Map(),
    pullRequests: new Map(),
    issueComments: new Map(),
    pullRequestComments: new Map(),
    pullRequestReviews: new Map(),
    pullRequestReviewComments: new Map(),
    failures: []
  };
}

function sampleIssue(): GhIssueSummary {
  return {
    id: "ISSUE_7",
    number: 7,
    title: "Track work",
    body: "Issue body",
    url: "https://github.com/example-org/repo-one/issues/7",
    state: "OPEN",
    createdAt: "2026-04-18T08:00:00.000Z",
    updatedAt: "2026-04-18T08:05:00.000Z",
    author: { login: "owner" },
    labels: [{ name: "agent-in-progress" }]
  };
}

function samplePullRequest(): GhPullRequestSummary {
  return {
    id: "PR_13",
    number: 13,
    title: "Implement scanner",
    body: "PR body",
    url: "https://github.com/example-org/repo-one/pull/13",
    state: "OPEN",
    createdAt: "2026-04-18T08:10:00.000Z",
    updatedAt: "2026-04-18T08:40:00.000Z",
    author: { login: "owner" },
    labels: [{ name: "agent-plan-approved" }],
    headRefName: "feature/scanner",
    headSha: "abc123",
    baseRefName: "main",
    isDraft: false
  };
}

function basePullRequest(overrides: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  const number = overrides.number ?? 101;
  const headBranch = overrides.headBranch ?? "feature/scanner";
  const baseBranch = overrides.baseBranch ?? "main";
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
    title: "Implement scanner",
    body: "PR body",
    labels: [],
    author: "owner",
    createdAt: "2026-04-18T08:10:00.000Z",
    updatedAt: "2026-04-18T08:40:00.000Z",
    state: "open",
    headSha: "abc123",
    baseClassification: "top_level",
    isDraft: false,
    ...overrides,
    headBranch,
    baseBranch,
    defaultBranch: overrides.defaultBranch ?? "main"
  };
}

function ghPullRequestSummary(pr: NormalizedPullRequest): GhPullRequestSummary {
  return {
    id: pr.sourceId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: pr.url,
    state: pr.state.toUpperCase() as "OPEN" | "CLOSED" | "MERGED",
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    author: pr.author ? { login: pr.author } : null,
    labels: pr.labels.map((name) => ({ name })),
    headRefName: pr.headBranch,
    headSha: pr.headSha,
    baseRefName: pr.baseBranch,
    isDraft: pr.isDraft
  };
}

function baseWorktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  const now = "2026-04-18T08:30:00.000Z";
  return {
    id: "worktree:example-org/repo-one:issue:17",
    repoId: "repo-1",
    repoSlug: "example-org/repo-one",
    repoName: "repo-one",
    path: "/tmp/code-root/_worktrees/example-org/repo-one/issue-17",
    branchName: "agent/example-org-repo-one/issue-17",
    planDocumentPath: "/tmp/code-root/_worktrees/example-org/repo-one/issue-17/docs/agents/issue-17/issue-17-agent-plan.md",
    logDocumentPath: "/tmp/code-root/_worktrees/example-org/repo-one/issue-17/docs/agents/issue-17/issue-17-agent-log.md",
    status: "implementation_ready",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function sampleIssueComment(): GhComment {
  return {
    id: "3001",
    url: "https://github.com/example-org/repo-one/issues/7#issuecomment-3001",
    body: "Existing comment",
    createdAt: "2026-04-18T08:30:00.000Z",
    updatedAt: "2026-04-18T08:30:00.000Z",
    author: { login: "owner" }
  };
}

function samplePullRequestComment(): GhComment {
  return {
    id: "4001",
    url: "https://github.com/example-org/repo-one/pull/13#issuecomment-4001",
    body: "General PR comment",
    createdAt: "2026-04-18T08:41:00.000Z",
    updatedAt: "2026-04-18T08:41:00.000Z",
    author: { login: "reviewer" }
  };
}

function samplePullRequestReview(): GhPullRequestReview {
  return {
    id: "REVIEW_99",
    url: "https://github.com/example-org/repo-one/pull/13#pullrequestreview-99",
    body: "Review summary",
    submittedAt: "2026-04-18T08:42:00.000Z",
    updatedAt: "2026-04-18T08:42:00.000Z",
    state: "COMMENTED",
    author: { login: "reviewer" }
  };
}

class FakeGitHubGateway implements GitHubGateway {
  readonly getPullRequestCalls: Array<{ repoSlug: string; prNumber: number }> = [];

  constructor(
    private readonly fixtures: {
      repoMetadata: Map<string, GitHubRepositoryMetadata>;
      issues: Map<string, GhIssueSummary[]>;
      pullRequests: Map<string, GhPullRequestSummary[]>;
      issueComments: Map<string, GhComment[]>;
      pullRequestComments: Map<string, GhComment[]>;
      pullRequestReviews: Map<string, GhPullRequestReview[]>;
      pullRequestReviewComments: Map<string, GhPullRequestReviewComment[]>;
      failures: Array<{
        repoSlug: string;
        step: RepoScanFailure["step"];
        scope?: string;
        message: string;
      }>;
    }
  ) {}

  async getRepositoryMetadata(owner: string, name: string): Promise<GitHubRepositoryMetadata> {
    this.maybeFail(`${owner}/${name}`, "repo_metadata", "repo");
    return this.fixtures.repoMetadata.get(`${owner}/${name}`)!;
  }

  async getRepositoryDefaultBranch(owner: string, name: string): Promise<string> {
    return this.getRepositoryMetadata(owner, name).then((metadata) => metadata.defaultBranch);
  }

  async getIssue(owner: string, name: string, issueNumber: number): Promise<GhIssueSummary> {
    return (this.fixtures.issues.get(`${owner}/${name}`) ?? []).find((issue) => issue.number === issueNumber)!;
  }

  async getPullRequest(owner: string, name: string, prNumber: number): Promise<GhPullRequestSummary> {
    this.getPullRequestCalls.push({ repoSlug: `${owner}/${name}`, prNumber });
    this.maybeFail(`${owner}/${name}`, "get_pull_request", `pull_request#${prNumber}`);
    const pullRequest = (this.fixtures.pullRequests.get(`${owner}/${name}`) ?? []).find((pr) => pr.number === prNumber);
    if (!pullRequest) {
      throw new Error(`Pull request #${prNumber} not found`);
    }
    return pullRequest;
  }

  async findOpenPullRequestByHeadBranch(
    owner: string,
    name: string,
    headBranch: string
  ): Promise<GhPullRequestSummary | null> {
    return (
      this.fixtures.pullRequests.get(`${owner}/${name}`)?.find((pr) => pr.headRefName === headBranch) ?? null
    );
  }

  async createPullRequest(): Promise<GhPullRequestSummary> {
    throw new Error("not implemented in scan tests");
  }

  async searchCode(): Promise<GhSearchCodeResult> {
    return {
      totalCount: 0,
      incompleteResults: false,
      items: []
    };
  }

  async postIssueComment(): Promise<GhIssueCommentMutationResult> {
    throw new Error("not implemented in scan tests");
  }

  async updateIssueComment(): Promise<GhIssueCommentMutationResult> {
    throw new Error("not implemented in scan tests");
  }

  async postPullRequestReviewCommentReply(): Promise<GhPullRequestReviewCommentReplyResult> {
    throw new Error("not implemented in scan tests");
  }

  async submitPullRequestReview(): Promise<GhPullRequestReviewSubmissionResult> {
    throw new Error("not implemented in scan tests");
  }

  async listOpenIssues(owner: string, name: string): Promise<GhIssueSummary[]> {
    this.maybeFail(`${owner}/${name}`, "list_issues", "repo");
    return this.fixtures.issues.get(`${owner}/${name}`) ?? [];
  }

  async listOpenPullRequests(owner: string, name: string): Promise<GhPullRequestSummary[]> {
    this.maybeFail(`${owner}/${name}`, "list_pull_requests", "repo");
    return (this.fixtures.pullRequests.get(`${owner}/${name}`) ?? []).filter((pr) => pr.state === "OPEN");
  }

  async listIssueComments(owner: string, name: string, issueNumber: number): Promise<GhComment[]> {
    this.maybeFail(`${owner}/${name}`, "issue_comments", `issue#${issueNumber}`);
    return this.fixtures.issueComments.get(`${owner}/${name}#${issueNumber}`) ?? [];
  }

  async listPullRequestComments(owner: string, name: string, prNumber: number): Promise<GhComment[]> {
    this.maybeFail(`${owner}/${name}`, "pull_request_comments", `pull_request#${prNumber}`);
    return this.fixtures.pullRequestComments.get(`${owner}/${name}#${prNumber}`) ?? [];
  }

  async listPullRequestReviews(owner: string, name: string, prNumber: number): Promise<GhPullRequestReview[]> {
    this.maybeFail(`${owner}/${name}`, "pull_request_reviews", `pull_request#${prNumber}`);
    return this.fixtures.pullRequestReviews.get(`${owner}/${name}#${prNumber}`) ?? [];
  }

  async listPullRequestReviewComments(
    owner: string,
    name: string,
    prNumber: number
  ): Promise<GhPullRequestReviewComment[]> {
    this.maybeFail(`${owner}/${name}`, "pull_request_review_comments", `pull_request#${prNumber}`);
    return this.fixtures.pullRequestReviewComments.get(`${owner}/${name}#${prNumber}`) ?? [];
  }

  async listPullRequestChangedFiles(): Promise<GhPullRequestChangedFile[]> {
    return [];
  }

  async listIssueEvents(owner: string, name: string, issueNumber: number): Promise<GhIssueEvent[]> {
    const issue = (this.fixtures.issues.get(`${owner}/${name}`) ?? []).find((i) => i.number === issueNumber);
    const pr = (this.fixtures.pullRequests.get(`${owner}/${name}`) ?? []).find((p) => p.number === issueNumber);
    const entity = issue || pr;
    if (!entity) {
      return [];
    }
    return entity.labels.map((label) => ({
      event: "labeled",
      createdAt: entity.createdAt,
      actor: entity.author,
      label
    }));
  }

  async listPullRequestCheckRuns(): Promise<GhCheckRun[]> {
    return [];
  }

  private maybeFail(repoSlug: string, step: RepoScanFailure["step"], scope: string): void {
    const failure = this.fixtures.failures.find(
      (entry) => entry.repoSlug === repoSlug && entry.step === step && (entry.scope === undefined || entry.scope === scope)
    );

    if (failure) {
      throw new Error(failure.message);
    }
  }

  async addReaction(): Promise<void> {}
}
