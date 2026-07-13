import type { McpStatusRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";

export type CapabilityBlockedReason =
  | "missing_mcp_handle"
  | "mcp_action_required"
  | "mcp_not_connection_ready"
  | "mcp_resolution_failed"
  | "mcp_error"
  | "capability_skipped_by_user"
  | "capability_tools_unavailable"
  | "capability_tools_not_allowed";

export type CapabilityKind = "sensor" | "controller";

export interface ValidCapability {
  name: string;
  kind: CapabilityKind;
  uses: string;
  mcpStatus: "ready";
}

export interface BlockedCapability {
  name: string;
  kind: CapabilityKind;
  uses: string;
  reason: CapabilityBlockedReason;
  mcpStatus?: McpStatusRecord["status"];
  message?: string;
}

export interface RequiredCapabilityEvaluationResult {
  taskId: string;
  taskKind: TaskRecord["kind"];
  blockedRequiredCapabilities: BlockedCapability[];
}

export interface CapabilityValidationResult {
  valid: ValidCapability[];
  blocked: BlockedCapability[];
}

export interface AgentVisibleSensorCapability {
  name: string;
  uses: string;
  observes: import("../config/types.js").SensorObserves;
  cadence?: import("../config/types.js").CapabilityCadence;
  scope?: import("../config/types.js").CapabilityScope;
  tools: string[];
}

export interface AgentVisibleControllerCapability {
  name: string;
  uses: string;
  grants: import("../config/types.js").ControllerGrants[];
  approval: import("../config/types.js").CapabilityApproval;
  tools: string[];
}

export interface AgentVisibleCapabilities {
  sensors: AgentVisibleSensorCapability[];
  controllers: AgentVisibleControllerCapability[];
  blocked: BlockedCapability[];
}
