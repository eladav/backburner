import type { AgentConfig } from "../config/types.js";
import type { BuiltContext } from "../context/types.js";
import type { ExecutionRecord, ProviderLimitSignal } from "../state/types.js";
import type { AgentVisibleCapabilities } from "../capabilities/types.js";
import type {
  ParentBranchSyncPreflight,
  PrepareForMergePreflight,
  PullRequestReviewCommentLocationContext,
  TaskRecord,
  WaveReassessmentContext
} from "../tasks/types.js";
import type {
  WaveAssessmentCheckpoint,
  WaveAssessmentResult
} from "../workstreams/wave-assessment/types.js";

import type { ProviderSessionDecision } from "./provider-sessions.js";
import type { ResolvedPromptContent } from "../prompts/resolver.js";

export interface ProviderSessionObservation {
  providerSessionId?: string;
  providerSessionName?: string;
  status: "active" | "stale" | "closed";
}

export interface DispatchResult {
  taskStatus: ExecutionRecord["taskStatus"];
  execution: ExecutionRecord;
  providerSession?: ProviderSessionObservation;
  providerLimitSignal?: ProviderLimitSignal;
}

export interface AgentRunner {
  dispatch(
    task: TaskRecord,
    context: BuiltContext,
    agentConfig: AgentConfig,
    sessionDecision?: ProviderSessionDecision,
    promptContent?: ResolvedPromptContent
  ): Promise<DispatchResult>;
}

export type AgentStrategyRole = "product" | "discussion" | "review" | "planning" | "implementation" | "implementation_manager" | "retrospective";

import type {
  RetrospectiveCandidateRecord,
  RetrospectiveProblemRecord,
  LearningOpportunityRecord,
} from "../retrospectives/types.js";

export interface PromptPacket {
  taskType: string;
  repo: string;
  url: string;
  executionPermission: TaskRecord["executionPermission"];
  handoffPolicy: TaskRecord["handoffPolicy"];
  capabilities?: AgentVisibleCapabilities;
  issueTitle?: string;
  issueBody?: string;
  productSpecDocumentPath?: string;
  relevantComment?: string;
  pullRequestReviewLocation?: PullRequestReviewCommentLocationContext;
  backburnerGitSessionId?: string;
  preflight?: ParentBranchSyncPreflight;
  prepareForMerge?: PrepareForMergePreflight;
  waveAssessmentCheckpoint?: WaveAssessmentCheckpoint;
  finalizedWaveAssessment?: WaveAssessmentResult;
  waveReassessment?: WaveReassessmentContext;
  retrospectiveCandidate?: RetrospectiveCandidateRecord;
  retrospectiveProblem?: RetrospectiveProblemRecord;
  learningOpportunity?: LearningOpportunityRecord;
  reviewCycle?: TaskRecord["context"]["reviewCycle"];
  reviewCycleFix?: TaskRecord["context"]["reviewCycleFix"];
  nativeResumeRetry?: {
    previousExecutionFailed: true;
  };
  action: string;
  localPaths: string[];
  reminder: string;
}
