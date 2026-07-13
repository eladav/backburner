import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

export const projectRoot = path.resolve(currentDirectory, "../../..");
export const managementRoot = path.join(projectRoot, "management");

export const outputsRoot = path.join(projectRoot, "outputs");
export const outputsStateRoot = path.join(outputsRoot, "state");
export const outputsLogsRoot = path.join(outputsRoot, "logs");

export function resolveOutputsStateRoot(outputsDir: string): string {
  return path.join(outputsDir, "state");
}

export function resolveOutputsLogsRoot(outputsDir: string): string {
  return path.join(outputsDir, "logs");
}

export const outputsJournalRoot = path.join(outputsRoot, "journal");

export function resolveOutputsJournalRoot(outputsDir: string): string {
  return path.join(outputsDir, "journal");
}

export function expandHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

export function resolveUserPath(input: string): string {
  return path.resolve(expandHomePath(input));
}

export function defaultBackburnerRoot(): string {
  if (process.env.BACKBURNER_ROOT !== undefined && process.env.BACKBURNER_ROOT.trim() !== "") {
    return resolveUserPath(process.env.BACKBURNER_ROOT);
  }

  return path.join(os.homedir(), ".backburner");
}

export function defaultBackburnerCodeRoot(): string {
  return path.join(defaultBackburnerRoot(), "code");
}

export function defaultBackburnerManagementRoot(): string {
  return path.join(defaultBackburnerRoot(), "management");
}

export function defaultBackburnerOutputsRoot(): string {
  return path.join(defaultBackburnerRoot(), "outputs");
}

export function defaultWorkspacesRootForCodeRoot(codeRoot: string): string {
  return path.join(codeRoot, "_worktrees");
}
