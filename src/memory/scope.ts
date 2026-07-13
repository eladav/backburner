import type { AgentConfig } from "../config/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { workflowRegistry } from "../workflows/registry.js";
import { roleForTask } from "../agents/selection.js";
import type { JobMemoryScope, ModelClass } from "./types.js";

/**
 * Resolves the memory scope for a given task and agent configuration.
 * Fails if workstreamId is missing.
 */
export function resolveJobMemoryScope(
  task: TaskRecord,
  agentConfig: AgentConfig
): JobMemoryScope {
  if (!task.workstreamId) {
    throw new Error(`Memory access requires a workstreamId for task ${task.id}`);
  }

  const definition = workflowRegistry.getDefinition(task.kind);
  const job = roleForTask(task);
  const modelClass = agentConfig.modelClass as ModelClass;

  // Assert that the selected agent's model class matches the workflow definition
  // This is a safety check from the plan.
  if (modelClass !== definition.modelClass) {
    throw new Error(
      `Model class mismatch for task ${task.id}: agent model class is ${modelClass}, but workflow definition requires ${definition.modelClass}`
    );
  }

  return {
    repoKey: task.repoSlug,
    workstreamId: task.workstreamId,
    job,
    modelClass
  };
}

/**
 * Generates the canonical bank ID for a given scope.
 */
export function getJobMemoryBankId(scope: JobMemoryScope): string {
  return `backburner:repo:${scope.repoKey}:workstream:${scope.workstreamId}:job:${scope.job}:model:${scope.modelClass}`;
}
