import type { AgentRunner } from "../agents/types.js";
import type { AgentConfig } from "../config/types.js";
import type { GitGateway, RepoSyncService, BranchSyncComparison } from "../git/types.js";
import type { MergePrepWorkspaceService } from "../git/merge-prep-workspace.js";
import type {
  GitOpsLifecycleService,
  ManagementGitOpsResult,
  OutputsGitOpsResult
} from "../git/gitops-lifecycle.js";
import type { GitHubScanningService } from "../github/service.js";
import type { GitHubGateway } from "../github/types.js";
import type { startGitHubBrokerServer } from "../github/broker-server.js";
import type { JournalService } from "../journal/index.js";
import type {
  PacketPlanStatus,
  PacketExecutionStatus,
  RepoSyncRecord
} from "../state/types.js";
import type { ParentBranchSyncPreflight, TaskRecord } from "../tasks/types.js";
import type { RuntimeStatusTracker } from "./tui/index.js";
import type { Logger } from "../utils/logger.js";
import type { CommandRunner } from "../utils/command-runner.js";
import type { ParentBranchSyncService } from "../workstreams/parent-branch-sync.js";
import type { WorkspaceRecoveryService } from "../worktrees/workspace-recovery.js";
import type { PacketPullRequestCandidate } from "../workstreams/packet-candidates.js";
import type {
  PacketPrCreatedRunEvent,
  PacketWaveAdvancedRunEvent,
  PacketWaveBlockedRunEvent
} from "../workstreams/packet-lifecycle-report.js";
import type { PullRequestBaseClassification } from "../github/pr-classification.js";

export interface RunCliOptions {
  managementDir?: string;
  outputsDir?: string;
  stateDir?: string;
  logDir?: string;
  logger?: Logger;
  gitGateway?: GitGateway;
  gitHubGateway?: GitHubGateway;
  syncService?: RepoSyncService;
  scanService?: GitHubScanningService;
  agentRunner?: AgentRunner;
  commandRunner?: CommandRunner;
  startBrokerServer?: typeof startGitHubBrokerServer;
  gitOpsLifecycleService?: GitOpsLifecycleService;
  parentBranchSyncService?: ParentBranchSyncService;
  mergePrepService?: MergePrepWorkspaceService;
  workspaceRecoveryService?: WorkspaceRecoveryService;
  journalService?: JournalService;
  statusTracker?: RuntimeStatusTracker;
  cycleNo?: number;
}

export interface ParentBranchSyncPreflightRunSummary {
  preflight: ParentBranchSyncPreflight;
  branchSyncComparison?: BranchSyncComparison;
  branchSyncComparisonSkippedReason?: "missing_local_path";
}

export interface RunSummary {
  command: "run";
  codeRoot: string;
  managementDir: string;
  outputsDir: string;
  stateDir: string;
  logDir: string;
  startedAt: string;
  completedAt: string;
  managementGitOps?: ManagementGitOpsResult;
  outputsGitOps?: OutputsGitOpsResult;
  repoCount: number;
  syncedRepoCount: number;
  failedRepoCount: number;
  scannedRepoCount: number;
  partiallyScannedRepoCount: number;
  failedScanRepoCount: number;
  issueCount: number;
  pullRequestCount: number;
  commentCount: number;
  taskCount: number;
  pendingTaskCount: number;
  dispatchedTaskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  executionCount: number;
  productDiscoveryCount?: number;
  productSpecificationCount?: number;
  waitingForProductApprovalCount?: number;
  pullRequestBaseClassifications: PullRequestBaseClassification[];
  packetPullRequestCandidates: PacketPullRequestCandidate[];
  parentBranchSyncPreflights: ParentBranchSyncPreflightRunSummary[];
  results: RepoSyncRecord[];
  tasks: TaskRecord[];
  packetPrsCreatedThisRun: PacketPrCreatedRunEvent[];
  packetWaveAdvancementsThisRun: PacketWaveAdvancedRunEvent[];
  packetWaveBlockedThisRun: PacketWaveBlockedRunEvent[];
  packetPlans: Array<{
    workstreamId: string;
    repoKey: string;
    parentPrNumber?: number | undefined;
    status: PacketPlanStatus;
    packetCount: number;
    waveCount: number;
    currentWaveIndex?: number | undefined;
    waves: Array<{
      index: number;
      packetIds: string[];
      packets: Array<{
        id: string;
        status: PacketExecutionStatus;
        branchName?: string | undefined;
        prNumber?: number | undefined;
      }>;
    }>;
  }>;
}

export type RunEnabledAgent = AgentConfig & { enabled: true };
