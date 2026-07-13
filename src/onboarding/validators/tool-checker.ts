import type { CommandRunner } from "../../utils/command-runner.js";
import type { ValidationIssue } from "../types.js";

export interface ToolCheckResult {
  name: string;
  command: string;
  available: boolean;
  version?: string;
  issue?: ValidationIssue;
}

export interface RequiredTool {
  name: string;
  command: string;
  versionArgs: string[];
  versionExtract?: (stdout: string) => string;
  /** Optional post-extraction version check. Return an issue string when invalid. */
  versionCheck?: (version: string) => string | undefined;
  installHint: string;
  required: boolean;
}

export type PlatformHelper = () => NodeJS.Platform;
export type ToolInstallTarget = "git" | "gh" | "node";

const REQUIRED_TOOLS: RequiredTool[] = [
  {
    name: "Git",
    command: "git",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim().replace("git version ", ""),
    installHint: getInstallHint("git"),
    required: true
  },
  {
    name: "GitHub CLI",
    command: "gh",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim().split("\n")[0] ?? out.trim(),
    installHint: getInstallHint("gh"),
    required: true
  },
  {
    name: "Node.js",
    command: "node",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim(),
    versionCheck: (version) => {
      const major = parseNodeMajor(version);
      if (major === undefined) {
        return `Could not parse Node.js version string: "${version}"`;
      }
      if (major < 20) {
        return `Node.js >= 20 is required (found ${version}).`;
      }
      return undefined;
    },
    installHint: getInstallHint("node"),
    required: true
  }
];

export class ToolChecker {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly platformHelper: PlatformHelper = getDefaultPlatform
  ) {}

  async checkTool(tool: RequiredTool): Promise<ToolCheckResult> {
    const installHint = getInstallHint(toInstallTarget(tool.command), this.platformHelper());

    try {
      const result = await this.commandRunner.run(tool.command, tool.versionArgs, {
        timeoutMs: 5_000
      });

      const version = tool.versionExtract?.(result.stdout) ?? result.stdout.trim();
      const versionError = tool.versionCheck?.(version);

      if (versionError !== undefined) {
        return {
          name: tool.name,
          command: tool.command,
          available: false,
          version,
          issue: {
            title: `${tool.name} version requirement not met`,
            cause: versionError,
            suggestedFix: installHint,
            canAutoRemediate: false,
            manualSteps: [installHint]
          }
        };
      }

      return { name: tool.name, command: tool.command, available: true, version };
    } catch {
      return {
        name: tool.name,
        command: tool.command,
        available: false,
        issue: {
          title: `${tool.name} not found`,
          cause: `The command "${tool.command}" is not available on PATH`,
          suggestedFix: installHint,
          canAutoRemediate: false,
          manualSteps: [installHint]
        }
      };
    }
  }

  async checkAll(): Promise<ToolCheckResult[]> {
    return Promise.all(REQUIRED_TOOLS.map((tool) => this.checkTool(tool)));
  }

  static getRequiredTools(): readonly RequiredTool[] {
    return REQUIRED_TOOLS;
  }
}

/** Parse the major version number from a Node.js version string like "v18.20.0". */
export function parseNodeMajor(version: string): number | undefined {
  const match = version.replace(/^v/, "").match(/^(\d+)/);
  if (!match?.[1]) return undefined;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

export function getDefaultPlatform(): NodeJS.Platform {
  return process.platform;
}

export function getInstallHint(
  tool: ToolInstallTarget,
  platform: NodeJS.Platform = getDefaultPlatform()
): string {
  switch (tool) {
    case "git":
      return gitInstallHint(platform);
    case "gh":
      return ghInstallHint(platform);
    case "node":
      return nodeInstallHint(platform);
  }
}

function gitInstallHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "Install Git with Homebrew (`brew install git`) or download it from https://git-scm.com/downloads";
  }
  if (platform === "win32") {
    return "Install Git with winget (`winget install Git.Git`) or download Git for Windows from https://git-scm.com/downloads/win";
  }
  if (platform === "linux") {
    return "Install Git with your distro package manager, for example `sudo apt install git` or `sudo dnf install git`; downloads: https://git-scm.com/downloads";
  }
  return "Install Git: https://git-scm.com/downloads";
}

function ghInstallHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "Install GitHub CLI with Homebrew (`brew install gh`) or follow https://cli.github.com";
  }
  if (platform === "win32") {
    return "Install GitHub CLI with winget (`winget install GitHub.cli`) or use the official installer/docs at https://cli.github.com";
  }
  if (platform === "linux") {
    return "Install GitHub CLI using the official Linux package instructions at https://cli.github.com";
  }
  return "Install GitHub CLI: https://cli.github.com";
}

function nodeInstallHint(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "Install Node.js >= 20 with winget (`winget install OpenJS.NodeJS.LTS`), fnm, or the official installer from https://nodejs.org";
  }
  if (platform === "darwin" || platform === "linux") {
    return "Install Node.js >= 20 with nvm, fnm, or the official downloads from https://nodejs.org";
  }
  return "Install Node.js >= 20: https://nodejs.org";
}

function toInstallTarget(command: string): ToolInstallTarget {
  if (command === "git") return "git";
  if (command === "gh") return "gh";
  if (command === "node") return "node";
  throw new Error(`No install hint configured for required tool command: ${command}`);
}
