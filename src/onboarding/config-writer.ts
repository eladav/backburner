import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../utils/json.js";
import type { AgentDraft, ConfigDraft, RepoDraft } from "./types.js";
import { DEFAULT_REVIEW_AUTOMATION_MAX_TURNS } from "../config/schemas.js";

export const DEFAULT_BACKBURNER_LABELS = {
  agentInProgress: "backburner:in-progress",
  agentPlanApproved: "backburner:plan-approved",
  agentProductApproved: "backburner:product-approved",
  agentReview: "backburner:review",
  planBreakdownNeeded: "backburner:plan-breakdown-needed",
  agentSyncParentBranch: "backburner:sync-parent-branch",
  prepareForMerge: "backburner:prepare-for-merge"
} as const;

export interface WriteConfigResult {
  reposFile: string;
  agentsFile: string;
  skippedExisting: string[];
}

export interface ExistingConfigSummary {
  reposExists: boolean;
  agentsExists: boolean;
  reposFile: string;
  agentsFile: string;
}

export class ConfigWriter {
  async detectExisting(managementDir: string): Promise<ExistingConfigSummary> {
    const reposFile = path.join(managementDir, "repos.json");
    const agentsFile = path.join(managementDir, "agents.json");

    const [reposExists, agentsExists] = await Promise.all([
      fileExists(reposFile),
      fileExists(agentsFile)
    ]);

    return { reposExists, agentsExists, reposFile, agentsFile };
  }

  /**
   * Write repos.json and agents.json into managementDir.
   *
   * @param overwriteRepos  When false, skips repos.json if it already exists.
   * @param overwriteAgents When false, skips agents.json if it already exists.
   */
  async write(
    draft: ConfigDraft,
    options: { overwriteRepos?: boolean; overwriteAgents?: boolean } = {}
  ): Promise<WriteConfigResult> {
    const { managementDir } = draft;
    await fs.mkdir(managementDir, { recursive: true });

    const reposFile = path.join(managementDir, "repos.json");
    const agentsFile = path.join(managementDir, "agents.json");
    const skippedExisting: string[] = [];

    const reposAlreadyExists = await fileExists(reposFile);
    if (!reposAlreadyExists || options.overwriteRepos) {
      await writeJsonFileAtomic(reposFile, buildReposJson(draft));
    } else {
      skippedExisting.push(reposFile);
    }

    const agentsAlreadyExists = await fileExists(agentsFile);
    if (!agentsAlreadyExists || options.overwriteAgents) {
      await writeJsonFileAtomic(agentsFile, buildAgentsJson(draft));
    } else {
      skippedExisting.push(agentsFile);
    }

    return { reposFile, agentsFile, skippedExisting };
  }
}

function buildReposJson(draft: ConfigDraft): unknown {
  return {
    allowedUsers: draft.allowedUsers,
    repos: draft.repos.map(buildRepoEntry)
  };
}

function buildRepoEntry(repo: RepoDraft): unknown {
  const id = `${repo.owner}-${repo.name}`;
  return {
    id,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    localPath: repo.localPath,
    enabled: repo.enabled,
    labels: repo.labels,
    reviewAutomation: repo.reviewAutomation ?? {
      maxTurns: DEFAULT_REVIEW_AUTOMATION_MAX_TURNS
    }
  };
}

function buildAgentsJson(draft: ConfigDraft): unknown {
  return {
    agents: draft.agents.map(buildAgentEntry)
  };
}

function buildAgentEntry(agent: AgentDraft): unknown {
  const base: Record<string, unknown> = {
    id: agent.id,
    provider: agent.provider,
    command: agent.command,
    modelClass: agent.modelClass,
    roles: agent.roles,
    enabled: agent.enabled
  };

  if (agent.timeoutMs !== undefined) {
    base["timeoutMs"] = agent.timeoutMs;
  }

  if (agent.model !== undefined) {
    base["model"] = agent.model;
  }

  return base;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
