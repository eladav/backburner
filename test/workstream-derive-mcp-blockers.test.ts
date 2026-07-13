import * as assert from "node:assert/strict";
import { test } from "node:test";
import { deriveWorkstreams } from "../src/workstreams/derive.js";
import type {
  WorkstreamRecord,
  WorktreeRecord,
  McpStatusRecord
} from "../src/state/types.js";
import type { NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import type { RepoConfig } from "../src/config/types.js";

const mockRepo = {
  id: "repo-1",
  owner: "example-org",
  name: "example-repo",
  labels: {
    agentInProgress: "agent-in-progress",
    agentPlanApproved: "agent-plan-approved",
    agentProductApproved: "agent-product-approved",
    agentReview: "agent-review",
    planBreakdownNeeded: "plan-breakdown-needed",
    agentSyncParentBranch: "sync-parent-branch",
    prepareForMerge: "prepare-for-merge"
  },
  branches: {
    main: "main"
  },
  capabilities: {
    sensors: [],
    controllers: []
  },
  mcps: []
} as any as RepoConfig;

const mockIssue = {
  id: "issue-1",
  repoId: "repo-1",
  repoOwner: "example-org",
  repoName: "example-repo",
  repoSlug: "example-org/example-repo",
  repoKey: "example-org/example-repo",
  number: 310,
  title: "Test Issue",
  state: "open",
  author: "example-org",
  url: "https://github.com/example-org/example-repo/issues/310",
  labels: ["agent-active"],
  createdAt: "2026-06-30T10:00:00Z",
  updatedAt: "2026-06-30T10:00:00Z",
  body: "Some body"
} as any as NormalizedIssue;

const mockMcpBlocker = {
  id: "mcp-blocker:ws-issue:context7:task-1",
  kind: "mcp_action_required" as const,
  mcpHandle: "context7",
  affectedCapabilityNames: ["context7-docs"],
  safeReason: "Auth required",
  blockedTaskKind: "implement_plan" as const,
  blockedTaskId: "task-1",
  createdAt: "2026-06-30T11:00:00Z",
  updatedAt: "2026-06-30T11:00:00Z",
  resolutionState: "waiting_for_user" as const
};

const mockExclusion = {
  id: "mcp-exclusion:ws-issue:context7:task-1",
  taskId: "task-1",
  taskKind: "implement_plan" as const,
  mcpHandle: "context7",
  affectedCapabilityNames: ["context7-docs"],
  createdAt: "2026-06-30T11:00:00Z"
};

test("deriveWorkstreams carries forward mcpBlockers and mcpSkipExclusions for issue-origin workstreams", () => {
  const previousWorkstream = {
    id: "example-org/example-repo:issue:310",
    owner: "example-org",
    repo: "example-repo",
    repoKey: "example-org/example-repo",
    issueNumber: 310,
    origin: {
      type: "issue",
      number: 310
    },
    phase: "implementing",
    status: "open",
    resolution: "unresolved",
    linkedPrs: [],
    mcpBlockers: [mockMcpBlocker],
    mcpSkipExclusions: [mockExclusion]
  } as any as WorkstreamRecord;

  const derived = deriveWorkstreams({
    repos: [mockRepo],
    currentIssues: [mockIssue],
    currentPullRequests: [],
    previousPullRequests: [],
    worktrees: [],
    previousWorkstreams: [previousWorkstream]
  });

  const target = derived.find((ws) => ws.id === previousWorkstream.id);
  assert.ok(target, "Should find the derived workstream");
  assert.deepEqual(target.mcpBlockers, [mockMcpBlocker]);
  assert.deepEqual(target.mcpSkipExclusions, [mockExclusion]);
});

test("deriveWorkstreams carries forward mcpBlockers and mcpSkipExclusions for PR-origin workstreams", () => {
  const mockPr = {
    id: "pr-1",
    repoId: "repo-1",
    repoOwner: "example-org",
    repoName: "example-repo",
    repoSlug: "example-org/example-repo",
    repoKey: "example-org/example-repo",
    number: 320,
    title: "Test PR",
    state: "open",
    author: "example-org",
    url: "https://github.com/example-org/example-repo/pull/320",
    labels: ["agent-active"],
    headBranch: "some-head",
    headSha: "abc123sha",
    baseBranch: "main",
    createdAt: "2026-06-30T10:00:00Z",
    updatedAt: "2026-06-30T10:00:00Z",
    body: "PR body",
    isDraft: false
  } as any as NormalizedPullRequest;

  const previousWorkstream = {
    id: "example-org/example-repo:pr:320",
    owner: "example-org",
    repo: "example-repo",
    repoKey: "example-org/example-repo",
    prNumber: 320,
    origin: {
      type: "pr",
      number: 320
    },
    phase: "implementing",
    status: "open",
    resolution: "unresolved",
    linkedPrs: [],
    mcpBlockers: [mockMcpBlocker],
    mcpSkipExclusions: [mockExclusion]
  } as any as WorkstreamRecord;

  const derived = deriveWorkstreams({
    repos: [mockRepo],
    currentIssues: [],
    currentPullRequests: [mockPr],
    previousPullRequests: [],
    worktrees: [],
    previousWorkstreams: [previousWorkstream]
  });

  const target = derived.find((ws) => ws.id === previousWorkstream.id);
  assert.ok(target, "Should find the derived workstream");
  assert.deepEqual(target.mcpBlockers, [mockMcpBlocker]);
  assert.deepEqual(target.mcpSkipExclusions, [mockExclusion]);
});
