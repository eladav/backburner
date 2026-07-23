import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { GitGateway } from "../git/types.js";
import { parseGitHubRemoteUrl } from "../github/utils.js";
import type { RepoSyncRecord, WorktreeRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { assertNoSymlinkedPathComponents } from "../utils/path-safety.js";
import {
  isWithinWorktreeRoot,
  relocateTaskRecords,
  relocateWorktreeRecord,
  resolveCanonicalWorktreePath,
  type RelocationAuthority
} from "./workspace-relocation-state.js";

export interface WorkspaceRelocationFailure {
  worktreeId: string;
  reason: string;
}

export interface WorkspaceRelocationResult {
  worktrees: WorktreeRecord[];
  tasks: TaskRecord[];
  relocatedCount: number;
  recreatedCount: number;
  taskRelocatedCount: number;
  failures: WorkspaceRelocationFailure[];
}

/**
 * Rehomes durable worktree state after the configured code root changes.
 *
 * Existing paths are never moved or removed. Missing canonical worktrees are
 * recreated from the configured repository clone and the recorded remote
 * branch, then durable worktree and task paths are updated to the new root.
 */
export async function reconcileDurableWorktreeLocations(input: {
  codeRoot: string;
  worktrees: readonly WorktreeRecord[];
  tasks: readonly TaskRecord[];
  repoSyncRecords: readonly RepoSyncRecord[];
  gitGateway: GitGateway;
}): Promise<WorkspaceRelocationResult> {
  const repoSyncById = new Map(input.repoSyncRecords.map((record) => [record.repoId, record]));
  const worktrees: WorktreeRecord[] = [];
  const authorities: RelocationAuthority[] = [];
  const failures: WorkspaceRelocationFailure[] = [];
  let relocatedCount = 0;
  let recreatedCount = 0;

  for (const worktree of input.worktrees) {
    if (worktree.status === "closed") {
      worktrees.push(worktree);
      continue;
    }

    const canonicalPath = resolveCanonicalWorktreePath(
      worktree.path,
      input.codeRoot,
      worktree.repoSlug
    );
    if (!canonicalPath) {
      failures.push({
        worktreeId: worktree.id,
        reason: `Cannot derive a canonical _worktrees path from "${worktree.path}".`
      });
      worktrees.push(worktree);
      continue;
    }

    const repoSync = repoSyncById.get(worktree.repoId);
    if (!repoSync) {
      failures.push({
        worktreeId: worktree.id,
        reason: `No synchronized repository is available for ${worktree.repoSlug}.`
      });
      worktrees.push(worktree);
      continue;
    }
    if (repoSync.repoSlug.toLowerCase() !== worktree.repoSlug.toLowerCase()) {
      failures.push({
        worktreeId: worktree.id,
        reason:
          `Repository identity mismatch for ${worktree.id}: state says "${worktree.repoSlug}", ` +
          `but synchronized repo ${repoSync.repoId} is "${repoSync.repoSlug}".`
      });
      worktrees.push(worktree);
      continue;
    }

    try {
      await validateRepositoryOrigin(repoSync, input.gitGateway);
      const resolution = await resolveOrRecreateWorktree({
        codeRoot: input.codeRoot,
        canonicalPath,
        branchName: worktree.branchName,
        repoPath: repoSync.localPath,
        gitGateway: input.gitGateway
      });

      if (resolution.recreated) {
        recreatedCount += 1;
      }

      authorities.push({
        repoId: worktree.repoId,
        branchName: worktree.branchName,
        previousPath: worktree.path,
        currentPath: resolution.path
      });

      if (path.resolve(worktree.path) === path.resolve(resolution.path)) {
        worktrees.push(worktree);
        continue;
      }

      const relocated = relocateWorktreeRecord(worktree, resolution.path);
      worktrees.push(relocated);
      relocatedCount += 1;
    } catch (error: unknown) {
      failures.push({
        worktreeId: worktree.id,
        reason: error instanceof Error ? error.message : String(error)
      });
      worktrees.push(worktree);
    }
  }

  const taskRelocation = relocateTaskRecords(
    input.tasks,
    authorities,
    input.codeRoot
  );

  return {
    worktrees,
    tasks: taskRelocation.tasks,
    relocatedCount,
    recreatedCount,
    taskRelocatedCount: taskRelocation.relocatedCount,
    failures
  };
}

async function validateRepositoryOrigin(
  repoSync: RepoSyncRecord,
  gitGateway: GitGateway
): Promise<void> {
  if (!gitGateway.getRemoteUrl) {
    throw new Error(
      `Cannot validate repository origin at "${repoSync.localPath}": Git gateway does not expose remote URLs.`
    );
  }

  const remoteUrl = await gitGateway.getRemoteUrl(repoSync.localPath, "origin");
  const identity = parseGitHubRemoteUrl(remoteUrl);
  if (!identity) {
    throw new Error(
      `Cannot validate repository origin at "${repoSync.localPath}": unrecognized GitHub remote URL "${remoteUrl}".`
    );
  }

  const remoteSlug = `${identity.owner}/${identity.name}`;
  if (remoteSlug.toLowerCase() !== repoSync.repoSlug.toLowerCase()) {
    throw new Error(
      `Repository origin mismatch at "${repoSync.localPath}": expected "${repoSync.repoSlug}", found "${remoteSlug}".`
    );
  }
}

async function resolveOrRecreateWorktree(input: {
  codeRoot: string;
  canonicalPath: string;
  branchName: string;
  repoPath: string;
  gitGateway: GitGateway;
}): Promise<{ path: string; recreated: boolean }> {
  await assertNoSymlinkedPathComponents(input.codeRoot, input.canonicalPath);
  await input.gitGateway.fetchRepository(input.repoPath);
  const registeredWorktrees = await input.gitGateway.listWorktrees(input.repoPath);
  const canonicalEntry = registeredWorktrees.find(
    (entry) => path.resolve(entry.path) === path.resolve(input.canonicalPath)
  );
  const canonicalPathExists = await pathExists(input.canonicalPath);

  if (canonicalPathExists) {
    if (!canonicalEntry) {
      throw new Error(
        `Canonical path "${input.canonicalPath}" exists but is not a worktree of "${input.repoPath}".`
      );
    }
    if (canonicalEntry.branch !== input.branchName) {
      throw new Error(
        `Canonical worktree "${input.canonicalPath}" is on branch "${canonicalEntry.branch}", expected "${input.branchName}".`
      );
    }
    return { path: input.canonicalPath, recreated: false };
  }

  const existingBranchWorktree = await findExistingCanonicalBranchWorktree(
    registeredWorktrees,
    input.branchName,
    input.codeRoot
  );
  if (existingBranchWorktree) {
    return { path: existingBranchWorktree, recreated: false };
  }

  const blockingWorktree = registeredWorktrees.find(
    (entry) => entry.branch === input.branchName && path.resolve(entry.path) !== path.resolve(input.canonicalPath)
  );
  if (blockingWorktree && await pathExists(blockingWorktree.path)) {
    throw new Error(
      `Branch "${input.branchName}" is already checked out outside the current code root at "${blockingWorktree.path}".`
    );
  }

  const createdPath = await input.gitGateway.createWorktree(
    input.repoPath,
    input.codeRoot,
    input.canonicalPath,
    input.branchName,
    `origin/${input.branchName}`,
    { reuseExistingBranch: true }
  );
  const currentBranch = await input.gitGateway.getCurrentBranch(createdPath);
  if (currentBranch !== input.branchName) {
    throw new Error(
      `Recreated worktree "${createdPath}" is on branch "${currentBranch ?? "detached HEAD"}", expected "${input.branchName}".`
    );
  }
  await input.gitGateway.resetHard(createdPath, `origin/${input.branchName}`);
  await input.gitGateway.cleanUntrackedFiles(createdPath);

  return { path: createdPath, recreated: true };
}

async function findExistingCanonicalBranchWorktree(
  worktrees: readonly { path: string; branch: string }[],
  branchName: string,
  codeRoot: string
): Promise<string | null> {
  for (const worktree of worktrees) {
    if (
      worktree.branch === branchName &&
      isWithinWorktreeRoot(worktree.path, codeRoot) &&
      await pathExists(worktree.path)
    ) {
      await assertNoSymlinkedPathComponents(codeRoot, worktree.path);
      return path.resolve(worktree.path);
    }
  }
  return null;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await stat(candidatePath);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
