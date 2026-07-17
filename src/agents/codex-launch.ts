export interface CodexGitHubBrokerRuntime {
  serverName: string;
  serverUrl: string;
  toolAllowList: string[];
}

export type CodexSandboxMode = "read-only" | "workspace-write";

export interface ResolvedCodexLaunchConfig {
  executionPermission: "read-only" | "workspace-write";
  sandboxMode: CodexSandboxMode;
  expectsPushableHandoff: boolean;
  orchestratorOwnsPush: boolean;
  remotePublishOwner: "orchestrator";
}

export function resolveCodexLaunchConfig(input: {
  executionPermission: "read-only" | "workspace-write";
  handoffPolicy: {
    expectsPushableHandoff: boolean;
    orchestratorOwnsPush: boolean;
    remotePublishOwner: "orchestrator";
  };
}): ResolvedCodexLaunchConfig {
  return {
    executionPermission: input.executionPermission,
    sandboxMode: mapExecutionPermissionToSandboxMode(input.executionPermission),
    expectsPushableHandoff: input.handoffPolicy.expectsPushableHandoff,
    orchestratorOwnsPush: input.handoffPolicy.orchestratorOwnsPush,
    remotePublishOwner: input.handoffPolicy.remotePublishOwner
  };
}

export function mapExecutionPermissionToSandboxMode(
  executionPermission: "read-only" | "workspace-write"
): CodexSandboxMode {
  switch (executionPermission) {
    case "read-only":
      return "read-only";
    case "workspace-write":
      return "workspace-write";
  }
}

export function buildCodexCliArgs(input: {
  sandboxMode: CodexSandboxMode;
  githubBroker?: CodexGitHubBrokerRuntime;
  resumeThreadId?: string | undefined;
  model?: string;
}): string[] {
  const args = ["exec", "--json", "--sandbox", input.sandboxMode, "--skip-git-repo-check", "--color", "never"];

  if (input.sandboxMode === "workspace-write") {
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }

  if (input.githubBroker) {
    const safeServerName = toCodexCliSafeServerName(input.githubBroker.serverName);
    args.push(
      "-c",
      `mcp_servers.${safeServerName}.url=${quoteTomlString(input.githubBroker.serverUrl)}`,
      "-c",
      `mcp_servers.${safeServerName}.default_tools_approval_mode="approve"`
    );
  }

  if (input.model) {
    args.push("--model", input.model);
  }

  if (input.resumeThreadId) {
    args.push("resume", input.resumeThreadId);
  }

  args.push("-");
  return args;
}

export function buildGlobalCodexLaunchInstructions(input: {
  githubBroker: CodexGitHubBrokerRuntime;
}): string {
  return [
    "# Global Codex Instructions",
    "",
    "These instructions apply across repositories for this orchestrated run.",
    "",
    "## MCP Server",
    `Use the local MCP server \`${input.githubBroker.serverName}\` for normal GitHub reads and writes.`,
    "- Do not call `gh` directly for normal GitHub issue, pull request, comment, or code-search work.",
    "",
    "## When To Use It",
    "- Use the broker for normal GitHub context gathering and GitHub write actions.",
    "- Repo-local `AGENTS.md` files still apply for repository-specific build, test, and style rules.",
    "",
    "## Local Command Working Directory",
    "- Codex already starts in the exact target repository. For repo-local shell commands, use that current workspace instead of inventing or shortening a workdir.",
    "- If a tool requires an explicit workdir, copy the exact local path from the task packet. Do not reconstruct it from branch or task names.",
    "- If a command fails before producing output with a missing-file or `ENOENT` error, verify the workdir first.",
    "",
    "Enabled broker tools for this run:",
    ...input.githubBroker.toolAllowList.map((tool) => `- \`${tool}\``),
    "",
    "## Fallback",
    "- If a needed GitHub capability is missing from the broker, report the gap clearly instead of silently bypassing it.",
    "- Continue with local repository work where possible while making the missing broker capability explicit.",
    "- Any GitHub-authored message you post must begin with `🤖` when the task requires writing back to GitHub.",
    ""
  ].join("\n");
}

export function prependGlobalLaunchInstructions(promptText: string, input: {
  githubBroker?: CodexGitHubBrokerRuntime;
}): string {
  if (!input.githubBroker) {
    return promptText;
  }

  return `${buildGlobalCodexLaunchInstructions({ githubBroker: input.githubBroker })}\n\n${promptText}`;
}

export function toCodexCliSafeServerName(value: string): string {
  const segments = value
    .split(/[^a-zA-Z0-9]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return "githubBroker";
  }

  return segments
    .map((segment, index) =>
      index === 0
        ? segment[0]!.toLowerCase() + segment.slice(1)
        : segment[0]!.toUpperCase() + segment.slice(1)
    )
    .join("");
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}
