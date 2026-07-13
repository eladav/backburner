import { hasGeneratedPlanBreakdown } from "../../../workstreams/packet-plan.js";
import type { TaskRecord } from "../../types.js";
import { buildTaskId, buildTaskRecord } from "../builders.js";
import type {
  BlockingTaskDerivationHandler,
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment
} from "../types.js";

export const planBreakdownHandler: BlockingTaskDerivationHandler = {
  name: "plan_breakdown",
  derive(context, env) {
    const task = derivePlanBreakdownTask(context, env);
    return task ? [task] : [];
  },
  shouldBlockRemainingHandlers(task) {
    return task.status !== "completed" && task.status !== "failed";
  }
};

function derivePlanBreakdownTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, attention, issue, activePullRequest, activeWorktree, repoConfig, repoSyncRecord } = context;
  if (hasGeneratedPlanBreakdown(workstream)) {
    return undefined;
  }

  if (!attention?.reasons.includes("plan_breakdown_requested") || !repoConfig) {
    return undefined;
  }

  const source = (issue?.labels.includes(repoConfig.labels.planBreakdownNeeded) ? issue : undefined)
    ?? (activePullRequest?.labels.includes(repoConfig.labels.planBreakdownNeeded) ? activePullRequest : undefined);

  if (!source) {
    return undefined;
  }

  const prWorktree =
    source.kind === "pull_request" &&
    activeWorktree &&
    activePullRequest &&
    activePullRequest.id === source.id &&
    activeWorktree.branchName === activePullRequest.headBranch
      ? activeWorktree
      : undefined;

  return buildTaskRecord(
    buildTaskId("plan_breakdown", source.id),
    "plan_breakdown",
    source,
    repoSyncRecord,
    {
      reason: `The "${repoConfig.labels.planBreakdownNeeded}" label is present, requesting a technical breakdown before implementation.`,
      summary: `Break down implementation for ${source.kind.replace("_", " ")} #${source.number}: ${source.title}`,
      contextBuilder: env.input.contextBuilder,
      now: env.input.now
    },
    env.input.contextBuilder.build({
      taskKind: "plan_breakdown",
      repoIdentifier: source.repoSlug,
      sourceKind: source.kind,
      sourceUrl: source.url,
      labels: source.labels,
      ...(source.kind === "issue"
        ? {
          issueTitle: source.title,
          issueBody: source.body
        }
        : {}),
      ...(prWorktree
        ? {
          localRepoPath: prWorktree.path,
          branchName: prWorktree.branchName,
          planDocumentPath: prWorktree.planDocumentPath,
          ...(prWorktree.productSpecDocumentPath ? { productSpecDocumentPath: prWorktree.productSpecDocumentPath } : {}),
          logDocumentPath: prWorktree.logDocumentPath
        }
        : repoSyncRecord?.localPath
          ? { localRepoPath: repoSyncRecord.localPath }
          : {})
    }),
    workstream.id
  );
}
