import { AntigravityCliAgent } from "../../../agents/antigravity.js";
import type { ProviderRuntimeDescriptor } from "../provider-runtime-types.js";

export const antigravityRuntimeProvider: ProviderRuntimeDescriptor = {
  provider: "antigravity",
  isEnabled: (config) => config.agents.some((agent) => agent.enabled && agent.provider === "antigravity"),
  toolAllowList: (config) => config.antigravity.githubBroker.toolAllowList,
  register: (input) => {
    input.composite.register(
      "antigravity",
      new AntigravityCliAgent({
        commandRunner: input.commandRunner,
        logDir: input.logDir,
        logger: input.logger,
        ...(process.env.BACKBURNER_ANTIGRAVITY_CONFIG_HOME
          ? { configHome: process.env.BACKBURNER_ANTIGRAVITY_CONFIG_HOME }
          : {}),
        ...(process.env.BACKBURNER_GEMINI_CONFIG_HOME
          ? { legacyGeminiConfigHome: process.env.BACKBURNER_GEMINI_CONFIG_HOME }
          : {}),
        githubBroker: {
          serverName: input.config.antigravity.githubBroker.serverName,
          serverUrl: input.serverUrl,
          toolAllowList: [...input.toolAllowList]
        },
        planBreakdownSessionStore: input.planBreakdownSessionStore,
        waveAssessmentSessionStore: input.waveAssessmentSessionStore
      })
    );
  }
};
