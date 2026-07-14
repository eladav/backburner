import * as assert from "node:assert/strict";
import { test } from "node:test";
import { runDispatchWithMergePrepLifecycle } from "../src/cli/run.js";
import type { TaskRecord } from "../src/tasks/types.js";

function createFailedTask(id: string): TaskRecord {
  return {
    id,
    kind: "respond_pr_comment",
    status: "failed",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: "repo-1",
    repoName: "example-repo",
    repoSlug: "example-org/example-repo",
    sourceKind: "pull_request",
    sourceId: `pull_request_review_comment:${id}`,
    sourceUrl: `https://example.test/pull/1#${id}`,
    relevant: true,
    reason: "Review requested changes.",
    summary: "Respond to PR comment",
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
    context: {
      localRepoPath: "/tmp/code/_worktrees/example-org/example-repo/packet-1",
      branchName: "agent/example-org/example-repo/packet-1",
      recoveryNeeded: true
    }
  } as TaskRecord;
}

test("workspace recovery clears every failed task sharing a recovered path", async () => {
  const first = createFailedTask("task-1");
  const second = createFailedTask("task-2");
  let recoverCalls = 0;
  const taskStateWrites: TaskRecord[][] = [];

  const result = await runDispatchWithMergePrepLifecycle({
    tasks: [first, second],
    executions: [],
    worktrees: [],
    workstreams: [],
    capabilityValidation: { valid: [], blocked: [] },
    mcpStatuses: [],
    declaredMcps: [],
    capabilitiesConfig: { sensors: [], controllers: [] },
    agents: [],
    enabledRepos: [],
    codeRoot: "/tmp/code",
    logDir: "/tmp/log",
    stateStore: {
      loadWorkspaceRecoveryState: async () => [],
      writeWorkspaceRecoveryState: async () => {},
      writeTaskState: async (tasks: TaskRecord[]) => { taskStateWrites.push(tasks.map((task) => ({ ...task, context: { ...task.context } }))); },
      writeExecutionState: async () => {},
      writeWorkstreamState: async () => {},
      writeMcpStatusState: async () => {},
      writeJobAgentAssignmentState: async () => {},
      writeProviderSessionState: async () => {}
    } as any,
    agentRunner: { dispatch: async () => { throw new Error("failed tasks must not dispatch"); } },
    failureNotifier: undefined,
    reviewPublisher: undefined,
    planBreakdownPublisher: undefined,
    waveAssessmentPublisher: undefined,
    lifecycleNotifier: undefined,
    jobMemoryRuntime: undefined,
    logger: { info: () => {}, warn: () => {} },
    promptsConfig: undefined,
    managementRoot: undefined,
    mergePrepService: { refreshPersistentWorktreeBeforeDispatch: async () => ({ status: "succeeded", message: "ok" }) } as any,
    githubGateway: {} as any,
    backburnerGitToolService: {} as any,
    commandRunner: {} as any,
    gitGateway: {} as any,
    workspaceRecoveryService: {
      isRecoveryNeeded: (task: TaskRecord) => task.context.recoveryNeeded === true,
      resolveTaskWorkspacePath: (task: TaskRecord) => task.context.localRepoPath ?? null,
      recoverWorkspace: async () => {
        recoverCalls += 1;
        return {
          taskId: first.id,
          taskKind: first.kind,
          workspacePath: first.context.localRepoPath,
          outcome: "recovered" as const,
          reason: "Workspace reset.",
          recoveredAt: "2026-07-14T10:01:00.000Z"
        };
      }
    } as any
  });

  assert.equal(recoverCalls, 1);
  assert.deepEqual(result.tasks.map((task) => task.context.recoveryNeeded), [false, false]);
  assert.ok(taskStateWrites.some((tasks) => tasks.every((task) => task.context.recoveryNeeded === false)));
});

test("a follow-up dispatch lifecycle can skip workspace recovery", async () => {
  const task = createFailedTask("task-1");
  let recoverCalls = 0;

  await runDispatchWithMergePrepLifecycle({
    tasks: [task],
    executions: [],
    worktrees: [],
    workstreams: [],
    capabilityValidation: { valid: [], blocked: [] },
    mcpStatuses: [],
    declaredMcps: [],
    capabilitiesConfig: { sensors: [], controllers: [] },
    agents: [],
    enabledRepos: [],
    codeRoot: "/tmp/code",
    logDir: "/tmp/log",
    stateStore: {
      loadWorkspaceRecoveryState: async () => [],
      writeWorkspaceRecoveryState: async () => {},
      writeTaskState: async () => {},
      writeExecutionState: async () => {},
      writeWorkstreamState: async () => {},
      writeMcpStatusState: async () => {},
      writeJobAgentAssignmentState: async () => {},
      writeProviderSessionState: async () => {}
    } as any,
    agentRunner: { dispatch: async () => { throw new Error("failed tasks must not dispatch"); } },
    failureNotifier: undefined,
    reviewPublisher: undefined,
    planBreakdownPublisher: undefined,
    waveAssessmentPublisher: undefined,
    lifecycleNotifier: undefined,
    jobMemoryRuntime: undefined,
    logger: { info: () => {}, warn: () => {} },
    promptsConfig: undefined,
    managementRoot: undefined,
    mergePrepService: { refreshPersistentWorktreeBeforeDispatch: async () => ({ status: "succeeded", message: "ok" }) } as any,
    githubGateway: {} as any,
    backburnerGitToolService: {} as any,
    commandRunner: {} as any,
    gitGateway: {} as any,
    workspaceRecoveryService: {
      isRecoveryNeeded: () => true,
      resolveTaskWorkspacePath: () => task.context.localRepoPath ?? null,
      recoverWorkspace: async () => {
        recoverCalls += 1;
        throw new Error("recovery must not run in the follow-up lifecycle");
      }
    } as any,
    skipWorkspaceRecovery: true
  });

  assert.equal(recoverCalls, 0);
});
