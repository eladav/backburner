import * as assert from "node:assert/strict";
import { test } from "node:test";
import { detectProviderLimit, mapSignalToRecord } from "../src/agents/limit-detector.js";
import { GitHubTaskLifecycleNotifier } from "../src/agents/lifecycle-feedback.js";
import { NoProviderAvailableError } from "../src/agents/selection.js";
import type { TaskRecord } from "../src/state/types.js";
import type { GitHubGateway } from "../src/github/types.js";

test("detectProviderLimit maps Exit Code 429 to a session signal", () => {
  const signal = detectProviderLimit("claude", 429, "", "Too Many Requests");
  assert.ok(signal);
  assert.equal(signal.provider, "claude");
  assert.equal(signal.limitType, "session");
  assert.equal(signal.isLimited, true);
  assert.equal(signal.rawError, "Too Many Requests");
});

test("detectProviderLimit maps '5-hour limit' to a session signal", () => {
  const signal = detectProviderLimit("claude", 1, "", "Exceeded the 5-hour limit for messages");
  assert.ok(signal);
  assert.equal(signal.provider, "claude");
  assert.equal(signal.limitType, "session");
  assert.equal(signal.isLimited, true);
});

test("mapSignalToRecord converts ProviderLimitSignal to ProviderLimitRecord", () => {
  const signal = {
    provider: "claude" as const,
    isLimited: true,
    limitType: "session" as const,
    rawError: "Too Many Requests",
    detectedAt: "2026-07-01T12:00:00Z",
    resetTime: "2026-07-01T17:00:00Z"
  };

  const record = mapSignalToRecord(signal, "2026-07-01T12:00:05Z");
  assert.equal(record.provider, "claude");
  assert.equal(record.status, "limited");
  assert.equal(record.limitType, "session");
  assert.equal(record.rawError, "Too Many Requests");
  assert.equal(record.detectedAt, "2026-07-01T12:00:00Z");
  assert.equal(record.resetTime, "2026-07-01T17:00:00Z");
  assert.equal(record.updatedAt, "2026-07-01T12:00:05Z");
});

test("TaskLifecycleNotifier posts a comment on queueing due to limited provider", async () => {
  let postedComment: { owner: string; name: string; issueNumber: number; body: string } | undefined;
  let addedReaction: any | undefined;

  const mockGateway = {
    postIssueComment: async (input: any): Promise<any> => {
      postedComment = input;
      return { id: 12345, url: "http://github/comment/12345", body: input.body, createdAt: "now", updatedAt: "now", author: "bot" };
    },
    addReaction: async (input: any): Promise<any> => {
      addedReaction = input;
    }
  } as unknown as GitHubGateway;

  const notifier = new GitHubTaskLifecycleNotifier(mockGateway, [
    {
      id: "repo-1",
      owner: "eladav",
      name: "agents-over-github",
      localPath: "/tmp/repo",
      enabled: true,
      labels: {
        agentInProgress: "",
        agentPlanApproved: "",
        agentProductApproved: "",
        agentReview: "",
        planBreakdownNeeded: "",
        agentSyncParentBranch: "",
        prepareForMerge: ""
      }
    }
  ]);

  const taskRecord = {
    id: "task-1",
    kind: "implement_plan",
    workflowPhase: "implementing",
    summary: "Implement boundary contract verification",
    status: "queued",
    repoId: "repo-1",
    updatedAt: "now",
    sourceKind: "issue",
    sourceId: "repo-1:42",
    context: {
      repoIdentifier: "eladav/agents-over-github",
      labels: [],
      instruction: "Do it"
    }
  } as unknown as TaskRecord;

  const error = new NoProviderAvailableError(
    "product",
    "strong",
    ["claude", "opencode"],
    "All matching providers are currently limited"
  );

  await notifier.notifyQueued(taskRecord, error.limitedProviders);

  assert.ok(postedComment);
  assert.equal(postedComment.owner, "eladav");
  assert.equal(postedComment.name, "agents-over-github");
  assert.equal(postedComment.issueNumber, 42);
  assert.match(postedComment.body, /queued/);
  assert.match(postedComment.body, /claude/);
  assert.match(postedComment.body, /opencode/);
});
