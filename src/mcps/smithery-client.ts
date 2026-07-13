import Smithery from "@smithery/api";
import type {
  SmitheryClient,
  SmitheryServerLookupResult,
  SmitheryRuntimeConfig,
  SmitheryConnectionResult,
  SmitheryConnectionMetadata,
} from "./smithery.js";

type SmitherySdkConnection = {
  connectionId: string;
  namespace?: string | null;
  transport?: string | null;
  mcpUrl?: string | null;
  status?: {
    state?: string;
    message?: string;
    setupUrl?: string;
    authorizationUrl?: string;
    url?: string;
    fields?: string[];
    http?: { headers?: Record<string, unknown>; query?: Record<string, unknown> };
    missing?: { headers?: string[]; query?: string[] };
  };
  metadata?: SmitheryConnectionMetadata | null;
};

type SmitherySdkClientShape = {
  servers: {
    get(smitheryId: string): Promise<any>;
  };
  connections: {
    get(connectionId: string, params: { namespace: string }): Promise<SmitherySdkConnection>;
    set(
      connectionId: string,
      params: {
        namespace: string;
        server: string;
        name: string;
        transport?: string;
        mcpUrl?: string;
        metadata?: SmitheryConnectionMetadata;
        headers?: Record<string, string>;
        mock?: boolean | { enabled: boolean; scenario?: string };
      }
    ): Promise<SmitherySdkConnection>;
  };
};

function isSmitherySdkClientShape(candidate: unknown): candidate is SmitherySdkClientShape {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const maybe = candidate as Partial<SmitherySdkClientShape>;
  return typeof maybe.servers?.get === "function" && typeof maybe.connections?.get === "function" && typeof maybe.connections?.set === "function";
}

export class SmitherySdkClient implements SmitheryClient {
  private readonly fetchFn: typeof fetch;
  private sdkClient?: SmitherySdkClientShape;

  constructor(
    private readonly runtimeConfig: SmitheryRuntimeConfig,
    clientOrFetch?: typeof fetch | SmitherySdkClientShape,
    sdkClient?: SmitherySdkClientShape
  ) {
    this.fetchFn = typeof clientOrFetch === "function" ? clientOrFetch : fetch;
    if (isSmitherySdkClientShape(clientOrFetch)) {
      this.sdkClient = clientOrFetch;
    } else if (sdkClient) {
      this.sdkClient = sdkClient;
    }
  }

  async getServerByExactId(smitheryId: string): Promise<SmitheryServerLookupResult> {
    if (!this.runtimeConfig.apiKey) {
      return {
        status: "error",
        message: "Missing Smithery API key.",
      };
    }

    try {
      const server = await this.getClient().servers.get(smitheryId);

      // Check for required configuration
      const configProperties = new Set<string>();
      if (Array.isArray(server.connections)) {
        for (const conn of server.connections) {
          if (conn.configSchema?.properties) {
            for (const key of Object.keys(conn.configSchema.properties as object)) {
              configProperties.add(key);
            }
          }
        }
      }

      const actionRequired =
        configProperties.size > 0
          ? {
              reason: "config_required" as const,
              message: `Configuration required for Smithery server "${smitheryId}".`,
              fields: Array.from(configProperties),
            }
          : undefined;

      // Map connection info if available. We prefer hosted HTTP connections.
      const httpConn = server.connections?.find((c: any) => c.type === "http");
      const connection = httpConn
        ? {
            transport: "http" as const,
            mcpUrl:
              (httpConn as any).deploymentUrl ||
              (httpConn as any).bundleUrl ||
              server.deploymentUrl ||
              undefined,
            readiness: "unknown" as const,
          }
        : undefined;

      return {
        status: "found",
        server: {
          name: server.displayName || server.qualifiedName,
          tools: (server.tools as any) ?? undefined,
          resources: (server.resources as any) ?? undefined,
          prompts: (server.prompts as any) ?? undefined,
        },
        actionRequired,
        connection,
      };
    } catch (err: any) {
      if (err.status === 404) {
        return {
          status: "not_found",
          message: `Smithery server "${smitheryId}" not found.`,
        };
      }
      if (err.status === 401 || err.status === 403) {
        return {
          status: "error",
          message: `Smithery API key is missing, invalid, or unauthorized (HTTP ${err.status}). Check the SMITHERY_API_KEY runtime configuration.`,
        };
      }
      return {
        status: "error",
        message: err.message || String(err),
      };
    }
  }

  async getConnection(namespace: string, connectionId: string): Promise<SmitheryConnectionResult> {
    if (!this.runtimeConfig.apiKey) {
      return { status: "error", message: "Missing Smithery API key." };
    }

    try {
      const connection = await this.getClient().connections.get(connectionId, { namespace });
      return this.mapConnectionData(connection);
    } catch (err: any) {
      if (err.status === 404) {
        return {
          status: "not_found",
          message: `Connection "${connectionId}" not found in namespace "${namespace}".`,
        };
      }
      if (err.status === 401 || err.status === 403) {
        return {
          status: "error",
          message: `Smithery API key is missing, invalid, or unauthorized (HTTP ${err.status}). Check the SMITHERY_API_KEY runtime configuration.`,
        };
      }
      return { status: "error", message: err.message || String(err) };
    }
  }

  async createOrUpdateConnection(input: {
    namespace: string;
    connectionId: string;
    smitheryId: string;
    handle: string;
    transport?: string | undefined;
    mcpUrl?: string | undefined;
  }): Promise<SmitheryConnectionResult> {
    if (!this.runtimeConfig.apiKey) {
      return { status: "error", message: "Missing Smithery API key." };
    }

    try {
      const connection = await this.getClient().connections.set(input.connectionId, {
        namespace: input.namespace,
        server: input.smitheryId,
        name: input.handle,
        ...(input.transport ? { transport: input.transport as any } : {}),
        metadata: {
          backburner: "backburner",
          backburnerHandle: input.handle,
          providerMcpId: input.smitheryId,
          localConnectionIdentity: input.connectionId,
        },
      } as any);

      return this.mapConnectionData(connection);
    } catch (err: any) {
      if (err.status === 401 || err.status === 403) {
        return {
          status: "error",
          message: `Smithery API key is missing, invalid, or unauthorized (HTTP ${err.status}). Check the SMITHERY_API_KEY runtime configuration.`,
        };
      }
      return { status: "error", message: err.message || String(err) };
    }
  }

  private mapConnectionData(data: SmitherySdkConnection): SmitheryConnectionResult {
    const state = data.status?.state;
    let status: SmitheryConnectionResult["status"] = "error";

    if (state === "connected") status = "connected";
    else if (state === "auth_required") status = "auth_required";
    else if (state === "input_required") status = "input_required";
    else if (state === "disconnected") status = "disconnected";

    const rawMetadata = (data as any).metadata;
    const metadata =
      rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
        ? (rawMetadata as SmitheryConnectionResult["metadata"])
        : undefined;

    return {
      status,
      message: (data.status as any)?.message,
      connectionId: data.connectionId,
      namespace: (data as any).namespace,
      transport: data.transport ?? undefined,
      mcpUrl: data.mcpUrl || undefined,
      setupUrl: (data.status as any)?.setupUrl || (data.status as any)?.url,
      fields: (data.status as any)?.fields,
      ...(metadata ? { metadata } : {}),
    };
  }

  private getClient(): SmitherySdkClientShape {
    if (this.sdkClient) {
      return this.sdkClient;
    }

    if (!this.runtimeConfig.apiKey) {
      throw new Error("Missing Smithery API key.");
    }

    this.sdkClient = new Smithery({
      apiKey: this.runtimeConfig.apiKey,
      fetch: this.fetchFn,
    }) as unknown as SmitherySdkClientShape;
    return this.sdkClient;
  }
}
