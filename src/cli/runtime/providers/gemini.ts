import { GeminiCliAgent } from "../../../agents/gemini.js";
import type { ProviderRuntimeDescriptor } from "../provider-runtime-types.js";

export const geminiRuntimeProvider: ProviderRuntimeDescriptor = {
  provider: "gemini",
  isEnabled: (config) => config.agents.some((agent) => agent.enabled && agent.provider === "gemini"),
  toolAllowList: (config) => config.gemini.githubBroker.toolAllowList,
  register: (input) => {
    input.composite.register(
      "gemini",
      new GeminiCliAgent({
        commandRunner: input.commandRunner,
        logDir: input.logDir,
        logger: input.logger,
        githubBroker: {
          serverName: input.config.gemini.githubBroker.serverName,
          serverUrl: input.serverUrl,
          toolAllowList: [...input.toolAllowList]
        },
        planBreakdownSessionStore: input.planBreakdownSessionStore,
        waveAssessmentSessionStore: input.waveAssessmentSessionStore
      })
    );
  }
};
