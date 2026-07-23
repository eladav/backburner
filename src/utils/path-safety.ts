import { lstat } from "node:fs/promises";
import * as path from "node:path";

/**
 * Rejects symlinks in existing path components below a trusted root.
 *
 * The root itself may be a symlink chosen by the user. Descendant symlinks are
 * rejected so a lexically contained destination cannot escape through an
 * existing directory link.
 */
export async function assertNoSymlinkedPathComponents(
  rootPath: string,
  candidatePath: string
): Promise<void> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path "${resolvedCandidate}" is not below "${resolvedRoot}".`);
  }

  let currentPath = resolvedRoot;
  for (const segment of relative.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    try {
      const info = await lstat(currentPath);
      if (info.isSymbolicLink()) {
        throw new Error(
          `Path "${resolvedCandidate}" traverses symbolic link "${currentPath}".`
        );
      }
    } catch (error: unknown) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
