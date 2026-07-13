import type { NormalizedIssue, NormalizedPullRequest } from "../../../domain/entities.js";
import type { WorktreeRecord } from "../../../state/types.js";
import type { TaskRecord } from "../../types.js";
import {
  buildTaskRecord,
  createPullRequestTask
} from "../builders.js";
import type {
  CreateWorktreeTaskInput,
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler
} from "../types.js";

export const implementPlanHandler: TaskDerivationHandler = {
  name: "implement_plan",
  derive(context, env) {
    const task = deriveImplementTask(context, env);
    return task ? [task] : [];
  }
};

export function derivePacketImplementTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, issue, activePullRequest, activeWorktree, packetPullRequest } = context;
  if (
    workstream.status !== "open" ||
    workstream.phase === "abandoned" ||
    workstream.phase === "resolved"
  ) {
    return undefined;
  }

  if (packetPullRequest && packetPullRequest.state !== "open") {
    return undefined;
  }

  if (!activeWorktree?.packet || activeWorktree.status !== "implementation_ready") {
    return undefined;
  }

  const parentSource = issue ?? activePullRequest;
  const source = packetPullRequest ?? parentSource;
  if (!source) {
    return undefined;
  }

  return createWorktreeImplementTask(
    source,
    activeWorktree,
    {
      contextBuilder: env.input.contextBuilder,
      now: env.input.now
    },
    parentSource,
    workstream.id
  );
}

function deriveImplementTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, attention, activePullRequest, activeWorktree, repoConfig, repoSyncRecord } = context;
  if (!attention || !activePullRequest || !repoConfig) {
    return undefined;
  }

  if (activeWorktree?.status === "implementation_done" || workstream.phase === "implementation_done") {
    return undefined;
  }

  if (
    activeWorktree &&
    activeWorktree.status !== "implementation_ready" &&
    activeWorktree.status !== "awaiting_plan_approval" &&
    activeWorktree.status !== "implementing"
  ) {
    return undefined;
  }

  if (workstream.phase === "abandoned" || workstream.phase === "resolved") {
    return undefined;
  }

  if (activePullRequest.state !== "open") {
    return undefined;
  }

  if (
    attention.reasons.includes("pr_review_requested") ||
    (!attention.reasons.includes("plan_approved") &&
      workstream.phase !== "implementation_ready" &&
      workstream.phase !== "implementing" &&
      workstream.phase !== "implementation_feedback")
  ) {
    return undefined;
  }

  return createPullRequestTask(
    "implement_plan",
    activePullRequest,
    repoSyncRecord,
    {
      reason: `Pull request carries the "${repoConfig.labels.agentPlanApproved}" label and is ready for implementation.`,
      summary: `Implement approved plan for PR #${activePullRequest.number}: ${activePullRequest.title}`,
      contextBuilder: env.input.contextBuilder,
      now: env.input.now
    },
    activeWorktree,
    workstream.id
  );
}

function createWorktreeImplementTask(
  source: NormalizedIssue | NormalizedPullRequest,
  worktree: WorktreeRecord,
  input: CreateWorktreeTaskInput,
  parentSource?: NormalizedIssue | NormalizedPullRequest,
  workstreamId?: string
): TaskRecord {
  const reason = worktree.packet
    ? `Implementation packet "${worktree.packet.packetId}" is approved in wave ${worktree.packet.waveIndex} and ready for implementation.`
    : `Implementation ready for ${source.kind === "issue" ? "issue" : "PR"} #${source.number}: ${source.title}`;

  const summary = worktree.packet
    ? `Implement approved packet "${worktree.packet.packetId}" in wave ${worktree.packet.waveIndex}`
    : `Implement approved plan for ${source.kind === "issue" ? "issue" : "PR"} #${source.number}: ${source.title}`;

  return buildTaskRecord(
    `task:implement_plan:worktree:${worktree.id}`,
    "implement_plan",
    source,
    undefined,
    {
      reason,
      summary,
      contextBuilder: input.contextBuilder,
      now: input.now
    },
    input.contextBuilder.build({
      taskKind: "implement_plan",
      repoIdentifier: source.repoSlug,
      sourceKind: worktree.prUrl ? "pull_request" : source.kind,
      sourceUrl: worktree.prUrl || source.url,
      ...(worktree.prUrl ? { parentUrl: parentSource?.url ?? source.url } : {}),
      labels: source.labels,
      localRepoPath: worktree.path,
      branchName: worktree.branchName,
      ...(worktree.packet?.packetId ? { packetId: worktree.packet.packetId } : {}),
      planDocumentPath: worktree.planDocumentPath,
      ...(worktree.productSpecDocumentPath ? { productSpecDocumentPath: worktree.productSpecDocumentPath } : {}),
      logDocumentPath: worktree.logDocumentPath,
      ...(parentSource && parentSource.kind === "issue"
        ? {
            issueTitle: parentSource.title,
            issueBody: parentSource.body
          }
        : source.kind === "issue"
        ? {
            issueTitle: source.title,
            issueBody: source.body
          }
        : {})
    }),
    workstreamId
  );
}
