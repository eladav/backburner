import type { GitGateway } from "./types.js";

export type ManagementGitOpsStatus = "skipped_not_git" | "pulled";

export type OutputsGitOpsStatus =
  | "skipped_not_git"
  | "clean_before_run"
  | "no_changes"
  | "pushed";

export interface ManagementGitOpsResult {
  status: ManagementGitOpsStatus;
}

export interface OutputsGitOpsResult {
  status: OutputsGitOpsStatus;
  commitSha?: string;
}

export class GitOpsLifecycleService {
  constructor(private readonly gitGateway: GitGateway) {}

  async prepareManagementRoot(managementDir: string): Promise<ManagementGitOpsResult> {
    const isGit = await this.gitGateway.isInsideWorkingTree(managementDir);
    if (!isGit) {
      return { status: "skipped_not_git" };
    }

    const isClean = await this.gitGateway.isWorkingTreeClean(managementDir);
    if (!isClean) {
      throw new Error(`Management directory is dirty: ${managementDir}`);
    }

    try {
      await this.gitGateway.pullFastForwardOnly(managementDir);
    } catch (error: unknown) {
      throw new Error(
        `Failed to pull management directory (fast-forward only): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return { status: "pulled" };
  }

  async prepareOutputsRoot(outputsDir: string): Promise<OutputsGitOpsResult> {
    const isGit = await this.gitGateway.isInsideWorkingTree(outputsDir);
    if (!isGit) {
      return { status: "skipped_not_git" };
    }

    const isClean = await this.gitGateway.isWorkingTreeClean(outputsDir);
    if (!isClean) {
      throw new Error(`Outputs directory is dirty: ${outputsDir}`);
    }

    return { status: "clean_before_run" };
  }

  async finalizeOutputsRoot(
    outputsDir: string,
    startedAt: string,
    prepared: OutputsGitOpsResult
  ): Promise<OutputsGitOpsResult> {
    if (prepared.status === "skipped_not_git") {
      return prepared;
    }

    const branch = await this.gitGateway.getCurrentBranch(outputsDir);
    if (!branch) {
      throw new Error(`Outputs directory is in a detached HEAD state: ${outputsDir}`);
    }

    const message = `Record orchestrator run ${startedAt}`;
    const committed = await this.gitGateway.commitAll(outputsDir, message);

    if (!committed) {
      return { status: "no_changes" };
    }

    const commitSha = await this.gitGateway.getHeadCommitSha(outputsDir);

    try {
      await this.gitGateway.pushBranch(outputsDir, branch);
    } catch (error: unknown) {
      throw new Error(
        `Failed to push outputs branch "${branch}" (commit ${commitSha}): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return { status: "pushed", commitSha };
  }
}
