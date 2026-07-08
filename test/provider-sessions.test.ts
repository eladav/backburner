import * as assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  resolveProviderSessionScope,
  getProviderSessionRecordId,
  evaluateProviderSessionDecision as originalEvaluateProviderSessionDecision
} from "../src/agents/provider-sessions.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { AgentConfig } from "../src/config/types.js";
import type { ProviderSessionScope, ProviderSessionRecord } from "../src/state/types.js";

describe("Provider Sessions", () => {
  const task: TaskRecord = {
    id: "task-1",
    kind: "write_plan",
    repoSlug: "owner/repo",
    workstreamId: "ws-1",
    status: "pending",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: "repo-1",
    repoName: "repo",
    sourceKind: "issue",
    sourceId: "issue-1",
    sourceUrl: "url",
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: "owner/repo",
      labels: [],
      instruction: "do it",
      localRepoPath: "/tmp/repo",
      branchName: "feature-branch"
    },
    createdAt: "now",
    updatedAt: "now"
  };

  const agentConfig: AgentConfig = {
    id: "agent-1",
    provider: "codex",
    modelClass: "strong",
    roles: ["planning"],
    enabled: true,
    command: "run"
  };

  test("resolves scope correctly", () => {
    const scope = resolveProviderSessionScope(task, agentConfig);
    assert.deepEqual(scope, {
      repoKey: "owner/repo",
      workstreamId: "ws-1",
      job: "planning",
      modelClass: "strong",
      configuredAgentId: "agent-1",
      provider: "codex",
      localRepoPath: "/tmp/repo",
      branchName: "feature-branch"
    });
  });

  test("fails if workstreamId is missing", () => {
    const taskWithoutWs = { ...task, workstreamId: undefined };
    assert.throws(() => resolveProviderSessionScope(taskWithoutWs, agentConfig), {
      message: /requires a workstream identity/
    });
  });

  test("fails if localRepoPath or branchName is missing", () => {
    const taskWithoutPath = {
      ...task,
      context: { ...task.context, localRepoPath: undefined }
    };
    assert.throws(() => resolveProviderSessionScope(taskWithoutPath as any, agentConfig), {
      message: /missing localRepoPath or branchName/
    });
  });

  test("fails if agent model class does not match workflow required model class", () => {
    const cheapAgent: AgentConfig = { ...agentConfig, modelClass: "cheap" };
    // task.kind is "write_plan" which requires "strong"
    assert.throws(() => resolveProviderSessionScope(task, cheapAgent), {
      message: /does not match required model class "strong" for task "write_plan"/
    });
  });

  test("generates stable record ID from scope", () => {
    const scope = resolveProviderSessionScope(task, agentConfig);
    const id1 = getProviderSessionRecordId(scope);
    const id2 = getProviderSessionRecordId({ ...scope });
    assert.equal(id1, id2);
    assert.equal(id1.length, 64); // sha256 hex
  });

  describe("evaluateProviderSessionDecision", () => {
    const scope = resolveProviderSessionScope(task, agentConfig);

    const evaluateProviderSessionDecision = (input: Omit<Parameters<typeof originalEvaluateProviderSessionDecision>[0], "taskKind"> & { taskKind?: string }) => {
      return originalEvaluateProviderSessionDecision({
        taskKind: "write_plan",
        ...input
      });
    };

    test("returns fallback for unsupported capability", () => {
      const decision = evaluateProviderSessionDecision({
        capability: "unsupported",
        requestedScope: scope,
        nativeResumeEnabled: true
      });
      assert.deepEqual(decision, { mode: "fallback", reason: "unsupported" });
    });

    test("returns fallback for unverified capability", () => {
      const decision = evaluateProviderSessionDecision({
        capability: "unverified",
        requestedScope: scope,
        nativeResumeEnabled: true
      });
      assert.deepEqual(decision, { mode: "fallback", reason: "unverified" });
    });

    test("returns fallback if native resume is disabled", () => {
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: scope,
        nativeResumeEnabled: false
      });
      assert.deepEqual(decision, { mode: "fallback", reason: "native_resume_not_enabled" });
    });

    test("returns fallback if no existing record", () => {
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: scope,
        nativeResumeEnabled: true
      });
      assert.deepEqual(decision, { mode: "fallback", reason: "no_session_record" });
    });

    test("returns native_resume_candidate if scope matches and enabled", () => {
      const record: ProviderSessionRecord = {
        id: "id",
        scope,
        capability: "verified_headless_resume",
        status: "available",
        createdAt: "now",
        updatedAt: "now"
      };
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: scope,
        existingRecord: record,
        nativeResumeEnabled: true
      });
      assert.deepEqual(decision, { mode: "native_resume_candidate", record });
    });

    test("returns fallback if scope mismatches", () => {
      const record: ProviderSessionRecord = {
        id: "id",
        scope: { ...scope, branchName: "different" },
        capability: "verified_headless_resume",
        status: "available",
        createdAt: "now",
        updatedAt: "now"
      };
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: scope,
        existingRecord: record,
        nativeResumeEnabled: true
      });
      assert.deepEqual(decision, { mode: "fallback", reason: "scope_mismatch" });
    });

    test("returns fallback if existing record is unsupported", () => {
      const record: ProviderSessionRecord = {
        id: "id",
        scope,
        capability: "unsupported",
        status: "unsupported",
        createdAt: "now",
        updatedAt: "now"
      };
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: scope,
        existingRecord: record,
        nativeResumeEnabled: true
      });
      assert.deepEqual(decision, { mode: "fallback", reason: "unsupported" });
    });

    test("returns fallback if existing record is unverified", () => {
      const record: ProviderSessionRecord = {
        id: "id",
        scope,
        capability: "unverified",
        status: "unverified",
        createdAt: "now",
        updatedAt: "now"
      };
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: scope,
        existingRecord: record,
        nativeResumeEnabled: true
      });
      assert.deepEqual(decision, { mode: "fallback", reason: "unverified" });
    });

    test("returns fallback if existing record is closed", () => {
      const record: ProviderSessionRecord = {
        id: "id",
        scope,
        capability: "verified_headless_resume",
        status: "closed",
        createdAt: "now",
        updatedAt: "now"
      };
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: scope,
        existingRecord: record,
        nativeResumeEnabled: true
      });
      // We'll decide what reason to use for closed. maybe "no_session_record" or a new one.
      // The comment says "fail closed for unsupported/unverified incompatible records".
      // Let's use "no_session_record" for closed if we don't want to add a new reason,
      // or add "closed" as a reason.
      assert.deepEqual(decision, { mode: "fallback", reason: "no_session_record" });
    });

    test("returns fallback if existing record is stale", () => {
      const record: ProviderSessionRecord = {
        id: "id",
        scope,
        capability: "verified_headless_resume",
        status: "stale",
        providerSessionId: "native-id",
        createdAt: "now",
        updatedAt: "now",
        lastFailedAt: "now"
      };
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: scope,
        existingRecord: record,
        nativeResumeEnabled: true
      });
      assert.deepEqual(decision, { mode: "fallback", reason: "no_session_record" });
    });

    test("throws if unsupported record carries identity", () => {
      const record: ProviderSessionRecord = {
        id: "id",
        scope,
        capability: "unsupported",
        status: "unsupported",
        providerSessionId: "native-id",
        createdAt: "now",
        updatedAt: "now"
      };
      assert.throws(
        () =>
          evaluateProviderSessionDecision({
            capability: "unsupported",
            requestedScope: scope,
            existingRecord: record,
            nativeResumeEnabled: true
          }),
        { message: /cannot carry provider identity/ }
      );
    });

    test("returns new_session with planned uuid for Claude if no existing record", () => {
      const claudeScope = { ...scope, provider: "claude" as const };
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: claudeScope,
        nativeResumeEnabled: true,
        taskKind: "write_plan"
      });
      assert.equal(decision.mode, "new_session");
      if (decision.mode === "new_session") {
        assert.ok(decision.providerSessionId);
        assert.equal(decision.providerSessionName, "backburner:owner/repo:write_plan:ws-1");
      }
    });

    test("returns new_session with planned uuid for Claude if record is stale or closed", () => {
      const claudeScope = { ...scope, provider: "claude" as const };
      const staleRecord: ProviderSessionRecord = {
        id: "id",
        scope: claudeScope,
        capability: "verified_headless_resume",
        status: "stale",
        providerSessionId: "old-id",
        createdAt: "now",
        updatedAt: "now"
      };
      const decision = evaluateProviderSessionDecision({
        capability: "verified_headless_resume",
        requestedScope: claudeScope,
        existingRecord: staleRecord,
        nativeResumeEnabled: true,
        taskKind: "write_plan"
      });
      assert.equal(decision.mode, "new_session");
    });
  });
});
