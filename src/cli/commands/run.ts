import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { GitHubTaskFailureNotifier, type TaskFailureNotifier } from "../../agents/failure-feedback.js";
import { GitHubPullRequestReviewPublisher, type ReviewPublisher } from "../../agents/review-feedback.js";
import { GitHubPlanBreakdownPublisher, type PlanBreakdownPublisher } from "../../agents/plan-breakdown-feedback.js";
import { GitHubWaveAssessmentPublisher, type WaveAssessmentPublisher } from "../../agents/wave-assessment-feedback.js";
import { GitHubTaskLifecycleNotifier, type TaskLifecycleNotifier } from "../../agents/lifecycle-feedback.js";
import {
  buildSinglePreDispatchFailureExecution,
  materializePreDispatchFailure,
  safelyNotifyFailure
} from "../../agents/service.js";
import { validateCapabilities } from "../../capabilities/validator.js";
import type { RepoConfig } from "../../config/types.js";
import { DefaultContextBuilder } from "../../context/types.js";
import type { AgentVisibleCapabilities } from "../../capabilities/types.js";
import type { GitGateway } from "../../git/types.js";
import { runDispatchWithMergePrepLifecycle } from "../runtime/dispatch-lifecycle.js";
import { createRunContext } from "../runtime/run-context.js";
import { setupProviderRuntime } from "../runtime/provider-runtime.js";
import { classifyPullRequestBase } from "../../github/pr-classification.js";
import type { NormalizedPullRequest } from "../../domain/entities.js";
import type { NormalizedIssue } from "../../domain/entities.js";
import type { GitHubGateway } from "../../github/types.js";
import { startGitHubBrokerServer } from "../../github/broker-server.js";
import type { ScopedBrokerToolService } from "../../github/scoped-broker.js";
import type {
  AttentionRecord,
  EntityStateMetadata,
  RepoSyncRecord,
  WorkstreamMcpScopedExclusion,
  WaveAssessmentResult,
  WorkstreamRecord,
  ExecutionRecord,
  PersistedState,
} from "../../state/types.js";
import { deriveTasks } from "../../tasks/derive.js";
import {
  buildEntityMaps,
  resolveTaskJournalIds,
  resolveRepoActionState,
  journalWorkstreamTransitions,
  journalTaskTransitions,
  journalWorktreeTransitions,
  journalNewExecutions,
  journalPacketWaveEvents
} from "../run-journal.js";
import {
  deriveWorkstreams
} from "../../workstreams/derive.js";
import { collectPacketPullRequestProjections } from "../../workstreams/packet-projections.js";
import { GitHubPacketLifecyclePublisher } from "../../workstreams/packet-lifecycle-feedback.js";
import type { StateStore } from "../../state/loader.js";
import {
  evaluatePacketWaveAdvancement,
  recommendBranchSyncAction,
  type PacketWaveAdvancementEvaluation
} from "../../workstreams/branch-sync.js";
import {
  applyPlanBreakdownResultsToWorkstreams,
  buildParentBranchSyncPreflight,
  markPacketPlanningPrOpen
} from "../../workstreams/packet-plan.js";
import { applyWaveAssessmentResultsToWorkstreams } from "../../workstreams/wave-assessment/checkpoint.js";
import {
  type ParentBranchSyncPreflight,
  type TaskRecord
} from "../../tasks/types.js";
import { deriveAttentionRecords } from "../../attention/derive.js";
import { collectPacketPullRequestCandidates } from "../../workstreams/packet-candidates.js";
import type { ManagedLogger } from "../../utils/logger.js";
import type {
  ParentBranchSyncPreflightRunSummary,
  RunCliOptions,
  RunSummary
} from "../run-types.js";

import {
  buildPacketLifecycleWorkstreamReport,
  formatPacketLifecycleReport,
  type PacketPrCreatedRunEvent,
  type PacketWaveAdvancedRunEvent,
  type PacketWaveBlockedRunEvent
} from "../../workstreams/packet-lifecycle-report.js";

import {
  LocalParentBranchSyncService,
} from "../../workstreams/parent-branch-sync.js";
import { reconcileDurableWorktreeLocations } from "../../worktrees/workspace-relocation.js";

import {
  executeParentBranchSyncActions
} from "../../workstreams/parent-branch-sync-action.js";

import { registerRetrospectiveCandidates } from "../../retrospectives/candidates.js";
import { deriveRetrospectiveTasks } from "../../retrospectives/derive.js";
import { ingestRetrospectiveExecutions } from "../../retrospectives/ingest.js";
import { scoreRetrospectiveProblems, buildScopeValidationConfigFromRuntime } from "../../retrospectives/scoring.js";
import { validateLearningProposals } from "../../retrospectives/proposals.js";
import { materializeManagementLearningProposals } from "../../retrospectives/management-prs.js";
import { workflowRegistry } from "../../workflows/registry.js";
import {
  applyMcpSkipExclusion,
  rehydrateTaskMcpSkipContexts
} from "../../workstreams/mcp-blockers.js";
import { CliUsageError } from "../errors.js";
import type { Logger } from "../../utils/logger.js";

export type { ParentBranchSyncPreflightRunSummary, RunCliOptions, RunSummary } from "../run-types.js";

/**
 * Builds a packet-wave advancement evaluation for the current run based on summary workstreams
 * and collected parent branch-sync preflights.
 *
 * This helper is pure and synchronous.
 */
export function buildPacketWaveAdvancementEvaluationForRun(input: {
  workstreams: WorkstreamRecord[];
  parentBranchSyncPreflights: ParentBranchSyncPreflightRunSummary[];
  waveAssessments?: WaveAssessmentResult[];
}): PacketWaveAdvancementEvaluation {
  return evaluatePacketWaveAdvancement({
    workstreams: input.workstreams,
    parentBranchSyncPreflights: input.parentBranchSyncPreflights,
    waveAssessments: input.waveAssessments
  });
}

/**
 * Returns local repositories that can safely provide packet worktrees.
 *
 * Packet worktrees start at an exact `origin/<integration-branch>` ref, so a
 * successfully fetched repository remains usable only when its primary
 * checkout was explicitly blocked for local changes. Other failed sync states
 * remain excluded because their remote refs may be stale or unavailable.
 */
export function buildPacketProvisioningRepoPathMap(
  repoResults: readonly RepoSyncRecord[]
): Map<string, string> {
  return new Map(
    repoResults
      .filter(isPacketProvisioningRepo)
      .map((result) => [result.repoId, result.localPath] as const)
  );
}

function isPacketProvisioningRepo(result: RepoSyncRecord): boolean {
  if (result.status === "synced") {
    return true;
  }

  return (
    result.fetched &&
    result.defaultBranchSyncStatus === "blocked_dirty"
  );
}

export async function processProviderLimitResumption(input: {
  previousState: PersistedState;
  stateStore: StateStore;
  currentIssues: readonly NormalizedIssue[];
  currentPullRequests: readonly NormalizedPullRequest[];
  lifecycleNotifier: TaskLifecycleNotifier;
  logDir: string;
  now: string;
  logger: Logger;
}): Promise<PersistedState> {
  const providerLimits = [...(input.previousState.providerLimits ?? [])];
  const currentTime = Date.parse(input.now);
  const expiredProviders = new Set<string>();
  let providerLimitsChanged = false;

  for (let index = 0; index < providerLimits.length; index += 1) {
    const record = providerLimits[index]!;
    if (record.status !== "limited" || !record.resetTime) {
      continue;
    }
    const resetTime = Date.parse(record.resetTime);
    if (!Number.isFinite(resetTime) || resetTime > currentTime) {
      continue;
    }
    expiredProviders.add(record.provider);
    providerLimits[index] = {
      ...record,
      status: "available",
      updatedAt: input.now
    };
    providerLimitsChanged = true;
  }

  if (expiredProviders.size === 0) {
    return input.previousState;
  }

  const currentIssuesById = new Map(input.currentIssues.map((issue) => [issue.id, issue]));
  const currentPullRequestsById = new Map(input.currentPullRequests.map((pr) => [pr.id, pr]));
  const tasks = [...input.previousState.tasks];
  const executions = [...input.previousState.executions];
  let tasksChanged = false;
  let executionsChanged = false;

  const queuedIndexes = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.status === "queued" && task.waitingOnProvider !== undefined && expiredProviders.has(task.waitingOnProvider))
    .sort((left, right) => {
      const providerComparison = left.task.waitingOnProvider!.localeCompare(right.task.waitingOnProvider!);
      if (providerComparison !== 0) return providerComparison;
      const leftQueuedAt = left.task.context.providerLimitQueuedAt ?? left.task.updatedAt;
      const rightQueuedAt = right.task.context.providerLimitQueuedAt ?? right.task.updatedAt;
      const queueComparison = leftQueuedAt.localeCompare(rightQueuedAt);
      if (queueComparison !== 0) return queueComparison;
      return left.task.id.localeCompare(right.task.id);
    });

  for (const { task, index } of queuedIndexes) {
    if (isQueuedTaskStillValid(task, currentIssuesById, currentPullRequestsById)) {
      tasks[index] = {
        ...task,
        status: "pending",
        waitingOnProvider: undefined,
        updatedAt: input.now,
        context: {
          ...task.context,
          notifiedQueued: false,
          providerLimitQueuedAt: task.context.providerLimitQueuedAt ?? task.updatedAt,
          providerLimitResumedProvider: task.waitingOnProvider
        }
      };
      tasksChanged = true;
      await input.lifecycleNotifier.notifyResumed(tasks[index]!);
      input.logger.info?.(`[provider-limits] Resumed queued task ${task.id} after ${task.waitingOnProvider} became available.`);
      continue;
    }

    const failure = await buildSinglePreDispatchFailureExecution({
      task,
      reason: "Task was canceled or the owning PR/issue was closed while queued.",
      logDir: input.logDir,
      now: () => input.now
    });
    tasks[index] = {
      ...failure.updatedTask,
      waitingOnProvider: undefined,
      context: {
        ...failure.updatedTask.context,
        notifiedQueued: false,
        providerLimitQueuedAt: undefined,
        providerLimitResumedProvider: undefined
      }
    };
    executions.push(failure.execution);
    tasksChanged = true;
    executionsChanged = true;
    await input.lifecycleNotifier.notifyCanceled(task);
    input.logger.info?.(`[provider-limits] Canceled queued task ${task.id}; owning PR/issue is no longer open.`);
  }

  if (providerLimitsChanged) {
    await input.stateStore.writeProviderLimitState(providerLimits);
  }
  if (executionsChanged) {
    await input.stateStore.writeExecutionState(executions);
  }
  if (tasksChanged) {
    await input.stateStore.writeTaskState(tasks);
  }

  return {
    ...input.previousState,
    providerLimits,
    tasks,
    executions
  };
}

function isQueuedTaskStillValid(
  task: TaskRecord,
  currentIssuesById: ReadonlyMap<string, NormalizedIssue>,
  currentPullRequestsById: ReadonlyMap<string, NormalizedPullRequest>
): boolean {
  const sourceId = task.parentSourceId ?? task.sourceId;
  const sourceKind = task.parentSourceKind ?? task.sourceKind;
  if (sourceKind === "issue") {
    const issue = currentIssuesById.get(sourceId);
    return issue !== undefined && issue.state === "open" && !hasCanceledLabel(issue.labels);
  }
  if (sourceKind === "pull_request") {
    const pullRequest = currentPullRequestsById.get(sourceId);
    return pullRequest !== undefined && pullRequest.state === "open" && !hasCanceledLabel(pullRequest.labels);
  }
  return true;
}

function hasCanceledLabel(labels: readonly string[]): boolean {
  return labels.some((label) => {
    const normalized = label.toLowerCase();
    return normalized === "canceled" || normalized === "cancelled" || normalized === "agent-canceled" || normalized === "agent-cancelled";
  });
}

function applyMcpSkipRequests(input: {
  tasks: TaskRecord[];
  workstreams: WorkstreamRecord[];
  attention: AttentionRecord[];
  now: string;
}): {
  tasks: TaskRecord[];
  workstreams: WorkstreamRecord[];
  changed: boolean;
  appliedExclusions: WorkstreamMcpScopedExclusion[];
} {
  let tasks = input.tasks;
  let workstreams = input.workstreams;
  let changed = false;
  const appliedExclusions: WorkstreamMcpScopedExclusion[] = [];

  for (const attention of input.attention) {
    if (
      !attention.reasons.includes("mcp_skip_requested") ||
      attention.mcpSkipTargetTaskId === undefined ||
      attention.mcpSkipMcpHandle === undefined
    ) {
      continue;
    }

    const workstreamIndex = workstreams.findIndex((workstream) => workstream.id === attention.workstreamId);
    if (workstreamIndex === -1) {
      continue;
    }

    const workstream = workstreams[workstreamIndex]!;
    const blocker = (workstream.mcpBlockers ?? []).find(
      (candidate) =>
        candidate.blockedTaskId === attention.mcpSkipTargetTaskId &&
        candidate.mcpHandle === attention.mcpSkipMcpHandle &&
        candidate.resolutionState === "waiting_for_user"
    );
    if (!blocker) {
      continue;
    }

    const updatedWorkstream = applyMcpSkipExclusion(
      workstream,
      blocker.blockedTaskId,
      blocker.blockedTaskKind,
      blocker.packetId,
      blocker.mcpHandle,
      blocker.affectedCapabilityNames,
      input.now
    );
    if (updatedWorkstream !== workstream) {
      workstreams = [
        ...workstreams.slice(0, workstreamIndex),
        updatedWorkstream,
        ...workstreams.slice(workstreamIndex + 1)
      ];
      const exclusion = updatedWorkstream.mcpSkipExclusions?.find(
        (candidate) =>
          candidate.taskId === blocker.blockedTaskId &&
          candidate.mcpHandle === blocker.mcpHandle
      );
      if (exclusion) {
        appliedExclusions.push(exclusion);
      }
      changed = true;
    }

    const taskIndex = tasks.findIndex((task) => task.id === blocker.blockedTaskId);
    if (taskIndex === -1) {
      continue;
    }

    const task = tasks[taskIndex]!;
    const mcpSkipContexts = [...(task.context.mcpSkipContexts ?? [])];
    const alreadyRecorded = mcpSkipContexts.some(
      (context) => context.mcpHandle === blocker.mcpHandle
    );
    if (!alreadyRecorded) {
      mcpSkipContexts.push({
        mcpHandle: blocker.mcpHandle,
        affectedCapabilityNames: blocker.affectedCapabilityNames,
        skipReason: "User explicitly skipped MCP authorization for this task."
      });
    }

    tasks = [
      ...tasks.slice(0, taskIndex),
      {
        ...task,
        status: task.status === "failed" ? "pending" : task.status,
        context: {
          ...task.context,
          recoveryNeeded: false,
          mcpSkipContexts
        },
        updatedAt: input.now
      },
      ...tasks.slice(taskIndex + 1)
    ];
    changed = true;
  }

  return { tasks, workstreams, changed, appliedExclusions };
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunSummary> {
  const [command, ...rest] = argv;

  if (command !== "run") {
    throw new CliUsageError(
      'Expected command: backburner run [--code-root <path>] [--management-dir <path>] [--outputs-dir <path>] [--log-dir <path>] [--broker-port <port>] [--headless] [--once]'
    );
  }

  const startedAt = new Date().toISOString();
  const cycleId = randomUUID();
  options.statusTracker?.onCycleStart(options.cycleNo ?? 1);
  const context = await createRunContext({ rest, options });
  const {
    managementDir,
    outputsDir,
    stateDir,
    logDir,
    logger,
    codeRoot,
    brokerPort,
    commandRunner,
    gitGateway,
    gitOpsLifecycle,
    workspaceRecoveryService,
    managementGitOps,
    config,
    agentPool,
    outputsGitOpsPrepared,
    managementRepo,
    stateStore,
    journal,
    memoryStore,
    memoryToolService,
    backburnerGitToolService,
    previousState: loadedPreviousState,
    currentMcpStatuses,
    gitHubGateway,
    syncService,
    scanService,
    implementationWorkflowService,
    triageFollowUpService,
    mergePrepService,
    enabledRepos,
    results
  } = context;
  let previousState = loadedPreviousState;
  await journal.write({
    cycleId,
    scope: "system",
    scopeId: cycleId,
    category: "observation",
    severity: "info",
    summary: `Orchestration cycle started with ${enabledRepos.length} enabled repo(s)`,
    observedState: { codeRoot, managementDir, outputsDir, enabledRepoCount: enabledRepos.length }
  });

  if (enabledRepos.length === 0) {
    await journal.recordNoAction({
      cycleId,
      scope: "system",
      scopeId: cycleId,
      reason: "No enabled repositories configured",
      derivedState: { totalRepos: config.repos.length, enabledRepos: 0 }
    });
  }

  for (const repo of enabledRepos) {
    options.statusTracker?.onRepoSyncStart(`${repo.owner}/${repo.name}`);
    logger.info(`Syncing ${repo.owner}/${repo.name} into ${path.join(codeRoot, repo.localPath)}`);
    const result = await syncService.syncRepository(repo, codeRoot);
    if (result.status === "failed") {
      logger.warn(`Failed to sync ${result.repoSlug}: ${result.error?.message ?? result.message}`);
    }
    results.push(result);
    await journal.write({
      cycleId,
      scope: "repo",
      scopeId: result.repoId,
      repoId: result.repoId,
      category: "sync",
      severity: result.status === "synced" ? "info" : "error",
      summary: result.status === "synced"
        ? `Synced ${result.repoSlug}`
        : `Failed to sync ${result.repoSlug}: ${result.error?.message ?? result.message}`,
      observedState: {
        repoSlug: result.repoSlug,
        status: result.status,
        cloned: result.cloned,
        fetched: result.fetched,
        defaultBranch: result.defaultBranch,
        syncedAt: result.syncedAt
      }
    });
  }

  const workspaceRelocation = await reconcileDurableWorktreeLocations({
    codeRoot,
    worktrees: previousState.worktrees,
    tasks: previousState.tasks,
    repoSyncRecords: results,
    gitGateway
  });
  const workspaceStateChanged = workspaceRelocation.relocatedCount > 0;
  const taskStateChangedByRelocation = workspaceRelocation.taskRelocatedCount > 0;
  if (workspaceStateChanged || taskStateChangedByRelocation) {
    previousState = {
      ...previousState,
      worktrees: workspaceRelocation.worktrees,
      tasks: workspaceRelocation.tasks
    };
    if (workspaceStateChanged) {
      await stateStore.writeWorktreeState(previousState.worktrees);
    }
    if (taskStateChangedByRelocation) {
      await stateStore.writeTaskState(previousState.tasks);
    }
  }
  if (
    workspaceRelocation.relocatedCount > 0 ||
    workspaceRelocation.recreatedCount > 0 ||
    workspaceRelocation.taskRelocatedCount > 0
  ) {
    logger.info(
      `Workspace relocation: relocated=${workspaceRelocation.relocatedCount}, recreated=${workspaceRelocation.recreatedCount}, tasks=${workspaceRelocation.taskRelocatedCount}`
    );
  }
  for (const failure of workspaceRelocation.failures) {
    logger.warn(
      `Workspace relocation skipped for ${failure.worktreeId}: ${failure.reason}`
    );
  }

  options.statusTracker?.onGitHubScanStart();
  logger.info(`Scanning ${enabledRepos.length} configured repos via GitHub`);
  const scanResult = await scanService.scanRepositories(enabledRepos, results, previousState);
  const generatedAt = new Date().toISOString();
  const lifecycleNotifier = new GitHubTaskLifecycleNotifier(gitHubGateway, enabledRepos, logger);

  previousState = await processProviderLimitResumption({
    previousState,
    stateStore,
    currentIssues: scanResult.issues,
    currentPullRequests: scanResult.prs,
    lifecycleNotifier,
    logDir,
    now: generatedAt,
    logger
  });

  for (const repoResult of scanResult.repoResults) {
    const scan = repoResult.githubScan;
    if (scan) {
      await journal.write({
        cycleId,
        scope: "repo",
        scopeId: repoResult.repoId,
        repoId: repoResult.repoId,
        category: "observation",
        severity: scan.status === "failed" ? "error" : scan.status === "partial" ? "warning" : "info",
        summary: `GitHub scan ${scan.status} for ${repoResult.repoSlug}: ${scan.issueCount} issues, ${scan.pullRequestCount} PRs`,
        observedState: {
          repoSlug: repoResult.repoSlug,
          scanStatus: scan.status,
          issueCount: scan.issueCount,
          pullRequestCount: scan.pullRequestCount,
          commentCount: scan.commentCount,
          failureCount: scan.failures.length
        }
      });
    }
  }

  const baseLinkedWorktrees = implementationWorkflowService.linkPullRequests(
    previousState.worktrees,
    scanResult.prs,
    enabledRepos
  );
  const initialWorkstreams = deriveWorkstreams({
    repos: enabledRepos,
    currentIssues: scanResult.issues,
    currentPullRequests: scanResult.prs,
    previousPullRequests: previousState.prs,
    worktrees: baseLinkedWorktrees,
    previousWorkstreams: previousState.workstreams
  });

  const packetPullRequestProjections = collectPacketPullRequestProjections({
    pullRequests: scanResult.prs,
    workstreams: initialWorkstreams,
    worktrees: baseLinkedWorktrees
  });

  const linkedWorktrees = implementationWorkflowService.reconcilePacketWorktreeReadinessFromProjections(
    baseLinkedWorktrees,
    packetPullRequestProjections,
    enabledRepos,
    previousState.tasks,
    initialWorkstreams,
    scanResult.prs
  );

  const initialAttention = deriveAttentionRecords({
    repos: enabledRepos,
    workstreams: initialWorkstreams,
    previousState,
    currentIssues: scanResult.issues,
    currentPullRequests: scanResult.prs,
    currentComments: scanResult.comments,
    tasks: previousState.tasks,
    now: generatedAt
  });
  let phaseAwareWorkstreams = deriveWorkstreams({
    repos: enabledRepos,
    currentIssues: scanResult.issues,
    currentPullRequests: scanResult.prs,
    previousPullRequests: previousState.prs,
    worktrees: linkedWorktrees,
    previousWorkstreams: previousState.workstreams,
    attention: initialAttention
  });
  let summaryWorkstreams = phaseAwareWorkstreams;

  const candidateResult = registerRetrospectiveCandidates({
    previousCandidates: previousState.retrospectiveCandidates,
    workstreams: phaseAwareWorkstreams,
    issues: scanResult.issues,
    pullRequests: scanResult.prs,
    tasks: previousState.tasks,
    executions: previousState.executions,
    worktrees: linkedWorktrees,
    managementPrs: previousState.managementPrs,
    ...(managementRepo ? { managementRepo } : {}),
    now: generatedAt
  });

  let tasks = deriveTasks({
    repos: enabledRepos,
    repoSyncRecords: scanResult.repoResults,
    previousState,
    currentIssues: scanResult.issues,
    currentPullRequests: scanResult.prs,
    currentComments: scanResult.comments,
    worktrees: linkedWorktrees,
    workstreams: phaseAwareWorkstreams,
    attention: initialAttention,
    contextBuilder: new DefaultContextBuilder(),
    now: generatedAt,
    ...(managementRepo ? { managementRepo } : {})
  });

  const mcpSkipApplication = applyMcpSkipRequests({
    tasks,
    workstreams: phaseAwareWorkstreams,
    attention: initialAttention,
    now: generatedAt
  });
  if (mcpSkipApplication.changed) {
    tasks = mcpSkipApplication.tasks;
    phaseAwareWorkstreams = mcpSkipApplication.workstreams;
    summaryWorkstreams = phaseAwareWorkstreams;
  }
  const skipContextHydration = rehydrateTaskMcpSkipContexts({
    tasks,
    workstreams: phaseAwareWorkstreams
  });
  if (skipContextHydration.changed) {
    tasks = skipContextHydration.tasks;
  }

  // Build entity maps for issue/PR number resolution in journal entries
  const entityMaps = buildEntityMaps(scanResult.issues, scanResult.prs, enabledRepos);

  const previousTaskIds = new Set(previousState.tasks.map((t) => t.id));
  const newTasks = tasks.filter((t) => !previousTaskIds.has(t.id));
  for (const task of newTasks) {
    const taskIds = resolveTaskJournalIds(task, entityMaps, phaseAwareWorkstreams);
    if (task.relevant) {
      await journal.write({
        cycleId,
        scope: task.workstreamId ? "workstream" : "repo",
        scopeId: task.workstreamId ?? task.repoId,
        repoId: task.repoId,
        ...(task.workstreamId !== undefined ? { workstreamId: task.workstreamId } : {}),
        ...(taskIds.issueNumber !== undefined ? { issueNumber: taskIds.issueNumber } : {}),
        ...(taskIds.prNumber !== undefined ? { prNumber: taskIds.prNumber } : {}),
        category: "task_created",
        severity: "info",
        summary: `Task created: ${task.kind} for ${task.repoSlug}`,
        observedState: { sourceKind: task.sourceKind, sourceId: task.sourceId },
        derivedState: { taskId: task.id, kind: task.kind, relevant: true, reason: task.reason },
        expectedNextAction: `Dispatch ${task.kind} to agent`
      });
    } else {
      await journal.write({
        cycleId,
        scope: task.workstreamId ? "workstream" : "repo",
        scopeId: task.workstreamId ?? task.repoId,
        repoId: task.repoId,
        ...(task.workstreamId !== undefined ? { workstreamId: task.workstreamId } : {}),
        ...(taskIds.issueNumber !== undefined ? { issueNumber: taskIds.issueNumber } : {}),
        ...(taskIds.prNumber !== undefined ? { prNumber: taskIds.prNumber } : {}),
        category: "task_skipped",
        severity: "info",
        summary: `Task skipped: ${task.kind} for ${task.repoSlug} — ${task.reason}`,
        noActionReason: task.reason,
        observedState: { sourceKind: task.sourceKind, sourceId: task.sourceId },
        derivedState: { taskId: task.id, kind: task.kind, relevant: false, reason: task.reason }
      });
    }
  }

  // Comprehensive per-repo no-action journaling (checks sync failure, scan failure, workstream phases, etc.)
  const syncRecordById = new Map(scanResult.repoResults.map((r) => [r.repoId, r]));
  for (const repo of enabledRepos) {
    const actionState = resolveRepoActionState({
      repoId: repo.id,
      repoSlug: `${repo.owner}/${repo.name}`,
      syncRecord: syncRecordById.get(repo.id),
      tasks,
      workstreams: phaseAwareWorkstreams,
      issues: scanResult.issues,
      prs: scanResult.prs
    });
    if (!actionState.hasAction && actionState.noActionReason !== undefined) {
      await journal.recordNoAction({
        cycleId,
        scope: "repo",
        scopeId: repo.id,
        repoId: repo.id,
        reason: actionState.noActionReason,
        observedState: {
          repoSlug: `${repo.owner}/${repo.name}`,
          taskCount: tasks.filter((t) => t.repoId === repo.id).length
        }
      });
    }
  }

  // Journal workstream transitions (phase/attention/status changes)
  await journalWorkstreamTransitions({
    cycleId,
    previousWorkstreams: previousState.workstreams,
    currentWorkstreams: phaseAwareWorkstreams,
    journal,
    entityMaps
  });

  // Track execution IDs before dispatch for dedup
  const executionIdsBeforeCycle = new Set(previousState.executions.map((e) => e.id));

  await stateStore.writeRepoSyncState(scanResult.repoResults);
  await stateStore.writeEntityState({
    issueMetadata: buildMetadata(generatedAt, scanResult.issues.length, enabledRepos.length, scanResult.failures),
    prMetadata: buildMetadata(generatedAt, scanResult.prs.length, enabledRepos.length, scanResult.failures),
    commentMetadata: buildMetadata(
      generatedAt,
      scanResult.comments.length,
      enabledRepos.length,
      scanResult.failures
    ),
    issues: scanResult.issues,
    prs: scanResult.prs,
    comments: scanResult.comments
  });
  await stateStore.writeWorktreeState(linkedWorktrees);
  await stateStore.writeWorkstreamState(phaseAwareWorkstreams);
  await stateStore.writeAttentionState(initialAttention);
  await stateStore.writeTaskState(tasks);
  await stateStore.writeRetrospectiveCandidateState(candidateResult.candidates);

  const parentBranchSyncService =
    options.parentBranchSyncService ?? new LocalParentBranchSyncService(gitGateway);

  const syncActionResult = await executeParentBranchSyncActions({
    tasks,
    executions: previousState.executions,
    parentBranchSyncService,
    gitGateway,
    gitHubGateway,
    stateStore,
    logDir,
    logger
  });

  let tasksAfterSync = syncActionResult.tasks;
  const executionsAfterSync = syncActionResult.executions;
  const postSyncSkipContextHydration = rehydrateTaskMcpSkipContexts({
    tasks: tasksAfterSync,
    workstreams: phaseAwareWorkstreams
  });
  if (postSyncSkipContextHydration.changed) {
    tasksAfterSync = postSyncSkipContextHydration.tasks;
    await stateStore.writeTaskState(tasksAfterSync);
  }

  let brokerServer:
    | Awaited<ReturnType<typeof startGitHubBrokerServer>>
    | undefined;
  let brokerLogger: ManagedLogger | undefined;

  let agentRunner = options.agentRunner;
  let capabilitiesByProvider: ReadonlyMap<string, AgentVisibleCapabilities> | undefined;
  let providerBrokerToolAllowLists: ReadonlyMap<string, readonly string[]> | undefined;
  let brokerToolScope: ScopedBrokerToolService | undefined;

  let packetPrsCreatedThisRun: PacketPrCreatedRunEvent[] = [];
  let packetWaveAdvancementsThisRun: PacketWaveAdvancedRunEvent[] = [];
  let packetWaveBlockedThisRun: PacketWaveBlockedRunEvent[] = [];

  const failureNotifier = new GitHubTaskFailureNotifier(gitHubGateway, enabledRepos, logger);
  const reviewPublisher = new GitHubPullRequestReviewPublisher(gitHubGateway, enabledRepos, logger);
  const planBreakdownPublisher = new GitHubPlanBreakdownPublisher(gitHubGateway, enabledRepos, logger);
  const waveAssessmentPublisher = new GitHubWaveAssessmentPublisher(gitHubGateway, enabledRepos, logger);

  const capabilityValidation = validateCapabilities(
    config.capabilities,
    config.mcps,
    currentMcpStatuses
  );

  let dispatchResult: Awaited<ReturnType<typeof runDispatchWithMergePrepLifecycle>> = {
    tasks: tasksAfterSync,
    executions: executionsAfterSync,
    workstreams: phaseAwareWorkstreams
  };
  let dispatchSetupFailed = false;

  try {
    const providerRuntime = await setupProviderRuntime({
      agentRunner,
      commandRunner,
      config,
      currentMcpStatuses,
      gitHubGateway,
      logger,
      logDir,
      brokerPort,
      startBrokerServer: options.startBrokerServer ?? startGitHubBrokerServer,
      memoryToolService,
      backburnerGitToolService
    });
    agentRunner = providerRuntime.agentRunner;
    capabilitiesByProvider = providerRuntime.capabilitiesByProvider;
    providerBrokerToolAllowLists = providerRuntime.providerBrokerToolAllowLists;
    brokerToolScope = providerRuntime.brokerToolScope;
    brokerServer = providerRuntime.brokerServer;
    brokerLogger = providerRuntime.brokerLogger;
  } catch (error: unknown) {
    dispatchSetupFailed = true;
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Dispatch setup failed before agent execution began: ${message}`);
    const failureResult = await materializePreDispatchFailure({
      tasks: tasksAfterSync,
      existingExecutions: executionsAfterSync,
      logDir,
      error,
      now: () => failedAt
    });
    await stateStore.writeExecutionState(failureResult.executions);
    await stateStore.writeTaskState(failureResult.tasks);
    let preDispatchTasks = [...failureResult.tasks];
    let preDispatchTasksDirty = false;
    for (let pi = 0; pi < preDispatchTasks.length; pi++) {
      const task = preDispatchTasks[pi]!;
      if (task.status !== "failed" || !task.lastExecutionId) {
        continue;
      }

      const execution = failureResult.executions.find((entry) => entry.id === task.lastExecutionId);
      if (!execution) {
        continue;
      }

      const failureCommentId = await safelyNotifyFailure(failureNotifier, task, execution);
      if (failureCommentId !== undefined) {
        preDispatchTasks[pi] = { ...task, lastFailureCommentId: failureCommentId };
        preDispatchTasksDirty = true;
      }
    }
    if (preDispatchTasksDirty) {
      await stateStore.writeTaskState(preDispatchTasks);
    }
    dispatchResult = { ...failureResult, tasks: preDispatchTasks, workstreams: phaseAwareWorkstreams };

    // Journal failed executions from pre-dispatch setup failure
    await journalNewExecutions({
      cycleId,
      executionIdsBeforeCycle,
      dispatchResult: failureResult,
      journal,
      entityMaps,
      workstreams: phaseAwareWorkstreams
    });
    await journalTaskTransitions({
      cycleId,
      tasksBefore: tasks,
      tasksAfter: failureResult.tasks,
      journal,
      entityMaps,
      workstreams: phaseAwareWorkstreams
    });

    if (brokerServer) {
      await brokerServer.close();
      brokerServer = undefined;
    }
    if (brokerLogger) {
      await brokerLogger.close();
      brokerLogger = undefined;
    }
  }

  if (!dispatchSetupFailed) {
    try {
      let dispatchAgentRunner = agentRunner;
      if (!dispatchAgentRunner) {
        throw new Error("Agent runner was not initialized.");
      }
      if (options.statusTracker) {
        const tracker = options.statusTracker;
        const realRunner = dispatchAgentRunner;
        dispatchAgentRunner = {
          dispatch: async (task, context, agentConfig, sessionDecision, promptContent) => {
            tracker.onTaskStart(task, agentConfig);
            try {
              const res = await realRunner.dispatch(task, context, agentConfig, sessionDecision, promptContent);
              tracker.onTaskEnd(task.id);
              return res;
            } catch (err) {
              tracker.onTaskEnd(task.id);
              throw err;
            }
          }
        };
      }

      logger.info(`Dispatching pending tasks (${tasksAfterSync.filter((task) => task.status === "pending").length})`);
      const initialDispatchResult = await runDispatchWithMergePrepLifecycle({
        tasks: tasksAfterSync,
        worktrees: linkedWorktrees,
        workstreams: phaseAwareWorkstreams,
        capabilityValidation,
        mcpStatuses: currentMcpStatuses,
        declaredMcps: config.mcps,
        capabilitiesConfig: config.capabilities,
        agents: config.agents,
        enabledRepos,
        codeRoot,
        executions: executionsAfterSync,
        stateStore,
        logDir,
        agentRunner: dispatchAgentRunner,
        failureNotifier,
        reviewPublisher,
        planBreakdownPublisher,
        waveAssessmentPublisher,
        lifecycleNotifier,
        jobMemoryRuntime: { store: memoryStore, toolService: memoryToolService },
        logger,
        promptsConfig: config.prompts,
        managementRoot: managementDir,
        ...(capabilitiesByProvider ? { capabilitiesByProvider } : {}),
        ...(providerBrokerToolAllowLists ? { providerBrokerToolAllowLists } : {}),
        ...(brokerToolScope ? { brokerToolScope } : {}),
        mergePrepService,
        githubGateway: gitHubGateway,
        backburnerGitToolService,
        commandRunner,
        gitGateway,
        workspaceRecoveryService,
        agentPool
      });

      const triageFollowUp = await triageFollowUpService.materializeStartImplementation({
        repos: enabledRepos,
        issues: scanResult.issues,
        repoPaths: new Map(
          scanResult.repoResults
            .filter((result) => result.status === "synced")
            .map((result) => [result.repoId, result.localPath] as const)
        ),
        codeRoot,
        state: {
          ...previousState,
          prs: scanResult.prs,
          executions: initialDispatchResult.executions,
          worktrees: linkedWorktrees
        },
        tasks: initialDispatchResult.tasks
      });
      const triageAwareWorktrees = implementationWorkflowService.reconcileTaskState(
        triageFollowUp.worktrees,
        triageFollowUp.tasks
      );
      const projectionAwareTriageWorktrees =
        implementationWorkflowService.reconcilePacketWorktreeReadinessFromProjections(
          triageAwareWorktrees,
          packetPullRequestProjections,
          enabledRepos,
          triageFollowUp.tasks,
          initialDispatchResult.workstreams,
          scanResult.prs
        );
      await stateStore.writeWorktreeState(projectionAwareTriageWorktrees);
      await stateStore.writeTaskState(triageFollowUp.tasks);

      const retrospectiveDerivation = deriveRetrospectiveTasks({
        existingTasks: triageFollowUp.tasks,
        candidates: candidateResult.candidates,
        problems: previousState.retrospectiveProblems,
        opportunities: previousState.retrospectiveOpportunities,
        proposals: previousState.learningProposals,
        agents: config.agents,
        contextBuilder: new DefaultContextBuilder(),
        now: generatedAt
      });

      let finalTasksToDispatch = triageFollowUp.tasks;
      if (retrospectiveDerivation.tasks.length > 0) {
        finalTasksToDispatch = [...triageFollowUp.tasks, ...retrospectiveDerivation.tasks];
      }
      const finalSkipContextHydration = rehydrateTaskMcpSkipContexts({
        tasks: finalTasksToDispatch,
        workstreams: initialDispatchResult.workstreams
      });
      if (finalSkipContextHydration.changed) {
        finalTasksToDispatch = finalSkipContextHydration.tasks;
      }
      if (retrospectiveDerivation.tasks.length > 0 || finalSkipContextHydration.changed) {
        await stateStore.writeTaskState(finalTasksToDispatch);
      }

      // Workspace recovery already ran before the initial dispatch. Deferring
      // further recovery until the next outer run preserves completed task
      // handoffs produced earlier in this run.
      dispatchResult = await runDispatchWithMergePrepLifecycle({
        tasks: finalTasksToDispatch,
        worktrees: projectionAwareTriageWorktrees,
        workstreams: initialDispatchResult.workstreams,
        capabilityValidation,
        mcpStatuses: currentMcpStatuses,
        declaredMcps: config.mcps,
        capabilitiesConfig: config.capabilities,
        agents: config.agents,
        enabledRepos,
        codeRoot,
        executions: initialDispatchResult.executions,
        stateStore,
        logDir,
        agentRunner: dispatchAgentRunner,
        failureNotifier,
        reviewPublisher,
        planBreakdownPublisher,
        waveAssessmentPublisher,
        lifecycleNotifier,
        jobMemoryRuntime: { store: memoryStore, toolService: memoryToolService },
        logger,
        promptsConfig: config.prompts,
        managementRoot: managementDir,
        ...(capabilitiesByProvider ? { capabilitiesByProvider } : {}),
        ...(providerBrokerToolAllowLists ? { providerBrokerToolAllowLists } : {}),
        ...(brokerToolScope ? { brokerToolScope } : {}),
        mergePrepService,
        githubGateway: gitHubGateway,
        backburnerGitToolService,
        commandRunner,
        gitGateway,
        workspaceRecoveryService,
        skipWorkspaceRecovery: true,
        agentPool
      });

      // Journal new executions (dedup via executionIdsBeforeCycle)
      await journalNewExecutions({
        cycleId,
        executionIdsBeforeCycle,
        dispatchResult,
        journal,
        entityMaps,
        workstreams: dispatchResult.workstreams
      });

      // Journal task status transitions after dispatch
      await journalTaskTransitions({
        cycleId,
        tasksBefore: tasks,
        tasksAfter: dispatchResult.tasks,
        journal,
        entityMaps,
        workstreams: dispatchResult.workstreams
      });

      const ingestionResult = await ingestRetrospectiveExecutions({
        tasks: [...dispatchResult.tasks, ...previousState.tasks],
        executions: dispatchResult.executions,
        candidates: retrospectiveDerivation.candidates,
        problems: retrospectiveDerivation.problems,
        opportunities: retrospectiveDerivation.opportunities,
        proposals: previousState.learningProposals,
        readArtifact: (p) => readFile(p, "utf8"),
        now: generatedAt
      });

      const scopeValidationConfig = buildScopeValidationConfigFromRuntime({
        repos: config.repos,
        agents: config.agents
      });

      const scoredProblems = scoreRetrospectiveProblems(
        ingestionResult.problems,
        scopeValidationConfig,
        generatedAt
      );

      const validationResult = await validateLearningProposals({
        proposals: ingestionResult.proposals,
        opportunities: ingestionResult.opportunities,
        problems: scoredProblems,
        scopeValidationConfig,
        managementRoot: managementDir,
        readArtifact: async (p) => {
          try {
            return await readFile(p, "utf8");
          } catch {
            return undefined;
          }
        },
        now: generatedAt
      });

      const materializationResult = await materializeManagementLearningProposals({
        proposals: validationResult.proposals,
        managementPrs: previousState.managementPrs,
        candidates: ingestionResult.candidates,
        problems: scoredProblems,
        opportunities: ingestionResult.opportunities,
        managementRoot: managementDir,
        gitGateway,
        githubGateway: gitHubGateway,
        commandRunner,
        now: generatedAt
      });

      await stateStore.writeRetrospectiveCandidateState(ingestionResult.candidates);
      await stateStore.writeRetrospectiveProblemState(scoredProblems);
      await stateStore.writeRetrospectiveOpportunityState(ingestionResult.opportunities);
      await stateStore.writeLearningProposalState(materializationResult.proposals);
      await stateStore.writeManagementPrState(materializationResult.managementPrs);

      const reconciledWorktrees = implementationWorkflowService.reconcileTaskState(
        projectionAwareTriageWorktrees,
        dispatchResult.tasks
      );
      const projectionAwareReconciledWorktrees =
        implementationWorkflowService.reconcilePacketWorktreeReadinessFromProjections(
          reconciledWorktrees,
          packetPullRequestProjections,
          enabledRepos,
          dispatchResult.tasks,
          dispatchResult.workstreams,
          scanResult.prs
        );
      const finalWorktrees = await implementationWorkflowService.finalizePushableHandoffs(
        projectionAwareReconciledWorktrees,
        dispatchResult.tasks,
        logger
      );
      await stateStore.writeWorktreeState(finalWorktrees);
      const finalWorkstreams = deriveWorkstreams({
        repos: enabledRepos,
        currentIssues: scanResult.issues,
        currentPullRequests: scanResult.prs,
        previousPullRequests: previousState.prs,
        worktrees: finalWorktrees,
        previousWorkstreams: dispatchResult.workstreams
      });
      const finalAttentionObservedAt = new Date().toISOString();
      const finalAttention = deriveAttentionRecords({
        repos: enabledRepos,
        workstreams: finalWorkstreams,
        previousState,
        currentIssues: scanResult.issues,
        currentPullRequests: scanResult.prs,
        currentComments: scanResult.comments,
        tasks: dispatchResult.tasks,
        now: finalAttentionObservedAt
      });
      const finalPhaseAwareWorkstreams = deriveWorkstreams({
        repos: enabledRepos,
        currentIssues: scanResult.issues,
        currentPullRequests: scanResult.prs,
        previousPullRequests: previousState.prs,
        worktrees: finalWorktrees,
        previousWorkstreams: finalWorkstreams,
        attention: finalAttention
      });
      const breakdownEnrichedWorkstreams = applyPlanBreakdownResultsToWorkstreams({
        workstreams: finalPhaseAwareWorkstreams,
        tasks: dispatchResult.tasks,
        executions: dispatchResult.executions
      });
      const enrichedWorkstreams = applyWaveAssessmentResultsToWorkstreams({
        workstreams: breakdownEnrichedWorkstreams,
        assessments: dispatchResult.executions
          .map((execution) => execution.result?.waveAssessment)
          .filter((assessment): assessment is WaveAssessmentResult => assessment !== undefined)
      });

      // Packet planning artifact creation
      const repoPathMap = buildPacketProvisioningRepoPathMap(scanResult.repoResults);

      let currentWorktrees = finalWorktrees;
      let currentWorkstreams = enrichedWorkstreams;

      // Preserve new packet plans before provisioning external packet artifacts.
      await stateStore.writeWorkstreamState(currentWorkstreams);

      for (const workstream of currentWorkstreams) {
        if (!workstream.packetPlan) {
          continue;
        }

        const repo = enabledRepos.find(
          (r) => r.id === workstream.repoKey || `${r.owner}/${r.name}` === workstream.repoKey
        );
        const repoPath = repo ? repoPathMap.get(repo.id) : undefined;
        if (!repo || !repoPath) {
          continue;
        }

        const parentIntegrationBranch = workstream.integration?.branchName;
        if (!parentIntegrationBranch) {
          continue;
        }

        try {
          const comparison = await gitGateway.compareBranchSyncStatus(
            repoPath,
            parentIntegrationBranch,
            repo.defaultBranch ?? "main"
          );
          if (comparison.status === "missing_parent_branch" || comparison.status === "unknown") {
            logger.warn(
              `Packet worktree start point origin/${parentIntegrationBranch} is unavailable for ${workstream.id}; will retry next cycle.`
            );
            continue;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            `Could not verify packet worktree start point for ${workstream.id}; will retry next cycle: ${message}`
          );
          continue;
        }

        let packetWorktreeResults;
        try {
          packetWorktreeResults =
            await implementationWorkflowService.ensurePacketPlanningWorktreesForCurrentWave({
              repo,
              repoPath,
              codeRoot,
              parentWorkstream: workstream,
              existingWorktrees: currentWorktrees
            });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            `Failed to provision packet worktrees for ${workstream.id}; will retry next cycle: ${message}`
          );
          continue;
        }

        if (packetWorktreeResults.length > 0) {
          for (const result of packetWorktreeResults) {
            const existingIndex = currentWorktrees.findIndex((wt) => wt.id === result.worktree.id);
            if (existingIndex !== -1) {
              currentWorktrees = [
                ...currentWorktrees.slice(0, existingIndex),
                result.worktree,
                ...currentWorktrees.slice(existingIndex + 1)
              ];
            } else {
              currentWorktrees = [...currentWorktrees, result.worktree];
            }
          }

          // A PR create failure must leave a persisted worktree that can be retried.
          await stateStore.writeWorktreeState(currentWorktrees);

          let runningWorkstream = workstream;
          for (const result of packetWorktreeResults) {
            const { worktree: updatedWorktree, pullRequestCreated } =
              await implementationWorkflowService.ensurePullRequestForPacketWorktree(
                repo,
                runningWorkstream,
                result.worktree
              );

            if (pullRequestCreated && updatedWorktree.packet && updatedWorktree.prNumber) {
              packetPrsCreatedThisRun.push({
                workstreamId: runningWorkstream.id,
                repoKey: runningWorkstream.repoKey,
                parentPrNumber: runningWorkstream.integration?.prNumber,
                packetId: updatedWorktree.packet.packetId,
                waveIndex: updatedWorktree.packet.waveIndex,
                branchName: updatedWorktree.branchName,
                prNumber: updatedWorktree.prNumber
              });
            }

            // Update WorktreeRecord list
            const existingIndex = currentWorktrees.findIndex((wt) => wt.id === updatedWorktree.id);
            if (existingIndex !== -1) {
              currentWorktrees = [
                ...currentWorktrees.slice(0, existingIndex),
                updatedWorktree,
                ...currentWorktrees.slice(existingIndex + 1)
              ];
            } else {
              currentWorktrees = [...currentWorktrees, updatedWorktree];
            }

            // Update WorkstreamRecord state
            const packetId = updatedWorktree.packet?.packetId;
            if (packetId && updatedWorktree.prNumber) {
              const updatedPacketPlan = markPacketPlanningPrOpen({
                packetPlan: runningWorkstream.packetPlan!,
                packetId,
                branchName: updatedWorktree.branchName,
                prNumber: updatedWorktree.prNumber,
                updatedAt: new Date().toISOString()
              });

              runningWorkstream = { ...runningWorkstream, packetPlan: updatedPacketPlan };
              currentWorkstreams = currentWorkstreams.map((ws) =>
                ws.id === runningWorkstream.id ? runningWorkstream : ws
              );
            }
          }
        }
      }

      await stateStore.writeWorktreeState(currentWorktrees);

      const parentBranchSyncPreflights = await collectParentBranchSyncPreflights({
        workstreams: currentWorkstreams,
        repos: enabledRepos,
        pullRequests: scanResult.prs,
        repoResults: scanResult.repoResults,
        tasks: [...dispatchResult.tasks, ...previousState.tasks],
        executions: dispatchResult.executions,
        gitGateway
      });

      const parentBranchSyncedThisRun = syncActionResult.attempts.some(
        (attempt) => attempt.attempted && attempt.status === "synced"
      );

      const packetWaveAdvancementEvaluation = buildPacketWaveAdvancementEvaluationForRun({
        workstreams: currentWorkstreams,
        parentBranchSyncPreflights: parentBranchSyncedThisRun ? [] : parentBranchSyncPreflights,
        waveAssessments: currentWorkstreams.flatMap((workstream) => workstream.packetPlan?.waveAssessments ?? [])
      });

      packetWaveAdvancementsThisRun = packetWaveAdvancementEvaluation.result.advanced.map((adv) => {
        const workstream = currentWorkstreams.find((ws) => ws.id === adv.workstreamId);
        return {
          workstreamId: adv.workstreamId,
          repoKey: workstream?.repoKey ?? "unknown",
          parentPrNumber: workstream?.integration?.prNumber,
          fromWaveIndex: adv.fromWaveIndex,
          toWaveIndex: adv.toWaveIndex,
          completedPacketIds: adv.result.packetPlanResult.preview.completedCurrentWavePacketIds,
          newlyCurrentPacketIds: adv.nextWavePacketIds
        };
      });

      packetWaveBlockedThisRun = packetWaveAdvancementEvaluation.result.blocked.map((blocked) => {
        const workstream = currentWorkstreams.find((ws) => ws.id === blocked.workstreamId);
        return {
          workstreamId: blocked.workstreamId,
          repoKey: workstream?.repoKey ?? "unknown",
          parentPrNumber: workstream?.integration?.prNumber,
          reason: blocked.reason,
          currentWaveIndex: blocked.result.packetPlanResult.preview.currentWaveIndex,
          incompletePacketIds: blocked.result.packetPlanResult.preview.incompleteCurrentWavePacketIds
        };
      });

      if (packetWaveAdvancementEvaluation.result.advanced.length > 0) {
        currentWorkstreams = currentWorkstreams.map(
          (workstream) =>
            packetWaveAdvancementEvaluation.result.workstreams[workstream.id] ?? workstream
        );
      }

      const persistedAttentionObservedAt = new Date().toISOString();
      const persistedAttention = deriveAttentionRecords({
        repos: enabledRepos,
        workstreams: currentWorkstreams,
        previousState,
        currentIssues: scanResult.issues,
        currentPullRequests: scanResult.prs,
        currentComments: scanResult.comments,
        tasks: dispatchResult.tasks,
        now: persistedAttentionObservedAt
      });

      await stateStore.writeWorkstreamState(currentWorkstreams);
      await stateStore.writeAttentionState(persistedAttention);

      const lifecyclePublisher = new GitHubPacketLifecyclePublisher(gitHubGateway, logger);
      await lifecyclePublisher.publishLifecycleFeedback({
        workstreams: currentWorkstreams,
        repos: enabledRepos,
        packetPrsCreatedThisRun,
        waveAdvancementsThisRun: packetWaveAdvancementsThisRun,
        blockedThisRun: packetWaveBlockedThisRun,
        parentBranchSyncPreflights
      });

      summaryWorkstreams = currentWorkstreams;

      // Journal worktree and packet wave transitions
      await journalWorktreeTransitions({
        cycleId,
        previousWorktrees: previousState.worktrees,
        currentWorktrees: currentWorktrees,
        journal
      });

      await journalPacketWaveEvents({
        cycleId,
        packetWaveAdvancementsThisRun,
        packetWaveBlockedThisRun,
        journal
      });
    } finally {
      if (brokerServer) {
        await brokerServer.close();
      }
      if (brokerLogger) {
        await brokerLogger.close();
      }
    }
  }

  const outputsGitOps = await gitOpsLifecycle.finalizeOutputsRoot(
    outputsDir,
    startedAt,
    outputsGitOpsPrepared
  );

  const completedAt = new Date().toISOString();
  logger.info(
    `Run complete: ${dispatchResult.tasks.length} tasks tracked, ${dispatchResult.tasks.filter((task) => task.status === "failed").length} failed`
  );
  const summary: RunSummary = {
    command: "run",
    codeRoot,
    managementDir,
    outputsDir,
    stateDir,
    logDir,
    startedAt,
    completedAt,
    managementGitOps,
    outputsGitOps,
    repoCount: enabledRepos.length,
    syncedRepoCount: scanResult.repoResults.filter((result) => result.status === "synced").length,
    failedRepoCount: scanResult.repoResults.filter((result) => result.status === "failed").length,
    scannedRepoCount: scanResult.repoResults.filter((result) => result.githubScan?.status === "scanned").length,
    partiallyScannedRepoCount: scanResult.repoResults.filter(
      (result) => result.githubScan?.status === "partial"
    ).length,
    failedScanRepoCount: scanResult.repoResults.filter(
      (result) => result.githubScan?.status === "failed"
    ).length,
    issueCount: scanResult.issues.length,
    pullRequestCount: scanResult.prs.length,
    commentCount: scanResult.comments.length,
    taskCount: dispatchResult.tasks.length,
    pendingTaskCount: dispatchResult.tasks.filter((task) => task.status === "pending").length,
    dispatchedTaskCount: dispatchResult.tasks.filter((task) => task.status === "dispatched").length,
    completedTaskCount: dispatchResult.tasks.filter((task) => task.status === "completed").length,
    failedTaskCount: dispatchResult.tasks.filter((task) => task.status === "failed").length,
    executionCount: dispatchResult.executions.length,
    productDiscoveryCount: summaryWorkstreams.filter((workstream) => workstream.phase === "product_discovery").length,
    productSpecificationCount: summaryWorkstreams.filter((workstream) => workstream.phase === "product_specification").length,
    waitingForProductApprovalCount: summaryWorkstreams.filter(
      (workstream) => workstream.product?.status === "in_discovery"
    ).length,
    pullRequestBaseClassifications: scanResult.prs
      .map((pr) =>
        classifyPullRequestBase({
          pullRequestNumber: pr.number,
          repoSlug: pr.repoSlug,
          baseBranch: pr.baseBranch,
          defaultBranch: pr.defaultBranch
        })
      )
      .sort((left, right) => {
        const slugCompare = left.repoSlug.localeCompare(right.repoSlug);
        if (slugCompare !== 0) {
          return slugCompare;
        }
        return left.pullRequestNumber - right.pullRequestNumber;
      }),
    packetPullRequestCandidates: collectPacketPullRequestCandidates({
      pullRequests: scanResult.prs,
      workstreams: summaryWorkstreams
    }),
    parentBranchSyncPreflights: await collectParentBranchSyncPreflights({
      workstreams: summaryWorkstreams,
      repos: enabledRepos,
      pullRequests: scanResult.prs,
      repoResults: scanResult.repoResults,
      tasks: [...dispatchResult.tasks, ...previousState.tasks],
      executions: dispatchResult.executions,
      gitGateway
    }),
    packetPrsCreatedThisRun,
    packetWaveAdvancementsThisRun,
    packetWaveBlockedThisRun,
    packetPlans: summaryWorkstreams
      .filter((ws) => ws.packetPlan)
      .map((ws) => ({
        workstreamId: ws.id,
        repoKey: ws.repoKey,
        parentPrNumber: ws.integration?.prNumber,
        status: ws.packetPlan!.status,
        packetCount: Object.keys(ws.packetPlan!.packets).length,
        waveCount: ws.packetPlan!.waves.length,
        currentWaveIndex: ws.packetPlan!.currentWaveIndex,
        waves: ws.packetPlan!.waves.map((packetIds, index) => ({
          index,
          packetIds,
          packets: packetIds.map((id) => {
            const p = ws.packetPlan!.packets[id];
            return {
              id,
              status: p?.status ?? "planned",
              branchName: p?.branchName,
              prNumber: p?.prNumber
            };
          })
        }))
      }))
      .sort((a, b) => a.workstreamId.localeCompare(b.workstreamId)),
    results: scanResult.repoResults
      .slice()
      .sort((left, right) => left.repoSlug.localeCompare(right.repoSlug)),
    tasks: dispatchResult.tasks
  };

  return summary;
}

async function collectParentBranchSyncPreflights(input: {
  workstreams: WorkstreamRecord[];
  repos: RepoConfig[];
  pullRequests: NormalizedPullRequest[];
  repoResults: RepoSyncRecord[];
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  gitGateway: GitGateway;
}): Promise<ParentBranchSyncPreflightRunSummary[]> {
  const repoByKey = new Map<string, RepoConfig>();
  for (const repo of input.repos) {
    repoByKey.set(repo.id, repo);
    repoByKey.set(`${repo.owner}/${repo.name}`, repo);
  }

  const repoResultById = new Map(input.repoResults.map((result) => [result.repoId, result]));
  const repoResultBySlug = new Map(input.repoResults.map((result) => [result.repoSlug, result]));
  const pullRequestByRepoAndNumber = new Map<string, NormalizedPullRequest>();
  for (const pullRequest of input.pullRequests) {
    pullRequestByRepoAndNumber.set(`${pullRequest.repoId}:${pullRequest.number}`, pullRequest);
    pullRequestByRepoAndNumber.set(`${pullRequest.repoKey}:${pullRequest.number}`, pullRequest);
    pullRequestByRepoAndNumber.set(`${pullRequest.repoSlug}:${pullRequest.number}`, pullRequest);
  }

  const basePreflights = input.workstreams
    .map((workstream) => {
      const repo = repoByKey.get(workstream.repoKey);
      const repoResult = repo
        ? repoResultById.get(repo.id) ?? repoResultBySlug.get(`${repo.owner}/${repo.name}`)
        : repoResultBySlug.get(workstream.repoKey);
      const defaultBranch = repo?.defaultBranch ?? repoResult?.defaultBranch ?? undefined;
      const preflight = buildParentBranchSyncPreflight({
        workstream,
        defaultBranch: defaultBranch ?? undefined
      });
      if (preflight?.parentPrNumber !== undefined) {
        const parentPr =
          pullRequestByRepoAndNumber.get(`${workstream.repoKey}:${preflight.parentPrNumber}`) ??
          (repo
            ? pullRequestByRepoAndNumber.get(`${repo.id}:${preflight.parentPrNumber}`) ??
              pullRequestByRepoAndNumber.get(`${repo.owner}/${repo.name}:${preflight.parentPrNumber}`)
            : undefined);
        if (parentPr?.headSha) {
          preflight.parentHeadSha = parentPr.headSha;
        }
      }
      if (preflight) {
        const originalPlanningSessionId = resolveWaveAssessmentOriginalPlanningSessionId(
          workstream,
          preflight,
          input.tasks,
          input.executions
        );
        if (originalPlanningSessionId) {
          preflight.originalPlanningSessionId = originalPlanningSessionId;
        }
      }
      return { preflight, repoResult };
    })
    .filter(
      (item): item is { preflight: ParentBranchSyncPreflight; repoResult: RepoSyncRecord | undefined } =>
        item.preflight !== undefined
    );

  const enriched: ParentBranchSyncPreflightRunSummary[] = [];

  for (const { preflight, repoResult } of basePreflights) {
    if (!repoResult?.localPath) {
      enriched.push({ preflight, branchSyncComparisonSkippedReason: "missing_local_path" });
      continue;
    }

    try {
      const branchSyncComparison = await input.gitGateway.compareBranchSyncStatus(
        repoResult.localPath,
        preflight.parentIntegrationBranch,
        preflight.defaultBranch
      );
      enriched.push({ preflight, branchSyncComparison });
    } catch {
      enriched.push({
        preflight,
        branchSyncComparison: {
          parentBranch: preflight.parentIntegrationBranch,
          defaultBranch: preflight.defaultBranch,
          parentRef: `refs/remotes/origin/${preflight.parentIntegrationBranch}`,
          defaultRef: `refs/remotes/origin/${preflight.defaultBranch}`,
          status: "unknown",
          message: "Could not compare branch sync status."
        }
      });
    }
  }

  return enriched.sort((left, right) => {
    const repoCompare = left.preflight.repoKey.localeCompare(right.preflight.repoKey);
    if (repoCompare !== 0) return repoCompare;
    return left.preflight.workstreamId.localeCompare(right.preflight.workstreamId);
  });
}

function resolveWaveAssessmentOriginalPlanningSessionId(
  workstream: WorkstreamRecord,
  preflight: ParentBranchSyncPreflight | undefined,
  tasks: TaskRecord[],
  executions: ExecutionRecord[]
): string | undefined {
  if (!preflight) {
    return undefined;
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const latestPlanBreakdownExecution = executions
    .filter((execution) => execution.taskKind === "plan_breakdown" && execution.taskStatus === "completed")
    .filter((execution) => taskById.get(execution.taskId)?.workstreamId === workstream.id)
    .sort((left, right) => right.endedAt.localeCompare(left.endedAt))[0];
  if (latestPlanBreakdownExecution?.result?.planBreakdownSessionId) {
    return latestPlanBreakdownExecution.result.planBreakdownSessionId;
  }

  const matchingAssessment = (workstream.packetPlan?.waveAssessments ?? []).find(
    (assessment) =>
      assessment.checkpoint.identity.workstreamId === preflight.workstreamId &&
      assessment.checkpoint.identity.currentWaveIndex === preflight.currentWaveIndex &&
      assessment.checkpoint.identity.nextWaveIndex === preflight.nextWaveIndex &&
      assessment.checkpoint.identity.parentPrNumber === (preflight.parentPrNumber ?? 0) &&
      assessment.checkpoint.identity.parentIntegrationBranch === preflight.parentIntegrationBranch &&
      assessment.checkpoint.identity.defaultBranch === preflight.defaultBranch &&
      assessment.checkpoint.identity.parentHeadSha === (preflight.parentHeadSha ?? "unknown") &&
      assessment.checkpoint.identity.planRevision === (preflight.planRevision ?? "unknown")
  );

  return matchingAssessment?.checkpoint.identity.originalPlanningSessionId;
}


function buildMetadata(
  generatedAt: string,
  entityCount: number,
  repoCount: number,
  failures: EntityStateMetadata["partialFailures"]
): EntityStateMetadata {
  return {
    generatedAt,
    repoCount,
    entityCount,
    partialFailures: failures
  };
}
