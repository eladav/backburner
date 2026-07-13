import type { CommandRunner } from "../../utils/command-runner.js";
import type { OnboardingContext, OnboardingStep, Prompter, StepResult } from "../types.js";
import { RepoDiscoveryService } from "../services/repo-discovery.js";

export class DiscoverReposStep implements OnboardingStep {
  readonly name = "discover-repos";
  readonly description = "Discovering repositories";

  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly codeRoot: string
  ) {}

  async run(ctx: OnboardingContext, _prompter: Prompter): Promise<StepResult> {
    const service = new RepoDiscoveryService(this.commandRunner);

    const [githubRepos, localRepos] = await Promise.all([
      service.discoverGitHubRepos(),
      service.discoverLocalRepos([this.codeRoot])
    ]);

    ctx.discoveredRepos = service.mergeRepos(githubRepos, localRepos);

    const localCount = ctx.discoveredRepos.filter((r) => r.isLocalClone).length;
    const remoteOnlyCount = ctx.discoveredRepos.length - localCount;

    if (ctx.discoveredRepos.length === 0) {
      return {
        status: "warning",
        message: "No repositories discovered",
        details: [
          "No GitHub repos found and no git repos found under the code root.",
          "You can enter a repository manually in the next step."
        ]
      };
    }

    return {
      status: "passed",
      message: `Found ${ctx.discoveredRepos.length} repositories`,
      details: [
        `${localCount} with a local clone`,
        `${remoteOnlyCount} on GitHub without a local clone`
      ]
    };
  }
}
