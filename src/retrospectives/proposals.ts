import * as path from "node:path";
import {
  type LearningProposalRecord,
  type LearningOpportunityRecord,
  type RetrospectiveProblemRecord,
} from "./types.js";
import {
  type LearningScope,
  type ScopeValidationConfig,
  SCOPE_PRECEDENCE_ORDER,
  validateLearningScope,
  resolveScopePath,
} from "./scopes.js";

export interface ValidateLearningProposalsInput {
  proposals: LearningProposalRecord[];
  opportunities: LearningOpportunityRecord[];
  problems: RetrospectiveProblemRecord[];
  scopeValidationConfig: ScopeValidationConfig;
  managementRoot: string;
  readArtifact?: ((absolutePath: string) => Promise<string | undefined>) | undefined;
  now: string;
}

export interface ValidateLearningProposalsResult {
  proposals: LearningProposalRecord[];
}

export async function validateLearningProposals(
  input: ValidateLearningProposalsInput
): Promise<ValidateLearningProposalsResult> {
  const {
    proposals,
    opportunities,
    problems,
    scopeValidationConfig,
    managementRoot,
    readArtifact,
    now,
  } = input;

  const validatedProposals: LearningProposalRecord[] = [];

  for (const proposal of proposals) {
    if (proposal.status !== "pending") {
      validatedProposals.push(proposal);
      continue;
    }

    const result = await validateLearningProposal({
      proposal,
      opportunities,
      problems,
      scopeValidationConfig,
      managementRoot,
      readArtifact,
      now,
    });
    validatedProposals.push(result);
  }

  return { proposals: validatedProposals };
}

interface ValidateSingleProposalInput {
  proposal: LearningProposalRecord;
  opportunities: LearningOpportunityRecord[];
  problems: RetrospectiveProblemRecord[];
  scopeValidationConfig: ScopeValidationConfig;
  managementRoot: string;
  readArtifact?: ((absolutePath: string) => Promise<string | undefined>) | undefined;
  now: string;
}

async function validateLearningProposal(
  input: ValidateSingleProposalInput
): Promise<LearningProposalRecord> {
  const {
    proposal,
    opportunities,
    problems,
    scopeValidationConfig,
    managementRoot,
    readArtifact,
    now,
  } = input;

  const updated: LearningProposalRecord = { ...proposal, updatedAt: now };

  try {
    // 1. Find source opportunity and problem
    const opportunity = opportunities.find((o) => o.id === proposal.opportunityId);
    if (!opportunity) {
      return decline(updated, "Source opportunity not found", now);
    }

    const problem = problems.find(
      (p) => p.id === proposal.problemId || p.id === opportunity.problemId
    );
    if (!problem) {
      return decline(updated, "Source retrospective problem not found", now);
    }

    // 2. Bound content
    const contentError = validateContentBounds(updated);
    if (contentError) {
      return decline(updated, contentError, now);
    }

    // 3. Deterministic Scope Validation And Narrowing
    if (!updated.selectedScope) {
      return decline(updated, "Missing selected scope", now);
    }
    const scopeResult = selectHighestPrecedenceSupportedScope({
      suggestedScope: updated.selectedScope,
      opportunity,
      problem,
      config: scopeValidationConfig,
    });

    if (!scopeResult.ok) {
      return decline(updated, `Scope validation failed: ${scopeResult.error}`, now);
    }

    updated.selectedScope = scopeResult.scope;
    if (scopeResult.reason) {
      updated.validationReason = scopeResult.reason;
    }

    // 4. Resolve Artifact Path
    let resolvedPath: string;
    try {
      if (!updated.selectedScope) {
        return decline(updated, "Missing selected scope for path resolution", now);
      }
      resolvedPath = resolveScopePath(updated.selectedScope, managementRoot);
      updated.resolvedArtifactPath = resolvedPath;
    } catch (err) {
      return decline(updated, `Path resolution failed: ${(err as Error).message}`, now);
    }

    // 5. Load Existing Artifact Content For Validation Context
    if (readArtifact) {
      try {
        const content = await readArtifact(resolvedPath);
        if (content !== undefined) {
          updated.targetArtifactExists = true;
          updated.existingArtifactContentExcerpt = content.slice(0, 500);

          // Edit-mode validation
          if (updated.proposedEditMode === "create") {
            return decline(updated, `Cannot use edit mode "create" because artifact already exists at ${resolvedPath}`, now);
          }

          if (updated.proposedGuidanceText && content.includes(updated.proposedGuidanceText.trim())) {
            return decline(updated, "Proposed guidance text is already present in the existing artifact", now);
          }
        } else {
          updated.targetArtifactExists = false;
          if (updated.proposedEditMode !== "create") {
            // Normalize to create if it doesn't exist? Plan says "normalize to create only if the guidance is otherwise valid... If this feels too broad... decline instead"
            // I'll be conservative and normalize.
            // Let's normalize but record it.
            updated.validationReason = (updated.validationReason ? updated.validationReason + ". " : "") +
              `Normalized edit mode from "${updated.proposedEditMode}" to "create" because artifact does not exist`;
            updated.proposedEditMode = "create";
          }
        }
      } catch (err) {
        return decline(updated, `Failed to read existing artifact: ${(err as Error).message}`, now);
      }
    }

    updated.status = "validated";
    updated.validationStatus = "passed";
  } catch (err) {
    return decline(updated, `Unexpected validation error: ${(err as Error).message}`, now);
  }

  return updated;
}

function decline(
  proposal: LearningProposalRecord,
  reason: string,
  now: string
): LearningProposalRecord {
  return {
    ...proposal,
    status: "declined",
    validationStatus: "failed",
    declineReason: reason,
    updatedAt: now,
  };
}

const LIMITS = {
  guidance: 4000,
  rationale: 2000,
  expectedBehaviorChange: 1000,
};

function validateContentBounds(proposal: LearningProposalRecord): string | undefined {
  if (!proposal.proposedGuidanceText || !proposal.proposedGuidanceText.trim()) return "Proposed guidance text is empty";
  if (proposal.proposedGuidanceText.length > LIMITS.guidance) return `Proposed guidance text exceeds limit of ${LIMITS.guidance} characters`;

  if (!proposal.rationale || !proposal.rationale.trim()) return "Rationale is empty";
  if (proposal.rationale.length > LIMITS.rationale) return `Rationale exceeds limit of ${LIMITS.rationale} characters`;

  if (!proposal.expectedBehaviorChange || !proposal.expectedBehaviorChange.trim()) return "Expected behavior change is empty";
  if (proposal.expectedBehaviorChange.length > LIMITS.expectedBehaviorChange) return `Expected behavior change exceeds limit of ${LIMITS.expectedBehaviorChange} characters`;

  return undefined;
}

interface ScopeSelectionInput {
  suggestedScope: LearningScope;
  opportunity: LearningOpportunityRecord;
  problem: RetrospectiveProblemRecord;
  config: ScopeValidationConfig;
}

interface ScopeSelectionResult {
  ok: boolean;
  scope: LearningScope;
  reason?: string;
  error?: string;
}

export function selectHighestPrecedenceSupportedScope(
  input: ScopeSelectionInput
): ScopeSelectionResult {
  const { suggestedScope, opportunity, problem, config } = input;

  // 1. Build candidate scopes
  const candidates: LearningScope[] = [];

  // Always consider suggested scope first (it's what the agent wanted)
  candidates.push(suggestedScope);

  if (opportunity.selectedScope) candidates.push(opportunity.selectedScope);
  if (problem.selectedScope) candidates.push(problem.selectedScope);
  if (problem.suggestedScopes) candidates.push(...problem.suggestedScopes);

  // 2. Validate and filter by evidence
  const validSupported: LearningScope[] = [];

  for (const candidate of candidates) {
    const val = validateLearningScope(candidate, config);
    if (!val.ok) continue;

    if (isScopeSupportedByEvidence(val.scope, problem)) {
      validSupported.push(val.scope);
    }
  }

  if (validSupported.length === 0) {
    return { ok: false, scope: suggestedScope, error: "No valid scopes supported by problem evidence" };
  }

  // 3. Sort by precedence
  validSupported.sort((a, b) => {
    const idxA = SCOPE_PRECEDENCE_ORDER.indexOf(a.kind);
    const idxB = SCOPE_PRECEDENCE_ORDER.indexOf(b.kind);
    return idxA - idxB;
  });

  const selected = validSupported[0];
  if (!selected) {
    // Should be impossible given length check above, but for TS:
    return { ok: false, scope: suggestedScope, error: "No valid scopes supported by problem evidence" };
  }

  let reason = `Selected highest-precedence valid scope: ${selected.kind}`;
  if (selected.kind !== suggestedScope.kind) {
    reason = `Narrowed scope from ${suggestedScope.kind} to ${selected.kind} based on evidence`;
  }

  return { ok: true, scope: selected, reason };
}

function isScopeSupportedByEvidence(
  scope: LearningScope,
  problem: RetrospectiveProblemRecord
): boolean {
  switch (scope.kind) {
    case "global":
      return true;
    case "provider":
      return problem.providers.includes(scope.provider);
    case "role":
      return problem.roles.includes(scope.role);
    case "task_kind":
      return problem.taskKinds.includes(scope.taskKind);
    case "repo":
      return problem.affectedRepoIds.includes(scope.repoId);
    case "repo_provider":
      return problem.affectedRepoIds.includes(scope.repoId) && problem.providers.includes(scope.provider);
    case "repo_role":
      return problem.affectedRepoIds.includes(scope.repoId) && problem.roles.includes(scope.role);
    case "repo_task_kind":
      return problem.affectedRepoIds.includes(scope.repoId) && problem.taskKinds.includes(scope.taskKind);
  }
}
