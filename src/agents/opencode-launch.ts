import { writeJsonFileAtomic } from "../utils/json.js";

export interface OpenCodeMcpRuntime {
  serverName: string;
  serverUrl: string;
  toolAllowList: string[];
}

/**
 * Builds OpenCode CLI arguments.
 * Prompt is passed as the last positional argument.
 */
export function buildOpenCodeCliArgs(options: {
  model: string;
  repoPath: string;
  promptText: string;
}): string[] {
  return [
    "run",
    "--model",
    options.model,
    "--format",
    "json",
    "--dir",
    options.repoPath,
    options.promptText
  ];
}

/**
 * Writes the per-run OpenCode config JSON that wires the broker MCP server.
 */
export async function writeOpenCodeConfig(
  configPath: string,
  options: { mcp?: OpenCodeMcpRuntime }
): Promise<void> {
  const config = options.mcp ? buildMcpConfig(options.mcp) : {};
  await writeJsonFileAtomic(configPath, config);
}

/**
 * Normalizes an MCP tool name for OpenCode.
 * OpenCode replaces characters outside [a-zA-Z0-9_-] with _.
 */
export function normalizeOpenCodeMcpToolName(serverName: string, toolName: string): string {
  const sanitizedTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${serverName}_${sanitizedTool}`;
}

/**
 * Builds the MCP configuration block.
 */
function buildMcpConfig(mcp: OpenCodeMcpRuntime): Record<string, unknown> {
  const tools: Record<string, boolean> = {
    [`${mcp.serverName}_*`]: false
  };
  for (const tool of mcp.toolAllowList) {
    tools[normalizeOpenCodeMcpToolName(mcp.serverName, tool)] = true;
  }
  return {
    mcp: {
      [mcp.serverName]: {
        type: "remote",
        url: mcp.serverUrl
      }
    },
    tools
  };
}

/**
 * Returns the env var that points OpenCode at the generated config.
 */
export function getOpenCodeEnvOverrides(configPath: string): NodeJS.ProcessEnv {
  return { OPENCODE_CONFIG: configPath };
}

/**
 * Normalizes OpenCode --format json output into assistant text.
 * Skips non-JSON lines and accumulates content from text/message events.
 */
export function extractOpenCodeAssistantText(streamText: string): string | undefined {
  if (!streamText.trim()) {
    return undefined;
  }

  let assistantText = "";
  let sawAssistantMessage = false;
  let fallbackResult: string | undefined;

  for (const line of streamText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!event || typeof event !== "object") {
      continue;
    }

    // Primary: type "text" with part.text (observed in implementation)
    if (event.type === "text" && event.part && typeof event.part.text === "string") {
      assistantText += event.part.text;
      sawAssistantMessage = true;
      continue;
    }

    // Secondary: type "message" with content (standard provider event)
    if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
      assistantText += event.content;
      sawAssistantMessage = true;
      continue;
    }

    // Fallback: type "result" or "output"
    if (!sawAssistantMessage && !fallbackResult) {
      if (event.type === "result" || event.type === "output") {
        if (typeof event.text === "string") {
          fallbackResult = event.text;
        } else if (event.part && typeof event.part.text === "string") {
          fallbackResult = event.part.text;
        } else if (typeof event.content === "string") {
          fallbackResult = event.content;
        }
      }
    }
  }

  if (sawAssistantMessage && assistantText.trim()) {
    return assistantText;
  }

  return fallbackResult;
}

export function buildGlobalOpenCodeLaunchInstructions(input: {
  mcp: OpenCodeMcpRuntime;
}): string {
  return [
    "# Global OpenCode Instructions",
    "",
    "These instructions apply across repositories for this orchestrated run.",
    "",
    "## MCP Server",
    `Use the local MCP server \`${input.mcp.serverName}\` for managed GitHub operations.`,
    "- Invoke broker tools instead of using \`gh\` directly.",
    "",
    "Enabled broker tools for this run:",
    ...input.mcp.toolAllowList.map((tool) => `- \`${normalizeOpenCodeMcpToolName(input.mcp.serverName, tool)}\``),
    "",
    "Any GitHub-authored message you post must begin with \`🤖\`."
  ].join("\n");
}

export function prependGlobalOpenCodeLaunchInstructions(
  promptText: string,
  options: { mcp?: OpenCodeMcpRuntime }
): string {
  if (!options.mcp) {
    return promptText;
  }

  return `${buildGlobalOpenCodeLaunchInstructions({ mcp: options.mcp })}\n\n${promptText}`;
}
