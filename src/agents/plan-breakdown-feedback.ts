import type { RepoConfig } from "../config/types.js";
import type { GitHubGateway } from "../github/types.js";
import type { ExecutionRecord, PlanBreakdownResult } from "../state/types.js";
import { Task } from "../tasks/task.js";
import type { TaskRecord } from "../tasks/types.js";
import type { Logger } from "../utils/logger.js";

export interface PlanBreakdownPublisher {
  publishBreakdown(task: TaskRecord, execution: ExecutionRecord): Promise<void>;
}

export class GitHubPlanBreakdownPublisher implements PlanBreakdownPublisher {
  private readonly reposById: Map<string, RepoConfig>;

  constructor(
    private readonly gitHubGateway: GitHubGateway,
    repos: RepoConfig[],
    private readonly logger?: Logger
  ) {
    this.reposById = new Map(repos.map((repo) => [repo.id, repo]));
  }

  async publishBreakdown(task: TaskRecord, execution: ExecutionRecord): Promise<void> {
    if (task.kind !== "plan_breakdown" || execution.taskStatus !== "completed") {
      return;
    }

    const breakdown = execution.result?.planBreakdown;
    if (!breakdown) {
      this.logger?.warn(`Completed plan_breakdown task ${task.id} did not return a structured breakdown result.`);
      return;
    }

    const repo = this.reposById.get(task.repoId);
    const targetNumber = Task.from(task).owningThreadNumber();
    if (!repo || targetNumber === undefined) {
      this.logger?.warn(`Could not resolve repo or target number for plan_breakdown task ${task.id}.`);
      return;
    }

    await this.gitHubGateway.postIssueComment({
      owner: repo.owner,
      name: repo.name,
      issueNumber: targetNumber,
      body: renderPlanBreakdownComment(breakdown)
    });
  }
}

export function renderPlanBreakdownComment(result: PlanBreakdownResult): string {
  const lines: string[] = ["🤖 Breakdown recommendation", ""];

  lines.push("## Summary", "", result.summary, "");

  lines.push("## Dependency graph", "");
  lines.push("| Task ID | Title | Depends on | Blocks | Parallel with | Risk |");
  lines.push("| --- | --- | --- | --- | --- | --- |");

  for (const task of result.tasks) {
    const row = [
      task.id,
      escapeTableCell(task.title),
      formatInlineList(task.dependsOn),
      formatInlineList(task.blocks),
      formatInlineList(task.canRunInParallelWith),
      task.risk
    ];
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Execution waves", "");
  for (const wave of result.waves) {
    lines.push(`### Wave ${wave.id}`, "", wave.rationale, "");
    for (const taskId of wave.taskIds) {
      const task = result.tasks.find((t) => t.id === taskId);
      if (task) {
        lines.push(`- ${task.id}: ${task.title}`);
      }
    }
    lines.push("");
  }

  lines.push("## Recommended first wave", "", result.recommendedFirstWaveId, "");

  lines.push("## Staged implementation packets", "");
  for (const task of result.tasks) {
    lines.push(`### ${task.id}: ${task.title}`, "", task.description, "");
    lines.push(`- **Depends on:** ${formatInlineList(task.dependsOn)}`);
    lines.push(`- **Blocks:** ${formatInlineList(task.blocks)}`);
    lines.push(`- **Parallel with:** ${formatInlineList(task.canRunInParallelWith)}`);
    lines.push(`- **Risk:** ${task.risk}`);
    lines.push(`- **Files likely involved:** ${formatInlineList(task.filesLikelyInvolved)}`);
    lines.push("- **Acceptance criteria:**");
    lines.push(formatBulletList(task.acceptanceCriteria));
    lines.push("- **Verification:**");
    lines.push(formatBulletList(task.verification));
    lines.push("");
  }

  lines.push("## Graph concerns / uncertainty", "");
  lines.push(formatBulletList(result.graphConcerns));
  lines.push("");

  lines.push("## Human decisions needed", "");
  lines.push(formatBulletList(result.humanDecisionsNeeded));
  lines.push("");

  lines.push("## Suggested next action", "", result.suggestedNextAction);

  return lines.join("\n").trim();
}

function formatInlineList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "-";
}

function formatBulletList(values: string[], emptyText = "None"): string {
  if (values.length === 0) return `  - ${emptyText}`;
  return values.map((v) => `  - ${v}`).join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
