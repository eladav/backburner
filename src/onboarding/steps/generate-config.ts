import * as path from "node:path";
import type {
  ConfigDraft,
  DiscoveredRepo,
  OnboardingContext,
  OnboardingStep,
  Prompter,
  RepoDraft,
  StepResult
} from "../types.js";
import { ConfigWriter } from "../config-writer.js";

export class GenerateConfigStep implements OnboardingStep {
  readonly name = "generate-config";
  readonly description = "Generating configuration";

  async run(ctx: OnboardingContext, prompter: Prompter): Promise<StepResult> {
    const writer = new ConfigWriter();
    const existing = await writer.detectExisting(ctx.managementDir);

    if (existing.reposExists || existing.agentsExists) {
      const existingFiles: string[] = [];
      if (existing.reposExists) existingFiles.push(existing.reposFile);
      if (existing.agentsExists) existingFiles.push(existing.agentsFile);

      process.stdout.write("\nExisting configuration found:\n");
      for (const f of existingFiles) {
        process.stdout.write(`  ${f}\n`);
      }

      const overwrite = await prompter.confirm(
        "Overwrite existing configuration?",
        false
      );

      if (!overwrite) {
        ctx.warnings.push(
          "Configuration was not overwritten. Edit the files manually if needed."
        );
        return {
          status: "skipped",
          message: "Existing configuration preserved",
          details: existingFiles.map((f) => `Kept: ${f}`)
        };
      }
    }

    const draft = buildConfigDraft(ctx);
    ctx.configDraft = draft;

    try {
      const result = await writer.write(draft, {
        overwriteRepos: true,
        overwriteAgents: true
      });

      const details: string[] = [];
      if (!result.skippedExisting.includes(result.reposFile)) {
        details.push(`Written: ${result.reposFile}`);
      }
      if (!result.skippedExisting.includes(result.agentsFile)) {
        details.push(`Written: ${result.agentsFile}`);
      }
      for (const f of result.skippedExisting) {
        details.push(`Skipped (already exists): ${f}`);
      }

      return {
        status: "passed",
        message: "Configuration written",
        details
      };
    } catch (err) {
      return {
        status: "failed",
        message: `Failed to write configuration: ${err instanceof Error ? err.message : String(err)}`,
        issues: [
          {
            title: "Configuration write failed",
            cause: err instanceof Error ? err.message : String(err),
            suggestedFix: `Check that ${ctx.managementDir} is writable`,
            canAutoRemediate: false,
            manualSteps: [
              `Create the management directory if it does not exist: "${ctx.managementDir}"`,
              `Confirm your user can write to the management directory: "${ctx.managementDir}"`
            ]
          }
        ]
      };
    }
  }
}

function buildConfigDraft(ctx: OnboardingContext): ConfigDraft {
  const repos: RepoDraft[] = ctx.selectedRepos.map((repo) =>
    buildRepoDraft(repo, ctx.codeRoot)
  );

  const existing = ctx.configDraft;

  return {
    codeRoot: ctx.codeRoot,
    managementDir: ctx.managementDir,
    outputsDir: ctx.outputsDir,
    logDir: ctx.logDir,
    workspacesDir: ctx.workspacesDir,
    allowedUsers:
      existing?.allowedUsers ??
      (ctx.githubUser !== undefined ? [ctx.githubUser] : []),
    repos,
    agents: existing?.agents ?? []
  };
}

function buildRepoDraft(repo: DiscoveredRepo, codeRoot: string): RepoDraft {
  let localPath: string;

  if (repo.localPath !== undefined) {
    localPath = path.relative(codeRoot, repo.localPath);
    // Fall back to owner/name if the path escapes the code root
    if (localPath.startsWith("..")) {
      localPath = `${repo.owner}/${repo.name}`;
    }
  } else {
    localPath = `${repo.owner}/${repo.name}`;
  }

  return {
    owner: repo.owner,
    name: repo.name,
    localPath,
    defaultBranch: repo.defaultBranch || "main",
    enabled: true
  };
}
