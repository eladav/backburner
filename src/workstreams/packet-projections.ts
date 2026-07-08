import type {
  NormalizedComment,
  NormalizedPullRequest
} from "../domain/entities.js";
import type {
  WorkstreamPacket,
  WorkstreamRecord,
  WorktreeRecord
} from "../state/types.js";

export interface PacketPullRequestProjection {
  pullRequest: NormalizedPullRequest;
  parentWorkstream: WorkstreamRecord;
  packet: WorkstreamPacket;
  packetWorktree?: WorktreeRecord;
  parentIntegrationBranch: string;
  parentPullRequestNumber?: number | undefined;
}

export interface PacketPullRequestCommentProjection {
  comment: NormalizedComment;
  packetProjection: PacketPullRequestProjection;
}

/**
 * Collects packet-scoped PR projections from a set of scanned entities.
 * This is a pure and deterministic function.
 */
export function collectPacketPullRequestProjections(input: {
  pullRequests: NormalizedPullRequest[];
  workstreams: WorkstreamRecord[];
  worktrees: WorktreeRecord[];
}): PacketPullRequestProjection[] {
  const { pullRequests, workstreams, worktrees } = input;

  // 1. Build lookups
  const worktreesByParentAndPacket = new Map<string, WorktreeRecord[]>();
  for (const wt of worktrees) {
    if (wt.packet) {
      const key = `${wt.packet.parentWorkstreamId}\0${wt.packet.packetId}`;
      const list = worktreesByParentAndPacket.get(key) || [];
      list.push(wt);
      worktreesByParentAndPacket.set(key, list);
    }
  }

  const prsByRepoIdAndHeadBranch = new Map<string, NormalizedPullRequest[]>();
  for (const pr of pullRequests) {
    const key = `${pr.repoId}\0${pr.headBranch}`;
    const list = prsByRepoIdAndHeadBranch.get(key) || [];
    list.push(pr);
    prsByRepoIdAndHeadBranch.set(key, list);
  }

  const prsByRepoIdAndNumber = new Map<string, NormalizedPullRequest>();
  for (const pr of pullRequests) {
    const key = `${pr.repoId}\0${pr.number}`;
    prsByRepoIdAndNumber.set(key, pr);
  }

  const projections: PacketPullRequestProjection[] = [];
  const seenProjections = new Set<string>(); // repoSlug#prNumber#parentWorkstream.id#packet.id

  // 2. Iterate parent workstreams deterministically
  const sortedWorkstreams = [...workstreams].sort((a, b) => {
    return a.repoKey.localeCompare(b.repoKey) || a.id.localeCompare(b.id);
  });

  for (const parentWorkstream of sortedWorkstreams) {
    if (!parentWorkstream.packetPlan) {
      continue;
    }

    const packetEntries = getPacketEntries(parentWorkstream);

    for (const [packetId, packet] of packetEntries) {
      let matchedInThisPacket = false;

      // A. Worktree-backed matching (primary)
      const key = `${parentWorkstream.id}\0${packetId}`;
      const candidateWorktrees = worktreesByParentAndPacket.get(key) || [];

      // Sort worktrees for determinism
      candidateWorktrees.sort(
        (a, b) =>
          a.repoSlug.localeCompare(b.repoSlug) ||
          a.branchName.localeCompare(b.branchName) ||
          a.id.localeCompare(b.id)
      );

      for (const packetWorktree of candidateWorktrees) {
        const parentIntegrationBranch = getParentIntegrationBranch(
          parentWorkstream,
          packetWorktree
        );
        if (!parentIntegrationBranch) {
          continue;
        }

        const prs =
          prsByRepoIdAndHeadBranch.get(
            `${packetWorktree.repoId}\0${packetWorktree.branchName}`
          ) || [];

        // Sort PRs for determinism if multiple match the same branch (unlikely)
        const sortedPrs = [...prs].sort((a, b) => a.number - b.number);

        for (const pr of sortedPrs) {
          if (isEligiblePacketPr(pr, parentIntegrationBranch)) {
            const projectionKey = `${pr.repoSlug}#${pr.number}#${parentWorkstream.id}#${packetId}`;
            if (!seenProjections.has(projectionKey)) {
              projections.push({
                pullRequest: pr,
                parentWorkstream,
                packet,
                packetWorktree,
                parentIntegrationBranch,
                parentPullRequestNumber: parentWorkstream.integration?.prNumber
              });
              seenProjections.add(projectionKey);
              matchedInThisPacket = true;
            }
          }
        }
      }

      // B. Fallback matching by packet.prNumber (only if no worktree match)
      if (!matchedInThisPacket && packet.prNumber) {
        const parentIntegrationBranch = getParentIntegrationBranch(parentWorkstream);
        if (parentIntegrationBranch) {
          // Find repoId for fallback.
          // Try to find it from packet worktrees for this parent.
          let repoId = "";
          for (const wt of worktrees) {
            if (wt.packet?.parentWorkstreamId === parentWorkstream.id) {
              repoId = wt.repoId;
              break;
            }
          }

          let pr: NormalizedPullRequest | undefined;
          if (repoId) {
            pr = prsByRepoIdAndNumber.get(`${repoId}\0${packet.prNumber}`);
          } else {
            // Fallback to repoSlug comparison since WorkstreamRecord doesn't have repoId
            for (const p of pullRequests) {
              if (
                p.repoSlug === parentWorkstream.repoKey &&
                p.number === packet.prNumber
              ) {
                pr = p;
                break;
              }
            }
          }

          if (pr && isEligiblePacketPr(pr, parentIntegrationBranch)) {
            const projectionKey = `${pr.repoSlug}#${pr.number}#${parentWorkstream.id}#${packetId}`;
            if (!seenProjections.has(projectionKey)) {
              projections.push({
                pullRequest: pr,
                parentWorkstream,
                packet,
                parentIntegrationBranch,
                parentPullRequestNumber: parentWorkstream.integration?.prNumber
              });
              seenProjections.add(projectionKey);
            }
          }
        }
      }
    }
  }

  return projections;
}

/**
 * Collects packet-scoped PR comment projections.
 */
export function collectPacketPullRequestCommentProjections(input: {
  comments: NormalizedComment[];
  packetPullRequestProjections: PacketPullRequestProjection[];
}): PacketPullRequestCommentProjection[] {
  const projections: PacketPullRequestCommentProjection[] = [];

  for (const comment of input.comments) {
    if (comment.parentType !== "pull_request") {
      continue;
    }

    for (const packetProjection of input.packetPullRequestProjections) {
      if (
        comment.repoId === packetProjection.pullRequest.repoId &&
        comment.parentNumber === packetProjection.pullRequest.number
      ) {
        projections.push({
          comment,
          packetProjection
        });
      }
    }
  }

  // Sort deterministically
  return projections.sort((a, b) => {
    return (
      a.comment.repoSlug.localeCompare(b.comment.repoSlug) ||
      a.comment.parentNumber - b.comment.parentNumber ||
      a.comment.id.localeCompare(b.comment.id) ||
      a.packetProjection.parentWorkstream.id.localeCompare(
        b.packetProjection.parentWorkstream.id
      ) ||
      a.packetProjection.packet.id.localeCompare(b.packetProjection.packet.id)
    );
  });
}

/**
 * Resolves the parent integration branch for a packet.
 */
function getParentIntegrationBranch(
  parentWorkstream: WorkstreamRecord,
  packetWorktree?: WorktreeRecord
): string | undefined {
  return (
    packetWorktree?.packet?.parentIntegrationBranch ||
    parentWorkstream.integration?.branchName
  );
}

/**
 * Returns packet entries sorted by wave order and then packet ID.
 */
function getPacketEntries(
  workstream: WorkstreamRecord
): [string, WorkstreamPacket][] {
  if (!workstream.packetPlan) {
    return [];
  }
  const packets = workstream.packetPlan.packets;
  const waves = workstream.packetPlan.waves || [];

  const entries: [string, WorkstreamPacket][] = [];
  const wavedIds = new Set<string>();

  for (const wave of waves) {
    const wavePackets: [string, WorkstreamPacket][] = [];
    for (const id of wave) {
      if (packets[id]) {
        wavePackets.push([id, packets[id]]);
        wavedIds.add(id);
      }
    }
    wavePackets.sort((a, b) => a[0].localeCompare(b[0]));
    entries.push(...wavePackets);
  }

  const remainingEntries = Object.entries(packets)
    .filter(([id]) => !wavedIds.has(id))
    .sort((a, b) => a[0].localeCompare(b[0]));

  entries.push(...remainingEntries);

  return entries;
}

/**
 * Checks if a PR is eligible to be a packet PR for a given parent integration branch.
 */
function isEligiblePacketPr(
  pr: NormalizedPullRequest,
  parentIntegrationBranch: string
): boolean {
  return (
    pr.baseBranch === parentIntegrationBranch &&
    pr.baseClassification === "non_default_parent"
  );
}
