import type { RepoConfig } from "../config/types.js";
import type { GitHubGateway } from "../github/types.js";
import type { ExecutionRecord, WorkstreamMcpBlocker } from "../state/types.js";
import { Task } from "../tasks/task.js";
import type { TaskRecord } from "../tasks/types.js";
import type { Logger } from "../utils/logger.js";

export interface TaskFailureNotifier {
  notifyFailure(task: TaskRecord, execution: ExecutionRecord, customMessage?: string): Promise<string | undefined>;
}

export class GitHubTaskFailureNotifier implements TaskFailureNotifier {
  constructor(
    private readonly gitHubGateway: GitHubGateway,
    repos: RepoConfig[],
    private readonly logger?: Logger
  ) {
    this.reposById = new Map(repos.map((repo) => [repo.id, repo]));
  }

  private readonly reposById: Map<string, RepoConfig>;

  async notifyFailure(task: TaskRecord, execution: ExecutionRecord, customMessage?: string): Promise<string | undefined> {
    const wrappedTask = Task.from(task);
    const repo = this.reposById.get(task.repoId);
    if (!repo) {
      return undefined;
    }

    const targetNumber = resolveFailureThreadNumber(wrappedTask);
    if (targetNumber === undefined) {
      return undefined;
    }

    const body = customMessage ?? buildTechnicalFailureComment(task, execution);
    const result = await this.gitHubGateway.postIssueComment({
      owner: repo.owner,
      name: repo.name,
      issueNumber: targetNumber,
      body
    });
    this.logger?.warn(
      JSON.stringify({
        component: "task-failure-comment",
        taskId: task.id,
        taskKind: task.kind,
        repoSlug: task.repoSlug,
        threadNumber: targetNumber,
        executionId: execution.id,
        commentId: result.id,
        commentUrl: result.url
      })
    );
    return String(result.id);
  }
}

export function buildTechnicalFailureComment(task: TaskRecord, execution: ExecutionRecord): string {
  const detail = summarizeExecutionFailure(execution);

  return [
    "🤖 I tried to handle this orchestrator task, but it failed for a technical reason and did not complete.",
    "",
    `Task: \`${task.kind}\``,
    `Execution: \`${execution.id}\``,
    `Failure: ${detail}`,
    "",
    'If you want me to try again after the underlying issue is fixed, reply with `retry: <url-of-this-comment>`.'
  ].join("\n");
}

function resolveFailureThreadNumber(task: Task): number | undefined {
  const targetId = task.getOwningThreadId() ?? task.sourceId;
  const match = targetId.match(/:(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function summarizeExecutionFailure(execution: ExecutionRecord): string {
  if (isTimeoutExecution(execution)) {
    return formatTimeoutFailure(execution);
  }

  return summarizeExecutionError(execution.errorMessage);
}

function summarizeExecutionError(errorMessage: string | undefined): string {
  if (!errorMessage) {
    return "Unknown technical failure.";
  }

  const trimmed = errorMessage.trim();
  const firstNonEmptyLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const summary = firstNonEmptyLine ?? "Unknown technical failure.";
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function isTimeoutExecution(execution: ExecutionRecord): boolean {
  return execution.exitCode === 124 || /timed out/i.test(execution.errorMessage ?? "");
}

function formatTimeoutFailure(execution: ExecutionRecord): string {
  const timeoutMs = execution.command.timeoutMs;
  const timeoutLimit = timeoutMs > 0 ? `${timeoutMs}ms` : "the configured timeout";
  return `Timed out after ${timeoutLimit} (exitCode: ${execution.exitCode}).`;
}

export function buildMcpBlockedFailureComment(
  task: TaskRecord,
  execution: ExecutionRecord,
  blockers: { mcpHandle: string; safeReason: string }[]
): string {
  const blockerDetails = blockers
    .map((b) => `- **${b.mcpHandle}**: ${b.safeReason}`)
    .join("\n");

  return [
    "🤖 I tried to handle this orchestrator task, but it is blocked because a required MCP capability requires authorization, configuration, or setup.",
    "",
    `Task: \`${task.kind}\``,
    `Execution: \`${execution.id}\``,
    "",
    "### Blocked Capabilities/MCPs",
    blockerDetails,
    "",
    "Please resolve the MCP setup requirement. Once resolved, the task will be resumed automatically."
  ].join("\n");
}

export function buildMcpBlockerNotificationComment(
  task: TaskRecord,
  blocker: WorkstreamMcpBlocker,
  execution?: ExecutionRecord | undefined
): string {
  return [
    "🤖 **MCP capability blocked**",
    "",
    `The task \`${task.id}\` (\`${task.kind}\`) requires MCP-backed capability ${formatCapabilityNames(blocker.affectedCapabilityNames)}, but the \`${blocker.mcpHandle}\` MCP connection needs authorization or configuration.`,
    ...(execution ? [`Execution: \`${execution.id}\``] : []),
    "",
    `Reason: ${sanitizeMcpCommentText(blocker.safeReason)}`,
    "",
    "Options:",
    `1. Complete the required setup for \`${blocker.mcpHandle}\`, then rerun the orchestrator. The task will remain pending until the MCP becomes ready.`,
    `2. Skip this MCP for this task only by replying exactly: \`mcp-skip: ${task.id} ${blocker.mcpHandle}\``,
    "",
    "If skipped, the agent will proceed without these tools and must find a workaround or report that the task cannot be completed correctly."
  ].join("\n");
}

function formatCapabilityNames(names: readonly string[]): string {
  if (names.length === 0) {
    return "the configured capability";
  }
  if (names.length === 1) {
    return `\`${names[0]}\``;
  }
  return names.map((name) => `\`${name}\``).join(", ");
}

function sanitizeMcpCommentText(value: string | undefined): string {
  const text = value?.trim() || "MCP requires user authorization or configuration.";
  return text
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 300);
}
