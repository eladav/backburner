import type { RepoConfig } from "../../../config/types.js";
import type { NormalizedPullRequest } from "../../../domain/entities.js";
import type {
  RepoSyncRecord,
  WorkstreamPacketPlan,
  WorktreeRecord
} from "../../../state/types.js";
import type { PacketPullRequestProjection } from "../../../workstreams/packet-projections.js";
import type { PrepareForMergePreflight } from "../../types.js";
import type { TaskRecord } from "../../types.js";
import { buildTaskId, buildTaskRecord } from "../builders.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler
} from "../types.js";

export const preparePullRequestForMergeHandler: TaskDerivationHandler = {
  name: "prepare_pr_for_merge",
  derive(context, env) {
    const task = derivePrepareForMergeTask(context, env);
    return task ? [task] : [];
  }
};

function derivePrepareForMergeTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, attention, activePullRequest, activeWorktree, repoConfig, repoSyncRecord } = context;

  if (
    !attention ||
    !activePullRequest ||
    !repoConfig ||
    activePullRequest.state !== "open" ||
    !attention.reasons.includes("prepare_for_merge_requested") ||
    !activePullRequest.labels.includes(repoConfig.labels.prepareForMerge)
  ) {
    return undefined;
  }

  const worktree = activeWorktree?.branchName === activePullRequest.headBranch ? activeWorktree : undefined;

  return createPrepareForMergeTask({
    pullRequest: activePullRequest,
    repoSyncRecord,
    repoConfig,
    contextBuilder: env.input.contextBuilder,
    now: env.input.now,
    workstreamId: workstream.id,
    worktree
  });
}

export function createPrepareForMergeTask(input: {
  pullRequest: NormalizedPullRequest;
  repoSyncRecord: RepoSyncRecord | undefined;
  repoConfig: RepoConfig;
  contextBuilder: TaskDerivationEnvironment["input"]["contextBuilder"];
  now: string;
  workstreamId: string;
  worktree?: WorktreeRecord | undefined;
  packetProjection?: PacketPullRequestProjection | undefined;
}): TaskRecord {
  const { pullRequest, repoSyncRecord, repoConfig, contextBuilder, now, workstreamId, worktree, packetProjection } = input;

  const preflight: PrepareForMergePreflight = {
    prNumber: pullRequest.number,
    headBranch: pullRequest.headBranch,
    headSha: pullRequest.headSha,
    baseBranch: pullRequest.baseBranch,
    prTitle: pullRequest.title,
    // Capture durable worktree paths at derivation time for audit/log use after clone cleanup
    persistentWorktreePath: worktree?.path,
    persistentLogDocumentPath: worktree?.logDocumentPath,
    persistentPlanDocumentPath: worktree?.planDocumentPath
  };

  const waveIndex = packetProjection?.packetWorktree?.packet?.waveIndex ??
    findWaveIndexForPacket(packetProjection?.packet.id, packetProjection?.parentWorkstream.packetPlan);

  const reason = packetProjection
    ? `Packet pull request #${pullRequest.number} (packet: ${packetProjection.packet.id}, wave: ${waveIndex ?? "unknown"}) has the "${repoConfig.labels.prepareForMerge}" label, requesting merge preparation into "${pullRequest.baseBranch}".`
    : `Pull request has the "${repoConfig.labels.prepareForMerge}" label, requesting merge preparation into "${pullRequest.baseBranch}".`;

  const summary = packetProjection
    ? `Prepare packet PR #${pullRequest.number} for merge into ${pullRequest.baseBranch} (Workstream: ${workstreamId})`
    : `Prepare PR #${pullRequest.number} for merge into ${pullRequest.baseBranch}: ${pullRequest.title}`;

  return buildTaskRecord(
    buildTaskId("prepare_pr_for_merge", pullRequest.id),
    "prepare_pr_for_merge",
    pullRequest,
    repoSyncRecord,
    {
      reason,
      summary,
      contextBuilder,
      now
    },
    contextBuilder.build({
      taskKind: "prepare_pr_for_merge",
      repoIdentifier: pullRequest.repoSlug,
      sourceKind: "pull_request",
      sourceUrl: pullRequest.url,
      labels: pullRequest.labels,
      prepareForMerge: preflight,
      ...(worktree?.path
        ? {
          localRepoPath: worktree.path,
          branchName: worktree.branchName,
          planDocumentPath: worktree.planDocumentPath,
          logDocumentPath: worktree.logDocumentPath
        }
        : repoSyncRecord?.localPath
          ? { localRepoPath: repoSyncRecord.localPath }
          : {}),
      ...(worktree?.packet?.packetId
        ? { packetId: worktree.packet.packetId }
        : packetProjection?.packet.id
          ? { packetId: packetProjection.packet.id }
          : {})
    }),
    workstreamId
  );
}

function findWaveIndexForPacket(
  packetId: string | undefined,
  packetPlan: WorkstreamPacketPlan | undefined
): number | undefined {
  if (!packetId || !packetPlan) {
    return undefined;
  }
  for (let i = 0; i < packetPlan.waves.length; i++) {
    const wave = packetPlan.waves[i];
    if (wave && wave.includes(packetId)) {
      return i;
    }
  }
  return undefined;
}
