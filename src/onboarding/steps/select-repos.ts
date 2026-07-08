import type {
  DiscoveredRepo,
  OnboardingContext,
  OnboardingStep,
  Prompter,
  StepResult
} from "../types.js";

export class SelectReposStep implements OnboardingStep {
  readonly name = "select-repos";
  readonly description = "Select repositories to manage";

  async run(ctx: OnboardingContext, prompter: Prompter): Promise<StepResult> {
    const { discoveredRepos } = ctx;

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
      const fallback = await prompter.confirm(
        "No repositories selected. Add one manually?",
        true
      );
      if (fallback) {
        return await this.promptManualEntry(ctx, prompter);
      }

      return {
        status: "warning",
        message: "No repositories selected",
        details: ["You can add repositories by editing repos.json later."]
      };
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
}
