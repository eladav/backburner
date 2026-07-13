import * as path from "node:path";
import {
  defaultBackburnerManagementRoot,
  defaultBackburnerOutputsRoot,
  defaultWorkspacesRootForCodeRoot,
  resolveUserPath
} from "../../utils/paths.js";
import type { OnboardingContext, OnboardingStep, Prompter, StepResult } from "../types.js";

export class ConfigurePathsStep implements OnboardingStep {
  readonly name = "configure-paths";
  readonly description = "Configure directories";

  async run(ctx: OnboardingContext, prompter: Prompter): Promise<StepResult> {
    // Use current ctx values as defaults so that CLI-supplied flags are preserved.
    // Only fall back to ~/.backburner/* when the context has no value (shouldn't happen
    // if runInit initialised ctx properly, but is a safety net).
    const defaultManagement = ctx.managementDir || defaultBackburnerManagementRoot();
    const defaultOutputs = ctx.outputsDir || defaultBackburnerOutputsRoot();
    const defaultLog = ctx.logDir || path.join(defaultOutputs, "logs");
    const defaultWorkspaces =
      ctx.workspacesDir || defaultWorkspacesRootForCodeRoot(ctx.codeRoot);

    const managementDir = await prompter.ask(
      "Management directory (Backburner config and prompt files):",
      defaultManagement
    );

    const outputsDir = await prompter.ask(
      "Outputs directory (state, logs):",
      defaultOutputs
    );

    const logDir = await prompter.ask(
      "Log directory:",
      ctx.logDir || path.join(outputsDir || defaultOutputs, "logs")
    );

    const workspacesDir = await prompter.ask(
      "Local workspaces directory (where Backburner creates git worktrees):",
      defaultWorkspaces
    );

    ctx.managementDir = resolveUserPath(managementDir || defaultManagement);
    ctx.outputsDir = resolveUserPath(outputsDir || defaultOutputs);
    ctx.logDir = resolveUserPath(logDir || path.join(ctx.outputsDir, "logs"));
    ctx.workspacesDir = resolveUserPath(workspacesDir || defaultWorkspaces);

    return {
      status: "passed",
      message: "Directories configured",
      details: [
        `Management: ${ctx.managementDir}`,
        `Outputs:    ${ctx.outputsDir}`,
        `Logs:       ${ctx.logDir}`,
        `Workspaces: ${ctx.workspacesDir}`
      ]
    };
  }
}
