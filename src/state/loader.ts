import * as path from "node:path";
import type {
  AttentionRecord,
  AttentionStateFile,
  CommentStateFile,
  EntityStateMetadata,
  EntityStateSnapshot,
  IssueStateFile,
  PersistedState,
  PullRequestStateFile,
  ExecutionRecord,
  ExecutionStateFile,
  RepoSyncRecord,
  RepoSyncStateFile,
  TaskStateFile,
  WorkstreamRecord,
  WorkstreamStateFile,
  WorktreeRecord,
  WorktreeStateFile,
  ProviderSessionRecord,
  ProviderSessionStateFile,
  JobAgentAssignmentRecord,
  JobAgentAssignmentStateFile,
  RetrospectiveCandidateStateFile,
  RetrospectiveProblemStateFile,
  RetrospectiveOpportunityStateFile,
  LearningProposalStateFile,
  ManagementPrStateFile,
  McpStatusRecord,
  McpStatusStateFile,
  WorkspaceRecoveryRecord,
  WorkspaceRecoveryStateFile,
  ProviderLimitRecord,
  ProviderLimitStateFile,
  ReviewSessionStateFile
} from "./types.js";
import type {
  LearningOpportunityRecord,
  LearningProposalRecord,
  ManagementPrRecord,
  RetrospectiveCandidateRecord,
  RetrospectiveProblemRecord
} from "../retrospectives/types.js";
import type { AgentProvider } from "../config/types.js";
import { ProviderLimitStateFileSchema } from "../config/schemas.js";
import {
  REVIEW_SESSION_SCHEMA_VERSION,
  ReviewSessionStateFileSchema,
  type ReviewSessionRecord
} from "../reviews/session.js";
import {
  readJsonFileIfExists,
  writeJsonFileAtomic
} from "../utils/json.js";
import { outputsStateRoot, outputsLogsRoot } from "../utils/paths.js";

export class StateStore {
  private readonly stateDir: string;
  private readonly executionDir: string;

  constructor(
    baseDirOrOptions:
      | string
      | {
          stateDir?: string;
          executionDir?: string;
        } = { stateDir: outputsStateRoot, executionDir: outputsLogsRoot }
  ) {
    if (typeof baseDirOrOptions === "string") {
      this.stateDir = baseDirOrOptions;
      this.executionDir = baseDirOrOptions;
      return;
    }

    const hasExplicitStateDir = baseDirOrOptions.stateDir !== undefined;
    this.stateDir = baseDirOrOptions.stateDir ?? outputsStateRoot;
    this.executionDir =
      baseDirOrOptions.executionDir ??
      (hasExplicitStateDir ? this.stateDir : outputsLogsRoot);
  }

  async load(): Promise<PersistedState> {
    const issuesState = await this.loadIssueState();
    const prsState = await this.loadPullRequestState();
    const commentsState = await this.loadCommentState();

    const state = {
      issueMetadata: issuesState.metadata,
      prMetadata: prsState.metadata,
      commentMetadata: commentsState.metadata,
      issues: issuesState.issues,
      prs: prsState.prs,
      comments: commentsState.comments,
      tasks: await this.loadArrayFile<TaskStateFile["tasks"]>(this.stateDir, "tasks.json", "tasks"),
      executions: await this.loadArrayFile<ExecutionStateFile["executions"]>(
        this.executionDir,
        "executions.json",
        "executions"
      ),
      worktrees: await this.loadArrayFile<WorktreeStateFile["worktrees"]>(
        this.stateDir,
        "worktrees.json",
        "worktrees"
      ),
      workstreams: await this.loadArrayFile<WorkstreamStateFile["workstreams"]>(
        this.stateDir,
        "workstreams.json",
        "workstreams"
      ),
      reviewSessions: await this.loadReviewSessionState(),
      attention: await this.loadArrayFile<AttentionStateFile["attention"]>(
        this.stateDir,
        "attention.json",
        "attention"
      ),
      repos: await this.loadArrayFile<RepoSyncStateFile["repos"]>(this.stateDir, "repos.json", "repos"),
      providerSessions: await this.loadArrayFile<ProviderSessionStateFile["providerSessions"]>(
        this.stateDir,
        "provider-sessions.json",
        "providerSessions"
      ),
      jobAgentAssignments: await this.loadArrayFile<JobAgentAssignmentStateFile["assignments"]>(
        this.stateDir,
        "job-agent-assignments.json",
        "assignments"
      ),
      retrospectiveCandidates: await this.loadArrayFile<RetrospectiveCandidateRecord[]>(
        this.stateDir,
        "retrospective-candidates.json",
        "retrospectiveCandidates"
      ),
      retrospectiveProblems: await this.loadArrayFile<RetrospectiveProblemRecord[]>(
        this.stateDir,
        "retrospective-problems.json",
        "retrospectiveProblems"
      ),
      retrospectiveOpportunities: await this.loadArrayFile<LearningOpportunityRecord[]>(
        this.stateDir,
        "retrospective-opportunities.json",
        "retrospectiveOpportunities"
      ),
      learningProposals: await this.loadArrayFile<LearningProposalRecord[]>(
        this.stateDir,
        "learning-proposals.json",
        "learningProposals"
      ),
      managementPrs: await this.loadArrayFile<ManagementPrRecord[]>(
        this.stateDir,
        "management-prs.json",
        "managementPrs"
      ),
      mcpStatuses: await this.loadArrayFile<McpStatusStateFile["mcpStatuses"]>(
        this.stateDir,
        "mcp-status.json",
        "mcpStatuses"
      ),
      workspaceRecoveries: await this.loadArrayFile<WorkspaceRecoveryStateFile["records"]>(
        this.stateDir,
        "workspace-recovery.json",
        "records"
      ),
      providerLimits: await this.loadProviderLimitsState()
    };

    return state;
  }

  async writeRepoSyncState(records: RepoSyncRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "repos.json"), {
      repos: [...records].sort(compareRepoSyncRecords).map(sortRepoSyncRecord)
    });
  }

  async writeEntityState(snapshot: EntityStateSnapshot): Promise<void> {
    await Promise.all([
      writeJsonFileAtomic(path.join(this.stateDir, "issues.json"), {
        metadata: sortMetadata(snapshot.issueMetadata),
        issues: [...snapshot.issues].sort(compareIssueLikeEntities)
      } satisfies IssueStateFile),
      writeJsonFileAtomic(path.join(this.stateDir, "prs.json"), {
        metadata: sortMetadata(snapshot.prMetadata),
        prs: [...snapshot.prs].sort(compareIssueLikeEntities)
      } satisfies PullRequestStateFile),
      writeJsonFileAtomic(path.join(this.stateDir, "comments.json"), {
        metadata: sortMetadata(snapshot.commentMetadata),
        comments: [...snapshot.comments].sort(compareComments)
      } satisfies CommentStateFile)
    ]);
  }

  async writeTaskState(tasks: TaskStateFile["tasks"]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "tasks.json"), {
      tasks: [...tasks].sort(compareTasks)
    });
  }

  async writeExecutionState(executions: ExecutionRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.executionDir, "executions.json"), {
      executions: [...executions].sort(compareExecutions)
    });
  }

  async writeWorktreeState(worktrees: WorktreeRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "worktrees.json"), {
      worktrees: [...worktrees].sort(compareWorktrees)
    });
  }

  async writeWorkstreamState(workstreams: WorkstreamRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "workstreams.json"), {
      workstreams: [...workstreams].sort(compareWorkstreams)
    });
  }

  async writeReviewSessionState(records: ReviewSessionRecord[]): Promise<void> {
    const state = ReviewSessionStateFileSchema.parse({
      schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
      reviewSessions: [...records].sort(compareReviewSessions)
    });
    await writeJsonFileAtomic(path.join(this.stateDir, "review-sessions.json"), state);
  }

  async writeAttentionState(attention: AttentionRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "attention.json"), {
      attention: [...attention].sort(compareAttentionRecords).map(sortAttentionRecord)
    });
  }

  async writeProviderSessionState(records: ProviderSessionRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "provider-sessions.json"), {
      providerSessions: [...records].sort(compareProviderSessions)
    });
  }

  async writeJobAgentAssignmentState(records: JobAgentAssignmentRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "job-agent-assignments.json"), {
      assignments: [...records].sort(compareJobAgentAssignments)
    });
  }

  async writeRetrospectiveCandidateState(records: RetrospectiveCandidateRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "retrospective-candidates.json"), {
      retrospectiveCandidates: [...records].sort(compareRetrospectiveCandidates)
    });
  }

  async writeRetrospectiveProblemState(records: RetrospectiveProblemRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "retrospective-problems.json"), {
      retrospectiveProblems: [...records].sort(compareRetrospectiveProblems)
    });
  }

  async writeRetrospectiveOpportunityState(records: LearningOpportunityRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "retrospective-opportunities.json"), {
      retrospectiveOpportunities: [...records].sort(compareLearningOpportunities)
    });
  }

  async writeLearningProposalState(records: LearningProposalRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "learning-proposals.json"), {
      learningProposals: [...records].sort(compareLearningProposals)
    });
  }

  async writeManagementPrState(records: ManagementPrRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "management-prs.json"), {
      managementPrs: [...records].sort(compareManagementPrs)
    });
  }

  async writeMcpStatusState(records: McpStatusRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "mcp-status.json"), {
      mcpStatuses: [...records].sort((a, b) => a.handle.localeCompare(b.handle))
    } satisfies McpStatusStateFile);
  }

  async writeWorkspaceRecoveryState(records: WorkspaceRecoveryRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "workspace-recovery.json"), {
      records: [...records].sort(compareWorkspaceRecoveryRecords)
    } satisfies WorkspaceRecoveryStateFile);
  }

  async writeProviderLimitState(records: ProviderLimitRecord[]): Promise<void> {
    await writeJsonFileAtomic(path.join(this.stateDir, "provider-limits.json"), {
      providerLimits: [...records].sort(compareProviderLimits)
    } satisfies ProviderLimitStateFile);
  }

  async loadWorkspaceRecoveryState(): Promise<WorkspaceRecoveryRecord[]> {
    return this.loadArrayFile<WorkspaceRecoveryStateFile["records"]>(
      this.stateDir,
      "workspace-recovery.json",
      "records"
    );
  }

  async loadProviderLimitsState(): Promise<ProviderLimitRecord[]> {
    const filePath = path.join(this.stateDir, "provider-limits.json");
    const existing = await readJsonFileIfExists<unknown>(filePath);
    if (!existing) {
      return [];
    }
    const result = ProviderLimitStateFileSchema.safeParse(existing);
    if (!result.success) {
      console.error(
        `Failed to parse provider limits state file from ${filePath}.\n` +
          `Rejected payload: ${JSON.stringify(existing, null, 2)}\n` +
          `Reason: ${result.error.message}`
      );
      throw result.error;
    }
    return result.data.providerLimits;
  }

  async loadReviewSessionState(): Promise<ReviewSessionRecord[]> {
    const filePath = path.join(this.stateDir, "review-sessions.json");
    const existing = await readJsonFileIfExists<unknown>(filePath);
    if (existing === undefined) {
      const initialState: ReviewSessionStateFile = {
        schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
        reviewSessions: []
      };
      await writeJsonFileAtomic(filePath, initialState);
      return [];
    }

    const result = ReviewSessionStateFileSchema.safeParse(existing);
    if (!result.success) {
      const issue = result.error.issues[0];
      const issuePath = issue?.path.length ? `.${issue.path.join(".")}` : "";
      throw new Error(
        `${filePath}${issuePath}: ${issue?.message ?? "invalid review session state"}`
      );
    }
    return result.data.reviewSessions;
  }



  private async loadArrayFile<T extends unknown[]>(
    baseDir: string,
    fileName: string,
    key: string
  ): Promise<T> {
    const filePath = path.join(baseDir, fileName);
    const existing = await readJsonFileIfExists<Record<string, unknown>>(filePath);

    if (!existing) {
      const defaultValue = { [key]: [] as unknown as T };
      await writeJsonFileAtomic(filePath, defaultValue);
      return defaultValue[key] as T;
    }

    const value = existing[key];

    if (!Array.isArray(value)) {
      throw new Error(`${filePath}: "${key}" must be an array`);
    }

    return value as T;
  }

  private async loadIssueState(): Promise<IssueStateFile> {
    const value = await this.loadEntityFile<IssueStateFile["issues"]>("issues.json", "issues");
    return {
      metadata: value.metadata,
      issues: value.records
    };
  }

  private async loadPullRequestState(): Promise<PullRequestStateFile> {
    const value = await this.loadEntityFile<PullRequestStateFile["prs"]>("prs.json", "prs");
    return {
      metadata: value.metadata,
      prs: value.records
    };
  }

  private async loadCommentState(): Promise<CommentStateFile> {
    const value = await this.loadEntityFile<CommentStateFile["comments"]>("comments.json", "comments");
    return {
      metadata: value.metadata,
      comments: value.records
    };
  }

  private async loadEntityFile<T extends unknown[]>(
    fileName: string,
    key: "issues" | "prs" | "comments"
  ): Promise<{ metadata: EntityStateMetadata; records: T }> {
    const filePath = path.join(this.stateDir, fileName);
    const existing = await readJsonFileIfExists<Record<string, unknown>>(filePath);

    if (!existing) {
      const defaultValue = {
        metadata: defaultEntityStateMetadata(),
        [key]: []
      };
      await writeJsonFileAtomic(filePath, defaultValue);
      return {
        metadata: defaultValue.metadata,
        records: defaultValue[key] as unknown as T
      };
    }

    const entities = existing[key];
    if (!Array.isArray(entities)) {
      throw new Error(`${filePath}: "${key}" must be an array`);
    }

    const metadata = validateMetadata(existing.metadata, filePath);
    return {
      metadata,
      records: entities as T
    };
  }
}

export async function loadState(
  baseDirOrOptions:
    | string
    | {
        stateDir?: string;
        executionDir?: string;
      } = { stateDir: outputsStateRoot, executionDir: outputsLogsRoot }
): Promise<PersistedState> {
  return new StateStore(baseDirOrOptions).load();
}

function defaultEntityStateMetadata(): EntityStateMetadata {
  return {
    partialFailures: []
  };
}

function validateMetadata(value: unknown, filePath: string): EntityStateMetadata {
  if (value === undefined) {
    return defaultEntityStateMetadata();
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath}: "metadata" must be an object when provided`);
  }

  const metadata = value as Record<string, unknown>;
  const partialFailures = metadata.partialFailures;

  if (partialFailures !== undefined && !Array.isArray(partialFailures)) {
    throw new Error(`${filePath}: "metadata.partialFailures" must be an array when provided`);
  }

  return {
    ...(typeof metadata.generatedAt === "string" ? { generatedAt: metadata.generatedAt } : {}),
    ...(typeof metadata.repoCount === "number" ? { repoCount: metadata.repoCount } : {}),
    ...(typeof metadata.entityCount === "number" ? { entityCount: metadata.entityCount } : {}),
    partialFailures: sortFailures(
      (partialFailures as EntityStateMetadata["partialFailures"] | undefined) ?? []
    )
  };
}

function sortMetadata(metadata: EntityStateMetadata): EntityStateMetadata {
  return {
    ...(metadata.generatedAt ? { generatedAt: metadata.generatedAt } : {}),
    ...(metadata.repoCount !== undefined ? { repoCount: metadata.repoCount } : {}),
    ...(metadata.entityCount !== undefined ? { entityCount: metadata.entityCount } : {}),
    partialFailures: sortFailures(metadata.partialFailures)
  };
}

function sortFailures(failures: EntityStateMetadata["partialFailures"]): EntityStateMetadata["partialFailures"] {
  return [...failures].sort((left, right) => {
    const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
    if (repoComparison !== 0) {
      return repoComparison;
    }

    const stepComparison = left.step.localeCompare(right.step);
    if (stepComparison !== 0) {
      return stepComparison;
    }

    return left.scope.localeCompare(right.scope);
  });
}

function compareIssueLikeEntities(
  left: { repoSlug: string; number: number; id: string },
  right: { repoSlug: string; number: number; id: string }
): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  if (left.number !== right.number) {
    return left.number - right.number;
  }

  return left.id.localeCompare(right.id);
}

function compareComments(
  left: { repoSlug: string; parentNumber: number; id: string },
  right: { repoSlug: string; parentNumber: number; id: string }
): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  if (left.parentNumber !== right.parentNumber) {
    return left.parentNumber - right.parentNumber;
  }

  return left.id.localeCompare(right.id);
}

function compareTasks(
  left: { repoSlug: string; kind: string; id: string },
  right: { repoSlug: string; kind: string; id: string }
): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  const kindComparison = left.kind.localeCompare(right.kind);
  if (kindComparison !== 0) {
    return kindComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareExecutions(left: ExecutionRecord, right: ExecutionRecord): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  const taskComparison = left.taskId.localeCompare(right.taskId);
  if (taskComparison !== 0) {
    return taskComparison;
  }

  return left.startedAt.localeCompare(right.startedAt);
}

function compareWorktrees(left: WorktreeRecord, right: WorktreeRecord): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareRepoSyncRecords(left: RepoSyncRecord, right: RepoSyncRecord): number {
  return left.repoSlug.localeCompare(right.repoSlug);
}

function compareWorkstreams(left: WorkstreamRecord, right: WorkstreamRecord): number {
  const repoComparison = left.repoKey.localeCompare(right.repoKey);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareReviewSessions(left: ReviewSessionRecord, right: ReviewSessionRecord): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) return repoComparison;

  if (left.pullRequestNumber !== right.pullRequestNumber) {
    return left.pullRequestNumber - right.pullRequestNumber;
  }

  return left.id.localeCompare(right.id);
}

function compareAttentionRecords(left: AttentionRecord, right: AttentionRecord): number {
  const repoComparison = left.repoKey.localeCompare(right.repoKey);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.workstreamId.localeCompare(right.workstreamId);
}

function compareProviderSessions(left: ProviderSessionRecord, right: ProviderSessionRecord): number {
  const sL = left.scope;
  const sR = right.scope;

  const repoComparison = sL.repoKey.localeCompare(sR.repoKey);
  if (repoComparison !== 0) return repoComparison;

  const workstreamComparison = sL.workstreamId.localeCompare(sR.workstreamId);
  if (workstreamComparison !== 0) return workstreamComparison;

  const jobComparison = sL.job.localeCompare(sR.job);
  if (jobComparison !== 0) return jobComparison;

  const modelComparison = sL.modelClass.localeCompare(sR.modelClass);
  if (modelComparison !== 0) return modelComparison;

  const providerComparison = sL.provider.localeCompare(sR.provider);
  if (providerComparison !== 0) return providerComparison;

  const agentComparison = sL.configuredAgentId.localeCompare(sR.configuredAgentId);
  if (agentComparison !== 0) return agentComparison;

  const pathComparison = sL.localRepoPath.localeCompare(sR.localRepoPath);
  if (pathComparison !== 0) return pathComparison;

  const branchComparison = sL.branchName.localeCompare(sR.branchName);
  if (branchComparison !== 0) return branchComparison;

  return left.id.localeCompare(right.id);
}

function compareJobAgentAssignments(left: JobAgentAssignmentRecord, right: JobAgentAssignmentRecord): number {
  const repoComparison = left.repoKey.localeCompare(right.repoKey);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  const workstreamComparison = left.workstreamId.localeCompare(right.workstreamId);
  if (workstreamComparison !== 0) {
    return workstreamComparison;
  }

  const jobKeyComparison = left.jobKey.localeCompare(right.jobKey);
  if (jobKeyComparison !== 0) {
    return jobKeyComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareWorkspaceRecoveryRecords(
  left: WorkspaceRecoveryRecord,
  right: WorkspaceRecoveryRecord
): number {
  const taskComparison = left.taskId.localeCompare(right.taskId);
  if (taskComparison !== 0) {
    return taskComparison;
  }

  return left.recoveredAt.localeCompare(right.recoveredAt);
}

function compareProviderLimits(left: ProviderLimitRecord, right: ProviderLimitRecord): number {
  return left.provider.localeCompare(right.provider);
}

function compareRetrospectiveCandidates(
  left: RetrospectiveCandidateRecord,
  right: RetrospectiveCandidateRecord
): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) return repoComparison;

  const workstreamComparison = left.sourceWorkstreamId.localeCompare(right.sourceWorkstreamId);
  if (workstreamComparison !== 0) return workstreamComparison;

  return left.id.localeCompare(right.id);
}

function compareRetrospectiveProblems(
  left: RetrospectiveProblemRecord,
  right: RetrospectiveProblemRecord
): number {
  const candidateComparison = left.candidateId.localeCompare(right.candidateId);
  if (candidateComparison !== 0) return candidateComparison;

  return left.id.localeCompare(right.id);
}

function compareLearningOpportunities(
  left: LearningOpportunityRecord,
  right: LearningOpportunityRecord
): number {
  const problemComparison = left.problemId.localeCompare(right.problemId);
  if (problemComparison !== 0) return problemComparison;

  return left.id.localeCompare(right.id);
}

function compareLearningProposals(
  left: LearningProposalRecord,
  right: LearningProposalRecord
): number {
  if (!left.selectedScope && !right.selectedScope) return left.id.localeCompare(right.id);
  if (!left.selectedScope) return 1;
  if (!right.selectedScope) return -1;

  const scopeKindComparison = left.selectedScope.kind.localeCompare(right.selectedScope.kind);
  if (scopeKindComparison !== 0) return scopeKindComparison;

  return left.id.localeCompare(right.id);
}

function compareManagementPrs(left: ManagementPrRecord, right: ManagementPrRecord): number {
  const modeComparison = left.mode.localeCompare(right.mode);
  if (modeComparison !== 0) return modeComparison;

  const statusComparison = left.status.localeCompare(right.status);
  if (statusComparison !== 0) return statusComparison;

  if (left.prNumber !== undefined && right.prNumber !== undefined) {
    return left.prNumber - right.prNumber;
  }

  if (left.branchName !== undefined && right.branchName !== undefined) {
    return left.branchName.localeCompare(right.branchName);
  }

  return left.id.localeCompare(right.id);
}

function sortAttentionRecord(record: AttentionRecord): AttentionRecord {
  return {
    workstreamId: record.workstreamId,
    repoKey: record.repoKey,
    needsAction: record.needsAction,
    reasons: [...record.reasons].sort((left, right) => left.localeCompare(right)),
    ...(record.issueNumber !== undefined ? { issueNumber: record.issueNumber } : {}),
    ...(record.pullRequestNumbers?.length
      ? { pullRequestNumbers: [...record.pullRequestNumbers].sort((left, right) => left - right) }
      : {}),
    ...(record.commentIds?.length
      ? { commentIds: [...record.commentIds].sort((left, right) => left.localeCompare(right)) }
      : {}),
    ...(record.retryTargetCommentId !== undefined ? { retryTargetCommentId: record.retryTargetCommentId } : {}),
    lastObservedAt: record.lastObservedAt,
    ...(record.lastHandledAt ? { lastHandledAt: record.lastHandledAt } : {}),
    ...(record.currentPullRequestHeadSha ? { currentPullRequestHeadSha: record.currentPullRequestHeadSha } : {}),
    ...(record.lastHandledReviewHeadSha ? { lastHandledReviewHeadSha: record.lastHandledReviewHeadSha } : {}),
    ...(record.gaps?.length ? { gaps: [...record.gaps].sort((left, right) => left.localeCompare(right)) } : {})
  };
}

function sortRepoSyncRecord(record: RepoSyncRecord): RepoSyncRecord {
  return {
    ...record,
    ...(record.githubScan
      ? {
          githubScan: {
            ...record.githubScan,
            failures: sortFailures(record.githubScan.failures)
          }
        }
      : {})
  };
}
