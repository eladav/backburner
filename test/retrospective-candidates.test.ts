import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerRetrospectiveCandidates } from "../src/retrospectives/candidates.js";
import type { RegisterRetrospectiveCandidatesInput } from "../src/retrospectives/candidates.js";
import type { WorkstreamRecord } from "../src/state/types.js";
import type { NormalizedIssue } from "../src/domain/entities.js";

describe("registerRetrospectiveCandidates", () => {
  const now = "2026-06-03T00:00:00Z";

  const defaultInput: RegisterRetrospectiveCandidatesInput = {
    previousCandidates: [],
    workstreams: [],
    issues: [],
    pullRequests: [],
    tasks: [],
    executions: [],
    worktrees: [],
    managementPrs: [],
    now,
  };

  it("creates exactly one candidate for a completed/merged operational workstream", () => {
    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [
        {
          id: "ws-1",
          repoKey: "owner/repo",
          origin: { type: "issue", number: 1 },
          linkedPrs: [],
          phase: "resolved",
          attention: "idle",
          status: "merged",
          resolution: "merged",
        } as unknown as WorkstreamRecord,
      ],
      issues: [
        {
          id: "iss-1",
          repoSlug: "owner/repo",
          number: 1,
          title: "Test Issue",
          url: "http://test/1",
          labels: ["bug"],
          state: "closed",
          author: "user",
          createdAt: now,
          updatedAt: now,
        } as unknown as NormalizedIssue,
      ],
    };

    const result = registerRetrospectiveCandidates(input);
    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.registered.length, 1);
    assert.strictEqual(result.skipped.length, 0);

    const candidate = result.candidates[0]!;
    assert.strictEqual(candidate.sourceWorkstreamId, "ws-1");
    assert.strictEqual(candidate.origin.type, "issue");
    assert.strictEqual(candidate.origin.number, 1);
    assert.strictEqual(candidate.terminalResolution, "merged");
    assert.strictEqual(candidate.title, "Test Issue");
    assert.deepStrictEqual(candidate.labels, ["bug"]);
    assert.strictEqual(candidate.evidenceReferences.length, 2);
  });

  it("creates exactly one candidate for a closed operational workstream", () => {
    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      managementRepo: { repoSlug: "owner/management-repo" },
      workstreams: [
        {
          id: "ws-2",
          repoKey: "owner/repo",
          origin: { type: "pr", number: 2 },
          linkedPrs: [],
          phase: "abandoned",
          attention: "idle",
          status: "closed",
          resolution: "closed",
        } as unknown as WorkstreamRecord,
      ],
    };

    const result = registerRetrospectiveCandidates(input);
    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.candidates[0]!.terminalResolution, "closed");
  });

  it("creates no candidate for an open/unresolved workstream", () => {
    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [
        {
          id: "ws-3",
          repoKey: "owner/repo",
          origin: { type: "issue", number: 3 },
          linkedPrs: [],
          phase: "implementing",
          attention: "idle",
          status: "open",
          resolution: "unresolved",
        } as unknown as WorkstreamRecord,
      ],
    };

    const result = registerRetrospectiveCandidates(input);
    assert.strictEqual(result.candidates.length, 0);
  });

  it("creates no duplicate when re-running registration with the prior candidate list", () => {
    const ws = {
      id: "ws-4",
      repoKey: "owner/repo",
      origin: { type: "issue", number: 4 },
      linkedPrs: [],
      phase: "resolved",
      attention: "idle",
      status: "merged",
      resolution: "merged",
    } as unknown as WorkstreamRecord;

    const input1: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [ws],
    };

    const result1 = registerRetrospectiveCandidates(input1);
    assert.strictEqual(result1.candidates.length, 1);

    const input2: RegisterRetrospectiveCandidatesInput = {
      ...input1,
      previousCandidates: result1.candidates,
    };

    const result2 = registerRetrospectiveCandidates(input2);
    assert.strictEqual(result2.candidates.length, 1);
    assert.strictEqual(result2.registered.length, 0);
  });

  it("preserves existing candidate status on rerun", () => {
    const existingCandidate = {
      id: "retrospective-candidate:owner/repo:ws-5:issue-5:merged",
      sourceWorkstreamId: "ws-5",
      repoId: "owner/repo",
      repoSlug: "owner/repo",
      repoKey: "owner/repo",
      origin: { type: "issue" as const, number: 5 },
      terminalResolution: "merged" as const,
      detectedAt: now,
      resolvedAt: now,
      status: "selected" as const,
      labels: [],
      sourceSummary: "",
      taskSummary: { total: 0, completed: 0, failed: 0, kinds: [], taskIds: [] },
      executionSummary: { total: 0, providers: [], models: [], roles: [], executionIds: [] },
      artifactReferences: [],
      evidenceReferences: [],
    };

    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [
        {
          id: "ws-5",
          repoKey: "owner/repo",
          origin: { type: "issue", number: 5 },
          linkedPrs: [],
          phase: "resolved",
          attention: "idle",
          status: "merged",
          resolution: "merged",
        } as unknown as WorkstreamRecord,
      ],
      previousCandidates: [existingCandidate as unknown as import("../src/retrospectives/types.js").RetrospectiveCandidateRecord],
    };

    const result = registerRetrospectiveCandidates(input);
    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.candidates[0]!.status, "selected");
  });

  it("skips if origin PR is classified as management", () => {
    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [
        {
          id: "ws-6",
          repoKey: "owner/repo",
          origin: { type: "pr", number: 6 },
          linkedPrs: [],
          phase: "resolved",
          attention: "idle",
          status: "merged",
          resolution: "merged",
        } as unknown as WorkstreamRecord,
      ],
      classifyPullRequest: () => ({ kind: "management", reason: "test" }),
    };

    const result = registerRetrospectiveCandidates(input);
    assert.strictEqual(result.candidates.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.match(result.skipped[0]!.reason, /classified as management/);
  });

  it("registers a candidate even if a linked PR classification is unknown", () => {
    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [
        {
          id: "ws-7",
          repoKey: "owner/repo",
          origin: { type: "issue", number: 7 },
          linkedPrs: [{ number: 8 } as any],
          phase: "resolved",
          attention: "idle",
          status: "merged",
          resolution: "merged",
        } as unknown as WorkstreamRecord,
      ],
      classifyPullRequest: () => ({ kind: "unknown", reason: "test unknown" }),
    };

    const result = registerRetrospectiveCandidates(input);
    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.registered.length, 1);
    assert.strictEqual(result.skipped.length, 0);
  });

  it("registers a candidate when management repo identity is unavailable", () => {
    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [
        {
          id: "ws-7b",
          repoKey: "owner/repo",
          origin: { type: "issue", number: 7 },
          linkedPrs: [{ number: 8 } as any],
          phase: "resolved",
          attention: "idle",
          status: "merged",
          resolution: "merged",
        } as unknown as WorkstreamRecord,
      ],
      pullRequests: [
        {
          repoSlug: "owner/repo",
          number: 8,
          headRefName: "agent/owner-repo/issue-7",
          baseRefName: "main",
        } as any,
      ],
    };

    const result = registerRetrospectiveCandidates(input);
    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.registered.length, 1);
    assert.strictEqual(result.skipped.length, 0);
  });

  it("contains enough reconstruction references", () => {
    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [
        {
          id: "ws-8",
          repoKey: "owner/repo",
          origin: { type: "issue", number: 8 },
          linkedPrs: [],
          phase: "resolved",
          attention: "idle",
          status: "merged",
          resolution: "merged",
        } as unknown as WorkstreamRecord,
      ],
      tasks: [
        {
          id: "t-1",
          workstreamId: "ws-8",
          repoSlug: "owner/repo",
          kind: "implement_plan",
          status: "completed",
          createdAt: now,
          updatedAt: now,
        } as unknown as import("../src/state/types.js").TaskRecord,
      ],
      executions: [
        {
          id: "ex-1",
          taskId: "t-1",
          taskKind: "implement_plan",
          taskStatus: "completed",
          repoId: "owner/repo",
          repoSlug: "owner/repo",
          agentId: "agent-1",
          agentProvider: "anthropic" as any,
          agentModel: "claude-3-5-sonnet",
          command: { executable: "echo", args: [], cwd: "/", timeoutMs: 1000 },
          promptArtifactPath: "/prompt.txt",
          stdoutArtifactPath: "/stdout.txt",
          stderrArtifactPath: "/stderr.txt",
          promptPacketPath: "/packet.json",
          startedAt: now,
          endedAt: now,
          exitCode: 0,
        } as unknown as import("../src/state/types.js").ExecutionRecord,
      ],
    };

    const result = registerRetrospectiveCandidates(input);
    const candidate = result.candidates[0]!;

    assert.strictEqual(candidate.taskSummary.total, 1);
    assert.deepStrictEqual(candidate.taskSummary.taskIds, ["t-1"]);
    assert.deepStrictEqual(candidate.taskSummary.kinds, ["implement_plan"]);

    assert.strictEqual(candidate.executionSummary.total, 1);
    assert.deepStrictEqual(candidate.executionSummary.executionIds, ["ex-1"]);
    assert.deepStrictEqual(candidate.executionSummary.models, ["claude-3-5-sonnet"]);

    assert.deepStrictEqual(candidate.artifactReferences, [
      "/prompt.txt",
      "/stdout.txt",
      "/stderr.txt",
      "/packet.json",
    ]);

    assert.strictEqual(candidate.evidenceReferences.length, 2);
    assert.strictEqual(candidate.evidenceReferences[0]!.kind, "workstream");
    assert.strictEqual(candidate.evidenceReferences[0]!.id, "ws-8");
  });

  it("populates execution roles from task kinds", () => {
    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [
        {
          id: "ws-9",
          repoKey: "owner/repo",
          origin: { type: "issue", number: 9 },
          linkedPrs: [],
          phase: "resolved",
          attention: "idle",
          status: "merged",
          resolution: "merged",
        } as unknown as WorkstreamRecord,
      ],
      tasks: [
        {
          id: "t-1",
          workstreamId: "ws-9",
          kind: "implement_plan",
          status: "completed",
        } as any,
        {
          id: "t-2",
          workstreamId: "ws-9",
          kind: "write_plan",
          status: "completed",
        } as any,
      ],
      executions: [
        {
          id: "ex-1",
          taskId: "t-1",
          startedAt: now,
        } as any,
        {
          id: "ex-2",
          taskId: "t-2",
          startedAt: now,
        } as any,
      ],
    };

    const result = registerRetrospectiveCandidates(input);
    const candidate = result.candidates[0]!;

    // implement_plan -> implementation
    // write_plan -> planning
    assert.ok(candidate.executionSummary.roles.includes("implementation" as any));
    assert.ok(candidate.executionSummary.roles.includes("planning" as any));
    assert.strictEqual(candidate.executionSummary.roles.length, 2);
  });

  it("uses the repoId from matched issue/PR instead of repoSlug", () => {
    const input: RegisterRetrospectiveCandidatesInput = {
      ...defaultInput,
      workstreams: [
        {
          id: "ws-repo-id",
          repoKey: "owner/repo-slug",
          origin: { type: "issue", number: 10 },
          linkedPrs: [],
          phase: "resolved",
          attention: "idle",
          status: "merged",
          resolution: "merged",
        } as unknown as WorkstreamRecord,
      ],
      issues: [
        {
          id: "iss-10",
          repoId: "configured-repo-id",
          repoSlug: "owner/repo-slug",
          number: 10,
          title: "Test Issue",
          url: "http://test/10",
          labels: [],
          state: "closed",
          author: "user",
          createdAt: now,
          updatedAt: now,
        } as unknown as NormalizedIssue,
      ],
    };

    const result = registerRetrospectiveCandidates(input);
    const candidate = result.candidates[0]!;
    assert.strictEqual(candidate.repoSlug, "owner/repo-slug");
    assert.strictEqual(candidate.repoId, "configured-repo-id");
  });
});
