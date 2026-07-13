import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ValidationIssue } from "../types.js";
import { getDefaultPlatform, type PlatformHelper } from "./tool-checker.js";

export interface WorkspaceCheckResult {
  path: string;
  exists: boolean;
  writable: boolean;
  issue?: ValidationIssue;
}

export class WorkspaceChecker {
  constructor(private readonly platformHelper: PlatformHelper = getDefaultPlatform) {}

  async check(dirPath: string): Promise<WorkspaceCheckResult> {
    let exists = false;
    let writable = false;

    try {
      await fs.access(dirPath, fs.constants.F_OK);
      exists = true;

      try {
        await fs.access(dirPath, fs.constants.W_OK);
        writable = true;
      } catch {
        // exists but not writable
      }
    } catch {
      // Does not exist. Check the nearest existing ancestor that mkdir -p would use.
      const parent = await findExistingAncestor(path.dirname(dirPath));
      try {
        await fs.access(parent, fs.constants.W_OK);
        writable = true;
      } catch {
        // parent also not writable
      }
    }

    if (!writable) {
      return {
        path: dirPath,
        exists,
        writable: false,
        issue: {
          title: `Cannot write to directory: ${dirPath}`,
          cause: `The directory or its parent is not writable by the current user`,
          suggestedFix: "Choose a different directory or fix the permissions",
          canAutoRemediate: false,
          manualSteps: buildWorkspacePermissionManualSteps(dirPath, this.platformHelper())
        }
      };
    }

    return { path: dirPath, exists, writable: true };
  }

  async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

async function findExistingAncestor(startPath: string): Promise<string> {
  let current = startPath;
  while (true) {
    try {
      await fs.access(current, fs.constants.F_OK);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

export function buildWorkspacePermissionManualSteps(
  dirPath: string,
  platform: NodeJS.Platform = getDefaultPlatform()
): string[] {
  if (platform === "win32") {
    const parentDir = path.win32.dirname(dirPath);
    return [
      `Open the directory properties for "${parentDir}" and confirm your user can write there`,
      `Open the directory properties for "${dirPath}" and confirm your user can write there`,
      "Or choose a different directory that your Windows user can write to"
    ];
  }

  return [
    `chmod u+w ${path.dirname(dirPath)}  # if parent not writable`,
    `chmod u+w ${dirPath}               # if directory not writable`
  ];
}
