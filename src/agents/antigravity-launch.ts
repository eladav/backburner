import type { TaskExecutionPermission } from "../tasks/types.js";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../utils/json.js";

export interface AntigravityMcpRuntime {
  serverName: string;
  serverUrl: string;
  toolAllowList: string[];
}

export type AntigravityPermissionMode = "sandbox" | "always-proceed";

export function mapPermissionToAntigravityMode(
  permission: TaskExecutionPermission
): AntigravityPermissionMode {
  switch (permission) {
    case "read-only":
      return "sandbox";
    case "workspace-write":
      return "always-proceed";
  }
}

export function buildAntigravityCliArgs(options: {
  permissionMode: AntigravityPermissionMode;
  model?: string;
  conversationId?: string;
  printTimeout: string;
  logFilePath: string;
  promptText: string;
}): string[] {
  const args = [
    "--print-timeout",
    options.printTimeout,
    "--log-file",
    options.logFilePath
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
  }

  if (options.permissionMode === "sandbox") {
    args.push("--sandbox");
  } else {
    args.push("--dangerously-skip-permissions");
  }

  args.push("--print", options.promptText);

  return args;
}

export async function writeAntigravitySettings(
  settingsPath: string,
  options: {
    permissionMode: AntigravityPermissionMode;
    cwd: string;
    model?: string;
  }
): Promise<void> {
  await writeJsonFileAtomic(settingsPath, {
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: options.permissionMode === "sandbox",
    toolPermission:
      options.permissionMode === "sandbox" ? "proceed-in-sandbox" : "always-proceed",
    trustedWorkspaces: [options.cwd],
    ...(options.model ? { model: options.model } : {})
  });
}

export async function writeAntigravityMcpConfig(
  configPath: string,
  options: { mcp?: AntigravityMcpRuntime }
): Promise<void> {
  const config = options.mcp ? buildMcpConfig(options.mcp) : { mcpServers: {} };
  await writeJsonFileAtomic(configPath, config);
}

export interface AntigravityMcpSetupResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
}

export async function ensureAntigravityMcpConfig(
  antigravityHome: string,
  mcp: AntigravityMcpRuntime,
  options: { now?: () => string } = {}
): Promise<AntigravityMcpSetupResult> {
  const configPath = path.join(antigravityHome, "mcp_config.json");
  await mkdir(antigravityHome, { recursive: true });

  const existing = await readExistingMcpConfig(configPath);
  const config = existing.config;
  const mcpServers = normalizeMcpServers(config["mcpServers"]);
  const existingServer = normalizeServerRecord(mcpServers[mcp.serverName]);
  const configuredUrl = getConfiguredServerUrl(existingServer);

  if (configuredUrl === mcp.serverUrl) {
    return { configPath, changed: false };
  }

  let backupPath: string | undefined;
  if (existing.existed) {
    backupPath = `${configPath}.backup-before-backburner-${formatBackupTimestamp(options.now?.() ?? new Date().toISOString())}`;
    await copyFile(configPath, backupPath);
  }

  const nextConfig = {
    ...config,
    mcpServers: {
      ...mcpServers,
      [mcp.serverName]: {
        ...existingServer,
        serverUrl: mcp.serverUrl
      }
    }
  };

  await writeJsonFileAtomic(configPath, nextConfig);
  return {
    configPath,
    changed: true,
    ...(backupPath ? { backupPath } : {})
  };
}

function buildMcpConfig(mcp: AntigravityMcpRuntime): Record<string, unknown> {
  return {
    mcpServers: {
      [mcp.serverName]: {
        serverUrl: mcp.serverUrl
      }
    }
  };
}

async function readExistingMcpConfig(configPath: string): Promise<{
  existed: boolean;
  config: Record<string, unknown>;
}> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { existed: false, config: {} };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Antigravity MCP config at ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Antigravity MCP config at ${configPath} must be a JSON object.`);
  }

  return { existed: true, config: parsed as Record<string, unknown> };
}

function normalizeMcpServers(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeServerRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function getConfiguredServerUrl(serverRecord: Record<string, unknown>): string | undefined {
  return typeof serverRecord["serverUrl"] === "string"
    ? serverRecord["serverUrl"]
    : typeof serverRecord["url"] === "string"
      ? serverRecord["url"]
      : undefined;
}

function formatBackupTimestamp(timestamp: string): string {
  return timestamp.replace(/[^0-9A-Za-z_-]+/g, "-");
}

export function getAntigravityEnvOverrides(): NodeJS.ProcessEnv {
  return {
    AGY_HOME: undefined,
    ANTIGRAVITY_HOME: undefined
  };
}

export function buildGlobalAntigravityLaunchInstructions(input: {
  mcp: AntigravityMcpRuntime;
}): string {
  return [
    "# Global Antigravity Instructions",
    "",
    "These instructions apply across repositories for this orchestrated run.",
    "",
    "## MCP Server",
    `Use the local MCP server \`${input.mcp.serverName}\` for managed GitHub operations.`,
    "- Invoke broker tools instead of using `gh` directly.",
    "- If a needed GitHub capability is missing from the broker, report the gap clearly instead of silently bypassing it.",
    "",
    "Enabled broker tools for this run:",
    ...input.mcp.toolAllowList.map((tool) => `- \`${tool}\``),
    "",
    "Any GitHub-authored message you post must begin with `🤖`."
  ].join("\n");
}

export function prependGlobalAntigravityLaunchInstructions(
  promptText: string,
  options: { mcp?: AntigravityMcpRuntime }
): string {
  if (!options.mcp) {
    return promptText;
  }

  return `${buildGlobalAntigravityLaunchInstructions({ mcp: options.mcp })}\n\n${promptText}`;
}
