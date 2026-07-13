import type { McpDependency } from "../config/types.js";
import type { McpStatusRecord } from "../state/types.js";

export type McpProviderId = "smithery";

export type ResolvedMcpStatus =
  | "ready"
  | "resolved"
  | "action_required"
  | "resolution_failed"
  | "error";

export interface ResolvedMcpActionRequired {
  reason: string;
  message?: string;
  url?: string;
  fields?: string[];
}

export interface ResolvedMcpConnectionMetadata {
  localConnectionIdentity?: string;
  providerConnectionId?: string;
  namespace?: string;
  transport?: string;
  readiness:
    | "connected"
    | "auth_required"
    | "input_required"
    | "disconnected"
    | "error"
    | "not_found"
    | "unknown";
  checkedAt?: string;
  mcpUrl?: string; // runtime-only, never copied to McpStatusRecord
  message?: string;
}

export interface ResolvedMcpCapabilityMetadata {
  name?: string | undefined;
  tools?: Array<{ name: string; description?: string }> | undefined;
  resources?: Array<{ name?: string; uri?: string; description?: string; mimeType?: string }> | undefined;
  prompts?: Array<{ name: string; description?: string }> | undefined;
}

export interface ResolvedMcp {
  handle: string;
  provider: McpProviderId;
  providerMcpId: string;
  status: ResolvedMcpStatus;
  message?: string | undefined;
  actionRequired?: ResolvedMcpActionRequired | undefined;
  connection?: ResolvedMcpConnectionMetadata | undefined;
  discovered?: ResolvedMcpCapabilityMetadata | undefined;
}

export interface McpDependencyResolver {
  resolveDependencies(
    dependencies: McpDependency[],
    previous?: McpStatusRecord[]
  ): Promise<ResolvedMcp[]>;
}
