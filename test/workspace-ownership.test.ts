import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test, describe } from "node:test";
import { validateWorkspaceOwnership } from "../src/worktrees/workspace-ownership.js";

describe("validateWorkspaceOwnership", () => {
  const codeRoot = path.resolve("/tmp/backburner-code-root");

  test("Validates a valid implementation worktree path", () => {
    const workspacePath = path.join(codeRoot, "_worktrees", "owner", "repo", "issue-262");
    const result = validateWorkspaceOwnership(workspacePath, codeRoot);
    assert.deepStrictEqual(result, { valid: true });
  });

  test("Validates a valid merge-prep clone path", () => {
    const workspacePath = path.join(codeRoot, "_merge-prep", "owner", "repo", "pr-267-runid");
    const result = validateWorkspaceOwnership(workspacePath, codeRoot);
    assert.deepStrictEqual(result, { valid: true });
  });

  test("Rejects a canonical repo clone", () => {
    const workspacePath = path.join(codeRoot, "agents-over-github");
    const result = validateWorkspaceOwnership(workspacePath, codeRoot);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("not within an orchestrator-owned workspace root"));
  });

  test("Rejects a path outside the code root", () => {
    const workspacePath = path.resolve(path.join(path.dirname(codeRoot), "other", "workspace"));
    const result = validateWorkspaceOwnership(workspacePath, codeRoot);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("not within an orchestrator-owned workspace root"));
  });

  test("Rejects traversal that normalizes outside", () => {
    const workspacePath = path.join(codeRoot, "_worktrees", "..", "..", "outside");
    const result = validateWorkspaceOwnership(workspacePath, codeRoot);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("not within an orchestrator-owned workspace root"));
  });

  test("Rejects sibling prefix paths", () => {
    const siblingWorktrees = path.join(codeRoot, "_worktrees-other", "repo");
    const resultWorktrees = validateWorkspaceOwnership(siblingWorktrees, codeRoot);
    assert.strictEqual(resultWorktrees.valid, false);

    const siblingMergePrep = path.join(codeRoot, "_merge-prep-old", "repo");
    const resultMergePrep = validateWorkspaceOwnership(siblingMergePrep, codeRoot);
    assert.strictEqual(resultMergePrep.valid, false);
  });

  test("Rejects the allowed roots themselves", () => {
    const worktreesRoot = path.join(codeRoot, "_worktrees");
    const resultWorktrees = validateWorkspaceOwnership(worktreesRoot, codeRoot);
    assert.strictEqual(resultWorktrees.valid, false);

    const mergePrepRoot = path.join(codeRoot, "_merge-prep");
    const resultMergePrep = validateWorkspaceOwnership(mergePrepRoot, codeRoot);
    assert.strictEqual(resultMergePrep.valid, false);
  });

  test("Accepts relative inputs that resolve into allowed roots", () => {
    // We use path.resolve in the implementation, so relative paths should be resolved against CWD.
    // To make this stable, we'll join it with CWD manually for the test expectation if needed,
    // but the implementation just calls path.resolve(workspacePath).

    const cwd = process.cwd();
    // This test is a bit brittle if we don't know where CWD is, but we can mock it by passing an absolute path
    // that happens to be relative to something we know.
    // Actually, the plan says: "Accept relative inputs after normalization when they resolve into the allowed roots"

    // If I pass "foo", it resolves to path.join(cwd, "foo").
    // If cwd is under _worktrees, it should pass.

    // Let's simulate this by using a codeRoot that contains the current directory's parent.
    // But it's easier to just test that path.resolve is called.

    const relativePath = path.join("_worktrees", "some-task");
    // If we set codeRoot to the parent of where this would resolve...
    const fakeCodeRoot = path.dirname(path.dirname(path.resolve(relativePath)));

    const result = validateWorkspaceOwnership(relativePath, fakeCodeRoot);
    assert.deepStrictEqual(result, { valid: true });
  });
});
