import type {
  WorkstreamRecord,
  WorkstreamMcpBlocker,
  WorkstreamMcpScopedExclusion,
  McpStatusRecord,
  WorktreeRecord
} from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import type {
  BlockedCapability,
  CapabilityValidationResult,
  RequiredCapabilityEvaluationResult
} from "../capabilities/types.js";
import { getRequiredCapabilityNames } from "../workflows/registry.js";
import { validateCapabilities } from "../capabilities/validator.js";
import type { NormalizedCapabilities, McpDependency } from "../config/types.js";

/**
 * Upserts an MCP blocker on a workstream for a specific task and capability.
 */
export function upsertMcpBlocker(
  workstream: WorkstreamRecord,
  task: TaskRecord,
  blockedCapability: BlockedCapability,
  mcpStatus: McpStatusRecord,
  packetId: string | undefined,
  now: string
): WorkstreamRecord {
  const blockerId = `mcp-blocker:${workstream.id}:${blockedCapability.uses}:${task.id}`;
  const existingBlockers = workstream.mcpBlockers ?? [];
  const index = existingBlockers.findIndex((b) => b.id === blockerId);

  let updatedBlockers: WorkstreamMcpBlocker[];

  if (index !== -1) {
    const existing = existingBlockers[index]!;
    const unionNames = Array.from(
      new Set([...existing.affectedCapabilityNames, blockedCapability.name])
    );
    const updatedBlocker: WorkstreamMcpBlocker = {
      ...existing,
      affectedCapabilityNames: unionNames,
      safeReason: sanitizeMcpBlockerReason(existing.safeReason),
      updatedAt: now,
    };
    updatedBlockers = [
      ...existingBlockers.slice(0, index),
      updatedBlocker,
      ...existingBlockers.slice(index + 1)
    ];
  } else {
    const safeReason = sanitizeMcpBlockerReason(
      mcpStatus.actionRequired?.reason ??
      blockedCapability.message ??
      "MCP requires user authorization or configuration."
    );

    const newBlocker: WorkstreamMcpBlocker = {
      id: blockerId,
      kind: "mcp_action_required",
      mcpHandle: blockedCapability.uses,
      affectedCapabilityNames: [blockedCapability.name],
      safeReason,
      blockedTaskKind: task.kind,
      blockedTaskId: task.id,
      packetId,
      createdAt: now,
      updatedAt: now,
      surfacedAt: undefined,
      resolutionState: "waiting_for_user"
    };
    updatedBlockers = [...existingBlockers, newBlocker];
  }

  return {
    ...workstream,
    mcpBlockers: updatedBlockers
  };
}

function sanitizeMcpBlockerReason(value: string): string {
  const sanitized = value
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 300)
    .trim();
  return sanitized || "MCP requires user authorization or configuration.";
}

/**
 * Removes the blocker with the given ID from the workstream's blockers entirely.
 */
export function clearMcpBlocker(
  workstream: WorkstreamRecord,
  blockerId: string,
  _now?: string
): WorkstreamRecord {
  const existingBlockers = workstream.mcpBlockers ?? [];
  const index = existingBlockers.findIndex((b) => b.id === blockerId);
  if (index === -1) {
    return workstream;
  }
  const updatedBlockers = [
    ...existingBlockers.slice(0, index),
    ...existingBlockers.slice(index + 1)
  ];
  return {
    ...workstream,
    mcpBlockers: updatedBlockers
  };
}

/**
 * Creates/updates a skip exclusion on the workstream and clears the matching blocker.
 */
export function applyMcpSkipExclusion(
  workstream: WorkstreamRecord,
  taskId: string,
  taskKind: TaskRecord["kind"],
  packetId: string | undefined,
  mcpHandle: string,
  affectedCapabilityNames: string[],
  now: string
): WorkstreamRecord {
  const exclusionId = `mcp-exclusion:${workstream.id}:${mcpHandle}:${taskId}`;
  const existingExclusions = workstream.mcpSkipExclusions ?? [];
  const index = existingExclusions.findIndex((e) => e.id === exclusionId);

  let updatedExclusions: WorkstreamMcpScopedExclusion[];

  if (index !== -1) {
    const existing = existingExclusions[index]!;
    const unionNames = Array.from(
      new Set([...existing.affectedCapabilityNames, ...affectedCapabilityNames])
    );
    const updatedExclusion: WorkstreamMcpScopedExclusion = {
      ...existing,
      affectedCapabilityNames: unionNames
    };
    updatedExclusions = [
      ...existingExclusions.slice(0, index),
      updatedExclusion,
      ...existingExclusions.slice(index + 1)
    ];
  } else {
    const newExclusion: WorkstreamMcpScopedExclusion = {
      id: exclusionId,
      taskId,
      taskKind,
      packetId,
      mcpHandle,
      affectedCapabilityNames,
      createdAt: now
    };
    updatedExclusions = [...existingExclusions, newExclusion];
  }

  const resultWorkstream = {
    ...workstream,
    mcpSkipExclusions: updatedExclusions
  };

  const blockerId = `mcp-blocker:${workstream.id}:${mcpHandle}:${taskId}`;
  return clearMcpBlocker(resultWorkstream, blockerId, now);
}

/**
 * Returns true if the task is actively blocked by any blocker on the workstream.
 */
export function isTaskActivelyBlocked(
  workstream: WorkstreamRecord,
  taskId: string
): boolean {
  const blockers = workstream.mcpBlockers ?? [];
  return blockers.some(
    (b) => b.blockedTaskId === taskId && b.resolutionState === "waiting_for_user"
  );
}

/**
 * Reconciles workstream blockers with current MCP statuses, clearing blockers
 * for MCPs that are now "ready".
 */
export function reconcileBlockersWithMcpStatuses(
  workstream: WorkstreamRecord,
  mcpStatuses: McpStatusRecord[],
  now: string
): { workstream: WorkstreamRecord; cleared: WorkstreamMcpBlocker[] } {
  const blockers = workstream.mcpBlockers ?? [];
  const cleared: WorkstreamMcpBlocker[] = [];
  let currentWorkstream = workstream;

  for (const blocker of blockers) {
    if (blocker.resolutionState === "waiting_for_user") {
      const statusRecord = mcpStatuses.find((s) => s.handle === blocker.mcpHandle);
      if (statusRecord && statusRecord.status === "ready") {
        cleared.push(blocker);
        currentWorkstream = clearMcpBlocker(currentWorkstream, blocker.id, now);
      }
    }
  }

  return {
    workstream: currentWorkstream,
    cleared
  };
}

/**
 * Filters the blockers on a workstream that have not yet been surfaced to the user.
 */
export function getUnsurfacedBlockers(
  workstream: WorkstreamRecord
): WorkstreamMcpBlocker[] {
  return (workstream.mcpBlockers ?? []).filter((b) => b.surfacedAt === undefined);
}

export function markMcpBlockersSurfaced(
  workstream: WorkstreamRecord,
  blockerIds: ReadonlySet<string>,
  surfacedAt: string
): WorkstreamRecord {
  if (blockerIds.size === 0) {
    return workstream;
  }

  const blockers = workstream.mcpBlockers ?? [];
  let changed = false;
  const updatedBlockers = blockers.map((blocker) => {
    if (!blockerIds.has(blocker.id) || blocker.surfacedAt !== undefined) {
      return blocker;
    }
    changed = true;
    return {
      ...blocker,
      surfacedAt,
      updatedAt: surfacedAt
    };
  });

  return changed
    ? {
      ...workstream,
      mcpBlockers: updatedBlockers
    }
    : workstream;
}

/**
 * Filters skip exclusions on a workstream applicable to a specific task.
 */
export function getApplicableSkipExclusions(
  workstream: WorkstreamRecord,
  taskId: string
): WorkstreamMcpScopedExclusion[] {
  return (workstream.mcpSkipExclusions ?? []).filter((e) => e.taskId === taskId);
}

export function rehydrateTaskMcpSkipContexts(input: {
  tasks: TaskRecord[];
  workstreams: readonly WorkstreamRecord[];
}): { tasks: TaskRecord[]; changed: boolean } {
  const workstreamsById = new Map(input.workstreams.map((workstream) => [workstream.id, workstream]));
  let changed = false;

  const tasks = input.tasks.map((task) => {
    if (!task.workstreamId) {
      return task;
    }

    const workstream = workstreamsById.get(task.workstreamId);
    if (!workstream) {
      return task;
    }

    const applicableExclusions = (workstream.mcpSkipExclusions ?? []).filter((exclusion) =>
      exclusionMatchesTaskScope(exclusion, task)
    );
    if (applicableExclusions.length === 0) {
      return task;
    }

    const existingContexts = task.context.mcpSkipContexts ?? [];
    const contextsByHandle = new Map(existingContexts.map((context) => [context.mcpHandle, context]));
    let taskChanged = false;

    for (const exclusion of applicableExclusions) {
      const existing = contextsByHandle.get(exclusion.mcpHandle);
      if (!existing) {
        contextsByHandle.set(exclusion.mcpHandle, {
          mcpHandle: exclusion.mcpHandle,
          affectedCapabilityNames: [...exclusion.affectedCapabilityNames],
          skipReason: "User explicitly skipped MCP authorization for this task."
        });
        taskChanged = true;
        continue;
      }

      const mergedCapabilityNames = Array.from(
        new Set([...existing.affectedCapabilityNames, ...exclusion.affectedCapabilityNames])
      );
      if (mergedCapabilityNames.length !== existing.affectedCapabilityNames.length) {
        contextsByHandle.set(exclusion.mcpHandle, {
          ...existing,
          affectedCapabilityNames: mergedCapabilityNames
        });
        taskChanged = true;
      }
    }

    if (!taskChanged) {
      return task;
    }

    changed = true;
    return {
      ...task,
      context: {
        ...task.context,
        mcpSkipContexts: [...contextsByHandle.values()]
      }
    };
  });

  return { tasks, changed };
}

function exclusionMatchesTaskScope(
  exclusion: WorkstreamMcpScopedExclusion,
  task: TaskRecord
): boolean {
  if (exclusion.taskId !== task.id || exclusion.taskKind !== task.kind) {
    return false;
  }

  const taskPacketId = task.context.packetId;
  if (exclusion.packetId !== undefined || taskPacketId !== undefined) {
    return exclusion.packetId === taskPacketId;
  }

  return true;
}

/**
 * Evaluates pending tasks against blocked required capabilities, recording blockers
 * and preventing blocked tasks from dispatching.
 */
export function evaluateMcpDispatchGate(input: {
  tasks: TaskRecord[];
  worktrees: WorktreeRecord[];
  workstreams: WorkstreamRecord[];
  capabilityValidation: CapabilityValidationResult;
  mcpStatuses: McpStatusRecord[];
  now: string;
}): {
  tasksToDispatch: TaskRecord[];
  blockedTaskIds: Set<string>;
  workstreams: WorkstreamRecord[];
  workstreamsChanged: boolean;
  evaluations: RequiredCapabilityEvaluationResult[];
  clearedBlockers: WorkstreamMcpBlocker[];
} {
  const updatedWorkstreams: WorkstreamRecord[] = [];
  let workstreamsChanged = false;
  const clearedBlockers: WorkstreamMcpBlocker[] = [];

  // 1. First, reconcile blockers with the current MCP statuses
  for (const ws of input.workstreams) {
    const recon = reconcileBlockersWithMcpStatuses(ws, input.mcpStatuses, input.now);
    if (recon.workstream !== ws) {
      workstreamsChanged = true;
    }
    updatedWorkstreams.push(recon.workstream);
    clearedBlockers.push(...recon.cleared);
  }

  const blockedTaskIds = new Set<string>();
  const evaluations: RequiredCapabilityEvaluationResult[] = [];

  const workstreamMap = new Map<string, WorkstreamRecord>();
  for (const ws of updatedWorkstreams) {
    workstreamMap.set(ws.id, ws);
  }

  // 2. Check each task and block it if it requires a blocked capability
  for (const task of input.tasks) {
    if (task.status !== "pending") {
      continue;
    }

    const requiredNames = getRequiredCapabilityNames(task.kind);
    if (requiredNames.length === 0) {
      continue;
    }

    const candidateBlockedRequired = input.capabilityValidation.blocked.filter(
      (b) => requiredNames.includes(b.name) && b.reason === "mcp_action_required"
    );

    if (candidateBlockedRequired.length > 0) {
      const wsId = task.workstreamId;
      if (!wsId) {
        console.warn(`[evaluateMcpDispatchGate] Task ${task.id} has no workstreamId.`);
        continue;
      }
      let ws = workstreamMap.get(wsId);
      if (!ws) {
        console.warn(
          `[evaluateMcpDispatchGate] Workstream ${wsId} not found for task ${task.id}.`
        );
        continue;
      }

      const skippedCapabilityNames = new Set<string>([
        ...(task.context.mcpSkipContexts ?? []).flatMap((context) => context.affectedCapabilityNames),
        ...getApplicableSkipExclusions(ws, task.id).flatMap((exclusion) => exclusion.affectedCapabilityNames)
      ]);
      const blockedRequired = candidateBlockedRequired.filter(
        (blockedCapability) => !skippedCapabilityNames.has(blockedCapability.name)
      );
      if (blockedRequired.length === 0) {
        continue;
      }

      // Resolve packetId from worktrees using path and branchName
      let localPath: string | undefined = undefined;
      let branchName: string | undefined = undefined;

      if (task.kind !== "prepare_pr_for_merge") {
        localPath = task.context.localRepoPath;
        branchName = task.context.branchName;
      } else {
        const preflight = task.context.prepareForMerge;
        if (preflight) {
          localPath = preflight.persistentWorktreePath;
          branchName = preflight.headBranch;
        }
      }

      const matchingWorktree = input.worktrees.find(
        (wt) => wt.path === localPath && wt.branchName === branchName
      );
      const packetId = task.context.packetId ?? matchingWorktree?.packet?.packetId;

      for (const entry of blockedRequired) {
        const mcpStatusRecord = input.mcpStatuses.find((s) => s.handle === entry.uses);
        if (!mcpStatusRecord) {
          const fallbackStatus: McpStatusRecord = {
            handle: entry.uses,
            providerId: "smithery",
            providerMcpId: entry.uses,
            status: "error",
            lastCheckedAt: input.now
          };
          const nextWs = upsertMcpBlocker(ws, task, entry, fallbackStatus, packetId, input.now);
          if (nextWs !== ws) {
            workstreamsChanged = true;
            ws = nextWs;
            workstreamMap.set(wsId, ws);
          }
        } else {
          const nextWs = upsertMcpBlocker(ws, task, entry, mcpStatusRecord, packetId, input.now);
          if (nextWs !== ws) {
            workstreamsChanged = true;
            ws = nextWs;
            workstreamMap.set(wsId, ws);
          }
        }
      }

      blockedTaskIds.add(task.id);
      evaluations.push({
        taskId: task.id,
        taskKind: task.kind,
        blockedRequiredCapabilities: blockedRequired
      });
    }
  }

  const finalWorkstreams = input.workstreams.map((ws) => workstreamMap.get(ws.id) ?? ws);
  const tasksToDispatch = input.tasks.filter((t) => !blockedTaskIds.has(t.id));

  return {
    tasksToDispatch,
    blockedTaskIds,
    workstreams: finalWorkstreams,
    workstreamsChanged,
    evaluations,
    clearedBlockers
  };
}

/**
 * Classifies whether a task's failure is due to a required capability's MCP status transitioning to action_required.
 * Returns the list of blocked required capabilities.
 */
export function classifyMidTaskMcpFailure(input: {
  task: TaskRecord;
  capabilities: NormalizedCapabilities;
  declaredMcps: McpDependency[];
  refreshedMcpStatuses: McpStatusRecord[];
}): BlockedCapability[] {
  const requiredNames = getRequiredCapabilityNames(input.task.kind);
  if (requiredNames.length === 0) {
    return [];
  }

  const validation = validateCapabilities(input.capabilities, input.declaredMcps, input.refreshedMcpStatuses);
  const skippedCapabilityNames = new Set(
    (input.task.context.mcpSkipContexts ?? []).flatMap((context) => context.affectedCapabilityNames)
  );
  return validation.blocked.filter(
    (b) =>
      requiredNames.includes(b.name) &&
      b.reason === "mcp_action_required" &&
      !skippedCapabilityNames.has(b.name)
  );
}

/**
 * Resumes task execution from a mid-task MCP block when the blocker is cleared or skipped.
 * For each task in `tasks` with status === "failed":
 * - If there is a cleared blocker matching the task's ID, or
 * - If there is an applied skip exclusion matching the task's ID,
 * Transition task status to "pending", set context.recoveryNeeded = false,
 * and if skipped, append an entry to context.mcpSkipContexts.
 */
export function resumeMidTaskBlockedTasks(input: {
  tasks: TaskRecord[];
  clearedBlockers: WorkstreamMcpBlocker[];
  skipExclusionsAppliedThisCycle: WorkstreamMcpScopedExclusion[];
  now: string;
}): {
  tasks: TaskRecord[];
  resumedTaskIds: Set<string>;
} {
  const resumedTaskIds = new Set<string>();
  const updatedTasks = input.tasks.map((task) => {
    if (task.status !== "failed") {
      return task;
    }

    const matchedClearedBlockers = input.clearedBlockers.filter(
      (b) => b.blockedTaskId === task.id
    );
    const matchedSkipExclusions = input.skipExclusionsAppliedThisCycle.filter(
      (e) => e.taskId === task.id
    );

    if (matchedClearedBlockers.length === 0 && matchedSkipExclusions.length === 0) {
      return task;
    }

    resumedTaskIds.add(task.id);

    // If it's a skip case, we construct the skip contexts
    const mcpSkipContexts = [...(task.context.mcpSkipContexts ?? [])];
    for (const exclusion of matchedSkipExclusions) {
      const alreadyExists = mcpSkipContexts.some(
        (ctx) => ctx.mcpHandle === exclusion.mcpHandle
      );
      if (!alreadyExists) {
        mcpSkipContexts.push({
          mcpHandle: exclusion.mcpHandle,
          affectedCapabilityNames: exclusion.affectedCapabilityNames,
          skipReason: "User explicitly chose to skip this blocked MCP capability."
        });
      }
    }

    return {
      ...task,
      status: "pending" as const,
      context: {
        ...task.context,
        recoveryNeeded: false,
        ...(mcpSkipContexts.length > 0 ? { mcpSkipContexts } : {})
      },
      updatedAt: input.now
    };
  });

  return {
    tasks: updatedTasks,
    resumedTaskIds
  };
}
