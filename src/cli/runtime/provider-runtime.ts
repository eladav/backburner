import * as path from "node:path";
import { CodexCliAgent } from "../../agents/codex.js";
import { CompositeAgentRunner } from "../../agents/composite-runner.js";
import type { AgentRunner } from "../../agents/types.js";
import type { AgentVisibleCapabilities } from "../../capabilities/types.js";
import type { LoadedConfig } from "../../config/loader.js";
import { GitHubBrokerService } from "../../github/broker.js";
import { startGitHubBrokerServer } from "../../github/broker-server.js";
import { ComposedBrokerService } from "../../github/composed.js";
import { ScopedBrokerToolService } from "../../github/scoped-broker.js";
import type { GitHubGateway } from "../../github/types.js";
import type { JobMemoryToolService } from "../../memory/tool-service.js";
import { createSmitheryMcpBridgeServicesFromStatuses } from "../../mcps/index.js";
import type { McpStatusRecord } from "../../state/types.js";
import type { CommandRunner } from "../../utils/command-runner.js";
import { createTeeFileLogger } from "../../utils/logger.js";
import type { Logger, ManagedLogger } from "../../utils/logger.js";
import { PlanBreakdownSessionStore } from "../../workstreams/plan-breakdown-generator/store.js";
import { PlanBreakdownToolService } from "../../workstreams/plan-breakdown-generator/tools.js";
import { WaveAssessmentSessionStore } from "../../workstreams/wave-assessment/store.js";
import { WaveAssessmentToolService } from "../../workstreams/wave-assessment/tools.js";
import { BackburnerGitToolService } from "../../git/backburner-git-tool-service.js";
import { antigravityRuntimeProvider } from "./providers/antigravity.js";
import { claudeRuntimeProvider } from "./providers/claude.js";
import { codexRuntimeProvider } from "./providers/codex.js";
import { geminiRuntimeProvider } from "./providers/gemini.js";
import { openCodeRuntimeProvider } from "./providers/opencode.js";
import type { ProviderRuntimeDescriptor } from "./provider-runtime-types.js";
import {
  buildCapabilitiesByProvider,
  buildEffectiveProviderBrokerToolAllowLists
} from "./provider-tools.js";

const providerRuntimeDescriptors: readonly ProviderRuntimeDescriptor[] = [
  codexRuntimeProvider,
  geminiRuntimeProvider,
  claudeRuntimeProvider,
  openCodeRuntimeProvider,
  antigravityRuntimeProvider
];

export interface ProviderRuntimeInput {
  agentRunner: AgentRunner | undefined;
  commandRunner: CommandRunner;
  config: LoadedConfig;
  currentMcpStatuses: McpStatusRecord[];
  gitHubGateway: GitHubGateway;
  logger: Logger;
  logDir: string;
  brokerPort: number;
  startBrokerServer: typeof startGitHubBrokerServer;
  memoryToolService: JobMemoryToolService;
  backburnerGitToolService: BackburnerGitToolService;
}

export interface ProviderRuntimeResult {
  agentRunner: AgentRunner;
  capabilitiesByProvider?: ReadonlyMap<string, AgentVisibleCapabilities>;
  providerBrokerToolAllowLists?: ReadonlyMap<string, readonly string[]>;
  brokerToolScope?: ScopedBrokerToolService;
  brokerServer?: Awaited<ReturnType<typeof startGitHubBrokerServer>>;
  brokerLogger?: ManagedLogger;
}

export async function setupProviderRuntime(input: ProviderRuntimeInput): Promise<ProviderRuntimeResult> {
  let brokerServer: Awaited<ReturnType<typeof startGitHubBrokerServer>> | undefined;
  let brokerLogger: ManagedLogger | undefined;

  try {
    let agentRunner = input.agentRunner;
    let capabilitiesByProvider: ReadonlyMap<string, AgentVisibleCapabilities> | undefined;
    let providerBrokerToolAllowLists: ReadonlyMap<string, readonly string[]> | undefined;
    let brokerToolScope: ScopedBrokerToolService | undefined;

    const enabledProviderDescriptors = providerRuntimeDescriptors.filter((descriptor) =>
      descriptor.isEnabled(input.config)
    );

    if (!agentRunner && enabledProviderDescriptors.length > 0) {
      const brokerToolUnion = new Set<string>();
      for (const descriptor of enabledProviderDescriptors) {
        descriptor.toolAllowList(input.config).forEach((toolName) => brokerToolUnion.add(toolName));
      }

      brokerLogger = createTeeFileLogger(input.logger, path.join(input.logDir, "github-broker.log"));
      const githubBrokerService = new GitHubBrokerService(
        input.gitHubGateway,
        input.config.repos,
        brokerLogger,
        Array.from(brokerToolUnion)
      );

      const planBreakdownSessionStore = new PlanBreakdownSessionStore(input.logDir);
      const planBreakdownToolService = new PlanBreakdownToolService(planBreakdownSessionStore, input.logger);
      const waveAssessmentSessionStore = new WaveAssessmentSessionStore(input.logDir);
      const waveAssessmentToolService = new WaveAssessmentToolService(waveAssessmentSessionStore, input.logger);
      let smitheryBridgeServices: Awaited<ReturnType<typeof createSmitheryMcpBridgeServicesFromStatuses>> = [];
      try {
        smitheryBridgeServices = await createSmitheryMcpBridgeServicesFromStatuses(
          input.currentMcpStatuses,
          { apiKey: process.env.SMITHERY_API_KEY },
          undefined,
          Array.from(brokerToolUnion)
        );
      } catch (err) {
        input.logger.warn(`Failed to initialize Smithery MCP bridge tools: ${err instanceof Error ? err.message : String(err)}`);
      }

      const brokerService = new ComposedBrokerService([
        githubBrokerService,
        ...smitheryBridgeServices,
        planBreakdownToolService,
        waveAssessmentToolService,
        input.memoryToolService,
        input.backburnerGitToolService
      ]);
      brokerToolScope = new ScopedBrokerToolService(brokerService);

      brokerServer = await input.startBrokerServer({
        brokerService: brokerToolScope,
        host: "127.0.0.1",
        port: input.brokerPort,
        logger: brokerLogger
      });

      const composite = new CompositeAgentRunner();
      const planBreakdownTools = [
        "plan_breakdown.start_session",
        "plan_breakdown.apply_patch",
        "plan_breakdown.inspect_session",
        "plan_breakdown.validate_session",
        "plan_breakdown.export_session"
      ];
      const memoryTools = ["memory_search", "memory_add"];
      const waveAssessmentTools = [
        "wave_assessment.start_session",
        "wave_assessment.add_finding",
        "wave_assessment.complete_session",
        "wave_assessment.export_session"
      ];
      const backburnerGitTools = input.backburnerGitToolService.listTools().map((tool) => tool.name);
      const extraTools = [...planBreakdownTools, ...waveAssessmentTools, ...memoryTools, ...backburnerGitTools];
      const providerBrokerToolAllowListsForRun = new Map<string, readonly string[]>();
      for (const descriptor of enabledProviderDescriptors) {
        providerBrokerToolAllowListsForRun.set(descriptor.provider, [
          ...descriptor.toolAllowList(input.config),
          ...extraTools
        ]);
      }

      const registeredPublicBrokerToolNames = brokerService.listTools().map((tool) => tool.name);
      capabilitiesByProvider = buildCapabilitiesByProvider({
        capabilities: input.config.capabilities,
        mcps: input.config.mcps,
        mcpStatuses: input.currentMcpStatuses,
        enabledAgents: input.config.agents.filter((agent) => agent.enabled),
        providerBrokerToolAllowLists: providerBrokerToolAllowListsForRun,
        registeredPublicBrokerToolNames
      });
      const effectiveProviderBrokerToolAllowListsForRun = buildEffectiveProviderBrokerToolAllowLists({
        declaredMcps: input.config.mcps,
        enabledAgents: input.config.agents.filter((agent) => agent.enabled),
        providerBrokerToolAllowLists: providerBrokerToolAllowListsForRun,
        capabilitiesByProvider,
        registeredPublicBrokerToolNames,
        internalAlwaysAllowedTools: extraTools
      });
      providerBrokerToolAllowLists = effectiveProviderBrokerToolAllowListsForRun;

      for (const descriptor of enabledProviderDescriptors) {
        descriptor.register({
          composite,
          commandRunner: input.commandRunner,
          config: input.config,
          logDir: input.logDir,
          logger: input.logger,
          serverUrl: brokerServer.url,
          toolAllowList: effectiveProviderBrokerToolAllowListsForRun.get(descriptor.provider) ?? [],
          planBreakdownSessionStore,
          waveAssessmentSessionStore
        });
      }
      agentRunner = composite;
    }

    if (!agentRunner) {
      agentRunner = new CodexCliAgent({
        commandRunner: input.commandRunner,
        logDir: input.logDir,
        logger: input.logger,
        planBreakdownSessionStore: new PlanBreakdownSessionStore(input.logDir),
        waveAssessmentSessionStore: new WaveAssessmentSessionStore(input.logDir)
      });
    }

    return {
      agentRunner,
      ...(capabilitiesByProvider ? { capabilitiesByProvider } : {}),
      ...(providerBrokerToolAllowLists ? { providerBrokerToolAllowLists } : {}),
      ...(brokerToolScope ? { brokerToolScope } : {}),
      ...(brokerServer ? { brokerServer } : {}),
      ...(brokerLogger ? { brokerLogger } : {})
    };
  } catch (error) {
    if (brokerServer) {
      await brokerServer.close();
    }
    if (brokerLogger) {
      await brokerLogger.close();
    }
    throw error;
  }
}
