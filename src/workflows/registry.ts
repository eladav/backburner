import type { AgentConfig } from "../config/types.js";
import type { AgentStrategyRole } from "../agents/types.js";
import type {
  TaskExecutionPermission,
  TaskHandoffPolicy,
  TaskKind,
  TaskSourceKind
} from "../tasks/types.js";

export interface WorkflowTaskDefinition {
  kind: TaskKind;
  role: AgentStrategyRole;
  modelClass: AgentConfig["modelClass"];
  executionPermission: TaskExecutionPermission;
  handoffPolicy: TaskHandoffPolicy;
  sourceKinds: TaskSourceKind[];
  /**
   * Capability names (from management/capabilities.json) that must be valid
   * for this task kind to dispatch. If any listed capability is blocked with
   * reason `mcp_action_required`, the task is held pending and a workstream
   * blocker is recorded.
   *
   * Optional capabilities that may be unavailable should NOT appear here.
   * Absent or empty means no required capabilities.
   */
  requiredCapabilityNames?: readonly string[] | undefined;
}

export interface ResolvedTaskExecutionPolicy {
  executionPermission: TaskExecutionPermission;
  handoffPolicy: TaskHandoffPolicy;
}

const READ_ONLY_HANDOFF_POLICY = {
  expectsPushableHandoff: false,
  orchestratorOwnsPush: true,
  remotePublishOwner: "orchestrator"
} satisfies TaskHandoffPolicy;

const WORKSPACE_WRITE_HANDOFF_POLICY = {
  expectsPushableHandoff: true,
  orchestratorOwnsPush: true,
  remotePublishOwner: "orchestrator"
} satisfies TaskHandoffPolicy;

const WORKFLOW_TASK_DEFINITIONS: readonly WorkflowTaskDefinition[] = [
  {
    kind: "product_discovery",
    role: "product",
    modelClass: "strong",
    executionPermission: "read-only",
    handoffPolicy: READ_ONLY_HANDOFF_POLICY,
    sourceKinds: ["issue"]
  },
  {
    kind: "write_product_spec",
    role: "product",
    modelClass: "strong",
    executionPermission: "workspace-write",
    handoffPolicy: WORKSPACE_WRITE_HANDOFF_POLICY,
    sourceKinds: ["issue"]
  },
  {
    kind: "respond_issue_comment",
    role: "discussion",
    modelClass: "strong",
    executionPermission: "read-only",
    handoffPolicy: READ_ONLY_HANDOFF_POLICY,
    sourceKinds: ["comment"]
  },
  {
    kind: "review_pr",
    role: "review",
    modelClass: "strong",
    executionPermission: "read-only",
    handoffPolicy: READ_ONLY_HANDOFF_POLICY,
    sourceKinds: ["pull_request"]
  },
  {
    kind: "fix_review_finding",
    role: "implementation",
    modelClass: "cheap",
    executionPermission: "workspace-write",
    handoffPolicy: WORKSPACE_WRITE_HANDOFF_POLICY,
    sourceKinds: ["pull_request"]
  },
  {
    kind: "respond_pr_comment",
    role: "discussion",
    modelClass: "cheap",
    executionPermission: "workspace-write",
    handoffPolicy: WORKSPACE_WRITE_HANDOFF_POLICY,
    sourceKinds: ["comment"]
  },
  {
    kind: "write_plan",
    role: "planning",
    modelClass: "strong",
    executionPermission: "workspace-write",
    handoffPolicy: WORKSPACE_WRITE_HANDOFF_POLICY,
    sourceKinds: ["issue"]
  },
  {
    kind: "implement_plan",
    role: "implementation",
    modelClass: "cheap",
    executionPermission: "workspace-write",
    handoffPolicy: WORKSPACE_WRITE_HANDOFF_POLICY,
    sourceKinds: ["pull_request"]
  },
  {
    kind: "plan_breakdown",
    role: "implementation_manager",
    modelClass: "strong",
    executionPermission: "read-only",
    handoffPolicy: READ_ONLY_HANDOFF_POLICY,
    sourceKinds: ["issue", "pull_request"]
  },
  {
    kind: "wave_plan_assessment",
    role: "planning",
    modelClass: "strong",
    executionPermission: "read-only",
    handoffPolicy: READ_ONLY_HANDOFF_POLICY,
    sourceKinds: ["pull_request"]
  },
  {
    kind: "wave_plan_replanning",
    role: "implementation_manager",
    modelClass: "strong",
    executionPermission: "workspace-write",
    handoffPolicy: WORKSPACE_WRITE_HANDOFF_POLICY,
    sourceKinds: ["pull_request"]
  },
  {
    kind: "sync_parent_branch_preflight",
    role: "implementation_manager",
    modelClass: "strong",
    executionPermission: "read-only",
    handoffPolicy: READ_ONLY_HANDOFF_POLICY,
    sourceKinds: ["issue"]
  },
  {
    kind: "sync_parent_branch",
    role: "implementation_manager",
    modelClass: "strong",
    executionPermission: "workspace-write",
    handoffPolicy: WORKSPACE_WRITE_HANDOFF_POLICY,
    sourceKinds: ["pull_request"]
  },
  {
    kind: "prepare_pr_for_merge",
    role: "implementation_manager",
    modelClass: "strong",
    executionPermission: "workspace-write",
    handoffPolicy: WORKSPACE_WRITE_HANDOFF_POLICY,
    sourceKinds: ["pull_request"]
  },
  {
    kind: "extract_retrospective_problems",
    role: "retrospective",
    modelClass: "strong",
    executionPermission: "read-only",
    handoffPolicy: READ_ONLY_HANDOFF_POLICY,
    sourceKinds: ["retrospective_candidate"]
  },
  {
    kind: "investigate_learning_opportunity",
    role: "retrospective",
    modelClass: "strong",
    executionPermission: "read-only",
    handoffPolicy: READ_ONLY_HANDOFF_POLICY,
    sourceKinds: ["retrospective_problem"]
  },
  {
    kind: "draft_management_learning_proposal",
    role: "retrospective",
    modelClass: "strong",
    executionPermission: "read-only",
    handoffPolicy: READ_ONLY_HANDOFF_POLICY,
    sourceKinds: ["learning_opportunity"]
  }
];

export class WorkflowRegistry {
  private readonly definitions: Map<TaskKind, WorkflowTaskDefinition>;

  constructor(definitions: readonly WorkflowTaskDefinition[] = WORKFLOW_TASK_DEFINITIONS) {
    this.definitions = new Map(definitions.map((def) => [def.kind, def]));
  }

  public getDefinition(kind: TaskKind): WorkflowTaskDefinition {
    const definition = this.definitions.get(kind);

    if (!definition) {
      throw new Error(`No workflow task definition registered for task kind "${kind}"`);
    }

    return definition;
  }

  public resolveTaskExecutionPolicy(kind: TaskKind): ResolvedTaskExecutionPolicy {
    const definition = this.getDefinition(kind);
    return {
      executionPermission: definition.executionPermission,
      handoffPolicy: definition.handoffPolicy
    };
  }

  public get definitionsList(): readonly WorkflowTaskDefinition[] {
    return Array.from(this.definitions.values());
  }
}

export const workflowRegistry = new WorkflowRegistry();

export function getWorkflowTaskDefinition(kind: TaskKind): WorkflowTaskDefinition {
  return workflowRegistry.getDefinition(kind);
}

/**
 * Returns the list of capability names required by the given task kind.
 * Returns an empty array when the kind has no required capabilities.
 */
export function getRequiredCapabilityNames(kind: TaskKind): readonly string[] {
  return workflowRegistry.getDefinition(kind).requiredCapabilityNames ?? [];
}
