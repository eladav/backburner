/**
 * Journal helper functions for run.ts.
 *
 * Extracted here to keep run.ts clean. Handles:
 *  - buildEntityMaps: builds lookup maps from scan data
 *  - resolveTaskJournalIds: resolves issueNumber/prNumber for a task
 *  - resolveRepoActionState: comprehensive no-action logic per repo
 *  - journalWorkstreamTransitions: journals workstream phase/attention/status changes
 *  - journalTaskTransitions: journals task status changes after dispatch
 *  - journalWorktreeTransitions: journals worktree status changes
 *  - journalNewExecutions: journals only newly-created executions
 *  - journalPacketWaveEvents: journals packet wave advancements and blocks
 */

import type { RepoConfig } from "../config/types.js";
import type { NormalizedIssue, NormalizedPullRequest } from "../domain/entities.js";
import type { ExecutionRecord, RepoSyncRecord, WorkstreamRecord, WorktreeRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import type { JournalService } from "../journal/index.js";
import type { PacketWaveAdvancedRunEvent, PacketWaveBlockedRunEvent } from "../workstreams/packet-lifecycle-report.js";

// ── Entity Maps ───────────────────────────────────────────────────────────────

export interface EntityMaps {
  issueIdToNumber: Map<string, number>;
  prIdToNumber: Map<string, number>;
  repoSlugToId: Map<string, string>;
}

export function buildEntityMaps(
  issues: NormalizedIssue[],
  prs: NormalizedPullRequest[],
  enabledRepos: RepoConfig[]
): EntityMaps {
  const issueIdToNumber = new Map<string, number>();
  for (const issue of issues) {
    issueIdToNumber.set(issue.id, issue.number);
  }

  const prIdToNumber = new Map<string, number>();
  for (const pr of prs) {
    prIdToNumber.set(pr.id, pr.number);
  }

  const repoSlugToId = new Map<string, string>();
  for (const repo of enabledRepos) {
    repoSlugToId.set(`${repo.owner}/${repo.name}`, repo.id);
    repoSlugToId.set(repo.id, repo.id); // fallback: repoKey stored as id resolves to itself
  }

  return { issueIdToNumber, prIdToNumber, repoSlugToId };
}

// ── Task Journal ID Resolution ────────────────────────────────────────────────

export interface TaskJournalIds {
  issueNumber?: number;
  prNumber?: number;
}

export function resolveTaskJournalIds(
  task: TaskRecord,
  maps: EntityMaps,
  workstreams?: WorkstreamRecord[]
): TaskJournalIds {
  let issueNumber: number | undefined;
  let prNumber: number | undefined;

  if (task.sourceKind === "issue") {
    issueNumber = maps.issueIdToNumber.get(task.sourceId);
  } else if (task.sourceKind === "pull_request") {
    prNumber = maps.prIdToNumber.get(task.sourceId);
  } else if (task.sourceKind === "comment") {
    if (task.parentSourceKind === "issue" && task.parentSourceId !== undefined) {
      issueNumber = maps.issueIdToNumber.get(task.parentSourceId);
    } else if (task.parentSourceKind === "pull_request" && task.parentSourceId !== undefined) {
      prNumber = maps.prIdToNumber.get(task.parentSourceId);
    }
  }

  // Also check workstream's activePrNumber if task belongs to one
  if (task.workstreamId && workstreams) {
    const ws = workstreams.find((w) => w.id === task.workstreamId);
    if (ws?.activePrNumber !== undefined && prNumber === undefined) {
      prNumber = ws.activePrNumber;
    }
  }

  return {
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(prNumber !== undefined ? { prNumber } : {})
  };
}

// ── No-Action Resolution ──────────────────────────────────────────────────────

export interface RepoActionState {
  hasAction: boolean;
  noActionReason?: string;
}

export interface ResolveRepoActionStateInput {
  repoId: string;
  repoSlug: string;
  syncRecord: RepoSyncRecord | undefined;
  tasks: TaskRecord[];
  workstreams: WorkstreamRecord[];
  issues: NormalizedIssue[];
  prs: NormalizedPullRequest[];
}

export function resolveRepoActionState(input: ResolveRepoActionStateInput): RepoActionState {
  const { repoId, repoSlug, syncRecord, tasks, workstreams, issues, prs } = input;

  // 1. Sync failed
  if (syncRecord?.status === "failed") {
    const reason = syncRecord.error?.message ?? syncRecord.message ?? "Unknown sync error";
    return { hasAction: false, noActionReason: `Repository failed to sync: ${reason}` };
  }

  // 2. Scan failed
  const scan = syncRecord?.githubScan;
  if (scan?.status === "failed") {
    return { hasAction: false, noActionReason: "GitHub scan failed — issue and PR data unavailable" };
  }

  // 3. Pending relevant tasks → has action
  const pendingRelevant = tasks.filter(
    (t) => t.repoId === repoId && t.status === "pending" && t.relevant
  );
  if (pendingRelevant.length > 0) {
    return { hasAction: true };
  }

  // 4. Dispatched tasks → has action
  const dispatched = tasks.filter(
    (t) => t.repoId === repoId && t.status === "dispatched"
  );
  if (dispatched.length > 0) {
    return { hasAction: true };
  }

  // Check workstreams for this repo
  const repoWorkstreams = workstreams.filter((ws) => {
    return ws.repoKey === repoSlug || ws.repoKey === repoId;
  });

  for (const ws of repoWorkstreams) {
    const wsTasks = tasks.filter((t) => t.workstreamId === ws.id);
    const hasFailedTasks = wsTasks.some((t) => t.status === "failed");
    const hasPendingOrDispatched = wsTasks.some(
      (t) => t.status === "pending" || t.status === "dispatched"
    );

    // 5. Workstream blocked by failed tasks
    if (hasFailedTasks && !hasPendingOrDispatched) {
      return { hasAction: false, noActionReason: "Workstream blocked by failed prior execution" };
    }

    // 6. Waiting for Product approval
    if (ws.phase === "product_discovery") {
      const approvalLabel = ws.product?.approvalLabel ?? "agent-product-approved";
      const num = ws.origin.number;
      return {
        hasAction: false,
        noActionReason: `Waiting for ${approvalLabel} label on issue #${num} to proceed`
      };
    }

    // 7. Waiting for plan approval
    if (ws.phase === "plan_feedback") {
      const num = ws.origin.number;
      const kind = ws.origin.type === "issue" ? "issue" : "PR";
      return {
        hasAction: false,
        noActionReason: `Waiting for plan approval (${kind} #${num})`
      };
    }

    // 8. Waiting for implementation feedback
    if (ws.phase === "implementation_feedback") {
      return { hasAction: false, noActionReason: "Waiting for implementation feedback" };
    }

    // 9. Waiting for PR review
    if (ws.phase === "pr_review") {
      return { hasAction: false, noActionReason: "Waiting for PR review" };
    }
  }

  // 10. No issues or PRs at all
  const repoIssues = issues.filter((i) => i.repoId === repoId);
  const repoPrs = prs.filter((p) => p.repoId === repoId);
  if (repoIssues.length === 0 && repoPrs.length === 0) {
    return { hasAction: false, noActionReason: "No open issues or PRs found for this repository" };
  }

  // 11. Default
  return { hasAction: false, noActionReason: "No open issues or PRs requiring attention this cycle" };
}

// ── Workstream Transitions ────────────────────────────────────────────────────

export async function journalWorkstreamTransitions(opts: {
  cycleId: string;
  previousWorkstreams: WorkstreamRecord[];
  currentWorkstreams: WorkstreamRecord[];
  journal: JournalService;
  entityMaps: EntityMaps;
}): Promise<void> {
  const { cycleId, previousWorkstreams, currentWorkstreams, journal, entityMaps } = opts;

  const prevById = new Map(previousWorkstreams.map((ws) => [ws.id, ws]));

  for (const ws of currentWorkstreams) {
    const prev = prevById.get(ws.id);
    if (!prev) continue; // new workstream, not a transition

    // Resolve repoId from repoKey (slug format "owner/name")
    const repoId = entityMaps.repoSlugToId.get(ws.repoKey);

    // Resolve issueNumber/prNumber from workstream origin
    let issueNumber: number | undefined;
    let prNumber: number | undefined;
    if (ws.origin.type === "issue") {
      issueNumber = ws.origin.number;
    } else {
      prNumber = ws.origin.number;
    }
    if (ws.activePrNumber !== undefined) {
      prNumber = ws.activePrNumber;
    }

    const commonOpts = {
      cycleId,
      scope: "workstream" as const,
      scopeId: ws.id,
      workstreamId: ws.id,
      ...(repoId !== undefined ? { repoId } : {}),
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      ...(prNumber !== undefined ? { prNumber } : {})
    };

    // Phase change
    if (prev.phase !== ws.phase) {
      await journal.recordStateTransition({
        ...commonOpts,
        from: prev.phase,
        to: ws.phase,
        trigger: "cycle",
        summary: `Workstream ${ws.id} phase: ${prev.phase} → ${ws.phase}`
      });
    }

    // Attention change
    if (prev.attention !== ws.attention) {
      await journal.recordStateTransition({
        ...commonOpts,
        from: prev.attention,
        to: ws.attention,
        trigger: "cycle",
        summary: `Workstream ${ws.id} attention: ${prev.attention} → ${ws.attention}`
      });
    }

    // Status change
    if (prev.status !== ws.status) {
      await journal.recordStateTransition({
        ...commonOpts,
        from: prev.status,
        to: ws.status,
        trigger: "cycle",
        summary: `Workstream ${ws.id} status: ${prev.status} → ${ws.status}`
      });
    }
  }
}

// ── Task Transitions ──────────────────────────────────────────────────────────

const MEANINGFUL_TRANSITIONS = new Set([
  "pending→dispatched",
  "pending→completed",
  "dispatched→completed",
  "dispatched→failed",
  "pending→failed",
  "pending→queued",
  "queued→dispatched",
  "queued→failed",
  "dispatched→queued",
  "queued→pending"
]);

export async function journalTaskTransitions(opts: {
  cycleId: string;
  tasksBefore: TaskRecord[];
  tasksAfter: TaskRecord[];
  journal: JournalService;
  entityMaps: EntityMaps;
  workstreams: WorkstreamRecord[];
}): Promise<void> {
  const { cycleId, tasksBefore, tasksAfter, journal, entityMaps, workstreams } = opts;

  const prevById = new Map(tasksBefore.map((t) => [t.id, t]));

  for (const task of tasksAfter) {
    const prev = prevById.get(task.id);
    if (!prev) continue;
    if (prev.status === task.status) continue;

    const transitionKey = `${prev.status}→${task.status}`;
    if (!MEANINGFUL_TRANSITIONS.has(transitionKey)) continue;

    const ids = resolveTaskJournalIds(task, entityMaps, workstreams);

    await journal.recordStateTransition({
      cycleId,
      scope: task.workstreamId ? "workstream" : "repo",
      scopeId: task.workstreamId ?? task.repoId,
      repoId: task.repoId,
      ...(task.workstreamId !== undefined ? { workstreamId: task.workstreamId } : {}),
      ...(ids.issueNumber !== undefined ? { issueNumber: ids.issueNumber } : {}),
      ...(ids.prNumber !== undefined ? { prNumber: ids.prNumber } : {}),
      from: prev.status,
      to: task.status,
      trigger: "dispatch",
      summary: `Task ${task.id} status: ${prev.status} → ${task.status}`,
      derivedState: { taskId: task.id, kind: task.kind, taskStatus: task.status }
    });
  }
}

// ── Worktree Transitions ──────────────────────────────────────────────────────

export async function journalWorktreeTransitions(opts: {
  cycleId: string;
  previousWorktrees: WorktreeRecord[];
  currentWorktrees: WorktreeRecord[];
  journal: JournalService;
}): Promise<void> {
  const { cycleId, previousWorktrees, currentWorktrees, journal } = opts;

  const prevById = new Map(previousWorktrees.map((wt) => [wt.id, wt]));

  for (const wt of currentWorktrees) {
    const prev = prevById.get(wt.id);
    if (!prev) continue;
    if (prev.status === wt.status) continue;

    const workstreamId = wt.packet?.parentWorkstreamId;
    await journal.recordStateTransition({
      cycleId,
      scope: "worktree",
      scopeId: wt.id,
      repoId: wt.repoId,
      ...(workstreamId !== undefined ? { workstreamId } : {}),
      ...(wt.issueNumber !== undefined ? { issueNumber: wt.issueNumber } : {}),
      ...(wt.prNumber !== undefined ? { prNumber: wt.prNumber } : {}),
      from: prev.status,
      to: wt.status,
      trigger: "cycle",
      summary: `Worktree ${wt.id} status: ${prev.status} → ${wt.status}`,
      derivedState: { worktreeId: wt.id, branchName: wt.branchName }
    });
  }
}

// ── Execution Journaling ──────────────────────────────────────────────────────

export async function journalNewExecutions(opts: {
  cycleId: string;
  executionIdsBeforeCycle: Set<string>;
  dispatchResult: { tasks: TaskRecord[]; executions: ExecutionRecord[] };
  journal: JournalService;
  entityMaps: EntityMaps;
  workstreams: WorkstreamRecord[];
}): Promise<void> {
  const { cycleId, executionIdsBeforeCycle, dispatchResult, journal, entityMaps, workstreams } = opts;

  const allNewExecutions = dispatchResult.executions.filter(
    (e) => !executionIdsBeforeCycle.has(e.id)
  );

  for (const exec of allNewExecutions) {
    const task = dispatchResult.tasks.find((t) => t.id === exec.taskId);
    if (!task) continue;

    if (task.status !== "completed" && task.status !== "failed") continue;
    if (task.lastExecutionId !== exec.id) continue;

    const ids = resolveTaskJournalIds(task, entityMaps, workstreams);

    await journal.write({
      cycleId,
      scope: "execution",
      scopeId: exec.id,
      repoId: task.repoId,
      ...(task.workstreamId !== undefined ? { workstreamId: task.workstreamId } : {}),
      executionId: exec.id,
      ...(ids.issueNumber !== undefined ? { issueNumber: ids.issueNumber } : {}),
      ...(ids.prNumber !== undefined ? { prNumber: ids.prNumber } : {}),
      category: task.status === "completed" ? "execution_completed" : "execution_failed",
      severity: task.status === "completed" ? "info" : "error",
      summary:
        task.status === "completed"
          ? `Completed ${task.kind} for ${task.repoSlug}`
          : `Failed ${task.kind} for ${task.repoSlug}`,
      observedState: {
        exitCode: exec.exitCode,
        startedAt: exec.startedAt,
        endedAt: exec.endedAt,
        agentProvider: exec.agentProvider,
        promptArtifactPath: exec.promptArtifactPath,
        stdoutArtifactPath: exec.stdoutArtifactPath,
        stderrArtifactPath: exec.stderrArtifactPath
      },
      derivedState: {
        taskId: task.id,
        taskKind: task.kind,
        taskStatus: task.status
      },
      ...(task.status === "failed"
        ? { noActionReason: exec.errorMessage ?? "Agent execution failed" }
        : {})
    });
  }
}

// ── Packet Wave Events ────────────────────────────────────────────────────────

export async function journalPacketWaveEvents(opts: {
  cycleId: string;
  packetWaveAdvancementsThisRun: PacketWaveAdvancedRunEvent[];
  packetWaveBlockedThisRun: PacketWaveBlockedRunEvent[];
  journal: JournalService;
}): Promise<void> {
  const { cycleId, packetWaveAdvancementsThisRun, packetWaveBlockedThisRun, journal } = opts;

  for (const adv of packetWaveAdvancementsThisRun) {
    await journal.recordStateTransition({
      cycleId,
      scope: "workstream",
      scopeId: adv.workstreamId,
      workstreamId: adv.workstreamId,
      ...(adv.parentPrNumber !== undefined ? { prNumber: adv.parentPrNumber } : {}),
      from: `wave:${adv.fromWaveIndex}`,
      to: `wave:${adv.toWaveIndex}`,
      trigger: "packet_wave_advancement",
      summary: `Packet wave advanced: wave ${adv.fromWaveIndex} → wave ${adv.toWaveIndex} for workstream ${adv.workstreamId}`,
      derivedState: {
        completedPacketIds: adv.completedPacketIds,
        newlyCurrentPacketIds: adv.newlyCurrentPacketIds
      }
    });
  }

  for (const blocked of packetWaveBlockedThisRun) {
    await journal.recordBlocked({
      cycleId,
      scope: "workstream",
      scopeId: blocked.workstreamId,
      workstreamId: blocked.workstreamId,
      ...(blocked.parentPrNumber !== undefined ? { prNumber: blocked.parentPrNumber } : {}),
      reason: `Packet wave blocked: ${blocked.reason}`,
      observedState: {
        currentWaveIndex: blocked.currentWaveIndex,
        incompletePacketIds: blocked.incompletePacketIds
      }
    });
  }
}
