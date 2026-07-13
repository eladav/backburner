import type { AgentConfig } from "../config/types.js";
import type { BuiltContext } from "../context/types.js";
import type { AgentRunner, DispatchResult } from "./types.js";
import type { TaskRecord } from "../tasks/types.js";

import type { ProviderSessionDecision } from "./provider-sessions.js";
import type { ResolvedPromptContent } from "../prompts/resolver.js";

export class CompositeAgentRunner implements AgentRunner {
  private readonly runners = new Map<string, AgentRunner>();

  register(provider: string, runner: AgentRunner): void {
    this.runners.set(provider, runner);
  }

  async dispatch(
    task: TaskRecord,
    context: BuiltContext,
    agentConfig: AgentConfig,
    sessionDecision?: ProviderSessionDecision,
    promptContent?: ResolvedPromptContent
  ): Promise<DispatchResult> {
    const runner = this.runners.get(agentConfig.provider);
    if (!runner) {
      throw new Error(`No runner registered for agent provider "${agentConfig.provider}" (agent: ${agentConfig.id})`);
    }

    return runner.dispatch(task, context, agentConfig, sessionDecision, promptContent);
  }
}
