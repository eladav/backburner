import type {
  DiscoveredRepo,
  OnboardingContext,
  OnboardingStep,
  Prompter,
  StepResult
} from "../types.js";
import { defaultDemoRepoName, DemoRepoCreator } from "../services/demo-repo.js";

export class SelectReposStep implements OnboardingStep {
  readonly name = "select-repos";
  readonly description = "Select repositories to manage";

  constructor(
    private readonly demoRepoCreator?: DemoRepoCreator,
    private readonly defaultSetupChoice: "demo" | "existing" = "demo"
  ) {}

  async run(ctx: OnboardingContext, prompter: Prompter): Promise<StepResult> {
    const { discoveredRepos } = ctx;

    const setupChoice = await this.promptSetupChoice(ctx, prompter);
    if (setupChoice === "demo") {
      return await this.promptCreateDemoRepo(ctx, prompter);
    }
    if (setupChoice === "skip") {
      return this.noRepositoryWarning();
    }

    if (discoveredRepos.length === 0) {
      return await this.promptManualEntry(ctx, prompter);
    }

    const byOwner = new Map<string, DiscoveredRepo[]>();
    for (const repo of discoveredRepos) {
      const group = byOwner.get(repo.owner) ?? [];
      group.push(repo);
      byOwner.set(repo.owner, group);
    }

    const selected: DiscoveredRepo[] = [];

    for (const [owner, repos] of byOwner) {
      const options = repos.map((repo) => {
        const note = repo.isLocalClone
          ? ` [local: ${repo.localPath ?? "?"}]`
          : " [GitHub only]";
        return `${repo.name}${note}`;
      });

      const preSelected = repos.flatMap((repo, i) => (repo.isLocalClone ? [i] : []));
      const selectedIndices = await prompter.multiSelect(
        `Select repositories from ${owner}/:`,
        options,
        preSelected
      );

      for (const i of selectedIndices) {
        const repo = repos[i];
        if (repo !== undefined) selected.push(repo);
      }
    }

    if (selected.length === 0) {
      return await this.promptNoSelection(ctx, prompter);
    }

    ctx.selectedRepos = selected;

    return {
      status: "passed",
      message: `${ctx.selectedRepos.length} repositor${ctx.selectedRepos.length === 1 ? "y" : "ies"} selected`,
      details: ctx.selectedRepos.map((r) => {
        const note = r.localPath !== undefined ? ` (${r.localPath})` : " (no local clone)";
        return `${r.owner}/${r.name}${note}`;
      })
    };
  }

  private async promptSetupChoice(
    ctx: OnboardingContext,
    prompter: Prompter
  ): Promise<"existing" | "demo" | "skip"> {
    const hasDiscoveredRepos = ctx.discoveredRepos.length > 0;
    const existingLabel = hasDiscoveredRepos
      ? "Select existing repositories (Backburner will create/update its labels on them)"
      : "Enter an existing repository manually";
    const hasDemoOption = ctx.githubUser !== undefined;
    const options = hasDemoOption
      ? ["Create a private Backburner demo repo", existingLabel, "Skip repository setup for now"]
      : [existingLabel, "Skip repository setup for now"];

    const defaultIndex = hasDemoOption && this.defaultSetupChoice === "existing" ? 1 : 0;
    const choice = await prompter.choose(
      "How do you want to set up repositories?",
      options,
      defaultIndex
    );

    if (hasDemoOption) {
      if (choice === 0) {
        return "demo";
      }
      if (choice === 1) {
        return "existing";
      }
      return "skip";
    }

    if (choice === 0) {
      return "existing";
    }

    return "skip";
  }

  private async promptNoSelection(
    ctx: OnboardingContext,
    prompter: Prompter
  ): Promise<StepResult> {
    const hasDemoOption = ctx.githubUser !== undefined;
    const options = hasDemoOption
      ? [
          "Create a private Backburner demo repo",
          "Add an existing repository manually",
          "Skip repository setup for now"
        ]
      : ["Add an existing repository manually", "Skip repository setup for now"];
    const defaultIndex = 0;
    const choice = await prompter.choose(
      "No repositories selected. How do you want to continue?",
      options,
      defaultIndex
    );

    if (hasDemoOption) {
      if (choice === 0) {
        return await this.promptCreateDemoRepo(ctx, prompter);
      }
      if (choice === 1) {
        return await this.promptManualEntry(ctx, prompter);
      }
      return this.noRepositoryWarning();
    }

    if (choice === 0) {
      return await this.promptManualEntry(ctx, prompter);
    }

    return this.noRepositoryWarning();
  }

  private async promptCreateDemoRepo(
    ctx: OnboardingContext,
    prompter: Prompter
  ): Promise<StepResult> {
    if (ctx.githubUser === undefined) {
      return this.noRepositoryWarning();
    }

    if (this.demoRepoCreator === undefined) {
      return {
        status: "warning",
        message: "Private demo repo creation is unavailable",
        details: ["You can create a private repository manually and re-run onboarding."]
      };
    }

    const repoName = (
      await prompter.ask("Private demo repository name:", defaultDemoRepoName())
    ).trim();

    if (!isValidRepoName(repoName)) {
      return {
        status: "warning",
        message: "Private demo repo was not created",
        details: ["Repository names can contain letters, numbers, dots, underscores, and hyphens."]
      };
    }

    const confirmed = await prompter.confirm(
      `Create private GitHub repository ${ctx.githubUser}/${repoName} and clone it under ${ctx.codeRoot}?`,
      true
    );

    if (!confirmed) {
      return this.noRepositoryWarning();
    }

    try {
      const repo = await this.demoRepoCreator.createPrivateDemoRepo({
        owner: ctx.githubUser,
        name: repoName,
        codeRoot: ctx.codeRoot
      });
      ctx.discoveredRepos = [repo, ...ctx.discoveredRepos];
      ctx.selectedRepos = [repo];

      return {
        status: "passed",
        message: `Private demo repository selected: ${repo.owner}/${repo.name}`,
        details: [
          "Visibility: private",
          `Local clone: ${repo.localPath ?? `${repo.owner}/${repo.name}`}`
        ]
      };
    } catch (err) {
      return {
        status: "failed",
        message: `Failed to create private demo repo: ${err instanceof Error ? err.message : String(err)}`,
        issues: [
          {
            title: "Private demo repo creation failed",
            cause: err instanceof Error ? err.message : String(err),
            suggestedFix: "Create a private GitHub repository manually, clone it locally, then re-run onboarding.",
            canAutoRemediate: false
          }
        ]
      };
    }
  }

  private async promptManualEntry(
    ctx: OnboardingContext,
    prompter: Prompter
  ): Promise<StepResult> {
    const owner = (await prompter.ask("Repository owner (e.g. myorg):")).trim();
    const name = (await prompter.ask("Repository name (e.g. my-repo):")).trim();

    if (owner.length === 0 || name.length === 0) {
      return {
        status: "warning",
        message: "No repository entered",
        details: ["You can add repositories by editing repos.json later."]
      };
    }

    const localPath = (
      await prompter.ask(`Local path to the clone (leave empty if not cloned):`)
    ).trim();

    const repo: DiscoveredRepo = {
      owner,
      name,
      isLocalClone: localPath.length > 0,
      ...(localPath.length > 0 ? { localPath } : {})
    };

    ctx.discoveredRepos = [repo];
    ctx.selectedRepos = [repo];

    return {
      status: "passed",
      message: `1 repository selected: ${owner}/${name}`
    };
  }

  private noRepositoryWarning(): StepResult {
    return {
      status: "warning",
      message: "No repositories selected",
      details: ["You can add repositories by editing repos.json later."]
    };
  }
}

function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}
