import { CodexCliAgent } from "../../../agents/codex.js";
import type { ProviderRuntimeDescriptor } from "../provider-runtime-types.js";

export const codexRuntimeProvider: ProviderRuntimeDescriptor = {
  provider: "codex",
  isEnabled: (config) => config.agents.some((agent) => agent.enabled && agent.provider === "codex"),
  toolAllowList: (config) => config.codex.githubBroker.toolAllowList,
  register: (input) => {
    input.composite.register(
      "codex",
      new CodexCliAgent({
        commandRunner: input.commandRunner,
        logDir: input.logDir,
        logger: input.logger,
        githubBroker: {
          serverName: input.config.codex.githubBroker.serverName,
          serverUrl: input.serverUrl,
          toolAllowList: [...input.toolAllowList]
        },
        planBreakdownSessionStore: input.planBreakdownSessionStore,
        waveAssessmentSessionStore: input.waveAssessmentSessionStore
      })
    );
  }
};
