import type { TaskRecord } from "../../types.js";
import { createPullRequestTask } from "../builders.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler
} from "../types.js";

export const reviewPullRequestHandler: TaskDerivationHandler = {
  name: "review_pr",
  derive(context, env) {
    const task = deriveReviewTask(context, env);
    return task ? [task] : [];
  }
};

function deriveReviewTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, attention, activePullRequest, activeWorktree, repoConfig, repoSyncRecord } = context;
  if (!attention || !activePullRequest || !repoConfig) {
    return undefined;
  }

  const reviewRequested = attention.reasons.includes("pr_review_requested");
  const reviewNeedsAction =
    reviewRequested &&
    (!attention.lastHandledReviewHeadSha ||
      attention.lastHandledReviewHeadSha !== attention.currentPullRequestHeadSha);
  const isReviewWorkstream = workstream.origin.type === "pr" || workstream.phase === "pr_review";

  if (!reviewNeedsAction || !isReviewWorkstream) {
    return undefined;
  }

  return createPullRequestTask("review_pr", activePullRequest, repoSyncRecord, {
    reason: `Pull request has the "${repoConfig.labels.agentReview}" label and code changed (head: ${activePullRequest.headSha || "unknown"}).`,
    summary: `Review PR #${activePullRequest.number}: ${activePullRequest.title}`,
    contextBuilder: env.input.contextBuilder,
    now: env.input.now
  }, activeWorktree, workstream.id);
}
