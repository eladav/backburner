import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { GitHubPlanBreakdownPublisher, renderPlanBreakdownComment } from "../src/agents/plan-breakdown-feedback.js";
import { dispatchPendingTasks } from "../src/agents/service.js";
import { StateStore } from "../src/state/loader.js";
import type { ExecutionRecord, PlanBreakdownResult } from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { workflowRegistry } from "../src/workflows/registry.js";

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const kind = overrides.kind ?? "plan_breakdown";
  const executionPolicy = workflowRegistry.resolveTaskExecutionPolicy(kind);
  return {
    id: "task:plan_breakdown:issue:eladaviv/repo-one:11",
    kind,
    status: "pending",
    executionPermission: executionPolicy.executionPermission,
    handoffPolicy: executionPolicy.handoffPolicy,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    sourceKind: "issue",
    sourceId: "issue:eladaviv/repo-one:11",
    sourceUrl: "https://github.com/eladaviv/repo-one/issues/11",
    relevant: true,
    reason: "Breakdown needed.",
    summary: "Break down the implementation",
    context: {
        repoIdentifier: "eladaviv/repo-one",
        localRepoPath: "/tmp/code-root/repo-one",
        labels: ["plan-breakdown-needed"],
        instruction: "Break down the issue."
    },
    createdAt: "2026-04-18T09:00:00.000Z",
    updatedAt: "2026-04-18T09:00:00.000Z",
    ...overrides
  };
}

const validBreakdown: PlanBreakdownResult = {
  title: "Test Plan",
  summary: "This is a test plan.",
  tasks: [
    {
      id: "T1",
      title: "Task 1",
      description: "Desc 1",
      dependsOn: [],
      blocks: ["T2"],
      canRunInParallelWith: [],
      risk: "low",
      filesLikelyInvolved: ["src/file1.ts"],
      acceptanceCriteria: ["Criteria 1"],
      verification: ["Verify 1"]
    },
    {
      id: "T2",
      title: "Task 2",
      description: "Desc 2",
      dependsOn: ["T1"],
      blocks: [],
      canRunInParallelWith: [],
      risk: "medium",
      filesLikelyInvolved: ["src/file2.ts"],
      acceptanceCriteria: ["Criteria 2"],
      verification: ["Verify 2"]
    }
  ],
  waves: [
    {
      id: "W1",
      taskIds: ["T1"],
      rationale: "Wave 1 rationale"
    },
    {
      id: "W2",
      taskIds: ["T2"],
      rationale: "Wave 2 rationale"
    }
  ],
  recommendedFirstWaveId: "W1",
  graphConcerns: ["Concern 1"],
  humanDecisionsNeeded: ["Decision 1"],
  suggestedNextAction: "Next action"
};

test("renderPlanBreakdownComment renders all required sections", () => {
  const rendered = renderPlanBreakdownComment(validBreakdown);

  assert.ok(rendered.startsWith("🤖 Breakdown recommendation"));
  assert.ok(rendered.includes("## Summary"));
  assert.ok(rendered.includes("This is a test plan."));
  assert.ok(rendered.includes("## Dependency graph"));
  assert.ok(rendered.includes("| T1 | Task 1 | - | T2 | - | low |"));
  assert.ok(rendered.includes("| T2 | Task 2 | T1 | - | - | medium |"));
  assert.ok(rendered.includes("## Execution waves"));
  assert.ok(rendered.includes("### Wave W1"));
  assert.ok(rendered.includes("Wave 1 rationale"));
  assert.ok(rendered.includes("- T1: Task 1"));
  assert.ok(rendered.includes("## Recommended first wave"));
  assert.ok(rendered.includes("W1"));
  assert.ok(rendered.includes("## Staged implementation packets"));
  assert.ok(rendered.includes("### T1: Task 1"));
  assert.ok(rendered.includes("Desc 1"));
  assert.ok(rendered.includes("- **Files likely involved:** src/file1.ts"));
  assert.ok(rendered.includes("Criteria 1"));
  assert.ok(rendered.includes("Verify 1"));
  assert.ok(rendered.includes("## Graph concerns / uncertainty"));
  assert.ok(rendered.includes("- Concern 1"));
  assert.ok(rendered.includes("## Human decisions needed"));
  assert.ok(rendered.includes("- Decision 1"));
  assert.ok(rendered.includes("## Suggested next action"));
  assert.ok(rendered.includes("Next action"));
});

test("dispatchPendingTasks publishes structured plan breakdown outcomes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-breakdown-publish-"));

  try {
    const task = baseTask({
        kind: "plan_breakdown",
        status: "pending",
        sourceId: "issue:eladaviv/repo-one:11",
        sourceUrl: "https://github.com/eladaviv/repo-one/issues/11",
    });
    const store = new StateStore(tempDir);
    const comments: Array<Record<string, unknown>> = [];

    const publisher = new GitHubPlanBreakdownPublisher(
      {
        async postIssueComment(input: unknown) {
          comments.push(input as Record<string, unknown>);
          return { id: 1 } as any;
        }
      } as any,
      [
        {
          id: "repo-1",
          owner: "eladaviv",
          name: "repo-one",
          localPath: "repo-one",
          defaultBranch: "main",
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
        }
      ]
    );

    const result = await dispatchPendingTasks({
      tasks: [task],
      agents: [{ id: "agent-1", provider: "codex", modelClass: "strong", roles: ["implementation_manager"], command: "echo", enabled: true }],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      planBreakdownPublisher: publisher,
      agentRunner: {
        async dispatch(task) {
          return {
            taskStatus: "completed",
            execution: {
              id: "exec:test:breakdown",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "agent-1",
              agentProvider: "codex",
              command: { executable: "echo", args: [], cwd: "/tmp", timeoutMs: 1000 },
              promptArtifactPath: path.join(tempDir, "prompt.md"),
              stdoutArtifactPath: path.join(tempDir, "stdout.txt"),
              stderrArtifactPath: path.join(tempDir, "stderr.txt"),
              promptPacketPath: path.join(tempDir, "prompt-packet.json"),
              startedAt: "2026-04-18T10:01:00.000Z",
              endedAt: "2026-04-18T10:01:10.000Z",
              exitCode: 0,
              result: {
                planBreakdown: validBreakdown
              }
            } as ExecutionRecord
          };
        }
      },
      now: () => "2026-04-18T10:01:00.000Z"
    });

    assert.equal(result.tasks[0]?.status, "completed");

    assert.equal(comments.length, 1);
    const firstComment = comments[0];
    assert.ok(firstComment);
    const commentBody = firstComment.body as string;
    assert.ok(commentBody.startsWith("🤖 Breakdown recommendation"));
    assert.ok(commentBody.includes("## Summary"));
    assert.ok(commentBody.includes("This is a test plan."));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("renderPlanBreakdownComment respects wave task order", () => {
  const t1 = validBreakdown.tasks[0];
  const t2 = validBreakdown.tasks[1];

  if (!t1 || !t2) {
    throw new Error("validBreakdown.tasks should have at least 2 tasks");
  }

  const resultWithOutOfOrderTasks: PlanBreakdownResult = {
    ...validBreakdown,
    tasks: [
      { ...t1, id: "T1", title: "Task 1" },
      { ...t2, id: "T2", title: "Task 2" }
    ],
    waves: [
      {
        id: "W1",
        taskIds: ["T2", "T1"],
        rationale: "Reordered wave"
      }
    ],
    recommendedFirstWaveId: "W1"
  };

  const rendered = renderPlanBreakdownComment(resultWithOutOfOrderTasks);

  const waveSection = rendered.substring(rendered.indexOf("### Wave W1"));
  const t1Index = waveSection.indexOf("- T1: Task 1");
  const t2Index = waveSection.indexOf("- T2: Task 2");

  assert.ok(t2Index !== -1, "T2 should be present");
  assert.ok(t1Index !== -1, "T1 should be present");
  assert.ok(t2Index < t1Index, "T2 should be rendered before T1 in the wave section");
});

test("GitHubPlanBreakdownPublisher skips completed missing-result execution", async () => {
  const comments: any[] = [];
  const publisher = new GitHubPlanBreakdownPublisher(
    {
      async postIssueComment(input: any) {
        comments.push(input);
        return { id: 1 };
      }
    } as any,
    []
  );

  const task = baseTask();
  const execution: ExecutionRecord = {
    id: "exec-1",
    taskId: task.id,
    taskKind: "plan_breakdown",
    taskStatus: "completed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "agent-1",
    agentProvider: "codex",
    command: { executable: "echo", args: [], cwd: ".", timeoutMs: 1000 },
    promptArtifactPath: "",
    stdoutArtifactPath: "",
    stderrArtifactPath: "",
    promptPacketPath: "",
    startedAt: "",
    endedAt: "",
    exitCode: 0,
    result: {} // missing planBreakdown
  };

  await publisher.publishBreakdown(task, execution);
  assert.equal(comments.length, 0);
});

test("GitHubPlanBreakdownPublisher skips failed execution", async () => {
  const comments: any[] = [];
  const publisher = new GitHubPlanBreakdownPublisher(
    {
      async postIssueComment(input: any) {
        comments.push(input);
        return { id: 1 };
      }
    } as any,
    []
  );

  const task = baseTask();
  const execution: ExecutionRecord = {
    id: "exec-1",
    taskId: task.id,
    taskKind: "plan_breakdown",
    taskStatus: "failed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "agent-1",
    agentProvider: "codex",
    command: { executable: "echo", args: [], cwd: ".", timeoutMs: 1000 },
    promptArtifactPath: "",
    stdoutArtifactPath: "",
    stderrArtifactPath: "",
    promptPacketPath: "",
    startedAt: "",
    endedAt: "",
    exitCode: 1,
    result: {
      planBreakdown: validBreakdown
    }
  };

  await publisher.publishBreakdown(task, execution);
  assert.equal(comments.length, 0);
});
