
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeComment } from "../src/github/normalize.js";

test("normalizeComment correctly overrides previous data", () => {
  const previous = {
    kind: "comment" as const,
    commentKind: "issue_comment" as const,
    id: "comment:owner/repo:issue_comment:1",
    sourceId: "1",
    repoId: 1,
    repoKey: "owner/repo",
    repoOwner: "owner",
    repoName: "repo",
    repoSlug: "owner/repo",
    parentType: "issue" as const,
    parentNumber: 1,
    parentKey: "issue:owner/repo:1",
    url: "https://old-url.com",
    body: "old body",
    author: "old-author",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    reactionTargetId: "old-id"
  };

  const context = {
    repo: { id: 1 },
    repoMetadata: { nameWithOwner: "owner/repo", owner: "owner", name: "repo" },
    previousComments: new Map([["comment:owner/repo:issue_comment:1", previous]])
  };

  const input = {
    sourceId: "1",
    url: "https://new-url.com",
    body: "new body",
    author: "new-author",
    createdAt: "2026-05-02T00:00:00Z",
    updatedAt: "2026-05-02T00:00:00Z",
    parentNumber: 1,
    parentType: "issue" as const,
    commentKind: "issue_comment" as const,
    context: context as any,
    reactionTargetId: "new-id"
  };

  const result = normalizeComment(input);

  assert.equal(result.url, "https://new-url.com");
  assert.equal(result.body, "new body");
  assert.equal(result.author, "new-author");
  assert.equal(result.reactionTargetId, "new-id");
  assert.equal(result.updatedAt, "2026-05-02T00:00:00Z");
});

test("normalizeComment sets lastSeenAt from context", () => {
  const context = {
    repo: { id: 1 },
    repoMetadata: { nameWithOwner: "owner/repo", owner: "owner", name: "repo" },
    previousComments: new Map(),
    seenAt: "2026-05-03T12:00:00Z"
  };

  const input = {
    sourceId: "2",
    url: "https://url.com",
    body: "body",
    author: "author",
    createdAt: "2026-05-02T00:00:00Z",
    updatedAt: "2026-05-02T00:00:00Z",
    parentNumber: 1,
    parentType: "issue" as const,
    commentKind: "issue_comment" as const,
    context: context as any
  };

  const result = normalizeComment(input);

  assert.equal(result.lastSeenAt, "2026-05-03T12:00:00Z");
});

test("normalizeComment preserves lastHandledAt and updates lastSeenAt when previous comment exists", () => {
  const previous = {
    kind: "comment" as const,
    commentKind: "issue_comment" as const,
    id: "comment:owner/repo:issue_comment:1",
    sourceId: "1",
    repoId: 1,
    repoKey: "owner/repo",
    repoOwner: "owner",
    repoName: "repo",
    repoSlug: "owner/repo",
    parentType: "issue" as const,
    parentNumber: 1,
    parentKey: "issue:owner/repo:1",
    url: "https://url.com",
    body: "old-body",
    author: "author",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    reactionTargetId: "old-reaction-id",
    lastSeenAt: "old-seen",
    lastHandledAt: "old-handled"
  };

  const context = {
    repo: { id: 1 },
    repoMetadata: { nameWithOwner: "owner/repo", owner: "owner", name: "repo" },
    previousComments: new Map([["comment:owner/repo:issue_comment:1", previous]]),
    seenAt: "new-seen"
  };

  const input = {
    sourceId: "1",
    url: "https://url.com",
    body: "new-body",
    author: "author",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "new-updated-at",
    parentNumber: 1,
    parentType: "issue" as const,
    commentKind: "issue_comment" as const,
    context: context as any,
    reactionTargetId: "new-reaction-id"
  };

  const result = normalizeComment(input);

  assert.equal(result.lastSeenAt, "new-seen");
  assert.equal(result.lastHandledAt, "old-handled");
  assert.equal(result.body, "new-body");
  assert.equal(result.updatedAt, "new-updated-at");
  assert.equal(result.reactionTargetId, "new-reaction-id");
});
