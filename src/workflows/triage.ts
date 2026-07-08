import type { RepoConfig } from "../config/types.js";
import type { NormalizedIssue } from "../domain/entities.js";
import type { GitGateway } from "../git/types.js";
import type { GitHubGateway } from "../github/types.js";
import type { PersistedState, WorktreeRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import {
  buildWorktreeProductSpecTaskRecord,
  ImplementationWorkflowService
} from "../worktrees/service.js";

export interface TriageFollowUpInput {
  repos: RepoConfig[];
  issues: NormalizedIssue[];
  repoPaths: Map<string, string>;
  codeRoot: string;
  state: PersistedState;
  tasks: TaskRecord[];
}

export interface TriageFollowUpResult {
  tasks: TaskRecord[];
  worktrees: WorktreeRecord[];
}

export class TriageFollowUpService {
  private readonly implementationWorkflow: ImplementationWorkflowService;

  constructor(
    gitGateway: GitGateway,
    gitHubGateway: GitHubGateway,
    now: () => string = () => new Date().toISOString()
  ) {
    this.implementationWorkflow = new ImplementationWorkflowService(gitGateway, gitHubGateway, now);
  }

  async materializeStartImplementation(input: TriageFollowUpInput): Promise<TriageFollowUpResult> {
    const reposById = new Map(input.repos.map((repo) => [repo.id, repo]));
    const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
    const worktrees = [...this.implementationWorkflow.linkPullRequests(input.state.worktrees, input.state.prs, input.repos)];

    for (const issue of input.issues) {
      const repo = reposById.get(issue.repoId);
      if (!repo || !issue.labels.includes(repo.labels.agentProductApproved)) {
        continue;
      }

      const repoPath = input.repoPaths.get(issue.repoId);
      if (!repoPath) {
        continue;
      }

      const alreadyHasSpecTask = [...tasksById.values()].some(
        (task) => task.kind === "write_product_spec" && task.sourceId === issue.id
      );
      const existingWorktree = worktrees.find(
        (worktree) => worktree.repoId === repo.id && worktree.issueNumber === issue.number
      );
      if (
        existingWorktree &&
        existingWorktree.status !== "closed" &&
        existingWorktree.prNumber !== undefined &&
        existingWorktree.prUrl !== undefined &&
        (existingWorktree.productSpecWrittenAt || alreadyHasSpecTask)
      ) {
        continue;
      }

      const prepared = await this.implementationWorkflow.ensureWorktreeForIssue({
        repo,
        repoPath,
        codeRoot: input.codeRoot,
        issue,
        decision: {
          decision: "start_implementation",
          summary: "Product direction approved; prepare Product Spec before engineering planning."
        },
        existingWorktrees: worktrees
      });
      const existingIndex = worktrees.findIndex((worktree) => worktree.id === prepared.worktree.id);
      if (existingIndex === -1) {
        worktrees.push(prepared.worktree);
      } else {
        worktrees[existingIndex] = prepared.worktree;
      }

      let withPr: WorktreeRecord;
      try {
        const result = await this.implementationWorkflow.ensurePullRequestForWorktree(
          repo,
          issue,
          prepared.worktree
        );
        withPr = result.worktree;
      } catch {
        continue;
      }
      const pushedIndex = worktrees.findIndex((worktree) => worktree.id === withPr.id);
      if (pushedIndex === -1) {
        worktrees.push(withPr);
      } else {
        worktrees[pushedIndex] = withPr;
      }

      if (!withPr.productSpecWrittenAt && !alreadyHasSpecTask) {
        const writeProductSpecTask = buildWorktreeProductSpecTaskRecord(withPr, issue, input.state.issueMetadata.generatedAt ?? withPr.updatedAt);
        tasksById.set(writeProductSpecTask.id, writeProductSpecTask);
      }
    }

    return {
      tasks: [...tasksById.values()].sort(compareTasks),
      worktrees: worktrees.sort(compareWorktrees)
    };
  }
}

function compareTasks(left: TaskRecord, right: TaskRecord): number {
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

function compareWorktrees(left: WorktreeRecord, right: WorktreeRecord): number {
  const repoComparison = left.repoSlug.localeCompare(right.repoSlug);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.id.localeCompare(right.id);
}
