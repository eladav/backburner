import type { NormalizedPullRequest } from "../domain/entities.js";
import {
  type ParentBranchSyncPreflight,
  type TaskRecord
} from "../tasks/types.js";
import {
  type ExecutionRecord,
  type PlanBreakdownResult,
  type WorkstreamPacket,
  type WorkstreamPacketPlan,
  type WorkstreamRecord,
  type WorktreeRecord
} from "../state/types.js";

export interface BuildPacketPlanInput {
  workstreamId: string;
  planBreakdown: PlanBreakdownResult;
  generatedAt?: string;
}


/**
 * Converts a PlanBreakdownResult into a WorkstreamPacketPlan.
 */
export function buildPacketPlanFromPlanBreakdown(
  input: BuildPacketPlanInput
): WorkstreamPacketPlan {
  const { workstreamId, planBreakdown, generatedAt } = input;

  const packets: Record<string, WorkstreamPacket> = {};
  const seenTaskIds = new Set<string>();

  for (const task of planBreakdown.tasks) {
    if (!task.id) {
      throw new Error("Task ID must not be empty in plan breakdown");
    }
    if (seenTaskIds.has(task.id)) {
      throw new Error(`Duplicate task ID found in plan breakdown: ${task.id}`);
    }
    seenTaskIds.add(task.id);

    packets[task.id] = {
      id: task.id,
      title: task.title,
      summary: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      filesLikelyTouched: task.filesLikelyInvolved,
      dependsOn: task.dependsOn,
      canRunInParallelWith: task.canRunInParallelWith,
      blocks: task.blocks,
      status: "planned"
    };
  }

  const waves = planBreakdown.waves.map((wave) => wave.taskIds);

  const packetPlan: WorkstreamPacketPlan = {
    status: "proposed",
    packets,
    waves,
    currentWaveIndex: 0,
    source: {
      kind: "plan_breakdown_result",
      workstreamId,
      generatedAt
    }
  };

  const errors = validatePacketPlan(packetPlan);
  if (errors.length > 0) {
    throw new Error(`Invalid packet plan: ${errors.join("; ")}`);
  }

  return packetPlan;
}

/**
 * Validates a WorkstreamPacketPlan for consistency.
 */
export function validatePacketPlan(packetPlan: WorkstreamPacketPlan): string[] {
  const errors: string[] = [];
  const packetIds = new Set(Object.keys(packetPlan.packets));

  // 1. Every packet ID must be non-empty and unique.
  // (Unique is guaranteed by Record keys, but we check if each packet.id matches the key)
  for (const [id, packet] of Object.entries(packetPlan.packets)) {
    if (!id) {
      errors.push("Packet ID must not be empty");
    }
    if (packet.id !== id) {
      errors.push(`Packet ID mismatch: dictionary key "${id}" does not match packet.id "${packet.id}"`);
    }
  }

  // 2. waves must be a non-empty array.
  if (!Array.isArray(packetPlan.waves) || packetPlan.waves.length === 0) {
    errors.push("Waves must be a non-empty array");
  } else {
    const seenInWaves = new Set<string>();

    packetPlan.waves.forEach((wave, waveIndex) => {
      // 3. Each wave must be a non-empty array.
      if (!Array.isArray(wave) || wave.length === 0) {
        errors.push(`Wave ${waveIndex} must be a non-empty array`);
        return;
      }

      wave.forEach((packetId) => {
        // 4. Every packet ID referenced by a wave must exist in packets.
        if (!packetIds.has(packetId)) {
          errors.push(`Wave ${waveIndex} references unknown packet ID: "${packetId}"`);
        }

        // 5. A packet ID must appear in exactly one wave.
        if (seenInWaves.has(packetId)) {
          errors.push(`Packet ID "${packetId}" appears in more than one wave`);
        }
        seenInWaves.add(packetId);
      });
    });

    // 6. Every packet in packets must appear in exactly one wave.
    for (const id of packetIds) {
      if (!seenInWaves.has(id)) {
        errors.push(`Packet ID "${id}" is missing from all waves`);
      }
    }
  }

  // Validation for dependencies and other references
  for (const packet of Object.values(packetPlan.packets)) {
    const checkRefs = (refs: string[], type: string) => {
      const seenRefs = new Set<string>();
      for (const ref of refs) {
        // 7. A packet must not depend on itself.
        if (ref === packet.id) {
          errors.push(`Packet "${packet.id}" has a self-reference in ${type}`);
        }
        // 8. dependsOn, blocks, and canRunInParallelWith references must point to existing packet IDs.
        if (!packetIds.has(ref)) {
          errors.push(`Packet "${packet.id}" references unknown packet ID "${ref}" in ${type}`);
        }
        // 10. Do not allow duplicate IDs inside dependsOn, blocks, or canRunInParallelWith.
        if (seenRefs.has(ref)) {
          errors.push(`Packet "${packet.id}" has duplicate reference "${ref}" in ${type}`);
        }
        seenRefs.add(ref);
      }
    };

    checkRefs(packet.dependsOn, "dependsOn");
    checkRefs(packet.blocks, "blocks");
    checkRefs(packet.canRunInParallelWith, "canRunInParallelWith");

    // 9. If packet A depends on packet B, B must appear in an earlier wave than A.
    // A wave is a dispatch batch; same-wave dependencies would let dependent
    // packets dispatch together.
    const waveOfA = packetPlan.waves.findIndex((wave) => wave.includes(packet.id));
    for (const depId of packet.dependsOn) {
      const waveOfB = packetPlan.waves.findIndex((wave) => wave.includes(depId));
      if (waveOfB !== -1 && waveOfA !== -1 && waveOfB === waveOfA) {
        errors.push(`Packet "${packet.id}" (wave ${waveOfA}) depends on "${depId}" in the same wave; dependent packets must be split into later waves`);
      } else if (waveOfB !== -1 && waveOfA !== -1 && waveOfB > waveOfA) {
        errors.push(`Packet "${packet.id}" (wave ${waveOfA}) depends on "${depId}" which is in a later wave (${waveOfB})`);
      }
    }
  }

  return errors;
}

/**
 * Updates a workstream list from completed plan_breakdown and wave_plan_replanning executions.
 */
export function applyPlanBreakdownResultsToWorkstreams(input: {
  workstreams: WorkstreamRecord[];
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
}): WorkstreamRecord[] {
  const { workstreams, tasks, executions } = input;

  // 1. Identify relevant executions
  const relevantExecutions = executions.filter(
    (e) =>
      isPacketPlanResultExecution(e) &&
      e.taskStatus === "completed" &&
      e.result?.planBreakdown
  );

  if (relevantExecutions.length === 0) {
    return workstreams;
  }

  // 2. Map executions to workstreams
  const latestExecutionPerWorkstream = new Map<string, ExecutionRecord>();

  for (const execution of relevantExecutions) {
    const task = tasks.find((t) => t.id === execution.taskId);
    if (!task) continue;
    if (execution.taskKind === "wave_plan_replanning" && task.status !== "completed") {
      continue;
    }

    const workstreamId = task.workstreamId;
    if (!workstreamId || !workstreams.some((ws) => ws.id === workstreamId)) {
      continue;
    }

    const existing = latestExecutionPerWorkstream.get(workstreamId);
    if (!existing || isExecutionNewer(execution, existing)) {
      latestExecutionPerWorkstream.set(workstreamId, execution);
    }
  }

  // 3. Apply to workstreams
  return workstreams.map((ws) => {
    const execution = latestExecutionPerWorkstream.get(ws.id);
    if (!execution || !execution.result?.planBreakdown) {
      return ws;
    }

    // Choose the latest valid plan-breakdown execution
    try {
      const newPacketPlan = buildPacketPlanFromPlanBreakdown({
        workstreamId: ws.id,
        planBreakdown: execution.result.planBreakdown,
        generatedAt: execution.endedAt
      });

      // Replace existing packetPlan only if the relevant execution is newer or there is no existing plan.
      // Replanning executions may replace older plans that lack generatedAt because they are explicit
      // orchestrator-owned plan revisions.
      if (shouldReplacePacketPlanFromExecution(ws, execution)) {
        const packetPlan = execution.taskKind === "wave_plan_replanning"
          ? {
              ...newPacketPlan,
              status: shouldPreserveReplannedPacketPlanStatus(ws.packetPlan?.status)
                ? ws.packetPlan!.status
                : newPacketPlan.status,
              waveAssessments: ws.packetPlan?.waveAssessments
            }
          : newPacketPlan;
        return {
          ...ws,
          packetPlan
        };
      }
    } catch (err) {
      // Preserve existing if conversion fails
      console.error(`Failed to apply plan breakdown result to workstream ${ws.id}:`, err);
    }

    return ws;
  });
}

function isPacketPlanResultExecution(execution: ExecutionRecord): boolean {
  return execution.taskKind === "plan_breakdown" || execution.taskKind === "wave_plan_replanning";
}

function shouldReplacePacketPlanFromExecution(workstream: WorkstreamRecord, execution: ExecutionRecord): boolean {
  if (!workstream.packetPlan) {
    return true;
  }

  const existingGeneratedAt = workstream.packetPlan.source?.generatedAt;
  if (execution.taskKind === "wave_plan_replanning") {
    return !existingGeneratedAt || isExecutionNewerThanGeneratedAt(execution.endedAt, existingGeneratedAt);
  }

  return Boolean(existingGeneratedAt && execution.endedAt > existingGeneratedAt);
}

function shouldPreserveReplannedPacketPlanStatus(status: WorkstreamPacketPlan["status"] | undefined): boolean {
  return status === "approved" || status === "in_progress";
}

function isExecutionNewerThanGeneratedAt(executionEndedAt: string, generatedAt: string): boolean {
  const executionTime = Date.parse(executionEndedAt);
  const generatedTime = Date.parse(generatedAt);
  if (Number.isFinite(executionTime) && Number.isFinite(generatedTime)) {
    return executionTime > generatedTime;
  }

  if (!Number.isFinite(generatedTime)) {
    return true;
  }

  return executionEndedAt > generatedAt;
}

/**
 * Returns the current wave index for a packet plan, defaulting to 0.
 */
export function getCurrentWaveIndex(packetPlan: WorkstreamPacketPlan): number {
  return packetPlan.currentWaveIndex ?? 0;
}

/**
 * Returns the packet IDs for the current wave.
 */
export function getCurrentWavePacketIds(packetPlan: WorkstreamPacketPlan): string[] {
  const waveIndex = getCurrentWaveIndex(packetPlan);
  if (waveIndex < 0 || waveIndex >= packetPlan.waves.length) {
    return [];
  }
  return packetPlan.waves[waveIndex] ?? [];
}

/**
 * Returns true when the current wave exists, is non-empty, and every packet
 * in that wave has been merged to the parent integration branch.
 */
export function isCurrentWaveComplete(packetPlan: WorkstreamPacketPlan): boolean {
  const waveIndex = getCurrentWaveIndex(packetPlan);
  if (waveIndex < 0 || waveIndex >= packetPlan.waves.length) {
    return false;
  }

  const currentWave = packetPlan.waves[waveIndex];
  if (!currentWave || currentWave.length === 0) {
    return false;
  }

  return currentWave.every((packetId) => {
    const packet = packetPlan.packets[packetId];
    return packet?.status === "merged_to_parent";
  });
}

/**
 * Returns true if the packet plan has at least one wave after the current wave.
 */
export function hasFutureWave(packetPlan: WorkstreamPacketPlan): boolean {
  const waveIndex = getCurrentWaveIndex(packetPlan);
  return waveIndex >= 0 && waveIndex < packetPlan.waves.length - 1;
}

export type PacketWaveAdvanceBlockedReason =
  | "no_packet_plan"
  | "invalid_current_wave_index"
  | "current_wave_incomplete"
  | "no_future_wave";

export interface PacketWaveAdvancePreview {
  canAdvance: boolean;
  blockedReason?: PacketWaveAdvanceBlockedReason;
  currentWaveIndex?: number;
  nextWaveIndex?: number;
  currentWavePacketIds: string[];
  completedCurrentWavePacketIds: string[];
  incompleteCurrentWavePacketIds: string[];
  nextWavePacketIds: string[];
  remainingFuturePacketIds: string[];
}

export type PacketWaveAdvanceResult =
  | {
      advanced: true;
      preview: PacketWaveAdvancePreview;
      packetPlan: WorkstreamPacketPlan;
    }
  | {
      advanced: false;
      preview: PacketWaveAdvancePreview;
      packetPlan?: WorkstreamPacketPlan | undefined;
    };

export type WorkstreamPacketWaveAdvanceResult =
  | {
      advanced: true;
      packetPlanResult: PacketWaveAdvanceResult;
      workstream: WorkstreamRecord;
    }
  | {
      advanced: false;
      packetPlanResult: PacketWaveAdvanceResult;
      workstream: WorkstreamRecord;
    };

/**
 * Previews what would happen if a packet-plan workstream advanced from its current wave
 * to the next wave. Returns a preview object detailing the state and blockages.
 */
export function buildPacketWaveAdvancePreview(input: {
  packetPlan?: WorkstreamPacketPlan | undefined;
}): PacketWaveAdvancePreview {
  const { packetPlan } = input;

  if (!packetPlan) {
    return {
      canAdvance: false,
      blockedReason: "no_packet_plan",
      currentWavePacketIds: [],
      completedCurrentWavePacketIds: [],
      incompleteCurrentWavePacketIds: [],
      nextWavePacketIds: [],
      remainingFuturePacketIds: []
    };
  }

  const currentWaveIndex = getCurrentWaveIndex(packetPlan);
  const nextWaveIndex = currentWaveIndex + 1;
  const currentWave = packetPlan.waves[currentWaveIndex];

  if (
    currentWaveIndex < 0 ||
    currentWaveIndex >= packetPlan.waves.length ||
    !currentWave ||
    currentWave.length === 0
  ) {
    return {
      canAdvance: false,
      blockedReason: "invalid_current_wave_index",
      currentWaveIndex,
      nextWaveIndex,
      currentWavePacketIds: [],
      completedCurrentWavePacketIds: [],
      incompleteCurrentWavePacketIds: [],
      nextWavePacketIds: [],
      remainingFuturePacketIds: []
    };
  }

  const currentWavePacketIds = [...currentWave];
  const completedCurrentWavePacketIds = currentWavePacketIds.filter(
    (packetId) => packetPlan.packets[packetId]?.status === "merged_to_parent"
  );
  const incompleteCurrentWavePacketIds = currentWavePacketIds.filter(
    (packetId) => packetPlan.packets[packetId]?.status !== "merged_to_parent"
  );
  const nextWavePacketIds = [...(packetPlan.waves[nextWaveIndex] ?? [])];
  const remainingFuturePacketIds = packetPlan.waves.slice(nextWaveIndex + 1).flat();

  if (!isCurrentWaveComplete(packetPlan)) {
    return {
      canAdvance: false,
      blockedReason: "current_wave_incomplete",
      currentWaveIndex,
      nextWaveIndex,
      currentWavePacketIds,
      completedCurrentWavePacketIds,
      incompleteCurrentWavePacketIds,
      nextWavePacketIds,
      remainingFuturePacketIds
    };
  }

  if (!hasFutureWave(packetPlan)) {
    return {
      canAdvance: false,
      blockedReason: "no_future_wave",
      currentWaveIndex,
      nextWaveIndex,
      currentWavePacketIds,
      completedCurrentWavePacketIds,
      incompleteCurrentWavePacketIds,
      nextWavePacketIds,
      remainingFuturePacketIds
    };
  }

  return {
    canAdvance: true,
    currentWaveIndex,
    nextWaveIndex,
    currentWavePacketIds,
    completedCurrentWavePacketIds,
    incompleteCurrentWavePacketIds,
    nextWavePacketIds,
    remainingFuturePacketIds
  };
}

/**
 * Advances a packet plan to the next wave if the current wave is complete
 * and a future wave exists. Returns a result object indicating success or failure.
 */
export function advancePacketPlanToNextWave(input: {
  packetPlan?: WorkstreamPacketPlan | undefined;
}): PacketWaveAdvanceResult {
  const preview = buildPacketWaveAdvancePreview(input);

  if (!preview.canAdvance || preview.nextWaveIndex === undefined || !input.packetPlan) {
    return {
      advanced: false,
      preview,
      packetPlan: input.packetPlan
    };
  }

  return {
    advanced: true,
    preview,
    packetPlan: {
      ...input.packetPlan,
      currentWaveIndex: preview.nextWaveIndex
    }
  };
}

/**
 * Advances a workstream's packet plan to the next wave if the current wave is complete
 * and a future wave exists. Returns a result object indicating success or failure,
 * along with the (potentially updated) workstream.
 */
export function advanceWorkstreamPacketPlanToNextWave(
  workstream: WorkstreamRecord
): WorkstreamPacketWaveAdvanceResult {
  const packetPlanResult = advancePacketPlanToNextWave({
    packetPlan: workstream.packetPlan
  });

  if (!packetPlanResult.advanced) {
    return {
      advanced: false,
      packetPlanResult,
      workstream
    };
  }

  return {
    advanced: true,
    packetPlanResult,
    workstream: {
      ...workstream,
      packetPlan: packetPlanResult.packetPlan
    }
  };
}

export interface AdvanceReadyWorkstreamPacketWavesInput {
  workstreams: Record<string, WorkstreamRecord>;
  readyWorkstreamIds: Iterable<string>;
}

export type WorkstreamPacketWaveAdvanceSkipReason = "not_ready";

export interface WorkstreamPacketWaveAdvanceAppliedItem {
  workstreamId: string;
  fromWaveIndex: number;
  toWaveIndex: number;
  nextWavePacketIds: string[];
  result: WorkstreamPacketWaveAdvanceResult;
}

export interface WorkstreamPacketWaveAdvanceBlockedItem {
  workstreamId: string;
  reason: PacketWaveAdvanceBlockedReason;
  result: WorkstreamPacketWaveAdvanceResult;
}

export interface WorkstreamPacketWaveAdvanceSkippedItem {
  workstreamId: string;
  reason: WorkstreamPacketWaveAdvanceSkipReason;
}

export interface AdvanceReadyWorkstreamPacketWavesResult {
  workstreams: Record<string, WorkstreamRecord>;
  advanced: WorkstreamPacketWaveAdvanceAppliedItem[];
  blocked: WorkstreamPacketWaveAdvanceBlockedItem[];
  skipped: WorkstreamPacketWaveAdvanceSkippedItem[];
}

/**
 * Advances packet waves for workstreams that are explicitly marked as ready.
 * Returns a new collection of workstreams and lists of advanced, blocked, and skipped items.
 */
export function advanceReadyWorkstreamPacketWaves(
  input: AdvanceReadyWorkstreamPacketWavesInput
): AdvanceReadyWorkstreamPacketWavesResult {
  const readyIds = new Set(input.readyWorkstreamIds);
  const workstreams: Record<string, WorkstreamRecord> = {};
  const advanced: WorkstreamPacketWaveAdvanceAppliedItem[] = [];
  const blocked: WorkstreamPacketWaveAdvanceBlockedItem[] = [];
  const skipped: WorkstreamPacketWaveAdvanceSkippedItem[] = [];

  for (const [workstreamId, workstream] of Object.entries(input.workstreams)) {
    if (!readyIds.has(workstreamId)) {
      workstreams[workstreamId] = workstream;
      skipped.push({ workstreamId, reason: "not_ready" });
      continue;
    }

    const result = advanceWorkstreamPacketPlanToNextWave(workstream);

    if (!result.advanced) {
      workstreams[workstreamId] = workstream;
      blocked.push({
        workstreamId,
        reason: result.packetPlanResult.preview.blockedReason ?? "current_wave_incomplete",
        result
      });
      continue;
    }

    workstreams[workstreamId] = result.workstream;
    advanced.push({
      workstreamId,
      fromWaveIndex: result.packetPlanResult.preview.currentWaveIndex ?? 0,
      toWaveIndex: result.packetPlanResult.preview.nextWaveIndex ?? 0,
      nextWavePacketIds: result.packetPlanResult.preview.nextWavePacketIds,
      result
    });
  }

  return { workstreams, advanced, blocked, skipped };
}

/**
 * Returns true when the current wave is complete and at least one future wave exists.
 */
export function isParentSyncNeededBeforeNextWave(packetPlan: WorkstreamPacketPlan): boolean {
  return isCurrentWaveComplete(packetPlan) && hasFutureWave(packetPlan);
}

/**
 * Builds a preflight object for parent branch synchronization when a wave is complete
 * and future waves remain.
 */
export function buildParentBranchSyncPreflight(input: {
  workstream: WorkstreamRecord;
  defaultBranch?: string | undefined;
}): ParentBranchSyncPreflight | undefined {
  const { workstream, defaultBranch } = input;
  const { packetPlan } = workstream;

  if (!packetPlan) {
    return undefined;
  }

  if (!isParentSyncNeededBeforeNextWave(packetPlan)) {
    return undefined;
  }

  const parentIntegrationBranch = workstream.integration?.branchName;
  if (!parentIntegrationBranch) {
    return undefined;
  }

  if (!defaultBranch) {
    return undefined;
  }

  const currentWaveIndex = getCurrentWaveIndex(packetPlan);
  const currentWave = packetPlan.waves[currentWaveIndex];
  if (!currentWave || currentWave.length === 0) {
    return undefined;
  }

  const nextWaveIndex = currentWaveIndex + 1;
  const completedPacketIds = [...currentWave];
  const pendingFuturePacketIds = packetPlan.waves.slice(nextWaveIndex).flat();

  const preflight: ParentBranchSyncPreflight = {
    workstreamId: workstream.id,
    repoKey: workstream.repoKey,
    parentIntegrationBranch,
    defaultBranch,
    planRevision: resolvePacketPlanRevision(packetPlan),
    currentWaveIndex,
    nextWaveIndex,
    completedPacketIds,
    pendingFuturePacketIds,
    planNodeIds: Object.keys(packetPlan.packets).sort()
  };

  if (workstream.integration?.prNumber !== undefined) {
    preflight.parentPrNumber = workstream.integration.prNumber;
  }

  return preflight;
}

function resolvePacketPlanRevision(packetPlan: WorkstreamPacketPlan): string {
  return (
    packetPlan.source?.generatedAt ??
    packetPlan.updatedAt ??
    `${getCurrentWaveIndex(packetPlan)}:${Object.keys(packetPlan.packets).sort().join(",")}`
  );
}

/**
 * Returns the packets in the current wave that are still in "planned" status
 * and do not have a branch name or PR number.
 */
export function getUndispatchedCurrentWavePackets(
  packetPlan: WorkstreamPacketPlan
): WorkstreamPacket[] {
  const packetIds = getCurrentWavePacketIds(packetPlan);
  const undispatched: WorkstreamPacket[] = [];

  for (const id of packetIds) {
    const packet = packetPlan.packets[id];
    if (
      packet &&
      packet.status === "planned" &&
      !packet.branchName &&
      !packet.prNumber
    ) {
      undispatched.push(packet);
    }
  }

  return undispatched;
}

/**
 * Marks a packet as having an open PR, returning a new packet plan.
 */
export function markPacketPlanningPrOpen(input: {
  packetPlan: WorkstreamPacketPlan;
  packetId: string;
  branchName: string;
  prNumber: number;
  updatedAt?: string;
}): WorkstreamPacketPlan {
  const { packetPlan, packetId, branchName, prNumber, updatedAt } = input;
  const packet = packetPlan.packets[packetId];

  if (!packet) {
    return packetPlan;
  }

  const updatedPacket: WorkstreamPacket = {
    ...packet,
    status: "pr_open",
    branchName,
    prNumber
  };

  const finalUpdatedAt = updatedAt ?? packet.updatedAt;
  if (finalUpdatedAt) {
    updatedPacket.updatedAt = finalUpdatedAt;
  }

  return {
    ...packetPlan,
    packets: {
      ...packetPlan.packets,
      [packetId]: updatedPacket
    }
  };
}

/**
 * Marks packet plan entries as merged when their corresponding packet PR has merged into the parent integration branch.
 */
export function markMergedPacketPullRequests(input: {
  packetPlan: WorkstreamPacketPlan;
  parentWorkstreamId: string;
  parentIntegrationBranch?: string | undefined;
  repoId: string;
  packetWorktrees: WorktreeRecord[];
  pullRequests: NormalizedPullRequest[];
  updatedAt?: string;
}): WorkstreamPacketPlan {
  const {
    packetPlan,
    parentWorkstreamId,
    parentIntegrationBranch,
    repoId,
    packetWorktrees,
    pullRequests,
    updatedAt
  } = input;

  const relevantWorktrees = packetWorktrees.filter(
    (wt) =>
      wt.packet &&
      wt.repoId === repoId &&
      wt.packet.parentWorkstreamId === parentWorkstreamId &&
      packetPlan.packets[wt.packet.packetId]
  );

  if (relevantWorktrees.length === 0) {
    return packetPlan;
  }

  const updatedPackets: Record<string, WorkstreamPacket> = { ...packetPlan.packets };
  let changed = false;

  for (const worktree of relevantWorktrees) {
    const packetId = worktree.packet!.packetId;
    const packet = packetPlan.packets[packetId]!;

    if (packet.status === "merged_to_parent") {
      continue;
    }

    const expectedIntegrationBranch = worktree.packet!.parentIntegrationBranch || parentIntegrationBranch;
    if (!expectedIntegrationBranch) {
      continue;
    }

    // Match a PR in the same repo by prNumber first, then branchName
    let matchedPr = worktree.prNumber !== undefined
      ? pullRequests.find((pr) => pr.repoId === repoId && pr.number === worktree.prNumber)
      : undefined;

    if (!matchedPr) {
      matchedPr = pullRequests.find(
        (pr) => pr.repoId === repoId && pr.headBranch === worktree.branchName
      );
    }

    if (
      matchedPr &&
      matchedPr.state === "merged" &&
      matchedPr.baseBranch === expectedIntegrationBranch
    ) {
      const updatedPacket: WorkstreamPacket = {
        ...packet,
        status: "merged_to_parent"
      };

      if (updatedAt) {
        updatedPacket.updatedAt = updatedAt;
      }

      // Sync metadata with the matched PR
      updatedPacket.prNumber = matchedPr.number;
      updatedPacket.branchName = matchedPr.headBranch;

      updatedPackets[packetId] = updatedPacket;
      changed = true;
    }
  }

  if (!changed) {
    return packetPlan;
  }

  return {
    ...packetPlan,
    packets: updatedPackets
  };
}

export function hasGeneratedPlanBreakdown(workstream: WorkstreamRecord | undefined): boolean {
  return workstream?.packetPlan?.source?.kind === "plan_breakdown_result";
}

function isExecutionNewer(a: ExecutionRecord, b: ExecutionRecord): boolean {
  if (a.endedAt > b.endedAt) return true;
  if (a.endedAt < b.endedAt) return false;
  return a.id > b.id;
}
