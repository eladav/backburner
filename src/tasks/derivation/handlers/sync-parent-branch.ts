import { buildParentBranchSyncPreflight } from "../../../workstreams/packet-plan.js";
import type { TaskRecord } from "../../types.js";
import { buildTaskRecord } from "../builders.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler
} from "../types.js";

export const syncParentBranchPreflightHandler: TaskDerivationHandler = {
  name: "sync_parent_branch_preflight",
  derive(context, env) {
    const task = deriveSyncParentBranchPreflightTask(context, env);
    return task ? [task] : [];
  }
};

export const syncParentBranchHandler: TaskDerivationHandler = {
  name: "sync_parent_branch",
  derive(context, env) {
    const task = deriveSyncParentBranchTask(context, env);
    return task ? [task] : [];
  }
};

function deriveSyncParentBranchPreflightTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, attention, issue, repoConfig, repoSyncRecord } = context;

  if (
    workstream.origin.type !== "issue" ||
    !issue ||
    !attention?.reasons.includes("packet_wave_complete_sync_needed") ||
    !workstream.packetPlan
  ) {
    return undefined;
  }

  const defaultBranch = repoConfig?.defaultBranch ?? repoSyncRecord?.defaultBranch ?? undefined;
  const preflight = buildParentBranchSyncPreflight({ workstream, defaultBranch });

  if (!preflight) {
    return undefined;
  }

  const reason = [
    `Current packet wave ${preflight.currentWaveIndex} is complete and a future wave exists.`,
    `Parent integration branch: ${preflight.parentIntegrationBranch}`,
    `Default branch: ${preflight.defaultBranch}`,
    `Next wave index: ${preflight.nextWaveIndex}`,
    `Completed packet IDs: ${preflight.completedPacketIds.join(", ")}`,
    `Pending future packet IDs: ${preflight.pendingFuturePacketIds.join(", ")}`,
    preflight.parentPrNumber ? `Parent PR: #${preflight.parentPrNumber}` : undefined
  ]
    .filter(Boolean)
    .join(" ");

  return buildTaskRecord(
    `task:sync_parent_branch_preflight:${workstream.id}`,
    "sync_parent_branch_preflight",
    issue,
    repoSyncRecord,
    {
      reason,
      summary: `Inspect parent branch sync before packet wave ${preflight.nextWaveIndex} for issue #${issue.number}`,
      contextBuilder: env.input.contextBuilder,
      now: env.input.now
    },
    env.input.contextBuilder.build({
      taskKind: "sync_parent_branch_preflight",
      repoIdentifier: issue.repoSlug,
      sourceKind: "issue",
      sourceUrl: issue.url,
      labels: issue.labels,
      issueTitle: issue.title,
      issueBody: issue.body,
      preflight,
      ...(repoSyncRecord?.localPath ? { localRepoPath: repoSyncRecord.localPath } : {})
    }),
    workstream.id
  );
}

function deriveSyncParentBranchTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, attention, issue, repoConfig, repoSyncRecord } = context;

  if (
    workstream.origin.type !== "issue" ||
    !issue ||
    issue.state !== "open" ||
    !attention?.reasons.includes("packet_wave_complete_sync_needed") ||
    !workstream.packetPlan ||
    !repoConfig
  ) {
    return undefined;
  }

  const defaultBranch = repoConfig.defaultBranch ?? repoSyncRecord?.defaultBranch ?? undefined;
  const preflight = buildParentBranchSyncPreflight({ workstream, defaultBranch });

  if (!preflight || !preflight.parentPrNumber) {
    return undefined;
  }

  const parentPr = env.currentPrsByRepoAndNumber.get(`${workstream.repoKey}:${preflight.parentPrNumber}`);
  if (!parentPr || parentPr.state !== "open" || !parentPr.labels.includes(repoConfig.labels.agentSyncParentBranch)) {
    return undefined;
  }

  const reason = [
    `Explicit sync requested via label "${repoConfig.labels.agentSyncParentBranch}" on parent PR #${parentPr.number}.`,
    `Current packet wave ${preflight.currentWaveIndex} is complete and a future wave exists.`,
    `Parent integration branch: ${preflight.parentIntegrationBranch}`,
    `Default branch: ${preflight.defaultBranch}`,
    `Next wave index: ${preflight.nextWaveIndex}`,
    `Completed packet IDs: ${preflight.completedPacketIds.join(", ")}`,
    `Pending future packet IDs: ${preflight.pendingFuturePacketIds.join(", ")}`
  ].join(" ");

  return buildTaskRecord(
    `task:sync_parent_branch:${parentPr.id}`,
    "sync_parent_branch",
    parentPr,
    repoSyncRecord,
    {
      reason,
      summary: `Sync parent branch for issue #${issue.number} before packet wave ${preflight.nextWaveIndex}`,
      contextBuilder: env.input.contextBuilder,
      now: env.input.now
    },
    env.input.contextBuilder.build({
      taskKind: "sync_parent_branch",
      repoIdentifier: parentPr.repoSlug,
      sourceKind: "pull_request",
      sourceUrl: parentPr.url,
      labels: parentPr.labels,
      preflight,
      ...(repoSyncRecord?.localPath ? { localRepoPath: repoSyncRecord.localPath } : {})
    }),
    workstream.id
  );
}
