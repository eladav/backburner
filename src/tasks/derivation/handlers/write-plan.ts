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

export const writePlanHandler: TaskDerivationHandler = {
  name: "write_plan",
  derive(context, env) {
    const task = deriveWritePlanTask(context, env);
    return task ? [task] : [];
  }
};

export function deriveWritePlanTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, attention, issue, activePullRequest, activeWorktree, repoSyncRecord, packetPullRequest } = context;

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

  const isPacketPlanning = activeWorktree?.packet && activeWorktree.status === "planning";

  if (!isPacketPlanning && workstream.origin.type === "issue") {
    if (workstream.phase === "product_discovery" || workstream.phase === "product_specification") {
      return undefined;
    }
    if (workstream.product && workstream.product.status !== "spec_written") {
      return undefined;
    }
  }

  if (workstream.phase !== "planning" && workstream.phase !== "plan_feedback" && !isPacketPlanning) {
    return undefined;
  }

  if (!isPacketPlanning) {
    if (
      attention?.reasons.includes("pr_review_requested") ||
      (attention?.reasons.includes("plan_approved") && activeWorktree?.status !== "planning")
    ) {
      return undefined;
    }
  }

  if (activeWorktree?.status !== "planning") {
    return undefined;
  }

  if (activeWorktree) {
    const parentSource = issue ?? activePullRequest;
    const source = (isPacketPlanning ? packetPullRequest : undefined) ?? parentSource;
    if (source) {
      return createWorktreeWritePlanTask(
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
  }

  if (!activePullRequest) {
    return undefined;
  }

  return createPullRequestTask("write_plan", activePullRequest, repoSyncRecord, {
    reason: 'Pull request carries the "agent-in-progress" label and still needs the planning step.',
    summary: `Write plan for PR #${activePullRequest.number}: ${activePullRequest.title}`,
    contextBuilder: env.input.contextBuilder,
    now: env.input.now
  }, undefined, workstream.id);
}

function createWorktreeWritePlanTask(
  source: NormalizedIssue | NormalizedPullRequest,
  worktree: WorktreeRecord,
  input: CreateWorktreeTaskInput,
  parentSource?: NormalizedIssue | NormalizedPullRequest,
  workstreamId?: string
): TaskRecord {
  const reason = worktree.packet
    ? `Implementation packet "${worktree.packet.packetId}" is in wave ${worktree.packet.waveIndex} and is ready for planning.`
    : source.kind === "issue"
    ? "Product Spec is written; the first engineering step is to write the plan."
    : 'Pull request carries the "agent-in-progress" label and still needs the planning step.';

  const summary = worktree.packet
    ? `Write plan for packet "${worktree.packet.packetId}" in wave ${worktree.packet.waveIndex}`
    : `Write plan for ${source.kind === "issue" ? "issue" : "PR"} #${source.number}: ${source.title}`;

  return buildTaskRecord(
    `task:write_plan:worktree:${worktree.id}`,
    "write_plan",
    source,
    undefined,
    {
      reason,
      summary,
      contextBuilder: input.contextBuilder,
      now: input.now
    },
    input.contextBuilder.build({
      taskKind: "write_plan",
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
        : {}),
      ...(worktree.triggerCommentUrl ? { commentUrl: worktree.triggerCommentUrl } : {}),
      ...(worktree.triggerCommentText ? { commentText: worktree.triggerCommentText } : {})
    }),
    workstreamId
  );
}
