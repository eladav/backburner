import type {
  ExecutionRecord,
  TaskRecord,
} from "../state/types.js";
import {
  type RetrospectiveCandidateRecord,
  type RetrospectiveProblemRecord,
  type LearningOpportunityRecord,
  type LearningProposalRecord,
  type RetrospectiveBand,
} from "./types.js";
import { normalizeRetrospectiveScopes } from "./scopes.js";


export type ArtifactReader = (path: string) => Promise<string>;

export interface IngestRetrospectiveExecutionsInput {
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  candidates: RetrospectiveCandidateRecord[];
  problems: RetrospectiveProblemRecord[];
  opportunities: LearningOpportunityRecord[];
  proposals: LearningProposalRecord[];
  readArtifact: ArtifactReader;
  now: string;
}

export interface IngestRetrospectiveExecutionsResult {
  candidates: RetrospectiveCandidateRecord[];
  problems: RetrospectiveProblemRecord[];
  opportunities: LearningOpportunityRecord[];
  proposals: LearningProposalRecord[];
  consumedExecutionIds: string[];
  declined: Array<{ executionId: string; taskId: string; reason: string }>;
}

export async function ingestRetrospectiveExecutions(
  input: IngestRetrospectiveExecutionsInput
): Promise<IngestRetrospectiveExecutionsResult> {
  const {
    tasks,
    executions,
    candidates,
    problems,
    opportunities,
    proposals,
    readArtifact,
    now,
  } = input;

  const resultCandidates = [...candidates];
  const resultProblems = [...problems];
  const resultOpportunities = [...opportunities];
  const resultProposals = [...proposals];
  const consumedExecutionIds: string[] = [];
  const declined: Array<{ executionId: string; taskId: string; reason: string }> = [];

  // Filter for retrospective tasks and completed executions
  const retrospectiveTasks = tasks.filter((t) =>
    [
      "extract_retrospective_problems",
      "investigate_learning_opportunity",
      "draft_management_learning_proposal",
    ].includes(t.kind)
  );

  const completedExecutions = executions.filter(
    (e) =>
      e.taskStatus === "completed" &&
      retrospectiveTasks.some((t) => t.id === e.taskId)
  );

  for (const execution of completedExecutions) {
    const task = retrospectiveTasks.find((t) => t.id === execution.taskId)!;

    // Skip if already consumed
    if (isExecutionConsumed(execution.id, resultCandidates, resultProblems, resultOpportunities, resultProposals)) {
      continue;
    }

    try {
      const stdout = await readArtifact(execution.stdoutArtifactPath);
      const json = extractJson(stdout);

      if (!json) {
        throw new Error("No valid JSON found in stdout");
      }

      switch (task.kind) {
        case "extract_retrospective_problems":
          await ingestExtraction(json, execution, task, resultCandidates, resultProblems, now);
          break;
        case "investigate_learning_opportunity":
          await ingestInvestigation(json, execution, task, resultProblems, resultOpportunities, now);
          break;
        case "draft_management_learning_proposal":
          await ingestProposal(json, execution, task, resultOpportunities, resultProposals, now);
          break;
      }

      consumedExecutionIds.push(execution.id);
    } catch (err) {
      const reason = (err as Error).message;
      declined.push({ executionId: execution.id, taskId: execution.taskId, reason });
      handleIngestionFailure(execution, task, resultCandidates, resultProblems, resultOpportunities, resultProposals, reason, now);
    }
  }

  return {
    candidates: resultCandidates,
    problems: resultProblems,
    opportunities: resultOpportunities,
    proposals: resultProposals,
    consumedExecutionIds,
    declined,
  };
}

function isExecutionConsumed(
  executionId: string,
  candidates: RetrospectiveCandidateRecord[],
  problems: RetrospectiveProblemRecord[],
  opportunities: LearningOpportunityRecord[],
  proposals: LearningProposalRecord[]
): boolean {
  return (
    candidates.some((c) => c.sourceExecutionId === executionId) ||
    problems.some((p) => p.sourceExecutionId === executionId) ||
    opportunities.some((o) => o.sourceExecutionId === executionId) ||
    proposals.some((p) => p.sourceExecutionId === executionId)
  );
}

function extractJson(stdout: string): any {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function ingestExtraction(
  json: any,
  execution: ExecutionRecord,
  task: TaskRecord,
  candidates: RetrospectiveCandidateRecord[],
  problems: RetrospectiveProblemRecord[],
  now: string
) {
  const problemsArray = json.problems;

  let sourceItems: any[];
  let explicitEmpty = false;

  if (problemsArray !== undefined) {
    if (!Array.isArray(problemsArray)) {
      throw new Error("Field 'problems' must be an array");
    }
    sourceItems = problemsArray;
    if (sourceItems.length === 0) {
      explicitEmpty = true;
    }
  } else {
    // Fallback: treat the whole object as a single problem result
    sourceItems = [json];
  }

  // Validate all items if not explicitly empty
  if (!explicitEmpty) {
    for (const [index, prob] of sourceItems.entries()) {
      if (!validateExtractionProblem(prob, task.sourceId)) {
        const location = problemsArray !== undefined ? `at index ${index}` : "at top-level";
        throw new Error(`Invalid problem record ${location}`);
      }
    }

    // All valid, ingest them
    for (const prob of sourceItems) {
      const { semanticScopes, candidateLearningScopes } = normalizeRetrospectiveScopes({
        rawSuggestedScopes: prob.suggestedScopes,
        affectedRepoIds: prob.affectedRepos,
        roles: prob.affectedRoles,
        taskKinds: prob.affectedTaskKinds,
        providers: prob.affectedProviders,
      });

      const problemRecord: RetrospectiveProblemRecord = {
        id: `retrospective-problem:${prob.candidateId}:${hashProse(prob.problemSummary).slice(0, 8)}`,
        candidateId: prob.candidateId,
        status: "pending",
        evidenceReferences: prob.evidenceReferences,
        affectedRepoIds: prob.affectedRepos,
        roles: prob.affectedRoles,
        taskKinds: prob.affectedTaskKinds,
        providers: prob.affectedProviders,
        confidence: prob.confidence as RetrospectiveBand,
        impact: prob.impact as RetrospectiveBand,
        transferability: prob.transferability as RetrospectiveBand,
        improvementLikelihood: prob.improvementLikelihood as RetrospectiveBand,
        overfittingRisk: prob.overfittingRisk as RetrospectiveBand,
        suggestedScopes: candidateLearningScopes,
        rawSuggestedScopes: prob.suggestedScopes,
        semanticSuggestedScopes: semanticScopes,
        detectedAt: now,
        updatedAt: now,
        sourceTaskId: task.id,
        sourceExecutionId: execution.id,
        structuredObservations: prob.problemSummary + "\n\n" + prob.reasonItMightRecur,
      };
      problems.push(problemRecord);
    }
  }

  const candidate = candidates.find((c) => c.id === task.sourceId);
  if (candidate) {
    candidate.status = explicitEmpty ? "skipped" : "extracted";
    if (explicitEmpty) {
      candidate.skipReason = "Agent reported no problems found";
    } else {
      delete candidate.skipReason;
    }
    candidate.sourceExecutionId = execution.id;
    candidate.sourceTaskId = task.id;
    candidate.updatedAt = now;
  }
}

function validateExtractionProblem(prob: any, expectedCandidateId: string): boolean {
  return (
    prob.candidateId === expectedCandidateId &&
    typeof prob.problemSummary === "string" &&
    Array.isArray(prob.evidenceReferences) &&
    Array.isArray(prob.affectedRepos) &&
    Array.isArray(prob.affectedRoles) &&
    Array.isArray(prob.affectedTaskKinds) &&
    Array.isArray(prob.affectedProviders) &&
    Array.isArray(prob.suggestedScopes) &&
    typeof prob.reasonItMightRecur === "string"
  );
}

async function ingestInvestigation(
  json: any,
  execution: ExecutionRecord,
  task: TaskRecord,
  problems: RetrospectiveProblemRecord[],
  opportunities: LearningOpportunityRecord[],
  now: string
) {
  if (!validateInvestigation(json, task.sourceId)) {
    throw new Error("Invalid investigation JSON");
  }

  const opportunityRecord: LearningOpportunityRecord = {
    id: `learning-opportunity:${json.problemId}`,
    problemId: json.problemId,
    status: "investigated",
    investigationSummary: json.investigationSummary,
    investigationResult: json.investigationResult,
    selectedScope: json.selectedScope,
    evidenceReferences: json.evidenceReferences,
    detectedAt: now,
    updatedAt: now,
    sourceTaskId: task.id,
    sourceExecutionId: execution.id,
  };

  opportunities.push(opportunityRecord);

  const problem = problems.find((p) => p.id === task.sourceId);
  if (problem) {
    problem.status = "completed";
    problem.sourceExecutionId = execution.id;
    problem.sourceTaskId = task.id;
    problem.updatedAt = now;
  }
}

function validateInvestigation(json: any, expectedProblemId: string): boolean {
  return (
    json.problemId === expectedProblemId &&
    typeof json.investigationSummary === "string" &&
    typeof json.investigationResult === "string" &&
    Array.isArray(json.evidenceReferences) &&
    validateLearningScopeStructure(json.selectedScope)
  );
}

async function ingestProposal(
  json: any,
  execution: ExecutionRecord,
  task: TaskRecord,
  opportunities: LearningOpportunityRecord[],
  proposals: LearningProposalRecord[],
  now: string
) {
  if (!validateProposal(json, task.sourceId)) {
    throw new Error("Invalid proposal JSON");
  }

  // Avoid duplicate proposals for the same opportunity
  if (proposals.some(p => p.opportunityId === json.opportunityId)) {
    return;
  }

  const proposalRecord: LearningProposalRecord = {
    id: `learning-proposal:${json.opportunityId}`,
    opportunityId: json.opportunityId,
    problemId: json.problemId,
    status: "pending",
    selectedScope: json.selectedScope,
    proposedEditMode: json.proposedEditMode,
    proposedGuidanceText: json.proposedGuidanceText,
    rationale: json.rationale,
    expectedBehaviorChange: json.expectedBehaviorChange,
    detectedAt: now,
    updatedAt: now,
    sourceTaskId: task.id,
    sourceExecutionId: execution.id,
  };

  proposals.push(proposalRecord);

  // Mark execution as consumed on the opportunity to prevent re-derivation
  const opportunity = opportunities.find(o => o.id === task.sourceId);
  if (opportunity) {
    opportunity.sourceExecutionId = execution.id;
    opportunity.sourceTaskId = task.id;
    opportunity.updatedAt = now;
  }
}

function validateProposal(json: any, expectedOpportunityId: string): boolean {
  const validEditModes = ["append", "refine", "supersede", "create"];
  return (
    json.opportunityId === expectedOpportunityId &&
    validateLearningScopeStructure(json.selectedScope) &&
    validEditModes.includes(json.proposedEditMode) &&
    typeof json.proposedGuidanceText === "string" &&
    json.proposedGuidanceText.trim().length > 0 &&
    typeof json.rationale === "string" &&
    json.rationale.trim().length > 0 &&
    typeof json.expectedBehaviorChange === "string" &&
    json.expectedBehaviorChange.trim().length > 0
  );
}

function handleIngestionFailure(
  execution: ExecutionRecord,
  task: TaskRecord,
  candidates: RetrospectiveCandidateRecord[],
  problems: RetrospectiveProblemRecord[],
  opportunities: LearningOpportunityRecord[],
  proposals: LearningProposalRecord[],
  reason: string,
  now: string
) {
  switch (task.kind) {
    case "extract_retrospective_problems":
      const candidate = candidates.find((c) => c.id === task.sourceId);
      if (candidate) {
        candidate.status = "failed";
        candidate.skipReason = `Ingestion failed: ${reason}`;
        candidate.sourceExecutionId = execution.id;
        candidate.sourceTaskId = task.id;
        candidate.updatedAt = now;
      }
      break;
    case "investigate_learning_opportunity":
      const problem = problems.find((p) => p.id === task.sourceId);
      if (problem) {
        problem.status = "failed";
        problem.decisionReason = `Ingestion failed: ${reason}`;
        problem.sourceExecutionId = execution.id;
        problem.sourceTaskId = task.id;
        problem.updatedAt = now;
      }
      break;
    case "draft_management_learning_proposal":
      const opportunity = opportunities.find((o) => o.id === task.sourceId);
      if (opportunity) {
        opportunity.status = "declined";
        opportunity.decisionReason = `Ingestion failed: ${reason}`;
        opportunity.sourceExecutionId = execution.id;
        opportunity.sourceTaskId = task.id;
        opportunity.updatedAt = now;
      }

      // Also persist a declined proposal record if it doesn't already exist
      if (!proposals.some(p => p.opportunityId === task.sourceId)) {
        proposals.push({
          id: `learning-proposal:${task.sourceId}`,
          opportunityId: task.sourceId,
          status: "declined",
          declineReason: `Ingestion failed: ${reason}`,
          detectedAt: now,
          updatedAt: now,
          sourceTaskId: task.id,
          sourceExecutionId: execution.id,
        });
      }
      break;
  }
}

function validateLearningScopeStructure(scope: any): boolean {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  if (typeof scope.kind !== "string") return false;

  switch (scope.kind) {
    case "global":
      return true;
    case "provider":
      return typeof scope.provider === "string" && scope.provider.length > 0;
    case "role":
      return typeof scope.role === "string" && scope.role.length > 0;
    case "task_kind":
      return typeof scope.taskKind === "string" && scope.taskKind.length > 0;
    case "repo":
      return typeof scope.repoId === "string" && scope.repoId.length > 0;
    case "repo_provider":
      return (
        typeof scope.repoId === "string" && scope.repoId.length > 0 &&
        typeof scope.provider === "string" && scope.provider.length > 0
      );
    case "repo_role":
      return (
        typeof scope.repoId === "string" && scope.repoId.length > 0 &&
        typeof scope.role === "string" && scope.role.length > 0
      );
    case "repo_task_kind":
      return (
        typeof scope.repoId === "string" && scope.repoId.length > 0 &&
        typeof scope.taskKind === "string" && scope.taskKind.length > 0
      );
    default:
      return false;
  }
}

function hashProse(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}
