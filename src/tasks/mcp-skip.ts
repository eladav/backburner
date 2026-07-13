// Matches: "mcp-skip: <taskId> <mcpHandle>"
// Case-insensitive prefix; tolerant of leading/trailing whitespace.
export const MCP_SKIP_PATTERN =
  /^\s*mcp-skip:\s+(\S+)\s+(\S+)\s*$/i;

export interface ParsedMcpSkipCommand {
  taskId: string;
  mcpHandle: string;
}

export function extractMcpSkipCommand(body: string): ParsedMcpSkipCommand | undefined {
  const match = MCP_SKIP_PATTERN.exec(body);
  if (!match) {
    return undefined;
  }
  return { taskId: match[1]!, mcpHandle: match[2]! };
}
