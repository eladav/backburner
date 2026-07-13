import type { TaskDerivationHandler } from "../types.js";
import { commentResponseHandler } from "./comment-response.js";
import { implementPlanHandler } from "./implement-plan.js";
import { packetPullRequestControlHandler } from "./packet-pr-control.js";
import { packetWorktreeHandler } from "./packet-worktree.js";
import { planBreakdownHandler } from "./plan-breakdown.js";
import { preparePullRequestForMergeHandler } from "./prepare-for-merge.js";
import { productDiscoveryHandler } from "./product-discovery.js";
import { retryFailedTaskHandler } from "./retry-failed-task.js";
import { reviewPullRequestHandler } from "./review-pr.js";
import {
  syncParentBranchHandler,
  syncParentBranchPreflightHandler
} from "./sync-parent-branch.js";
import {
  hasOpenWaveAssessmentParentPullRequest,
  isWaveAssessmentCheckpointAllowed,
  waveAssessmentHandler
} from "./wave-assessment.js";
import { writePlanHandler } from "./write-plan.js";
import { writeProductSpecHandler } from "./write-product-spec.js";

export { deriveManagementPullRequestCommentTasks } from "./comment-response.js";
export { isActiveParentWorkstream } from "./shared.js";
export { planBreakdownHandler } from "./plan-breakdown.js";
export { waveAssessmentHandler } from "./wave-assessment.js";

const gatedSyncParentBranchPreflightHandler: TaskDerivationHandler = {
  name: syncParentBranchPreflightHandler.name,
  derive(context, env, sink) {
    if (
      hasOpenWaveAssessmentParentPullRequest(context, env) &&
      !isWaveAssessmentCheckpointAllowed(context, env)
    ) {
      return [];
    }

    return syncParentBranchPreflightHandler.derive(context, env, sink);
  }
};

const gatedSyncParentBranchHandler: TaskDerivationHandler = {
  name: syncParentBranchHandler.name,
  derive(context, env, sink) {
    if (!isWaveAssessmentCheckpointAllowed(context, env)) {
      return [];
    }

    return syncParentBranchHandler.derive(context, env, sink);
  }
};

export const parentWorkstreamHandlers: TaskDerivationHandler[] = [
  waveAssessmentHandler,
  gatedSyncParentBranchPreflightHandler,
  gatedSyncParentBranchHandler,
  reviewPullRequestHandler,
  preparePullRequestForMergeHandler,
  packetPullRequestControlHandler,
  writeProductSpecHandler,
  writePlanHandler
];

export const activeParentWorkstreamHandlers: TaskDerivationHandler[] = [
  packetWorktreeHandler
];

export const finalWorkstreamHandlers: TaskDerivationHandler[] = [
  implementPlanHandler,
  productDiscoveryHandler,
  retryFailedTaskHandler,
  commentResponseHandler
];
