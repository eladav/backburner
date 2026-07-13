import type { RepoConfig, AgentProvider } from "../config/types.js";
import type { GitHubGateway } from "../github/types.js";
import { Task } from "../tasks/task.js";
import type { TaskRecord } from "../tasks/types.js";
import type { Logger } from "../utils/logger.js";

export interface TaskLifecycleNotifier {
  notifyDispatch(task: TaskRecord, metadata: { isRetry: boolean }): Promise<void>;
  notifyCompletionStatus(task: TaskRecord, status: "completed" | "failed"): Promise<void>;
  notifyQueued(task: TaskRecord, providers: AgentProvider | AgentProvider[], resetTime?: string): Promise<void>;
  notifyResumed(task: TaskRecord): Promise<void>;
  notifyCanceled(task: TaskRecord): Promise<void>;
}

export class GitHubTaskLifecycleNotifier implements TaskLifecycleNotifier {
  private readonly reposById: Map<string, RepoConfig>;

  constructor(
    private readonly gitHubGateway: GitHubGateway,
    repos: RepoConfig[],
    private readonly logger?: Logger
  ) {
    this.reposById = new Map(repos.map((repo) => [repo.id, repo]));
  }

  async notifyDispatch(taskRecord: TaskRecord, { isRetry }: { isRetry: boolean }): Promise<void> {
    const task = Task.from(taskRecord);
    const repo = this.reposById.get(taskRecord.repoId);
    if (!repo) {
      this.logger?.warn(`Could not resolve repo ${taskRecord.repoId} for task lifecycle feedback.`);
      return;
    }

    // Best-effort reaction
    try {
      const eyesSourceNumber = task.getSourceEntityNumber();
      const eyesCommentId = task.getSourceCommentId();
      const eyesCommentKind = task.getSourceCommentKind();
      await this.gitHubGateway.addReaction({
        owner: repo.owner,
        name: repo.name,
        ...(eyesSourceNumber !== undefined ? { issueNumber: eyesSourceNumber } : {}),
        ...(eyesCommentId !== undefined ? { commentId: eyesCommentId } : {}),
        ...(eyesCommentKind !== undefined ? { commentKind: eyesCommentKind } : {}),
        content: "eyes"
      });
    } catch (error) {
      this.logger?.warn(`Failed to add reaction for task ${taskRecord.id}: ${error}`);
    }

    // Best-effort comment
    try {
      const threadNumber = task.owningThreadNumber();
      if (threadNumber !== undefined) {
        const suffix = isRetry ? " (this is a re-run)" : "";
        const body = `🤖 I noticed this task and I'm starting work on it: **${taskRecord.summary}**${suffix}`;

        await this.gitHubGateway.postIssueComment({
          owner: repo.owner,
          name: repo.name,
          issueNumber: threadNumber,
          body
        });
      }
    } catch (error) {
      this.logger?.warn(`Failed to post dispatch lifecycle feedback for task ${taskRecord.id}: ${error}`);
    }
  }

  async notifyCompletionStatus(taskRecord: TaskRecord, status: "completed" | "failed"): Promise<void> {
    const task = Task.from(taskRecord);
    const repo = this.reposById.get(taskRecord.repoId);
    if (!repo) return;

    try {
      const sourceNumber = task.getSourceEntityNumber();
      const commentId = task.getSourceCommentId();
      const commentKind = task.getSourceCommentKind();
      await this.gitHubGateway.addReaction({
        owner: repo.owner,
        name: repo.name,
        ...(sourceNumber !== undefined ? { issueNumber: sourceNumber } : {}),
        ...(commentId !== undefined ? { commentId: commentId } : {}),
        ...(commentKind !== undefined ? { commentKind } : {}),
        content: status === "completed" ? "+1" : "-1"
      });
    } catch (error) {
      this.logger?.warn(`Failed to post completion reaction for task ${taskRecord.id}: ${error}`);
    }
  }

  async notifyQueued(taskRecord: TaskRecord, providers: AgentProvider | AgentProvider[], resetTime?: string): Promise<void> {
    const task = Task.from(taskRecord);
    const repo = this.reposById.get(taskRecord.repoId);
    if (!repo) {
      this.logger?.warn(`Could not resolve repo ${taskRecord.repoId} for task lifecycle feedback.`);
      return;
    }

    const providerList = Array.isArray(providers) ? providers : [providers];
    const providersStr = providerList.map(p => `\`${p}\``).join(", ");

    try {
      const threadNumber = task.owningThreadNumber();
      if (threadNumber !== undefined) {
        const resetMsg = resetTime ? ` until ${resetTime}` : "";
        const providerText = providerList.length > 1 ? "providers" : "provider";
        const body = `🤖 I've queued this task because the AI ${providerText} (${providersStr}) has hit its session/rate limit${resetMsg}. It will resume automatically once the limit resets.`;

        await this.gitHubGateway.postIssueComment({
          owner: repo.owner,
          name: repo.name,
          issueNumber: threadNumber,
          body
        });
      }
    } catch (error) {
      this.logger?.warn(`Failed to post queued lifecycle feedback for task ${taskRecord.id}: ${error}`);
    }
  }

  async notifyResumed(taskRecord: TaskRecord): Promise<void> {
    const task = Task.from(taskRecord);
    const repo = this.reposById.get(taskRecord.repoId);
    if (!repo) {
      this.logger?.warn(`Could not resolve repo ${taskRecord.repoId} for task lifecycle feedback.`);
      return;
    }

    try {
      const threadNumber = task.owningThreadNumber();
      if (threadNumber !== undefined) {
        const body = `🤖 Resuming task: **${taskRecord.summary}**`;

        await this.gitHubGateway.postIssueComment({
          owner: repo.owner,
          name: repo.name,
          issueNumber: threadNumber,
          body
        });
      }
    } catch (error) {
      this.logger?.warn(`Failed to post resumed lifecycle feedback for task ${taskRecord.id}: ${error}`);
    }
  }

  async notifyCanceled(taskRecord: TaskRecord): Promise<void> {
    const task = Task.from(taskRecord);
    const repo = this.reposById.get(taskRecord.repoId);
    if (!repo) {
      this.logger?.warn(`Could not resolve repo ${taskRecord.repoId} for task lifecycle feedback.`);
      return;
    }

    try {
      const threadNumber = task.owningThreadNumber();
      if (threadNumber !== undefined) {
        await this.gitHubGateway.postIssueComment({
          owner: repo.owner,
          name: repo.name,
          issueNumber: threadNumber,
          body: "🤖 Task was canceled or the PR/issue was closed while queued."
        });
      }
    } catch (error) {
      this.logger?.warn(`Failed to post canceled lifecycle feedback for task ${taskRecord.id}: ${error}`);
    }
  }
}
