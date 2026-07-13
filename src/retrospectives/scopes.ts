import * as path from "node:path";
import type { AgentProvider } from "../config/types.js";
import type { AgentStrategyRole } from "../agents/types.js";
import type { TaskKind } from "../tasks/types.js";

export interface GlobalScope {
  kind: "global";
}

export interface ProviderScope {
  kind: "provider";
  provider: AgentProvider;
}

export interface RoleScope {
  kind: "role";
  role: AgentStrategyRole;
}

export interface TaskKindScope {
  kind: "task_kind";
  taskKind: TaskKind;
}

export interface RepoScope {
  kind: "repo";
  repoId: string;
}

export interface RepoProviderScope {
  kind: "repo_provider";
  repoId: string;
  provider: AgentProvider;
}

export interface RepoRoleScope {
  kind: "repo_role";
  repoId: string;
  role: AgentStrategyRole;
}

export interface RepoTaskKindScope {
  kind: "repo_task_kind";
  repoId: string;
  taskKind: TaskKind;
}

export type LearningScope =
  | GlobalScope
  | ProviderScope
  | RoleScope
  | TaskKindScope
  | RepoScope
  | RepoProviderScope
  | RepoRoleScope
  | RepoTaskKindScope;

export type ScopeKind = LearningScope["kind"];

export type RetrospectiveSemanticScopeKind =
  | "workflow"
  | "configuration"
  | "guidance"
  | "orchestration";

export interface RetrospectiveSemanticScopeRecord {
  kind: RetrospectiveSemanticScopeKind;
  raw: unknown;
  reason?: string | undefined;
}

export interface NormalizeRetrospectiveScopesInput {
  rawSuggestedScopes: unknown[];
  affectedRepoIds: string[];
  roles: AgentStrategyRole[];
  taskKinds: TaskKind[];
  providers: AgentProvider[];
}

export interface NormalizeRetrospectiveScopesResult {
  semanticScopes: RetrospectiveSemanticScopeRecord[];
  candidateLearningScopes: LearningScope[];
}

export function normalizeRetrospectiveScopes(
  input: NormalizeRetrospectiveScopesInput
): NormalizeRetrospectiveScopesResult {
  const { rawSuggestedScopes, affectedRepoIds, roles, taskKinds, providers } = input;
  const semanticScopes: RetrospectiveSemanticScopeRecord[] = [];
  const candidateLearningScopes: LearningScope[] = [];

  const seenKeys = new Set<string>();
  const addCandidate = (scope: LearningScope) => {
    const key = JSON.stringify(scope);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      candidateLearningScopes.push(scope);
    }
  };

  const semanticKinds: RetrospectiveSemanticScopeKind[] = [
    "workflow",
    "configuration",
    "guidance",
    "orchestration",
  ];

  for (const raw of rawSuggestedScopes) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      addCandidate(raw as unknown as LearningScope);
      continue;
    }

    const obj = raw as Record<string, unknown>;
    const kind = obj.kind;

    if (typeof kind !== "string") {
      continue;
    }

    // Is it already a valid learning scope kind?
    if (SCOPE_PRECEDENCE_ORDER.includes(kind as ScopeKind)) {
      addCandidate(raw as unknown as LearningScope);
      continue;
    }

    // Is it a known semantic kind?
    if (semanticKinds.includes(kind as RetrospectiveSemanticScopeKind)) {
      const semanticKind = kind as RetrospectiveSemanticScopeKind;
      semanticScopes.push({
        kind: semanticKind,
        raw,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
      });

      // Expand candidates
      switch (semanticKind) {
        case "workflow":
          for (const repoId of affectedRepoIds) {
            for (const taskKind of taskKinds) {
              addCandidate({ kind: "repo_task_kind", repoId, taskKind });
            }
          }
          for (const taskKind of taskKinds) {
            addCandidate({ kind: "task_kind", taskKind });
          }
          for (const repoId of affectedRepoIds) {
            addCandidate({ kind: "repo", repoId });
          }
          addCandidate({ kind: "global" });
          break;

        case "configuration":
          for (const repoId of affectedRepoIds) {
            for (const provider of providers) {
              addCandidate({ kind: "repo_provider", repoId, provider });
            }
          }
          for (const provider of providers) {
            addCandidate({ kind: "provider", provider });
          }
          for (const repoId of affectedRepoIds) {
            addCandidate({ kind: "repo", repoId });
          }
          addCandidate({ kind: "global" });
          break;

        case "guidance":
          for (const repoId of affectedRepoIds) {
            for (const role of roles) {
              addCandidate({ kind: "repo_role", repoId, role });
            }
          }
          for (const repoId of affectedRepoIds) {
            for (const taskKind of taskKinds) {
              addCandidate({ kind: "repo_task_kind", repoId, taskKind });
            }
          }
          for (const role of roles) {
            addCandidate({ kind: "role", role });
          }
          for (const taskKind of taskKinds) {
            addCandidate({ kind: "task_kind", taskKind });
          }
          addCandidate({ kind: "global" });
          break;

        case "orchestration":
          for (const repoId of affectedRepoIds) {
            for (const taskKind of taskKinds) {
              addCandidate({ kind: "repo_task_kind", repoId, taskKind });
            }
          }
          for (const repoId of affectedRepoIds) {
            for (const role of roles) {
              addCandidate({ kind: "repo_role", repoId, role });
            }
          }
          for (const repoId of affectedRepoIds) {
            addCandidate({ kind: "repo", repoId });
          }
          addCandidate({ kind: "global" });
          break;
      }
    } else {
      // Not a known semantic kind, pass it through as a candidate so validation can report it
      addCandidate(raw as unknown as LearningScope);
    }
  }

  return {
    semanticScopes,
    candidateLearningScopes,
  };
}

export const SCOPE_PRECEDENCE_ORDER: readonly ScopeKind[] = [
  "repo_task_kind",
  "repo_role",
  "repo_provider",
  "repo",
  "task_kind",
  "role",
  "provider",
  "global",
];

export interface ScopeValidationConfig {
  repoIds: readonly string[];
  providers: readonly AgentProvider[];
  roles: readonly AgentStrategyRole[];
  taskKinds: readonly TaskKind[];
}

export type ScopeValidationResult =
  | { ok: true; scope: LearningScope }
  | { ok: false; error: string };

export function validateLearningScope(
  input: unknown,
  config: ScopeValidationConfig
): ScopeValidationResult {
  // Guard: must be a plain non-null object
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Scope input must be a plain object" };
  }

  const obj = input as Record<string, unknown>;

  // Guard: kind must be present and must be a known ScopeKind string
  const { kind, ...rest } = obj;
  if (typeof kind !== "string") {
    return { ok: false, error: "Scope input must have a string \"kind\" field" };
  }
  if (!SCOPE_PRECEDENCE_ORDER.includes(kind as ScopeKind)) {
    return { ok: false, error: `Unknown scope kind: "${kind}"` };
  }

  // Dispatch to per-kind validation
  switch (kind as ScopeKind) {
    case "global": {
      if (Object.keys(rest).length > 0) {
        return { ok: false, error: `Scope "global" must have no keys besides "kind", got extra: ${Object.keys(rest).join(", ")}` };
      }
      return { ok: true, scope: { kind: "global" } };
    }
    case "provider": {
      const { provider, ...extra } = rest;
      if (Object.keys(extra).length > 0) {
        return { ok: false, error: `Scope "provider" has extra keys: ${Object.keys(extra).join(", ")}` };
      }
      if (typeof provider !== "string" || !config.providers.includes(provider as AgentProvider)) {
        return { ok: false, error: `Unknown provider: "${provider}"` };
      }
      return { ok: true, scope: { kind: "provider", provider: provider as AgentProvider } };
    }
    case "role": {
      const { role, ...extra } = rest;
      if (Object.keys(extra).length > 0) {
        return { ok: false, error: `Scope "role" has extra keys: ${Object.keys(extra).join(", ")}` };
      }
      if (typeof role !== "string" || !config.roles.includes(role as AgentStrategyRole)) {
        return { ok: false, error: `Unknown role: "${role}"` };
      }
      return { ok: true, scope: { kind: "role", role: role as AgentStrategyRole } };
    }
    case "task_kind": {
      const { taskKind, ...extra } = rest;
      if (Object.keys(extra).length > 0) {
        return { ok: false, error: `Scope "task_kind" has extra keys: ${Object.keys(extra).join(", ")}` };
      }
      if (typeof taskKind !== "string" || !config.taskKinds.includes(taskKind as TaskKind)) {
        return { ok: false, error: `Unknown task kind: "${taskKind}"` };
      }
      return { ok: true, scope: { kind: "task_kind", taskKind: taskKind as TaskKind } };
    }
    case "repo": {
      const { repoId, ...extra } = rest;
      if (Object.keys(extra).length > 0) {
        return { ok: false, error: `Scope "repo" has extra keys: ${Object.keys(extra).join(", ")}` };
      }
      if (typeof repoId !== "string" || !config.repoIds.includes(repoId)) {
        return { ok: false, error: `Unknown repo ID: "${repoId}"` };
      }
      return { ok: true, scope: { kind: "repo", repoId } };
    }
    case "repo_provider": {
      const { repoId, provider, ...extra } = rest;
      if (Object.keys(extra).length > 0) {
        return { ok: false, error: `Scope "repo_provider" has extra keys: ${Object.keys(extra).join(", ")}` };
      }
      if (typeof repoId !== "string" || !config.repoIds.includes(repoId)) {
        return { ok: false, error: `Unknown repo ID: "${repoId}"` };
      }
      if (typeof provider !== "string" || !config.providers.includes(provider as AgentProvider)) {
        return { ok: false, error: `Unknown provider: "${provider}"` };
      }
      return { ok: true, scope: { kind: "repo_provider", repoId, provider: provider as AgentProvider } };
    }
    case "repo_role": {
      const { repoId, role, ...extra } = rest;
      if (Object.keys(extra).length > 0) {
        return { ok: false, error: `Scope "repo_role" has extra keys: ${Object.keys(extra).join(", ")}` };
      }
      if (typeof repoId !== "string" || !config.repoIds.includes(repoId)) {
        return { ok: false, error: `Unknown repo ID: "${repoId}"` };
      }
      if (typeof role !== "string" || !config.roles.includes(role as AgentStrategyRole)) {
        return { ok: false, error: `Unknown role: "${role}"` };
      }
      return { ok: true, scope: { kind: "repo_role", repoId, role: role as AgentStrategyRole } };
    }
    case "repo_task_kind": {
      const { repoId, taskKind, ...extra } = rest;
      if (Object.keys(extra).length > 0) {
        return { ok: false, error: `Scope "repo_task_kind" has extra keys: ${Object.keys(extra).join(", ")}` };
      }
      if (typeof repoId !== "string" || !config.repoIds.includes(repoId)) {
        return { ok: false, error: `Unknown repo ID: "${repoId}"` };
      }
      if (typeof taskKind !== "string" || !config.taskKinds.includes(taskKind as TaskKind)) {
        return { ok: false, error: `Unknown task kind: "${taskKind}"` };
      }
      return { ok: true, scope: { kind: "repo_task_kind", repoId, taskKind: taskKind as TaskKind } };
    }
    default: {
      const exhaustiveCheck: never = kind as never;
      return { ok: false, error: `Unhandled scope kind: "${exhaustiveCheck}"` };
    }
  }
}

export function resolveScopePath(scope: LearningScope, managementRoot: string): string {
  const learningsRoot = path.resolve(managementRoot, "learnings");

  let relative: string;
  switch (scope.kind) {
    case "global":
      relative = "global.md";
      break;
    case "provider":
      relative = path.join("providers", `${scope.provider}.md`);
      break;
    case "role":
      relative = path.join("roles", `${scope.role}.md`);
      break;
    case "task_kind":
      relative = path.join("task-kinds", `${scope.taskKind}.md`);
      break;
    case "repo":
      relative = path.join("repos", `${scope.repoId}.md`);
      break;
    case "repo_provider":
      relative = path.join("repo-providers", scope.repoId, `${scope.provider}.md`);
      break;
    case "repo_role":
      relative = path.join("repo-roles", scope.repoId, `${scope.role}.md`);
      break;
    case "repo_task_kind":
      relative = path.join("repo-task-kinds", scope.repoId, `${scope.taskKind}.md`);
      break;
  }

  const resolved = path.resolve(learningsRoot, relative);

  // Guard: resolved path must stay under learningsRoot
  if (!resolved.startsWith(learningsRoot + path.sep) && resolved !== learningsRoot) {
    throw new Error(
      `Path traversal detected: scope resolved to "${resolved}" which escapes learnings root "${learningsRoot}"`
    );
  }

  return resolved;
}
