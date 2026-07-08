import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { RepoConfig } from "../config/types.js";
import { DefaultContextBuilder } from "../context/types.js";
import type { NormalizedIssue, NormalizedPullRequest } from "../domain/entities.js";
import type { GitGateway } from "../git/types.js";
import type { GitHubGateway, GhPullRequestSummary } from "../github/types.js";
import { slugify } from "../utils/slug.js";
import { getPacketSlug } from "../workstreams/utils.js";
import type { Logger } from "../utils/logger.js";
import type {
  TriageDecisionResult,
  WorkstreamPacket,
  WorkstreamRecord,
  WorktreeRecord
} from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { workflowRegistry } from "../workflows/registry.js";
import {
  getCurrentWaveIndex,
  getUndispatchedCurrentWavePackets
} from "../workstreams/packet-plan.js";

const WORKTREE_ROOT_DIR = "_worktrees";
const AGENT_DOCS_ROOT_DIR = path.join("docs", "agents");

export interface StartImplementationInput {
  repo: RepoConfig;
  repoPath: string;
  codeRoot: string;
  issue: NormalizedIssue;
  decision: TriageDecisionResult;
  existingWorktrees: WorktreeRecord[];
  triggerCommentText?: string;
  triggerCommentUrl?: string;
}

export interface WorktreePreparationResult {
  worktree: WorktreeRecord;
  created: boolean;
}

export class ImplementationWorkflowService {
  constructor(
    private readonly gitGateway: GitGateway,
    private readonly gitHubGateway: GitHubGateway,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async ensureWorktreeForIssue(input: StartImplementationInput): Promise<WorktreePreparationResult> {
    const branchName = buildWorktreeBranchName(input.repo, input.issue.number);
    const baseBranch = input.repo.defaultBranch ?? "main";
    const existing =
      input.existingWorktrees.find(
        (worktree) => worktree.repoId === input.repo.id && worktree.issueNumber === input.issue.number
      ) ??
      input.existingWorktrees.find(
        (worktree) => worktree.repoId === input.repo.id && worktree.branchName === branchName
      );

    if (existing) {
      const preparedPaths = await preparePlanDocuments(
        existing.path,
        input.issue,
        input.decision,
        existing.branchName
      );
      return {
        worktree: {
          ...existing,
          issueId: input.issue.id,
          issueNumber: input.issue.number,
          baseBranch: existing.baseBranch ?? baseBranch,
          planDocumentPath: preparedPaths.planDocumentPath,
          productSpecDocumentPath: preparedPaths.productSpecDocumentPath,
          logDocumentPath: preparedPaths.logDocumentPath,
          status: existing.status === "closed" ? "product_specification" : existing.status,
          ...(input.triggerCommentText ? { triggerCommentText: input.triggerCommentText } : {}),
          ...(input.triggerCommentUrl ? { triggerCommentUrl: input.triggerCommentUrl } : {}),
          updatedAt: this.now()
        },
        created: false
      };
    }

    const worktreePath = this.gitGateway.validatePathWithinCodeRoot(
      input.codeRoot,
      buildWorktreeRelativePath(input.repo, input.issue.number)
    );
    const startPoint = input.repo.defaultBranch ? `origin/${input.repo.defaultBranch}` : "origin/HEAD";
    const createdPath = await this.gitGateway.createWorktree(
      input.repoPath,
      input.codeRoot,
      worktreePath,
      branchName,
      startPoint
    );
    const preparedPaths = await preparePlanDocuments(
      createdPath,
      input.issue,
      input.decision,
      branchName
    );
    const timestamp = this.now();

    return {
      created: true,
      worktree: {
        id: buildWorktreeId(input.repo.owner, input.repo.name, input.issue.number),
        repoId: input.repo.id,
        repoSlug: `${input.repo.owner}/${input.repo.name}`,
        repoName: input.repo.name,
        issueId: input.issue.id,
        issueNumber: input.issue.number,
        baseBranch,
        branchName,
        path: createdPath,
        planDocumentPath: preparedPaths.planDocumentPath,
        productSpecDocumentPath: preparedPaths.productSpecDocumentPath,
        logDocumentPath: preparedPaths.logDocumentPath,
        status: "product_specification",
        ...(input.triggerCommentText ? { triggerCommentText: input.triggerCommentText } : {}),
        ...(input.triggerCommentUrl ? { triggerCommentUrl: input.triggerCommentUrl } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      }
    };
  }

  async ensurePullRequestForWorktree(
    repo: RepoConfig,
    issue: NormalizedIssue,
    worktree: WorktreeRecord
  ): Promise<{ worktree: WorktreeRecord; pullRequestCreated: boolean }> {
    const existingPr =
      worktree.prId && worktree.prNumber !== undefined && worktree.prUrl
        ? {
            id: worktree.prId,
            number: worktree.prNumber,
            url: worktree.prUrl
          }
        : undefined;
    const existingRemotePr =
      existingPr?.number !== undefined
        ? existingPr
        : await this.gitHubGateway.findOpenPullRequestByHeadBranch(repo.owner, repo.name, worktree.branchName);

    if (!existingRemotePr) {
      const baseBranch = worktree.baseBranch ?? repo.defaultBranch ?? "main";
      const bootstrapCommitCreated = await this.ensureBootstrapCommit(worktree.path, issue, baseBranch);
      await this.gitGateway.pushBranch(worktree.path, worktree.branchName);
      const createdPr = await this.gitHubGateway.createPullRequest({
        owner: repo.owner,
        name: repo.name,
        headBranch: worktree.branchName,
        baseBranch,
        title: buildPullRequestTitle(issue),
        body: buildPullRequestBody(issue, worktree)
      });
      const timestamp = this.now();
      return {
        worktree: {
          ...worktree,
          prId: createdPr.id,
          prNumber: createdPr.number,
          prUrl: createdPr.url,
          baseBranch,
          status: worktree.productSpecWrittenAt ? "awaiting_plan_approval" : "product_specification",
          bootstrapCommitCreated,
          branchPushedAt: timestamp,
          pullRequestCreatedAt: timestamp,
          updatedAt: timestamp
        },
        pullRequestCreated: true
      };
    }

    return {
      worktree: {
        ...worktree,
        prId: existingRemotePr.id,
        prNumber: existingRemotePr.number,
        prUrl: existingRemotePr.url,
        baseBranch:
          worktree.baseBranch ??
          (existingRemotePr as GhPullRequestSummary).baseRefName ??
          repo.defaultBranch ??
          "main",
        status: worktree.productSpecWrittenAt ? "awaiting_plan_approval" : "product_specification",
        updatedAt: this.now()
      },
      pullRequestCreated: false
    };
  }

  async ensurePacketPlanningWorktreesForCurrentWave(input: {
    repo: RepoConfig;
    repoPath: string;
    codeRoot: string;
    parentWorkstream: WorkstreamRecord;
    existingWorktrees: WorktreeRecord[];
  }): Promise<WorktreePreparationResult[]> {
    const { repo, repoPath, codeRoot, parentWorkstream, existingWorktrees } = input;
    const packetPlan = parentWorkstream.packetPlan;
    if (!packetPlan) {
      return [];
    }

    const integrationBranch = parentWorkstream.integration?.branchName;
    if (!integrationBranch) {
      return [];
    }

    const waveIndex = getCurrentWaveIndex(packetPlan);
    const packetsToDispatch = getUndispatchedCurrentWavePackets(packetPlan);
    const results: WorktreePreparationResult[] = [];

    for (const packet of packetsToDispatch) {
      const branchName = buildPacketWorktreeBranchName({ repo, parentWorkstream, packetId: packet.id });
      const worktreeId = buildPacketWorktreeId({ repo, parentWorkstream, packetId: packet.id });

      const existing =
        existingWorktrees.find(
          (wt) =>
            wt.packet?.parentWorkstreamId === parentWorkstream.id &&
            wt.packet?.packetId === packet.id &&
            wt.packet?.waveIndex === waveIndex
        ) ??
        existingWorktrees.find(
          (wt) => wt.repoId === repo.id && wt.branchName === branchName
        );

      if (existing) {
        const preparedPaths = await preparePacketPlanDocuments({
          worktreePath: existing.path,
          parentWorkstream,
          packet,
          waveIndex,
          branchName,
          now: this.now,
          existingPaths: {
            planDocumentPath: existing.planDocumentPath,
            logDocumentPath: existing.logDocumentPath
          }
        });
        results.push({
          worktree: {
            ...existing,
            packet: {
              parentWorkstreamId: parentWorkstream.id,
              packetId: packet.id,
              waveIndex,
              parentIntegrationBranch: integrationBranch
            },
            baseBranch: existing.baseBranch ?? integrationBranch,
            planDocumentPath: preparedPaths.planDocumentPath,
            logDocumentPath: preparedPaths.logDocumentPath,
            updatedAt: this.now()
          },
          created: false
        });
        continue;
      }

      const worktreePath = this.gitGateway.validatePathWithinCodeRoot(
        codeRoot,
        buildPacketWorktreeRelativePath({ repo, parentWorkstream, packetId: packet.id })
      );
      const startPoint = `origin/${integrationBranch}`;

      const createdPath = await this.gitGateway.createWorktree(
        repoPath,
        codeRoot,
        worktreePath,
        branchName,
        startPoint
      );

      const preparedPaths = await preparePacketPlanDocuments({
        worktreePath: createdPath,
        parentWorkstream,
        packet,
        waveIndex,
        branchName,
        now: this.now
      });

      const timestamp = this.now();
      results.push({
        created: true,
        worktree: {
          id: worktreeId,
          repoId: repo.id,
          repoSlug: `${repo.owner}/${repo.name}`,
          repoName: repo.name,
          packet: {
            parentWorkstreamId: parentWorkstream.id,
            packetId: packet.id,
            waveIndex,
            parentIntegrationBranch: integrationBranch
          },
          baseBranch: integrationBranch,
          branchName,
          path: createdPath,
          planDocumentPath: preparedPaths.planDocumentPath,
          logDocumentPath: preparedPaths.logDocumentPath,
          status: "planning",
          createdAt: timestamp,
          updatedAt: timestamp
        }
      });
    }

    return results;
  }

  async ensurePullRequestForPacketWorktree(
    repo: RepoConfig,
    parentWorkstream: WorkstreamRecord,
    worktree: WorktreeRecord
  ): Promise<{ worktree: WorktreeRecord; pullRequestCreated: boolean }> {
    if (!worktree.packet) {
      throw new Error("Worktree is not a packet worktree");
    }

    const packet = parentWorkstream.packetPlan?.packets[worktree.packet.packetId];
    if (!packet) {
      throw new Error(
        `Packet ${worktree.packet.packetId} not found in workstream ${parentWorkstream.id}`
      );
    }

    const existingPr =
      worktree.prId && worktree.prNumber !== undefined && worktree.prUrl
        ? {
            id: worktree.prId,
            number: worktree.prNumber,
            url: worktree.prUrl
          }
        : undefined;

    const existingRemotePr =
      existingPr?.number !== undefined
        ? existingPr
        : await this.gitHubGateway.findOpenPullRequestByHeadBranch(
            repo.owner,
            repo.name,
            worktree.branchName
          );

    if (!existingRemotePr) {
      const baseBranch = worktree.baseBranch ?? worktree.packet.parentIntegrationBranch;

      const bootstrapCommitCreated = await this.ensurePacketBootstrapCommit(
        worktree.path,
        worktree.packet.packetId,
        baseBranch
      );
      await this.gitGateway.pushBranch(worktree.path, worktree.branchName);

      const createdPr = await this.gitHubGateway.createPullRequest({
        owner: repo.owner,
        name: repo.name,
        headBranch: worktree.branchName,
        baseBranch,
        title: buildPacketPullRequestTitle({ parentWorkstream, packetId: packet.id }),
        body: buildPacketPullRequestBody({ parentWorkstream, packet, worktree })
      });

      const timestamp = this.now();
      return {
        worktree: {
          ...worktree,
          prId: createdPr.id,
          prNumber: createdPr.number,
          prUrl: createdPr.url,
          baseBranch,
          status: "planning",
          bootstrapCommitCreated,
          branchPushedAt: timestamp,
          pullRequestCreatedAt: timestamp,
          updatedAt: timestamp
        },
        pullRequestCreated: true
      };
    }

    return {
      worktree: {
        ...worktree,
        prId: existingRemotePr.id,
        prNumber: existingRemotePr.number,
        prUrl: existingRemotePr.url,
        baseBranch:
          worktree.baseBranch ??
          (existingRemotePr as GhPullRequestSummary).baseRefName ??
          worktree.packet.parentIntegrationBranch,
        status: "planning",
        updatedAt: this.now()
      },
      pullRequestCreated: false
    };
  }

  linkPullRequests(
    worktrees: WorktreeRecord[],
    prs: NormalizedPullRequest[],
    repos: RepoConfig[]
  ): WorktreeRecord[] {
    const prsByRepoAndBranch = new Map(
      prs.map((pr) => [`${pr.repoId}:${pr.headBranch}`, pr] as const)
    );
    const reposById = new Map(repos.map((repo) => [repo.id, repo]));

    return worktrees.map((worktree) => {
      const pr = prsByRepoAndBranch.get(`${worktree.repoId}:${worktree.branchName}`);
      const repo = reposById.get(worktree.repoId);
      if (!pr) {
        return worktree;
      }

      const status =
        worktree.status === "implementation_done"
          ? "implementation_done"
        : !worktree.packet && worktree.status === "product_specification"
          ? worktree.productSpecWrittenAt
            ? "awaiting_plan_approval"
            : "product_specification"
          : !worktree.packet &&
              worktree.status === "awaiting_plan_approval" &&
              repo &&
              pr.labels.includes(repo.labels.agentPlanApproved)
          ? "implementation_ready"
          : !worktree.packet &&
              (worktree.status === "implementation_ready" || worktree.status === "implementing")
            ? "awaiting_plan_approval"
            : worktree.status;

      return {
        ...worktree,
        prId: pr.id,
        prNumber: pr.number,
        prUrl: pr.url,
        baseBranch: worktree.baseBranch ?? pr.baseBranch,
        status,
        updatedAt: this.now()
      };
    });
  }

  reconcilePacketWorktreeReadinessFromProjections(
    worktrees: WorktreeRecord[],
    projections: import("../workstreams/packet-projections.js").PacketPullRequestProjection[],
    repos: RepoConfig[],
    tasks: TaskRecord[] = [],
    workstreams?: WorkstreamRecord[],
    pullRequests?: NormalizedPullRequest[]
  ): WorktreeRecord[] {
    const reposById = new Map(repos.map((repo) => [repo.id, repo]));
    const projectionsByWorktreeId = new Map(
      projections
        .filter((p) => p.packetWorktree?.id)
        .map((p) => [p.packetWorktree!.id, p] as const)
    );
    const tasksByWorktreeId = groupTasksByWorktreeId(tasks);

    return worktrees.map((worktree) => {
      if (!worktree.packet) {
        return worktree;
      }

      const parentWorkstream = workstreams?.find((w) => w.id === worktree.packet!.parentWorkstreamId);
      const isParentInactive =
        workstreams !== undefined &&
        (!parentWorkstream ||
          parentWorkstream.status === "closed" ||
          parentWorkstream.status === "merged" ||
          parentWorkstream.phase === "abandoned" ||
          parentWorkstream.phase === "resolved");

      const projection = projectionsByWorktreeId.get(worktree.id);

      const hasClosedPr =
        (projection !== undefined &&
          (projection.pullRequest.state === "closed" || projection.pullRequest.state === "merged")) ||
        (pullRequests !== undefined &&
          worktree.prNumber !== undefined &&
          !pullRequests.some((pr) => pr.repoId === worktree.repoId && pr.number === worktree.prNumber));

      if (isParentInactive || hasClosedPr) {
        if (worktree.status === "closed") {
          return worktree;
        }
        return {
          ...worktree,
          ...(projection ? {
            prId: projection.pullRequest.id,
            prNumber: projection.pullRequest.number,
            prUrl: projection.pullRequest.url,
            baseBranch: worktree.baseBranch ?? projection.pullRequest.baseBranch,
          } : {}),
          status: "closed",
          updatedAt: this.now()
        };
      }

      if (!projection) {
        return worktree;
      }

      const repo = reposById.get(worktree.repoId);
      const hasApproval =
        Boolean(repo && projection.pullRequest.labels.includes(repo.labels.agentPlanApproved));
      const status = worktree.status === "implementation_done"
        ? "implementation_done"
        : hasApproval
        ? deriveApprovedPacketWorktreeStatus(worktree, tasksByWorktreeId.get(worktree.id) ?? [])
        : worktree.status === "implementation_ready" || worktree.status === "implementing"
          ? "awaiting_plan_approval"
          : worktree.status;

      return {
        ...worktree,
        prId: projection.pullRequest.id,
        prNumber: projection.pullRequest.number,
        prUrl: projection.pullRequest.url,
        baseBranch: worktree.baseBranch ?? projection.pullRequest.baseBranch,
        status,
        updatedAt: this.now()
      };
    });
  }

  reconcileTaskState(worktrees: WorktreeRecord[], tasks: TaskRecord[]): WorktreeRecord[] {
    const tasksByWorktreeId = groupTasksByWorktreeId(tasks);
    const tasksByWorktreePath = groupTasksByWorktreePath(tasks);

    return worktrees.map((worktree) => {
      const relatedTasks = [
        ...(tasksByWorktreeId.get(worktree.id) ?? []),
        ...(tasksByWorktreePath.get(worktree.path) ?? [])
      ];
      const status = deriveWorktreeStatusFromTasks(worktree, relatedTasks);
      const productSpecTask = relatedTasks.find((task) => task.kind === "write_product_spec" && task.status === "completed");
      const hasProductSpecArtifact = hasMeaningfulProductSpecArtifact(worktree);
      const productSpecWrittenAt =
        hasProductSpecArtifact
          ? worktree.productSpecWrittenAt ?? productSpecTask?.updatedAt ?? productSpecTask?.createdAt
          : undefined;

      if (status === worktree.status && productSpecWrittenAt === worktree.productSpecWrittenAt) {
        return worktree;
      }

      const { productSpecWrittenAt: _staleProductSpecWrittenAt, ...worktreeWithoutProductSpecWrittenAt } = worktree;
      return {
        ...worktreeWithoutProductSpecWrittenAt,
        status,
        ...(productSpecWrittenAt ? { productSpecWrittenAt } : {}),
        updatedAt: this.now()
      };
    });
  }

  async finalizePushableHandoffs(
    worktrees: WorktreeRecord[],
    tasks: TaskRecord[],
    logger?: Logger
  ): Promise<WorktreeRecord[]> {
    const worktreesByPath = new Map(worktrees.map((worktree) => [worktree.path, worktree] as const));
    const updatedWorktrees = new Map(worktrees.map((worktree) => [worktree.id, worktree] as const));

    for (const task of tasks) {
      if (
        task.status !== "completed" ||
        task.executionPermission !== "workspace-write" ||
        !task.handoffPolicy.expectsPushableHandoff ||
        task.kind === "prepare_pr_for_merge"
      ) {
        continue;
      }

      const worktree = task.context.localRepoPath
        ? worktreesByPath.get(task.context.localRepoPath)
        : undefined;
      if (!worktree) {
        continue;
      }

      const branchName = task.context.branchName ?? worktree.branchName;
      const localRepoPath = worktree.path;
      const wasClean = await this.gitGateway.isWorkingTreeClean(localRepoPath);
      const committed = wasClean
        ? false
        : await this.gitGateway.commitAll(localRepoPath, buildHandoffCommitMessage(task, worktree));
      const hasUnpushedCommits = committed
        ? true
        : await safeHasCommitsAhead(this.gitGateway, localRepoPath, `origin/${branchName}`);

      if (!hasUnpushedCommits) {
        continue;
      }

      await this.gitGateway.pushBranch(localRepoPath, branchName);
      const pushedAt = this.now();
      const updatedWorktree: WorktreeRecord = {
        ...worktree,
        branchPushedAt: pushedAt,
        updatedAt: pushedAt
      };
      updatedWorktrees.set(updatedWorktree.id, updatedWorktree);
      worktreesByPath.set(updatedWorktree.path, updatedWorktree);
      logger?.info(
        JSON.stringify({
          component: "worktree-handoff",
          taskId: task.id,
          taskKind: task.kind,
          repoSlug: task.repoSlug,
          worktreePath: localRepoPath,
          branchName,
          committed,
          pushed: true,
          orchestratorOwnsPush: task.handoffPolicy.orchestratorOwnsPush
        })
      );
    }

    return [...updatedWorktrees.values()].sort(compareWorktrees);
  }

  private async ensureBootstrapCommit(
    worktreePath: string,
    issue: NormalizedIssue,
    baseBranch: string
  ): Promise<boolean> {
    const hasCommitsAhead = await this.gitGateway.hasCommitsAhead(worktreePath, `origin/${baseBranch}`);
    if (hasCommitsAhead) {
      return false;
    }

    return this.gitGateway.commitAll(
      worktreePath,
      `chore(agent): initialize plan workflow for #${issue.number}`
    );
  }

  private async ensurePacketBootstrapCommit(
    worktreePath: string,
    packetId: string,
    baseBranch: string
  ): Promise<boolean> {
    const hasCommitsAhead = await this.gitGateway.hasCommitsAhead(worktreePath, `origin/${baseBranch}`);
    if (hasCommitsAhead) {
      return false;
    }

    return this.gitGateway.commitAll(
      worktreePath,
      `chore(agent): initialize packet ${packetId} planning workflow`
    );
  }
}

async function safeHasCommitsAhead(
  gitGateway: GitGateway,
  localPath: string,
  baseRef: string
): Promise<boolean> {
  try {
    return await gitGateway.hasCommitsAhead(localPath, baseRef);
  } catch {
    return true;
  }
}

function buildHandoffCommitMessage(task: TaskRecord, worktree: WorktreeRecord): string {
  switch (task.kind) {
    case "write_product_spec":
      return `chore(agent): capture product spec for #${worktree.issueNumber ?? task.sourceId}`;
    case "write_plan":
      return `chore(agent): capture plan updates for #${worktree.issueNumber ?? task.sourceId}`;
    case "implement_plan":
      return `feat(agent): capture implementation updates for #${worktree.issueNumber ?? task.sourceId}`;
    case "respond_pr_comment":
      return `chore(agent): apply PR follow-up for ${task.repoSlug}`;
    case "prepare_pr_for_merge":
      return `chore(agent): capture merge preparation for #${worktree.prNumber ?? task.sourceId}`;
    default:
      return `chore(agent): capture task handoff for ${task.kind}`;
  }
}

export function buildWorktreeProductSpecTaskRecord(
  worktree: WorktreeRecord,
  issue: NormalizedIssue,
  now: string
): TaskRecord {
  const executionPolicy = workflowRegistry.resolveTaskExecutionPolicy("write_product_spec");
  const productSpecDocumentPath =
    worktree.productSpecDocumentPath ??
    path.join(worktree.path, buildAgentDocumentRelativePaths(issue.number, worktree.branchName).productSpecDocumentPath);
  const context = new DefaultContextBuilder().build({
    taskKind: "write_product_spec",
    repoIdentifier: worktree.repoSlug,
    localRepoPath: worktree.path,
    branchName: worktree.branchName,
    productSpecDocumentPath,
    planDocumentPath: worktree.planDocumentPath,
    logDocumentPath: worktree.logDocumentPath,
    sourceKind: "issue",
    sourceUrl: issue.url,
    labels: issue.labels,
    issueTitle: issue.title,
    issueBody: issue.body
  });

  return {
    id: `task:write_product_spec:worktree:${worktree.id}`,
    kind: "write_product_spec",
    status: "pending",
    executionPermission: executionPolicy.executionPermission,
    handoffPolicy: executionPolicy.handoffPolicy,
    repoId: worktree.repoId,
    repoName: worktree.repoName,
    repoSlug: worktree.repoSlug,
    sourceKind: "issue",
    sourceId: issue.id,
    sourceUrl: issue.url,
    relevant: true,
    reason: "Issue has Product approval; Product Manager must write the Product Spec before engineering planning.",
    summary: `Write Product Spec for issue #${issue.number}: ${issue.title}`,
    context,
    createdAt: now,
    updatedAt: now
  };
}

export function buildWorktreeId(owner: string, repoName: string, issueNumber: number): string {
  return `worktree:${owner}/${repoName}:issue:${issueNumber}`;
}

export function buildPacketWorktreeId(input: {
  repo: { owner: string; name: string };
  parentWorkstream: WorkstreamRecord;
  packetId: string;
}): string {
  const { owner, name } = input.repo;
  const { type, number } = input.parentWorkstream.origin;
  return `worktree:${owner}/${name}:${type}:${number}:packet:${getPacketSlug(input.packetId)}`;
}

export function buildWorktreeBranchName(repo: RepoConfig, issueNumber: number): string {
  return `agent/${slugify(`${repo.owner}-${repo.name}`)}/issue-${issueNumber}`;
}

export function buildPacketWorktreeBranchName(input: {
  repo: { owner: string; name: string };
  parentWorkstream: WorkstreamRecord;
  packetId: string;
}): string {
  const { owner, name } = input.repo;
  const { type, number } = input.parentWorkstream.origin;
  const slug = slugify(`${owner}-${name}`);
  const workstreamRef = `workstream-${type}-${number}`;
  const packetRef = `packet-${getPacketSlug(input.packetId)}`;
  return `agent/${slug}/${workstreamRef}/${packetRef}`;
}

export function buildWorktreeRelativePath(repo: RepoConfig, issueNumber: number): string {
  return path.join(
    WORKTREE_ROOT_DIR,
    slugify(repo.owner),
    slugify(repo.name),
    `issue-${issueNumber}`
  );
}

export function buildPacketWorktreeRelativePath(input: {
  repo: { owner: string; name: string };
  parentWorkstream: WorkstreamRecord;
  packetId: string;
}): string {
  const { owner, name } = input.repo;
  const { type, number } = input.parentWorkstream.origin;
  return path.join(
    WORKTREE_ROOT_DIR,
    slugify(owner),
    slugify(name),
    `workstream-${type}-${number}`,
    `packet-${getPacketSlug(input.packetId)}`
  );
}

async function preparePlanDocuments(
  worktreePath: string,
  issue: NormalizedIssue,
  decision: TriageDecisionResult,
  branchName: string
): Promise<{ planDocumentPath: string; productSpecDocumentPath: string; logDocumentPath: string }> {
  const relativePaths = buildAgentDocumentRelativePaths(issue.number, branchName);
  const planDocumentPath = path.join(worktreePath, relativePaths.planDocumentPath);
  const productSpecDocumentPath = path.join(worktreePath, relativePaths.productSpecDocumentPath);
  const logDocumentPath = path.join(worktreePath, relativePaths.logDocumentPath);
  const docsDir = path.dirname(planDocumentPath);

  await mkdir(docsDir, { recursive: true });

  if (!(await pathExists(planDocumentPath))) {
    await writeFile(
      planDocumentPath,
      [
        `# Agent Plan`,
        "",
        `Issue: ${issue.url}`,
        "",
        `Status: Draft`,
        "",
        "## Objective",
        decision.summary?.trim() || issue.title,
        "",
        "## Notes",
        "- Planning document created by the orchestrator workflow.",
        ""
      ].join("\n"),
      "utf8"
    );
  }

  if (!(await pathExists(logDocumentPath))) {
    await writeFile(
      logDocumentPath,
      [
        "# Agent Log",
        "",
        `- ${new Date().toISOString()}: Worktree prepared for plan-writing.`,
        ""
      ].join("\n"),
      "utf8"
    );
  }

  return {
    planDocumentPath,
    productSpecDocumentPath,
    logDocumentPath
  };
}

async function preparePacketPlanDocuments(input: {
  worktreePath: string;
  parentWorkstream: WorkstreamRecord;
  packet: WorkstreamPacket;
  waveIndex: number;
  branchName: string;
  now: () => string;
  existingPaths?: { planDocumentPath: string; logDocumentPath: string };
}): Promise<{ planDocumentPath: string; logDocumentPath: string }> {
  const { worktreePath, parentWorkstream, packet, branchName, now, existingPaths } = input;
  const relativePaths = existingPaths
    ? undefined
    : buildPacketAgentDocumentRelativePaths(packet.id, branchName);
  const planDocumentPath =
    existingPaths?.planDocumentPath ?? path.join(worktreePath, relativePaths!.planDocumentPath);
  const logDocumentPath =
    existingPaths?.logDocumentPath ?? path.join(worktreePath, relativePaths!.logDocumentPath);
  const docsDir = path.dirname(planDocumentPath);

  await mkdir(docsDir, { recursive: true });

  if (!(await pathExists(planDocumentPath))) {
    const integrationBranch = parentWorkstream.integration?.branchName ?? "unknown";

    await writeFile(
      planDocumentPath,
      [
        `# Agent Plan`,
        "",
        `Parent workstream: ${parentWorkstream.id}`,
        `Packet: ${packet.id}`,
        "",
        `Status: Draft`,
        "",
        "## Objective",
        packet.title,
        "",
        packet.summary,
        "",
        "## Acceptance Criteria",
        ...packet.acceptanceCriteria.map((ac) => `- ${ac}`),
        "",
        "## Likely Files",
        ...packet.filesLikelyTouched.map((f) => `- ${f}`),
        "",
        "## Dependencies",
        ...packet.dependsOn.map((d) => `- ${d}`),
        "",
        "## Notes",
        `- This is a packet planning PR targeting \`${integrationBranch}\`.`,
        "- Implementation must not begin until the `agent-plan-approved` label is present.",
        ""
      ].join("\n"),
      "utf8"
    );
  }

  if (!(await pathExists(logDocumentPath))) {
    await writeFile(
      logDocumentPath,
      ["# Agent Log", "", `- ${now()}: Packet planning worktree prepared.`, ""].join("\n"),
      "utf8"
    );
  }

  return {
    planDocumentPath,
    logDocumentPath
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function compareWorktrees(left: WorktreeRecord, right: WorktreeRecord): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.id.localeCompare(right.id);
}

function buildPullRequestTitle(issue: NormalizedIssue): string {
  return `agent: plan for issue #${issue.number} - ${issue.title}`;
}

function buildPullRequestBody(issue: NormalizedIssue, worktree: WorktreeRecord): string {
  const planPath = toRepoRelativePath(worktree.path, worktree.planDocumentPath);
  const productSpecPath = worktree.productSpecDocumentPath
    ? toRepoRelativePath(worktree.path, worktree.productSpecDocumentPath)
    : undefined;
  const logPath = toRepoRelativePath(worktree.path, worktree.logDocumentPath);
  return [
    `Planning workflow for ${issue.url}.`,
    "",
    "This PR was created by the local agent orchestrator to support the plan-first workflow.",
    "",
    ...(productSpecPath ? [`- Product Spec: \`${productSpecPath}\``] : []),
    `- Plan document: \`${planPath}\``,
    `- Agent log: \`${logPath}\``,
    "- Implementation must not begin until the `agent-plan-approved` label is present."
  ].join("\n");
}

function buildPacketPullRequestTitle(input: {
  parentWorkstream: WorkstreamRecord;
  packetId: string;
}): string {
  const { parentWorkstream, packetId } = input;
  const source =
    parentWorkstream.origin.type === "issue"
      ? `issue #${parentWorkstream.origin.number}`
      : `PR #${parentWorkstream.origin.number}`;
  return `agent: plan packet ${packetId} for ${source}`;
}

function buildPacketPullRequestBody(input: {
  parentWorkstream: WorkstreamRecord;
  packet: WorkstreamPacket;
  worktree: WorktreeRecord;
}): string {
  const { parentWorkstream, packet, worktree } = input;
  if (!worktree.packet) throw new Error("Missing packet metadata");

  const planPath = toRepoRelativePath(worktree.path, worktree.planDocumentPath);
  const logPath = toRepoRelativePath(worktree.path, worktree.logDocumentPath);

  const parentPr = parentWorkstream.activePrNumber ? `#${parentWorkstream.activePrNumber}` : "unknown";

  return [
    `Planning workflow for packet \`${packet.id}\` in parent workstream \`${parentWorkstream.id}\`.`,
    "",
    `Parent integration branch: \`${worktree.packet.parentIntegrationBranch}\``,
    `Parent PR: ${parentPr}`,
    `Wave index: ${worktree.packet.waveIndex}`,
    `Packet title: ${packet.title}`,
    "",
    "Packet summary:",
    packet.summary,
    "",
    "Acceptance criteria:",
    ...packet.acceptanceCriteria.map((ac) => `- ${ac}`),
    "",
    "Likely files:",
    ...packet.filesLikelyTouched.map((f) => `- ${f}`),
    "",
    "Dependencies:",
    ...packet.dependsOn.map((d) => `- ${d}`),
    "",
    "This PR was created by the orchestrator as a packet planning PR.",
    "Implementation must not begin until the `agent-plan-approved` label is present."
  ].join("\n");
}

function buildAgentDocumentRelativePaths(
  issueNumber: number,
  branchName: string
): { planDocumentPath: string; productSpecDocumentPath: string; logDocumentPath: string } {
  const scopedDocsDir = path.join(AGENT_DOCS_ROOT_DIR, slugify(branchName));
  return {
    productSpecDocumentPath: path.join(scopedDocsDir, `issue-${issueNumber}-product-spec.md`),
    planDocumentPath: path.join(scopedDocsDir, `issue-${issueNumber}-agent-plan.md`),
    logDocumentPath: path.join(scopedDocsDir, `issue-${issueNumber}-agent-log.md`)
  };
}

function buildPacketAgentDocumentRelativePaths(
  packetId: string,
  branchName: string
): { planDocumentPath: string; logDocumentPath: string } {
  const branchHash = createHash("sha256").update(branchName).digest("hex").slice(0, 8);
  const scopedDocsDir = path.join(AGENT_DOCS_ROOT_DIR, `${slugify(branchName)}-${branchHash}`);
  return {
    planDocumentPath: path.join(scopedDocsDir, `packet-${getPacketSlug(packetId)}-agent-plan.md`),
    logDocumentPath: path.join(scopedDocsDir, `packet-${getPacketSlug(packetId)}-agent-log.md`)
  };
}

function toRepoRelativePath(worktreePath: string, filePath: string): string {
  return path.relative(worktreePath, filePath).split(path.sep).join("/");
}

function extractWorktreeId(taskId: string): string | undefined {
  const prefixes = ["task:write_plan:worktree:", "task:implement_plan:worktree:"];
  for (const prefix of prefixes) {
    if (taskId.startsWith(prefix)) {
      return taskId.slice(prefix.length);
    }
  }

  return undefined;
}

function groupTasksByWorktreeId(tasks: TaskRecord[]): Map<string, TaskRecord[]> {
  const tasksByWorktreeId = new Map<string, TaskRecord[]>();

  for (const task of tasks) {
    const worktreeId = extractWorktreeId(task.id);
    if (!worktreeId) {
      continue;
    }

    const existing = tasksByWorktreeId.get(worktreeId) ?? [];
    existing.push(task);
    tasksByWorktreeId.set(worktreeId, existing);
  }

  return tasksByWorktreeId;
}

function groupTasksByWorktreePath(tasks: TaskRecord[]): Map<string, TaskRecord[]> {
  const tasksByWorktreePath = new Map<string, TaskRecord[]>();

  for (const task of tasks) {
    const worktreePath = task.context.localRepoPath;
    if (!worktreePath) {
      continue;
    }

    const existing = tasksByWorktreePath.get(worktreePath) ?? [];
    existing.push(task);
    tasksByWorktreePath.set(worktreePath, existing);
  }

  return tasksByWorktreePath;
}

function deriveApprovedPacketWorktreeStatus(
  worktree: WorktreeRecord,
  tasks: TaskRecord[]
): WorktreeRecord["status"] {
  if (worktree.status === "closed") {
    return "closed";
  }

  if (worktree.status === "implementation_done") {
    return "implementation_done";
  }

  const implementTask = tasks.find((task) => task.kind === "implement_plan");
  if (implementTask) {
    return deriveImplementationStatusFromTask(implementTask);
  }

  return "implementation_ready";
}

function deriveWorktreeStatusFromTasks(
  worktree: WorktreeRecord,
  tasks: TaskRecord[]
): WorktreeRecord["status"] {
  if (worktree.status === "closed") {
    return "closed";
  }

  if (worktree.status === "implementation_done") {
    return "implementation_done";
  }

  const implementTask = tasks.find((task) => task.kind === "implement_plan");
  if (implementTask) {
    return deriveImplementationStatusFromTask(implementTask);
  }

  const hasProductSpecArtifact = hasMeaningfulProductSpecArtifact(worktree);
  const productSpecTask = tasks.find((task) => task.kind === "write_product_spec");
  if (worktree.productSpecWrittenAt && hasProductSpecArtifact) {
    const writePlanTask = tasks.find((task) => task.kind === "write_plan");
    if (writePlanTask) {
      return writePlanTask.status === "completed" ? "awaiting_plan_approval" : "planning";
    }
    return worktree.status === "product_specification" ? "planning" : worktree.status;
  }

  if (productSpecTask && productSpecTask.status !== "completed") {
    return "product_specification";
  }

  const writePlanTask = tasks.find((task) => task.kind === "write_plan");
  if (writePlanTask) {
    return writePlanTask.status === "completed" ? "awaiting_plan_approval" : "planning";
  }

  if (productSpecTask?.status === "completed" && hasProductSpecArtifact) {
    return "planning";
  }

  return worktree.status;
}

function hasMeaningfulProductSpecArtifact(worktree: WorktreeRecord): boolean {
  if (!worktree.productSpecDocumentPath || !existsSync(worktree.productSpecDocumentPath)) {
    return false;
  }

  try {
    return readFileSync(worktree.productSpecDocumentPath, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function deriveImplementationStatusFromTask(task: TaskRecord): WorktreeRecord["status"] {
  switch (task.status) {
    case "pending":
      return "implementation_ready";
    case "queued":
      return "implementation_ready";
    case "dispatched":
      return "implementing";
    case "completed":
      return "implementation_done";
    case "failed":
      return "implementing";
  }
}
