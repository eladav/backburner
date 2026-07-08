import type {
  NormalizedComment,
  NormalizedIssue,
  NormalizedPullRequest
} from "../../domain/entities.js";
import type {
  RepoSyncRecord,
  WorktreeRecord
} from "../../state/types.js";
import { workflowRegistry } from "../../workflows/registry.js";
import type {
  TaskContextPacket,
  TaskKind,
  TaskRecord
} from "../types.js";
import type { CreateTaskInput } from "./types.js";

export function createIssueTask(
  kind: Extract<TaskKind, "product_discovery">,
  issue: NormalizedIssue,
  repoSyncRecord: RepoSyncRecord | undefined,
  input: CreateTaskInput,
  workstreamId?: string
): TaskRecord {
  return buildTaskRecord(
    buildTaskId(kind, issue.id),
    kind,
    issue,
    repoSyncRecord,
    input,
    input.contextBuilder.build({
      taskKind: kind,
      repoIdentifier: issue.repoSlug,
      sourceKind: "issue",
      sourceUrl: issue.url,
      labels: issue.labels,
      issueTitle: issue.title,
      issueBody: issue.body,
      ...(repoSyncRecord?.localPath ? { localRepoPath: repoSyncRecord.localPath } : {})
    }),
    workstreamId
  );
}

export function createPullRequestTask(
  kind: Extract<
    TaskKind,
    "review_pr" | "write_plan" | "implement_plan" | "prepare_pr_for_merge"
  >,
  pr: NormalizedPullRequest,
  repoSyncRecord: RepoSyncRecord | undefined,
  input: CreateTaskInput,
  worktree?: WorktreeRecord,
  workstreamId?: string
): TaskRecord {
  return buildTaskRecord(
    buildTaskId(kind, pr.id),
    kind,
    pr,
    repoSyncRecord,
    input,
    input.contextBuilder.build({
      taskKind: kind,
      repoIdentifier: pr.repoSlug,
      sourceKind: "pull_request",
      sourceUrl: pr.url,
      labels: pr.labels,
      ...(pr.headSha ? { headSha: pr.headSha } : {}),
      ...(worktree?.path
        ? {
          localRepoPath: worktree.path,
          branchName: worktree.branchName,
          planDocumentPath: worktree.planDocumentPath,
          ...(worktree.productSpecDocumentPath ? { productSpecDocumentPath: worktree.productSpecDocumentPath } : {}),
          logDocumentPath: worktree.logDocumentPath
        }
        : repoSyncRecord?.localPath
          ? { localRepoPath: repoSyncRecord.localPath }
          : {}),
      ...(worktree?.packet?.packetId ? { packetId: worktree.packet.packetId } : {})
    }),
    workstreamId
  );
}

export function buildTaskRecord(
  id: string,
  kind: Exclude<TaskKind, "respond_issue_comment" | "respond_pr_comment">,
  source: NormalizedIssue | NormalizedPullRequest,
  repoSyncRecord: RepoSyncRecord | undefined,
  input: CreateTaskInput,
  context: TaskContextPacket,
  workstreamId?: string
): TaskRecord {
  const executionPolicy = workflowRegistry.resolveTaskExecutionPolicy(kind);

  return {
    id,
    kind,
    status: "pending",
    executionPermission: executionPolicy.executionPermission,
    handoffPolicy: executionPolicy.handoffPolicy,
    repoId: source.repoId,
    repoName: source.repoName,
    repoSlug: source.repoSlug,
    sourceKind: source.kind,
    sourceId: source.id,
    sourceUrl: source.url,
    relevant: true,
    reason: input.reason,
    summary: input.summary,
    workstreamId,
    context,
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function buildTaskId(kind: TaskKind, sourceId: string): string {
  return `task:${kind}:${sourceId}`;
}

export function buildCommentReason(
  comment: NormalizedComment,
  previousComment: NormalizedComment | undefined
): string {
  if (!previousComment) {
    return `Comment is newly seen and needs a response path for ${comment.parentType.replace("_", " ")} #${comment.parentNumber}.`;
  }

  return `Comment changed since the last seen state (updatedAt ${previousComment.updatedAt} -> ${comment.updatedAt}).`;
}

export function isAgentAuthoredComment(comment: NormalizedComment): boolean {
  return comment.body.trimStart().startsWith("🤖");
}
