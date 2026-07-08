import type { CommandRunner } from "../../utils/command-runner.js";
import type { DiscoveredProvider, ProviderName } from "../types.js";

interface ProviderSpec {
  name: ProviderName;
  command: string;
  versionArgs: string[];
  versionExtract?: (stdout: string) => string;
}

const PROVIDER_SPECS: ProviderSpec[] = [
  {
    name: "claude",
    command: "claude",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim().split("\n")[0] ?? out.trim()
  },
  {
    name: "codex",
    command: "codex",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim()
  },
  {
    name: "gemini",
    command: "gemini",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim()
  },
  {
    name: "opencode",
    command: "opencode",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim()
  },
  {
    name: "antigravity",
    command: "agy",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim()
  }
];

export class ProviderDiscoveryService {
  constructor(private readonly commandRunner: CommandRunner) {}

  async discoverAll(): Promise<DiscoveredProvider[]> {
    return Promise.all(PROVIDER_SPECS.map((spec) => this.checkProvider(spec)));
  }

  private async checkProvider(spec: ProviderSpec): Promise<DiscoveredProvider> {
    try {
      const result = await this.commandRunner.run(spec.command, spec.versionArgs, {
        timeoutMs: 5_000
      });

      const version = spec.versionExtract?.(result.stdout) ?? result.stdout.trim();

      return {
        name: spec.name,
        command: spec.command,
        available: true,
        ...(version.length > 0 ? { version } : {})
      };
    } catch {
      return { name: spec.name, command: spec.command, available: false };
    }
  }
}
