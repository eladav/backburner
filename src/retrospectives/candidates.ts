import type {
  ExecutionRecord,
  TaskRecord,
  WorkstreamRecord,
  WorktreeRecord,
} from "../state/types.js";
import type {
  NormalizedIssue,
  NormalizedPullRequest,
} from "../domain/entities.js";
import type {
  ManagementPrRecord,
  RetrospectiveCandidateRecord,
  RetrospectiveEvidenceReference,
} from "./types.js";
import { classifyManagementPullRequest, type ClassifyPullRequestInput } from "../github/pr-classification.js";
import { workflowRegistry } from "../workflows/registry.js";

export interface RegisterRetrospectiveCandidatesInput {
  previousCandidates: RetrospectiveCandidateRecord[];
  workstreams: WorkstreamRecord[];
  issues: NormalizedIssue[];
  pullRequests: NormalizedPullRequest[];
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  worktrees: WorktreeRecord[];
  managementPrs: ManagementPrRecord[];
  classifyPullRequest?: typeof classifyManagementPullRequest;
  managementRepo?: { repoId?: string; repoSlug?: string };
  now: string;
}

export interface RegisterRetrospectiveCandidatesResult {
  candidates: RetrospectiveCandidateRecord[];
  registered: RetrospectiveCandidateRecord[];
  skipped: Array<{ workstreamId: string; reason: string }>;
}

export function registerRetrospectiveCandidates(
  input: RegisterRetrospectiveCandidatesInput
): RegisterRetrospectiveCandidatesResult {
  const {
    previousCandidates,
    workstreams,
    issues,
    pullRequests,
    tasks,
    executions,
    managementPrs,
    classifyPullRequest = classifyManagementPullRequest,
    managementRepo,
    now,
  } = input;

  const candidatesMap = new Map<string, RetrospectiveCandidateRecord>();
  for (const prev of previousCandidates) {
    candidatesMap.set(prev.id, prev);
  }

  const registered: RetrospectiveCandidateRecord[] = [];
  const skipped: Array<{ workstreamId: string; reason: string }> = [];

  for (const workstream of workstreams) {
    // 1. Consider only terminal workstreams
    const isPhaseTerminal =
      workstream.phase === "resolved" || workstream.phase === "abandoned";
    const isStatusMergedOrClosed =
      (workstream.status === "closed" && workstream.resolution === "closed") ||
      (workstream.status === "merged" && workstream.resolution === "merged");

    if (!isPhaseTerminal && !isStatusMergedOrClosed) {
      // 2. Do not register open/unresolved workstreams
      continue;
    }

    if (workstream.resolution !== "closed" && workstream.resolution !== "merged") {
      continue; // Extra safety check based on plan text
    }

    // Identify candidate PRs to classify
    const prsToClassify: { number: number; headBranch?: string; baseBranch?: string }[] = [];
    if (workstream.origin.type === "pr") {
      const pr = pullRequests.find(
        (p) => p.number === workstream.origin.number && p.repoSlug === workstream.repoKey
      );
      if (pr) {
        prsToClassify.push({
          number: pr.number,
          headBranch: pr.headBranch,
          baseBranch: pr.baseBranch,
        });
      } else {
        prsToClassify.push({ number: workstream.origin.number });
      }
    } else {
      for (const linkedPr of workstream.linkedPrs) {
        const pr = pullRequests.find(
          (p) => p.number === linkedPr.number && p.repoSlug === workstream.repoKey
        );
        if (pr) {
          prsToClassify.push({
            number: pr.number,
            headBranch: pr.headBranch,
            baseBranch: pr.baseBranch,
          });
        } else {
          prsToClassify.push({ number: linkedPr.number });
        }
      }
      if (workstream.activePrNumber) {
        const alreadyIncluded = prsToClassify.some(p => p.number === workstream.activePrNumber);
        if (!alreadyIncluded) {
            const pr = pullRequests.find(
              (p) => p.number === workstream.activePrNumber && p.repoSlug === workstream.repoKey
            );
            if (pr) {
              prsToClassify.push({
                number: pr.number,
                headBranch: pr.headBranch,
                baseBranch: pr.baseBranch,
              });
            } else {
              prsToClassify.push({ number: workstream.activePrNumber });
            }
        }
      }
    }

    // 3. Skip management PR workstreams using early classifier
    let skipReason = "";
    for (const prData of prsToClassify) {
      const classificationInput: ClassifyPullRequestInput = {
        repoId: workstream.repoKey,
        repoSlug: workstream.repoKey,
        pullRequestNumber: prData.number,
        managementPrs,
      };
      if (prData.headBranch !== undefined) classificationInput.headBranch = prData.headBranch;
      if (prData.baseBranch !== undefined) classificationInput.baseBranch = prData.baseBranch;
      if (managementRepo !== undefined) classificationInput.managementRepo = managementRepo;

      const classification = classifyPullRequest(classificationInput);

      if (classification.kind === "management") {
        skipReason = `Origin or linked PR #${prData.number} classified as management: ${classification.reason}`;
        break;
      }
    }

    if (skipReason) {
      skipped.push({ workstreamId: workstream.id, reason: skipReason });
      continue;
    }

    const repoSlug = workstream.repoKey;
    const originType = workstream.origin.type;
    const originNumber = workstream.origin.number;
    const resolution = workstream.resolution;

    // Stable candidate key
    const id = `retrospective-candidate:${repoSlug}:${workstream.id}:${originType}-${originNumber}:${resolution}`;

    // 5. Preserve existing candidate records
    if (candidatesMap.has(id)) {
      continue;
    }

    const workstreamTasks = tasks.filter((t) => t.workstreamId === workstream.id);
    const taskIds = workstreamTasks.map((t) => t.id);
    const workstreamExecutions = executions.filter((e) => taskIds.includes(e.taskId));

    const taskSummary: RetrospectiveCandidateRecord["taskSummary"] = {
      total: workstreamTasks.length,
      completed: workstreamTasks.filter((t) => t.status === "completed").length,
      failed: workstreamTasks.filter((t) => t.status === "failed").length,
      kinds: Array.from(new Set(workstreamTasks.map((t) => t.kind))) as import("../tasks/types.js").TaskKind[],
      taskIds,
    };

    const lastExecutionId = workstreamExecutions.length > 0
      ? workstreamExecutions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id
      : undefined;
    if (lastExecutionId !== undefined) {
      taskSummary.lastExecutionId = lastExecutionId;
    }

    const executionRoles = new Set<import("../agents/types.js").AgentStrategyRole>();
    for (const execution of workstreamExecutions) {
      const task = workstreamTasks.find((t) => t.id === execution.taskId);
      if (task) {
        try {
          const definition = workflowRegistry.getDefinition(task.kind);
          executionRoles.add(definition.role);
        } catch (e) {
          // Ignore unregistered task kinds for role derivation
        }
      }
    }

    const executionSummary: RetrospectiveCandidateRecord["executionSummary"] = {
      total: workstreamExecutions.length,
      providers: Array.from(new Set(workstreamExecutions.map((e) => e.agentProvider).filter(p => p !== "unassigned"))) as import("../config/types.js").AgentProvider[],
      models: Array.from(new Set(workstreamExecutions.map((e) => e.agentModel).filter(Boolean) as string[])),
      roles: Array.from(executionRoles),
      executionIds: workstreamExecutions.map((e) => e.id),
    };

    let title = "";
    let url = "";
    const labels: string[] = [];
    let repoIdForCandidate = repoSlug;

    if (originType === "issue") {
      const issue = issues.find(i => i.number === originNumber && i.repoSlug === repoSlug);
      if (issue) {
        title = issue.title;
        url = issue.url;
        labels.push(...issue.labels);
        repoIdForCandidate = issue.repoId;
      }
    } else {
      const pr = pullRequests.find(p => p.number === originNumber && p.repoSlug === repoSlug);
      if (pr) {
        title = pr.title;
        url = pr.url;
        labels.push(...pr.labels);
        repoIdForCandidate = pr.repoId;
      }
    }

    const artifactReferences: string[] = [];
    workstreamExecutions.forEach((e) => {
        artifactReferences.push(e.promptArtifactPath);
        artifactReferences.push(e.stdoutArtifactPath);
        artifactReferences.push(e.stderrArtifactPath);
        artifactReferences.push(e.promptPacketPath);
        if (e.streamArtifactPath) artifactReferences.push(e.streamArtifactPath);
        if (e.settingsArtifactPath) artifactReferences.push(e.settingsArtifactPath);
    });

    const evidenceReferences: RetrospectiveEvidenceReference[] = [];
    evidenceReferences.push({
      kind: "workstream",
      id: workstream.id,
    });
    evidenceReferences.push({
      kind: originType === "issue" ? "issue" : "pull_request",
      id: `${repoSlug}#${originNumber}`,
      url,
    });

    const candidate: RetrospectiveCandidateRecord = {
      id,
      sourceWorkstreamId: workstream.id,
      repoId: repoIdForCandidate,
      repoSlug,
      repoKey: workstream.repoKey,
      origin: {
        type: originType as "issue" | "pull_request",
        number: originNumber,
      },
      terminalResolution: resolution as "closed" | "merged",
      detectedAt: now,
      resolvedAt: now, // Since we only pick terminal workstreams
      status: "new",
      title,
      url,
      labels,
      sourceSummary: `Terminal operational workstream ${workstream.id}`,
      taskSummary,
      executionSummary,
      artifactReferences,
      evidenceReferences,
    };

    candidatesMap.set(id, candidate);
    registered.push(candidate);
  }

  // 6. Sort the returned candidates deterministically
  const candidates = Array.from(candidatesMap.values()).sort((a, b) => {
    const repoComparison = a.repoSlug.localeCompare(b.repoSlug);
    if (repoComparison !== 0) return repoComparison;

    const workstreamComparison = a.sourceWorkstreamId.localeCompare(b.sourceWorkstreamId);
    if (workstreamComparison !== 0) return workstreamComparison;

    return a.id.localeCompare(b.id);
  });

  return {
    candidates,
    registered,
    skipped,
  };
}
