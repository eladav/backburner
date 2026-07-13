import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  AgentConfig,
  McpDependency,
  NormalizedCapabilities,
  RepoConfig,
  PromptsConfigFile
} from "../../config/types.js";
import type {
  AgentVisibleCapabilities,
  BlockedCapability,
  CapabilityValidationResult
} from "../../capabilities/types.js";
import {
  dispatchPendingTasks,
  buildSinglePostDispatchHandoffFailureExecution,
  buildSinglePreDispatchFailureExecution,
  safelyNotifyFailure
} from "../../agents/service.js";
import type { AgentRunner } from "../../agents/types.js";
import { AgentPool } from "../../agents/pool.js";
import {
  buildMcpBlockerNotificationComment,
  type TaskFailureNotifier
} from "../../agents/failure-feedback.js";
import type { ReviewPublisher } from "../../agents/review-feedback.js";
import type { PlanBreakdownPublisher } from "../../agents/plan-breakdown-feedback.js";
import type { WaveAssessmentPublisher } from "../../agents/wave-assessment-feedback.js";
import type { TaskLifecycleNotifier } from "../../agents/lifecycle-feedback.js";
import type { GitGateway } from "../../git/types.js";
import {
  MergePrepWorkspaceService,
  buildMergePrepPrComment,
  type MergePrepAuditData
} from "../../git/merge-prep-workspace.js";
import { BackburnerGitToolService } from "../../git/backburner-git-tool-service.js";
import type { GitHubGateway } from "../../github/types.js";
import type { JobMemoryRuntime } from "../../memory/types.js";
import { StateStore } from "../../state/loader.js";
import type {
  ExecutionRecord,
  McpStatusRecord,
  WorkstreamRecord,
  WorktreeRecord,
  WorkspaceRecoveryRecord,
  WorkspaceRecoveryOutcome
} from "../../state/types.js";
import type { TaskRecord } from "../../tasks/types.js";
import { Task } from "../../tasks/task.js";
import { CommandExecutionError, type CommandRunner } from "../../utils/command-runner.js";
import type { Logger } from "../../utils/logger.js";
import { WorkspaceRecoveryService } from "../../worktrees/workspace-recovery.js";
import {
  classifyMidTaskMcpFailure,
  evaluateMcpDispatchGate,
  markMcpBlockersSurfaced,
  rehydrateTaskMcpSkipContexts,
  resumeMidTaskBlockedTasks,
  upsertMcpBlocker
} from "../../workstreams/mcp-blockers.js";
import {
  createSmitheryMcpResolverFromEnv,
  reconcileMcpStatus
} from "../../mcps/index.js";

function repoSlug(repo: RepoConfig): string {
  return `${repo.owner}/${repo.name}`;
}

function replaceWorkstream(
  workstreams: readonly WorkstreamRecord[],
  updated: WorkstreamRecord
): WorkstreamRecord[] {
  return workstreams.map((workstream) => workstream.id === updated.id ? updated : workstream);
}

function resolveTaskPacketId(task: TaskRecord, worktrees: readonly WorktreeRecord[]): string | undefined {
  if (task.context.packetId) {
    return task.context.packetId;
  }

  const localPath =
    task.kind === "prepare_pr_for_merge"
      ? task.context.prepareForMerge?.persistentWorktreePath
      : task.context.localRepoPath;
  const branchName =
    task.kind === "prepare_pr_for_merge"
      ? task.context.prepareForMerge?.headBranch
      : task.context.branchName;
  return worktrees.find((worktree) => worktree.path === localPath && worktree.branchName === branchName)
    ?.packet?.packetId;
}

async function refreshMcpStatusesForMidTaskCheck(input: {
  declaredMcps: readonly McpDependency[];
  previousStatuses: McpStatusRecord[];
  refreshMcpStatuses?: ((previousStatuses: McpStatusRecord[]) => Promise<McpStatusRecord[]>) | undefined;
  stateStore: StateStore;
  logger: Logger;
}): Promise<McpStatusRecord[]> {
  if (input.refreshMcpStatuses) {
    const refreshed = await input.refreshMcpStatuses(input.previousStatuses);
    await input.stateStore.writeMcpStatusState(refreshed);
    return refreshed;
  }

  if (input.declaredMcps.length === 0) {
    return input.previousStatuses;
  }

  try {
    const resolvedMcps = await createSmitheryMcpResolverFromEnv().resolveDependencies(
      [...input.declaredMcps],
      input.previousStatuses
    );
    const reconciliation = reconcileMcpStatus(
      [...input.declaredMcps],
      input.previousStatuses,
      resolvedMcps,
      new Date().toISOString()
    );
    await input.stateStore.writeMcpStatusState(reconciliation.records);
    return reconciliation.records;
  } catch (err) {
    input.logger.warn(`Failed to refresh MCP readiness after task failure: ${err instanceof Error ? err.message : String(err)}`);
    return input.previousStatuses;
  }
}

async function surfaceUnsurfacedMcpBlockers(input: {
  workstreams: WorkstreamRecord[];
  tasks: readonly TaskRecord[];
  executionsByTaskId: ReadonlyMap<string, ExecutionRecord>;
  enabledRepos: readonly RepoConfig[];
  githubGateway: GitHubGateway;
  stateStore: StateStore;
  logger: Logger;
  now: () => string;
}): Promise<WorkstreamRecord[]> {
  let workstreams = input.workstreams;
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const reposById = new Map(input.enabledRepos.map((repo) => [repo.id, repo]));

  for (const workstream of workstreams) {
    const unsurfaced = (workstream.mcpBlockers ?? []).filter(
      (blocker) => blocker.resolutionState === "waiting_for_user" && blocker.surfacedAt === undefined
    );
    if (unsurfaced.length === 0) {
      continue;
    }

    let currentWorkstream = workstreams.find((candidate) => candidate.id === workstream.id) ?? workstream;
    for (const blocker of unsurfaced) {
      const task = taskById.get(blocker.blockedTaskId);
      const repo = task ? reposById.get(task.repoId) : undefined;
      const targetNumber = task ? Task.from(task).owningThreadNumber() : undefined;
      if (!task || !repo || targetNumber === undefined) {
        input.logger.warn(`[mcp-blocker] Cannot surface blocker ${blocker.id}: missing task, repo, or target thread.`);
        continue;
      }

      try {
        await input.githubGateway.postIssueComment({
          owner: repo.owner,
          name: repo.name,
          issueNumber: targetNumber,
          body: buildMcpBlockerNotificationComment(
            task,
            blocker,
            input.executionsByTaskId.get(task.id)
          )
        });
      } catch (err) {
        input.logger.warn(`[mcp-blocker] Failed to surface blocker ${blocker.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      currentWorkstream = markMcpBlockersSurfaced(
        currentWorkstream,
        new Set([blocker.id]),
        input.now()
      );
      workstreams = replaceWorkstream(workstreams, currentWorkstream);
      await input.stateStore.writeWorkstreamState(workstreams);
    }
  }

  return workstreams;
}

async function classifyAndSurfaceMidTaskMcpFailures(input: {
  inputTasks: readonly TaskRecord[];
  tasks: TaskRecord[];
  executions: readonly ExecutionRecord[];
  worktrees: readonly WorktreeRecord[];
  workstreams: WorkstreamRecord[];
  mcpStatuses: McpStatusRecord[];
  declaredMcps: readonly McpDependency[];
  capabilitiesConfig?: NormalizedCapabilities | undefined;
  refreshMcpStatuses?: ((previousStatuses: McpStatusRecord[]) => Promise<McpStatusRecord[]>) | undefined;
  enabledRepos: readonly RepoConfig[];
  githubGateway: GitHubGateway;
  stateStore: StateStore;
  logger: Logger;
}): Promise<{ tasks: TaskRecord[]; workstreams: WorkstreamRecord[]; mcpBlockedTaskIds: Set<string> }> {
  if (!input.capabilitiesConfig) {
    return { tasks: input.tasks, workstreams: input.workstreams, mcpBlockedTaskIds: new Set() };
  }

  const previousStatusByTaskId = new Map(input.inputTasks.map((task) => [task.id, task.status]));
  const candidates = input.tasks.filter(
    (task) =>
      task.status === "failed" &&
      previousStatusByTaskId.get(task.id) !== "failed"
  );
  if (candidates.length === 0) {
    return { tasks: input.tasks, workstreams: input.workstreams, mcpBlockedTaskIds: new Set() };
  }

  const refreshedMcpStatuses = await refreshMcpStatusesForMidTaskCheck({
    declaredMcps: input.declaredMcps,
    previousStatuses: input.mcpStatuses,
    refreshMcpStatuses: input.refreshMcpStatuses,
    stateStore: input.stateStore,
    logger: input.logger
  });

  let tasks = input.tasks;
  let workstreams = input.workstreams;
  const mcpBlockedTaskIds = new Set<string>();
  const executionByTaskId = new Map(input.executions.map((execution) => [execution.taskId, execution]));

  for (const task of candidates) {
    const blockedCapabilities = classifyMidTaskMcpFailure({
      task,
      capabilities: input.capabilitiesConfig,
      declaredMcps: [...input.declaredMcps],
      refreshedMcpStatuses
    });
    if (blockedCapabilities.length === 0 || !task.workstreamId) {
      continue;
    }

    const workstream = workstreams.find((candidate) => candidate.id === task.workstreamId);
    if (!workstream) {
      continue;
    }

    let updatedWorkstream = workstream;
    for (const blockedCapability of blockedCapabilities) {
      const mcpStatus = refreshedMcpStatuses.find((status) => status.handle === blockedCapability.uses);
      if (!mcpStatus) {
        continue;
      }
      updatedWorkstream = upsertMidTaskBlocker(
        updatedWorkstream,
        task,
        blockedCapability,
        mcpStatus,
        resolveTaskPacketId(task, input.worktrees),
        new Date().toISOString()
      );
    }

    workstreams = replaceWorkstream(workstreams, updatedWorkstream);
    const taskIndex = tasks.findIndex((candidate) => candidate.id === task.id);
    if (taskIndex !== -1) {
      tasks = [
        ...tasks.slice(0, taskIndex),
        {
          ...tasks[taskIndex]!,
          context: {
            ...tasks[taskIndex]!.context,
            recoveryNeeded: false
          }
        },
        ...tasks.slice(taskIndex + 1)
      ];
    }
    mcpBlockedTaskIds.add(task.id);
  }

  if (mcpBlockedTaskIds.size > 0) {
    await input.stateStore.writeTaskState(tasks);
    await input.stateStore.writeWorkstreamState(workstreams);
    workstreams = await surfaceUnsurfacedMcpBlockers({
      workstreams,
      tasks,
      executionsByTaskId: executionByTaskId,
      enabledRepos: input.enabledRepos,
      githubGateway: input.githubGateway,
      stateStore: input.stateStore,
      logger: input.logger,
      now: () => new Date().toISOString()
    });
  }

  return { tasks, workstreams, mcpBlockedTaskIds };
}

function upsertMidTaskBlocker(
  workstream: WorkstreamRecord,
  task: TaskRecord,
  blockedCapability: BlockedCapability,
  mcpStatus: McpStatusRecord,
  packetId: string | undefined,
  now: string
): WorkstreamRecord {
  return upsertMcpBlocker(workstream, task, blockedCapability, mcpStatus, packetId, now);
}

async function notifyOrdinaryDeferredFailures(input: {
  inputTasks: readonly TaskRecord[];
  tasks: TaskRecord[];
  executions: readonly ExecutionRecord[];
  failureNotifier: TaskFailureNotifier | undefined;
  stateStore: StateStore;
  mcpBlockedTaskIds: ReadonlySet<string>;
}): Promise<TaskRecord[]> {
  const previousStatusByTaskId = new Map(input.inputTasks.map((task) => [task.id, task.status]));
  const executionByTaskId = new Map(input.executions.map((execution) => [execution.taskId, execution]));
  let tasks = input.tasks;
  let changed = false;

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    if (
      task.status !== "failed" ||
      previousStatusByTaskId.get(task.id) === "failed" ||
      input.mcpBlockedTaskIds.has(task.id)
    ) {
      continue;
    }

    const execution = task.lastExecutionId ? input.executions.find((entry) => entry.id === task.lastExecutionId) : executionByTaskId.get(task.id);
    if (!execution) {
      continue;
    }
    const failureCommentId = await safelyNotifyFailure(input.failureNotifier, task, execution);
    if (failureCommentId !== undefined) {
      tasks = [
        ...tasks.slice(0, index),
        { ...task, lastFailureCommentId: failureCommentId },
        ...tasks.slice(index + 1)
      ];
      changed = true;
    }
  }

  if (changed) {
    await input.stateStore.writeTaskState(tasks);
  }

  return tasks;
}

type PrepareMergeStartResult =
  | { status: "merged_cleanly"; message: string }
  | { status: "merge_conflict"; message: string; conflictedFiles: string[] };

async function startPrepareForMerge(input: {
  commandRunner: CommandRunner;
  clonePath: string;
  headBranch: string;
  expectedHeadSha: string;
  baseBranch: string;
}): Promise<PrepareMergeStartResult> {
  const { commandRunner, clonePath, headBranch, expectedHeadSha, baseBranch } = input;

  await commandRunner.run("git", ["fetch", "--prune", "origin"], { cwd: clonePath });
  await commandRunner.run("git", ["checkout", headBranch], { cwd: clonePath });
  await commandRunner.run("git", ["reset", "--hard", expectedHeadSha], { cwd: clonePath });

  const currentHead = (await commandRunner.run("git", ["rev-parse", "HEAD"], { cwd: clonePath })).stdout.trim();
  if (currentHead !== expectedHeadSha) {
    throw new Error(`Prepare-for-merge clone reset to ${currentHead}, expected ${expectedHeadSha}`);
  }

  const status = (await commandRunner.run("git", ["status", "--porcelain"], { cwd: clonePath })).stdout.trim();
  if (status !== "") {
    throw new Error("Prepare-for-merge clone is dirty before merge start.");
  }

  await commandRunner.run(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`],
    { cwd: clonePath }
  );

  try {
    await commandRunner.run("git", ["merge", "--no-ff", "--no-edit", `origin/${baseBranch}`], {
      cwd: clonePath
    });
    return {
      status: "merged_cleanly",
      message: `Merged origin/${baseBranch} into ${headBranch} without conflicts.`
    };
  } catch (error) {
    const conflictedFiles = await getUnresolvedConflictFiles(commandRunner, clonePath);
    if (error instanceof CommandExecutionError && conflictedFiles.length > 0) {
      return {
        status: "merge_conflict",
        message: `Merge from origin/${baseBranch} stopped on conflicts.`,
        conflictedFiles
      };
    }
    throw error;
  }
}

async function getUnresolvedConflictFiles(
  commandRunner: CommandRunner,
  clonePath: string
): Promise<string[]> {
  const result = await commandRunner.run("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: clonePath
  });
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function buildOrchestratorMergePrepSuccessExecution(input: {
  task: TaskRecord;
  clonePath: string;
  logDir: string;
  timestamp: string;
  summary: string;
}): Promise<ExecutionRecord> {
  const executionId = `exec-${input.task.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}-merge-prep-orchestrator-${input.timestamp.replace(/[:.]/g, "-")}`;
  const artifactRoot = path.join(input.logDir, "artifacts", executionId);
  const promptArtifactPath = path.join(artifactRoot, "prompt.md");
  const stdoutArtifactPath = path.join(artifactRoot, "stdout.txt");
  const stderrArtifactPath = path.join(artifactRoot, "stderr.txt");
  const promptPacketPath = path.join(artifactRoot, "prompt-packet.json");
  await mkdir(artifactRoot, { recursive: true });
  await Promise.all([
    writeFile(
      promptArtifactPath,
      `Task: ${input.task.id}\nPhase: prepare-for-merge orchestrator merge\n\n${input.summary}\n`,
      "utf8"
    ),
    writeFile(stdoutArtifactPath, `${input.summary}\n`, "utf8"),
    writeFile(stderrArtifactPath, "", "utf8"),
    writeFile(
      promptPacketPath,
      JSON.stringify(
        {
          taskId: input.task.id,
          taskKind: input.task.kind,
          status: "merged_cleanly",
          summary: input.summary
        },
        null,
        2
      ),
      "utf8"
    )
  ]);

  return {
    id: executionId,
    taskId: input.task.id,
    taskKind: input.task.kind,
    taskStatus: "completed",
    repoId: input.task.repoId,
    repoSlug: input.task.repoSlug,
    agentId: "orchestrator",
    agentProvider: "unassigned",
    command: {
      executable: "git",
      args: ["merge", "--no-ff", "--no-edit", `origin/${input.task.context.prepareForMerge?.baseBranch ?? "base"}`],
      cwd: input.clonePath,
      timeoutMs: 0
    },
    promptArtifactPath,
    stdoutArtifactPath,
    stderrArtifactPath,
    promptPacketPath,
    startedAt: input.timestamp,
    endedAt: input.timestamp,
    exitCode: 0
  };
}

/**
 * Run a single dispatch phase with full merge-prep lifecycle:
 * 1. Pre-dispatch: refresh persistent worktrees; create merge-prep clones.
 * 2. Dispatch: call dispatchPendingTasks with executionCwdByTaskId.
 * 3. Post-dispatch: inspect/push/audit/refresh/cleanup for each merge-prep task.
 *
 * Returns updated tasks and executions; state store is kept in sync at each step.
 */
export async function runDispatchWithMergePrepLifecycle(input: {
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  worktrees: WorktreeRecord[];
  workstreams: WorkstreamRecord[];
  capabilityValidation: CapabilityValidationResult;
  mcpStatuses: McpStatusRecord[];
  declaredMcps?: McpDependency[] | undefined;
  capabilitiesConfig?: NormalizedCapabilities | undefined;
  refreshMcpStatuses?: ((previousStatuses: McpStatusRecord[]) => Promise<McpStatusRecord[]>) | undefined;
  agents: AgentConfig[];
  capabilitiesByProvider?: ReadonlyMap<string, AgentVisibleCapabilities>;
  providerBrokerToolAllowLists?: ReadonlyMap<string, readonly string[]>;
  brokerToolScope?: {
    bindAllowedTools(allowedToolNames: readonly string[]): void;
    clearAllowedTools(): void;
  };
  enabledRepos: RepoConfig[];
  codeRoot: string;
  logDir: string;
  stateStore: StateStore;
  agentRunner: AgentRunner;
  failureNotifier: TaskFailureNotifier | undefined;
  reviewPublisher: ReviewPublisher | undefined;
  planBreakdownPublisher: PlanBreakdownPublisher | undefined;
  waveAssessmentPublisher: WaveAssessmentPublisher | undefined;
  lifecycleNotifier: TaskLifecycleNotifier | undefined;
  jobMemoryRuntime: JobMemoryRuntime | undefined;
  logger: Logger;
  promptsConfig: PromptsConfigFile | undefined;
  managementRoot: string | undefined;
  mergePrepService: MergePrepWorkspaceService;
  githubGateway: GitHubGateway;
  backburnerGitToolService: BackburnerGitToolService;
  commandRunner: CommandRunner;
  gitGateway: GitGateway;
  workspaceRecoveryService: WorkspaceRecoveryService;
  agentPool?: AgentPool | undefined;
}): Promise<{ tasks: TaskRecord[]; executions: ExecutionRecord[]; workstreams: WorkstreamRecord[] }> {
  const {
    tasks: inputTasks,
    executions: inputExecutions,
    mergePrepService,
    logger,
    stateStore,
    logDir,
    failureNotifier,
    enabledRepos,
    codeRoot,
    githubGateway,
    backburnerGitToolService,
    commandRunner,
    gitGateway,
    workspaceRecoveryService
  } = input;
  let dispatchWorkstreams = input.workstreams;
  let hydratedInputTasks = inputTasks;
  const skipHydration = rehydrateTaskMcpSkipContexts({
    tasks: hydratedInputTasks,
    workstreams: dispatchWorkstreams
  });
  if (skipHydration.changed) {
    hydratedInputTasks = skipHydration.tasks;
    await stateStore.writeTaskState(hydratedInputTasks);
  }

  // ── Phase 0: Recover workspaces of failed workspace-write tasks ─────────────

  const seenRecoveryPaths = new Set<string>();
  const existingRecoveryRecords = await stateStore.loadWorkspaceRecoveryState();
  const recoveryRecords = [...existingRecoveryRecords];
  let recoveryStateChanged = false;
  let taskStateChangedByRecovery = false;

  const counts: Record<WorkspaceRecoveryOutcome, number> = {
    recovered: 0,
    skipped: 0,
    rejected: 0,
    failed: 0
  };

  const recoveryResultByTaskId = new Map<string, WorkspaceRecoveryRecord>();

  for (const task of hydratedInputTasks) {
    if (!workspaceRecoveryService.isRecoveryNeeded(task)) {
      continue;
    }

    const localPath = workspaceRecoveryService.resolveTaskWorkspacePath(task);
    if (localPath && seenRecoveryPaths.has(localPath)) {
      continue;
    }
    if (localPath) {
      seenRecoveryPaths.add(localPath);
    }

    const recoveryResult = await workspaceRecoveryService.recoverWorkspace({
      task,
      codeRoot,
      gitGateway
    });

    counts[recoveryResult.outcome]++;
    recoveryRecords.push(recoveryResult);
    recoveryResultByTaskId.set(task.id, recoveryResult);
    recoveryStateChanged = true;

    if (recoveryResult.outcome === "recovered" || recoveryResult.outcome === "skipped") {
      task.context.recoveryNeeded = false;
      taskStateChangedByRecovery = true;
    }

    logger.info(
      JSON.stringify({
        component: "workspace-recovery-phase",
        taskId: task.id,
        taskKind: task.kind,
        localPath,
        outcome: recoveryResult.outcome,
        message: recoveryResult.reason
      })
    );
  }

  if (taskStateChangedByRecovery) {
    await stateStore.writeTaskState(hydratedInputTasks);
  }

  if (recoveryStateChanged) {
    await stateStore.writeWorkspaceRecoveryState(recoveryRecords);
  }

  logger.info(
    `Workspace recovery phase: recovered=${counts.recovered}, skipped=${counts.skipped}, rejected=${counts.rejected}, failed=${counts.failed}`
  );

  // ── Phase 1: Pre-dispatch worktree refresh ──────────────────────────────────

  // Build map of localPath → expectedBranch for all pending task persistent paths.
  // We exclude tasks that just failed or were rejected during recovery.
  const persistentPathsToRefresh = new Map<string, string>();

  for (const task of hydratedInputTasks) {
    if (task.status !== "pending" || !task.relevant) continue;

    const recoveryResult = recoveryResultByTaskId.get(task.id);
    if (recoveryResult && (recoveryResult.outcome === "failed" || recoveryResult.outcome === "rejected")) {
      continue;
    }

    if (task.kind !== "prepare_pr_for_merge" && task.context.localRepoPath && task.context.branchName) {
      persistentPathsToRefresh.set(task.context.localRepoPath, task.context.branchName);
    }

    const preflight = task.context.prepareForMerge;
    if (task.kind === "prepare_pr_for_merge" && preflight?.persistentWorktreePath) {
      persistentPathsToRefresh.set(preflight.persistentWorktreePath, preflight.headBranch);
    }
  }

  const blockedPaths = new Set<string>();
  for (const [localPath, expectedBranch] of persistentPathsToRefresh) {
    const refreshResult = await mergePrepService.refreshPersistentWorktreeBeforeDispatch({
      localPath,
      expectedBranch
    });
    logger.info(`Pre-dispatch worktree refresh for ${localPath}: ${refreshResult.status} — ${refreshResult.message}`);
    if (refreshResult.status.startsWith("blocked")) {
      blockedPaths.add(localPath);
    }
  }

  // Mark tasks with blocked non-merge-prep persistent paths OR failed recovery as pre-dispatch failures.
  // Merge-prep tasks are NOT blocked by their persistent worktree refresh failure —
  // they always create a fresh clone. The persistent worktree refresh for merge-prep
  // is for the benefit of future review/discussion agents, not for the merge-prep task itself.
  let currentTasks = [...hydratedInputTasks];
  const executionsAccumulated = [...inputExecutions];

  for (let i = 0; i < currentTasks.length; i++) {
    const task = currentTasks[i];
    if (!task || task.status !== "pending") continue;

    let blockerReason: string | undefined;

    const recoveryResult = recoveryResultByTaskId.get(task.id);
    if (recoveryResult && (recoveryResult.outcome === "failed" || recoveryResult.outcome === "rejected")) {
      blockerReason = `Pre-dispatch workspace recovery ${recoveryResult.outcome}: ${recoveryResult.reason}`;
    } else if (
      task.kind !== "prepare_pr_for_merge" &&
      task.context.localRepoPath &&
      blockedPaths.has(task.context.localRepoPath)
    ) {
      blockerReason = `Pre-dispatch worktree refresh blocked: persistent worktree at ${task.context.localRepoPath} could not be safely fast-forwarded.`;
    }

    if (blockerReason) {
      const { updatedTask, execution } = await buildSinglePreDispatchFailureExecution({
        task,
        reason: blockerReason,
        logDir,
        now: () => new Date().toISOString()
      });
      currentTasks[i] = updatedTask;               // update in-place
      executionsAccumulated.push(execution);        // accumulate without losing prior failures
      await stateStore.writeExecutionState(executionsAccumulated);
      await stateStore.writeTaskState(currentTasks);
      const failureCommentId = await safelyNotifyFailure(failureNotifier, updatedTask, execution);
      if (failureCommentId !== undefined) {
        currentTasks[i] = { ...currentTasks[i]!, lastFailureCommentId: failureCommentId };
        await stateStore.writeTaskState(currentTasks);
      }
    }
  }

  // ── Phase 2: Create dedicated clones for pending merge-prep tasks ────────────

  // Runtime-only map: taskId → clone path. NEVER written to durable task state.
  const mergePrepClonePathByTaskId = new Map<string, string>();

  for (let i = 0; i < currentTasks.length; i++) {
    const task = currentTasks[i];
    if (!task || task.status !== "pending" || task.kind !== "prepare_pr_for_merge") continue;

    const preflight = task.context.prepareForMerge;
    if (!preflight) continue;

    const repo = enabledRepos.find(repo => repoSlug(repo) === task.repoSlug);
    if (!repo) {
      const reason = `No repo config found for ${task.repoSlug} — cannot create merge-prep clone.`;
      const { updatedTask, execution } = await buildSinglePreDispatchFailureExecution({
        task, reason, logDir, now: () => new Date().toISOString()
      });
      currentTasks[i] = updatedTask;
      executionsAccumulated.push(execution);
      await stateStore.writeExecutionState(executionsAccumulated);
      await stateStore.writeTaskState(currentTasks);
      const failureCommentId = await safelyNotifyFailure(failureNotifier, updatedTask, execution);
      if (failureCommentId !== undefined) {
        currentTasks[i] = { ...currentTasks[i]!, lastFailureCommentId: failureCommentId };
        await stateStore.writeTaskState(currentTasks);
      }
      continue;
    }

    const sshUrl = `git@github.com:${repo.owner}/${repo.name}.git`;
    let setupClonePath: string | undefined;

    try {
      const cloneResult = await mergePrepService.prepareMergePrepClone({
        codeRoot,
        repoSshUrl: sshUrl,
        owner: repo.owner,
        repoName: repo.name,
        prNumber: preflight.prNumber,
        headBranch: preflight.headBranch,
        expectedHeadSha: preflight.headSha
      });
      setupClonePath = cloneResult.clonePath;
      logger.info(`Created merge-prep clone for task ${task.id} at ${cloneResult.clonePath}`);

      const mergeStart = await startPrepareForMerge({
        commandRunner,
        clonePath: cloneResult.clonePath,
        headBranch: preflight.headBranch,
        expectedHeadSha: preflight.headSha,
        baseBranch: preflight.baseBranch
      });

      mergePrepClonePathByTaskId.set(task.id, cloneResult.clonePath);

      if (mergeStart.status === "merge_conflict") {
        if (!task.workstreamId) {
          throw new Error(`Prepare-for-merge task ${task.id} has no workstream ID for Backburner Git session context.`);
        }
        backburnerGitToolService.registerPrepareForMergeWorkstream({
          backburnerGitSessionId: task.id,
          workstreamId: task.workstreamId,
          repoRoot: cloneResult.clonePath,
          expectedHeadSha: preflight.headSha,
          baseRef: `origin/${preflight.baseBranch}`,
          currentBranch: preflight.headBranch,
          state: "merge_conflict"
        });
        logger.info(
          `Base merge for task ${task.id} stopped on conflicts; registered Backburner Git session ${task.id} for workstream ${task.workstreamId}`
        );
      } else {
        const completedAt = new Date().toISOString();
        const execution = await buildOrchestratorMergePrepSuccessExecution({
          task,
          clonePath: cloneResult.clonePath,
          logDir,
          timestamp: completedAt,
          summary: mergeStart.message
        });
        currentTasks[i] = {
          ...task,
          status: "completed",
          lastExecutionId: execution.id,
          updatedAt: completedAt
        };
        executionsAccumulated.push(execution);
        await stateStore.writeExecutionState(executionsAccumulated);
        await stateStore.writeTaskState(currentTasks);
        logger.info(`Base merge for task ${task.id} completed without conflicts; skipping agent dispatch.`);
      }
    } catch (err) {
      if (setupClonePath && !mergePrepClonePathByTaskId.has(task.id)) {
        await mergePrepService.cleanupMergePrepClone({ clonePath: setupClonePath });
      }
      const reason = err instanceof Error ? err.message : String(err);
      const { updatedTask, execution } = await buildSinglePreDispatchFailureExecution({
        task, reason, logDir, now: () => new Date().toISOString()
      });
      currentTasks[i] = updatedTask;
      executionsAccumulated.push(execution);
      await stateStore.writeExecutionState(executionsAccumulated);
      await stateStore.writeTaskState(currentTasks);
      const failureCommentId = await safelyNotifyFailure(failureNotifier, updatedTask, execution);
      if (failureCommentId !== undefined) {
        currentTasks[i] = { ...currentTasks[i]!, lastFailureCommentId: failureCommentId };
        await stateStore.writeTaskState(currentTasks);
      }
    }
  }

  // ── Phase 2.5: MCP dispatch gate ─────────────────────────────────────────────

  const gateResult = evaluateMcpDispatchGate({
    tasks: currentTasks,
    worktrees: input.worktrees,
    workstreams: dispatchWorkstreams,
    capabilityValidation: input.capabilityValidation,
    mcpStatuses: input.mcpStatuses,
    now: new Date().toISOString()
  });

  if (gateResult.workstreamsChanged) {
    dispatchWorkstreams = gateResult.workstreams;
    await stateStore.writeWorkstreamState(dispatchWorkstreams);
  }

  dispatchWorkstreams = await surfaceUnsurfacedMcpBlockers({
    workstreams: dispatchWorkstreams,
    tasks: currentTasks,
    executionsByTaskId: new Map(),
    enabledRepos,
    githubGateway,
    stateStore,
    logger,
    now: () => new Date().toISOString()
  });

  const resumeResult = resumeMidTaskBlockedTasks({
    tasks: currentTasks,
    clearedBlockers: gateResult.clearedBlockers,
    skipExclusionsAppliedThisCycle: [],
    now: new Date().toISOString()
  });
  if (resumeResult.resumedTaskIds.size > 0) {
    currentTasks = resumeResult.tasks;
    await stateStore.writeTaskState(currentTasks);
  }

  // ── Phase 3: Dispatch ────────────────────────────────────────────────────────

  const dispatchResult = await dispatchPendingTasks({
    tasks: currentTasks,
    agents: input.agents,
    existingExecutions: executionsAccumulated,
    stateStore,
    logDir,
    agentRunner: input.agentRunner,
    failureNotifier,
    reviewPublisher: input.reviewPublisher,
    planBreakdownPublisher: input.planBreakdownPublisher,
    waveAssessmentPublisher: input.waveAssessmentPublisher,
    lifecycleNotifier: input.lifecycleNotifier,
    jobMemoryRuntime: input.jobMemoryRuntime,
    logger,
    promptsConfig: input.promptsConfig,
    managementRoot: input.managementRoot,
    ...(input.capabilitiesByProvider ? { capabilitiesByProvider: input.capabilitiesByProvider } : {}),
    ...(input.providerBrokerToolAllowLists ? { providerBrokerToolAllowLists: input.providerBrokerToolAllowLists } : {}),
    ...(input.brokerToolScope ? { brokerToolScope: input.brokerToolScope } : {}),
    mcpBlockedTaskIds: gateResult.blockedTaskIds,
    deferFailureNotifications: true,
    executionCwdByTaskId: mergePrepClonePathByTaskId,
    ...(input.agentPool ? { agentPool: input.agentPool } : {})
  });

  // ── Phase 4: Post-dispatch merge-prep lifecycle ──────────────────────────────

  let postTasks = dispatchResult.tasks;
  const postExecutions = [...dispatchResult.executions];

  const midTaskMcpResult = await classifyAndSurfaceMidTaskMcpFailures({
    inputTasks: currentTasks,
    tasks: postTasks,
    executions: postExecutions,
    worktrees: input.worktrees,
    workstreams: dispatchWorkstreams,
    mcpStatuses: input.mcpStatuses,
    declaredMcps: input.declaredMcps ?? [],
    capabilitiesConfig: input.capabilitiesConfig,
    refreshMcpStatuses: input.refreshMcpStatuses,
    enabledRepos,
    githubGateway,
    stateStore,
    logger
  });
  postTasks = midTaskMcpResult.tasks;
  dispatchWorkstreams = midTaskMcpResult.workstreams;
  postTasks = await notifyOrdinaryDeferredFailures({
    inputTasks: currentTasks,
    tasks: postTasks,
    executions: postExecutions,
    failureNotifier,
    stateStore,
    mcpBlockedTaskIds: midTaskMcpResult.mcpBlockedTaskIds
  });

  const mergePrepTasksToProcess = postTasks.filter(
    task =>
      task.kind === "prepare_pr_for_merge" &&
      (task.status === "completed" || task.status === "failed") &&
      mergePrepClonePathByTaskId.has(task.id)
  );

  for (const task of mergePrepTasksToProcess) {
    const clonePath = mergePrepClonePathByTaskId.get(task.id)!;
    try {
      const preflight = task.context.prepareForMerge;
      if (!preflight) continue;

      const repo = enabledRepos.find(repo => repoSlug(repo) === task.repoSlug);
      const auditBase = {
        prNumber: preflight.prNumber,
        headBranch: preflight.headBranch,
        baseBranch: preflight.baseBranch,
        originalHeadSha: preflight.headSha
      };

      let audit: MergePrepAuditData;
      let postDispatchFailureReason: string | undefined;

      if (task.status === "completed") {
        const inspectResult = await mergePrepService.inspectMergePrepCloneResult({
          clonePath,
          expectedBranch: preflight.headBranch,
          originalHeadSha: preflight.headSha
        });
        logger.info(`Merge-prep inspect for task ${task.id}: ${inspectResult.status} — ${inspectResult.message}`);

        if (inspectResult.status === "ready_to_push") {
          // Write audit log entry into the clone and commit it so it travels with the push.
          // This prevents direct writes to the persistent worktree (which would leave it dirty).
          if (preflight.persistentLogDocumentPath && preflight.persistentWorktreePath) {
            const prePushAudit: MergePrepAuditData = {
              prNumber: preflight.prNumber,
              headBranch: preflight.headBranch,
              baseBranch: preflight.baseBranch,
              originalHeadSha: preflight.headSha,
              finalLocalSha: inspectResult.localSha,
              commitLog: inspectResult.commitLog,
              diffStats: inspectResult.diffStats,
              pushed: true, // optimistic: only reached in ready_to_push path
              persistentRefreshStatus: "skipped" // refresh happens after push
            };
            await mergePrepService.commitAuditInClone({
              clonePath,
              persistentWorktreePath: preflight.persistentWorktreePath,
              persistentLogDocumentPath: preflight.persistentLogDocumentPath,
              audit: prePushAudit
            });
          }

          const pushResult = await mergePrepService.publishMergePrepResult({
            clonePath,
            headBranch: preflight.headBranch,
            originalHeadSha: preflight.headSha
          });
          logger.info(`Merge-prep push for task ${task.id}: ${pushResult.status} — ${pushResult.message}`);

          let persistentRefreshStatus: MergePrepAuditData["persistentRefreshStatus"] = "skipped";
          let persistentRefreshMessage: string | undefined;

          // Refresh persistent worktree after successful push.
          // Refresh status is always included in the audit — even if push succeeded but refresh failed.
          if (pushResult.status === "pushed" && preflight.persistentWorktreePath) {
            const refreshResult = await mergePrepService.refreshPersistentWorktreeAfterMergePrep({
              persistentWorktreePath: preflight.persistentWorktreePath,
              headBranch: preflight.headBranch
            });
            persistentRefreshStatus = refreshResult.status;
            persistentRefreshMessage = refreshResult.message;
            if (refreshResult.status === "succeeded") {
              logger.info(`Refreshed persistent worktree at ${preflight.persistentWorktreePath}`);
            } else {
              logger.warn(`Failed to refresh persistent worktree at ${preflight.persistentWorktreePath}: ${refreshResult.message}`);
            }
          }

          audit = {
            ...auditBase,
            finalLocalSha: inspectResult.localSha,
            commitLog: inspectResult.commitLog,
            diffStats: inspectResult.diffStats,
            pushed: pushResult.status === "pushed",
            pushedSha: pushResult.pushedSha,
            blockerReason: pushResult.status !== "pushed" ? pushResult.message : undefined,
            safeNextAction:
              pushResult.status === "lease_failed"
                ? "The remote branch was updated concurrently. Re-trigger prepare-for-merge."
                : pushResult.status === "push_failed"
                  ? "Check network connectivity and remote repository access, then retry."
                  : undefined,
            persistentRefreshStatus,
            persistentRefreshMessage
          };

          if (pushResult.status !== "pushed") {
            postDispatchFailureReason = `Merge-prep push failed: ${pushResult.message}`;
          }
        } else {
          // Inspection failed — do not push
          postDispatchFailureReason = `Merge-prep clone inspection failed: ${inspectResult.message}`;
          audit = {
            ...auditBase,
            finalLocalSha: inspectResult.localSha,
            pushed: false,
            blockerReason: inspectResult.message,
            safeNextAction: "Review the agent execution log and retry or manually resolve the state.",
            persistentRefreshStatus: "skipped"
          };
        }
      } else {
        // Task failed during agent execution
        audit = {
          ...auditBase,
          pushed: false,
          blockerReason: "Task failed during agent execution. Check execution log for details.",
          safeNextAction: "Review agent execution log and retry.",
          persistentRefreshStatus: "skipped"
        };
      }

      // If the agent exited successfully but orchestrator-owned inspection/push
      // failed, the task must be failed in durable state. The local agent result is
      // not the success boundary for prepare_pr_for_merge; successful publication is.
      if (task.status === "completed" && postDispatchFailureReason) {
        const { updatedTask, execution } = await buildSinglePostDispatchHandoffFailureExecution({
          task,
          reason: postDispatchFailureReason,
          logDir,
          now: () => new Date().toISOString()
        });
        const postTaskIdx = postTasks.findIndex(t => t.id === task.id);
        if (postTaskIdx !== -1) {
          postTasks[postTaskIdx] = updatedTask;
        }
        postExecutions.push(execution);
        await stateStore.writeExecutionState(postExecutions);
        await stateStore.writeTaskState(postTasks);
        const failureCommentId = await safelyNotifyFailure(failureNotifier, updatedTask, execution);
        if (failureCommentId !== undefined && postTaskIdx !== -1) {
          postTasks[postTaskIdx] = { ...postTasks[postTaskIdx]!, lastFailureCommentId: failureCommentId };
          await stateStore.writeTaskState(postTasks);
        }
      }

      // Orchestrator posts the single final audit comment to the GitHub PR
      if (repo) {
        try {
          const comment = buildMergePrepPrComment(audit);
          await githubGateway.postIssueComment({
            owner: repo.owner,
            name: repo.name,
            issueNumber: preflight.prNumber,
            body: comment
          });
        } catch (err) {
          logger.warn(`Failed to post merge-prep audit comment for PR #${preflight.prNumber}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      backburnerGitToolService.unregisterBackburnerGitSession(task.id);
      // Always clean up the clone
      await mergePrepService.cleanupMergePrepClone({ clonePath });
      logger.info(`Cleaned up merge-prep clone at ${clonePath}`);
    }
  }

  return { tasks: postTasks, executions: postExecutions, workstreams: dispatchWorkstreams };
}
