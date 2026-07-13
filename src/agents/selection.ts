import type { AgentConfig, AgentProvider } from "../config/types.js";
import type { TaskRecord } from "../tasks/types.js";
import type { AgentVisibleCapabilities } from "../capabilities/types.js";
import { getWorkflowTaskDefinition, workflowRegistry } from "../workflows/registry.js";
import type { AgentStrategyRole } from "./types.js";
import type { ProviderLimitRecord } from "../state/types.js";

export class NoProviderAvailableError extends Error {
  constructor(
    public readonly role: AgentStrategyRole,
    public readonly modelClass: "strong" | "cheap",
    public readonly limitedProviders: AgentProvider[],
    message: string
  ) {
    super(message);
    this.name = "NoProviderAvailableError";
  }
}

export interface ProviderSelectionRuntimeCompatibility {
  replacementForProvider?: AgentProvider | undefined;
  providerBrokerToolAllowLists?: ReadonlyMap<string, readonly string[]> | undefined;
  capabilitiesByProvider?: ReadonlyMap<string, AgentVisibleCapabilities> | undefined;
}

export function selectAgentForTask(
  task: TaskRecord,
  agents: AgentConfig[],
  providerLimits?: ProviderLimitRecord[],
  runtimeCompatibility?: ProviderSelectionRuntimeCompatibility
): AgentConfig {
  const definition = workflowRegistry.getDefinition(task.kind);
  const requiredRole = resolveTaskRole(task, definition.role);
  const requiredModelClass = definition.modelClass;

  const candidates = agents.filter(
    (agent) =>
      agent.enabled &&
      agent.roles.includes(requiredRole) &&
      agent.modelClass === requiredModelClass
  );

  if (candidates.length === 0) {
    throw new Error(
      `No enabled agent configured for task ${task.id} with role "${requiredRole}" and modelClass "${requiredModelClass}"`
    );
  }

  const runtimeCompatibleCandidates = candidates.filter((agent) =>
    providerRuntimeIsCompatible(agent.provider, runtimeCompatibility)
  );

  if (runtimeCompatibleCandidates.length === 0) {
    if (runtimeCompatibility?.replacementForProvider) {
      throw new NoProviderAvailableError(
        requiredRole,
        requiredModelClass,
        [runtimeCompatibility.replacementForProvider],
        `No runtime-compatible replacement provider for role "${requiredRole}" and modelClass "${requiredModelClass}" after ${runtimeCompatibility.replacementForProvider} was limited`
      );
    }

    throw new Error(
      `No runtime-compatible agent configured for task ${task.id} with role "${requiredRole}" and modelClass "${requiredModelClass}"`
    );
  }

  const limitedProviders = new Set<AgentProvider>();
  const limits = providerLimits ?? [];
  for (const limit of limits) {
    if (limit.status === "limited") {
      limitedProviders.add(limit.provider);
    }
  }

  const availableCandidates = runtimeCompatibleCandidates.filter(
    (agent) => !limitedProviders.has(agent.provider)
  );

  if (availableCandidates.length === 0) {
    const candidateProviders = Array.from(new Set(runtimeCompatibleCandidates.map((a) => a.provider)));
    throw new NoProviderAvailableError(
      requiredRole,
      requiredModelClass,
      candidateProviders,
      `No available provider for role "${requiredRole}" and modelClass "${requiredModelClass}" (all matching providers: ${candidateProviders.join(", ")} are currently limited)`
    );
  }

  const index = Math.floor(Math.random() * availableCandidates.length);
  return availableCandidates[index]!;
}

export function roleForTask(task: TaskRecord): AgentStrategyRole {
  return resolveTaskRole(task, workflowRegistry.getDefinition(task.kind).role);
}

function resolveTaskRole(task: TaskRecord, defaultRole: AgentStrategyRole): AgentStrategyRole {
  if (
    task.kind === "respond_issue_comment" &&
    (task.workflowPhase === "product_discovery" || task.workflowPhase === "product_specification")
  ) {
    return "product";
  }

  return defaultRole;
}

function providerRuntimeIsCompatible(
  candidateProvider: AgentProvider,
  compatibility: ProviderSelectionRuntimeCompatibility | undefined
): boolean {
  const sourceProvider = compatibility?.replacementForProvider;
  if (!sourceProvider || candidateProvider === sourceProvider) {
    return true;
  }

  if (
    !providerAllowListCoversRequiredTools(
      compatibility.providerBrokerToolAllowLists,
      sourceProvider,
      candidateProvider
    )
  ) {
    return false;
  }

  return providerCapabilitiesCoverRequiredTools(
    compatibility.capabilitiesByProvider,
    sourceProvider,
    candidateProvider
  );
}

function providerAllowListCoversRequiredTools(
  allowLists: ReadonlyMap<string, readonly string[]> | undefined,
  sourceProvider: AgentProvider,
  candidateProvider: AgentProvider
): boolean {
  if (!allowLists) {
    return true;
  }

  const requiredTools = allowLists.get(sourceProvider);
  if (!requiredTools || requiredTools.length === 0) {
    return true;
  }

  const candidateTools = allowLists.get(candidateProvider);
  if (!candidateTools) {
    return false;
  }

  return requiredTools.every((requiredTool) => allowListAllowsRequiredTool(candidateTools, requiredTool));
}

function allowListAllowsRequiredTool(candidateTools: readonly string[], requiredTool: string): boolean {
  if (candidateTools.includes("*") || candidateTools.includes(requiredTool)) {
    return true;
  }

  if (requiredTool.endsWith(".*")) {
    return candidateTools.includes(requiredTool);
  }

  return candidateTools.some((candidateTool) =>
    candidateTool.endsWith(".*") && requiredTool.startsWith(candidateTool.slice(0, -1))
  );
}

function providerCapabilitiesCoverRequiredTools(
  capabilitiesByProvider: ReadonlyMap<string, AgentVisibleCapabilities> | undefined,
  sourceProvider: AgentProvider,
  candidateProvider: AgentProvider
): boolean {
  if (!capabilitiesByProvider) {
    return true;
  }

  const sourceCapabilities = capabilitiesByProvider.get(sourceProvider);
  if (!sourceCapabilities) {
    return true;
  }

  const requiredTools = visibleCapabilityTools(sourceCapabilities);
  if (requiredTools.size === 0) {
    return true;
  }

  const candidateCapabilities = capabilitiesByProvider.get(candidateProvider);
  if (!candidateCapabilities) {
    return false;
  }

  const candidateTools = visibleCapabilityTools(candidateCapabilities);
  return [...requiredTools].every((tool) => candidateTools.has(tool));
}

function visibleCapabilityTools(capabilities: AgentVisibleCapabilities): Set<string> {
  return new Set([
    ...capabilities.sensors.flatMap((sensor) => sensor.tools),
    ...capabilities.controllers.flatMap((controller) => controller.tools)
  ]);
}
