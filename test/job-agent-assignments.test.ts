import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, describe } from "node:test";
import { StateStore } from "../src/state/loader.js";
import {
  resolveJobAgentAssignment,
  recordJobAgentAssignmentExecution,
  getJobKey,
  getJobAgentAssignmentId
} from "../src/agents/job-agent-assignments.js";
import type { TaskRecord, JobAgentAssignmentRecord } from "../src/state/types.js";
import type { AgentConfig } from "../src/config/types.js";

describe("Job Agent Assignments", () => {
  const now = "2026-06-02T10:00:00.000Z";

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
    createdAt: now,
    updatedAt: now
  };

  const agents: AgentConfig[] = [
    {
      id: "agent-strong-1",
      provider: "codex",
      modelClass: "strong",
      roles: ["planning"],
      enabled: true,
      command: "run"
    },
    {
      id: "agent-strong-2",
      provider: "claude",
      modelClass: "strong",
      roles: ["planning"],
      enabled: true,
      command: "run"
    }
  ];

  test("1. Missing job-agent-assignments.json loads as an empty list", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-state-test-"));
    try {
      const store = new StateStore(tempDir);
      const state = await store.load();
      assert.deepEqual(state.jobAgentAssignments, []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("2. writeJobAgentAssignmentState writes pretty JSON and sorts correctly", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-state-write-test-"));
    try {
      const store = new StateStore(tempDir);
      const records: JobAgentAssignmentRecord[] = [
        {
          id: "id-2",
          repoKey: "b/repo",
          workstreamId: "ws-1",
          role: "planning",
          modelClass: "strong",
          jobKey: "planning-strong",
          configuredAgentId: "agent-1",
          provider: "codex",
          status: "active",
          createdAt: now,
          updatedAt: now
        },
        {
          id: "id-1",
          repoKey: "a/repo",
          workstreamId: "ws-1",
          role: "planning",
          modelClass: "strong",
          jobKey: "planning-strong",
          configuredAgentId: "agent-1",
          provider: "codex",
          status: "active",
          createdAt: now,
          updatedAt: now
        }
      ];

      await store.writeJobAgentAssignmentState(records);
      const content = await readFile(path.join(tempDir, "job-agent-assignments.json"), "utf8");
      const parsed = JSON.parse(content);

      assert.equal(parsed.assignments[0].repoKey, "a/repo");
      assert.equal(parsed.assignments[1].repoKey, "b/repo");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("3. First scoped task initializes an assignment", () => {
    const resolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: [],
      now
    });

    assert.equal(resolution.mode, "pinned");
    assert.equal(resolution.initialized, true);
    assert.ok(resolution.configuredAgent);
    assert.equal(resolution.assignments.length, 1);
    assert.equal(resolution.assignment?.repoKey, "owner/repo");
    assert.equal(resolution.assignment?.workstreamId, "ws-1");
    assert.equal(resolution.assignment?.configuredAgentId, resolution.configuredAgent.id);
  });

  test("4. Second task with same scope reuses the pinned agent", () => {
    const firstResolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: [],
      now
    });

    const secondResolution = resolveJobAgentAssignment({
      task: { ...task, id: "task-2" },
      agents,
      existingAssignments: firstResolution.assignments,
      now
    });

    assert.equal(secondResolution.mode, "pinned");
    assert.equal(secondResolution.initialized, false);
    assert.equal(secondResolution.configuredAgent.id, firstResolution.configuredAgent.id);
    assert.equal(secondResolution.assignments.length, 1);
  });

  test("5. Different job key in the same workstream creates separate assignment", () => {
    const firstResolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: [],
      now
    });

    const reviewTask: TaskRecord = {
      ...task,
      id: "task-review",
      kind: "review_pr" // role: review, modelClass: strong
    };

    const reviewAgents: AgentConfig[] = [
      ...agents,
      {
        id: "agent-review",
        provider: "codex",
        modelClass: "strong",
        roles: ["review"],
        enabled: true,
        command: "run"
      }
    ];

    const secondResolution = resolveJobAgentAssignment({
      task: reviewTask,
      agents: reviewAgents,
      existingAssignments: firstResolution.assignments,
      now
    });

    assert.equal(secondResolution.mode, "pinned");
    assert.equal(secondResolution.initialized, true);
    assert.equal(secondResolution.assignments.length, 2);
    assert.equal(secondResolution.assignment?.jobKey, "review-strong");
  });

  test("6. Same job key in a different workstream creates separate assignment", () => {
    const firstResolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: [],
      now
    });

    const otherWsTask: TaskRecord = {
      ...task,
      id: "task-other-ws",
      workstreamId: "ws-2"
    };

    const secondResolution = resolveJobAgentAssignment({
      task: otherWsTask,
      agents,
      existingAssignments: firstResolution.assignments,
      now
    });

    assert.equal(secondResolution.mode, "pinned");
    assert.equal(secondResolution.initialized, true);
    assert.equal(secondResolution.assignments.length, 2);
    assert.notEqual(secondResolution.assignment?.id, firstResolution.assignment?.id);
  });

  test("7. No-workstream task returns unscoped_fallback and does not create an assignment", () => {
    const noWsTask: TaskRecord = {
      ...task,
      workstreamId: undefined
    };

    const resolution = resolveJobAgentAssignment({
      task: noWsTask,
      agents,
      existingAssignments: [],
      now
    });

    assert.equal(resolution.mode, "unscoped_fallback");
    assert.equal(resolution.initialized, false);
    assert.equal(resolution.assignments.length, 0);
  });

  test("8. Disabled pinned agent is marked stale and reassigned", () => {
    const firstResolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: [],
      now
    });

    const disabledAgents = agents.map(a =>
      a.id === firstResolution.configuredAgent.id ? { ...a, enabled: false } : a
    );

    const nextResolution = resolveJobAgentAssignment({
      task: { ...task, id: "task-2" },
      agents: disabledAgents,
      existingAssignments: firstResolution.assignments,
      now
    });

    assert.equal(nextResolution.initialized, true);
    assert.notEqual(nextResolution.configuredAgent.id, firstResolution.configuredAgent.id);
    const stale = nextResolution.assignments.find((a) => a.id === firstResolution.assignment!.id);
    assert.equal(stale?.status, "stale");
    assert.match(stale?.notes ?? "", /disabled/);
  });

  test("9. Removed pinned agent is marked stale and reassigned", () => {
    const firstResolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: [],
      now
    });

    const otherAgents = [agents[1]!]; // Remove agent picked in first resolution if it was agents[0]
    const pinnedAgentId = firstResolution.configuredAgent.id;
    const filteredAgents = agents.filter(a => a.id !== pinnedAgentId);

    const nextResolution = resolveJobAgentAssignment({
      task: { ...task, id: "task-2" },
      agents: filteredAgents,
      existingAssignments: firstResolution.assignments,
      now
    });

    assert.equal(nextResolution.initialized, true);
    assert.notEqual(nextResolution.configuredAgent.id, pinnedAgentId);
    const stale = nextResolution.assignments.find((a) => a.id === firstResolution.assignment!.id);
    assert.equal(stale?.status, "stale");
    assert.match(stale?.notes ?? "", /no longer exists/);
  });

  test("10. Pinned agent with wrong provider is marked stale and reassigned", () => {
    const firstResolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: [],
      now
    });

    const wrongProviderAgents = agents.map(a =>
      a.id === firstResolution.configuredAgent.id
        ? { ...a, provider: (a.provider === "codex" ? "claude" : "codex") as any }
        : a
    );

    const nextResolution = resolveJobAgentAssignment({
      task: { ...task, id: "task-2" },
      agents: wrongProviderAgents,
      existingAssignments: firstResolution.assignments,
      now
    });

    assert.equal(nextResolution.initialized, true);
    const stale = nextResolution.assignments.find((a) => a.id === firstResolution.assignment!.id);
    assert.equal(stale?.status, "stale");
    assert.match(stale?.notes ?? "", /provider changed/);
  });

  test("11. Assignment execution metadata updates are deterministic", () => {
    const resolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: [],
      now
    });

    const startedAt = "2026-06-02T10:05:00.000Z";
    const endedAt = "2026-06-02T10:10:00.000Z";

    const updated = recordJobAgentAssignmentExecution({
      assignments: resolution.assignments,
      assignmentId: resolution.assignment!.id,
      taskId: "task-1",
      executionId: "exec-1",
      startedAt,
      endedAt,
      taskStatus: "completed"
    });

    assert.equal(updated.length, 1);
    assert.equal(updated[0]?.lastTaskId, "task-1");
    assert.equal(updated[0]?.lastExecutionId, "exec-1");
    assert.equal(updated[0]?.lastStartedAt, startedAt);
    assert.equal(updated[0]?.lastCompletedAt, endedAt);
    assert.equal(updated[0]?.updatedAt, endedAt);
  });

  test("12. resolveJobAgentAssignment creates unique IDs for new assignments when stale one exists", () => {
    const firstResolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: [],
      now
    });

    const assignmentId = firstResolution.assignment!.id;

    // Mark the first assignment as stale
    const staleAssignments = firstResolution.assignments.map(a => ({ ...a, status: "stale" as const }));

    const secondResolution = resolveJobAgentAssignment({
      task,
      agents,
      existingAssignments: staleAssignments,
      now: "2026-06-02T11:00:00.000Z"
    });

    // Check for duplicate IDs
    const ids = secondResolution.assignments.map(a => a.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, `Should have unique IDs, but found duplicates: ${ids}`);

    // If we use unique IDs across generations, we should have 2 assignments with different IDs
    assert.equal(secondResolution.assignments.length, 2, "Should have two assignments (one stale, one active)");
    assert.notEqual(secondResolution.assignment?.id, assignmentId, "New assignment should have a different ID");
  });
});
