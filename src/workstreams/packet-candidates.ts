import type { NormalizedPullRequest } from "../domain/entities.js";
import type { WorkstreamRecord } from "../state/types.js";

export interface PacketPullRequestCandidate {
  repoSlug: string;
  pullRequestNumber: number;
  title: string;
  baseBranch: string;
  headBranch: string;
  parentWorkstreamId?: string | undefined;
  parentIntegrationBranch?: string | undefined;
  parentPullRequestNumber?: number | undefined;
  status: "matched_parent_workstream" | "orphan_non_default_parent";
}

export function collectPacketPullRequestCandidates(input: {
  pullRequests: NormalizedPullRequest[];
  workstreams: WorkstreamRecord[];
}): PacketPullRequestCandidate[] {
  const candidates: PacketPullRequestCandidate[] = [];

  const nonDefaultPrs = input.pullRequests.filter(
    (pr) => pr.baseClassification === "non_default_parent"
  );

  for (const pr of nonDefaultPrs) {
    const matchingWorkstreams = input.workstreams
      .filter((ws) => ws.repoKey === pr.repoSlug)
      .filter((ws) => ws.status === "open" && ws.resolution === "unresolved")
      .filter((ws) => ws.integration?.branchName === pr.baseBranch)
      .sort((a, b) => a.id.localeCompare(b.id));

    const parentWorkstream = matchingWorkstreams[0];

    if (parentWorkstream) {
      candidates.push({
        repoSlug: pr.repoSlug,
        pullRequestNumber: pr.number,
        title: pr.title,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        parentWorkstreamId: parentWorkstream.id,
        parentIntegrationBranch: parentWorkstream.integration?.branchName,
        parentPullRequestNumber: parentWorkstream.integration?.prNumber,
        status: "matched_parent_workstream"
      });
    } else {
      candidates.push({
        repoSlug: pr.repoSlug,
        pullRequestNumber: pr.number,
        title: pr.title,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        status: "orphan_non_default_parent"
      });
    }
  }

  return candidates.sort((a, b) => {
    const repoComparison = a.repoSlug.localeCompare(b.repoSlug);
    if (repoComparison !== 0) {
      return repoComparison;
    }
    return a.pullRequestNumber - b.pullRequestNumber;
  });
}
