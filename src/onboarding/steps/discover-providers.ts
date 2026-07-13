import type { CommandRunner } from "../../utils/command-runner.js";
import type { OnboardingContext, OnboardingStep, Prompter, StepResult } from "../types.js";
import { ProviderDiscoveryService } from "../services/provider-discovery.js";

export class DiscoverProvidersStep implements OnboardingStep {
  readonly name = "discover-providers";
  readonly description = "Detecting available AI providers";

  constructor(private readonly commandRunner: CommandRunner) {}

  async run(ctx: OnboardingContext, _prompter: Prompter): Promise<StepResult> {
    const service = new ProviderDiscoveryService(this.commandRunner);
    ctx.discoveredProviders = await service.discoverAll();

    const available = ctx.discoveredProviders.filter((p) => p.available);
    const unavailable = ctx.discoveredProviders.filter((p) => !p.available);

    const details = ctx.discoveredProviders.map((p) => {
      if (!p.available) {
        return `x ${p.name} (${p.command}): not found`;
      }

      const modelNote =
        p.models !== undefined && p.models.length > 0
          ? `, ${p.models.length} model${p.models.length === 1 ? "" : "s"} discovered`
          : ", model list unavailable";
      return `ok ${p.name} (${p.command}): ${p.version ?? "found"}${modelNote}`;
    });

    if (available.length === 0) {
      ctx.warnings.push(
        "No AI providers found. Install at least one of: antigravity, gemini, claude, codex, opencode"
      );
      return {
        status: "warning",
        message: "No AI providers found",
        details: [
          ...details,
          "",
          "Install at least one provider before running agents."
        ]
      };
    }

    const unavailableNote =
      unavailable.length > 0
        ? ` (${unavailable.length} not found)`
        : "";

    return {
      status: "passed",
      message: `${available.length} provider${available.length === 1 ? "" : "s"} available: ${available.map((p) => p.name).join(", ")}${unavailableNote}`,
      details
    };
  }
}
