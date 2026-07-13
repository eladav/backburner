import type { CommandRunner } from "../../utils/command-runner.js";
import type { OnboardingContext, OnboardingStep, Prompter, StepResult } from "../types.js";
import { GitHubAuthChecker } from "../validators/github-auth.js";

export class CheckGitHubAuthStep implements OnboardingStep {
  readonly name = "check-github-auth";
  readonly description = "Validating GitHub authentication";

  constructor(private readonly commandRunner: CommandRunner) {}

  async run(ctx: OnboardingContext, _prompter: Prompter): Promise<StepResult> {
    const checker = new GitHubAuthChecker(this.commandRunner);
    const authResult = await checker.check();

    if (!authResult.authenticated) {
      return {
        status: "requiresUserAction",
        message: "Not authenticated with GitHub",
        issues: authResult.issue !== undefined ? [authResult.issue] : []
      };
    }

    let username = authResult.username;
    if (username === undefined || username.length === 0) {
      username = await checker.getAuthenticatedUser();
    }

    if (username !== undefined && username.length > 0) {
      ctx.githubUser = username;
    }

    return {
      status: "passed",
      message: `Authenticated as ${username ?? "unknown"}`,
      ...(username !== undefined ? { details: [`GitHub user: ${username}`] } : {})
    };
  }
}
