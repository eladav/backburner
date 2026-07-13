import type {
  RetrospectiveProblemRecord,
  RetrospectiveBand,
  RetrospectiveThresholdCriterionResult,
  RetrospectiveThresholdDecision,
} from "./types.js";
import {
  type ScopeValidationConfig,
  validateLearningScope,
  normalizeRetrospectiveScopes,
  SCOPE_PRECEDENCE_ORDER,
  type LearningScope,
} from "./scopes.js";
import { workflowRegistry } from "../workflows/registry.js";
import { type AgentStrategyRole } from "../agents/types.js";
import { type RepoConfig, type AgentConfig } from "../config/types.js";

export interface ScoreRetrospectiveProblemInput {
  problem: RetrospectiveProblemRecord;
  scopeValidationConfig: ScopeValidationConfig;
  now: string;
}

export interface ScoreRetrospectiveProblemResult {
  problem: RetrospectiveProblemRecord;
}

export function scoreRetrospectiveProblem(
  input: ScoreRetrospectiveProblemInput
): ScoreRetrospectiveProblemResult {
  const { problem, scopeValidationConfig, now } = input;
  const criteria: RetrospectiveThresholdCriterionResult[] = [];
  const reasons: string[] = [];

  // 1. Impact must be high
  const impactPassed = problem.impact === "high";
  const impactCriterion: RetrospectiveThresholdCriterionResult = {
    criterion: "impact",
    passed: impactPassed,
    actual: problem.impact,
    expected: "high",
    reason: impactPassed ? "impact is high" : `impact is ${problem.impact || "missing"}; expected "high"`,
  };
  criteria.push(impactCriterion);
  if (!impactPassed) reasons.push(impactCriterion.reason);

  // 2. Transferability must be high
  const transferabilityPassed = problem.transferability === "high";
  const transferabilityCriterion: RetrospectiveThresholdCriterionResult = {
    criterion: "transferability",
    passed: transferabilityPassed,
    actual: problem.transferability,
    expected: "high",
    reason: transferabilityPassed ? "transferability is high" : `transferability is ${problem.transferability || "missing"}; expected "high"`,
  };
  criteria.push(transferabilityCriterion);
  if (!transferabilityPassed) reasons.push(transferabilityCriterion.reason);

  // 3. Confidence must be high
  const confidencePassed = problem.confidence === "high";
  const confidenceCriterion: RetrospectiveThresholdCriterionResult = {
    criterion: "confidence",
    passed: confidencePassed,
    actual: problem.confidence,
    expected: "high",
    reason: confidencePassed ? "confidence is high" : `confidence is ${problem.confidence || "missing"}; expected "high"`,
  };
  criteria.push(confidenceCriterion);
  if (!confidencePassed) reasons.push(confidenceCriterion.reason);

  // 4. Improvement Likelihood must be high
  const improvementLikelihoodPassed = problem.improvementLikelihood === "high";
  const improvementLikelihoodCriterion: RetrospectiveThresholdCriterionResult = {
    criterion: "improvementLikelihood",
    passed: improvementLikelihoodPassed,
    actual: problem.improvementLikelihood,
    expected: "high",
    reason: improvementLikelihoodPassed ? "improvementLikelihood is high" : `improvementLikelihood is ${problem.improvementLikelihood || "missing"}; expected "high"`,
  };
  criteria.push(improvementLikelihoodCriterion);
  if (!improvementLikelihoodPassed) reasons.push(improvementLikelihoodCriterion.reason);

  // 5. Overfitting Risk must be low
  const overfittingRiskPassed = problem.overfittingRisk === "low";
  const overfittingRiskCriterion: RetrospectiveThresholdCriterionResult = {
    criterion: "overfittingRisk",
    passed: overfittingRiskPassed,
    actual: problem.overfittingRisk,
    expected: "low",
    reason: overfittingRiskPassed ? "overfittingRisk is low" : `overfittingRisk is ${problem.overfittingRisk || "missing"}; expected "low"`,
  };
  criteria.push(overfittingRiskCriterion);
  if (!overfittingRiskPassed) reasons.push(overfittingRiskCriterion.reason);

  // 6. Scope validation
  let selectedScope: LearningScope | undefined;
  let scopeValidationReason: string | undefined;
  const validScopes: LearningScope[] = [];
  const invalidScopeReasons: string[] = [];

  // Defensive normalization for older persisted state or direct callers
  const { semanticScopes, candidateLearningScopes } = normalizeRetrospectiveScopes({
    rawSuggestedScopes: problem.suggestedScopes,
    affectedRepoIds: problem.affectedRepoIds,
    roles: problem.roles,
    taskKinds: problem.taskKinds,
    providers: problem.providers,
  });

  const normalizedSuggestedScopes = candidateLearningScopes;
  const normalizedAnySemantic =
    semanticScopes.length > 0 || (problem.semanticSuggestedScopes?.length ?? 0) > 0;

  for (const suggested of normalizedSuggestedScopes) {
    const validation = validateLearningScope(suggested, scopeValidationConfig);
    if (validation.ok) {
      validScopes.push(validation.scope);
    } else {
      invalidScopeReasons.push(validation.error);
    }
  }

  if (validScopes.length > 0) {
    // Select the narrowest scope by SCOPE_PRECEDENCE_ORDER
    validScopes.sort((a, b) => {
      const aIdx = SCOPE_PRECEDENCE_ORDER.indexOf(a.kind);
      const bIdx = SCOPE_PRECEDENCE_ORDER.indexOf(b.kind);
      return aIdx - bIdx;
    });
    selectedScope = validScopes[0];
    if (selectedScope) {
      scopeValidationReason = `selected scope ${selectedScope.kind} validated${normalizedAnySemantic ? " after normalizing semantic scopes" : ""}`;
    } else {
      // Should not happen given validScopes.length > 0
      scopeValidationReason = "no valid scopes found after validation";
    }
  } else {
    scopeValidationReason = invalidScopeReasons.length > 0
      ? `no suggested scope validated successfully: ${invalidScopeReasons.join("; ")}`
      : "no suggested scopes provided";
  }

  const scopePassed = !!selectedScope;
  const scopeCriterion: RetrospectiveThresholdCriterionResult = {
    criterion: "scope",
    passed: scopePassed,
    expected: "at least one valid scope",
    reason: scopeValidationReason,
  };
  criteria.push(scopeCriterion);
  if (!scopePassed) reasons.push(scopeValidationReason);

  const allPassed = criteria.every((c) => c.passed);
  const decision: RetrospectiveThresholdDecision = allPassed ? "pass" : "fail";

  return {
    problem: {
      ...problem,
      suggestedScopes: normalizedSuggestedScopes,
      rawSuggestedScopes: problem.rawSuggestedScopes || problem.suggestedScopes,
      semanticSuggestedScopes:
        problem.semanticSuggestedScopes || (semanticScopes.length > 0 ? semanticScopes : undefined),
      thresholdDecision: decision,
      thresholdCriteria: criteria,
      thresholdReasons: reasons,
      selectedScope,
      scopeValidationReason,
      decisionReason: allPassed ? "All criteria passed" : reasons.join("; "),
      updatedAt: now,
    },
  };
}

export function scoreRetrospectiveProblems(
  problems: RetrospectiveProblemRecord[],
  scopeValidationConfig: ScopeValidationConfig,
  now: string
): RetrospectiveProblemRecord[] {
  return problems.map((p) => {
    // Only rescore if needed (no decision yet, or newly ingested)
    // For now, let's implement the idempotent rescoring as requested.
    const result = scoreRetrospectiveProblem({ problem: p, scopeValidationConfig, now });

    // To avoid needlessly changing updatedAt on already-scored unchanged problems,
    // we can compare the result.
    if (p.thresholdDecision === result.problem.thresholdDecision &&
        p.decisionReason === result.problem.decisionReason &&
        JSON.stringify(p.thresholdCriteria) === JSON.stringify(result.problem.thresholdCriteria) &&
        JSON.stringify(p.selectedScope) === JSON.stringify(result.problem.selectedScope) &&
        JSON.stringify(p.suggestedScopes) === JSON.stringify(result.problem.suggestedScopes) &&
        JSON.stringify(p.rawSuggestedScopes) === JSON.stringify(result.problem.rawSuggestedScopes) &&
        JSON.stringify(p.semanticSuggestedScopes) === JSON.stringify(result.problem.semanticSuggestedScopes)) {
      return p;
    }

    return result.problem;
  });
}

export function buildScopeValidationConfigFromRuntime(input: {
  repos: RepoConfig[];
  agents: AgentConfig[];
}): ScopeValidationConfig {
  const { repos, agents } = input;

  const repoIds = repos.filter((r) => r.enabled).map((r) => r.id);
  const providers = agents.filter((a) => a.enabled).map((a) => a.provider);
  const roles = Array.from(new Set(agents.filter((a) => a.enabled).flatMap((a) => a.roles))) as AgentStrategyRole[];
  const taskKinds = workflowRegistry.definitionsList.map((def) => def.kind);

  return {
    repoIds,
    providers,
    roles,
    taskKinds,
  };
}
