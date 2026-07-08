import type { RepoConfig } from "../config/types.js";
import type { NormalizedIssue, NormalizedPullRequest } from "../domain/entities.js";
import type {
  AttentionRecord,
  WorkstreamAttention,
  WorkstreamIntegrationState,
  WorkstreamLinkedPullRequest,
  WorkstreamProductState,
  WorkstreamRecord,
  WorkstreamResolution,
  WorkstreamStatus,
  WorktreeRecord
} from "../state/types.js";
import { reduceWorkstreamPhase } from "./phases.js";
import { markMergedPacketPullRequests } from "./packet-plan.js";

export interface WorkstreamDerivationInput {
  repos: RepoConfig[];
  currentIssues: NormalizedIssue[];
  currentPullRequests: NormalizedPullRequest[];
  previousPullRequests?: NormalizedPullRequest[];
  worktrees: WorktreeRecord[];
  previousWorkstreams: WorkstreamRecord[];
  attention?: AttentionRecord[];
}

function deriveProductState(input: {
  repo: RepoConfig | undefined;
  issue: NormalizedIssue | undefined;
  previous: WorkstreamRecord | undefined;
  activeWorktree: WorktreeRecord | undefined;
  nextPhase: WorkstreamRecord["phase"];
  now?: string | undefined;
}): WorkstreamProductState | undefined {
  const approvalLabel = input.repo?.labels.agentProductApproved;
  const issueApproved = approvalLabel !== undefined && input.issue?.labels.includes(approvalLabel);
  const previous = input.previous?.product;

  if (input.activeWorktree?.productSpecWrittenAt || previous?.status === "spec_written") {
    return {
      status: "spec_written",
      ...(approvalLabel ? { approvalLabel } : {}),
      ...(previous?.approvedAt ? { approvedAt: previous.approvedAt } : issueApproved && input.now ? { approvedAt: input.now } : {})
    };
  }

  if (input.nextPhase === "product_specification" || issueApproved) {
    return {
      status: "approved_for_spec",
      ...(approvalLabel ? { approvalLabel } : {}),
      ...(previous?.approvedAt ? { approvedAt: previous.approvedAt } : input.now ? { approvedAt: input.now } : {})
    };
  }

  if (input.nextPhase === "product_discovery" || previous?.status === "in_discovery") {
    return {
      status: "in_discovery",
      ...(approvalLabel ? { approvalLabel } : {})
    };
  }

  return previous;
}

interface IssueWorkstreamBuilder {
  id: string;
  repoId: string | undefined;
  repoKey: string;
  originIssueNumber: number;
  previous: WorkstreamRecord | undefined;
  currentIssue: NormalizedIssue | undefined;
  worktrees: WorktreeRecord[];
  linkedPrNumbers: Set<number>;
}

export function deriveWorkstreams(input: WorkstreamDerivationInput): WorkstreamRecord[] {
  const reposById = new Map(input.repos.map((repo) => [repo.id, repo]));
  const reposBySlug = new Map(input.repos.map((repo) => [`${repo.owner}/${repo.name}`, repo] as const));
  const previousPullRequestIds = new Set((input.previousPullRequests ?? []).map((pr) => pr.id));
  const currentIssues = [...input.currentIssues].sort(compareIssues);
  const currentPullRequests = [...input.currentPullRequests].sort(comparePullRequests);
  const previousWorkstreams = [...input.previousWorkstreams].sort(compareWorkstreams);
  const worktrees = [...input.worktrees].sort(compareWorktrees);
  const currentPrsByRepoAndNumber = new Map(
    currentPullRequests.map((pr) => [`${pr.repoId}:${pr.number}`, pr] as const)
  );
  const currentPrsByRepoAndBranch = new Map(
    currentPullRequests.map((pr) => [`${pr.repoId}:${pr.headBranch}`, pr] as const)
  );
  const attentionByWorkstreamId = new Map(
    (input.attention ?? []).map((record) => [record.workstreamId, record] as const)
  );

  const worktreesByParentId = new Map<string, WorktreeRecord[]>();
  for (const worktree of worktrees) {
    let parentId = getIssueWorkstreamIdForWorktree(worktree);
    if (!parentId && worktree.packet?.parentWorkstreamId) {
      parentId = worktree.packet.parentWorkstreamId;
    }

    if (parentId) {
      if (!worktreesByParentId.has(parentId)) {
        worktreesByParentId.set(parentId, []);
      }
      worktreesByParentId.get(parentId)!.push(worktree);
    }
  }

  const issueBuilders = new Map<string, IssueWorkstreamBuilder>();

  for (const previous of previousWorkstreams) {
    if (previous.origin.type !== "issue") {
      continue;
    }

    const packetPrNumbers = new Set(
      Object.values(previous.packetPlan?.packets ?? {})
        .map((p) => p.prNumber)
        .filter(isDefined)
    );

    issueBuilders.set(previous.id, {
      id: previous.id,
      repoId: undefined,
      repoKey: previous.repoKey,
      originIssueNumber: previous.origin.number,
      previous,
      currentIssue: undefined,
      worktrees: [],
      linkedPrNumbers: new Set(
        previous.linkedPrs
          .map((pr) => pr.number)
          .filter((num) => !packetPrNumbers.has(num))
      )
    });
  }

  for (const issue of currentIssues) {
    const id = buildIssueWorkstreamId(issue.repoOwner, issue.repoName, issue.number);
    const existing = issueBuilders.get(id);
    issueBuilders.set(id, {
      id,
      repoId: issue.repoId,
      repoKey: issue.repoKey,
      originIssueNumber: issue.number,
      previous: existing?.previous ?? undefined,
      currentIssue: issue,
      worktrees: existing?.worktrees ?? [],
      linkedPrNumbers: existing?.linkedPrNumbers ?? new Set<number>()
    });
  }

  for (const [parentId, relatedWorktrees] of worktreesByParentId) {
    const issueNumber = extractIssueNumberFromWorkstreamId(parentId);
    if (issueNumber === undefined) {
      continue;
    }

    const existing = issueBuilders.get(parentId);
    const builder: IssueWorkstreamBuilder = existing ?? {
      id: parentId,
      repoId: relatedWorktrees[0]?.repoId,
      repoKey: relatedWorktrees[0]!.repoSlug,
      originIssueNumber: issueNumber,
      previous: undefined,
      currentIssue: undefined,
      worktrees: [],
      linkedPrNumbers: new Set<number>()
    };

    for (const worktree of relatedWorktrees) {
      builder.worktrees.push(worktree);
      if (worktree.packet) {
        if (worktree.prNumber !== undefined) {
          builder.linkedPrNumbers.delete(worktree.prNumber);
        }
        const pr = currentPrsByRepoAndBranch.get(`${worktree.repoId}:${worktree.branchName}`);
        if (pr) {
          builder.linkedPrNumbers.delete(pr.number);
        }
        continue;
      }
      if (worktree.prNumber !== undefined) {
        builder.linkedPrNumbers.add(worktree.prNumber);
      }
      const pr = currentPrsByRepoAndBranch.get(`${worktree.repoId}:${worktree.branchName}`);
      if (pr) {
        builder.linkedPrNumbers.add(pr.number);
      }
    }
    issueBuilders.set(parentId, builder);
  }

  const issueWorkstreams = [...issueBuilders.values()]
    .map((builder) => {
      const sortedWorktrees = [...builder.worktrees]
        .filter((wt) => !wt.packet)
        .sort(compareWorktrees);
      const linkedPrs = [...builder.linkedPrNumbers]
        .sort((left, right) => left - right)
        .map((prNumber) =>
          buildLinkedPullRequest(
            builder.previous,
            currentPrsByRepoAndNumber.get(`${builder.repoId ?? builder.currentIssue?.repoId}:${prNumber}`),
            prNumber,
            "implementation"
          )
        );
      const activeWorktree = pickActiveWorktree(sortedWorktrees);
      const repoId = builder.repoId ?? builder.currentIssue?.repoId;
      const activePrNumber =
        activeWorktree?.prNumber ??
        (activeWorktree
          ? currentPrsByRepoAndBranch.get(`${activeWorktree.repoId}:${activeWorktree.branchName}`)?.number
          : undefined) ??
        pickActivePrNumber(linkedPrs, currentPrsByRepoAndNumber, repoId);
      const activePullRequest =
        activePrNumber !== undefined && repoId !== undefined
          ? currentPrsByRepoAndNumber.get(`${repoId}:${activePrNumber}`)
          : undefined;
      const repo = reposById.get(repoId ?? "");
      const status = deriveIssueStatus(
        builder.currentIssue,
        linkedPrs,
        currentPrsByRepoAndNumber,
        repoId,
        builder.previous?.status
      );
      const resolution = deriveResolution(
        linkedPrs,
        currentPrsByRepoAndNumber,
        repoId,
        builder.previous?.resolution
      );

      const integration = deriveIntegrationState(
        activePullRequest,
        activePrNumber,
        activeWorktree,
        builder.previous,
        repo?.defaultBranch
      );

      const previousPacketPlan = builder.previous?.packetPlan;
      let packetPlan = previousPacketPlan && repoId
        ? markMergedPacketPullRequests({
            packetPlan: previousPacketPlan,
            parentWorkstreamId: builder.id,
            parentIntegrationBranch: integration?.branchName ?? builder.previous?.integration?.branchName,
            repoId,
            packetWorktrees: builder.worktrees,
            pullRequests: currentPullRequests
          })
        : previousPacketPlan;

      const nextPhase = reduceWorkstreamPhase({
        previousPhase: builder.previous?.phase,
        originType: "issue",
        issuePresent: builder.currentIssue !== undefined,
        activePullRequestState: activePullRequest?.state,
        activePullRequestLabels: activePullRequest?.labels ?? [],
        attentionReasons: attentionByWorkstreamId.get(builder.id)?.reasons ?? [],
        inProgressLabel: repo?.labels.agentInProgress,
        reviewLabel: repo?.labels.agentReview,
        approvalLabel: repo?.labels.agentPlanApproved,
        activeWorktreeStatus: activeWorktree?.status,
        status,
        resolution
      });
      const product = deriveProductState({
        repo,
        issue: builder.currentIssue,
        previous: builder.previous,
        activeWorktree,
        nextPhase,
        now: input.attention?.find((record) => record.workstreamId === builder.id)?.lastObservedAt
      });

      if (packetPlan) {
        const packets = Object.values(packetPlan.packets);
        const allMerged = packets.length > 0 && packets.every((p) => p.status === "merged_to_parent");
        const anyStarted = packets.some((p) => p.status !== "planned");
        const reasons = attentionByWorkstreamId.get(builder.id)?.reasons ?? [];

        // Treat nextPhase === "implementation_ready", "implementing", or "implementation_done" as a plan approval signal.
        // This is safe because a workstream cannot transition into or remain in these implementation phases
        // without the plan first being approved. Checking this early nextPhase value helps eliminate
        // the one-cycle lag that would occur if we only relied on the previous cycle's phase.
        const hasApproval = reasons.includes("plan_approved") ||
                            nextPhase === "implementation_ready" ||
                            nextPhase === "implementing" ||
                            nextPhase === "implementation_done";

        let newStatus: typeof packetPlan.status = packetPlan.status;
        if (allMerged) {
          newStatus = "complete";
        } else if (anyStarted || nextPhase === "implementing") {
          newStatus = "in_progress";
        } else if (hasApproval) {
          newStatus = "approved";
        } else {
          const wasApproved = packetPlan.status === "approved";
          const prevPhase = builder.previous?.phase as string | undefined;

          // If the plan was previously approved and we were already in an implementation phase,
          // but we no longer have approval (e.g. the plan approval label was explicitly removed),
          // we transition back to "proposed".
          // If the previous phase was something else (e.g. "planning" or "plan_feedback") and we
          // don't have approval now, we preserve the "approved" status. This protects the approved status
          // from being lost during transient cycle run failures or when the plan breakdown is re-evaluating.
          const lostApproval = wasApproved &&
                               (prevPhase === "implementation_ready" ||
                                prevPhase === "implementing" ||
                                prevPhase === "implementation_done") &&
                               !hasApproval;
          if (lostApproval) {
            newStatus = "proposed";
          } else if (!wasApproved) {
            newStatus = "proposed";
          }
        }

        packetPlan = {
          ...packetPlan,
          status: newStatus
        };
      }

      const workstream: WorkstreamRecord = {
        id: builder.id,
        repoKey: builder.repoKey,
        origin: {
          type: "issue",
          number: builder.originIssueNumber
        },
        linkedIssueNumber: builder.originIssueNumber,
        linkedPrs,
        ...(activePrNumber !== undefined ? { activePrNumber } : {}),
        ...(activeWorktree ? { activeWorktreeId: activeWorktree.id } : {}),
        phase: nextPhase,
        attention: deriveAttention(
          linkedPrs,
          currentPrsByRepoAndNumber,
          repoId,
          repo,
          builder.previous?.attention
        ),
        status,
        resolution,
        ...(product ? { product } : {}),
        ...(integration ? { integration } : {}),
        ...(packetPlan ? { packetPlan } : {}),
        ...(builder.previous?.mcpBlockers ? { mcpBlockers: builder.previous.mcpBlockers } : {}),
        ...(builder.previous?.mcpSkipExclusions ? { mcpSkipExclusions: builder.previous.mcpSkipExclusions } : {})
      };

      if (activePrNumber !== undefined) {
        workstream.activePrNumber = activePrNumber;
      }

      if (activeWorktree) {
        workstream.activeWorktreeId = activeWorktree.id;
      } else if (builder.previous?.activeWorktreeId) {
        workstream.activeWorktreeId = builder.previous.activeWorktreeId;
      }

      return workstream;
    })
    .sort(compareWorkstreams);

  const matchedPacketPrKeys = collectMatchedPacketPrKeys({
    pullRequests: currentPullRequests,
    issueWorkstreams,
    reposById,
    worktrees,
    previousPullRequestIds
  });

  // Filter out matched packet PRs from issue workstream linkedPrs.
  // These PRs are now managed as part of the packet plan and should not be treated
  // as primary implementation PRs of the issue workstream itself.
  for (const workstream of issueWorkstreams) {
    workstream.linkedPrs = workstream.linkedPrs.filter(
      (pr) => !matchedPacketPrKeys.has(buildRepoPrKey(workstream.repoKey, pr.number))
    );
  }

  const linkedIssuePrKeys = new Set(
    issueWorkstreams.flatMap((workstream) =>
      workstream.linkedPrs.map((pr) => `${workstream.repoKey}:${pr.number}`)
    )
  );

  const previousPrWorkstreams = previousWorkstreams.filter((workstream) => workstream.origin.type === "pr");

  const currentPrsByWorkstreamId = new Map(
    currentPullRequests.map((pr) => [buildPrWorkstreamId(pr.repoOwner, pr.repoName, pr.number), pr] as const)
  );

  const prWorkstreamIds = new Set([
    ...previousPrWorkstreams
      .filter((workstream) => {
        const currentPr = currentPrsByWorkstreamId.get(workstream.id);
        if (!currentPr) {
          return true;
        }
        return !matchedPacketPrKeys.has(buildRepoPrKey(currentPr.repoKey, currentPr.number));
      })
      .map((workstream) => workstream.id),
    ...currentPullRequests
      .filter((pr) => !matchedPacketPrKeys.has(buildRepoPrKey(pr.repoKey, pr.number)))
      .filter((pr) => isRelevantStandalonePr(pr, reposById.get(pr.repoId), worktrees, previousPullRequestIds))
      .map((pr) => buildPrWorkstreamId(pr.repoOwner, pr.repoName, pr.number))
  ]);

  const prWorkstreams = [...prWorkstreamIds]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => {
      const previous = previousPrWorkstreams.find((workstream) => workstream.id === id);
      const currentPr = currentPullRequests.find((pr) => buildPrWorkstreamId(pr.repoOwner, pr.repoName, pr.number) === id);
      const repoKey = currentPr?.repoKey ?? previous?.repoKey;
      const prNumber = currentPr?.number ?? previous?.origin.number;

      if (!repoKey || prNumber === undefined) {
        return undefined;
      }

      if (linkedIssuePrKeys.has(`${repoKey}:${prNumber}`)) {
        return undefined;
      }

      const repo = reposBySlug.get(repoKey as `${string}/${string}`);
      const repoId = repo?.id;

      const relatedWorktrees = worktreesByParentId.get(id) ?? [];
      const primaryWorktree =
        currentPr && repoId
          ? worktrees.find(
              (candidate) =>
                candidate.repoId === repoId &&
                candidate.branchName === currentPr.headBranch &&
                !candidate.issueId &&
                !candidate.packet
            )
          : undefined;

      const allWorktrees = primaryWorktree ? [primaryWorktree, ...relatedWorktrees] : relatedWorktrees;
      const activeWorktree = pickActiveWorktree(allWorktrees.filter((wt) => !wt.packet));

      const linkedPrNumbers = new Set<number>();
      linkedPrNumbers.add(prNumber);
      for (const wt of allWorktrees) {
        if (wt.packet) {
          continue;
        }
        if (wt.prNumber !== undefined) {
          linkedPrNumbers.add(wt.prNumber);
        }
        const packetPr = currentPrsByRepoAndBranch.get(`${wt.repoId}:${wt.branchName}`);
        if (packetPr) {
          linkedPrNumbers.add(packetPr.number);
        }
      }

      const linkedPrs = [...linkedPrNumbers]
        .sort((left, right) => left - right)
        .map((num) =>
          buildLinkedPullRequest(
            previous,
            currentPrsByRepoAndNumber.get(`${repoId}:${num}`),
            num,
            num === prNumber ? undefined : "implementation"
          )
        );

      const activePrNumber =
        activeWorktree?.prNumber ??
        (activeWorktree
          ? currentPrsByRepoAndBranch.get(`${activeWorktree.repoId}:${activeWorktree.branchName}`)?.number
          : undefined) ??
        pickActivePrNumber(linkedPrs, currentPrsByRepoAndNumber, repoId);

      const activePullRequest =
        activePrNumber !== undefined && repoId !== undefined
          ? currentPrsByRepoAndNumber.get(`${repoId}:${activePrNumber}`)
          : undefined;

      const integration = deriveIntegrationState(activePullRequest, activePrNumber, activeWorktree, previous, repo?.defaultBranch);

      const workstream: WorkstreamRecord = {
        id,
        repoKey,
        origin: {
          type: "pr",
          number: prNumber
        },
        linkedPrs,
        ...(activePrNumber !== undefined ? { activePrNumber } : {}),
        phase: reduceWorkstreamPhase({
          previousPhase: previous?.phase,
          originType: "pr",
          issuePresent: false,
          activePullRequestState: activePullRequest?.state,
          activePullRequestLabels: activePullRequest?.labels ?? [],
          attentionReasons: attentionByWorkstreamId.get(id)?.reasons ?? [],
          inProgressLabel: repo?.labels.agentInProgress,
          reviewLabel: repo?.labels.agentReview,
          approvalLabel: repo?.labels.agentPlanApproved,
          activeWorktreeStatus: activeWorktree?.status,
          status: activePullRequest ? derivePrStatus(activePullRequest) : previous?.status ?? "open",
          resolution: activePullRequest ? derivePrResolution(activePullRequest) : previous?.resolution ?? "unresolved"
        }),
        attention: activePullRequest
          ? deriveAttentionForPr(activePullRequest, repo, previous?.attention)
          : previous?.attention ?? "idle",
        status: activePullRequest ? derivePrStatus(activePullRequest) : previous?.status ?? "open",
        resolution: activePullRequest ? derivePrResolution(activePullRequest) : previous?.resolution ?? "unresolved",
        ...(integration ? { integration } : {}),
        ...(previous?.packetPlan ? { packetPlan: previous.packetPlan } : {}),
        ...(previous?.mcpBlockers ? { mcpBlockers: previous.mcpBlockers } : {}),
        ...(previous?.mcpSkipExclusions ? { mcpSkipExclusions: previous.mcpSkipExclusions } : {})
      };

      if (activeWorktree) {
        workstream.activeWorktreeId = activeWorktree.id;
      } else if (previous?.activeWorktreeId) {
        workstream.activeWorktreeId = previous.activeWorktreeId;
      }

      return workstream;
    })
    .filter(isDefined);

  return [...issueWorkstreams, ...prWorkstreams].sort(compareWorkstreams);
}

function buildLinkedPullRequest(
  previous: WorkstreamRecord | undefined,
  currentPr: NormalizedPullRequest | undefined,
  prNumber: number,
  defaultRole?: string
): WorkstreamLinkedPullRequest {
  const previousPr = previous?.linkedPrs.find((pr) => pr.number === prNumber);
  const linkedPr: WorkstreamLinkedPullRequest = {
    number: prNumber
  };

  if (currentPr?.state) {
    linkedPr.status = currentPr.state;
  } else if (previousPr?.status) {
    linkedPr.status = previousPr.status;
  }

  const role = defaultRole ?? previousPr?.role;
  if (role !== undefined) {
    linkedPr.role = role;
  }

  return linkedPr;
}

function deriveAttention(
  linkedPrs: WorkstreamLinkedPullRequest[],
  currentPrsByRepoAndNumber: Map<string, NormalizedPullRequest>,
  repoId: string | undefined,
  repo: RepoConfig | undefined,
  previousAttention: WorkstreamAttention | undefined
): WorkstreamAttention {
  if (repoId !== undefined && repo) {
    for (const linkedPr of linkedPrs) {
      const pr = currentPrsByRepoAndNumber.get(`${repoId}:${linkedPr.number}`);
      if (pr?.labels.includes(repo.labels.agentReview)) {
        return "review_requested";
      }
      if (pr?.labels.includes(repo.labels.prepareForMerge)) {
        return "prepare_for_merge_requested";
      }
    }
  }

  return previousAttention ?? "idle";
}

function deriveAttentionForPr(
  pr: NormalizedPullRequest,
  repo: RepoConfig | undefined,
  previousAttention: WorkstreamAttention | undefined
): WorkstreamAttention {
  if (repo) {
    if (pr.labels.includes(repo.labels.agentReview)) {
      return "review_requested";
    }
    if (pr.labels.includes(repo.labels.prepareForMerge)) {
      return "prepare_for_merge_requested";
    }
  }

  return previousAttention ?? "idle";
}

function deriveIssueStatus(
  issue: NormalizedIssue | undefined,
  linkedPrs: WorkstreamLinkedPullRequest[],
  currentPrsByRepoAndNumber: Map<string, NormalizedPullRequest>,
  repoId: string | undefined,
  previousStatus: WorkstreamStatus | undefined
): WorkstreamStatus {
  if (repoId !== undefined) {
    for (const linkedPr of linkedPrs) {
      const pr = currentPrsByRepoAndNumber.get(`${repoId}:${linkedPr.number}`);
      if (pr?.state === "merged") {
        return "merged";
      }
    }
  }

  if (issue?.state === "closed") {
    return "closed";
  }

  // listOpenIssues only returns open issues. If an issue was previously tracked
  // as open but is absent from the current scan, it has been closed on GitHub.
  if (issue === undefined && previousStatus === "open") {
    return "closed";
  }

  return previousStatus ?? "open";
}

function derivePrStatus(pr: NormalizedPullRequest): WorkstreamStatus {
  if (pr.state === "merged") {
    return "merged";
  }

  if (pr.state === "closed") {
    return "closed";
  }

  return "open";
}

function deriveResolution(
  linkedPrs: WorkstreamLinkedPullRequest[],
  currentPrsByRepoAndNumber: Map<string, NormalizedPullRequest>,
  repoId: string | undefined,
  previousResolution: WorkstreamResolution | undefined
): WorkstreamResolution {
  if (repoId !== undefined) {
    for (const linkedPr of linkedPrs) {
      const pr = currentPrsByRepoAndNumber.get(`${repoId}:${linkedPr.number}`);
      if (pr?.state === "merged") {
        return "merged";
      }
    }
  }

  return previousResolution ?? "unresolved";
}

function derivePrResolution(pr: NormalizedPullRequest): WorkstreamResolution {
  if (pr.state === "merged") {
    return "merged";
  }

  if (pr.state === "closed") {
    return "closed";
  }

  return "unresolved";
}

function pickActiveWorktree(worktrees: WorktreeRecord[]): WorktreeRecord | undefined {
  return [...worktrees].sort((left, right) => {
    const updatedComparison = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedComparison !== 0) {
      return updatedComparison;
    }

    return left.id.localeCompare(right.id);
  })[0];
}

function pickActivePrNumber(
  linkedPrs: WorkstreamLinkedPullRequest[],
  currentPrsByRepoAndNumber: Map<string, NormalizedPullRequest>,
  repoId: string | undefined
): number | undefined {
  if (repoId !== undefined) {
    const currentOpenPr = linkedPrs
      .map((pr) => currentPrsByRepoAndNumber.get(`${repoId}:${pr.number}`))
      .filter((pr): pr is NormalizedPullRequest => pr !== undefined)
      .sort(comparePullRequests)[0];
    if (currentOpenPr) {
      return currentOpenPr.number;
    }
  }

  return linkedPrs[0]?.number;
}

function isRelevantStandalonePr(
  pr: NormalizedPullRequest,
  repo: RepoConfig | undefined,
  worktrees: WorktreeRecord[],
  previousPullRequestIds: Set<string>
): boolean {
  if (!repo) {
    return false;
  }

  if (
    pr.labels.includes(repo.labels.agentReview) ||
    pr.labels.includes(repo.labels.agentInProgress) ||
    pr.labels.includes(repo.labels.agentPlanApproved) ||
    pr.labels.includes(repo.labels.planBreakdownNeeded) ||
    pr.labels.includes(repo.labels.prepareForMerge)
  ) {
    return true;
  }

  if (previousPullRequestIds.has(pr.id)) {
    return true;
  }

  return worktrees.some((worktree) => worktree.repoId === pr.repoId && worktree.branchName === pr.headBranch);
}

function getIssueWorkstreamIdForWorktree(worktree: WorktreeRecord): string | undefined {
  if (worktree.issueNumber === undefined) {
    return undefined;
  }

  const [owner, name] = worktree.repoSlug.split("/");
  if (!owner || !name) {
    return undefined;
  }

  return buildIssueWorkstreamId(owner, name, worktree.issueNumber);
}

function extractIssueNumberFromWorkstreamId(workstreamId: string): number | undefined {
  const match = workstreamId.match(/:issue:(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function buildIssueWorkstreamId(owner: string, name: string, issueNumber: number): string {
  return `${owner}/${name}:issue:${issueNumber}`;
}

function buildPrWorkstreamId(owner: string, name: string, prNumber: number): string {
  return `${owner}/${name}:pr:${prNumber}`;
}

function compareIssues(left: NormalizedIssue, right: NormalizedIssue): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.number - right.number;
}

function comparePullRequests(left: NormalizedPullRequest, right: NormalizedPullRequest): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.number - right.number;
}

function compareWorktrees(left: WorktreeRecord, right: WorktreeRecord): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareWorkstreams(left: WorkstreamRecord, right: WorkstreamRecord): number {
  const repoComparison = left.repoKey.localeCompare(right.repoKey);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.id.localeCompare(right.id);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function deriveIntegrationState(
  activePullRequest: NormalizedPullRequest | undefined,
  activePrNumber: number | undefined,
  activeWorktree: WorktreeRecord | undefined,
  previous: WorkstreamRecord | undefined,
  defaultBranch?: string
): WorkstreamIntegrationState | undefined {
  if (activePullRequest) {
    if (activePullRequest.baseBranch !== activePullRequest.defaultBranch) {
      return undefined;
    }

    return {
      branchName: activePullRequest.headBranch,
      prNumber: activePrNumber
    };
  }

  if (activeWorktree) {
    if (
      defaultBranch !== undefined &&
      activeWorktree.baseBranch !== undefined &&
      activeWorktree.baseBranch !== defaultBranch
    ) {
      return undefined;
    }

    return {
      branchName: activeWorktree.branchName,
      prNumber: activePrNumber
    };
  }

  if (previous?.integration) {
    return previous.integration;
  }

  return undefined;
}

function buildRepoPrKey(repoKey: string, prNumber: number): string {
  return `${repoKey}#${prNumber}`;
}

function collectMatchedPacketPrKeys(input: {
  pullRequests: NormalizedPullRequest[];
  issueWorkstreams: WorkstreamRecord[];
  reposById: Map<string, RepoConfig>;
  worktrees: WorktreeRecord[];
  previousPullRequestIds: Set<string>;
}): Set<string> {
  const activeParentIntegrationBranchesByRepo = new Map<string, Set<string>>();

  for (const workstream of input.issueWorkstreams) {
    if (
      workstream.status === "open" &&
      workstream.resolution === "unresolved" &&
      workstream.integration?.branchName !== undefined
    ) {
      if (!activeParentIntegrationBranchesByRepo.has(workstream.repoKey)) {
        activeParentIntegrationBranchesByRepo.set(workstream.repoKey, new Set());
      }
      activeParentIntegrationBranchesByRepo.get(workstream.repoKey)!.add(workstream.integration.branchName);
    }
  }

  for (const pr of input.pullRequests) {
    if (pr.baseClassification === "top_level" && pr.state === "open") {
      const repo = input.reposById.get(pr.repoId);
      if (isRelevantStandalonePr(pr, repo, input.worktrees, input.previousPullRequestIds)) {
        if (!activeParentIntegrationBranchesByRepo.has(pr.repoKey)) {
          activeParentIntegrationBranchesByRepo.set(pr.repoKey, new Set());
        }
        activeParentIntegrationBranchesByRepo.get(pr.repoKey)!.add(pr.headBranch);
      }
    }
  }

  const matched = new Set<string>();

  for (const pr of input.pullRequests) {
    if (pr.baseClassification !== "non_default_parent") {
      continue;
    }

    const branches = activeParentIntegrationBranchesByRepo.get(pr.repoKey);
    if (branches?.has(pr.baseBranch)) {
      matched.add(buildRepoPrKey(pr.repoKey, pr.number));
    }
  }

  return matched;
}
