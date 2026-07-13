import type { ContextBuilder } from "../../context/types.js";
import type { RepoConfig } from "../../config/types.js";
import type {
  NormalizedComment,
  NormalizedIssue,
  NormalizedPullRequest
} from "../../domain/entities.js";
import type {
  AttentionRecord,
  PersistedState,
  RepoSyncRecord,
  WorkstreamRecord,
  WorktreeRecord
} from "../../state/types.js";
import type { PacketPullRequestProjection } from "../../workstreams/packet-projections.js";
import type { TaskRecord } from "../types.js";

export interface TaskDerivationInput {
  repos: RepoConfig[];
  repoSyncRecords: RepoSyncRecord[];
  previousState: PersistedState;
  currentIssues: NormalizedIssue[];
  currentPullRequests: NormalizedPullRequest[];
  currentComments: NormalizedComment[];
  worktrees?: WorktreeRecord[];
  workstreams?: WorkstreamRecord[];
  attention?: AttentionRecord[];
  contextBuilder: ContextBuilder;
  managementRepo?: {
    repoId?: string;
    repoSlug?: string;
  };
  now: string;
}

export interface ResolvedWorkstreamContext {
  workstream: WorkstreamRecord;
  attention: AttentionRecord | undefined;
  issue: NormalizedIssue | undefined;
  activePullRequest: NormalizedPullRequest | undefined;
  activeWorktree: WorktreeRecord | undefined;
  repoConfig: RepoConfig | undefined;
  repoSyncRecord: RepoSyncRecord | undefined;
  packetPullRequest?: NormalizedPullRequest | undefined;
  isManagementPullRequest: boolean;
}

export interface TaskDerivationEnvironment {
  input: TaskDerivationInput;
  repoConfigs: Map<string, RepoConfig>;
  repoSyncRecords: Map<string, RepoSyncRecord>;
  previousIssues: Map<string, NormalizedIssue>;
  previousPullRequests: Map<string, NormalizedPullRequest>;
  previousComments: Map<string, NormalizedComment>;
  currentIssues: NormalizedIssue[];
  currentPullRequests: NormalizedPullRequest[];
  currentCommentsById: Map<string, NormalizedComment>;
  currentIssuesByRepoAndNumber: Map<string, NormalizedIssue>;
  currentPrsByRepoAndNumber: Map<string, NormalizedPullRequest>;
  packetPullRequestProjections: PacketPullRequestProjection[];
  packetProjectionByRepoAndPrNumber: Map<string, PacketPullRequestProjection>;
  packetWorktreesByWorkstreamId: Map<string, WorktreeRecord[]>;
  existingTasks: TaskRecord[];
  existingTasksById: Map<string, TaskRecord>;
}

export interface TaskDerivationHandler {
  name: string;
  derive(
    context: ResolvedWorkstreamContext,
    env: TaskDerivationEnvironment,
    sink: TaskDerivationSink
  ): TaskRecord[];
}

export interface BlockingTaskDerivationHandler extends TaskDerivationHandler {
  shouldBlockRemainingHandlers(task: TaskRecord): boolean;
}

export interface CreateTaskInput {
  reason: string;
  summary: string;
  contextBuilder: ContextBuilder;
  now: string;
}

export interface CreateWorktreeTaskInput {
  contextBuilder: ContextBuilder;
  now: string;
}

export interface CommentTaskWorktreeContext {
  localRepoPath?: string | undefined;
  branchName?: string | undefined;
  planDocumentPath?: string | undefined;
  productSpecDocumentPath?: string | undefined;
  logDocumentPath?: string | undefined;
  packetId?: string | undefined;
}

export interface TaskDerivationSink {
  add(task: TaskRecord): TaskRecord;
  replace(task: TaskRecord): TaskRecord;
  get(taskId: string): TaskRecord | undefined;
  preserveExisting(taskId: string): TaskRecord | undefined;
}
