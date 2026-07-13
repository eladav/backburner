import type { CommandRunner } from "../../utils/command-runner.js";
import type { ValidationIssue } from "../types.js";

export interface GitAccessCheckResult {
  canFetch: boolean;
  canPush: boolean;
  fetchIssue?: ValidationIssue;
  pushIssue?: ValidationIssue;
}

export class GitAccessChecker {
  constructor(private readonly commandRunner: CommandRunner) {}

  async checkFetch(repoPath: string, remote = "origin"): Promise<boolean> {
    try {
      await this.commandRunner.run("git", ["fetch", "--dry-run", remote], {
        cwd: repoPath,
        timeoutMs: 30_000
      });
      return true;
    } catch {
      return false;
    }
  }

  async checkPush(repoPath: string, remote = "origin"): Promise<boolean> {
    try {
      await this.commandRunner.run(
        "git",
        ["push", "--dry-run", "--porcelain", remote, "HEAD"],
        { cwd: repoPath, timeoutMs: 30_000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  async check(repoPath: string): Promise<GitAccessCheckResult> {
    const [canFetch, canPush] = await Promise.all([
      this.checkFetch(repoPath),
      this.checkPush(repoPath)
    ]);

    const result: GitAccessCheckResult = { canFetch, canPush };

    if (!canFetch) {
      result.fetchIssue = {
        title: "Cannot fetch from remote",
        cause: `git fetch --dry-run failed for repository at "${repoPath}"`,
        suggestedFix: "Verify the remote URL and network or credential access",
        canAutoRemediate: false,
        manualSteps: [
          `Open a terminal in the repository directory: "${repoPath}"`,
          "Run `git remote -v` to verify the remote URL",
          "Run `gh auth setup-git` to configure git to use your GitHub credentials",
          "Run `git fetch origin` to attempt the fetch manually"
        ]
      };
    }

    if (!canPush) {
      result.pushIssue = {
        title: "Cannot push to remote",
        cause: `git push --dry-run failed for repository at "${repoPath}"`,
        suggestedFix: "Verify push permissions on GitHub",
        canAutoRemediate: false,
        manualSteps: [
          `Open a terminal in the repository directory: "${repoPath}"`,
          "Run `gh auth setup-git` to configure git to use your GitHub credentials",
          "Run `git push --dry-run origin HEAD` to attempt the push manually",
          "Check that you have write access to the repository on GitHub"
        ]
      };
    }

    return result;
  }
}
