import { deriveOverallStatus } from "../engine.js";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { OnboardingContext, OnboardingStep, Prompter, StepResult } from "../types.js";
import {
  defaultBackburnerCodeRoot,
  defaultBackburnerManagementRoot,
  defaultBackburnerOutputsRoot
} from "../../utils/paths.js";

const require = createRequire(import.meta.url);

interface TerminalQrModule {
  generate(input: string, options: { small: boolean }, callback: (qr: string) => void): void;
}

const terminalQr = require("qrcode-terminal") as TerminalQrModule;

export class ShowSummaryStep implements OnboardingStep {
  readonly name = "show-summary";
  readonly description = "Summary";

  async run(ctx: OnboardingContext, _prompter: Prompter): Promise<StepResult> {
    // Derive status from steps that have already completed — the engine will
    // not have returned yet when this step runs, so we cannot rely on a
    // finalResult callback. ctx.stepResults is already fully populated up to
    // (but not including) this step.
    const priorResults = Array.from(ctx.stepResults.values());
    const overallStatus = deriveOverallStatus(priorResults);
    const succeeded = overallStatus === "passed" || overallStatus === "warning";

    const lines: string[] = ["", "=== Backburner Onboarding Complete ===", ""];

    // Paths
    lines.push("Directories:");
    lines.push(`  Code root:   ${ctx.codeRoot}`);
    lines.push(`  Management:  ${ctx.managementDir}`);
    lines.push(`  Outputs:     ${ctx.outputsDir}`);
    lines.push(`  Logs:        ${ctx.logDir}`);
    lines.push(`  Workspaces:  ${ctx.workspacesDir}`);

    // Repositories
    if (ctx.selectedRepos.length > 0) {
      lines.push("");
      lines.push("Repositories:");
      for (const repo of ctx.selectedRepos) {
        const note =
          repo.localPath !== undefined ? ` (${repo.localPath})` : " (no local clone)";
        lines.push(`  - ${repo.owner}/${repo.name}${note}`);
      }
    } else {
      lines.push("");
      lines.push("Repositories: none selected");
    }

    // Providers
    const available = ctx.discoveredProviders.filter((p) => p.available);
    if (available.length > 0) {
      lines.push("");
      lines.push("Providers:");
      for (const p of available) {
        lines.push(`  - ${p.name}${p.version !== undefined ? ` (${p.version})` : ""}`);
      }
    }

    // Agents
    const agents = ctx.configDraft?.agents ?? [];
    if (agents.length > 0) {
      lines.push("");
      lines.push("Configured agents:");
      for (const a of agents) {
        const model = a.model !== undefined ? ` (${a.model})` : "";
        lines.push(`  - ${a.id}: ${a.provider}${model} [${a.modelClass}]`);
        lines.push(`    Roles: ${a.roles.join(", ")}`);
      }
    }

    // Warnings
    if (ctx.warnings.length > 0) {
      lines.push("");
      lines.push("Warnings:");
      for (const w of ctx.warnings) {
        lines.push(`  ⚠ ${w}`);
      }
    }

    if (succeeded) {
      const issueTarget = buildFirstIssueTarget(ctx);
      lines.push("");
      lines.push("Next steps:");
      if (issueTarget !== undefined) {
        lines.push("  1. Open and submit your first Backburner issue:");
        lines.push(`     ${issueTarget.prefilledIssueUrl}`);
        lines.push("  2. Start the orchestrator and leave it running:");
        lines.push(`     ${buildRunCommand(ctx)}`);
        lines.push("  3. Continue from GitHub on your phone while this machine does the work");
        lines.push("");
        lines.push("Repository issues QR:");
        lines.push(renderQr(issueTarget.repositoryIssuesUrl));
      } else {
        lines.push("  1. Add a repository to repos.json");
        lines.push("  2. Open an issue on a managed repo with the configured product-approved label");
        lines.push("  3. Start the orchestrator and leave it running:");
        lines.push(`     ${buildRunCommand(ctx)}`);
      }
    } else {
      lines.push("");
      lines.push("Fix the issues listed above, then re-run: backburner init");
    }

    lines.push("");
    process.stdout.write(lines.join("\n"));

    return { status: "passed", message: "Summary displayed" };
  }
}

interface FirstIssueTarget {
  prefilledIssueUrl: string;
  repositoryIssuesUrl: string;
}

function buildFirstIssueTarget(ctx: OnboardingContext): FirstIssueTarget | undefined {
  const repo = ctx.configDraft?.repos[0];
  if (repo === undefined) {
    return undefined;
  }

  const url = new URL(`https://github.com/${repo.owner}/${repo.name}/issues/new`);
  url.searchParams.set("title", "Initialize a TypeScript React Native kitchen measurement converter");
  url.searchParams.set(
    "body",
    [
      "Create a small TypeScript React Native application for converting common kitchen measurements.",
      "",
      "Goal:",
      "- Let a cook enter a quantity, choose a source unit, choose a target unit, and see the converted value.",
      "",
      "Requirements:",
      "- Use TypeScript.",
      "- Support cups, tablespoons, teaspoons, milliliters, liters, fluid ounces, ounces, grams, and kilograms.",
      "- Include a simple conversion screen with clear input validation and useful empty/error states.",
      "- Keep the implementation small and easy to review.",
      "",
      "Acceptance criteria:",
      "- The app can convert at least 1 cup to tablespoons, milliliters, and fluid ounces.",
      "- Invalid or empty input does not crash the app.",
      "- Add or update tests for the conversion logic where the project test setup supports it."
    ].join("\n")
  );
  url.searchParams.set("labels", repo.labels.agentProductApproved);
  return {
    prefilledIssueUrl: url.toString(),
    repositoryIssuesUrl: `https://github.com/${repo.owner}/${repo.name}/issues`
  };
}

function renderQr(input: string): string {
  let rendered = "";
  terminalQr.generate(input, { small: true }, (qr) => {
    rendered = qr.trimEnd();
  });
  return rendered;
}

function buildRunCommand(ctx: OnboardingContext): string {
  const args = ["backburner", "run"];

  if (ctx.codeRoot !== defaultBackburnerCodeRoot()) {
    args.push("--code-root", ctx.codeRoot);
  }
  if (ctx.managementDir !== defaultBackburnerManagementRoot()) {
    args.push("--management-dir", ctx.managementDir);
  }
  if (ctx.outputsDir !== defaultBackburnerOutputsRoot()) {
    args.push("--outputs-dir", ctx.outputsDir);
  }
  if (ctx.logDir !== path.join(ctx.outputsDir, "logs")) {
    args.push("--log-dir", ctx.logDir);
  }

  return args.join(" ");
}
