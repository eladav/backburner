import type { BrokerTool, BrokerToolCallResult, BrokerToolService } from "./types.js";

export class ScopedBrokerToolService implements BrokerToolService {
  private activeAllowedToolNames: ReadonlySet<string> | undefined;

  constructor(private readonly delegate: BrokerToolService) {}

  listTools(): BrokerTool[] {
    return this.delegate.listTools().filter((tool) => this.isAllowed(tool.name));
  }

  async callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    if (!this.isAllowed(name)) {
      return {
        ok: false,
        tool: name,
        error: {
          code: "tool_not_found",
          message: `Tool "${name}" is not enabled for this agent run`
        }
      };
    }

    return await this.delegate.callTool(name, rawArguments);
  }

  bindAllowedTools(allowedToolNames: readonly string[]): void {
    this.activeAllowedToolNames = new Set(allowedToolNames);
  }

  clearAllowedTools(): void {
    this.activeAllowedToolNames = undefined;
  }

  private isAllowed(publicToolName: string): boolean {
    return (
      this.activeAllowedToolNames === undefined ||
      this.activeAllowedToolNames.has(publicToolName) ||
      this.activeAllowedToolNames.has("*") ||
      Array.from(this.activeAllowedToolNames).some((allowedToolName) =>
        allowedToolName.endsWith(".*") && publicToolName.startsWith(allowedToolName.slice(0, -1))
      )
    );
  }
}
