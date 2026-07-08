import type { CommandRunner } from "../../utils/command-runner.js";
import type {
  OnboardingContext,
  OnboardingStep,
  Prompter,
  StepResult,
  ValidationIssue
} from "../types.js";
import { ToolChecker } from "../validators/tool-checker.js";

export class CheckRequirementsStep implements OnboardingStep {
  readonly name = "check-requirements";
  readonly description = "Checking required tools";

  constructor(private readonly commandRunner: CommandRunner) {}

  async run(ctx: OnboardingContext, _prompter: Prompter): Promise<StepResult> {
    const checker = new ToolChecker(this.commandRunner);
    const results = await checker.checkAll();

    const missing = results.filter((r) => !r.available);

    const details = results.map((r) =>
      r.available ? `✓ ${r.name}: ${r.version ?? "found"}` : `✗ ${r.name}: not found`
    );

    if (missing.length === 0) {
      return {
        status: "passed",
        message: `All ${results.length} required tools found`,
        details
      };
    }

    for (const r of missing) {
      ctx.warnings.push(`Required tool not found: ${r.name} (${r.command})`);
    }

    const issues: ValidationIssue[] = missing
      .map((r) => r.issue)
      .filter((issue): issue is ValidationIssue => issue !== undefined);

    return {
      status: "failed",
      message: `${missing.length} required tool(s) missing: ${missing.map((r) => r.name).join(", ")}`,
      details,
      issues
    };
  }
}
