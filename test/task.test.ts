import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedComment, NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import { Task } from "../src/tasks/task.js";

test("Task resolves source and owning relationships for issue, PR, and comment tasks", () => {
  const issue = baseIssue();
  const pullRequest = basePullRequest();
  const issueComment = baseIssueComment();
  const prComment = basePrComment();

  const issueTask = Task.from({
    kind: "triage_issue",
    id: "task:triage_issue:issue:eladaviv/repo-one:11",
    status: "pending",
    executionPermission: "read-only",
    handoffPolicy: {
      expectsPushableHandoff: false,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: issue.repoId,
    repoName: issue.repoName,
    repoSlug: issue.repoSlug,
    sourceKind: "issue",
    sourceId: issue.id,
    sourceUrl: issue.url,
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: issue.repoSlug,
      labels: [],
      instruction: "instruction"
    },
    createdAt: "2026-04-21T08:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z"
  });

  assert.equal(issueTask.getOwningThreadKind(), "issue");
  assert.equal(issueTask.getOwningThreadId(), issue.id);
  assert.equal(issueTask.resolveSourceIssue({ issuesById: new Map([[issue.id, issue]]) }), issue);
  assert.equal(issueTask.resolveOwningIssue({ issuesById: new Map([[issue.id, issue]]) }), issue);
  assert.equal(issueTask.isRelatedToIssue(issue), true);

  const issueCommentTask = Task.from({
    kind: "respond_issue_comment",
    id: `task:respond_issue_comment:${issueComment.id}`,
    status: "pending",
    executionPermission: "read-only",
    handoffPolicy: {
      expectsPushableHandoff: false,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: issueComment.repoId,
    repoName: issueComment.repoName,
    repoSlug: issueComment.repoSlug,
    sourceKind: "comment",
    sourceId: issueComment.id,
    sourceUrl: issueComment.url,
    parentSourceKind: "issue",
    parentSourceId: issue.id,
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: issueComment.repoSlug,
      labels: [],
      commentUrl: issueComment.url,
      issueUrl: issue.url,
      instruction: "instruction"
    },
    createdAt: "2026-04-21T08:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z"
  });

  const issueLookups = new Map([[issue.id, issue]]);
  const issueCommentLookups = new Map([[issueComment.id, issueComment]]);

  assert.equal(issueCommentTask.getOwningThreadKind(), "issue");
  assert.equal(issueCommentTask.getOwningThreadId(), issue.id);
  assert.equal(issueCommentTask.resolveSourceComment({ commentsById: issueCommentLookups }), issueComment);
  assert.equal(
    issueCommentTask.resolveOwningComment({ commentsById: issueCommentLookups }),
    issueComment
  );
  assert.equal(issueCommentTask.resolveOwningIssue({ issuesById: issueLookups }), issue);
  assert.equal(issueCommentTask.isRelatedToIssue(issue), true);

  const prTask = Task.from({
    kind: "review_pr",
    id: "task:review_pr:pull_request:eladaviv/repo-one:21",
    status: "pending",
    executionPermission: "read-only",
    handoffPolicy: {
      expectsPushableHandoff: false,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: pullRequest.repoId,
    repoName: pullRequest.repoName,
    repoSlug: pullRequest.repoSlug,
    sourceKind: "pull_request",
    sourceId: pullRequest.id,
    sourceUrl: pullRequest.url,
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: pullRequest.repoSlug,
      labels: [],
      pullRequestUrl: pullRequest.url,
      instruction: "instruction"
    },
    createdAt: "2026-04-21T08:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z"
  });

  const pullRequestLookups = new Map([[pullRequest.id, pullRequest]]);
  const prCommentLookups = new Map([[prComment.id, prComment]]);

  assert.equal(prTask.getOwningThreadKind(), "pull_request");
  assert.equal(prTask.getOwningThreadId(), pullRequest.id);
  assert.equal(prTask.resolveSourcePullRequest({ pullRequestsById: pullRequestLookups }), pullRequest);
  assert.equal(prTask.resolveOwningPullRequest({ pullRequestsById: pullRequestLookups }), pullRequest);
  assert.equal(prTask.isRelatedToPullRequest(pullRequest), true);

  const prCommentTask = Task.from({
    kind: "respond_pr_comment",
    id: `task:respond_pr_comment:${prComment.id}`,
    status: "pending",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: prComment.repoId,
    repoName: prComment.repoName,
    repoSlug: prComment.repoSlug,
    sourceKind: "comment",
    sourceId: prComment.id,
    sourceUrl: prComment.url,
    parentSourceKind: "pull_request",
    parentSourceId: pullRequest.id,
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: prComment.repoSlug,
      labels: [],
      commentUrl: prComment.url,
      pullRequestUrl: pullRequest.url,
      instruction: "instruction"
    },
    createdAt: "2026-04-21T08:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z"
  });

  assert.equal(prCommentTask.getOwningThreadKind(), "pull_request");
  assert.equal(prCommentTask.getOwningThreadId(), pullRequest.id);
  assert.equal(prCommentTask.resolveSourceComment({ commentsById: prCommentLookups }), prComment);
  assert.equal(prCommentTask.resolveOwningComment({ commentsById: prCommentLookups }), prComment);
  assert.equal(prCommentTask.resolveOwningPullRequest({ pullRequestsById: pullRequestLookups }), pullRequest);
  assert.equal(prCommentTask.isRelatedToPullRequest(pullRequest), true);
});

function baseIssue(): NormalizedIssue {
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
    title: "Issue",
    body: "Body",
    labels: [],
    author: "owner",
    createdAt: "2026-04-21T08:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z",
    state: "open"
  };
}

function basePullRequest(): NormalizedPullRequest {
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
    title: "PR",
    body: "Body",
    labels: [],
    author: "owner",
    createdAt: "2026-04-21T08:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z",
    state: "open",
    headBranch: "feature/test",
    headSha: "abc123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false
  };
}

function baseIssueComment(): NormalizedComment {
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
    body: "Comment",
    author: "owner",
    createdAt: "2026-04-21T08:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z"
  };
}

function basePrComment(): NormalizedComment {
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
    body: "Comment",
    author: "reviewer",
    createdAt: "2026-04-21T08:00:00.000Z",
    updatedAt: "2026-04-21T08:00:00.000Z"
  };
}
