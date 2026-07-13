import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  validateLearningScope,
  resolveScopePath,
  normalizeRetrospectiveScopes,
  SCOPE_PRECEDENCE_ORDER,
  type ScopeValidationConfig,
  type ScopeKind
} from "../src/retrospectives/scopes.js";

const config: ScopeValidationConfig = {
  repoIds: ["my-repo"],
  providers: ["claude", "codex", "antigravity"],
  roles: ["planning", "implementation", "review", "discussion", "implementation_manager", "retrospective"],
  taskKinds: ["write_plan", "implement_plan", "review_pr", "triage_issue", "respond_issue_comment", "plan_breakdown", "sync_parent_branch_preflight", "sync_parent_branch", "prepare_pr_for_merge", "respond_pr_comment"]
};

const mgmtRoot = "/mgmt";

// Group A: Scope validation — happy path
test("validateLearningScope accepts global scope with no extra keys", () => {
  const result = validateLearningScope({ kind: "global" }, config);
  assert.ok(result.ok);
  assert.equal((result as any).scope.kind, "global");
});

test("validateLearningScope accepts provider scope", () => {
  const result = validateLearningScope({ kind: "provider", provider: "claude" }, config);
  assert.ok(result.ok);
  assert.equal((result as any).scope.kind, "provider");
  assert.equal((result as any).scope.provider, "claude");
});

test("validateLearningScope accepts role scope", () => {
  const result = validateLearningScope({ kind: "role", role: "planning" }, config);
  assert.ok(result.ok);
  assert.equal((result as any).scope.kind, "role");
  assert.equal((result as any).scope.role, "planning");
});

test("validateLearningScope accepts task_kind scope", () => {
  const result = validateLearningScope({ kind: "task_kind", taskKind: "write_plan" }, config);
  assert.ok(result.ok);
  assert.equal((result as any).scope.kind, "task_kind");
  assert.equal((result as any).scope.taskKind, "write_plan");
});

test("validateLearningScope accepts repo scope", () => {
  const result = validateLearningScope({ kind: "repo", repoId: "my-repo" }, config);
  assert.ok(result.ok);
  assert.equal((result as any).scope.kind, "repo");
  assert.equal((result as any).scope.repoId, "my-repo");
});

test("validateLearningScope accepts repo_provider scope", () => {
  const result = validateLearningScope({ kind: "repo_provider", repoId: "my-repo", provider: "claude" }, config);
  assert.ok(result.ok);
  assert.equal((result as any).scope.kind, "repo_provider");
  assert.equal((result as any).scope.repoId, "my-repo");
  assert.equal((result as any).scope.provider, "claude");
});

test("validateLearningScope accepts repo_role scope", () => {
  const result = validateLearningScope({ kind: "repo_role", repoId: "my-repo", role: "implementation" }, config);
  assert.ok(result.ok);
  assert.equal((result as any).scope.kind, "repo_role");
  assert.equal((result as any).scope.repoId, "my-repo");
  assert.equal((result as any).scope.role, "implementation");
});

test("validateLearningScope accepts repo_task_kind scope", () => {
  const result = validateLearningScope({ kind: "repo_task_kind", repoId: "my-repo", taskKind: "implement_plan" }, config);
  assert.ok(result.ok);
  assert.equal((result as any).scope.kind, "repo_task_kind");
  assert.equal((result as any).scope.repoId, "my-repo");
  assert.equal((result as any).scope.taskKind, "implement_plan");
});

// Group B: Validation — missing required keys
test("validateLearningScope rejects provider scope missing provider key", () => {
  const result = validateLearningScope({ kind: "provider" }, config);
  assert.ok(!result.ok);
});

test("validateLearningScope rejects repo_provider scope missing repoId", () => {
  const result = validateLearningScope({ kind: "repo_provider", provider: "claude" }, config);
  assert.ok(!result.ok);
});

// Group C: Validation — extra keys
test("validateLearningScope rejects global scope with extra key", () => {
  const result = validateLearningScope({ kind: "global", extra: "bad" }, config);
  assert.ok(!result.ok);
});

test("validateLearningScope rejects role scope with extra key", () => {
  const result = validateLearningScope({ kind: "role", role: "planning", extra: "bad" }, config);
  assert.ok(!result.ok);
});

// Group D: Validation — unknown values
test("validateLearningScope rejects unknown repo ID", () => {
  const result = validateLearningScope({ kind: "repo", repoId: "unknown-repo" }, config);
  assert.ok(!result.ok);
});

test("validateLearningScope rejects unknown provider", () => {
  const result = validateLearningScope({ kind: "provider", provider: "openai" }, config);
  assert.ok(!result.ok);
});

test("validateLearningScope rejects unknown role", () => {
  const result = validateLearningScope({ kind: "role", role: "gpt" }, config);
  assert.ok(!result.ok);
});

test("validateLearningScope rejects unknown task kind", () => {
  const result = validateLearningScope({ kind: "task_kind", taskKind: "do_magic" }, config);
  assert.ok(!result.ok);
});

// Group E: Validation — bad input types
test("validateLearningScope rejects null", () => {
  assert.ok(!validateLearningScope(null, config).ok);
});

test("validateLearningScope rejects array", () => {
  assert.ok(!validateLearningScope([], config).ok);
});

test("validateLearningScope rejects string", () => {
  assert.ok(!validateLearningScope("global", config).ok);
});

test("validateLearningScope rejects missing kind", () => {
  assert.ok(!validateLearningScope({}, config).ok);
});

test("validateLearningScope rejects unknown kind string", () => {
  assert.ok(!validateLearningScope({ kind: "super_scope" }, config).ok);
});

// Group F: retrospective is a valid role
test("validateLearningScope accepts role=retrospective", () => {
  const result = validateLearningScope({ kind: "role", role: "retrospective" }, config);
  assert.ok(result.ok);
  assert.equal((result as any).scope.role, "retrospective");
});

// Group G: SCOPE_PRECEDENCE_ORDER contents and ordering
test("SCOPE_PRECEDENCE_ORDER contains all 8 scope kinds", () => {
  assert.equal(SCOPE_PRECEDENCE_ORDER.length, 8);
  const expected: ScopeKind[] = [
    "repo_task_kind", "repo_role", "repo_provider", "repo",
    "task_kind", "role", "provider", "global"
  ];
  assert.deepEqual([...SCOPE_PRECEDENCE_ORDER], expected);
});

test("repo_task_kind has higher precedence than global", () => {
  assert.ok(
    SCOPE_PRECEDENCE_ORDER.indexOf("repo_task_kind") < SCOPE_PRECEDENCE_ORDER.indexOf("global")
  );
});

// Group H: resolveScopePath — correct paths for all 8 shapes
test("resolveScopePath global → learnings/global.md", () => {
  const result = resolveScopePath({ kind: "global" }, mgmtRoot);
  assert.ok(result.endsWith(path.join("learnings", "global.md")));
});

test("resolveScopePath provider → learnings/providers/<provider>.md", () => {
  const result = resolveScopePath({ kind: "provider", provider: "claude" }, mgmtRoot);
  assert.ok(result.endsWith(path.join("learnings", "providers", "claude.md")));
});

test("resolveScopePath role → learnings/roles/<role>.md", () => {
  const result = resolveScopePath({ kind: "role", role: "planning" }, mgmtRoot);
  assert.ok(result.endsWith(path.join("learnings", "roles", "planning.md")));
});

test("resolveScopePath task_kind → learnings/task-kinds/<task-kind>.md", () => {
  const result = resolveScopePath({ kind: "task_kind", taskKind: "write_plan" }, mgmtRoot);
  assert.ok(result.endsWith(path.join("learnings", "task-kinds", "write_plan.md")));
});

test("resolveScopePath repo → learnings/repos/<repoId>.md", () => {
  const result = resolveScopePath({ kind: "repo", repoId: "my-repo" }, mgmtRoot);
  assert.ok(result.endsWith(path.join("learnings", "repos", "my-repo.md")));
});

test("resolveScopePath repo_provider → learnings/repo-providers/<repoId>/<provider>.md", () => {
  const result = resolveScopePath({ kind: "repo_provider", repoId: "my-repo", provider: "claude" }, mgmtRoot);
  assert.ok(result.endsWith(path.join("learnings", "repo-providers", "my-repo", "claude.md")));
});

test("resolveScopePath repo_role → learnings/repo-roles/<repoId>/<role>.md", () => {
  const result = resolveScopePath({ kind: "repo_role", repoId: "my-repo", role: "implementation" }, mgmtRoot);
  assert.ok(result.endsWith(path.join("learnings", "repo-roles", "my-repo", "implementation.md")));
});

test("resolveScopePath repo_task_kind → learnings/repo-task-kinds/<repoId>/<taskKind>.md", () => {
  const result = resolveScopePath({ kind: "repo_task_kind", repoId: "my-repo", taskKind: "implement_plan" }, mgmtRoot);
  assert.ok(result.endsWith(path.join("learnings", "repo-task-kinds", "my-repo", "implement_plan.md")));
});

// Group I: Path traversal guard
test("resolveScopePath throws on traversal via repoId", () => {
  assert.throws(
    () => resolveScopePath({ kind: "repo", repoId: "../../etc/passwd" }, mgmtRoot),
    /traversal/
  );
});

test("resolveScopePath throws on traversal via role", () => {
  // This requires bypassing TypeScript validation, so cast to any
  assert.throws(
    () => resolveScopePath({ kind: "role", role: "../../etc" as any }, mgmtRoot),
    /traversal/
  );
});

// Group J: normalizeRetrospectiveScopes
test("normalizeRetrospectiveScopes handles empty input", () => {
  const result = normalizeRetrospectiveScopes({
    rawSuggestedScopes: [],
    affectedRepoIds: [],
    roles: [],
    taskKinds: [],
    providers: []
  });
  assert.deepEqual(result.semanticScopes, []);
  assert.deepEqual(result.candidateLearningScopes, []);
});

test("normalizeRetrospectiveScopes preserves already-valid scopes", () => {
  const validScope = { kind: "global" };
  const result = normalizeRetrospectiveScopes({
    rawSuggestedScopes: [validScope],
    affectedRepoIds: [],
    roles: [],
    taskKinds: [],
    providers: []
  });
  assert.deepEqual(result.candidateLearningScopes, [validScope]);
});

test("normalizeRetrospectiveScopes expands workflow semantic scope", () => {
  const result = normalizeRetrospectiveScopes({
    rawSuggestedScopes: [{ kind: "workflow" }],
    affectedRepoIds: ["repo-a"],
    roles: [],
    taskKinds: ["implement_plan"],
    providers: []
  });

  const kinds = result.candidateLearningScopes.map(s => s.kind);
  assert.ok(kinds.includes("repo_task_kind"));
  assert.ok(kinds.includes("task_kind"));
  assert.ok(kinds.includes("repo"));
  assert.ok(kinds.includes("global"));

  assert.equal(result.semanticScopes.length, 1);
  assert.equal(result.semanticScopes[0]?.kind, "workflow");
});

test("normalizeRetrospectiveScopes expands configuration semantic scope", () => {
  const result = normalizeRetrospectiveScopes({
    rawSuggestedScopes: [{ kind: "configuration" }],
    affectedRepoIds: ["repo-a"],
    roles: [],
    taskKinds: [],
    providers: ["claude"]
  });

  const kinds = result.candidateLearningScopes.map(s => s.kind);
  assert.ok(kinds.includes("repo_provider"));
  assert.ok(kinds.includes("provider"));
  assert.ok(kinds.includes("repo"));
  assert.ok(kinds.includes("global"));
});

test("normalizeRetrospectiveScopes expands guidance semantic scope", () => {
  const result = normalizeRetrospectiveScopes({
    rawSuggestedScopes: [{ kind: "guidance" }],
    affectedRepoIds: ["repo-a"],
    roles: ["planning"],
    taskKinds: ["implement_plan"],
    providers: []
  });

  const kinds = result.candidateLearningScopes.map(s => s.kind);
  assert.ok(kinds.includes("repo_role"));
  assert.ok(kinds.includes("repo_task_kind"));
  assert.ok(kinds.includes("role"));
  assert.ok(kinds.includes("task_kind"));
  assert.ok(kinds.includes("global"));
});

test("normalizeRetrospectiveScopes expands orchestration semantic scope", () => {
  const result = normalizeRetrospectiveScopes({
    rawSuggestedScopes: [{ kind: "orchestration" }],
    affectedRepoIds: ["repo-a"],
    roles: ["planning"],
    taskKinds: ["implement_plan"],
    providers: []
  });

  const kinds = result.candidateLearningScopes.map(s => s.kind);
  assert.ok(kinds.includes("repo_task_kind"));
  assert.ok(kinds.includes("repo_role"));
  assert.ok(kinds.includes("repo"));
  assert.ok(kinds.includes("global"));
});

test("normalizeRetrospectiveScopes deduplicates candidates", () => {
  const result = normalizeRetrospectiveScopes({
    rawSuggestedScopes: [{ kind: "workflow" }, { kind: "workflow" }],
    affectedRepoIds: ["repo-a"],
    roles: [],
    taskKinds: ["implement_plan"],
    providers: []
  });

  const globals = result.candidateLearningScopes.filter(s => s.kind === "global");
  assert.equal(globals.length, 1);
});

test("normalizeRetrospectiveScopes passes through unknown scope kinds to candidates for validation", () => {
  const result = normalizeRetrospectiveScopes({
    rawSuggestedScopes: [{ kind: "unknown-thing" }],
    affectedRepoIds: [],
    roles: [],
    taskKinds: [],
    providers: []
  });

  assert.equal(result.candidateLearningScopes.length, 1);
  assert.equal((result.candidateLearningScopes[0] as any).kind, "unknown-thing");
  assert.equal(result.semanticScopes.length, 0);
});
