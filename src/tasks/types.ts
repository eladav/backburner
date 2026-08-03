import type {
  WaveAssessmentCheckpoint,
  WaveAssessmentResult
} from "../workstreams/wave-assessment/types.js";
import type { WorkstreamPhase } from "../state/types.js";
import type { AgentProvider } from "../config/types.js";
import type {
  FixResultV1,
  ReviewFindingV2,
  ReviewResultV2
} from "../reviews/contracts.js";

export type TaskKind =
  | "product_discovery"
  | "write_product_spec"
  | "triage_issue"
  | "respond_issue_comment"
  | "review_pr"
  | "fix_review_finding"
  | "respond_pr_comment"
  | "write_plan"
  | "implement_plan"
  | "plan_breakdown"
  | "wave_plan_assessment"
  | "wave_plan_replanning"
  | "sync_parent_branch_preflight"
  | "sync_parent_branch"
  | "prepare_pr_for_merge"
  | "extract_retrospective_problems"
  | "investigate_learning_opportunity"
  | "draft_management_learning_proposal";

export type TaskExecutionPermission = "read-only" | "workspace-write";
export type RemotePublishOwner = "orchestrator";

export interface TaskHandoffPolicy {
  expectsPushableHandoff: boolean;
  orchestratorOwnsPush: boolean;
  remotePublishOwner: RemotePublishOwner;
}

export type TaskStatus = "pending" | "queued" | "dispatched" | "completed" | "failed";

export type TaskSourceKind =
  | "issue"
  | "pull_request"
  | "comment"
  | "retrospective_candidate"
  | "retrospective_problem"
  | "learning_opportunity";

export interface PullRequestReviewCommentLocationContext {
  path?: string | undefined;
  line?: number | null | undefined;
  side?: string | null | undefined;
  startLine?: number | null | undefined;
  startSide?: string | null | undefined;
  originalLine?: number | null | undefined;
  originalStartLine?: number | null | undefined;
  commitId?: string | undefined;
  originalCommitId?: string | undefined;
  diffHunk?: string | undefined;
  inReplyToId?: number | undefined;
}

export interface ParentBranchSyncPreflight {
  workstreamId: string;
  repoKey: string;
  parentIntegrationBranch: string;
  parentPrNumber?: number;
  parentHeadSha?: string;
  defaultBranch: string;
  planRevision?: string;
  originalPlanningSessionId?: string;
  currentWaveIndex: number;
  nextWaveIndex: number;
  completedPacketIds: string[];
  pendingFuturePacketIds: string[];
  planNodeIds?: string[];
}

export interface PrepareForMergePreflight {
  prNumber: number;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  prTitle: string;
  /** Absolute path to the durable persistent worktree for this PR, if one exists. */
  persistentWorktreePath?: string | undefined;
  /** Absolute path to the agent log document in the durable persistent worktree. */
  persistentLogDocumentPath?: string | undefined;
  /** Absolute path to the agent plan document in the durable persistent worktree. */
  persistentPlanDocumentPath?: string | undefined;
}

export interface McpSkipContext {
  mcpHandle: string;
  affectedCapabilityNames: string[];
  skipReason: string;
}

export interface WaveReassessmentContext {
  sourceCommentId: string;
  sourceCommentUrl: string;
  sourceCommentAuthor: string;
  commentText: string;
  reason: string;
}

export interface ReviewCycleTaskLineage {
  sessionId: string;
  reviewOrdinal: number;
  /** One-based number of the fix batch this task belongs to. */
  turnNumber?: number;
  findingId?: string;
  targetHeadSha: string;
  retryScope: "review_session";
}

export interface ReviewCycleFixContext {
  finding: ReviewFindingV2;
  findings: ReviewFindingV2[];
  precedingDispositions: Array<{
    findingId: string;
    disposition: FixResultV1["disposition"];
    summary: string;
  }>;
  review: ReviewResultV2;
  reviewUrl?: string;
}

export interface TaskContextPacket {
  repoIdentifier: string;
  localRepoPath?: string;
  branchName?: string;
  /** Packet identifier when this task belongs to a packet-scoped worktree. */
  packetId?: string | undefined;
  planDocumentPath?: string;
  productSpecDocumentPath?: string;
  logDocumentPath?: string;
  issueUrl?: string;
  issueTitle?: string;
  issueBody?: string;
  pullRequestUrl?: string;
  commentUrl?: string;
  relevantCommentText?: string;
  pullRequestReviewLocation?: PullRequestReviewCommentLocationContext;
  labels: string[];
  instruction: string;
  preflight?: ParentBranchSyncPreflight;
  prepareForMerge?: PrepareForMergePreflight;
  waveAssessmentCheckpoint?: WaveAssessmentCheckpoint;
  finalizedWaveAssessment?: WaveAssessmentResult;
  waveReassessment?: WaveReassessmentContext;
  retrospectiveCandidate?: any;
  retrospectiveProblem?: any;
  learningOpportunity?: any;
  memoryBackground?: string;
  /** True if the task workspace requires recovery (hard reset/clean) before dispatch. */
  recoveryNeeded?: boolean | undefined;
  /** True if the user has already been notified that this task is queued. */
  notifiedQueued?: boolean | undefined;
  /** Original queue timestamp used to preserve provider-limit FIFO resumption. */
  providerLimitQueuedAt?: string | undefined;
  /** Provider that most recently released this task from a limit queue. */
  providerLimitResumedProvider?: AgentProvider | undefined;
  /**
   * Present when a task was resumed after the user explicitly skipped MCP authorization.
   * The agent must not use tools from the excluded MCP and must acknowledge the exclusion.
   */
  mcpSkipContexts?: McpSkipContext[] | undefined;
  /** Durable parent-workflow lineage for automatic review-cycle children. */
  reviewCycle?: ReviewCycleTaskLineage | undefined;
  /** Per-finding implementation input; present only for fix_review_finding. */
  reviewCycleFix?: ReviewCycleFixContext | undefined;
}

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  executionPermission: TaskExecutionPermission;
  handoffPolicy: TaskHandoffPolicy;
  repoId: string;
  repoName: string;
  repoSlug: string;
  sourceKind: TaskSourceKind;
  sourceId: string;
  sourceUrl: string;
  parentSourceKind?: Extract<TaskSourceKind, "issue" | "pull_request">;
  parentSourceId?: string;
  relevant: boolean;
  reason: string;
  summary: string;
  workstreamId?: string | undefined;
  workflowPhase?: WorkstreamPhase | undefined;
  waitingOnProvider?: AgentProvider | undefined;
  context: TaskContextPacket;
  lastExecutionId?: string;
  lastFailureCommentId?: string;
  sourceReactionTargetId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}
