import { deriveOverallStatus } from "../engine.js";
import * as path from "node:path";
import type { OnboardingContext, OnboardingStep, Prompter, StepResult } from "../types.js";
import {
  defaultBackburnerCodeRoot,
  defaultBackburnerManagementRoot,
  defaultBackburnerOutputsRoot
} from "../../utils/paths.js";

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
      lines.push("");
      lines.push("Next steps:");
      lines.push(
        "  1. Create the configured GitHub labels on each managed repository"
      );
      lines.push("  2. Start the orchestrator:");
      lines.push(`     ${buildRunCommand(ctx)}`);
      lines.push(
        "  3. Open an issue on a managed repo and apply the 'agent-plan-approved' label"
      );
      lines.push("  4. Watch Backburner pick it up on the next orchestration cycle");
    } else {
      lines.push("");
      lines.push("Fix the issues listed above, then re-run: backburner init");
    }

    lines.push("");
    process.stdout.write(lines.join("\n"));

    return { status: "passed", message: "Summary displayed" };
  }
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
