import type {
  ControllerGrants,
  McpDependency,
  NormalizedCapabilities,
  SensorObserves,
} from "../config/types.js";
import type { McpStatusRecord } from "../state/types.js";
import { validateCapabilities } from "./validator.js";
import type {
  AgentVisibleCapabilities,
  AgentVisibleControllerCapability,
  AgentVisibleSensorCapability,
  BlockedCapability,
  CapabilityKind,
} from "./types.js";

export const SENSOR_TOOL_MAP: Record<SensorObserves, readonly string[]> = {
  "issues-and-prs": ["get_issue", "get_issue_comments", "get_pr", "get_pr_comments"],
  "package-docs": ["resolve-library-id", "get-library-docs", "query-docs"],
  "repository-context": ["search_code"],
};

export const CONTROLLER_TOOL_MAP: Record<ControllerGrants, readonly string[]> = {
  "comment-on-prs": ["post_issue_comment"],
  "comment-on-issues": ["post_issue_comment"],
  "open-issues": [],
  "edit-issue-labels": [],
};

export interface CapabilityProjectionInput {
  capabilities: NormalizedCapabilities;
  declaredMcps: McpDependency[];
  mcpStatuses: McpStatusRecord[];
  registeredPublicBrokerToolNames: readonly string[];
  providerRunAllowList: readonly string[];
  taskKind?: string;
  skippedCapabilityNames?: ReadonlySet<string> | undefined;
}

export function projectCapabilities(
  input: CapabilityProjectionInput
): AgentVisibleCapabilities {
  void input.taskKind;

  const validation = validateCapabilities(
    input.capabilities,
    input.declaredMcps,
    input.mcpStatuses
  );

  const sensorsByName = new Map(
    input.capabilities.sensors.map((sensor) => [sensor.name, sensor] as const)
  );
  const controllersByName = new Map(
    input.capabilities.controllers.map((controller) => [controller.name, controller] as const)
  );

  const registeredPublicBrokerToolNames = uniqueStrings(
    input.registeredPublicBrokerToolNames
  );
  const providerRunAllowList = uniqueStrings(input.providerRunAllowList);
  const declaredMcpHandles = new Set(input.declaredMcps.map((mcp) => mcp.handle));

  const skippedCapabilityNames = input.skippedCapabilityNames ?? new Set<string>();
  const blocked: BlockedCapability[] = validation.blocked.map((capability) =>
    skippedCapabilityNames.has(capability.name)
      ? skippedCapability(capability.kind, capability.name, capability.uses)
      : capability
  );
  const sensors: AgentVisibleSensorCapability[] = [];
  const controllers: AgentVisibleControllerCapability[] = [];

  for (const capability of validation.valid) {
    if (skippedCapabilityNames.has(capability.name)) {
      blocked.push(skippedCapability(capability.kind, capability.name, capability.uses));
      continue;
    }

    if (capability.kind === "sensor") {
      const sensor = sensorsByName.get(capability.name);
      if (!sensor) {
        continue;
      }

      const tools = projectToolsForCapability(
        SENSOR_TOOL_MAP[sensor.observes],
        registeredPublicBrokerToolNames,
        providerRunAllowList,
        sensor.uses,
        declaredMcpHandles
      );

      if (tools.length === 0) {
        blocked.push(
          blockedCapability(
            capability.kind,
            sensor.name,
            sensor.uses,
            toolsBlockedReason(
              SENSOR_TOOL_MAP[sensor.observes],
              registeredPublicBrokerToolNames,
              sensor.uses,
              declaredMcpHandles
            )
          )
        );
        continue;
      }

      sensors.push(buildVisibleSensor(sensor, tools));
      continue;
    }

    const controller = controllersByName.get(capability.name);
    if (!controller) {
      continue;
    }

    const mappedTools = capabilityToolsForController(controller.grants);
    const tools = projectToolsForCapability(
      mappedTools,
      registeredPublicBrokerToolNames,
      providerRunAllowList,
      controller.uses,
      declaredMcpHandles
    );

    if (tools.length === 0) {
      blocked.push(
        blockedCapability(
          capability.kind,
          controller.name,
          controller.uses,
          toolsBlockedReason(mappedTools, registeredPublicBrokerToolNames, controller.uses, declaredMcpHandles)
        )
      );
      continue;
    }

    controllers.push(buildVisibleController(controller, tools));
  }

  return { sensors, controllers, blocked };
}

export function applySkippedCapabilityProjection(
  capabilities: AgentVisibleCapabilities,
  skippedCapabilityNames: ReadonlySet<string>
): AgentVisibleCapabilities {
  if (skippedCapabilityNames.size === 0) {
    return capabilities;
  }

  const skippedFromSensors = capabilities.sensors
    .filter((sensor) => skippedCapabilityNames.has(sensor.name))
    .map((sensor) => skippedCapability("sensor", sensor.name, sensor.uses));
  const skippedFromControllers = capabilities.controllers
    .filter((controller) => skippedCapabilityNames.has(controller.name))
    .map((controller) => skippedCapability("controller", controller.name, controller.uses));
  const blocked = capabilities.blocked.map((capability) =>
    skippedCapabilityNames.has(capability.name)
      ? skippedCapability(capability.kind, capability.name, capability.uses)
      : capability
  );

  const blockedNames = new Set(blocked.map((capability) => capability.name));
  for (const capability of [...skippedFromSensors, ...skippedFromControllers]) {
    if (!blockedNames.has(capability.name)) {
      blocked.push(capability);
      blockedNames.add(capability.name);
    }
  }

  return {
    sensors: capabilities.sensors.filter((sensor) => !skippedCapabilityNames.has(sensor.name)),
    controllers: capabilities.controllers.filter((controller) => !skippedCapabilityNames.has(controller.name)),
    blocked
  };
}

function buildVisibleSensor(
  sensor: NormalizedCapabilities["sensors"][number],
  tools: string[]
): AgentVisibleSensorCapability {
  return {
    name: sensor.name,
    uses: sensor.uses,
    observes: sensor.observes,
    ...(sensor.cadence !== undefined ? { cadence: sensor.cadence } : {}),
    ...(sensor.scope !== undefined ? { scope: sensor.scope } : {}),
    tools,
  };
}

function buildVisibleController(
  controller: NormalizedCapabilities["controllers"][number],
  tools: string[]
): AgentVisibleControllerCapability {
  return {
    name: controller.name,
    uses: controller.uses,
    grants: [...controller.grants],
    approval: controller.approval,
    tools,
  };
}

function projectToolsForCapability(
  mappedTools: readonly string[],
  registeredPublicBrokerToolNames: readonly string[],
  providerRunAllowList: readonly string[],
  capabilityUses: string,
  declaredMcpHandles: ReadonlySet<string>
): string[] {
  const registeredMatches = registeredPublicBrokerToolNames.filter((publicToolName) =>
    mappedTools.some((mappedTool) =>
      publicToolMatchesMappedCapabilityTool(publicToolName, mappedTool, capabilityUses, declaredMcpHandles)
    )
  );

  if (registeredMatches.length === 0) {
    return [];
  }

  return registeredMatches.filter((publicToolName) =>
    providerRunAllowList.some((allowedToolName) => providerToolAllowsPublicTool(publicToolName, allowedToolName))
  );
}

function toolsBlockedReason(
  mappedTools: readonly string[],
  registeredPublicBrokerToolNames: readonly string[],
  capabilityUses: string,
  declaredMcpHandles: ReadonlySet<string>
): "capability_tools_unavailable" | "capability_tools_not_allowed" {
  const registeredMatches = registeredPublicBrokerToolNames.filter((publicToolName) =>
    mappedTools.some((mappedTool) =>
      publicToolMatchesMappedCapabilityTool(publicToolName, mappedTool, capabilityUses, declaredMcpHandles)
    )
  );

  return registeredMatches.length === 0
    ? "capability_tools_unavailable"
    : "capability_tools_not_allowed";
}

function capabilityToolsForController(grants: readonly string[]): readonly string[] {
  const tools = grants.flatMap(
    (grant) => CONTROLLER_TOOL_MAP[grant as keyof typeof CONTROLLER_TOOL_MAP] ?? []
  );
  return uniqueStrings(tools);
}

function blockedCapability(
  kind: CapabilityKind,
  name: string,
  uses: string,
  reason: "capability_tools_unavailable" | "capability_tools_not_allowed"
): BlockedCapability {
  return {
    name,
    kind,
    uses,
    reason,
    message:
      reason === "capability_tools_unavailable"
        ? "No registered broker tool matches the capability's mapped tool set."
        : "Mapped capability tools are not in the active provider/run allow-list.",
  };
}

function skippedCapability(
  kind: CapabilityKind,
  name: string,
  uses: string
): BlockedCapability {
  return {
    kind,
    name,
    uses,
    reason: "capability_skipped_by_user",
    message: "User explicitly skipped this MCP-backed capability for the current task."
  };
}

function publicToolNameMatches(publicToolName: string, candidateToolName: string): boolean {
  if (candidateToolName === "*") {
    return true;
  }
  if (candidateToolName.endsWith(".*")) {
    return publicToolName.startsWith(candidateToolName.slice(0, -1));
  }
  return (
    publicToolName === candidateToolName ||
    publicToolName.endsWith(`.${candidateToolName}`) ||
    candidateToolName.endsWith(`.${publicToolName}`)
  );
}

function publicToolMatchesMappedCapabilityTool(
  publicToolName: string,
  mappedToolName: string,
  capabilityUses: string,
  declaredMcpHandles: ReadonlySet<string>
): boolean {
  const parsed = splitPublicToolName(publicToolName);
  if (parsed && declaredMcpHandles.has(parsed.namespace)) {
    return parsed.namespace === capabilityUses && publicToolNameMatches(parsed.localName, mappedToolName);
  }
  return publicToolNameMatches(publicToolName, mappedToolName);
}

function splitPublicToolName(publicToolName: string): { namespace: string; localName: string } | undefined {
  const dotIndex = publicToolName.indexOf(".");
  if (dotIndex <= 0 || dotIndex === publicToolName.length - 1) {
    return undefined;
  }
  return {
    namespace: publicToolName.slice(0, dotIndex),
    localName: publicToolName.slice(dotIndex + 1)
  };
}

function providerToolAllowsPublicTool(publicToolName: string, allowedToolName: string): boolean {
  if (publicToolName.includes(".")) {
    return allowedToolName === publicToolName;
  }
  return publicToolNameMatches(publicToolName, allowedToolName);
}

export function deriveProjectedCapabilityToolNames(capabilities: AgentVisibleCapabilities): string[] {
  return uniqueStrings([
    ...capabilities.sensors.flatMap((sensor) => sensor.tools),
    ...capabilities.controllers.flatMap((controller) => controller.tools),
  ]);
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}
