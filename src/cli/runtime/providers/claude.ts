import { ClaudeCodeCliAgent } from "../../../agents/claude.js";
import type { ProviderRuntimeDescriptor } from "../provider-runtime-types.js";

export const claudeRuntimeProvider: ProviderRuntimeDescriptor = {
  provider: "claude",
  isEnabled: (config) => config.agents.some((agent) => agent.enabled && agent.provider === "claude"),
  toolAllowList: (config) => config.claude.githubBroker.toolAllowList,
  register: (input) => {
    input.composite.register(
      "claude",
      new ClaudeCodeCliAgent({
        commandRunner: input.commandRunner,
        logDir: input.logDir,
        logger: input.logger,
        githubBroker: {
          serverName: input.config.claude.githubBroker.serverName,
          serverUrl: input.serverUrl,
          toolAllowList: [...input.toolAllowList]
        },
        planBreakdownSessionStore: input.planBreakdownSessionStore,
        waveAssessmentSessionStore: input.waveAssessmentSessionStore
      })
    );
  }
};
