import type { ManagementPrRecord } from "../retrospectives/types.js";

export type PullRequestBaseClassification =
  | {
      kind: "top_level";
      pullRequestNumber: number;
      repoSlug: string;
      baseBranch: string;
      defaultBranch: string;
    }
  | {
      kind: "non_default_parent";
      pullRequestNumber: number;
      repoSlug: string;
      baseBranch: string;
      defaultBranch: string;
    };

export function classifyPullRequestBase(input: {
  pullRequestNumber: number;
  repoSlug: string;
  baseBranch: string;
  defaultBranch: string;
}): PullRequestBaseClassification {
  const baseBranch = input.baseBranch.trim();
  const defaultBranch = input.defaultBranch.trim();

  if (baseBranch === defaultBranch) {
    return {
      kind: "top_level",
      pullRequestNumber: input.pullRequestNumber,
      repoSlug: input.repoSlug,
      baseBranch,
      defaultBranch,
    };
  }

  return {
    kind: "non_default_parent",
    pullRequestNumber: input.pullRequestNumber,
    repoSlug: input.repoSlug,
    baseBranch,
    defaultBranch,
  };
}

export type PullRequestManagementClassification =
  | { kind: "management"; reason: string; managementPrRecordId?: string }
  | { kind: "operational"; reason: string }
  | { kind: "unknown"; reason: string };

export interface ClassifyPullRequestInput {
  repoId: string;
  repoSlug: string;
  pullRequestNumber: number;
  headBranch?: string;
  baseBranch?: string;
  managementRepo?: {
    repoId?: string;
    repoSlug?: string;
  };
  managementPrs?: ManagementPrRecord[];
  managementBranchPrefixes?: string[];
}

export const MANAGEMENT_LEARNING_BRANCH_PREFIXES = [
  "agent/management-learning/",
  "management-learning/",
];

export function classifyManagementPullRequest(
  input: ClassifyPullRequestInput
): PullRequestManagementClassification {
  const {
    repoId,
    repoSlug,
    pullRequestNumber,
    headBranch,
    managementRepo,
    managementPrs = [],
    managementBranchPrefixes = MANAGEMENT_LEARNING_BRANCH_PREFIXES,
  } = input;

  // 1. Check if it matches a known management PR record
  const matchingRecord = managementPrs.find(
    (record) =>
      record.mode === "pull_request" &&
      record.prNumber === pullRequestNumber &&
      (record.repoSlug === repoSlug || record.repoId === repoId)
  );

  if (matchingRecord) {
    return {
      kind: "management",
      reason: "Matched known management PR record",
      managementPrRecordId: matchingRecord.id,
    };
  }

  // 2. Check if it's in the management repo
  const isManagementRepo =
    managementRepo &&
    (managementRepo.repoId === repoId || managementRepo.repoSlug === repoSlug);

  if (isManagementRepo) {
    // 3. Check head branch prefix
    if (headBranch) {
      if (managementBranchPrefixes.some((prefix) => headBranch.startsWith(prefix))) {
        return {
          kind: "management",
          reason: "Management repo PR with management branch prefix",
        };
      }
    }

    // 4. Check if it matches a management record by branch
    const matchingBranchRecord = managementPrs.find(
      (record) =>
        record.branchName === headBranch &&
        (record.repoSlug === repoSlug || record.repoId === repoId)
    );

    if (matchingBranchRecord) {
      return {
        kind: "management",
        reason: "Matched known management PR record by branch",
        managementPrRecordId: matchingBranchRecord.id,
      };
    }
  }

  // 5. If we don't have enough info about management repo, we might return unknown
  if (!managementRepo) {
    return {
      kind: "unknown",
      reason: "Management repository identity is unknown",
    };
  }

  return {
    kind: "operational",
    reason: "Did not match management PR criteria",
  };
}
