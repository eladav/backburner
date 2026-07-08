import type { OnboardingContext, OnboardingStep, Prompter, StepResult } from "../types.js";

export class WelcomeStep implements OnboardingStep {
  readonly name = "welcome";
  readonly description = "Welcome";

  async run(_ctx: OnboardingContext, _prompter: Prompter): Promise<StepResult> {
    const lines = [
      "",
      "Welcome to Backburner!",
      "",
      "This wizard configures Backburner to manage your GitHub repositories using local",
      "AI agents. Work flows through GitHub issues, comments, labels, and pull",
      "requests. Backburner runs locally and uses your existing credentials.",
      "",
      "You will be guided through:",
      "  1. Checking required tools",
      "  2. Validating GitHub authentication",
      "  3. Selecting repositories to manage",
      "  4. Configuring directories",
      "  5. Detecting available AI providers",
      "  6. Assigning models to agent roles",
      "  7. Generating configuration files",
      "  8. Running a final readiness check",
      ""
    ];

    process.stdout.write(lines.join("\n"));

    return { status: "passed", message: "Ready to begin" };
  }
}
