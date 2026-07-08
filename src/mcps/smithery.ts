import { createHash } from "node:crypto";
import type { McpDependency } from "../config/types.js";
import type { McpStatusRecord } from "../state/types.js";
import type {
  McpDependencyResolver,
  ResolvedMcp,
  ResolvedMcpStatus,
  ResolvedMcpActionRequired,
  ResolvedMcpConnectionMetadata,
  ResolvedMcpCapabilityMetadata,
} from "./types.js";

import { SmitherySdkClient } from "./smithery-client.js";

export function deriveSmitheryConnectionId(handle: string, smitheryId: string): string {
  const hash = createHash("sha256")
    .update(`${handle}|${smitheryId}`)
    .digest("hex")
    .slice(0, 8);
  const sanitizedHandle = handle.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase().slice(0, 20);
  return `backburner-${sanitizedHandle}-${hash}`;
}

export interface SmitheryServerLookupResult {
  status: "found" | "not_found" | "action_required" | "error";
  message?: string | undefined;
  server?: {
    name: string;
    tools?: Array<{ name: string; description?: string }> | undefined;
    resources?: Array<{ name?: string; uri?: string; description?: string; mimeType?: string }> | undefined;
    prompts?: Array<{ name: string; description?: string }> | undefined;
  } | undefined;
  actionRequired?: ResolvedMcpActionRequired | undefined;
  connection?: ResolvedMcpConnectionMetadata | undefined;
}

export interface SmitheryConnectionResult {
  status: "connected" | "auth_required" | "input_required" | "disconnected" | "error" | "not_found";
  message?: string | undefined;
  connectionId?: string | undefined;
  namespace?: string | undefined;
  transport?: string | undefined;
  mcpUrl?: string | undefined;
  setupUrl?: string | undefined;
  fields?: string[] | undefined;
  metadata?: SmitheryConnectionMetadata | undefined;
}

export interface SmitheryConnectionMetadata {
  backburner?: string;
  backburnerHandle?: string;
  providerMcpId?: string;
  localConnectionIdentity?: string;
  [key: string]: unknown;
}

export interface SmitheryClient {
  getServerByExactId(smitheryId: string): Promise<SmitheryServerLookupResult>;
  getConnection(namespace: string, connectionId: string): Promise<SmitheryConnectionResult>;
  createOrUpdateConnection(input: {
    namespace: string;
    connectionId: string;
    smitheryId: string;
    handle: string;
    transport?: string | undefined;
    mcpUrl?: string | undefined;
  }): Promise<SmitheryConnectionResult>;
}

function isOwnedConnection(
  connection: SmitheryConnectionResult,
  handle: string,
  smitheryId: string,
  localConnectionIdentity: string
): boolean {
  const meta = connection.metadata;
  return (
    meta?.backburner === "backburner" &&
    meta.backburnerHandle === handle &&
    meta.providerMcpId === smitheryId &&
    meta.localConnectionIdentity === localConnectionIdentity
  );
}

export interface SmitheryRuntimeConfig {
  apiKey?: string | undefined;
  namespace?: string | undefined;
}

export class SmitheryMcpResolver implements McpDependencyResolver {
  constructor(
    private readonly client: SmitheryClient,
    private readonly runtimeConfig: SmitheryRuntimeConfig
  ) {}

  async resolveDependencies(
    dependencies: McpDependency[],
    previous: McpStatusRecord[] = []
  ): Promise<ResolvedMcp[]> {
    const previousByHandle = new Map(previous.map((r) => [r.handle, r]));
    return Promise.all(
      dependencies.map((dependency) =>
        this.resolveOne(dependency, previousByHandle.get(dependency.handle))
      )
    );
  }

  private async resolveOne(dependency: McpDependency, prev?: McpStatusRecord): Promise<ResolvedMcp> {
    const result: ResolvedMcp = {
      handle: dependency.handle,
      provider: "smithery",
      providerMcpId: dependency.smitheryId,
      status: "error", // Default to error
    };

    if (!this.runtimeConfig.apiKey) {
      result.status = "error";
      result.message = "Missing Smithery API key. Set SMITHERY_API_KEY to resolve Smithery MCP dependencies.";
      return result;
    }

    if (!this.runtimeConfig.namespace) {
      result.status = "error";
      result.message = "Missing Smithery namespace. Set SMITHERY_NAMESPACE to resolve Smithery MCP dependencies.";
      return result;
    }

    try {
      // 1. Verify server exists
      const lookup = await this.client.getServerByExactId(dependency.smitheryId);
      if (lookup.status === "not_found") {
        result.status = "resolution_failed";
        result.message = lookup.message || `Smithery server "${dependency.smitheryId}" not found.`;
        return result;
      }
      if (lookup.status === "error") {
        result.status = "error";
        result.message = lookup.message || "Unknown Smithery error during server lookup.";
        return result;
      }
      if (lookup.status === "action_required") {
        result.status = "action_required";
        result.actionRequired = lookup.actionRequired;
        result.message = lookup.message;
        return result;
      }

      result.discovered = lookup.server;

      if (!lookup.connection) {
        result.status = "resolved";
        result.message = "Server lookup succeeded but no usable hosted HTTP connection was found.";
        return result;
      }

      // 2. Manage connection
      const namespace = this.runtimeConfig.namespace;
      const localConnectionIdentity = deriveSmitheryConnectionId(dependency.handle, dependency.smitheryId);
      const candidateIds: string[] = [];
      if (prev?.connection?.localConnectionIdentity === localConnectionIdentity && prev.connection.providerConnectionId) {
        candidateIds.push(prev.connection.providerConnectionId);
      }
      if (!candidateIds.includes(localConnectionIdentity)) {
        candidateIds.push(localConnectionIdentity);
      }

      let connection: SmitheryConnectionResult | undefined;
      for (const candidateId of candidateIds) {
        const candidate = await this.client.getConnection(namespace, candidateId);
        if (candidate.status === "not_found") {
          continue;
        }
        if (
          candidate.status === "connected" ||
          candidate.status === "auth_required" ||
          candidate.status === "input_required" ||
          candidate.status === "disconnected"
        ) {
          if (!isOwnedConnection(candidate, dependency.handle, dependency.smitheryId, localConnectionIdentity)) {
            continue;
          }
        }

        connection = candidate;
        break;
      }

      if (!connection || connection.status === "disconnected") {
        connection = await this.client.createOrUpdateConnection({
          namespace,
          connectionId: localConnectionIdentity,
          smitheryId: dependency.smitheryId,
          handle: dependency.handle,
          transport: lookup.connection?.transport,
          mcpUrl: lookup.connection?.mcpUrl,
        });
      }

      if (
        connection.status === "connected" &&
        !isOwnedConnection(connection, dependency.handle, dependency.smitheryId, localConnectionIdentity)
      ) {
        result.status = "error";
        result.message = `Smithery connection "${localConnectionIdentity}" is connected but its metadata does not match Backburner handle "${dependency.handle}" and Smithery id "${dependency.smitheryId}"; refusing to mark ready.`;
        return result;
      }

      result.connection = {
        localConnectionIdentity,
        readiness: connection.status,
        ...(connection.connectionId ? { providerConnectionId: connection.connectionId } : {}),
        namespace: connection.namespace || namespace,
        ...(connection.transport ? { transport: connection.transport } : {}),
        ...(connection.mcpUrl ? { mcpUrl: connection.mcpUrl } : {}),
        ...(connection.message ? { message: connection.message } : {}),
      };

      switch (connection.status) {
        case "connected":
          result.status = "ready";
          result.message = connection.message || `Smithery connection is ready for "${dependency.handle}".`;
          break;
        case "auth_required":
        case "input_required":
          result.status = "action_required";
          result.actionRequired = {
            reason: connection.status === "auth_required" ? "auth_required" : "input_required",
            message: connection.message || `Smithery connection for "${dependency.handle}" requires user action.`,
            ...(connection.setupUrl ? { url: connection.setupUrl } : {}),
            ...(connection.fields ? { fields: connection.fields } : {}),
          };
          break;
        case "disconnected":
          result.status = "resolved";
          result.message = connection.message || `Smithery connection for "${dependency.handle}" exists but is disconnected.`;
          break;
        case "error":
          result.status = "error";
          result.message = connection.message || "Unknown Smithery connection error.";
          break;
        default:
          result.status = "error";
          result.message = `Unexpected Smithery connection status: ${connection.status}`;
      }
    } catch (err) {
      result.status = "error";
      result.message = err instanceof Error ? err.message : String(err);
    }

    return result;
  }
}

export function createSmitheryMcpResolverFromEnv(env: NodeJS.ProcessEnv = process.env): SmitheryMcpResolver {
  const apiKey = env.SMITHERY_API_KEY;
  const namespace = env.SMITHERY_NAMESPACE;
  const config: SmitheryRuntimeConfig = { apiKey, namespace };
  const client = new SmitherySdkClient(config);
  return new SmitheryMcpResolver(client, config);
}
