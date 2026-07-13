import * as assert from "node:assert/strict";
import { test } from "node:test";
import { detectProviderLimit } from "../src/agents/extraction.js";
import { selectAgentForTask, NoProviderAvailableError } from "../src/agents/selection.js";
import { resolveJobAgentAssignment } from "../src/agents/job-agent-assignments.js";
import type { AgentConfig } from "../src/config/types.js";
import type { TaskRecord, ProviderLimitRecord } from "../src/state/types.js";

test("detectProviderLimit parses standard and custom rate limit signals correctly", () => {
  // Claude session limit
  const signal1 = detectProviderLimit("claude", 1, "", "Exceeded the 5-hour limit for messages");
  assert.ok(signal1);
  assert.equal(signal1.provider, "claude");
  assert.equal(signal1.limitType, "session");
  assert.equal(signal1.isLimited, true);

  // Claude weekly limit
  const signal2 = detectProviderLimit("claude", 1, "", "Weekly limit reached for Claude");
  assert.ok(signal2);
  assert.equal(signal2.provider, "claude");
  assert.equal(signal2.limitType, "weekly");

  // Codex rate limit
  const signal3 = detectProviderLimit("codex", 1, "", "Thread rate limit exceeded");
  assert.ok(signal3);
  assert.equal(signal3.provider, "codex");
  assert.equal(signal3.isLimited, true);

  assert.ok(detectProviderLimit("codex", 1, "", "Quota exceeded for this account"));
  assert.ok(detectProviderLimit("codex", 1, "", "Billing limit reached"));

  // Gemini quota exhaustion
  const geminiSignal = detectProviderLimit("gemini", 1, "", "RESOURCE_EXHAUSTED: quota exhausted");
  assert.ok(geminiSignal);
  assert.equal(geminiSignal.provider, "gemini");
  assert.equal(geminiSignal.isLimited, true);

  // Exit code 429
  const signal4 = detectProviderLimit("opencode", 429, "", "error");
  assert.ok(signal4);
  assert.equal(signal4.provider, "opencode");
  assert.equal(signal4.isLimited, true);

  assert.ok(detectProviderLimit("opencode", 1, "", "Daily quota exhausted"));
  assert.ok(detectProviderLimit("opencode", 1, "", "Provider quota unavailable"));

  assert.ok(detectProviderLimit("antigravity", 1, "", "Usage cap reached"));
  assert.ok(detectProviderLimit("antigravity", 1, "", "Session limit reached"));
  assert.ok(detectProviderLimit("antigravity", 1, "", "Quota exhausted"));

  // Non-limit error
  const signal5 = detectProviderLimit("antigravity", 1, "", "syntax error");
  assert.equal(signal5, undefined);
});

test("selectAgentForTask filters limited providers and throws NoProviderAvailableError", () => {
  const agents: AgentConfig[] = [
    { id: "c1", provider: "claude", modelClass: "strong", roles: ["review"], command: "c", enabled: true }
  ];

  const limits: ProviderLimitRecord[] = [
    { provider: "claude", status: "limited", updatedAt: "now" }
  ];

  const task = { kind: "review_pr", id: "t1" } as TaskRecord;

  assert.throws(
    () => selectAgentForTask(task, agents, limits),
    NoProviderAvailableError
  );
});

test("selectAgentForTask rejects replacement providers without equivalent broker tools", () => {
  const agents: AgentConfig[] = [
    { id: "c1", provider: "claude", modelClass: "strong", roles: ["review"], command: "c", enabled: true },
    { id: "g1", provider: "gemini", modelClass: "strong", roles: ["review"], command: "g", enabled: true }
  ];
  const task = { kind: "review_pr", id: "t1" } as TaskRecord;
  const limits: ProviderLimitRecord[] = [
    { provider: "claude", status: "limited", updatedAt: "now" }
  ];

  assert.throws(
    () =>
      selectAgentForTask(task, agents, limits, {
        replacementForProvider: "claude",
        providerBrokerToolAllowLists: new Map([
          ["claude", ["get_pr", "post_issue_comment"]],
          ["gemini", ["get_pr"]]
        ])
      }),
    NoProviderAvailableError
  );
});

test("resolveJobAgentAssignment deactivates assignment when provider is limited", () => {
  const agents: AgentConfig[] = [
    { id: "c1", provider: "claude", modelClass: "strong", roles: ["review"], command: "c", enabled: true },
    { id: "a1", provider: "antigravity", modelClass: "strong", roles: ["review"], command: "agy", enabled: true }
  ];

  const existingAssignments = [
    {
      id: "assign1",
      repoKey: "owner/repo",
      workstreamId: "ws1",
      role: "review" as const,
      modelClass: "strong" as const,
      jobKey: "review-strong" as const,
      configuredAgentId: "c1",
      provider: "claude" as const,
      status: "active" as const,
      createdAt: "now",
      updatedAt: "now"
    }
  ];

  const limits: ProviderLimitRecord[] = [
    { provider: "claude", status: "limited", updatedAt: "now" }
  ];

  const task = {
    kind: "review_pr",
    id: "t1",
    repoSlug: "owner/repo",
    workstreamId: "ws1"
  } as TaskRecord;

  const resolution = resolveJobAgentAssignment({
    task,
    agents,
    existingAssignments,
    providerLimits: limits,
    now: "now"
  });

  assert.equal(resolution.mode, "pinned");
  assert.equal(resolution.configuredAgent.id, "a1"); // Swapped to antigravity since claude is limited
  assert.equal(resolution.initialized, true);

  // Verify the old assignment was marked stale
  const oldAssignment = resolution.assignments.find(a => a.id === "assign1");
  assert.ok(oldAssignment);
  assert.equal(oldAssignment.status, "stale");
  assert.equal(oldAssignment.notes, "Pinned provider limit exceeded");
});
