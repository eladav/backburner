import { createHash, randomUUID } from "node:crypto";
import type { AgentConfig } from "../config/types.js";
import type {
  ProviderSessionCapability,
  ProviderSessionRecord,
  ProviderSessionScope
} from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { workflowRegistry } from "../workflows/registry.js";
import { roleForTask } from "./selection.js";

export function resolveProviderSessionScope(
  task: TaskRecord,
  agent: AgentConfig
): ProviderSessionScope {
  if (!task.workstreamId) {
    throw new Error(
      `Task ${task.id} has no workstreamId; provider session scope requires a workstream identity.`
    );
  }

  const { localRepoPath, branchName } = task.context;
  if (!localRepoPath || !branchName) {
    throw new Error(
      `Task ${task.id} is missing localRepoPath or branchName; provider session scope cannot be resolved.`
    );
  }

  const definition = workflowRegistry.getDefinition(task.kind);

  if (agent.modelClass !== definition.modelClass) {
    throw new Error(
      `Agent model class "${agent.modelClass}" does not match required model class "${definition.modelClass}" for task "${task.kind}".`
    );
  }

  return {
    repoKey: task.repoSlug,
    workstreamId: task.workstreamId,
    job: roleForTask(task),
    modelClass: agent.modelClass,
    configuredAgentId: agent.id,
    provider: agent.provider,
    localRepoPath,
    branchName
  };
}

export function getProviderSessionRecordId(scope: ProviderSessionScope): string {
  const components = [
    scope.repoKey,
    scope.workstreamId,
    scope.job,
    scope.modelClass,
    scope.provider,
    scope.configuredAgentId,
    scope.localRepoPath,
    scope.branchName
  ];

  const data = components.join("|");
  return createHash("sha256").update(data).digest("hex");
}

export type ProviderSessionDecision =
  | {
      mode: "fallback";
      reason:
        | "unsupported"
        | "unverified"
        | "native_resume_not_enabled"
        | "no_session_record"
        | "scope_mismatch";
    }
  | { mode: "native_resume_candidate"; record: ProviderSessionRecord }
  | { mode: "new_session"; providerSessionId: string; providerSessionName: string };

export function evaluateProviderSessionDecision(input: {
  capability: ProviderSessionCapability;
  requestedScope: ProviderSessionScope;
  existingRecord?: ProviderSessionRecord | undefined;
  nativeResumeEnabled: boolean;
  taskKind: string;
}): ProviderSessionDecision {
  if (input.capability === "unsupported") {
    if (input.existingRecord?.providerSessionId || input.existingRecord?.providerSessionName) {
      throw new Error("Invalid state: unsupported capability record cannot carry provider identity.");
    }
    return { mode: "fallback", reason: "unsupported" };
  }

  if (input.capability === "unverified") {
    if (input.existingRecord?.providerSessionId || input.existingRecord?.providerSessionName) {
      throw new Error("Invalid state: unverified capability record cannot carry provider identity.");
    }
    return { mode: "fallback", reason: "unverified" };
  }

  if (!input.nativeResumeEnabled) {
    return { mode: "fallback", reason: "native_resume_not_enabled" };
  }

  const getNewSessionDecision = (): ProviderSessionDecision => {
    const uuid = randomUUID();
    const displayName = `backburner:${input.requestedScope.repoKey}:${input.taskKind}:${input.requestedScope.workstreamId}`;
    return {
      mode: "new_session",
      providerSessionId: uuid,
      providerSessionName: displayName
    };
  };

  if (!input.existingRecord) {
    if (input.requestedScope.provider === "claude") {
      return getNewSessionDecision();
    }
    return { mode: "fallback", reason: "no_session_record" };
  }

  // Exact scope comparison
  const sE = input.existingRecord.scope;
  const sR = input.requestedScope;

  const match =
    sE.repoKey === sR.repoKey &&
    sE.workstreamId === sR.workstreamId &&
    sE.job === sR.job &&
    sE.modelClass === sR.modelClass &&
    sE.configuredAgentId === sR.configuredAgentId &&
    sE.provider === sR.provider &&
    sE.localRepoPath === sR.localRepoPath &&
    sE.branchName === sR.branchName;

  if (!match) {
    return { mode: "fallback", reason: "scope_mismatch" };
  }

  if (input.existingRecord.capability === "unsupported") {
    return { mode: "fallback", reason: "unsupported" };
  }

  if (input.existingRecord.capability === "unverified") {
    return { mode: "fallback", reason: "unverified" };
  }

  if (input.existingRecord.status === "closed") {
    if (input.requestedScope.provider === "claude") {
      return getNewSessionDecision();
    }
    return { mode: "fallback", reason: "no_session_record" };
  }

  if (input.existingRecord.status === "stale") {
    if (input.requestedScope.provider === "claude") {
      return getNewSessionDecision();
    }
    return { mode: "fallback", reason: "no_session_record" };
  }

  return { mode: "native_resume_candidate", record: input.existingRecord };
}
