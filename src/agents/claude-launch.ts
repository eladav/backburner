import * as fs from "node:fs/promises";
import type { TaskExecutionPermission } from "../tasks/types.js";

export type ClaudePermissionMode = "dontAsk" | "acceptEdits" | "bypassPermissions";

export interface ClaudeMcpRuntime {
  serverName: string;
  serverUrl: string;
  toolAllowList: string[];
}

/**
 * Maps orchestrator permissions to Claude Code CLI permission modes.
 * - read-only -> dontAsk
 * - workspace-write -> bypassPermissions (allows running local bash commands like npm, docker-compose)
 */
export function mapPermissionToClaudePermissionMode(
  permission: TaskExecutionPermission
): ClaudePermissionMode {
  return permission === "workspace-write" ? "bypassPermissions" : "dontAsk";
}

/**
 * Builds CLI arguments for Claude Code CLI.
 * Uses -p for print mode (non-interactive).
 */
export function buildClaudeCliArgs(options: {
  permissionMode: ClaudePermissionMode;
  settingsPath?: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  resumeSessionId?: string | undefined;
  plannedSessionId?: string | undefined;
  sessionName?: string | undefined;
  model?: string;
}): string[] {
  const args = ["-p", "--permission-mode", options.permissionMode];

  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  } else if (options.plannedSessionId) {
    args.push("--session-id", options.plannedSessionId);
    if (options.sessionName) {
      args.push("--name", options.sessionName);
    }
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.settingsPath) {
    args.push("--settings", options.settingsPath);
  }

  if (options.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath, "--strict-mcp-config");
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }

  return args;
}

/**
 * Builds the MCP configuration object for Claude.
 */
export function buildClaudeMcpConfig(mcp: ClaudeMcpRuntime): Record<string, unknown> {
  return {
    mcpServers: {
      [mcp.serverName]: {
        type: "http",
        url: mcp.serverUrl
      }
    }
  };
}

/**
 * Builds the settings configuration object for Claude.
 */
export function buildClaudeSettings(options: {
  mcp?: ClaudeMcpRuntime;
  workspacePath?: string;
}): Record<string, unknown> {
  if (options.workspacePath) {
    return { trustedWorkspaces: [options.workspacePath] };
  }
  return {};
}

/**
 * Writes the MCP configuration to a file.
 */
export async function writeClaudeMcpConfig(
  path: string,
  mcp: ClaudeMcpRuntime
): Promise<void> {
  const config = buildClaudeMcpConfig(mcp);
  await fs.writeFile(path, JSON.stringify(config, null, 2));
}

/**
 * Writes the settings configuration to a file.
 */
export async function writeClaudeSettings(
  path: string,
  options: { mcp?: ClaudeMcpRuntime; workspacePath?: string }
): Promise<void> {
  const settings = buildClaudeSettings(options);
  await fs.writeFile(path, JSON.stringify(settings, null, 2));
}

/**
 * Generates the allow-list of tool names for Claude's --allowedTools flag.
 * Names follow the mcp__<serverName>__<toolName> pattern.
 */
export function buildClaudeAllowedTools(mcp: ClaudeMcpRuntime): string[] {
  return mcp.toolAllowList.map((tool) => {
    const normalizedToolName = tool.replaceAll(".", "_");
    return `mcp__${mcp.serverName}__${normalizedToolName}`;
  });
}

/**
 * Provides global launch instructions for Claude agents.
 */
export function buildGlobalClaudeLaunchInstructions(input: {
  mcp: ClaudeMcpRuntime;
}): string {
  const tools = buildClaudeAllowedTools(input.mcp).join(", ");

  return `
# Claude Code CLI Launch Instructions

You are running inside a managed orchestrator.
A local MCP server named "${input.mcp.serverName}" is available and pre-authorized.
The following tools are allowed: ${tools}.

## Operational Rules

1. Use the local MCP server for all GitHub operations (issues, PRs, comments, code search).
2. Do not use the "gh" CLI or other external GitHub tools directly for these tasks.
3. If a required GitHub capability is missing from the MCP server, report it as a limitation rather than attempting a bypass.
4. Adhere to the repository-local AGENTS.md instructions if present.
5. Any message you post to GitHub (via comments or PR descriptions) MUST begin with the "🤖" emoji.

Ready for task execution.
`.trim();
}

/**
 * Prepends global instructions to a prompt if MCP is configured.
 */
export function prependGlobalClaudeLaunchInstructions(
  promptText: string,
  options: { mcp?: ClaudeMcpRuntime }
): string {
  if (!options.mcp) {
    return promptText;
  }

  const instructions = buildGlobalClaudeLaunchInstructions({ mcp: options.mcp });
  return `${instructions}\n\n${promptText}`;
}
