import type { RepoConfig } from "../config/types.js";
import type { GitHubGateway } from "../github/types.js";
import type { WorkstreamRecord } from "../state/types.js";
import type { Logger } from "../utils/logger.js";
import {
  buildPacketLifecycleWorkstreamReport,
  formatPacketLifecycleReport,
  type PacketLifecycleBranchSyncPreflight,
  type PacketPrCreatedRunEvent,
  type PacketWaveAdvancedRunEvent,
  type PacketWaveBlockedRunEvent
} from "./packet-lifecycle-report.js";

const STATUS_COMMENT_MARKER = "<!-- backburner:packet-wave-status -->";

export interface PublishPacketLifecycleFeedbackInput {
  workstreams: WorkstreamRecord[];
  repos: RepoConfig[];
  packetPrsCreatedThisRun: PacketPrCreatedRunEvent[];
  waveAdvancementsThisRun: PacketWaveAdvancedRunEvent[];
  blockedThisRun: PacketWaveBlockedRunEvent[];
  parentBranchSyncPreflights?: PacketLifecycleBranchSyncPreflight[] | undefined;
}

export class GitHubPacketLifecyclePublisher {
  constructor(
    private readonly gitHubGateway: GitHubGateway,
    private readonly logger?: Logger
  ) {}

  async publishLifecycleFeedback(input: PublishPacketLifecycleFeedbackInput): Promise<void> {
    const { workstreams, repos, packetPrsCreatedThisRun, waveAdvancementsThisRun, blockedThisRun, parentBranchSyncPreflights } = input;

    for (const workstream of workstreams) {
      if (!workstream.packetPlan || !workstream.integration?.prNumber) {
        continue;
      }

      const repo = repos.find(
        (r) => r.id === workstream.repoKey || `${r.owner}/${r.name}` === workstream.repoKey
      );
      if (!repo) {
        continue;
      }

      const report = buildPacketLifecycleWorkstreamReport({
        workstream,
        packetPrsCreatedThisRun,
        waveAdvancementsThisRun,
        blockedThisRun,
        parentBranchSyncPreflights,
        agentSyncParentBranchLabel: repo.labels.agentSyncParentBranch
      });

      if (!report) {
        continue;
      }

      const body = `🤖 ${STATUS_COMMENT_MARKER}\n${formatPacketLifecycleReport(report)}`;

      try {
        const comments = await this.gitHubGateway.listPullRequestComments(
          repo.owner,
          repo.name,
          workstream.integration.prNumber
        );

        const existingComment = comments.find(
          (c) => c.body.includes(STATUS_COMMENT_MARKER) && c.body.startsWith("🤖")
        );

        if (existingComment) {
          this.logger?.info(`Updating lifecycle status comment on ${repo.owner}/${repo.name} PR #${workstream.integration.prNumber}`);
          await this.gitHubGateway.updateIssueComment({
            owner: repo.owner,
            name: repo.name,
            commentId: existingComment.id,
            body
          });
        } else {
          this.logger?.info(`Posting new lifecycle status comment on ${repo.owner}/${repo.name} PR #${workstream.integration.prNumber}`);
          await this.gitHubGateway.postIssueComment({
            owner: repo.owner,
            name: repo.name,
            issueNumber: workstream.integration.prNumber,
            body
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn(
          `Failed to publish lifecycle feedback for ${workstream.id}: ${message}`
        );
      }
    }
  }
}
