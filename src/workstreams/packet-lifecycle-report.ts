import { PacketExecutionStatus, WorkstreamPacketPlan } from "../state/types.js";
import type { ParentBranchSyncPreflight } from "../tasks/types.js";
import type { BranchSyncComparison } from "../git/types.js";
import { recommendBranchSyncAction, type BranchSyncComparisonSkippedReason, type BranchSyncRecommendation } from "./branch-sync.js";

export interface PacketPrCreatedRunEvent {
  workstreamId: string;
  repoKey: string;
  parentPrNumber?: number | undefined;
  packetId: string;
  waveIndex: number;
  branchName: string;
  prNumber: number;
}

export interface PacketWaveAdvancedRunEvent {
  workstreamId: string;
  repoKey: string;
  parentPrNumber?: number | undefined;
  fromWaveIndex: number;
  toWaveIndex: number;
  completedPacketIds: string[];
  newlyCurrentPacketIds: string[];
}

export interface PacketWaveBlockedRunEvent {
  workstreamId: string;
  repoKey: string;
  parentPrNumber?: number | undefined;
  reason: string;
  currentWaveIndex?: number | undefined;
  incompletePacketIds: string[];
}

export interface PacketLifecyclePacketStatus {
  id: string;
  status: PacketExecutionStatus;
  branchName?: string | undefined;
  prNumber?: number | undefined;
}

export interface PacketLifecycleWaveStatus {
  index: number;
  state: "complete" | "current" | "future" | "waiting";
  packets: PacketLifecyclePacketStatus[];
}

export interface PacketLifecycleBranchSyncPreflight {
  preflight: ParentBranchSyncPreflight;
  branchSyncComparison?: BranchSyncComparison | undefined;
  branchSyncComparisonSkippedReason?: BranchSyncComparisonSkippedReason | undefined;
}

export interface PacketLifecycleWorkstreamReport {
  workstreamId: string;
  repoKey: string;
  parentPrNumber?: number | undefined;
  currentWaveIndex?: number | undefined;
  waveCount: number;
  waves: PacketLifecycleWaveStatus[];
  packetPrsCreatedThisRun: PacketPrCreatedRunEvent[];
  waveAdvancementsThisRun: PacketWaveAdvancedRunEvent[];
  blockedThisRun: PacketWaveBlockedRunEvent[];
  nextExpectedAction: string;
  parentBranchSyncPreflight?: PacketLifecycleBranchSyncPreflight | undefined;
  agentSyncParentBranchLabel?: string | undefined;
}

export interface BuildLifecycleWorkstreamReportInput {
  workstream: {
    id: string;
    repoKey: string;
    integration?: { prNumber?: number | undefined };
    packetPlan?: WorkstreamPacketPlan;
  };
  packetPrsCreatedThisRun: PacketPrCreatedRunEvent[];
  waveAdvancementsThisRun: PacketWaveAdvancedRunEvent[];
  blockedThisRun: PacketWaveBlockedRunEvent[];
  parentBranchSyncPreflights?: PacketLifecycleBranchSyncPreflight[] | undefined;
  agentSyncParentBranchLabel?: string | undefined;
}

function getNextExpectedAction(
  waves: PacketLifecycleWaveStatus[],
  currentWaveIndex: number | undefined,
  isBranchSyncReady: boolean
): string {
  if (currentWaveIndex === undefined) {
    return "complete or verify final parent PR state";
  }

  const currentWave = waves.find((w) => w.index === currentWaveIndex);
  if (!currentWave) {
    return "complete or verify final parent PR state";
  }

  const hasPlannedWithoutPr = currentWave.packets.some((p) => p.status === "planned" && !p.prNumber);
  if (hasPlannedWithoutPr) {
    return "run orchestrator again to create current-wave packet PRs";
  }

  const allComplete = currentWave.packets.every((p) => p.status === "merged_to_parent");
  if (!allComplete) {
    return "review/merge current-wave packet PRs";
  }

  const isFinalWave = currentWaveIndex === waves.length - 1;
  if (isFinalWave) {
    return "complete or verify final parent PR state";
  }

  if (!isBranchSyncReady) {
    return "follow branch sync recommendation";
  }

  return "Review/merge current-wave packet PRs. After all current-wave packets are merged to parent and parent branch sync is ready, the next run will advance.";
}

export function buildPacketLifecycleWorkstreamReport(input: BuildLifecycleWorkstreamReportInput): PacketLifecycleWorkstreamReport | undefined {
  const { workstream, packetPrsCreatedThisRun, waveAdvancementsThisRun, blockedThisRun, parentBranchSyncPreflights, agentSyncParentBranchLabel } = input;
  const { packetPlan, id: workstreamId, repoKey } = workstream;

  if (!packetPlan) {
    return undefined;
  }

  const parentPrNumber = workstream.integration?.prNumber;

  const waves: PacketLifecycleWaveStatus[] = packetPlan.waves.map((packetIds, index) => {
    let state: "complete" | "current" | "future" | "waiting" = "waiting";
    if (packetPlan.currentWaveIndex === undefined) {
      state = "complete";
    } else if (index < packetPlan.currentWaveIndex) {
      const allMerged = packetIds.every((id) => packetPlan.packets[id]?.status === "merged_to_parent");
      state = allMerged ? "complete" : "waiting";
    } else if (index === packetPlan.currentWaveIndex) {
      state = "current";
    } else if (index > packetPlan.currentWaveIndex) {
      state = "future";
    }

    const packets = packetIds.map((id) => {
      const p = packetPlan.packets[id];
      return {
        id,
        status: p?.status ?? "planned",
        branchName: p?.branchName,
        prNumber: p?.prNumber
      } as PacketLifecyclePacketStatus;
    });

    return { index, state, packets };
  });

  const matchingPreflight = parentBranchSyncPreflights?.find(p => p.preflight.workstreamId === workstreamId);
  const isBranchSyncReady = matchingPreflight
    ? recommendBranchSyncAction(matchingPreflight.branchSyncComparison, matchingPreflight.branchSyncComparisonSkippedReason) === "ready_to_advance"
    : false;

  const workstreamPrsCreated = packetPrsCreatedThisRun.filter(e => e.workstreamId === workstreamId);
  const workstreamAdvancements = waveAdvancementsThisRun.filter(e => e.workstreamId === workstreamId);
  const workstreamBlocked = blockedThisRun.filter(e => e.workstreamId === workstreamId);

  return {
    workstreamId,
    repoKey,
    parentPrNumber,
    currentWaveIndex: packetPlan.currentWaveIndex,
    waveCount: packetPlan.waves.length,
    waves,
    packetPrsCreatedThisRun: workstreamPrsCreated,
    waveAdvancementsThisRun: workstreamAdvancements,
    blockedThisRun: workstreamBlocked,
    nextExpectedAction: getNextExpectedAction(waves, packetPlan.currentWaveIndex, isBranchSyncReady),
    parentBranchSyncPreflight: matchingPreflight,
    agentSyncParentBranchLabel
  };
}

export function formatPacketLifecycleReport(report: PacketLifecycleWorkstreamReport): string {
  const parts: string[] = [];
  parts.push("## Multi-wave packet status\n");
  parts.push(`Workstream: ${report.workstreamId}`);
  if (report.parentPrNumber) {
    parts.push(`Parent PR: #${report.parentPrNumber}`);
  }

  if (report.currentWaveIndex !== undefined) {
    parts.push(`Current wave: ${report.currentWaveIndex} / ${report.waveCount}\n`);
  } else {
    parts.push(`Current wave: complete\n`);
  }

  for (const wave of report.waves) {
    parts.push(`Wave ${wave.index} - ${wave.state}`);
    for (const packet of wave.packets) {
      const prText = packet.prNumber ? `PR #${packet.prNumber}` : "no PR yet";
      parts.push(`- ${packet.id} - ${packet.status} - ${prText}`);
    }
    parts.push("");
  }

  const branchSyncSection = formatParentBranchSyncSection(report.parentBranchSyncPreflight, report.agentSyncParentBranchLabel);
  if (branchSyncSection) {
    parts.push(branchSyncSection);
  }

  if (report.waveAdvancementsThisRun.length > 0 || report.packetPrsCreatedThisRun.length > 0 || report.blockedThisRun.length > 0) {
    parts.push("This run:");
    for (const adv of report.waveAdvancementsThisRun) {
      parts.push(`- Advanced from wave ${adv.fromWaveIndex} to wave ${adv.toWaveIndex}.`);
      if (adv.newlyCurrentPacketIds.length > 0) {
        const newPrs = report.packetPrsCreatedThisRun.filter(p => adv.newlyCurrentPacketIds.includes(p.packetId));
        if (newPrs.length < adv.newlyCurrentPacketIds.length) {
          const deferredIds = adv.newlyCurrentPacketIds.filter(id => !newPrs.some(pr => pr.packetId === id));
          parts.push(`- Deferred packet PR creation for newly advanced packets until the next run: ${deferredIds.join(", ")}.`);
        }
      }
    }
    for (const pr of report.packetPrsCreatedThisRun) {
      parts.push(`- Created packet PR #${pr.prNumber} for ${pr.packetId}.`);
    }
    parts.push("");
  }

  if (report.blockedThisRun.length > 0) {
    parts.push("Blocked / waiting:");
    for (const blocked of report.blockedThisRun) {
      parts.push(`- ${blocked.reason}`);
    }
    parts.push("");
  }

  parts.push("Next expected action:");
  parts.push(`- ${report.nextExpectedAction}`);

  return parts.join("\n");
}

function formatParentBranchSyncSection(
  item: PacketLifecycleBranchSyncPreflight | undefined,
  syncLabel: string | undefined
): string | undefined {
  if (!item) {
    return undefined;
  }

  const { preflight, branchSyncComparison, branchSyncComparisonSkippedReason } = item;
  const parts: string[] = ["Parent branch sync:"];

  parts.push(`- Parent branch: \`${preflight.parentIntegrationBranch}\``);
  parts.push(`- Default branch: \`${preflight.defaultBranch}\``);

  const statusLine = formatBranchSyncStatus(branchSyncComparison, branchSyncComparisonSkippedReason);
  parts.push(`- Status: ${statusLine}`);

  const action = recommendBranchSyncAction(branchSyncComparison, branchSyncComparisonSkippedReason);
  const recommendation = formatBranchSyncRecommendation(
    action,
    syncLabel ?? "agent-sync-parent-branch"
  );
  parts.push(`- Recommendation: ${recommendation}`);

  const showLabel = action === "sync_parent_from_default" || action === "manual_conflict_aware_sync_required";
  if (syncLabel && showLabel) {
    parts.push(`- Action label: \`${syncLabel}\``);
  }

  parts.push("");
  return parts.join("\n");
}

function formatBranchSyncStatus(
  comparison: BranchSyncComparison | undefined,
  skippedReason?: BranchSyncComparisonSkippedReason
): string {
  if (skippedReason === "missing_local_path") {
    return "unavailable (missing local repository path)";
  }

  if (!comparison) {
    return "unknown";
  }

  let text = `\`${comparison.status}\``;
  if (comparison.parentAheadCount !== undefined && comparison.parentBehindCount !== undefined) {
    text += ` (behind ${comparison.parentBehindCount}, ahead ${comparison.parentAheadCount})`;
  }

  return text;
}

function formatBranchSyncRecommendation(
  action: BranchSyncRecommendation,
  syncLabel: string
): string {
  switch (action) {
    case "ready_to_advance":
      return "the parent branch is up to date with default and the next packet wave may advance on the next orchestration evaluation.";
    case "sync_parent_from_default":
      return `add \`${syncLabel}\` to the parent PR to authorize merging default into the parent branch. The orchestrator will perform the local git operation and push.`;
    case "manual_conflict_aware_sync_required":
      return `the parent and default branches have diverged. Adding \`${syncLabel}\` authorizes one conflict-aware merge attempt. If conflicts occur, they will be reported as blocked and manual resolution will be required.`;
    case "blocked_missing_ref":
      return "sync is blocked because required branch refs are missing. These must be diagnosed before sync can proceed.";
    case "blocked_unknown":
    default:
      return "parent branch sync status is unavailable or unknown and must be diagnosed before sync can proceed.";
  }
}

export function formatPacketLifecycleReportsForRunSummary(reports: PacketLifecycleWorkstreamReport[]): string {
  if (reports.length === 0) {
    return "";
  }

  // Sort reports by repoKey, then workstreamId
  const sortedReports = [...reports].sort((a, b) => {
    if (a.repoKey !== b.repoKey) return a.repoKey.localeCompare(b.repoKey);
    return a.workstreamId.localeCompare(b.workstreamId);
  });

  const parts = ["Multi-wave packet lifecycle:"];
  for (const report of sortedReports) {
    parts.push(formatPacketLifecycleReport(report));
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}
