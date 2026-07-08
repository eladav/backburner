import type { AgentConfig } from "../../config/types.js";
import type { AgentVisibleCapabilities } from "../../capabilities/types.js";
import { deriveProjectedCapabilityToolNames, projectCapabilities } from "../../capabilities/projection.js";

export function buildCapabilitiesByProvider(input: {
  capabilities: import("../../config/types.js").NormalizedCapabilities;
  mcps: import("../../config/types.js").McpDependency[];
  mcpStatuses: import("../../state/types.js").McpStatusRecord[];
  enabledAgents: AgentConfig[];
  providerBrokerToolAllowLists: ReadonlyMap<string, readonly string[]>;
  registeredPublicBrokerToolNames: readonly string[];
}): ReadonlyMap<string, AgentVisibleCapabilities> {
  const projections = new Map<string, AgentVisibleCapabilities>();

  if (input.capabilities.sensors.length === 0 && input.capabilities.controllers.length === 0) {
    return projections;
  }

  for (const agent of input.enabledAgents) {
    const providerAllowList = input.providerBrokerToolAllowLists.get(agent.provider);
    if (!providerAllowList) {
      continue;
    }

    projections.set(
      agent.provider,
      projectCapabilities({
        capabilities: input.capabilities,
        declaredMcps: input.mcps,
        mcpStatuses: input.mcpStatuses,
        registeredPublicBrokerToolNames: input.registeredPublicBrokerToolNames,
        providerRunAllowList: providerAllowList
      })
    );
  }

  return projections;
}

export function buildEffectiveProviderBrokerToolAllowLists(input: {
  declaredMcps: import("../../config/types.js").McpDependency[];
  enabledAgents: AgentConfig[];
  providerBrokerToolAllowLists: ReadonlyMap<string, readonly string[]>;
  capabilitiesByProvider: ReadonlyMap<string, AgentVisibleCapabilities>;
  registeredPublicBrokerToolNames: readonly string[];
  internalAlwaysAllowedTools: readonly string[];
}): ReadonlyMap<string, readonly string[]> {
  const projectedToolsByProvider = new Map<string, ReadonlySet<string>>();
  for (const [provider, capabilities] of input.capabilitiesByProvider.entries()) {
    projectedToolsByProvider.set(provider, new Set(deriveProjectedCapabilityToolNames(capabilities)));
  }

  const registeredTools = new Set(input.registeredPublicBrokerToolNames);
  const internalTools = new Set(input.internalAlwaysAllowedTools);
  const hostedMcpHandles = new Set(input.declaredMcps.map((mcp) => mcp.handle));
  const effective = new Map<string, readonly string[]>();

  for (const agent of input.enabledAgents) {
    if (effective.has(agent.provider)) {
      continue;
    }

    const providerAllowList = input.providerBrokerToolAllowLists.get(agent.provider) ?? [];
    const providerAllowedRegisteredTools = input.registeredPublicBrokerToolNames.filter((toolName) =>
      providerAllowListAllowsTool(providerAllowList, toolName, hostedMcpHandles)
    );
    const projectedTools = projectedToolsByProvider.get(agent.provider) ?? new Set<string>();
    const effectiveTools = new Set<string>();

    for (const toolName of input.internalAlwaysAllowedTools) {
      effectiveTools.add(toolName);
    }

    for (const toolName of providerAllowedRegisteredTools) {
      if (internalTools.has(toolName)) {
        effectiveTools.add(toolName);
        continue;
      }
      if (!isDeclaredHostedMcpTool(toolName, hostedMcpHandles)) {
        effectiveTools.add(toolName);
        continue;
      }
      if (projectedTools.has(toolName)) {
        effectiveTools.add(toolName);
      }
    }

    effective.set(
      agent.provider,
      [...effectiveTools].filter((toolName) => internalTools.has(toolName) || registeredTools.has(toolName))
    );
  }

  return effective;
}

function providerAllowListAllowsTool(
  providerAllowList: readonly string[],
  publicToolName: string,
  hostedMcpHandles: ReadonlySet<string>
): boolean {
  if (isDeclaredHostedMcpTool(publicToolName, hostedMcpHandles)) {
    return providerAllowList.includes(publicToolName);
  }

  return providerAllowList.some((allowedToolName) => {
    if (allowedToolName === publicToolName || allowedToolName === "*") {
      return true;
    }
    return allowedToolName.endsWith(".*") && publicToolName.startsWith(allowedToolName.slice(0, -1));
  });
}

function isDeclaredHostedMcpTool(publicToolName: string, hostedMcpHandles: ReadonlySet<string>): boolean {
  const dotIndex = publicToolName.indexOf(".");
  return dotIndex > 0 && hostedMcpHandles.has(publicToolName.slice(0, dotIndex));
}
