export type {
  CapabilityBlockedReason,
  CapabilityKind,
  ValidCapability,
  BlockedCapability,
  CapabilityValidationResult,
  AgentVisibleSensorCapability,
  AgentVisibleControllerCapability,
  AgentVisibleCapabilities,
} from "./types.js";

export { validateCapabilities } from "./validator.js";
export {
  applySkippedCapabilityProjection,
  deriveProjectedCapabilityToolNames,
  projectCapabilities
} from "./projection.js";
export type { CapabilityProjectionInput } from "./projection.js";
