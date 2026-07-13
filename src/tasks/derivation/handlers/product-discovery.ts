import type { TaskRecord } from "../../types.js";
import { createIssueTask } from "../builders.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler
} from "../types.js";

export const productDiscoveryHandler: TaskDerivationHandler = {
  name: "product_discovery",
  derive(context, env) {
    const task = deriveProductDiscoveryTask(context, env);
    return task ? [task] : [];
  }
};

function deriveProductDiscoveryTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, attention, issue, repoConfig, repoSyncRecord } = context;
  if (!issue || workstream.origin.type !== "issue") {
    return undefined;
  }

  if (workstream.phase !== "product_discovery") {
    return undefined;
  }

  const hasExistingProductDiscoveryTask = env.existingTasks.some(
    (task) => task.kind === "product_discovery" && task.workstreamId === workstream.id
  );
  const previousWorkstream = env.input.previousState.workstreams.find((record) => record.id === workstream.id);
  const issueCommentsUnavailable = repoSyncRecord?.githubScan?.failures.some(
    (failure) => failure.step === "issue_comments" && failure.scope === `issue#${issue.number}`
  ) ?? false;
  const isNewIssueProductDiscovery = Boolean(attention?.reasons.includes("new_issue") && !env.previousIssues.has(issue.id));
  const isMigratedProductDiscovery = Boolean(
    !hasExistingProductDiscoveryTask &&
      !issueCommentsUnavailable &&
      (previousWorkstream?.phase === "issue_triage" || previousWorkstream?.phase === "issue_waiting")
  );

  if (!isNewIssueProductDiscovery && !isMigratedProductDiscovery) {
    return undefined;
  }

  if (repoConfig && issue.labels.includes(repoConfig.labels.agentProductApproved)) {
    return undefined;
  }

  return createIssueTask("product_discovery", issue, repoSyncRecord, {
    reason: "Issue is newly seen and needs Product Discovery before implementation approval.",
    summary: `Product Discovery for issue #${issue.number}: ${issue.title}`,
    contextBuilder: env.input.contextBuilder,
    now: env.input.now
  }, workstream.id);
}
