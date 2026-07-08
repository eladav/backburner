import type { RepoScanFailure, RepoSyncRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import {
  recommendBranchSyncAction,
  type BranchSyncRecommendation
} from "../workstreams/branch-sync.js";
import {
  buildPacketLifecycleWorkstreamReport,
  formatPacketLifecycleReport
} from "../workstreams/packet-lifecycle-report.js";
import type { RunSummary } from "./run-types.js";

export function formatRunSummary(summary: RunSummary): string {
  const lines = [
    `Orchestrator run ${summary.failedRepoCount > 0 || summary.failedTaskCount > 0 ? "finished with failures" : "completed successfully"}.`,
    `Code root: ${summary.codeRoot}`,
    `Management dir: ${summary.managementDir}`,
    `Outputs dir: ${summary.outputsDir}`,
    `State dir: ${summary.stateDir}`,
    `Log dir: ${summary.logDir}`,
    `Time: ${summary.startedAt} -> ${summary.completedAt}`,
    `Repos: ${summary.repoCount} enabled, ${summary.syncedRepoCount} synced, ${summary.failedRepoCount} failed sync, ${summary.scannedRepoCount} scanned, ${summary.partiallyScannedRepoCount} partial scan, ${summary.failedScanRepoCount} failed scan`,
    `Entities: ${summary.issueCount} issues, ${summary.pullRequestCount} PRs, ${summary.commentCount} comments`,
    `Tasks: ${summary.taskCount} tracked, ${summary.pendingTaskCount} pending, ${summary.completedTaskCount} completed, ${summary.failedTaskCount} failed`,
    `Product discovery: ${summary.productDiscoveryCount ?? 0}`,
    `Product specification: ${summary.productSpecificationCount ?? 0}`,
    `Waiting for product approval: ${summary.waitingForProductApprovalCount ?? 0}`,
    `Executions: ${summary.executionCount}`,
    "",
    "GitOps:",
    `- Management: ${formatManagementGitOps(summary.managementGitOps)}`,
    `- Outputs: ${formatOutputsGitOps(summary.outputsGitOps)}`,
    "",
    "Repo results:"
  ];

  for (const result of summary.results) {
    lines.push(formatRepoResult(result));
  }

  if (summary.pullRequestBaseClassifications.length > 0) {
    lines.push("");
    lines.push("Pull request base classifications:");
    for (const classification of summary.pullRequestBaseClassifications) {
      if (classification.kind === "top_level") {
        lines.push(
          `- ${classification.repoSlug} PR #${classification.pullRequestNumber} targets default branch \`${classification.defaultBranch}\`.`
        );
      } else {
        lines.push(
          `- ${classification.repoSlug} PR #${classification.pullRequestNumber} targets non-default parent branch \`${classification.baseBranch}\`; repo default branch is \`${classification.defaultBranch}\`.`
        );
      }
    }
  }

  if (summary.packetPullRequestCandidates.length > 0) {
    lines.push("");
    lines.push("Packet PR candidates:");
    for (const candidate of summary.packetPullRequestCandidates) {
      if (candidate.status === "matched_parent_workstream") {
        lines.push(
          `- ${candidate.repoSlug} PR #${candidate.pullRequestNumber} targets parent branch \`${candidate.baseBranch}\` and is attached to workstream \`${candidate.parentWorkstreamId}\`.`
        );
      } else {
        lines.push(
          `- ${candidate.repoSlug} PR #${candidate.pullRequestNumber} targets non-default parent branch \`${candidate.baseBranch}\` but no active parent workstream was found.`
        );
      }
    }
  }

  if (summary.parentBranchSyncPreflights.length > 0) {
    lines.push("");
    lines.push("Parent branch sync preflights:");
    for (const item of summary.parentBranchSyncPreflights) {
      const preflight = item.preflight;
      const parentPr =
        preflight.parentPrNumber !== undefined ? `#${preflight.parentPrNumber}` : "unknown";
      lines.push(
        `- ${preflight.workstreamId}: sync \`${preflight.parentIntegrationBranch}\` from \`${preflight.defaultBranch}\` after wave ${preflight.currentWaveIndex} before wave ${preflight.nextWaveIndex}`
      );
      lines.push(`  status: ${formatBranchSyncComparison(item)}`);
      lines.push(`  recommendation: ${formatBranchSyncRecommendation(item)}`);
      lines.push(`  parent PR: ${parentPr}`);
      lines.push(`  completed packets: ${formatPacketIds(preflight.completedPacketIds)}`);
      lines.push(`  pending future packets: ${formatPacketIds(preflight.pendingFuturePacketIds)}`);
    }
  }

  const nextWaveReadyPreflights = collectNextWaveReadyPreflights(summary);
  if (nextWaveReadyPreflights.length > 0) {
    lines.push("");
    lines.push("Next wave readiness:");
    for (const item of nextWaveReadyPreflights) {
      lines.push(...formatNextWaveReadyPreflight(item));
    }
  }

  if (summary.packetPlans.length > 0) {
    lines.push("");
    lines.push("Multi-wave packet lifecycle:");
    for (const plan of summary.packetPlans) {
      const report = buildPacketLifecycleWorkstreamReport({
        workstream: {
          id: plan.workstreamId,
          repoKey: plan.repoKey,
          integration: plan.parentPrNumber ? { branchName: "unknown", prNumber: plan.parentPrNumber } : undefined,
          packetPlan: {
             status: plan.status,
             packets: Object.fromEntries(plan.waves.flatMap(w => w.packets).map(p => [p.id, p])),
             waves: plan.waves.map(w => w.packetIds),
             currentWaveIndex: plan.currentWaveIndex
          }
        } as any,
        packetPrsCreatedThisRun: summary.packetPrsCreatedThisRun,
        waveAdvancementsThisRun: summary.packetWaveAdvancementsThisRun,
        blockedThisRun: summary.packetWaveBlockedThisRun,
        parentBranchSyncPreflights: summary.parentBranchSyncPreflights.map(p => ({
          preflight: p.preflight,
          branchSyncComparison: p.branchSyncComparison,
          branchSyncComparisonSkippedReason: p.branchSyncComparisonSkippedReason
        }))
      });

      if (report) {
        lines.push(formatPacketLifecycleReport(report));
        lines.push("");
      }
    }
  }

  if (summary.packetPlans.length > 0) {
    lines.push("");
    lines.push("Packet plans:");
    for (const plan of summary.packetPlans) {
      const waveInfo =
        plan.currentWaveIndex !== undefined ? `, current wave ${plan.currentWaveIndex}` : "";
      lines.push(
        `- ${plan.workstreamId} status ${plan.status}, ${plan.packetCount} packets, ${plan.waveCount} waves${waveInfo}`
      );
      plan.waves.forEach((wave, index) => {
        lines.push(`  wave ${index}: ${wave.packetIds.join(", ")}`);
      });
    }
  }

  const failedTasks = summary.tasks.filter((task) => task.status === "failed");
  if (failedTasks.length > 0) {
    lines.push("");
    lines.push("Failed tasks:");
    for (const task of failedTasks) {
      lines.push(`- ${task.repoSlug} ${task.kind}: ${task.summary}`);
    }
  }

  const scanFailures = collectScanFailures(summary.results);
  if (scanFailures.length > 0) {
    lines.push("");
    lines.push("Scan failures:");
    for (const failure of scanFailures) {
      lines.push(
        `- ${failure.repoSlug} ${failure.step} (${failure.scope}): ${failure.message}`
      );
    }
  }

  lines.push("");
  lines.push(`Generated state: ${summary.stateDir}/{repos,issues,prs,comments,tasks,worktrees,workstreams,attention}.json`);
  lines.push(`Execution log: ${summary.logDir}/{executions.json,artifacts/<execution-id>/...}`);

  return `${lines.join("\n")}\n`;
}

function formatRepoResult(result: RepoSyncRecord): string {
  const parts = [`- ${result.repoSlug}`];
  parts.push(result.status === "synced" ? "sync ok" : "sync failed");

  if (result.githubScan) {
    parts.push(`scan ${result.githubScan.status}`);
  }

  if (result.status === "failed" && result.error?.message) {
    parts.push(result.error.message);
  } else if (result.githubScan?.failures[0]?.message) {
    parts.push(result.githubScan.failures[0].message);
  }

  return parts.join(" | ");
}

function collectScanFailures(results: RepoSyncRecord[]): RepoScanFailure[] {
  return results.flatMap((result) => result.githubScan?.failures ?? []);
}

function formatPacketIds(ids: string[]): string {
  return ids.length > 0 ? ids.join(", ") : "(none)";
}

function formatBranchSyncRecommendation(
  item: RunSummary["parentBranchSyncPreflights"][number]
): string {
  const recommendation = recommendBranchSyncAction(
    item.branchSyncComparison,
    item.branchSyncComparisonSkippedReason
  );
  const nextWaveIndex = item.preflight.nextWaveIndex;

  switch (recommendation) {
    case "ready_to_advance":
      return "parent branch is up to date with default; next wave may proceed";
    case "sync_parent_from_default":
      return `sync parent from default before starting wave ${nextWaveIndex}`;
    case "manual_conflict_aware_sync_required":
      return `parent and default diverged; perform conflict-aware sync before starting wave ${nextWaveIndex}`;
    case "blocked_missing_ref":
      return "blocked; inspect missing local branch refs before continuing";
    case "blocked_unknown":
      return "blocked; branch sync status is unavailable or unknown";
  }
}

function formatBranchSyncComparison(
  item: RunSummary["parentBranchSyncPreflights"][number]
): string {
  if (item.branchSyncComparisonSkippedReason === "missing_local_path") {
    return "unavailable (missing local repo path)";
  }

  const comparison = item.branchSyncComparison;
  if (!comparison) {
    return "unavailable";
  }

  const hasCounts =
    comparison.parentBehindCount !== undefined && comparison.parentAheadCount !== undefined;

  return hasCounts
    ? `${comparison.status} (behind ${comparison.parentBehindCount}, ahead ${comparison.parentAheadCount})`
    : comparison.status;
}

function collectNextWaveReadyPreflights(
  summary: RunSummary
): RunSummary["parentBranchSyncPreflights"] {
  return summary.parentBranchSyncPreflights.filter(
    (item) =>
      recommendBranchSyncAction(
        item.branchSyncComparison,
        item.branchSyncComparisonSkippedReason
      ) === "ready_to_advance"
  );
}

function formatNextWaveReadyPreflight(
  item: RunSummary["parentBranchSyncPreflights"][number]
): string[] {
  const preflight = item.preflight;
  const parentPr =
    preflight.parentPrNumber !== undefined ? `#${preflight.parentPrNumber}` : "unknown";

  return [
    `- ${preflight.workstreamId}: wave ${preflight.nextWaveIndex} is ready to prepare`,
    `  parent branch: ${preflight.parentIntegrationBranch}`,
    `  default branch: ${preflight.defaultBranch}`,
    `  parent PR: ${parentPr}`,
    `  completed packets: ${formatPacketIds(preflight.completedPacketIds)}`,
    `  pending future packets: ${formatPacketIds(preflight.pendingFuturePacketIds)}`
  ];
}

function formatManagementGitOps(result?: import("../git/gitops-lifecycle.js").ManagementGitOpsResult): string {
  if (!result) {
    return "unknown";
  }

  switch (result.status) {
    case "skipped_not_git":
      return "skipped (not a Git worktree)";
    case "pulled":
      return "pulled with fast-forward-only update";
    default:
      return "unknown";
  }
}

function formatOutputsGitOps(result?: import("../git/gitops-lifecycle.js").OutputsGitOpsResult): string {
  if (!result) {
    return "unknown";
  }

  switch (result.status) {
    case "skipped_not_git":
      return "skipped (not a Git worktree)";
    case "clean_before_run":
      return "clean before run; failed to finalize (check logs)";
    case "no_changes":
      return "clean before run; no generated changes";
    case "pushed":
      return `clean before run; committed and pushed ${result.commitSha}`;
    default:
      return "unknown";
  }
}
