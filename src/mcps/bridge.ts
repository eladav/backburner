import Smithery from "@smithery/api";
import type { BrokerTool, BrokerToolCallResult, BrokerToolService } from "../github/types.js";
import type { McpStatusRecord } from "../state/types.js";

/**
 * Small, fakeable client seam for a ready MCP connection.
 *
 * The bridge intentionally consumes orchestrator-owned connection state instead
 * of accepting URLs, tokens, or provider metadata from the agent. Production
 * calls go through Smithery's connection tool API; tests inject this seam.
 */
export interface BridgedMcpClient {
  listTools(): BrokerTool[] | Promise<BrokerTool[]>;
  getTool?(name: string): BrokerTool | undefined | Promise<BrokerTool | undefined>;
  callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult>;
}

export interface ReadyMcpBridgeInput {
  status: McpStatusRecord;
  client: BridgedMcpClient;
  allowedPublicToolNames?: readonly string[] | undefined;
}

export interface ReadyMcpBridgeProjection {
  handle: string;
  tools: string[];
}

interface SmitheryToolsClientShape {
  connections: {
    tools: {
      list(connectionId: string, params: { namespace: string }): Promise<{
        tools: Array<{
          name: string;
          title?: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
      }>;
      get(toolPath: string, params: { namespace: string; connectionId: string }): Promise<{
        name: string;
        title?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
      call(
        toolPath: string,
        params: {
          namespace: string;
          connectionId: string;
          body: Record<string, unknown>;
        }
      ): Promise<Record<string, unknown>>;
    };
  };
}

export interface SmitheryBridgeRuntimeConfig {
  apiKey?: string | undefined;
}

export class SmitheryConnectionToolsClient implements BridgedMcpClient {
  constructor(
    private readonly input: {
      namespace: string;
      connectionId: string;
      client: SmitheryToolsClientShape;
    }
  ) {}

  async listTools(): Promise<BrokerTool[]> {
    const response = await this.input.client.connections.tools.list(
      this.input.connectionId,
      { namespace: this.input.namespace }
    );
    return response.tools.map((tool) => toBrokerTool(tool));
  }

  async getTool(name: string): Promise<BrokerTool | undefined> {
    try {
      return toBrokerTool(await this.input.client.connections.tools.get(name, {
        namespace: this.input.namespace,
        connectionId: this.input.connectionId
      }));
    } catch {
      return undefined;
    }
  }

  async callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    try {
      const body = normalizeToolArguments(rawArguments);
      const result = await this.input.client.connections.tools.call(name, {
        namespace: this.input.namespace,
        connectionId: this.input.connectionId,
        body
      });
      return {
        ok: true,
        tool: name,
        result,
        summary: `Smithery MCP tool "${name}" succeeded.`
      };
    } catch (err) {
      return {
        ok: false,
        tool: name,
        error: {
          code: "smithery_tool_call_failed",
          message: err instanceof Error ? err.message : String(err)
        }
      };
    }
  }
}

function toBrokerTool(tool: {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}): BrokerTool {
  return {
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? `Smithery MCP tool ${tool.name}`,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} }
  };
}

export class ReadyMcpBridgeService implements BrokerToolService {
  public readonly namespace: string;
  private cachedTools?: BrokerTool[];

  constructor(
    private readonly handle: string,
    private readonly client: BridgedMcpClient,
    allowedPublicToolNames?: readonly string[] | undefined
  ) {
    this.namespace = handle;
    this.allowedLocalToolNames = allowedPublicToolNames
      ? new Set(
          allowedPublicToolNames
            .filter((name) => name.startsWith(`${handle}.`))
            .filter((name) => !name.endsWith(".*"))
            .map((name) => name.slice(handle.length + 1))
        )
      : undefined;
  }
  private readonly allowedLocalToolNames: ReadonlySet<string> | undefined;

  listTools(): BrokerTool[] {
    return (this.cachedTools ?? [])
      .filter((tool) => this.isToolAllowed(tool.name))
      .map((tool) => ({
        ...tool,
        name: tool.name
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async initialize(): Promise<void> {
    try {
      this.cachedTools = await this.client.listTools();
    } catch (err) {
      if (this.allowedLocalToolNames === undefined || this.client.getTool === undefined) {
        throw err;
      }
      const tools: BrokerTool[] = [];
      for (const toolName of [...this.allowedLocalToolNames].sort((left, right) => left.localeCompare(right))) {
        const tool = await this.client.getTool(toolName);
        if (tool) {
          tools.push(tool);
        }
      }
      if (tools.length === 0) {
        throw err;
      }
      this.cachedTools = tools;
    }
  }

  async callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    if (!this.isToolAllowed(name)) {
      return {
        ok: false,
        tool: name,
        error: {
          code: "tool_not_found",
          message: `MCP bridge tool "${this.handle}.${name}" is not enabled for this run`
        }
      };
    }
    return await this.client.callTool(name, rawArguments);
  }

  private isToolAllowed(localToolName: string): boolean {
    return (
      this.allowedLocalToolNames === undefined ||
      this.allowedLocalToolNames.has(localToolName)
    );
  }
}

export function createReadyMcpBridgeService(input: ReadyMcpBridgeInput): ReadyMcpBridgeService | undefined {
  if (input.status.status !== "ready") {
    return undefined;
  }

  return new ReadyMcpBridgeService(input.status.handle, input.client, input.allowedPublicToolNames);
}

export function createReadyMcpBridgeServices(
  inputs: ReadyMcpBridgeInput[]
): ReadyMcpBridgeService[] {
  return [...inputs]
    .sort((left, right) => left.status.handle.localeCompare(right.status.handle))
    .map((input) => createReadyMcpBridgeService(input))
    .filter((service): service is ReadyMcpBridgeService => service !== undefined);
}

export async function createSmitheryMcpBridgeServicesFromStatuses(
  statuses: McpStatusRecord[],
  runtimeConfig: SmitheryBridgeRuntimeConfig,
  client?: SmitheryToolsClientShape,
  allowedPublicToolNames?: readonly string[] | undefined
): Promise<ReadyMcpBridgeService[]> {
  if (!runtimeConfig.apiKey && !client) {
    return [];
  }

  const sdkClient = client ?? new Smithery({ apiKey: runtimeConfig.apiKey }) as unknown as SmitheryToolsClientShape;
  const services: ReadyMcpBridgeService[] = [];

  for (const status of [...statuses].sort((left, right) => left.handle.localeCompare(right.handle))) {
    if (status.status !== "ready") {
      continue;
    }
    const namespace = status.connection?.namespace;
    const connectionId = status.connection?.providerConnectionId;
    if (!namespace || !connectionId) {
      continue;
    }

    const service = new ReadyMcpBridgeService(
      status.handle,
      new SmitheryConnectionToolsClient({ namespace, connectionId, client: sdkClient }),
      allowedPublicToolNames
    );
    await service.initialize();
    services.push(service);
  }

  return services;
}

export function projectReadyMcpBridge(service: BrokerToolService, status: McpStatusRecord): ReadyMcpBridgeProjection {
  return {
    handle: status.handle,
    tools: service.listTools().map((tool) => tool.name)
  };
}

function normalizeToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    return rawArguments as Record<string, unknown>;
  }
  return {};
}
