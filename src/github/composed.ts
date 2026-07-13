import type { BrokerTool, BrokerToolService, BrokerToolCallResult } from "./types.js";

interface BrokerToolRoute {
  publicName: string;
  serviceToolName: string;
  service: BrokerToolService;
  tool: BrokerTool;
}

export class ComposedBrokerService implements BrokerToolService {
  private readonly routes = new Map<string, BrokerToolRoute>();

  constructor(private readonly services: BrokerToolService[]) {
    for (const service of services) {
      const namespace = service.namespace;
      if (namespace !== undefined && (namespace === "" || namespace.includes("."))) {
        throw new Error(
          `Invalid namespace "${namespace}". Namespaces must be non-empty and must not contain "."`
        );
      }

      for (const tool of service.listTools()) {
        if (tool.name === "") {
          throw new Error("Tool local name must be non-empty");
        }

        const publicName = namespace ? `${namespace}.${tool.name}` : tool.name;

        if (this.routes.has(publicName)) {
          throw new Error(`Duplicate tool registration for public name "${publicName}"`);
        }

        this.routes.set(publicName, {
          publicName,
          serviceToolName: tool.name,
          service,
          tool
        });
      }
    }
  }

  listTools(): BrokerTool[] {
    return Array.from(this.routes.values()).map((route) => ({
      ...route.tool,
      name: route.publicName
    }));
  }

  async callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    const route = this.routes.get(name);
    if (!route) {
      return {
        ok: false,
        tool: name,
        error: {
          code: "tool_not_found",
          message: `Tool "${name}" not found in any registered service`
        }
      };
    }

    const result = await route.service.callTool(route.serviceToolName, rawArguments);

    // Ensure the returned tool name matches the public name used for the call
    return {
      ...result,
      tool: name
    };
  }
}
