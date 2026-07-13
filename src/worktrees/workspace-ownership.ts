import * as path from "node:path";

/**
 * Result of a workspace ownership validation.
 */
export type WorkspaceOwnershipValidation =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Validates that a candidate workspace path is owned by the orchestrator.
 *
 * Orchestrator-owned task workspaces are strictly located under:
 * - <codeRoot>/_worktrees/
 * - <codeRoot>/_merge-prep/
 *
 * This function performs a pure string-normalization check without I/O.
 * It rejects the root directories themselves to ensure recovery targets
 * individual task workspaces.
 *
 * @param workspacePath The candidate workspace path to validate.
 * @param codeRoot The orchestrator's code root directory.
 */
export function validateWorkspaceOwnership(
  workspacePath: string,
  codeRoot: string
): WorkspaceOwnershipValidation {
  const resolvedCodeRoot = path.resolve(codeRoot);
  const resolvedWorkspacePath = path.resolve(workspacePath);

  const allowedRootSubdirs = ["_worktrees", "_merge-prep"];

  for (const subdir of allowedRootSubdirs) {
    const allowedRoot = path.join(resolvedCodeRoot, subdir);
    const relative = path.relative(allowedRoot, resolvedWorkspacePath);

    const isInside =
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative);

    if (isInside) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    reason: `Path "${resolvedWorkspacePath}" is not within an orchestrator-owned workspace root (_worktrees or _merge-prep) under "${resolvedCodeRoot}".`,
  };
}
