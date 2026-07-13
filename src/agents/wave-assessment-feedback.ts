import type { RepoConfig } from "../config/types.js";
import type { GitHubGateway } from "../github/types.js";
import type { ExecutionRecord, WaveAssessmentResult } from "../state/types.js";
import { Task } from "../tasks/task.js";
import type { TaskRecord } from "../tasks/types.js";
import type { Logger } from "../utils/logger.js";

export interface WaveAssessmentPublisher {
  publishWaveAssessment(task: TaskRecord, execution: ExecutionRecord): Promise<string | undefined>;
}

export class GitHubWaveAssessmentPublisher implements WaveAssessmentPublisher {
  private readonly reposById: Map<string, RepoConfig>;

  constructor(
    private readonly gitHubGateway: GitHubGateway,
    repos: RepoConfig[],
    private readonly logger?: Logger
  ) {
    this.reposById = new Map(repos.map((repo) => [repo.id, repo]));
  }

  async publishWaveAssessment(task: TaskRecord, execution: ExecutionRecord): Promise<string | undefined> {
    if (
      (task.kind !== "wave_plan_assessment" && task.kind !== "wave_plan_replanning") ||
      execution.taskStatus !== "completed"
    ) {
      return undefined;
    }

    const assessment = execution.result?.waveAssessment;
    if (!assessment) {
      this.logger?.warn(`Completed ${task.kind} task ${task.id} did not return a structured assessment result.`);
      return undefined;
    }

    const repo = this.reposById.get(task.repoId);
    const pullRequestNumber = Task.from(task).owningPullRequestNumber();
    if (!repo || pullRequestNumber === undefined) {
      this.logger?.warn(`Could not resolve repo or parent PR number for wave assessment task ${task.id}.`);
      return undefined;
    }

    const comment = await this.gitHubGateway.postIssueComment({
      owner: repo.owner,
      name: repo.name,
      issueNumber: pullRequestNumber,
      body: renderWaveAssessmentComment(assessment)
    });

    return String(comment.id);
  }
}

export function renderWaveAssessmentComment(assessment: WaveAssessmentResult): string {
  const { identity } = assessment.checkpoint;
  const lines: string[] = [
    "🤖 **Wave Plan Assessment Report**",
    "",
    `- **Wave**: ${identity.waveId}`,
    `- **Decision**: ${assessment.decision}`,
    `- **Assessed Parent Head SHA**: \`${identity.parentHeadSha}\``,
    `- **Plan Revision**: \`${identity.planRevision}\``,
    `- **Assessment Session**: \`${assessment.sessionId}\``,
    "",
    "## Summary",
    "",
    assessment.summary,
    "",
    "## Findings",
    ""
  ];

  if (assessment.findings.length === 0) {
    lines.push("- None");
  } else {
    for (const finding of assessment.findings) {
      const affected = finding.affectedPlanNodeIds.length > 0
        ? finding.affectedPlanNodeIds.join(", ")
        : "none";
      lines.push(`- **[${finding.category}]** ${finding.summary} (Affected plan nodes: ${affected})`);
      if (finding.details.trim()) {
        lines.push(`  ${finding.details.replace(/\s+/g, " ").trim()}`);
      }
    }
  }

  return lines.join("\n").trim();
}
