import type { AgentConfig, PromptsConfigFile, AgentProvider } from "../config/types.js";
import { buildAgentContext, type BuiltContext } from "../context/types.js";
import type { AgentVisibleCapabilities } from "../capabilities/types.js";
import {
  applySkippedCapabilityProjection,
  deriveProjectedCapabilityToolNames
} from "../capabilities/projection.js";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { StateStore } from "../state/loader.js";
import type {
  ExecutionRecord,
  PlanBreakdownResult,
  WaveAssessmentResult,
  WorkstreamPacketPlan,
  WorkstreamRecord
} from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { roleForTask, selectAgentForTask, NoProviderAvailableError } from "./selection.js";
import {
  resolveJobAgentAssignment,
  recordJobAgentAssignmentExecution
} from "./job-agent-assignments.js";
import type { AgentRunner } from "./types.js";
import type { TaskFailureNotifier } from "./failure-feedback.js";
import type { ReviewPublisher } from "./review-feedback.js";
import type { PlanBreakdownPublisher } from "./plan-breakdown-feedback.js";
import type { WaveAssessmentPublisher } from "./wave-assessment-feedback.js";
import type { TaskLifecycleNotifier } from "./lifecycle-feedback.js";
import { getJobMemoryBankId, resolveJobMemoryScope } from "../memory/scope.js";
import { buildMemoryPrelude } from "../memory/prompt.js";
import type { JobMemoryRuntime } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import { managementRoot } from "../utils/paths.js";
import { resolveTaskPromptContent, loadLearningOverlays } from "../prompts/resolver.js";
import type { ResolvedPromptContent, OverlayLoadContext } from "../prompts/resolver.js";
import { workflowRegistry } from "../workflows/registry.js";
import type { AgentStrategyRole } from "./types.js";
import {
  resolveProviderSessionScope,
  getProviderSessionRecordId,
  evaluateProviderSessionDecision
} from "./provider-sessions.js";
import type {
  ProviderSessionCapability,
  ProviderSessionScope,
  ProviderSessionRecord,
  ProviderLimitRecord
} from "../state/types.js";
import { AgentPool, Mutex, deriveExecutionLockKeys } from "./pool.js";
import { buildPacketPlanFromPlanBreakdown } from "../workstreams/packet-plan.js";
import { buildWaveAssessmentCheckpoint } from "../workstreams/wave-assessment/checkpoint.js";
import { mapSignalToRecord } from "./limit-detector.js";

/**
 * Memory tool names that are not safe to expose in concurrent mode because
 * JobMemoryToolService.bind() is global mutable state and is skipped when
 * isConcurrent is true. Calls would return memory_scope_unbound.
 */
const CONCURRENT_UNSAFE_MEMORY_TOOLS = new Set(["memory_search", "memory_add"]);

/**
 * Maximum number of memory entries to include in the prompt prelude.
 * This limit balances providing sufficient historical context with prompt token budget
 * and ensuring the most relevant recent memories are prioritized.
 */
const MEMORY_PRELUDE_LIMIT = 10;

function getSkippedCapabilityNames(task: TaskRecord): ReadonlySet<string> {
  return new Set(
    (task.context.mcpSkipContexts ?? []).flatMap((context) => context.affectedCapabilityNames)
  );
}

function applyTaskCapabilitySkips(
  capabilities: AgentVisibleCapabilities | undefined,
  task: TaskRecord
): AgentVisibleCapabilities | undefined {
  if (capabilities === undefined) {
    return undefined;
  }

  const skippedCapabilityNames = getSkippedCapabilityNames(task);
  return applySkippedCapabilityProjection(capabilities, skippedCapabilityNames);
}

function applyTaskBrokerToolSkips(
  providerBrokerToolAllowList: readonly string[],
  baseCapabilities: AgentVisibleCapabilities | undefined,
  taskCapabilities: AgentVisibleCapabilities | undefined
): readonly string[] {
  if (baseCapabilities === undefined || taskCapabilities === undefined) {
    return providerBrokerToolAllowList;
  }

  const baseTools = new Set(deriveProjectedCapabilityToolNames(baseCapabilities));
  const taskTools = new Set(deriveProjectedCapabilityToolNames(taskCapabilities));
  const skippedTools = new Set([...baseTools].filter((toolName) => !taskTools.has(toolName)));
  if (skippedTools.size === 0) {
    return providerBrokerToolAllowList;
  }

  return providerBrokerToolAllowList.filter((toolName) => !skippedTools.has(toolName));
}

function eligibleTaskRecordsHaveSkips(tasks: readonly TaskRecord[]): boolean {
  return tasks.some((task) => (task.context.mcpSkipContexts ?? []).length > 0);
}

export interface DispatchCycleInput {
  tasks: TaskRecord[];
  agents: AgentConfig[];
  existingExecutions: ExecutionRecord[];
  stateStore: StateStore;
  logDir: string;
  agentRunner: AgentRunner;
  failureNotifier?: TaskFailureNotifier | undefined;
  reviewPublisher?: ReviewPublisher | undefined;
  planBreakdownPublisher?: PlanBreakdownPublisher | undefined;
  waveAssessmentPublisher?: WaveAssessmentPublisher | undefined;
  lifecycleNotifier?: TaskLifecycleNotifier | undefined;
  jobMemoryRuntime?: JobMemoryRuntime | undefined;
  logger?: Logger | undefined;
  now?: (() => string) | undefined;
  promptsConfig?: PromptsConfigFile | undefined;
  managementRoot?: string | undefined;
  capabilitiesByProvider?: ReadonlyMap<string, AgentVisibleCapabilities> | undefined;
  providerBrokerToolAllowLists?: ReadonlyMap<string, readonly string[]> | undefined;
  mcpBlockedTaskIds?: ReadonlySet<string> | undefined;
  /** Restrict this dispatch pass to an explicit task subset. */
  eligibleTaskIds?: ReadonlySet<string> | undefined;
  deferFailureNotifications?: boolean | undefined;
  brokerToolScope?: {
    bindAllowedTools(allowedToolNames: readonly string[]): void;
    clearAllowedTools(): void;
  } | undefined;
  /**
   * Execution-local cwd overrides for specific tasks.
   * When present for a task, the agent runs with this path as its working directory.
   * This value is NEVER written to the durable task state — it is only used
   * to shadow `localRepoPath` in the BuiltContext passed to the agent runner.
   */
  executionCwdByTaskId?: ReadonlyMap<string, string> | undefined;
  /**
   * When provided, eligible tasks are dispatched concurrently up to
   * AgentPool.maxConcurrent slots. Scope locks (workstream / branch / workspace)
   * prevent tasks that share resources from overlapping. State reads/writes are
   * serialized via the pool's stateMutex.
   *
   * In concurrent mode (pool.isConcurrent AND all participating providers share
   * an identical safe allow-list after memory tools are removed):
   * - ScopedBrokerToolService is bound once for the whole batch using the common
   *   safe allow-list and cleared after all tasks settle.
   * - memory_search / memory_add are filtered from the batch allow-list because
   *   JobMemoryToolService.bind() is global mutable state and is skipped.
   * - Per-task bind/unbind of the memory tool service is also skipped.
   *
   * If participating providers have different safe allow-lists, dispatch falls
   * back to sequential for this batch to preserve per-provider broker boundaries.
   * Per-task broker binding and memory tool binding still apply in the fallback.
   *
   * With pool.maxConcurrent=1, isConcurrent is false and the sequential path
   * (per-task binding) is always used — identical to running without a pool.
   */
  agentPool?: AgentPool | undefined;
}

/**
 * Compute whether a single batch-level broker allow-list can safely serve
 * all concurrent tasks, and what that list should be.
 *
 * Returns canBind=true + the common safe list when every provider whose agents
 * could run a task in this batch shares an identical safe allow-list (with
 * memory tools removed). Returns canBind=false when providers differ —
 * the caller must fall back to sequential dispatch.
 *
 * Only considers providers represented by agents that are eligible to handle
 * at least one task in eligibleTasks (matched by role and modelClass). Providers
 * that are enabled but not selected for any task in this batch are excluded so
 * they cannot unnecessarily downgrade an otherwise-safe concurrent batch.
 */
function computeConcurrentBrokerBinding(
  eligibleTasks: readonly TaskRecord[],
  agents: readonly AgentConfig[],
  providerBrokerToolAllowLists: ReadonlyMap<string, readonly string[]>
): { canBind: true; safeList: readonly string[] } | { canBind: false } {
  const participatingProviders = new Set<string>();
  for (const task of eligibleTasks) {
    try {
      const definition = workflowRegistry.getDefinition(task.kind);
      const requiredRole = roleForTask(task);
      for (const agent of agents) {
        if (
          agent.enabled &&
          agent.roles.includes(requiredRole) &&
          agent.modelClass === definition.modelClass
        ) {
          participatingProviders.add(agent.provider);
        }
      }
    } catch {
      // unknown task kind — skip; doesn't affect safety
    }
  }

  const safeLists: string[][] = [];
  for (const [provider, tools] of providerBrokerToolAllowLists) {
    if (!participatingProviders.has(provider)) continue;
    safeLists.push(
      [...tools].filter(t => !CONCURRENT_UNSAFE_MEMORY_TOOLS.has(t)).sort()
    );
  }

  if (safeLists.length === 0) {
    return { canBind: true, safeList: [] };
  }

  const reference = safeLists[0]!;
  const allMatch = safeLists.every(
    list =>
      list.length === reference.length &&
      list.every((t, i) => t === reference[i])
  );

  return allMatch ? { canBind: true, safeList: reference } : { canBind: false };
}

export interface DispatchCycleResult {
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
}

export interface PreDispatchFailureResult {
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
}

export async function dispatchPendingTasks(input: DispatchCycleInput): Promise<DispatchCycleResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const tasks = [...input.tasks];
  const executions = [...input.existingExecutions];

  const pool = input.agentPool;
  // isConcurrent may be downgraded to false below if broker allow-lists differ.
  let isConcurrent = pool !== undefined && pool.isConcurrent;
  const stateMutex: Mutex = pool !== undefined ? pool.stateMutex : new Mutex();

  const eligibleEntries: Array<{ index: number }> = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i];
    if (
      t &&
      t.status === "pending" &&
      t.relevant !== false &&
      (input.eligibleTaskIds === undefined || input.eligibleTaskIds.has(t.id)) &&
      (t.context.reviewCycle === undefined || input.eligibleTaskIds?.has(t.id) === true) &&
      t.kind !== "sync_parent_branch" &&
      !input.mcpBlockedTaskIds?.has(t.id)
    ) {
      eligibleEntries.push({ index: i });
    }
  }
  eligibleEntries.sort((left, right) => compareEligibleDispatchEntries(tasks, left.index, right.index));

  const dispatchOneTask = async (index: number): Promise<void> => {
    // Track whether sequential-mode memory binding has been established so we
    // can guarantee unbind in the outer finally regardless of where failure occurs.
    let memoryBoundForTask = false;

    try {
      // ── PRE-DISPATCH (serialized) ────────────────────────────────────────
      // Resolve agent, build memory prelude, make session decision, mark task
      // dispatched. All state reads and writes are inside stateMutex so
      // concurrent tasks don't overwrite each other's updates to the shared
      // tasks/executions arrays.
      //
      // Session decision is also made inside this mutex so that two tasks
      // sharing the same provider session scope can never concurrently evaluate
      // and resume the same headless session (fix #3).
      const preDispatch = await stateMutex.runExclusive(async () => {
        const state = await input.stateStore.load();
        const currentAssignments = state.jobAgentAssignments ?? [];

        let assignmentResolution;
        try {
          assignmentResolution = resolveJobAgentAssignment({
            task: tasks[index]!,
            agents: input.agents,
            existingAssignments: currentAssignments,
            providerLimits: state.providerLimits ?? [],
            ...(input.providerBrokerToolAllowLists ? { providerBrokerToolAllowLists: input.providerBrokerToolAllowLists } : {}),
            ...(input.capabilitiesByProvider ? { capabilitiesByProvider: input.capabilitiesByProvider } : {}),
            now: now()
          });
        } catch (err) {
          if (err instanceof NoProviderAvailableError) {
            const providers = err.limitedProviders;
            const provider = providers[0]!;
            const limit = (state.providerLimits ?? []).find((l) => l.provider === provider);
            const resetTime = limit?.resetTime;

            const task = tasks[index]!;
            if (!task.context.notifiedQueued) {
              await safelyNotifyQueued(input.lifecycleNotifier, task, providers, resetTime, input.logger);
            }
            const updatedTask: TaskRecord = {
              ...task,
              status: "queued",
              waitingOnProvider: provider,
              updatedAt: now(),
              context: {
                ...task.context,
                notifiedQueued: true,
                providerLimitQueuedAt: task.context.providerLimitQueuedAt ?? now(),
                providerLimitResumedProvider: undefined
              }
            };
            tasks[index] = updatedTask;
            await input.stateStore.writeTaskState(tasks);

            console.log(`🤖 Task ${updatedTask.id} has been queued (waiting on providers ${providers.join(", ")} due to rate limit).`);
            input.logger?.info(`[dispatch] Task ${updatedTask.id} queued, waiting on providers ${providers.join(", ")}`);

            return { queued: true as const, providers };
          }
          throw err;
        }

        const agent = assignmentResolution.configuredAgent;

        if (assignmentResolution.initialized) {
          await input.stateStore.writeJobAgentAssignmentState(assignmentResolution.assignments);

          if (assignmentResolution.mode === "pinned") {
            const oldAssignment = currentAssignments.find(
              (a) =>
                a.repoKey === tasks[index]!.repoSlug &&
                a.workstreamId === tasks[index]!.workstreamId &&
                a.role === roleForTask(tasks[index]!) &&
                a.status === "active" &&
                a.id !== assignmentResolution.assignment.id
            );
            if (oldAssignment) {
              console.log(`🤖 Pinned agent for task ${tasks[index]!.id} swapped from ${oldAssignment.configuredAgentId} (${oldAssignment.provider}) to ${agent.id} (${agent.provider}).`);
            }
          }
        }

        let memoryBackground: string | undefined;
        if (input.jobMemoryRuntime && tasks[index]!.workstreamId) {
          try {
            const scope = resolveJobMemoryScope(tasks[index]!, agent);
            const bankId = getJobMemoryBankId(scope);
            if (!isConcurrent) {
              input.jobMemoryRuntime.toolService.bind(scope, bankId, tasks[index]!.id);
              memoryBoundForTask = true;
            }
            const entries = await input.jobMemoryRuntime.store.search(bankId, { limit: MEMORY_PRELUDE_LIMIT });
            memoryBackground = buildMemoryPrelude(entries);
          } catch (err) {
            input.logger?.warn(`[job-memory] Failed to bind memory scope for task ${tasks[index]!.id}, dispatching without memory: ${err}`);
          }
        }

        let sessionDecision: import("./provider-sessions.js").ProviderSessionDecision | undefined = undefined;
        let sessionScope: import("../state/types.js").ProviderSessionScope | undefined = undefined;
        let sessionRecordId: string | undefined = undefined;

        if (tasks[index]!.workstreamId) {
          try {
            sessionScope = resolveProviderSessionScope(tasks[index]!, agent);
            sessionRecordId = getProviderSessionRecordId(sessionScope);

            const existingRecord = state.providerSessions?.find(r => r.id === sessionRecordId);

            const capability: ProviderSessionCapability =
              (agent.provider === "codex" || agent.provider === "gemini" || agent.provider === "claude" || agent.provider === "antigravity")
                ? "verified_headless_resume"
                : "unsupported";

            const nativeResumeEnabled = tasks[index]!.kind !== "prepare_pr_for_merge";

            sessionDecision = evaluateProviderSessionDecision({
              capability,
              requestedScope: sessionScope,
              existingRecord,
              nativeResumeEnabled,
              taskKind: tasks[index]!.kind
            });
          } catch (err) {
            input.logger?.warn(`[provider-sessions] Failed to evaluate session decision for task ${tasks[index]!.id}: ${err}`);
          }
        }

        const preparingTask: TaskRecord = {
          ...tasks[index]!,
          status: "dispatched",
          updatedAt: now()
        };
        tasks[index] = preparingTask;
        await input.stateStore.writeTaskState(tasks);

        const isRetry = input.existingExecutions.some(e => e.taskId === preparingTask.id);
        await safelyNotifyDispatch(input.lifecycleNotifier, preparingTask, isRetry, input.logger);

        return {
          queued: false as const,
          agent,
          assignmentResolution,
          memoryBackground,
          preparingTask,
          sessionDecision,
          sessionScope,
          sessionRecordId
        };
      });

      if (preDispatch.queued) {
        return;
      }

      const { agent, assignmentResolution, memoryBackground, preparingTask, sessionDecision, sessionScope, sessionRecordId } = preDispatch;

      // ── PROMPT RESOLUTION (parallel-safe IO, no state mutation) ─────────
      const promptContent = await resolveTaskPromptContent(
        preparingTask,
        input.promptsConfig,
        input.managementRoot ?? managementRoot,
        input.logger
      );

      let taskRole: AgentStrategyRole | undefined;
      try {
        workflowRegistry.getDefinition(preparingTask.kind);
        taskRole = roleForTask(preparingTask);
      } catch {
        // task.kind may not be registered (e.g., future kind); proceed without role scope
      }

      const overlayCtx: OverlayLoadContext = {
        repoId: preparingTask.repoId || undefined,
        provider: agent.provider,
        role: taskRole,
        taskKind: preparingTask.kind
      };

      const loadedOverlays = await loadLearningOverlays(
        overlayCtx,
        input.managementRoot ?? managementRoot,
        input.logger
      );

      const promptContentWithOverlays: ResolvedPromptContent =
        loadedOverlays.length > 0
          ? { ...promptContent, learningOverlays: loadedOverlays }
          : promptContent;

      // ── AGENT EXECUTION (parallel) ───────────────────────────────────────
      const baseCapabilities = input.capabilitiesByProvider?.get(agent.provider);
      const taskCapabilities = applyTaskCapabilitySkips(baseCapabilities, preparingTask);
      const agentContext = buildAgentContext(
        preparingTask,
        memoryBackground,
        taskCapabilities
      );
      const isNativeResumeAfterFailure =
        sessionDecision?.mode === "native_resume_candidate" &&
        input.existingExecutions.some(
          execution =>
            execution.id === preparingTask.lastExecutionId &&
            execution.taskId === preparingTask.id &&
            execution.taskStatus === "failed"
        );
      const retryAwareAgentContext: BuiltContext = isNativeResumeAfterFailure
        ? {
            ...agentContext,
            nativeResumeRetry: {
              previousExecutionFailed: true
            }
          }
        : agentContext;

      const executionCwdOverride = input.executionCwdByTaskId?.get(preparingTask.id);
      const contextForDispatch: BuiltContext = executionCwdOverride
        ? { ...retryAwareAgentContext, localRepoPath: executionCwdOverride }
        : retryAwareAgentContext;

      // In sequential mode only: bind the broker tool scope for this task so
      // the ScopedBrokerToolService enforces the per-provider allowlist.
      // In concurrent mode: the scope was already set for the whole batch at
      // batch start (without memory tools) and will be cleared at batch end.
      if (!isConcurrent && input.brokerToolScope) {
        const providerBrokerToolAllowList = input.providerBrokerToolAllowLists?.get(agent.provider);
        if (providerBrokerToolAllowList) {
          input.brokerToolScope.bindAllowedTools(
            applyTaskBrokerToolSkips(providerBrokerToolAllowList, baseCapabilities, taskCapabilities)
          );
        }
      }

      const result = await (async () => {
        try {
          return await input.agentRunner.dispatch(
            preparingTask,
            contextForDispatch,
            agent,
            sessionDecision,
            promptContentWithOverlays
          );
        } finally {
          // In sequential mode, clear the broker scope after each task.
          // Memory unbind is handled in the outer finally to cover pre-dispatch throws.
          if (!isConcurrent) {
            input.brokerToolScope?.clearAllowedTools();
          }
        }
      })();

      // ── POST-DISPATCH (serialized) ───────────────────────────────────────
      await stateMutex.runExclusive(async () => {
        executions.push(result.execution);

        let providerLimitQueueProviders: AgentProvider | AgentProvider[] | undefined;
        let providerLimitResetTime: string | undefined;
        let swappedAfterProviderLimit = false;

        const actionableProviderLimitSignal =
          result.taskStatus === "completed" ? undefined : result.providerLimitSignal;

        if (actionableProviderLimitSignal) {
          try {
            const limitState = await input.stateStore.load();
            const providerLimits = [...(limitState.providerLimits ?? [])];

            const signal = actionableProviderLimitSignal;
            const existingIdx = providerLimits.findIndex(l => l.provider === signal.provider);

            const newRecord = mapSignalToRecord(signal, now());

            if (existingIdx !== -1) {
              providerLimits[existingIdx] = newRecord;
            } else {
              providerLimits.push(newRecord);
            }

            await input.stateStore.writeProviderLimitState(providerLimits);

            console.log(`🤖 Provider ${signal.provider} limits exceeded: status set to limited. Reset time: ${signal.resetTime}`);
            input.logger?.info(`[dispatch] Provider ${signal.provider} limited until ${signal.resetTime}`);

            try {
              const swapResolution = resolveJobAgentAssignment({
                task: preparingTask,
                agents: input.agents,
                existingAssignments: limitState.jobAgentAssignments ?? [],
                providerLimits,
                replacementForProvider: signal.provider,
                ...(input.providerBrokerToolAllowLists ? { providerBrokerToolAllowLists: input.providerBrokerToolAllowLists } : {}),
                ...(input.capabilitiesByProvider ? { capabilitiesByProvider: input.capabilitiesByProvider } : {}),
                now: now()
              });

              if (swapResolution.configuredAgent.provider !== signal.provider) {
                if (swapResolution.initialized) {
                  await input.stateStore.writeJobAgentAssignmentState(swapResolution.assignments);
                }
                swappedAfterProviderLimit = true;
                input.logger?.info(
                  `[dispatch] Task ${preparingTask.id} reassigned from limited provider ${signal.provider} to ${swapResolution.configuredAgent.provider}.`
                );
                console.log(`🤖 Task ${preparingTask.id} reassigned from limited provider ${signal.provider} to ${swapResolution.configuredAgent.provider}.`);
              } else {
                providerLimitQueueProviders = signal.provider;
                providerLimitResetTime = signal.resetTime;
              }
            } catch (err) {
              if (err instanceof NoProviderAvailableError) {
                providerLimitQueueProviders = err.limitedProviders.length > 0 ? err.limitedProviders : signal.provider;
                providerLimitResetTime = signal.resetTime;
              } else {
                throw err;
              }
            }
          } catch (err) {
            input.logger?.warn(`[dispatch] Failed to persist provider limit updates: ${err}`);
            providerLimitQueueProviders = actionableProviderLimitSignal.provider;
            providerLimitResetTime = actionableProviderLimitSignal.resetTime;
          }
        }

        const isProviderLimit = !!actionableProviderLimitSignal;
        const shouldQueueForProviderLimit = isProviderLimit && !swappedAfterProviderLimit;
        const finalStatus = shouldQueueForProviderLimit ? "queued" as const : swappedAfterProviderLimit ? "pending" as const : result.taskStatus;

        if (shouldQueueForProviderLimit && !preparingTask.context.notifiedQueued) {
          await safelyNotifyQueued(
            input.lifecycleNotifier,
            preparingTask,
            providerLimitQueueProviders ?? actionableProviderLimitSignal.provider,
            providerLimitResetTime,
            input.logger
          );
        }

        tasks[index] = {
          ...preparingTask,
          status: finalStatus,
          lastExecutionId: result.execution.id,
          updatedAt: result.execution.endedAt,
          context: {
            ...preparingTask.context,
            ...(finalStatus === "failed" ? { recoveryNeeded: true } : {}),
            ...(shouldQueueForProviderLimit
              ? {
                  notifiedQueued: true,
                  providerLimitQueuedAt: preparingTask.context.providerLimitQueuedAt ?? result.execution.endedAt,
                  providerLimitResumedProvider: undefined
                }
              : {}),
            ...(swappedAfterProviderLimit
              ? {
                  notifiedQueued: false,
                  providerLimitQueuedAt: undefined,
                  providerLimitResumedProvider: undefined
                }
              : {})
          },
          ...(shouldQueueForProviderLimit ? { waitingOnProvider: actionableProviderLimitSignal.provider } : { waitingOnProvider: undefined })
        };
        await input.stateStore.writeExecutionState(executions);
        await input.stateStore.writeTaskState(tasks);

        if (shouldQueueForProviderLimit) {
          console.log(`🤖 Task ${preparingTask.id} has been queued (waiting on provider ${actionableProviderLimitSignal.provider} due to rate limit).`);
        }

        if (assignmentResolution.mode === "pinned") {
          try {
            const assignmentState = await input.stateStore.load();
            const updatedAssignments = recordJobAgentAssignmentExecution({
              assignments: assignmentState.jobAgentAssignments ?? [],
              assignmentId: assignmentResolution.assignment.id,
              taskId: preparingTask.id,
              executionId: result.execution.id,
              startedAt: result.execution.startedAt,
              endedAt: result.execution.endedAt,
              taskStatus: result.taskStatus
            });
            await input.stateStore.writeJobAgentAssignmentState(updatedAssignments);
          } catch (err) {
            input.logger?.warn(`[job-agent-assignments] Failed to update assignment metadata for task ${preparingTask.id}: ${err}`);
          }
        }

        if (sessionScope && sessionRecordId) {
          try {
            const sessionState = await input.stateStore.load();
            const providerSessions = [...(sessionState.providerSessions ?? [])];
            const recordIdx = providerSessions.findIndex(r => r.id === sessionRecordId);

            const capability: ProviderSessionCapability =
              (agent.provider === "codex" || agent.provider === "gemini" || agent.provider === "claude" || agent.provider === "antigravity")
                ? "verified_headless_resume"
                : "unsupported";

            const nowStr = now();
            const hasSessionId = !!result.providerSession?.providerSessionId;

            if (hasSessionId) {
              const existing = recordIdx !== -1 ? providerSessions[recordIdx] : undefined;
              const isFailed = result.taskStatus === "failed";
              const isRetryable = isFailed
                ? preparingTask.context.reviewCycle === undefined &&
                  isRetryableProviderSessionFailure(result.execution)
                : true;
              const recordStatus = isRetryable ? "active" : "stale";
              const sessionName = result.providerSession!.providerSessionName ?? existing?.providerSessionName;

              const updatedRecord: ProviderSessionRecord = {
                id: sessionRecordId,
                scope: sessionScope,
                capability,
                status: recordStatus,
                providerSessionId: result.providerSession!.providerSessionId!,
                createdAt: existing?.createdAt ?? nowStr,
                updatedAt: nowStr,
                lastStartedAt: existing?.lastStartedAt ?? (sessionDecision?.mode !== "native_resume_candidate" ? nowStr : existing?.lastStartedAt),
                lastResumedAt: sessionDecision?.mode === "native_resume_candidate" ? nowStr : existing?.lastResumedAt,
                ...(sessionName ? { providerSessionName: sessionName } : {}),
                ...(isFailed ? { lastFailedAt: nowStr } : existing?.lastFailedAt ? { lastFailedAt: existing.lastFailedAt } : {}),
                notes: result.providerSession!.status === "stale" ? "Marked stale after completion" : undefined
              };
              if (recordIdx !== -1) {
                providerSessions[recordIdx] = updatedRecord;
              } else {
                providerSessions.push(updatedRecord);
              }
              await input.stateStore.writeProviderSessionState(providerSessions);
            } else if (result.taskStatus === "failed") {
              const existing = recordIdx !== -1 ? providerSessions[recordIdx] : undefined;
              if (existing && existing.status === "active") {
                const isRetryable =
                  preparingTask.context.reviewCycle === undefined &&
                  isRetryableProviderSessionFailure(result.execution);
                if (isRetryable) {
                  existing.lastFailedAt = nowStr;
                  existing.updatedAt = nowStr;
                } else {
                  existing.status = "stale";
                  existing.lastFailedAt = nowStr;
                  existing.updatedAt = nowStr;
                }
                await input.stateStore.writeProviderSessionState(providerSessions);
              }
            }
          } catch (err) {
            input.logger?.warn(`[provider-sessions] Failed to persist session updates for task ${preparingTask.id}: ${err}`);
          }
        }

        if (
          result.taskStatus === "completed" &&
          preparingTask.kind === "review_pr" &&
          preparingTask.context.reviewCycle === undefined
        ) {
          await safelyPublishReview(input.reviewPublisher, preparingTask, result.execution);
        }
        if (result.taskStatus === "completed" && preparingTask.kind === "plan_breakdown") {
          await safelyPublishBreakdown(input.planBreakdownPublisher, preparingTask, result.execution);
        }
        if (result.taskStatus === "completed" && preparingTask.kind === "wave_plan_assessment") {
          const commentId = await safelyPublishWaveAssessment(
            input.waveAssessmentPublisher,
            preparingTask,
            result.execution
          );
          if (commentId && result.execution.result?.waveAssessment) {
            const updatedAssessment: WaveAssessmentResult = {
              ...result.execution.result.waveAssessment,
              postedCommentId: commentId,
              updatedAt: now()
            };
            const updatedExecution: ExecutionRecord = {
              ...result.execution,
              result: {
                ...result.execution.result,
                waveAssessment: updatedAssessment
              }
            };
            const executionIndex = executions.findIndex((execution) => execution.id === updatedExecution.id);
            if (executionIndex !== -1) {
              executions[executionIndex] = updatedExecution;
              tasks[index] = {
                ...tasks[index]!,
                lastExecutionId: updatedExecution.id
              };
              await input.stateStore.writeExecutionState(executions);
              await persistWaveAssessmentToWorkstream(input.stateStore, updatedAssessment);
            }
          } else if (result.execution.result?.waveAssessment) {
            await markCompletedTaskPostDispatchFailure({
              input,
              tasks,
              executions,
              index,
              reason: "Wave assessment completed locally, but publishing the required parent PR assessment comment failed.",
              now
            });
            await safelyNotifyCompletion(input.lifecycleNotifier, preparingTask, "failed", input.logger);
            return;
          }
        }
        if (result.taskStatus === "completed" && preparingTask.kind === "wave_plan_replanning") {
          const planBreakdown = result.execution.result?.planBreakdown;
          if (!planBreakdown) {
            await markCompletedTaskPostDispatchFailure({
              input,
              tasks,
              executions,
              index,
              reason: "Wave replanning completed locally, but it did not return a validated packet plan result.",
              now
            });
            await safelyNotifyCompletion(input.lifecycleNotifier, preparingTask, "failed", input.logger);
            return;
          }
          const replanningCompletedAt = result.execution.endedAt;
          const replanningAssessment = buildReplanningCompletionAssessment(
            preparingTask,
            result.execution,
            planBreakdown,
            replanningCompletedAt
          );
          if (replanningAssessment) {
            const executionWithAssessment: ExecutionRecord = {
              ...result.execution,
              result: {
                ...result.execution.result,
                waveAssessment: replanningAssessment
              }
            };
            const commentId = await safelyPublishWaveAssessment(
              input.waveAssessmentPublisher,
              preparingTask,
              executionWithAssessment
            );
            if (commentId) {
              const updatedAssessment: WaveAssessmentResult = {
                ...replanningAssessment,
                postedCommentId: commentId,
                updatedAt: now()
              };
              const updatedExecution: ExecutionRecord = {
                ...executionWithAssessment,
                result: {
                  ...executionWithAssessment.result,
                  waveAssessment: updatedAssessment
                }
              };
              const executionIndex = executions.findIndex((execution) => execution.id === updatedExecution.id);
              if (executionIndex !== -1) {
                executions[executionIndex] = updatedExecution;
                tasks[index] = {
                  ...tasks[index]!,
                  lastExecutionId: updatedExecution.id
                };
                await input.stateStore.writeExecutionState(executions);
                await persistReplannedPacketPlanToWorkstream(
                  input.stateStore,
                  updatedAssessment,
                  planBreakdown,
                  replanningCompletedAt
                );
              }
            } else {
              await markCompletedTaskPostDispatchFailure({
                input,
                tasks,
                executions,
                index,
                reason: "Wave replanning completed locally, but publishing the required parent PR assessment comment failed.",
                now
              });
              await safelyNotifyCompletion(input.lifecycleNotifier, preparingTask, "failed", input.logger);
              return;
            }
          } else {
            await markCompletedTaskPostDispatchFailure({
              input,
              tasks,
              executions,
              index,
              reason: "Wave replanning completed locally, but the task was missing the assessment checkpoint required for handoff.",
              now
            });
            await safelyNotifyCompletion(input.lifecycleNotifier, preparingTask, "failed", input.logger);
            return;
          }
        }
        if (result.taskStatus === "failed" && !isProviderLimit && input.deferFailureNotifications !== true) {
          const failureCommentId = await safelyNotifyFailure(input.failureNotifier, tasks[index]!, result.execution);
          if (failureCommentId !== undefined) {
            tasks[index] = { ...tasks[index]!, lastFailureCommentId: failureCommentId };
            await input.stateStore.writeTaskState(tasks);
          }
        }
        if (!isProviderLimit) {
          await safelyNotifyCompletion(input.lifecycleNotifier, preparingTask, result.taskStatus, input.logger);
        }
      });
    } catch (error: unknown) {
      await stateMutex.runExclusive(async () => {
        const failedAt = now();
        const failureExecution = await buildSelectionFailureExecution(
          tasks[index]!,
          failedAt,
          input.logDir,
          error
        );
        tasks[index] = {
          ...tasks[index]!,
          status: "failed",
          lastExecutionId: failureExecution.id,
          updatedAt: failedAt,
          context: {
            ...tasks[index]!.context,
            recoveryNeeded: true
          }
        };
        executions.push(failureExecution);
        await input.stateStore.writeExecutionState(executions);
        await input.stateStore.writeTaskState(tasks);
        if (input.deferFailureNotifications !== true) {
          const failureCommentId = await safelyNotifyFailure(input.failureNotifier, tasks[index]!, failureExecution);
          if (failureCommentId !== undefined) {
            tasks[index] = { ...tasks[index]!, lastFailureCommentId: failureCommentId };
            await input.stateStore.writeTaskState(tasks);
          }
        }
      });
    } finally {
      // Guarantee sequential-mode memory unbind regardless of where failure
      // occurred — before dispatch, during dispatch, or after dispatch (fix #5).
      if (!isConcurrent && memoryBoundForTask) {
        input.jobMemoryRuntime?.toolService.unbind();
      }
    }
  };

  // ── Broker scope pre-check ─────────────────────────────────────────────────
  // Compute the batch-level broker allow-list for concurrent mode. If
  // participating providers have different safe allow-lists (after memory tools
  // are removed), downgrade to sequential so per-task binding preserves
  // per-provider broker boundaries. batchBrokerSafeList is non-null only when
  // concurrent dispatch with a single shared allow-list is safe.
  let batchBrokerSafeList: readonly string[] | null = null;
  if (isConcurrent && eligibleTaskRecordsHaveSkips(eligibleEntries.map(({ index }) => tasks[index]!))) {
    isConcurrent = false;
    input.logger?.info(
      "[dispatch] Concurrent mode downgraded to sequential: at least one eligible task has task-scoped MCP skip contexts."
    );
  }

  if (isConcurrent && input.brokerToolScope && input.providerBrokerToolAllowLists) {
    const eligibleTaskRecords = eligibleEntries.map(({ index }) => tasks[index]!);
    const binding = computeConcurrentBrokerBinding(eligibleTaskRecords, input.agents, input.providerBrokerToolAllowLists);
    if (binding.canBind) {
      batchBrokerSafeList = binding.safeList;
    } else {
      isConcurrent = false;
      input.logger?.info(
        "[dispatch] Concurrent mode downgraded to sequential: participating providers have " +
        "different broker tool allow-lists. To run concurrently, make all provider broker " +
        "allow-lists identical or set maxConcurrentAgents: 1."
      );
    }
  }

  if (pool) {
    // Bind the shared broker allow-list before the batch starts. This is only
    // set when isConcurrent is true (all participating providers share the same
    // safe list). When isConcurrent was downgraded above, batchBrokerSafeList
    // is null and per-task binding inside dispatchOneTask applies instead.
    if (batchBrokerSafeList !== null) {
      input.brokerToolScope!.bindAllowedTools(batchBrokerSafeList);
    }

    try {
      if (isConcurrent) {
        // Each task acquires scope locks (workstream / branch / workspace) for
        // its full lifetime before entering dispatchOneTask. Locks are sorted
        // before acquisition to prevent deadlock (fix #2).
        const results = await Promise.allSettled(
          eligibleEntries.map(({ index }) =>
            pool.runWithSlot(async () => {
              const task = tasks[index]!;
              const lockKeys = deriveExecutionLockKeys(task, input.executionCwdByTaskId);
              const releaseScope = await pool.scopeLocks.acquireAll(lockKeys);
              try {
                await dispatchOneTask(index);
              } finally {
                releaseScope();
              }
            })
          )
        );

        // Surface unexpected wrapper-level rejections. Expected task failures are
        // materialized as failed task executions inside dispatchOneTask and should
        // not cause a rejection here. Only a bug in the dispatch wrapper itself
        // should produce a rejected promise (fix #4).
        const unexpectedFailures = results
          .map((r, i) => ({ result: r, index: eligibleEntries[i]!.index }))
          .filter((x): x is { result: PromiseRejectedResult; index: number } =>
            x.result.status === "rejected"
          );
        if (unexpectedFailures.length > 0) {
          const messages = unexpectedFailures.map(({ result, index }) => {
            const taskId = tasks[index]?.id ?? `index:${index}`;
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
            return `task ${taskId}: ${message}`;
          });
          throw new Error(`Unexpected agent dispatch failures:\n${messages.join("\n")}`);
        }
      } else {
        // Sequential: either pool.maxConcurrent=1 or broker lists differ.
        // Per-task broker binding and memory bind/unbind are handled inside
        // dispatchOneTask (isConcurrent=false path).
        for (const { index } of eligibleEntries) {
          await dispatchOneTask(index);
        }
      }
    } finally {
      // Clear the batch-level broker scope after all tasks have settled.
      // Only needed when batchBrokerSafeList was set (concurrent path).
      if (batchBrokerSafeList !== null) {
        input.brokerToolScope?.clearAllowedTools();
      }
    }
  } else {
    for (const { index } of eligibleEntries) {
      await dispatchOneTask(index);
    }
  }

  return {
    tasks,
    executions
  };
}

function compareEligibleDispatchEntries(
  tasks: readonly TaskRecord[],
  leftIndex: number,
  rightIndex: number
): number {
  const left = tasks[leftIndex]!;
  const right = tasks[rightIndex]!;
  const leftProvider = left.context.providerLimitResumedProvider;
  const rightProvider = right.context.providerLimitResumedProvider;

  if (leftProvider && rightProvider) {
    if (leftProvider === rightProvider) {
      const leftQueuedAt = left.context.providerLimitQueuedAt ?? left.updatedAt;
      const rightQueuedAt = right.context.providerLimitQueuedAt ?? right.updatedAt;
      const queueComparison = leftQueuedAt.localeCompare(rightQueuedAt);
      if (queueComparison !== 0) {
        return queueComparison;
      }
      return left.id.localeCompare(right.id);
    }
    return leftProvider.localeCompare(rightProvider);
  }

  if (leftProvider) {
    return -1;
  }
  if (rightProvider) {
    return 1;
  }

  return leftIndex - rightIndex;
}

export async function materializePreDispatchFailure(input: {
  tasks: TaskRecord[];
  existingExecutions: ExecutionRecord[];
  logDir: string;
  error: unknown;
  now?: () => string;
}): Promise<PreDispatchFailureResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const tasks = [...input.tasks];
  const executions = [...input.existingExecutions];

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (!task || (task.status !== "pending" && task.status !== "dispatched") || task.relevant === false) {
      continue;
    }

    const failedAt = now();
    const execution = await buildFailureExecution(
      task,
      failedAt,
      input.logDir,
      input.error,
      "pre-dispatch-failure",
      "failed before agent execution began",
      "Dispatch setup failed before the agent could start."
    );

    tasks[index] = {
      ...task,
      status: "failed",
      lastExecutionId: execution.id,
      updatedAt: failedAt,
      context: {
        ...task.context,
        recoveryNeeded: true
      }
    };
    executions.push(execution);
  }

  return {
    tasks,
    executions
  };
}

async function safelyPublishReview(
  publisher: ReviewPublisher | undefined,
  task: TaskRecord,
  execution: ExecutionRecord
): Promise<void> {
  if (!publisher) {
    return;
  }

  try {
    await publisher.publishReview(task, execution);
  } catch {
    // Review publication failures must not break the dispatch loop.
  }
}

async function safelyPublishBreakdown(
  publisher: PlanBreakdownPublisher | undefined,
  task: TaskRecord,
  execution: ExecutionRecord
): Promise<void> {
  if (!publisher) {
    return;
  }

  try {
    await publisher.publishBreakdown(task, execution);
  } catch {
    // Breakdown publication failures must not break the dispatch loop.
  }
}

function buildReplanningCompletionAssessment(
  task: TaskRecord,
  execution: ExecutionRecord,
  planBreakdown: PlanBreakdownResult,
  timestamp: string
): WaveAssessmentResult | undefined {
  const checkpoint = task.context.waveAssessmentCheckpoint;
  const priorAssessment = task.context.finalizedWaveAssessment;
  if (!checkpoint || !priorAssessment || priorAssessment.decision !== "replan") {
    return undefined;
  }
  const revisedCheckpoint = buildWaveAssessmentCheckpoint({
    ...checkpoint.identity,
    planRevision: timestamp,
    planNodeIds: planBreakdown.tasks.map((planTask) => planTask.id).sort()
  });

  return {
    id: `assessment:replanning-complete:${revisedCheckpoint.id}:${execution.id}`,
    sessionId: execution.id,
    checkpoint: revisedCheckpoint,
    decision: "continue",
    summary: `Replanning completed by task ${task.id}; packet wave progression can continue for the revised checkpoint.`,
    findings: [],
    status: "finalized",
    createdAt: timestamp,
    finalizedAt: timestamp,
    updatedAt: timestamp
  };
}

async function safelyPublishWaveAssessment(
  publisher: WaveAssessmentPublisher | undefined,
  task: TaskRecord,
  execution: ExecutionRecord
): Promise<string | undefined> {
  if (!publisher) {
    return undefined;
  }

  try {
    return await publisher.publishWaveAssessment(task, execution);
  } catch {
    // Assessment publication failures must not break the dispatch loop. Without
    // a posted comment id, the wave remains gated and can be retried.
    return undefined;
  }
}

async function persistWaveAssessmentToWorkstream(
  stateStore: StateStore,
  assessment: WaveAssessmentResult
): Promise<void> {
  const state = await stateStore.load();
  const workstreams = state.workstreams.map((workstream) =>
    workstream.id === assessment.checkpoint.identity.workstreamId
      ? upsertWaveAssessment(workstream, assessment)
      : workstream
  );
  await stateStore.writeWorkstreamState(workstreams);
}

async function persistReplannedPacketPlanToWorkstream(
  stateStore: StateStore,
  assessment: WaveAssessmentResult,
  planBreakdown: PlanBreakdownResult,
  generatedAt?: string
): Promise<void> {
  const state = await stateStore.load();
  const workstreams = state.workstreams.map((workstream) => {
    if (workstream.id !== assessment.checkpoint.identity.workstreamId) {
      return workstream;
    }

    const packetPlan = buildPacketPlanFromPlanBreakdown({
      workstreamId: workstream.id,
      planBreakdown,
      generatedAt:
        generatedAt ??
        assessment.checkpoint.identity.planRevision ??
        assessment.updatedAt ??
        assessment.finalizedAt ??
        assessment.createdAt ??
        new Date().toISOString()
    });
    const priorAssessments = workstream.packetPlan?.waveAssessments ?? [];
    const withoutCurrent = priorAssessments.filter((item) => item.id !== assessment.id);
    const priorStatus = workstream.packetPlan?.status;
    const installedStatus = shouldPreserveReplannedPacketPlanStatus(priorStatus) && priorStatus
      ? priorStatus
      : packetPlan.status;

    return {
      ...workstream,
      packetPlan: {
        ...packetPlan,
        status: installedStatus,
        waveAssessments: [...withoutCurrent, assessment].sort((left, right) => left.id.localeCompare(right.id))
      }
    };
  });
  await stateStore.writeWorkstreamState(workstreams);
}

function shouldPreserveReplannedPacketPlanStatus(status: WorkstreamPacketPlan["status"] | undefined): boolean {
  return status === "approved" || status === "in_progress";
}

function upsertWaveAssessment(
  workstream: WorkstreamRecord,
  assessment: WaveAssessmentResult
): WorkstreamRecord {
  if (!workstream.packetPlan) {
    return workstream;
  }

  const existing = workstream.packetPlan.waveAssessments ?? [];
  const withoutCurrent = existing.filter((item) => item.id !== assessment.id);
  return {
    ...workstream,
    packetPlan: {
      ...workstream.packetPlan,
      waveAssessments: [...withoutCurrent, assessment].sort((left, right) => left.id.localeCompare(right.id))
    }
  };
}

async function markCompletedTaskPostDispatchFailure(input: {
  input: DispatchCycleInput;
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  index: number;
  reason: string;
  now: () => string;
}): Promise<void> {
  const task = input.tasks[input.index]!;
  const failure = await buildSinglePostDispatchHandoffFailureExecution({
    task,
    reason: input.reason,
    logDir: input.input.logDir,
    now: input.now
  });
  input.tasks[input.index] = failure.updatedTask;
  input.executions.push(failure.execution);
  await input.input.stateStore.writeExecutionState(input.executions);
  await input.input.stateStore.writeTaskState(input.tasks);
  if (input.input.deferFailureNotifications !== true) {
    const failureCommentId = await safelyNotifyFailure(
      input.input.failureNotifier,
      failure.updatedTask,
      failure.execution
    );
    if (failureCommentId !== undefined) {
      input.tasks[input.index] = {
        ...input.tasks[input.index]!,
        lastFailureCommentId: failureCommentId
      };
      await input.input.stateStore.writeTaskState(input.tasks);
    }
  }
}

/**
 * Build a failure execution record for a single task that failed before dispatch.
 * Use this when a specific task cannot be dispatched due to a pre-dispatch condition
 * (e.g. worktree blocked, clone creation failed, SHA mismatch).
 *
 * The caller is responsible for:
 * 1. Writing the updated task and execution to state.
 * 2. Calling safelyNotifyFailure to post a GitHub comment.
 */
export async function buildSinglePreDispatchFailureExecution(input: {
  task: TaskRecord;
  reason: string;
  logDir: string;
  now?: () => string;
}): Promise<{ updatedTask: TaskRecord; execution: ExecutionRecord }> {
  const now = input.now ?? (() => new Date().toISOString());
  const failedAt = now();
  const execution = await buildFailureExecution(
    input.task,
    failedAt,
    input.logDir,
    new Error(input.reason),
    "pre-dispatch-failure",
    input.reason,
    "Dispatch setup failed before the agent could start."
  );
  const updatedTask: TaskRecord = {
    ...input.task,
    status: "failed",
    lastExecutionId: execution.id,
    updatedAt: failedAt,
    context: {
      ...input.task.context,
      recoveryNeeded: true
    }
  };
  return { updatedTask, execution };
}

/**
 * Build a failure execution record for a single task whose agent run completed,
 * but whose orchestrator-owned handoff failed afterward.
 *
 * Use this for prepare_pr_for_merge inspection failures and push/lease failures.
 * A merge-prep task is only complete after the orchestrator has inspected the
 * clone and pushed the prepared branch successfully.
 */
export async function buildSinglePostDispatchHandoffFailureExecution(input: {
  task: TaskRecord;
  reason: string;
  logDir: string;
  now?: () => string;
}): Promise<{ updatedTask: TaskRecord; execution: ExecutionRecord }> {
  const now = input.now ?? (() => new Date().toISOString());
  const failedAt = now();
  const execution = await buildFailureExecution(
    input.task,
    failedAt,
    input.logDir,
    new Error(input.reason),
    "post-dispatch-handoff-failure",
    input.reason,
    "Handoff failed after the agent completed. The orchestrator could not safely inspect or publish the merge-prep result."
  );
  const updatedTask: TaskRecord = {
    ...input.task,
    status: "failed",
    lastExecutionId: execution.id,
    updatedAt: failedAt,
    context: {
      ...input.task.context,
      recoveryNeeded: true
    }
  };
  return { updatedTask, execution };
}

async function safelyNotifyDispatch(
  notifier: TaskLifecycleNotifier | undefined,
  task: TaskRecord,
  isRetry: boolean,
  logger?: Logger
): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notifyDispatch(task, { isRetry });
  } catch (err) {
    logger?.error?.(`[lifecycle] Failed to notify dispatch for task ${task.id}: ${err}`);
    console.error(`🤖 [lifecycle] Failed to notify dispatch for task ${task.id}:`, err);
  }
}

async function safelyNotifyQueued(
  notifier: TaskLifecycleNotifier | undefined,
  task: TaskRecord,
  providers: AgentProvider | AgentProvider[],
  resetTime?: string,
  logger?: Logger
): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notifyQueued(task, providers, resetTime);
  } catch (err) {
    const providerList = Array.isArray(providers) ? providers : [providers];
    logger?.error?.(`[lifecycle] Failed to notify queued for task ${task.id} (providers: ${providerList.join(",")}): ${err}`);
    console.error(`🤖 [lifecycle] Failed to notify queued for task ${task.id}:`, err);
  }
}

export async function safelyNotifyResumed(
  notifier: TaskLifecycleNotifier | undefined,
  task: TaskRecord,
  logger?: Logger
): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notifyResumed(task);
  } catch (err) {
    logger?.error?.(`[lifecycle] Failed to notify resumed for task ${task.id}: ${err}`);
    console.error(`🤖 [lifecycle] Failed to notify resumed for task ${task.id}:`, err);
  }
}



async function safelyNotifyCompletion(
  notifier: TaskLifecycleNotifier | undefined,
  task: TaskRecord,
  status: "completed" | "failed",
  logger?: Logger
): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notifyCompletionStatus(task, status);
  } catch (err) {
    logger?.error?.(`[lifecycle] Failed to notify completion status ${status} for task ${task.id}: ${err}`);
    console.error(`🤖 [lifecycle] Failed to notify completion status for task ${task.id}:`, err);
  }
}

export async function safelyNotifyFailure(
  notifier: TaskFailureNotifier | undefined,
  task: TaskRecord,
  execution: ExecutionRecord,
  customMessage?: string
): Promise<string | undefined> {
  if (!notifier) return undefined;
  try {
    return await notifier.notifyFailure(task, execution, customMessage);
  } catch {
    // Failure notifications must not break the dispatch loop.
    return undefined;
  }
}

async function buildSelectionFailureExecution(
  task: TaskRecord,
  timestamp: string,
  stateDir: string,
  error: unknown
): Promise<ExecutionRecord> {
  return buildFailureExecution(
    task,
    timestamp,
    stateDir,
    error,
    "selection-failure",
    "failed during agent selection",
    "Selection Context: No enabled agent was found that matches the role required for this task. Dispatch aborted."
  );
}

async function buildFailureExecution(
  task: TaskRecord,
  timestamp: string,
  stateDir: string,
  error: unknown,
  executionPhase: string,
  statusLine: string,
  contextLine: string
): Promise<ExecutionRecord> {
  const message = error instanceof Error ? error.message : String(error);
  const executionId = `exec-${task.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}-${executionPhase}-${timestamp.replace(/[:.]/g, "-")}`;
  const artifactRoot = path.join(stateDir, "artifacts", executionId);
  const promptArtifactPath = path.join(artifactRoot, "prompt.md");
  const stdoutArtifactPath = path.join(artifactRoot, "stdout.txt");
  const stderrArtifactPath = path.join(artifactRoot, "stderr.txt");
  const promptPacketPath = path.join(artifactRoot, "prompt-packet.json");
  await mkdir(artifactRoot, { recursive: true });
  await Promise.all([
    writeFile(
      promptArtifactPath,
      `Task: ${task.id}\nPhase: ${statusLine}\n\n${contextLine}\n`,
      "utf8"
    ),
    writeFile(stdoutArtifactPath, "", "utf8"),
    writeFile(
      stderrArtifactPath,
      `Task: ${task.id}\nStatus: ${statusLine}\nError: ${message}\n\n${contextLine}\n`,
      "utf8"
    ),
    writeFile(
      promptPacketPath,
      JSON.stringify(
        {
          taskId: task.id,
          taskKind: task.kind,
          status: statusLine,
          context: contextLine,
          error: message
        },
        null,
        2
      ),
      "utf8"
    )
  ]);

  return {
    id: executionId,
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: "failed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "unassigned",
    agentProvider: "unassigned",
    command: {
      executable: "none",
      args: [],
      cwd: task.context.localRepoPath ?? process.cwd(),
      timeoutMs: 0
    },
    promptArtifactPath,
    stdoutArtifactPath,
    stderrArtifactPath,
    promptPacketPath,
    startedAt: timestamp,
    endedAt: timestamp,
    exitCode: 1,
    errorMessage: message
  };
}

function isRetryableProviderSessionFailure(execution: ExecutionRecord): boolean {
  return execution.exitCode === 124 || /timed out|timeout/i.test(execution.errorMessage ?? "");
}
