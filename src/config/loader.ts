import * as path from "node:path";
import type { ZodType } from "zod";
import {
  AgentsConfigFileSchema,
  CapabilitiesConfigFileSchema,
  DEFAULT_GITHUB_BROKER_SERVER_NAME,
  DEFAULT_GITHUB_BROKER_TOOLS,
  McpsConfigFileSchema,
  PromptsConfigFileSchema,
  ReposConfigFileSchema
} from "./schemas.js";
import type {
  AgentConfig,
  BackburnerControllerCapability,
  BackburnerSensorCapability,
  GitHubBrokerConfig,
  McpDependency,
  NormalizedRepoConfig,
  NormalizedCapabilities,
  PromptsConfigFile
} from "./types.js";
import { readJsonFile } from "../utils/json.js";
import { managementRoot } from "../utils/paths.js";

export interface LoadedConfig {
  allowedUsers: string[];
  repos: NormalizedRepoConfig[];
  agents: AgentConfig[];
  codex: {
    githubBroker: GitHubBrokerConfig;
  };
  gemini: {
    githubBroker: GitHubBrokerConfig;
  };
  claude: {
    githubBroker: GitHubBrokerConfig;
  };
  opencode: {
    githubBroker: GitHubBrokerConfig;
  };
  antigravity: {
    githubBroker: GitHubBrokerConfig;
  };
  prompts?: PromptsConfigFile;
  mcps: McpDependency[];
  capabilities: {
    sensors: BackburnerSensorCapability[];
    controllers: BackburnerControllerCapability[];
  };
  maxConcurrentAgents: number;
}

function formatZodPath(pathParts: Array<any>): string {
  return pathParts
    .map((segment, index) => {
      if (typeof segment === "number") return `[${segment}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join("");
}

function parseConfig<T>(schema: ZodType<T>, value: unknown, filePath: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const schemaPath = issue ? formatZodPath(issue.path) : "";
  const message = issue?.message ?? "invalid configuration";
  const detail = schemaPath ? `${schemaPath} ${message}` : message;
  throw new Error(`${filePath}: ${detail}`);
}

function defaultGitHubBrokerConfig(): GitHubBrokerConfig {
  return {
    serverName: DEFAULT_GITHUB_BROKER_SERVER_NAME,
    toolAllowList: [...DEFAULT_GITHUB_BROKER_TOOLS]
  };
}

export async function loadConfig(baseDir = managementRoot): Promise<LoadedConfig> {
  const reposFile = path.join(baseDir, "repos.json");
  const agentsFile = path.join(baseDir, "agents.json");

  const reposConfig = parseConfig(
    ReposConfigFileSchema,
    await readJsonFile<unknown>(reposFile),
    reposFile
  );
  const agentsConfig = parseConfig(
    AgentsConfigFileSchema,
    await readJsonFile<unknown>(agentsFile),
    agentsFile
  );
  const prompts = await loadPromptsConfig(baseDir);
  const mcps = await loadMcpsConfig(baseDir);
  const capabilities = await loadCapabilitiesConfig(baseDir);

  const maxConcurrentAgents = resolveMaxConcurrentAgents(agentsConfig.maxConcurrentAgents);

  return {
    allowedUsers: reposConfig.allowedUsers,
    repos: reposConfig.repos,
    agents: agentsConfig.agents,
    codex: {
      githubBroker: agentsConfig.codex?.githubBroker ?? defaultGitHubBrokerConfig()
    },
    gemini: {
      githubBroker: agentsConfig.gemini?.githubBroker ?? defaultGitHubBrokerConfig()
    },
    claude: {
      githubBroker: agentsConfig.claude?.githubBroker ?? defaultGitHubBrokerConfig()
    },
    opencode: {
      githubBroker: agentsConfig.opencode?.githubBroker ?? defaultGitHubBrokerConfig()
    },
    antigravity: {
      githubBroker: agentsConfig.antigravity?.githubBroker ?? defaultGitHubBrokerConfig()
    },
    ...(prompts ? { prompts } : {}),
    mcps,
    capabilities,
    maxConcurrentAgents
  };
}

const DEFAULT_MAX_CONCURRENT_AGENTS = 1;

function resolveMaxConcurrentAgents(fromConfig: number | undefined): number {
  const fromEnv = process.env["BACKBURNER_MAX_CONCURRENT_AGENTS"];
  if (fromEnv !== undefined) {
    const parsed = parseInt(fromEnv, 10);
    if (!isNaN(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return fromConfig ?? DEFAULT_MAX_CONCURRENT_AGENTS;
}

export async function loadMcpsConfig(baseDir: string): Promise<McpDependency[]> {
  const mcpsFile = path.join(baseDir, "mcps.json");

  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(mcpsFile);
  } catch (err) {
    if (err instanceof Error && err.message.includes("file not found")) {
      return [];
    }
    throw err;
  }

  const config = parseConfig(McpsConfigFileSchema, raw, mcpsFile);
  return config.mcps.map((entry) => {
    if (typeof entry === "string") {
      return { handle: entry, smitheryId: entry };
    }
    return { handle: (entry as any).as, smitheryId: (entry as any).id };
  });
}

export async function loadCapabilitiesConfig(
  baseDir: string
): Promise<NormalizedCapabilities> {
  const capabilitiesFile = path.join(baseDir, "capabilities.json");

  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(capabilitiesFile);
  } catch (err) {
    if (err instanceof Error && err.message.includes("file not found")) {
      return { sensors: [], controllers: [] };
    }
    throw err;
  }

  const config = parseConfig(CapabilitiesConfigFileSchema, raw, capabilitiesFile);

  const sensors: BackburnerSensorCapability[] = Object.entries(config.sensors).map(
    ([name, sensor]) => ({
      name,
      uses: sensor.uses,
      observes: sensor.observes,
      ...(sensor.cadence !== undefined ? { cadence: sensor.cadence } : {}),
      ...(sensor.scope !== undefined ? { scope: sensor.scope } : {})
    })
  );

  const controllers: BackburnerControllerCapability[] = Object.entries(config.controllers).map(
    ([name, controller]) => ({
      name,
      uses: controller.uses,
      grants: controller.grants,
      approval: controller.approval
    })
  );

  return { sensors, controllers };
}

export async function loadPromptsConfig(
  baseDir: string
): Promise<PromptsConfigFile | undefined> {
  const promptsFile = path.join(baseDir, "prompts.json");

  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(promptsFile);
  } catch (err) {
    if (err instanceof Error && err.message.includes("file not found")) {
      return undefined;
    }
    throw err;
  }

  return parseConfig(PromptsConfigFileSchema, raw, promptsFile);
}
