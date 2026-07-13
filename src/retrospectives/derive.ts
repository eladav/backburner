import type { AgentConfig } from "../config/types.js";
import type {
  TaskRecord,
  TaskKind,
} from "../tasks/types.js";
import type {
  RetrospectiveCandidateRecord,
  RetrospectiveProblemRecord,
  LearningOpportunityRecord,
  LearningProposalRecord,
} from "./types.js";
import type { ContextBuilder } from "../context/types.js";
import { workflowRegistry } from "../workflows/registry.js";

export interface DeriveRetrospectiveTasksInput {
  existingTasks: TaskRecord[];
  candidates: RetrospectiveCandidateRecord[];
  problems: RetrospectiveProblemRecord[];
  opportunities: LearningOpportunityRecord[];
  proposals: LearningProposalRecord[];
  agents: AgentConfig[];
  contextBuilder: ContextBuilder;
  now: string;
}

export interface DeriveRetrospectiveTasksResult {
  tasks: TaskRecord[];
  candidates: RetrospectiveCandidateRecord[];
  problems: RetrospectiveProblemRecord[];
  opportunities: LearningOpportunityRecord[];
  blocked: Array<{ sourceId: string; reason: string }>;
}

const RETROSPECTIVE_TASK_KINDS: TaskKind[] = [
  "extract_retrospective_problems",
  "investigate_learning_opportunity",
  "draft_management_learning_proposal",
];

export function deriveRetrospectiveTasks(
  input: DeriveRetrospectiveTasksInput
): DeriveRetrospectiveTasksResult {
  const {
    existingTasks,
    candidates,
    problems,
    opportunities,
    agents,
    contextBuilder,
    now,
  } = input;

  const resultTasks: TaskRecord[] = [];
  const resultCandidates = [...candidates];
  const resultProblems = [...problems];
  const resultOpportunities = [...opportunities];
  const blocked: Array<{ sourceId: string; reason: string }> = [];

  // 1. Check idleness
  const hasPendingOperationalTasks = existingTasks.some(
    (t) =>
      (t.status === "pending" || t.status === "dispatched") &&
      !RETROSPECTIVE_TASK_KINDS.includes(t.kind) &&
      t.relevant
  );

  if (hasPendingOperationalTasks) {
    return {
      tasks: [],
      candidates: resultCandidates,
      problems: resultProblems,
      opportunities: resultOpportunities,
      blocked: [],
    };
  }

  // 2. Check if we already have a retrospective task in flight
  const hasInFlightRetrospectiveTask = existingTasks.some(
    (t) =>
      (t.status === "pending" || t.status === "dispatched") &&
      RETROSPECTIVE_TASK_KINDS.includes(t.kind)
  );

  if (hasInFlightRetrospectiveTask) {
    return {
      tasks: [],
      candidates: resultCandidates,
      problems: resultProblems,
      opportunities: resultOpportunities,
      blocked: [],
    };
  }

  // 3. Check for retrospective agent role
  const hasRetrospectiveAgent = agents.some(
    (a) => a.enabled && a.modelClass === "strong" && a.roles.includes("retrospective")
  );

  const NO_AGENT_REASON = 'No enabled strong agent is configured for role "retrospective".';

  // 4. Derivation in priority order: Extraction > Investigation > Proposal

  // A. Candidate to Extraction
  const eligibleCandidates = resultCandidates
    .filter((c) => c.status === "new" || c.status === "blocked")
    .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.id.localeCompare(b.id));

  for (const candidate of eligibleCandidates) {
    if (!hasRetrospectiveAgent) {
      candidate.status = "blocked";
      candidate.skipReason = NO_AGENT_REASON;
      candidate.updatedAt = now;
      blocked.push({ sourceId: candidate.id, reason: NO_AGENT_REASON });
      continue;
    }

    const taskId = `extract_retrospective_problems:${candidate.id}`;
    if (existingTasks.some((t) => t.id === taskId)) continue;

    const task = createTask(
      taskId,
      "extract_retrospective_problems",
      "retrospective_candidate",
      candidate.id,
      candidate.url || `https://github.com/${candidate.repoSlug}`,
      candidate.repoId,
      candidate.repoSlug,
      `Extracting problems from candidate ${candidate.id}`,
      contextBuilder,
      now,
      candidate
    );

      candidate.status = "extracting";
    candidate.updatedAt = now;

    return {
      tasks: [task],
      candidates: resultCandidates,
      problems: resultProblems,
      opportunities: resultOpportunities,
      blocked: [],
    };
  }

  // B. Problem to Investigation
  const eligibleProblems = resultProblems
    .filter((p) => (p.status === "pending" || p.status === "blocked") && p.thresholdDecision === "pass")
    .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.id.localeCompare(b.id));

  for (const problem of eligibleProblems) {
    if (!hasRetrospectiveAgent) {
      problem.status = "blocked";
      problem.decisionReason = NO_AGENT_REASON;
      problem.updatedAt = now;
      blocked.push({ sourceId: problem.id, reason: NO_AGENT_REASON });
      continue;
    }

    const taskId = `investigate_learning_opportunity:${problem.id}`;
    if (existingTasks.some((t) => t.id === taskId)) continue;

    const candidate = resultCandidates.find(c => c.id === problem.candidateId);
    const repoId = candidate?.repoId || problem.affectedRepoIds[0] || "unknown";
    const repoSlug = candidate?.repoSlug || problem.affectedRepoIds[0] || "unknown";

    const task = createTask(
      taskId,
      "investigate_learning_opportunity",
      "retrospective_problem",
      problem.id,
      `https://github.com/${repoSlug}`,
      repoId,
      repoSlug,
      `Investigating learning opportunity for problem ${problem.id}`,
      contextBuilder,
      now,
      undefined,
      problem
    );

    problem.status = "investigating";
    problem.updatedAt = now;

    return {
      tasks: [task],
      candidates: resultCandidates,
      problems: resultProblems,
      opportunities: resultOpportunities,
      blocked: [],
    };
  }

  // C. Opportunity to Proposal
  const eligibleOpportunities = resultOpportunities
    .filter((o) => (o.status === "investigated" || o.status === "blocked"))
    .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.id.localeCompare(b.id));

  for (const opportunity of eligibleOpportunities) {
    // Check if proposal already exists
    if (input.proposals.some(p => p.opportunityId === opportunity.id)) continue;

    if (!hasRetrospectiveAgent) {
      opportunity.status = "blocked";
      opportunity.decisionReason = NO_AGENT_REASON;
      opportunity.updatedAt = now;
      blocked.push({ sourceId: opportunity.id, reason: NO_AGENT_REASON });
      continue;
    }

    const taskId = `draft_management_learning_proposal:${opportunity.id}`;
    if (existingTasks.some((t) => t.id === taskId)) continue;

    // We need a repo for the task. We use the one from the problem/candidate if possible.
    const problem = problems.find(p => p.id === opportunity.problemId);
    const candidate = resultCandidates.find(c => c.id === problem?.candidateId);
    const repoId = candidate?.repoId || problem?.affectedRepoIds[0] || "unknown";
    const repoSlug = candidate?.repoSlug || problem?.affectedRepoIds[0] || "unknown";

    const task = createTask(
      taskId,
      "draft_management_learning_proposal",
      "learning_opportunity",
      opportunity.id,
      `https://github.com/${repoSlug}`,
      repoId,
      repoSlug,
      `Drafting learning proposal for opportunity ${opportunity.id}`,
      contextBuilder,
      now,
      undefined,
      undefined,
      opportunity
    );

    return {
      tasks: [task],
      candidates: resultCandidates,
      problems: resultProblems,
      opportunities: resultOpportunities,
      blocked: [],
    };
  }

  return {
    tasks: [],
    candidates: resultCandidates,
    problems: resultProblems,
    opportunities: resultOpportunities,
    blocked,
  };
}

function createTask(
  id: string,
  kind: TaskKind,
  sourceKind: any,
  sourceId: string,
  sourceUrl: string,
  repoId: string,
  repoSlug: string,
  summary: string,
  contextBuilder: ContextBuilder,
  now: string,
  candidate?: RetrospectiveCandidateRecord,
  problem?: RetrospectiveProblemRecord,
  opportunity?: LearningOpportunityRecord
): TaskRecord {
  const policy = workflowRegistry.resolveTaskExecutionPolicy(kind);

  const context = contextBuilder.build({
    taskKind: kind,
    repoIdentifier: repoSlug,
    sourceKind,
    sourceUrl,
    labels: [],
    ...(candidate ? { retrospectiveCandidate: candidate } : {}),
    ...(problem ? { retrospectiveProblem: problem } : {}),
    ...(opportunity ? { learningOpportunity: opportunity } : {}),
  });

  return {
    id,
    kind,
    status: "pending",
    executionPermission: policy.executionPermission,
    handoffPolicy: policy.handoffPolicy,
    repoId,
    repoName: repoSlug,
    repoSlug,
    sourceKind,
    sourceId,
    sourceUrl,
    relevant: true,
    reason: "Idle retrospective work",
    summary,
    context,
    createdAt: now,
    updatedAt: now,
  };
}
