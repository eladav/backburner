import * as path from "node:path";
import { AgentPool } from "../../agents/pool.js";
import { loadConfig, type LoadedConfig } from "../../config/loader.js";
import { GitCliGateway, LocalRepoSyncService } from "../../git/types.js";
import type { GitGateway, RepoSyncService } from "../../git/types.js";
import { GitOpsLifecycleService } from "../../git/gitops-lifecycle.js";
import type { ManagementGitOpsResult, OutputsGitOpsResult } from "../../git/gitops-lifecycle.js";
import { MergePrepWorkspaceService } from "../../git/merge-prep-workspace.js";
import { BackburnerGitToolService } from "../../git/backburner-git-tool-service.js";
import { GhCliGitHubGateway } from "../../github/gateway.js";
import { GitHubScanService, type GitHubScanningService } from "../../github/service.js";
import type { GitHubGateway } from "../../github/types.js";
import { parseGitHubRemoteUrl } from "../../github/utils.js";
import { JournalService } from "../../journal/index.js";
import { JsonJobMemoryStore } from "../../memory/json-store.js";
import { JobMemoryToolService } from "../../memory/tool-service.js";
import {
  createSmitheryMcpResolverFromEnv,
  reconcileMcpStatus
} from "../../mcps/index.js";
import { StateStore } from "../../state/loader.js";
import type { McpStatusRecord, PersistedState, RepoSyncRecord } from "../../state/types.js";
import { ExecFileCommandRunner } from "../../utils/command-runner.js";
import type { CommandRunner } from "../../utils/command-runner.js";
import { defaultStderrLogger } from "../../utils/logger.js";
import type { Logger } from "../../utils/logger.js";
import {
  defaultBackburnerCodeRoot,
  defaultBackburnerManagementRoot,
  defaultBackburnerOutputsRoot,
  resolveOutputsStateRoot,
  resolveOutputsLogsRoot,
  resolveOutputsJournalRoot,
  resolveUserPath
} from "../../utils/paths.js";
import { TriageFollowUpService } from "../../workflows/triage.js";
import { ImplementationWorkflowService } from "../../worktrees/service.js";
import { WorkspaceRecoveryService } from "../../worktrees/workspace-recovery.js";
import type { RunCliOptions } from "../run-types.js";
import {
  DEFAULT_GITHUB_BROKER_PORT as CLI_DEFAULT_GITHUB_BROKER_PORT,
  readNumberFlag,
  readOptionalStringFlag,
  readStringFlag
} from "../options.js";

export interface RunContext {
  managementDir: string;
  outputsDir: string;
  stateDir: string;
  logDir: string;
  logger: Logger;
  codeRoot: string;
  brokerPort: number;
  commandRunner: CommandRunner;
  gitGateway: GitGateway;
  gitOpsLifecycle: GitOpsLifecycleService;
  workspaceRecoveryService: WorkspaceRecoveryService;
  managementGitOps: ManagementGitOpsResult;
  config: LoadedConfig;
  agentPool: AgentPool;
  outputsGitOpsPrepared: OutputsGitOpsResult;
  managementRepo?: { repoId?: string; repoSlug?: string };
  stateStore: StateStore;
  journal: JournalService;
  memoryStore: JsonJobMemoryStore;
  memoryToolService: JobMemoryToolService;
  backburnerGitToolService: BackburnerGitToolService;
  previousState: PersistedState;
  currentMcpStatuses: McpStatusRecord[];
  gitHubGateway: GitHubGateway;
  syncService: RepoSyncService;
  scanService: GitHubScanningService;
  implementationWorkflowService: ImplementationWorkflowService;
  triageFollowUpService: TriageFollowUpService;
  mergePrepService: MergePrepWorkspaceService;
  enabledRepos: LoadedConfig["repos"];
  results: RepoSyncRecord[];
}

export async function createRunContext(input: {
  rest: string[];
  options: RunCliOptions;
}): Promise<RunContext> {
  const { rest, options } = input;
  const managementDir = resolveUserPath(
    options.managementDir ?? readStringFlag(rest, "--management-dir", defaultBackburnerManagementRoot())
  );
  const configuredOutputsDir =
    options.outputsDir ?? readOptionalStringFlag(rest, "--outputs-dir");
  const outputsDir = resolveUserPath(configuredOutputsDir ?? defaultBackburnerOutputsRoot());
  const useLegacyStateDirWithoutOutputs =
    options.stateDir !== undefined && configuredOutputsDir === undefined;

  const logger = options.logger ?? defaultStderrLogger;
  const codeRoot = resolveUserPath(readOptionalStringFlag(rest, "--code-root") ?? defaultBackburnerCodeRoot());
  const brokerPort = readNumberFlag(rest, "--broker-port", CLI_DEFAULT_GITHUB_BROKER_PORT);

  const commandRunner = options.commandRunner ?? new ExecFileCommandRunner();
  const gitGateway = options.gitGateway ?? new GitCliGateway(commandRunner);
  const gitOpsLifecycle =
    options.gitOpsLifecycleService ?? new GitOpsLifecycleService(gitGateway);
  const workspaceRecoveryService = options.workspaceRecoveryService ?? new WorkspaceRecoveryService();

  logger.info(`Preparing management root ${managementDir}`);
  const managementGitOps = await gitOpsLifecycle.prepareManagementRoot(managementDir);

  logger.info(`Loading orchestrator config from ${managementDir}`);
  const config = await loadConfig(managementDir);
  const agentPool = new AgentPool(config.maxConcurrentAgents);
  logger.info(`Agent pool: maxConcurrentAgents=${agentPool.maxConcurrent}`);

  let outputsGitOpsPrepared: OutputsGitOpsResult;
  if (useLegacyStateDirWithoutOutputs) {
    logger.info(`Skipping outputs root GitOps because explicit state is stored at ${options.stateDir}`);
    outputsGitOpsPrepared = { status: "skipped_not_git" };
  } else {
    logger.info(`Preparing outputs root ${outputsDir}`);
    outputsGitOpsPrepared = await gitOpsLifecycle.prepareOutputsRoot(outputsDir);
  }

  const stateDir = resolveUserPath(options.stateDir ?? resolveOutputsStateRoot(outputsDir));
  const defaultLogDir = options.stateDir !== undefined ? stateDir : resolveOutputsLogsRoot(outputsDir);
  const logDir = resolveUserPath(options.logDir ?? readStringFlag(rest, "--log-dir", defaultLogDir));

  let managementRepo: { repoId?: string; repoSlug?: string } | undefined;
  try {
    const remoteResult = await commandRunner.run("git", ["remote", "get-url", "origin"], { cwd: managementDir });
    const remoteUrl = remoteResult.stdout.trim();
    const identity = parseGitHubRemoteUrl(remoteUrl);
    if (identity) {
      managementRepo = { repoSlug: `${identity.owner}/${identity.name}` };
    }
  } catch {
    // Management repo identity resolve failed, classifyPullRequest will handle missing managementRepo
  }

  const stateStore = new StateStore({ stateDir, executionDir: logDir });
  const journal = options.journalService ?? new JournalService(resolveOutputsJournalRoot(outputsDir));
  const memoryStore = new JsonJobMemoryStore({ filePath: path.join(stateDir, "job-memory.json") });
  const memoryToolService = new JobMemoryToolService(memoryStore, logger);
  const backburnerGitToolService = new BackburnerGitToolService(commandRunner, logger);

  logger.info(`Loading persisted state from ${stateDir}`);
  if (logDir !== stateDir) {
    logger.info(`Loading execution log from ${logDir}`);
  }
  const previousState = await stateStore.load();
  let currentMcpStatuses = previousState.mcpStatuses ?? [];
  if (config.mcps.length > 0) {
    try {
      const resolvedMcps = await createSmitheryMcpResolverFromEnv().resolveDependencies(
        config.mcps,
        currentMcpStatuses
      );
      const reconciliation = reconcileMcpStatus(
        config.mcps,
        currentMcpStatuses,
        resolvedMcps,
        new Date().toISOString()
      );
      currentMcpStatuses = reconciliation.records;
      await stateStore.writeMcpStatusState(currentMcpStatuses);
      logger.info(
        `MCP readiness reconciled: added=${reconciliation.added.length}, updated=${reconciliation.updated.length}, unchanged=${reconciliation.unchanged.length}, removed=${reconciliation.removed.length}`
      );
    } catch (err) {
      logger.warn(`Failed to reconcile MCP readiness: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const gitHubGateway = options.gitHubGateway ?? new GhCliGitHubGateway(commandRunner, config.allowedUsers);

  const syncService =
    options.syncService ??
    new LocalRepoSyncService(
      gitGateway,
      gitHubGateway
    );
  const scanService =
    options.scanService ?? new GitHubScanService(gitHubGateway);
  const implementationWorkflowService = new ImplementationWorkflowService(gitGateway, gitHubGateway);
  const triageFollowUpService = new TriageFollowUpService(gitGateway, gitHubGateway);
  const mergePrepService = options.mergePrepService ?? new MergePrepWorkspaceService(gitGateway);

  const enabledRepos = config.repos.filter((repo) => repo.enabled);
  const results: RepoSyncRecord[] = [];

  return {
    managementDir,
    outputsDir,
    stateDir,
    logDir,
    logger,
    codeRoot,
    brokerPort,
    commandRunner,
    gitGateway,
    gitOpsLifecycle,
    workspaceRecoveryService,
    managementGitOps,
    config,
    agentPool,
    outputsGitOpsPrepared,
    ...(managementRepo ? { managementRepo } : {}),
    stateStore,
    journal,
    memoryStore,
    memoryToolService,
    backburnerGitToolService,
    previousState,
    currentMcpStatuses,
    gitHubGateway,
    syncService,
    scanService,
    implementationWorkflowService,
    triageFollowUpService,
    mergePrepService,
    enabledRepos,
    results
  };
}
