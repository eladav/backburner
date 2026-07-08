import type { McpDependency } from "../config/types.js";
import type { ResolvedMcp } from "./types.js";
import type { McpStatusRecord } from "../state/types.js";

export interface McpStatusReconciliationResult {
  records: McpStatusRecord[];
  added: string[];      // handles new to persisted state
  updated: string[];    // handles whose status changed from previous
  unchanged: string[];  // handles whose status is identical to previous
  removed: string[];    // handles dropped because no longer in dependencies
}

export function reconcileMcpStatus(
  dependencies: McpDependency[],
  previous: McpStatusRecord[],
  resolverResults: ResolvedMcp[],
  now: string
): McpStatusReconciliationResult {
  const previousByHandle = new Map<string, McpStatusRecord>(
    previous.map((r) => [r.handle, r])
  );
  const currentHandles = new Set(dependencies.map((d) => d.handle));
  const resultByHandle = new Map<string, ResolvedMcp>(
    resolverResults.map((r) => [r.handle, r])
  );

  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  // Drop records for handles no longer in dependencies.
  for (const prev of previous) {
    if (!currentHandles.has(prev.handle)) {
      removed.push(prev.handle);
    }
  }

  const records: McpStatusRecord[] = [];

  for (const dep of dependencies) {
    const resolved = resultByHandle.get(dep.handle);
    const prev = previousByHandle.get(dep.handle);

    if (!resolved) {
      // No resolver result for this handle — carry forward previous if any.
      if (prev) {
        records.push(prev);
        unchanged.push(dep.handle);
      }
      continue;
    }

    const next = resolvedMcpToStatusRecord(resolved, now);

    if (!prev) {
      added.push(dep.handle);
    } else if (
      prev.status === next.status &&
      prev.actionRequired?.reason === next.actionRequired?.reason &&
      prev.connection?.providerConnectionId === next.connection?.providerConnectionId &&
      prev.connection?.readinessProof === next.connection?.readinessProof
    ) {
      // Status, action_required reason, and connection identity/proof are unchanged — still update lastCheckedAt and message.
      unchanged.push(dep.handle);
      records.push({ ...next });
      continue;
    } else {
      updated.push(dep.handle);
    }

    records.push(next);
  }

  // Sort deterministically by handle.
  records.sort((a, b) => a.handle.localeCompare(b.handle));

  return { records, added, updated, unchanged, removed };
}

function resolvedMcpToStatusRecord(
  resolved: ResolvedMcp,
  now: string
): McpStatusRecord {
  const record: McpStatusRecord = {
    handle: resolved.handle,
    providerId: resolved.provider,
    providerMcpId: resolved.providerMcpId,
    status: resolved.status,
    lastCheckedAt: now,
  };

  if (resolved.message) {
    record.message = resolved.message;
  }

  if (resolved.actionRequired) {
    // Only persist the reason, user-visible message, safe fields list.
    // Do NOT persist URLs unless they are explicitly safe (non-secret, non-short-lived).
    // For V1, omit URL persistence to stay conservative.
    record.actionRequired = {
      reason: resolved.actionRequired.reason,
      ...(resolved.actionRequired.message
        ? { message: resolved.actionRequired.message }
        : {}),
      ...(resolved.actionRequired.fields?.length
        ? { fields: [...resolved.actionRequired.fields] }
        : {}),
    };
  }

  if (resolved.connection) {
    // Only persist non-secret connection metadata.
    // mcpUrl is intentionally omitted: Smithery bundleUrl/deploymentUrl may embed
    // short-lived auth tokens. transport (e.g. "http", "streamable-http") is safe.
    record.connection = {
      ...(resolved.connection.localConnectionIdentity
        ? { localConnectionIdentity: resolved.connection.localConnectionIdentity }
        : {}),
      ...(resolved.connection.providerConnectionId
        ? { providerConnectionId: resolved.connection.providerConnectionId }
        : {}),
      ...(resolved.connection.namespace
        ? { namespace: resolved.connection.namespace }
        : {}),
      ...(resolved.connection.transport
        ? { transport: resolved.connection.transport }
        : {}),
      ...(resolved.status === "ready" && resolved.connection.readiness === "connected"
        ? { readinessProof: "connected", readinessCheckedAt: now }
        : {}),
    };
  }

  if (resolved.discovered) {
    // Store discovery summary (counts) rather than full tool lists for now.
    // Full projection is out of scope for this issue.
    record.discovered = {
      ...(resolved.discovered.name ? { name: resolved.discovered.name } : {}),
      ...(resolved.discovered.tools?.length !== undefined
        ? { toolCount: resolved.discovered.tools?.length ?? 0 }
        : {}),
      ...(resolved.discovered.resources?.length !== undefined
        ? { resourceCount: resolved.discovered.resources?.length ?? 0 }
        : {}),
      ...(resolved.discovered.prompts?.length !== undefined
        ? { promptCount: resolved.discovered.prompts?.length ?? 0 }
        : {}),
    };
  }

  return record;
}
