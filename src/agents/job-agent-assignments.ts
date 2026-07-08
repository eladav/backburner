import { randomUUID } from "node:crypto";
import type { AgentConfig, AgentProvider } from "../config/types.js";
import type { AgentVisibleCapabilities } from "../capabilities/types.js";
import type { TaskRecord, JobAgentAssignmentRecord, ProviderLimitRecord } from "../state/types.js";
import { workflowRegistry } from "../workflows/registry.js";
import { roleForTask, selectAgentForTask } from "./selection.js";
import type { AgentStrategyRole } from "./types.js";

export type JobAgentAssignmentResolution =
  | {
      mode: "pinned";
      configuredAgent: AgentConfig;
      assignment: JobAgentAssignmentRecord;
      initialized: boolean;
      assignments: JobAgentAssignmentRecord[];
    }
  | {
      mode: "unscoped_fallback";
      configuredAgent: AgentConfig;
      assignment?: undefined;
      initialized: false;
      assignments: JobAgentAssignmentRecord[];
    };

export function getJobKey(role: AgentStrategyRole, modelClass: "strong" | "cheap"): `${AgentStrategyRole}-${"strong" | "cheap"}` {
  return `${role}-${modelClass}`;
}

export function getJobAgentAssignmentId(input: {
  repoKey: string;
  workstreamId: string;
  jobKey: string;
  uniqueSuffix?: string;
}): string {
  const base = `job-assignment:${input.repoKey.replaceAll("/", "~")}:${input.workstreamId}:${input.jobKey}`;
  return input.uniqueSuffix ? `${base}:${input.uniqueSuffix}` : base;
}

export function resolveJobAgentAssignment(input: {
  task: TaskRecord;
  agents: AgentConfig[];
  existingAssignments: JobAgentAssignmentRecord[];
  providerLimits?: ProviderLimitRecord[];
  replacementForProvider?: AgentProvider | undefined;
  providerBrokerToolAllowLists?: ReadonlyMap<string, readonly string[]> | undefined;
  capabilitiesByProvider?: ReadonlyMap<string, AgentVisibleCapabilities> | undefined;
  now: string;
}): JobAgentAssignmentResolution {
  const providerLimits = input.providerLimits ?? [];
  const definition = workflowRegistry.getDefinition(input.task.kind);
  const role = roleForTask(input.task);
  const modelClass = definition.modelClass;
  const jobKey = getJobKey(role, modelClass);

  if (!input.task.workstreamId) {
    const configuredAgent = selectAgentForTask(input.task, input.agents, providerLimits, {
      ...(input.replacementForProvider ? { replacementForProvider: input.replacementForProvider } : {}),
      ...(input.providerBrokerToolAllowLists ? { providerBrokerToolAllowLists: input.providerBrokerToolAllowLists } : {}),
      ...(input.capabilitiesByProvider ? { capabilitiesByProvider: input.capabilitiesByProvider } : {})
    });
    return {
      mode: "unscoped_fallback",
      configuredAgent,
      initialized: false,
      assignments: input.existingAssignments
    };
  }

  const existingAssignment = input.existingAssignments.find(
    (a) =>
      a.repoKey === input.task.repoSlug &&
      a.workstreamId === input.task.workstreamId &&
      a.role === role &&
      a.modelClass === modelClass &&
      a.jobKey === jobKey &&
      a.status === "active"
  );

  if (existingAssignment) {
    const agent = input.agents.find((a) => a.id === existingAssignment.configuredAgentId);
    let staleReason = getPinnedAssignmentStaleReason(existingAssignment, agent, role, modelClass);

    if (!staleReason && agent) {
      const providerLimit = providerLimits.find(
        (limit) => limit.provider === agent.provider && limit.status === "limited"
      );
      if (providerLimit) {
        staleReason = "Pinned provider limit exceeded";
      }
    }

    if (staleReason) {
      const staleAssignments = input.existingAssignments.map((assignment) =>
        assignment.id === existingAssignment.id
          ? {
              ...assignment,
              status: "stale" as const,
              updatedAt: input.now,
              notes: staleReason
            }
          : assignment
      );
      return createNewAssignment({
        task: input.task,
        agents: input.agents,
        existingAssignments: staleAssignments,
        providerLimits,
        replacementForProvider: existingAssignment.provider,
        ...(input.providerBrokerToolAllowLists ? { providerBrokerToolAllowLists: input.providerBrokerToolAllowLists } : {}),
        ...(input.capabilitiesByProvider ? { capabilitiesByProvider: input.capabilitiesByProvider } : {}),
        now: input.now,
        role,
        modelClass,
        jobKey
      });
    }

    return {
      mode: "pinned",
      configuredAgent: agent!,
      assignment: existingAssignment,
      initialized: false,
      assignments: input.existingAssignments
    };
  }

  return createNewAssignment({
    task: input.task,
    agents: input.agents,
    existingAssignments: input.existingAssignments,
    providerLimits,
    ...(input.replacementForProvider ? { replacementForProvider: input.replacementForProvider } : {}),
    ...(input.providerBrokerToolAllowLists ? { providerBrokerToolAllowLists: input.providerBrokerToolAllowLists } : {}),
    ...(input.capabilitiesByProvider ? { capabilitiesByProvider: input.capabilitiesByProvider } : {}),
    now: input.now,
    role,
    modelClass,
    jobKey
  });
}

function createNewAssignment(input: {
  task: TaskRecord;
  agents: AgentConfig[];
  existingAssignments: JobAgentAssignmentRecord[];
  providerLimits?: ProviderLimitRecord[];
  replacementForProvider?: AgentProvider | undefined;
  providerBrokerToolAllowLists?: ReadonlyMap<string, readonly string[]> | undefined;
  capabilitiesByProvider?: ReadonlyMap<string, AgentVisibleCapabilities> | undefined;
  now: string;
  role: AgentStrategyRole;
  modelClass: "strong" | "cheap";
  jobKey: `${AgentStrategyRole}-${"strong" | "cheap"}`;
}): JobAgentAssignmentResolution {
  const configuredAgent = selectAgentForTask(input.task, input.agents, input.providerLimits, {
    ...(input.replacementForProvider ? { replacementForProvider: input.replacementForProvider } : {}),
    ...(input.providerBrokerToolAllowLists ? { providerBrokerToolAllowLists: input.providerBrokerToolAllowLists } : {}),
    ...(input.capabilitiesByProvider ? { capabilitiesByProvider: input.capabilitiesByProvider } : {})
  });
  if (!input.task.workstreamId) {
    throw new Error(`Task ${input.task.id} has no workstreamId; scoped job assignment cannot be created.`);
  }
  const newAssignment: JobAgentAssignmentRecord = {
    id: getJobAgentAssignmentId({
      repoKey: input.task.repoSlug,
      workstreamId: input.task.workstreamId,
      jobKey: input.jobKey,
      uniqueSuffix: randomUUID().slice(0, 8)
    }),
    repoKey: input.task.repoSlug,
    workstreamId: input.task.workstreamId,
    role: input.role,
    modelClass: input.modelClass,
    jobKey: input.jobKey,
    configuredAgentId: configuredAgent.id,
    provider: configuredAgent.provider,
    status: "active",
    createdAt: input.now,
    updatedAt: input.now
  };

  return {
    mode: "pinned",
    configuredAgent,
    assignment: newAssignment,
    initialized: true,
    assignments: [...input.existingAssignments, newAssignment].sort(compareJobAgentAssignments)
  };
}

function getPinnedAssignmentStaleReason(
  assignment: JobAgentAssignmentRecord,
  agent: AgentConfig | undefined,
  role: AgentStrategyRole,
  modelClass: "strong" | "cheap"
): string | undefined {
  if (!agent) {
    return `Pinned agent "${assignment.configuredAgentId}" no longer exists in agents.json.`;
  }

  if (!agent.enabled) {
    return `Pinned agent "${agent.id}" is disabled in agents.json.`;
  }

  if (agent.provider !== assignment.provider) {
    return `Pinned agent "${agent.id}" provider changed from "${assignment.provider}" to "${agent.provider}".`;
  }

  if (agent.modelClass !== modelClass) {
    return `Pinned agent "${agent.id}" modelClass changed from "${modelClass}" to "${agent.modelClass}".`;
  }

  if (!agent.roles.includes(role)) {
    return `Pinned agent "${agent.id}" no longer has required role "${role}".`;
  }

  return undefined;
}

export function recordJobAgentAssignmentExecution(input: {
  assignments: JobAgentAssignmentRecord[];
  assignmentId: string;
  taskId: string;
  executionId: string;
  startedAt: string;
  endedAt: string;
  taskStatus: "completed" | "failed";
}): JobAgentAssignmentRecord[] {
  const index = input.assignments.findIndex((a) => a.id === input.assignmentId);

  if (index === -1) {
    throw new Error(`Assignment "${input.assignmentId}" not found for execution update`);
  }

  const existing = input.assignments[index]!;
  const updated: JobAgentAssignmentRecord = {
    ...existing,
    lastTaskId: input.taskId,
    lastExecutionId: input.executionId,
    lastStartedAt: input.startedAt,
    updatedAt: input.endedAt
  };

  if (input.taskStatus === "completed") {
    updated.lastCompletedAt = input.endedAt;
  } else if (input.taskStatus === "failed") {
    updated.lastFailedAt = input.endedAt;
  }

  const nextAssignments = [...input.assignments];
  nextAssignments[index] = updated;

  return nextAssignments.sort(compareJobAgentAssignments);
}

function compareJobAgentAssignments(left: JobAgentAssignmentRecord, right: JobAgentAssignmentRecord): number {
  const repoComparison = left.repoKey.localeCompare(right.repoKey);
  if (repoComparison !== 0) {
    return repoComparison;
  }

  const workstreamComparison = left.workstreamId.localeCompare(right.workstreamId);
  if (workstreamComparison !== 0) {
    return workstreamComparison;
  }

  const jobKeyComparison = left.jobKey.localeCompare(right.jobKey);
  if (jobKeyComparison !== 0) {
    return jobKeyComparison;
  }

  return left.id.localeCompare(right.id);
}
