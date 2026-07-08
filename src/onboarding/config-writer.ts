import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../utils/json.js";
import type { AgentDraft, ConfigDraft, RepoDraft } from "./types.js";

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
    labels: {
      agentInProgress: "agent-in-progress",
      agentPlanApproved: "agent-plan-approved",
      agentProductApproved: "agent-product-approved",
      agentReview: "agent-review",
      planBreakdownNeeded: "plan-breakdown-needed",
      agentSyncParentBranch: "agent-sync-parent-branch",
      prepareForMerge: "prepare-for-merge"
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
