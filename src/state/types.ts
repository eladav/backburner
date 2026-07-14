import type { AgentProvider } from "../config/types.js";
import type { AgentStrategyRole } from "../agents/types.js";
import type {
  NormalizedComment,
  NormalizedIssue,
  NormalizedPullRequest
} from "../domain/entities.js";
import type { JobName } from "../memory/types.js";
import type { TaskRecord } from "../tasks/types.js";
import type { BranchSyncComparison } from "../git/types.js";
import type {
  LearningOpportunityRecord,
  LearningProposalRecord,
  ManagementPrRecord,
  RetrospectiveCandidateRecord,
  RetrospectiveProblemRecord
} from "../retrospectives/types.js";
export type { TaskRecord };

export interface RepoScanFailure {
  repoId: string;
  repoSlug: string;
  step:
    | "repo_metadata"
    | "list_issues"
    | "list_pull_requests"
    | "get_pull_request"
    | "issue_comments"
    | "pull_request_comments"
    | "pull_request_reviews"
    | "pull_request_review_comments";
  scope: string;
  message: string;
}

export interface EntityStateMetadata {
  generatedAt?: string;
  repoCount?: number;
  entityCount?: number;
  partialFailures: RepoScanFailure[];
}

export interface IssueStateFile {
  metadata: EntityStateMetadata;
  issues: NormalizedIssue[];
}

export interface PullRequestStateFile {
  metadata: EntityStateMetadata;
  prs: NormalizedPullRequest[];
}

export interface CommentStateFile {
  metadata: EntityStateMetadata;
  comments: NormalizedComment[];
}

export interface TaskStateFile {
  tasks: TaskRecord[];
}

export interface RetrospectiveCandidateStateFile {
  retrospectiveCandidates: RetrospectiveCandidateRecord[];
}

export interface RetrospectiveProblemStateFile {
  retrospectiveProblems: RetrospectiveProblemRecord[];
}

export interface RetrospectiveOpportunityStateFile {
  retrospectiveOpportunities: LearningOpportunityRecord[];
}

export interface LearningProposalStateFile {
  learningProposals: LearningProposalRecord[];
}

export interface ManagementPrStateFile {
  managementPrs: ManagementPrRecord[];
}

export interface ExecutionRecord {
  id: string;
  taskId: string;
  taskKind: TaskRecord["kind"];
  taskStatus: Extract<TaskRecord["status"], "completed" | "failed">;
  repoId: string;
  repoSlug: string;
  agentId: string;
  agentProvider: AgentProvider | "unassigned";
  agentModel?: string;
  command: {
    executable: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  };
  promptArtifactPath: string;
  stdoutArtifactPath: string;
  stderrArtifactPath: string;
  streamArtifactPath?: string;
  providerTranscriptArtifactPath?: string;
  promptPacketPath: string;
  settingsArtifactPath?: string;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  errorMessage?: string;
  result?: AgentExecutionResult;
}

export interface ExecutionStateFile {
  executions: ExecutionRecord[];
}

export interface WorktreeRecord {
  id: string;
  repoId: string;
  repoSlug: string;
  repoName: string;
  issueId?: string;
  issueNumber?: number;
  prId?: string;
  prNumber?: number;
  prUrl?: string;
  packet?: {
    parentWorkstreamId: string;
    packetId: string;
    waveIndex: number;
    parentIntegrationBranch: string;
  };
  baseBranch?: string;
  branchName: string;
  path: string;
  planDocumentPath: string;
  productSpecDocumentPath?: string;
  productSpecWrittenAt?: string;
  logDocumentPath: string;
  status:
    | "product_specification"
    | "planning"
    | "awaiting_plan_approval"
    | "implementation_ready"
    | "implementing"
    | "implementation_done"
    | "closed";
  triggerCommentText?: string;
  triggerCommentUrl?: string;
  bootstrapCommitCreated?: boolean;
  branchPushedAt?: string;
  pullRequestCreatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeStateFile {
  worktrees: WorktreeRecord[];
}

export type WorkspaceRecoveryOutcome = "recovered" | "skipped" | "rejected" | "failed";

export interface WorkspaceRecoveryRecord {
  taskId: string;
  taskKind: TaskRecord["kind"];
  workspacePath?: string;
  outcome: WorkspaceRecoveryOutcome;
  reason: string;
  recoveredAt: string;
}

export interface WorkspaceRecoveryStateFile {
  records: WorkspaceRecoveryRecord[];
}

export type WorkstreamOrigin =
  | { type: "issue"; number: number }
  | { type: "pr"; number: number };

export interface WorkstreamLinkedPullRequest {
  number: number;
  status?: string;
  role?: string;
}

export const WORKSTREAM_PHASES = [
  "product_discovery",
  "product_specification",
  "issue_triage",
  "issue_waiting",
  "planning",
  "plan_feedback",
  "implementation_ready",
  "implementing",
  "implementation_done",
  "implementation_feedback",
  "pr_review",
  "resolved",
  "abandoned"
] as const;

export type WorkstreamPhase = (typeof WORKSTREAM_PHASES)[number];

export type WorkstreamAttention = "idle" | "review_requested" | "prepare_for_merge_requested";

export type WorkstreamStatus = "open" | "closed" | "merged";

export type WorkstreamResolution = "unresolved" | "closed" | "merged";

export interface WorkstreamIntegrationState {
  branchName: string;
  prNumber?: number | undefined;
}

export interface WorkstreamProductState {
  status: "in_discovery" | "approved_for_spec" | "spec_written";
  approvalLabel?: string;
  approvedAt?: string;
}

export type PacketPlanStatus =
  | "proposed"
  | "needs_revision"
  | "approved"
  | "in_progress"
  | "complete";

export type PacketExecutionStatus =
  | "planned"
  | "branch_created"
  | "pr_open"
  | "review_requested"
  | "changes_requested"
  | "approved"
  | "merged_to_parent"
  | "failed";

export interface WorkstreamPacket {
  id: string;
  title: string;
  summary: string;
  acceptanceCriteria: string[];
  filesLikelyTouched: string[];
  dependsOn: string[];
  canRunInParallelWith: string[];
  blocks: string[];
  status: PacketExecutionStatus;
  branchName?: string;
  prNumber?: number;
  updatedAt?: string;
}

export interface WorkstreamPacketPlanSource {
  kind: "plan_breakdown_result";
  workstreamId: string;
  generatedAt?: string | undefined;
}

export interface WorkstreamPacketPlan {
  status: PacketPlanStatus;
  packets: Record<string, WorkstreamPacket>;
  waves: string[][];
  currentWaveIndex?: number | undefined;
  source?: WorkstreamPacketPlanSource | undefined;
  waveAssessments?: WaveAssessmentResult[] | undefined;
  updatedAt?: string | undefined;
}

export interface WaveAssessmentCheckpointIdentity {
  repoKey: string;
  workstreamId: string;
  waveId: string;
  parentPrNumber: number;
  parentHeadSha: string;
  parentIntegrationBranch: string;
  defaultBranch: string;
  planRevision: string;
  originalPlanningSessionId: string;
  currentWaveIndex: number;
  nextWaveIndex: number;
  completedPacketIds: string[];
  pendingFuturePacketIds: string[];
  planNodeIds: string[];
}

export interface WaveAssessmentCheckpoint {
  id: string;
  sessionId: string;
  identity: WaveAssessmentCheckpointIdentity;
}

export type WaveAssessmentDecision = "continue" | "replan" | "blocked";
export type WaveAssessmentFindingCategory =
  | "correctness"
  | "completeness"
  | "drift"
  | "invalid_assumption";

export interface WaveAssessmentFinding {
  id: string;
  category: WaveAssessmentFindingCategory;
  summary: string;
  details: string;
  affectedPlanNodeIds: string[];
  createdAt?: string;
}

export interface WaveAssessmentResult {
  id: string;
  sessionId: string;
  checkpoint: WaveAssessmentCheckpoint;
  decision: WaveAssessmentDecision;
  summary: string;
  findings: WaveAssessmentFinding[];
  status: "draft" | "finalized";
  postedCommentId?: string;
  createdAt?: string;
  finalizedAt?: string;
  updatedAt?: string;
}

export interface WorkstreamRecord {
  id: string;
  repoKey: string;
  origin: WorkstreamOrigin;
  linkedIssueNumber?: number;
  linkedPrs: WorkstreamLinkedPullRequest[];
  activePrNumber?: number;
  activeWorktreeId?: string;
  phase: WorkstreamPhase;
  attention: WorkstreamAttention;
  status: WorkstreamStatus;
  resolution: WorkstreamResolution;
  product?: WorkstreamProductState;
  integration?: WorkstreamIntegrationState;
  packetPlan?: WorkstreamPacketPlan;
  /** MCP action-required blockers scoped to tasks or packets in this workstream. */
  mcpBlockers?: WorkstreamMcpBlocker[] | undefined;
  /** Explicit user-authorized MCP skip exclusions for specific tasks/packets. */
  mcpSkipExclusions?: WorkstreamMcpScopedExclusion[] | undefined;
}

export interface WorkstreamStateFile {
  workstreams: WorkstreamRecord[];
}

export type AttentionReason =
  | "new_issue"
  | "product_approval_observed"
  | "issue_comment_added"
  | "issue_comment_edited"
  | "new_pr"
  | "pr_comment_added"
  | "pr_comment_edited"
  | "pr_review_requested"
  | "pr_head_changed_since_last_review"
  | "plan_approved"
  | "plan_breakdown_requested"
  | "packet_wave_complete_sync_needed"
  | "prepare_for_merge_requested"
  | "retry_requested"
  | "cancel_requested"
  | "mcp_skip_requested"
  | "contextual_feedback_received"
  | "workstream_unlinked_pr"
  | "unknown_phase_needs_attention";

export interface AttentionRecord {
  workstreamId: string;
  repoKey: string;
  needsAction: boolean;
  reasons: AttentionReason[];
  issueNumber?: number;
  pullRequestNumbers?: number[];
  commentIds?: string[];
  retryTargetCommentId?: string;
  mcpSkipTargetTaskId?: string;
  mcpSkipMcpHandle?: string;
  lastObservedAt: string;
  lastHandledAt?: string;
  currentPullRequestHeadSha?: string;
  lastHandledReviewHeadSha?: string;
  gaps?: string[];
}

export interface AttentionStateFile {
  attention: AttentionRecord[];
}

export interface RepoSyncRecord {
  repoId: string;
  repoName: string;
  repoSlug: string;
  localPath: string;
  codeRoot: string;
  status: "synced" | "failed";
  existedBeforeSync: boolean;
  cloned: boolean;
  fetched: boolean;
  /** Outcome of synchronizing the primary checkout after fetching origin. */
  defaultBranchSyncStatus?: "not_attempted" | "synced" | "blocked_dirty" | "failed";
  defaultBranch: string | null;
  defaultBranchSource: "config" | "github" | "git" | "unknown";
  currentBranchBefore: string | null;
  currentBranchAfter: string | null;
  syncedAt: string;
  message: string;
  githubScan?: {
    status: "not_run" | "scanned" | "partial" | "failed";
    scannedAt?: string;
    issueCount: number;
    pullRequestCount: number;
    commentCount: number;
    failures: RepoScanFailure[];
  };
  error?: {
    step: string;
    message: string;
  };
}

export interface RepoSyncStateFile {
  repos: RepoSyncRecord[];
}

export type ProviderSessionCapability =
  | "verified_headless_resume"
  | "unsupported"
  | "unverified";

export type ProviderSessionStatus =
  | "available"
  | "active"
  | "stale"
  | "closed"
  | "unsupported"
  | "unverified";

export interface ProviderSessionScope {
  repoKey: string;
  workstreamId: string;
  job: JobName;
  modelClass: "strong" | "cheap";
  configuredAgentId: string;
  provider: AgentProvider;
  localRepoPath: string;
  branchName: string;
}

export interface ProviderSessionRecord {
  id: string;
  scope: ProviderSessionScope;
  capability: ProviderSessionCapability;
  status: ProviderSessionStatus;
  providerSessionId?: string | undefined;
  providerSessionName?: string | undefined;
  createdAt: string;
  updatedAt: string;
  lastStartedAt?: string | undefined;
  lastResumedAt?: string | undefined;
  lastFailedAt?: string | undefined;
  notes?: string | undefined;
}

export interface ProviderSessionStateFile {
  providerSessions: ProviderSessionRecord[];
}

export type JobAgentAssignmentStatus = "active" | "stale" | "closed";

export interface JobAgentAssignmentRecord {
  id: string;
  repoKey: string;
  workstreamId: string;
  role: AgentStrategyRole;
  modelClass: "strong" | "cheap";
  jobKey: `${AgentStrategyRole}-${"strong" | "cheap"}`;
  configuredAgentId: string;
  provider: AgentProvider;
  status: JobAgentAssignmentStatus;
  createdAt: string;
  updatedAt: string;
  lastTaskId?: string;
  lastExecutionId?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastFailedAt?: string;
  notes?: string;
}

export interface JobAgentAssignmentStateFile {
  assignments: JobAgentAssignmentRecord[];
}

export interface EntityStateSnapshot {
  issueMetadata: EntityStateMetadata;
  prMetadata: EntityStateMetadata;
  commentMetadata: EntityStateMetadata;
  issues: NormalizedIssue[];
  prs: NormalizedPullRequest[];
  comments: NormalizedComment[];
}

export interface McpStatusActionRequired {
  reason: string;
  message?: string;
  fields?: string[];
}

export interface McpStatusConnection {
  localConnectionIdentity?: string;
  providerConnectionId?: string;
  namespace?: string;
  transport?: string;
  readinessProof?: "connected";
  readinessCheckedAt?: string;
}

export interface McpStatusDiscovered {
  name?: string;
  toolCount?: number;
  resourceCount?: number;
  promptCount?: number;
}

export interface McpStatusRecord {
  handle: string;
  providerId: "smithery";
  providerMcpId: string;
  status: "ready" | "resolved" | "action_required" | "resolution_failed" | "error";
  lastCheckedAt: string;
  message?: string;
  actionRequired?: McpStatusActionRequired;
  connection?: McpStatusConnection;
  discovered?: McpStatusDiscovered;
}

export interface McpStatusStateFile {
  mcpStatuses: McpStatusRecord[];
}

export interface WorkstreamMcpBlocker {
  /** Stable unique ID: `mcp-blocker:<workstreamId>:<mcpHandle>:<blockedTaskId>` */
  id: string;
  kind: "mcp_action_required";
  mcpHandle: string;
  affectedCapabilityNames: string[];
  /** Safe reason category only — never a URL, token, or raw provider payload. */
  safeReason: string;
  blockedTaskKind: TaskRecord["kind"];
  blockedTaskId: string;
  /** Present when the blocked task belongs to a packet worktree. */
  packetId?: string | undefined;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of when the user-facing GitHub comment was posted. Absent if not yet surfaced. */
  surfacedAt?: string | undefined;
  resolutionState: "waiting_for_user" | "skipped" | "cleared";
}

export interface WorkstreamMcpScopedExclusion {
  /** Stable unique ID: `mcp-exclusion:<workstreamId>:<mcpHandle>:<taskId>` */
  id: string;
  taskId: string;
  taskKind: TaskRecord["kind"];
  packetId?: string | undefined;
  mcpHandle: string;
  affectedCapabilityNames: string[];
  createdAt: string;
}

export interface ProviderLimitSignal {
  provider: AgentProvider;
  isLimited: boolean;
  limitType?: "session" | "weekly" | undefined;
  rawError?: string | undefined;
  detectedAt: string;
  resetTime?: string | undefined;
}

export type ProviderLimitStatus = "available" | "limited";

export interface ProviderLimitRecord {
  provider: AgentProvider;
  status: ProviderLimitStatus;
  limitType?: "session" | "weekly" | undefined;
  rawError?: string | undefined;
  detectedAt?: string | undefined;
  resetTime?: string | undefined;
  updatedAt: string;
}

export interface ProviderLimitStateFile {
  providerLimits: ProviderLimitRecord[];
}

export interface PersistedState {
  issueMetadata: EntityStateMetadata;
  prMetadata: EntityStateMetadata;
  commentMetadata: EntityStateMetadata;
  issues: NormalizedIssue[];
  prs: NormalizedPullRequest[];
  comments: NormalizedComment[];
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  worktrees: WorktreeRecord[];
  workstreams: WorkstreamRecord[];
  attention: AttentionRecord[];
  repos: RepoSyncRecord[];
  providerSessions: ProviderSessionRecord[];
  jobAgentAssignments: JobAgentAssignmentRecord[];
  retrospectiveCandidates: RetrospectiveCandidateRecord[];
  retrospectiveProblems: RetrospectiveProblemRecord[];
  retrospectiveOpportunities: LearningOpportunityRecord[];
  learningProposals: LearningProposalRecord[];
  managementPrs: ManagementPrRecord[];
  mcpStatuses: McpStatusRecord[];
  workspaceRecoveries: WorkspaceRecoveryRecord[];
  providerLimits?: ProviderLimitRecord[];
}

export type ParentBranchSyncStatus =
  | "synced"
  | "already_up_to_date"
  | "blocked"
  | "conflict"
  | "failed";

export interface AgentExecutionResult {
  triage?: TriageDecisionResult;
  review?: ReviewDecisionResult;
  planBreakdown?: PlanBreakdownResult;
  planBreakdownSessionId?: string;
  waveAssessment?: WaveAssessmentResult;
  parentBranchSync?: {
    status: ParentBranchSyncStatus;
    message: string;
    parentBranch: string;
    defaultBranch: string;
    parentPrNumber?: number;
    beforeComparison?: BranchSyncComparison;
    afterComparison?: BranchSyncComparison;
    error?: string;
  };
}


export interface PlanBreakdownTaskResult {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  blocks: string[];
  canRunInParallelWith: string[];
  risk: "low" | "medium" | "high";
  filesLikelyInvolved: string[];
  acceptanceCriteria: string[];
  verification: string[];
}

export interface PlanBreakdownWaveResult {
  id: string;
  taskIds: string[];
  rationale: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string[];
}

export interface PlanBreakdownResult {
  title: string;
  summary: string;
  tasks: PlanBreakdownTaskResult[];
  waves: PlanBreakdownWaveResult[];
  recommendedFirstWaveId: string;
  graphConcerns: string[];
  humanDecisionsNeeded: string[];
  suggestedNextAction: string;
  validationIssues?: ValidationIssue[] | undefined;
}

export interface TriageDecisionResult {
  decision: "answer_only" | "start_implementation";
  summary?: string;
  reply?: string;
}

export type ReviewAction = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type PullRequestReviewSide = "LEFT" | "RIGHT";

export interface ReviewInlineComment {
  path?: string;
  line?: number;
  side?: PullRequestReviewSide;
  startLine?: number;
  startSide?: PullRequestReviewSide;
  body?: string;
}

export interface ReviewFinding {
  path?: string;
  line?: number;
  body?: string;
}

export interface ReviewDecisionResult {
  action: ReviewAction;
  summary: string;
  inlineComments?: ReviewInlineComment[];
  /** @deprecated use action */
  decision?: "approve" | "request_changes";
  /** @deprecated use inlineComments */
  findings?: ReviewFinding[];
}
