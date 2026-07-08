import { OpenCodeCliAgent } from "../../../agents/opencode.js";
import type { ProviderRuntimeDescriptor } from "../provider-runtime-types.js";

export const openCodeRuntimeProvider: ProviderRuntimeDescriptor = {
  provider: "opencode",
  isEnabled: (config) => config.agents.some((agent) => agent.enabled && agent.provider === "opencode"),
  toolAllowList: (config) => config.opencode.githubBroker.toolAllowList,
  register: (input) => {
    input.composite.register(
      "opencode",
      new OpenCodeCliAgent({
        commandRunner: input.commandRunner,
        logDir: input.logDir,
        logger: input.logger,
        githubBroker: {
          serverName: input.config.opencode.githubBroker.serverName,
          serverUrl: input.serverUrl,
          toolAllowList: [...input.toolAllowList]
        },
        planBreakdownSessionStore: input.planBreakdownSessionStore,
        waveAssessmentSessionStore: input.waveAssessmentSessionStore
      })
    );
  }
};
