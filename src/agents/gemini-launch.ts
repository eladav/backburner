import type { TaskExecutionPermission } from "../tasks/types.js";
import { writeJsonFileAtomic } from "../utils/json.js";

export type GeminiApprovalMode = "plan" | "yolo";
export const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
export const GEMINI_MODEL_FALLBACKS = [
  DEFAULT_GEMINI_MODEL,
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview"
] as const;
const GEMINI_HEADLESS_PROMPT = "";

export interface GeminiMcpRuntime {
  serverName: string;
  serverUrl: string;
  toolAllowList: string[];
}

/**
 * Maps orchestrator permissions to Gemini approval modes.
 * - read-only -> "plan"
 * - workspace-write -> "yolo"
 */
export function mapPermissionToApprovalMode(
  permission: TaskExecutionPermission
): GeminiApprovalMode {
  switch (permission) {
    case "read-only":
      return "plan";
    case "workspace-write":
      return "yolo";
  }
}

/**
 * Builds Gemini CLI arguments while sending the prompt over stdin.
 */
export function buildGeminiCliArgs(options: {
  approvalMode: GeminiApprovalMode;
  model?: string;
  outputFormat?: "text" | "json" | "stream-json";
  resumeSessionId?: string | undefined;
}): string[] {
  const args = [
    "--model",
    options.model ?? DEFAULT_GEMINI_MODEL,
    "--approval-mode",
    options.approvalMode,
    "--output-format",
    options.outputFormat ?? "text"
  ];

  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  args.push("--prompt", GEMINI_HEADLESS_PROMPT);
  return args;
}

export async function writeGeminiSystemSettings(
  settingsPath: string,
  options: { mcp?: GeminiMcpRuntime }
): Promise<void> {
  const settings = options.mcp ? buildMcpSettings(options.mcp) : {};
  await writeJsonFileAtomic(settingsPath, settings);
}

/**
 * Removes auth-switching env vars and points Gemini at a run-scoped system settings file.
 */
export function getGeminiEnvOverrides(systemSettingsPath: string): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = {
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath
  };

  // We explicitly want to reuse Google-account login and avoid drifting into API-key mode.
  const toRemove = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"];
  for (const key of toRemove) {
    overrides[key] = undefined;
  }

  return overrides;
}

/**
 * Builds Gemini MCP system settings for the local broker.
 * Inspection showed the broker uses streamable HTTP, so we use httpUrl.
 */
function buildMcpSettings(mcp: GeminiMcpRuntime): Record<string, unknown> {
  return {
    mcp: {
      allowed: [mcp.serverName]
    },
    mcpServers: {
      [mcp.serverName]: {
        httpUrl: mcp.serverUrl,
        includeTools: mcp.toolAllowList
      }
    }
  };
}

export function buildGlobalGeminiLaunchInstructions(input: {
  mcp: GeminiMcpRuntime;
}): string {
  return [
    "# Global Gemini Instructions",
    "",
    "These instructions apply across repositories for this orchestrated run.",
    "",
    "## MCP Server",
    `Use the local MCP server \`${input.mcp.serverName}\` for managed GitHub operations.`,
    "- Invoke broker tools instead of using `gh` directly.",
    "",
    "Enabled broker tools for this run:",
    ...input.mcp.toolAllowList.map((tool) => `- \`${tool}\``),
    "",
    "Any GitHub-authored message you post must begin with `🤖`."
  ].join("\n");
}

export function prependGlobalGeminiLaunchInstructions(
  promptText: string,
  options: { mcp?: GeminiMcpRuntime }
): string {
  if (!options.mcp) {
    return promptText;
  }

  return `${buildGlobalGeminiLaunchInstructions({ mcp: options.mcp })}\n\n${promptText}`;
}
