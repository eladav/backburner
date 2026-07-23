import * as path from "node:path";
import type { WorktreeRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { slugify } from "../utils/slug.js";
import { validateWorkspaceOwnership } from "./workspace-ownership.js";

export interface RelocationAuthority {
  repoId: string;
  branchName: string;
  previousPath: string;
  currentPath: string;
}

export function relocateTaskRecords(
  tasks: readonly TaskRecord[],
  authorities: readonly RelocationAuthority[],
  codeRoot: string
): { tasks: TaskRecord[]; relocatedCount: number } {
  let relocatedCount = 0;
  const relocatedTasks = tasks.map((task) => {
    const relocated = relocateTaskRecord(task, authorities, codeRoot);
    if (relocated !== task) {
      relocatedCount += 1;
    }
    return relocated;
  });
  return { tasks: relocatedTasks, relocatedCount };
}

export function resolveCanonicalWorktreePath(
  storedPath: string,
  codeRoot: string,
  repoSlug: string
): string | null {
  const resolvedStoredPath = path.resolve(storedPath);
  const segments = resolvedStoredPath.split(path.sep);
  const markerIndex = segments.lastIndexOf("_worktrees");
  if (markerIndex < 0 || markerIndex === segments.length - 1) {
    return null;
  }

  const suffix = segments.slice(markerIndex + 1);
  const [expectedOwner, expectedRepo, ...rest] = repoSlug.split("/");
  if (
    !expectedOwner ||
    !expectedRepo ||
    rest.length > 0 ||
    suffix[0] !== slugify(expectedOwner) ||
    suffix[1] !== slugify(expectedRepo) ||
    suffix.length < 3
  ) {
    return null;
  }

  const candidate = path.join(
    path.resolve(codeRoot),
    "_worktrees",
    ...suffix
  );
  return isWithinWorktreeRoot(candidate, codeRoot) ? candidate : null;
}

export function isWithinWorktreeRoot(
  candidatePath: string,
  codeRoot: string
): boolean {
  const ownership = validateWorkspaceOwnership(candidatePath, codeRoot);
  if (!ownership.valid) {
    return false;
  }

  const relative = path.relative(
    path.join(path.resolve(codeRoot), "_worktrees"),
    path.resolve(candidatePath)
  );
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function relocateWorktreeRecord(
  worktree: WorktreeRecord,
  currentPath: string
): WorktreeRecord {
  return {
    ...worktree,
    path: currentPath,
    planDocumentPath: relocateDescendantPath(
      worktree.planDocumentPath,
      worktree.path,
      currentPath
    ),
    ...(worktree.productSpecDocumentPath
      ? {
          productSpecDocumentPath: relocateDescendantPath(
            worktree.productSpecDocumentPath,
            worktree.path,
            currentPath
          )
        }
      : {}),
    logDocumentPath: relocateDescendantPath(
      worktree.logDocumentPath,
      worktree.path,
      currentPath
    )
  };
}

function relocateTaskRecord(
  task: TaskRecord,
  authorities: readonly RelocationAuthority[],
  codeRoot: string
): TaskRecord {
  if (task.kind === "prepare_pr_for_merge") {
    return relocatePrepareForMergeTask(task, authorities, codeRoot);
  }

  const branchName = task.context.branchName;
  const previousWorkspacePath = task.context.localRepoPath;
  if (!branchName || !previousWorkspacePath) {
    return task;
  }

  const relocatedWorkspacePath = resolveTaskWorkspaceRelocation({
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    branchName,
    previousWorkspacePath,
    authorities,
    codeRoot
  });
  if (
    !relocatedWorkspacePath ||
    path.resolve(previousWorkspacePath) === path.resolve(relocatedWorkspacePath)
  ) {
    return task;
  }

  return {
    ...task,
    context: relocateTaskContextPaths(
      task.context,
      previousWorkspacePath,
      relocatedWorkspacePath
    )
  };
}

function relocatePrepareForMergeTask(
  task: TaskRecord,
  authorities: readonly RelocationAuthority[],
  codeRoot: string
): TaskRecord {
  const preflight = task.context.prepareForMerge;
  const previousWorkspacePath = preflight?.persistentWorktreePath;
  if (!preflight || !previousWorkspacePath) {
    return task;
  }

  const relocatedWorkspacePath = resolveTaskWorkspaceRelocation({
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    branchName: preflight.headBranch,
    previousWorkspacePath,
    authorities,
    codeRoot
  });
  if (
    !relocatedWorkspacePath ||
    path.resolve(previousWorkspacePath) === path.resolve(relocatedWorkspacePath)
  ) {
    return task;
  }

  const relocatedContext = relocateTaskContextPaths(
    task.context,
    previousWorkspacePath,
    relocatedWorkspacePath
  );
  return {
    ...task,
    context: {
      ...relocatedContext,
      prepareForMerge: {
        ...preflight,
        persistentWorktreePath: relocatedWorkspacePath,
        ...(preflight.persistentPlanDocumentPath
          ? {
              persistentPlanDocumentPath: relocateDescendantPath(
                preflight.persistentPlanDocumentPath,
                previousWorkspacePath,
                relocatedWorkspacePath
              )
            }
          : {}),
        ...(preflight.persistentLogDocumentPath
          ? {
              persistentLogDocumentPath: relocateDescendantPath(
                preflight.persistentLogDocumentPath,
                previousWorkspacePath,
                relocatedWorkspacePath
              )
            }
          : {})
      }
    }
  };
}

function resolveTaskWorkspaceRelocation(input: {
  repoId: string;
  repoSlug: string;
  branchName: string;
  previousWorkspacePath: string;
  authorities: readonly RelocationAuthority[];
  codeRoot: string;
}): string | undefined {
  const matches = input.authorities.filter(
    (authority) =>
      authority.repoId === input.repoId &&
      authority.branchName === input.branchName
  );
  const exact = matches.find(
    (authority) =>
      path.resolve(authority.previousPath) ===
      path.resolve(input.previousWorkspacePath)
  );
  if (exact) {
    return exact.currentPath;
  }

  const canonicalTaskPath = resolveCanonicalWorktreePath(
    input.previousWorkspacePath,
    input.codeRoot,
    input.repoSlug
  );
  if (!canonicalTaskPath) {
    return undefined;
  }

  return matches.find(
    (authority) =>
      path.resolve(authority.currentPath) === path.resolve(canonicalTaskPath)
  )?.currentPath;
}

function relocateTaskContextPaths(
  context: TaskRecord["context"],
  previousWorkspacePath: string,
  relocatedWorkspacePath: string
): TaskRecord["context"] {
  return {
    ...context,
    ...(context.localRepoPath &&
    path.resolve(context.localRepoPath) === path.resolve(previousWorkspacePath)
      ? { localRepoPath: relocatedWorkspacePath }
      : {}),
    ...(context.planDocumentPath
      ? {
          planDocumentPath: relocateDescendantPath(
            context.planDocumentPath,
            previousWorkspacePath,
            relocatedWorkspacePath
          )
        }
      : {}),
    ...(context.productSpecDocumentPath
      ? {
          productSpecDocumentPath: relocateDescendantPath(
            context.productSpecDocumentPath,
            previousWorkspacePath,
            relocatedWorkspacePath
          )
        }
      : {}),
    ...(context.logDocumentPath
      ? {
          logDocumentPath: relocateDescendantPath(
            context.logDocumentPath,
            previousWorkspacePath,
            relocatedWorkspacePath
          )
        }
      : {})
  };
}

function relocateDescendantPath(
  candidatePath: string,
  previousRoot: string,
  currentRoot: string
): string {
  const relative = path.relative(path.resolve(previousRoot), path.resolve(candidatePath));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return candidatePath;
  }
  return path.join(currentRoot, relative);
}
