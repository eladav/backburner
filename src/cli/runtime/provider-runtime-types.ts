import type { CompositeAgentRunner } from "../../agents/composite-runner.js";
import type { LoadedConfig } from "../../config/loader.js";
import type { AgentProvider } from "../../config/types.js";
import type { CommandRunner } from "../../utils/command-runner.js";
import type { Logger } from "../../utils/logger.js";
import type { PlanBreakdownSessionStore } from "../../workstreams/plan-breakdown-generator/store.js";
import type { WaveAssessmentSessionStore } from "../../workstreams/wave-assessment/store.js";

export interface ProviderRegisterInput {
  composite: CompositeAgentRunner;
  commandRunner: CommandRunner;
  config: LoadedConfig;
  logDir: string;
  logger: Logger;
  serverUrl: string;
  toolAllowList: readonly string[];
  planBreakdownSessionStore: PlanBreakdownSessionStore;
  waveAssessmentSessionStore: WaveAssessmentSessionStore;
}

export interface ProviderRuntimeDescriptor {
  provider: AgentProvider;
  isEnabled(config: LoadedConfig): boolean;
  toolAllowList(config: LoadedConfig): readonly string[];
  register(input: ProviderRegisterInput): void;
}
