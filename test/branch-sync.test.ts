import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  recommendBranchSyncAction,
  type BranchSyncRecommendation
} from "../src/workstreams/branch-sync.js";
import type { BranchSyncComparison } from "../src/git/types.js";

function comparison(status: BranchSyncComparison["status"]): BranchSyncComparison {
  return {
    parentBranch: "agent/owner-repo/issue-132",
    defaultBranch: "main",
    parentRef: "refs/remotes/origin/agent/owner-repo/issue-132",
    defaultRef: "refs/remotes/origin/main",
    status,
    message: status
  };
}

describe("recommendBranchSyncAction", () => {
  it("recommends ready_to_advance when up_to_date", () => {
    assert.equal(recommendBranchSyncAction(comparison("up_to_date")), "ready_to_advance");
  });

  it("recommends sync_parent_from_default when behind_default", () => {
    assert.equal(recommendBranchSyncAction(comparison("behind_default")), "sync_parent_from_default");
  });

  it("recommends manual_conflict_aware_sync_required when diverged", () => {
    assert.equal(
      recommendBranchSyncAction(comparison("diverged")),
      "manual_conflict_aware_sync_required"
    );
  });

  it("recommends blocked_missing_ref when missing_parent_branch or missing_default_branch", () => {
    assert.equal(recommendBranchSyncAction(comparison("missing_parent_branch")), "blocked_missing_ref");
    assert.equal(recommendBranchSyncAction(comparison("missing_default_branch")), "blocked_missing_ref");
  });

  it("recommends blocked_unknown when unknown", () => {
    assert.equal(recommendBranchSyncAction(comparison("unknown")), "blocked_unknown");
  });

  it("recommends blocked_unknown when comparison is undefined", () => {
    assert.equal(recommendBranchSyncAction(undefined), "blocked_unknown");
  });

  it("recommends blocked_unknown when skippedReason is missing_local_path", () => {
    assert.equal(
      recommendBranchSyncAction(comparison("up_to_date"), "missing_local_path"),
      "blocked_unknown"
    );
    assert.equal(recommendBranchSyncAction(undefined, "missing_local_path"), "blocked_unknown");
  });
});
