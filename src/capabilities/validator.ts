import type { McpDependency, NormalizedCapabilities } from "../config/types.js";
import type { McpStatusRecord } from "../state/types.js";
import type {
  CapabilityValidationResult,
  ValidCapability,
  BlockedCapability,
  CapabilityKind,
} from "./types.js";

/**
 * Validates requested capabilities against declared MCP dependencies and their current status.
 *
 * This implementation takes a normalized capabilities object as returned
 * by loadCapabilitiesConfig() or loadConfig().
 */
export function validateCapabilities(
  capabilities: NormalizedCapabilities,
  declaredMcps: McpDependency[],
  mcpStatuses: McpStatusRecord[]
): CapabilityValidationResult {
  const { sensors, controllers } = capabilities;
  const declaredHandles = new Set(declaredMcps.map((d) => d.handle));
  const statusByHandle = new Map(mcpStatuses.map((s) => [s.handle, s]));

  const valid: ValidCapability[] = [];
  const blocked: BlockedCapability[] = [];

  const processCapability = (
    name: string,
    uses: string,
    kind: CapabilityKind
  ): void => {
    if (!declaredHandles.has(uses)) {
      blocked.push({ name, kind, uses, reason: "missing_mcp_handle" });
      return;
    }

    const statusRecord = statusByHandle.get(uses);
    if (!statusRecord) {
      blocked.push({
        name,
        kind,
        uses,
        reason: "mcp_not_connection_ready",
        message: "MCP has not been checked yet — no status record available.",
      });
      return;
    }

    const message = statusRecord.actionRequired?.message ?? statusRecord.message;

    switch (statusRecord.status) {
      case "ready":
        valid.push({ name, kind, uses, mcpStatus: "ready" });
        break;
      case "action_required":
        blocked.push({
          name,
          kind,
          uses,
          reason: "mcp_action_required",
          mcpStatus: "action_required",
          ...(message ? { message } : {}),
        });
        break;
      case "resolved":
        blocked.push({
          name,
          kind,
          uses,
          reason: "mcp_not_connection_ready",
          mcpStatus: "resolved",
          ...(message ? { message } : {}),
        });
        break;
      case "resolution_failed":
        blocked.push({
          name,
          kind,
          uses,
          reason: "mcp_resolution_failed",
          mcpStatus: "resolution_failed",
          ...(message ? { message } : {}),
        });
        break;
      case "error":
        blocked.push({
          name,
          kind,
          uses,
          reason: "mcp_error",
          mcpStatus: "error",
          ...(message ? { message } : {}),
        });
        break;
      default: {
        const _exhaustive: never = statusRecord.status;
        throw new Error(`Unexpected MCP status: ${_exhaustive}`);
      }
    }
  };

  for (const sensor of sensors) {
    processCapability(sensor.name, sensor.uses, "sensor");
  }
  for (const controller of controllers) {
    processCapability(controller.name, controller.uses, "controller");
  }

  return { valid, blocked };
}
