import {
  type LearningScope,
  type RetrospectiveSemanticScopeRecord,
} from "./scopes.js";
import type { AgentStrategyRole } from "../agents/types.js";
import type { TaskKind } from "../tasks/types.js";
import type { AgentProvider } from "../config/types.js";

export type RetrospectiveCandidateStatus =
  | "new"
  | "selected"
  | "extracting"
  | "extracted"
  | "skipped"
  | "resolved"
  | "blocked"
  | "failed";

export type RetrospectiveExtractionStatus =
  | "pending"
  | "investigating"
  | "completed"
  | "failed"
  | "declined"
  | "blocked";

export type LearningOpportunityStatus =
  | "pending"
  | "investigating"
  | "investigated"
  | "declined"
  | "blocked";

export type LearningProposalStatus =
  | "pending"
  | "validated"
  | "declined"
  | "materialized"
  | "audit_only"
  | "blocked";

export type ManagementPrStatus =
  | "pending"
  | "opened"
  | "audit_only"
  | "closed"
  | "merged"
  | "failed";

export type RetrospectiveBand = "low" | "medium" | "high";

export type RetrospectiveThresholdDecision = "pass" | "fail";

export interface RetrospectiveThresholdCriterionResult {
  criterion:
    | "impact"
    | "transferability"
    | "confidence"
    | "improvementLikelihood"
    | "overfittingRisk"
    | "scope";
  passed: boolean;
  actual?: RetrospectiveBand | undefined;
  expected: string;
  reason: string;
}

export interface RetrospectiveEvidenceReference {
  kind:
    | "issue"
    | "pull_request"
    | "comment"
    | "task"
    | "execution"
    | "artifact"
    | "workstream"
    | "worktree";
  id: string;
  url?: string;
  path?: string;
  summary?: string;
}

export interface RetrospectiveCandidateRecord {
  id: string;
  sourceWorkstreamId: string;
  repoId: string;
  repoSlug: string;
  repoKey?: string;
  origin: {
    type: "issue" | "pull_request";
    number: number;
  };
  terminalResolution: "closed" | "merged";
  detectedAt: string;
  resolvedAt: string;
  updatedAt?: string;
  status: RetrospectiveCandidateStatus;
  title?: string;
  url?: string;
  labels: string[];
  sourceSummary: string;
  taskSummary: {
    total: number;
    completed: number;
    failed: number;
    kinds: TaskKind[];
    taskIds: string[];
    lastExecutionId?: string;
  };
  executionSummary: {
    total: number;
    providers: AgentProvider[];
    models: string[];
    roles: AgentStrategyRole[];
    executionIds: string[];
  };
  artifactReferences: string[];
  evidenceReferences: RetrospectiveEvidenceReference[];
  skipReason?: string;
  sourceTaskId?: string;
  sourceExecutionId?: string;
}

export interface RetrospectiveProblemRecord {
  id: string;
  candidateId: string;
  status: RetrospectiveExtractionStatus;
  structuredObservations?: string;
  evidenceReferences: RetrospectiveEvidenceReference[];
  affectedRepoIds: string[];
  roles: AgentStrategyRole[];
  taskKinds: TaskKind[];
  providers: AgentProvider[];
  confidence?: RetrospectiveBand;
  impact?: RetrospectiveBand;
  transferability?: RetrospectiveBand;
  improvementLikelihood?: RetrospectiveBand;
  overfittingRisk?: RetrospectiveBand;
  suggestedScopes: LearningScope[];
  rawSuggestedScopes?: unknown[] | undefined;
  semanticSuggestedScopes?: RetrospectiveSemanticScopeRecord[] | undefined;
  thresholdDecision?: RetrospectiveThresholdDecision;
  thresholdReasons?: string[];
  thresholdCriteria?: RetrospectiveThresholdCriterionResult[];
  selectedScope?: LearningScope | undefined;
  scopeValidationReason?: string;
  decisionReason?: string;
  detectedAt: string;
  updatedAt?: string;
  sourceTaskId?: string;
  sourceExecutionId?: string;
}

export interface LearningOpportunityRecord {
  id: string;
  problemId: string;
  status: LearningOpportunityStatus;
  investigationSummary?: string;
  investigationResult?: string;
  selectedScope?: LearningScope;
  evidenceReferences: RetrospectiveEvidenceReference[];
  decisionReason?: string;
  detectedAt: string;
  updatedAt?: string;
  sourceTaskId?: string;
  sourceExecutionId?: string;
}

export interface LearningProposalRecord {
  id: string;
  opportunityId?: string;
  problemId?: string;
  status: LearningProposalStatus;
  selectedScope?: LearningScope;
  resolvedArtifactPath?: string;
  proposedEditMode?: "append" | "refine" | "supersede" | "create";
  proposedGuidanceText?: string;
  rationale?: string;
  expectedBehaviorChange?: string;
  validationStatus?: "pending" | "passed" | "failed";
  validationReason?: string;
  declineReason?: string;
  existingArtifactContentExcerpt?: string;
  targetArtifactExists?: boolean;
  materializationStatus?: "pending" | "completed" | "failed";
  detectedAt: string;
  updatedAt?: string;
  sourceTaskId?: string;
  sourceExecutionId?: string;
}

export interface ManagementPrRecord {
  id: string;
  proposalId: string;
  mode: "pull_request" | "audit_only";
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  repoSlug?: string;
  repoId?: string;
  changedArtifactPaths: string[];
  status: ManagementPrStatus;
  reason?: string;
  detectedAt: string;
  updatedAt?: string;
}
