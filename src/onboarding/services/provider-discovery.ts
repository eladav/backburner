import type { CommandRunner } from "../../utils/command-runner.js";
import type { DiscoveredProvider, ProviderName } from "../types.js";

interface ProviderSpec {
  name: ProviderName;
  command: string;
  versionArgs: string[];
  versionExtract?: (stdout: string) => string;
  modelListCommands?: string[][];
}

const PROVIDER_SPECS: ProviderSpec[] = [
  {
    name: "claude",
    command: "claude",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim().split("\n")[0] ?? out.trim(),
    modelListCommands: [["models"], ["models", "list"], ["model", "list"]]
  },
  {
    name: "codex",
    command: "codex",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim(),
    modelListCommands: [["models"], ["models", "list"], ["model", "list"]]
  },
  {
    name: "gemini",
    command: "gemini",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim(),
    modelListCommands: [["models"], ["models", "list"], ["model", "list"]]
  },
  {
    name: "opencode",
    command: "opencode",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim(),
    modelListCommands: [["models"], ["models", "list"], ["model", "list"]]
  },
  {
    name: "antigravity",
    command: "agy",
    versionArgs: ["--version"],
    versionExtract: (out) => out.trim(),
    modelListCommands: [["models"], ["models", "list"], ["model", "list"]]
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
      const models = await this.discoverModels(spec);

      return {
        name: spec.name,
        command: spec.command,
        available: true,
        ...(version.length > 0 ? { version } : {}),
        ...(models.length > 0 ? { models } : {})
      };
    } catch {
      return { name: spec.name, command: spec.command, available: false };
    }
  }

  private async discoverModels(spec: ProviderSpec): Promise<string[]> {
    for (const args of spec.modelListCommands ?? []) {
      try {
        const result = await this.commandRunner.run(spec.command, args, {
          timeoutMs: 5_000
        });
        const models = parseModelListOutput(result.stdout);
        if (models.length > 0) {
          return models;
        }
      } catch {
        // Model listing is optional. Keep provider discovery available and fall back to defaults.
      }
    }
    return [];
  }
}

function parseModelListOutput(stdout: string): string[] {
  const models: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const model = normalizeModelListLine(rawLine);
    if (model.length === 0 || seen.has(model)) {
      continue;
    }
    models.push(model);
    seen.add(model);
  }

  return models;
}

function normalizeModelListLine(line: string): string {
  const withoutBullet = line
    .trim()
    .replace(/^[*\-]\s*/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim();

  if (withoutBullet.length === 0 || withoutBullet.startsWith("#")) {
    return "";
  }

  const jsonName = /"(?<key>id|name|model)"\s*:\s*"(?<value>[^"]+)"/.exec(withoutBullet);
  if (jsonName?.groups?.value !== undefined) {
    return jsonName.groups.value.trim();
  }

  const tableCells = withoutBullet.split("|").map((cell) => cell.trim()).filter(Boolean);
  if (tableCells.length > 0 && tableCells.every((cell) => /^-+$/.test(cell))) {
    return "";
  }
  if (tableCells.length > 1) {
    return stripAnnotation(tableCells[0] ?? "");
  }

  return stripAnnotation(withoutBullet);
}

function stripAnnotation(value: string): string {
  return value
    .replace(/\s+\((default|recommended|latest|beta|preview)\)$/i, "")
    .trim();
}
