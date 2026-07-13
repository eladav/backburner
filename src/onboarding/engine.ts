import type {
  OnboardingContext,
  OnboardingResult,
  OnboardingStep,
  Prompter,
  StepResult,
  StepStatus
} from "./types.js";

export interface OnboardingEngineOptions {
  /** When true the engine stops on the first failed step. Default: false. */
  stopOnFailure?: boolean;
}

export class OnboardingEngine {
  constructor(
    private readonly steps: OnboardingStep[],
    private readonly prompter: Prompter,
    private readonly options: OnboardingEngineOptions = {}
  ) {}

  async run(ctx: OnboardingContext): Promise<OnboardingResult> {
    const results: Array<{ stepName: string; result: StepResult }> = [];

    for (const step of this.steps) {
      process.stdout.write(`\n--- ${step.description} ---\n`);

      let result: StepResult;
      try {
        result = await step.run(ctx, this.prompter);
      } catch (err) {
        result = {
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
          issues: [
            {
              title: "Unexpected error in onboarding step",
              cause: err instanceof Error ? err.message : String(err),
              suggestedFix: "Check the error message above and retry",
              canAutoRemediate: false
            }
          ]
        };
      }

      ctx.stepResults.set(step.name, result);
      results.push({ stepName: step.name, result });

      const icon = statusIcon(result.status);
      process.stdout.write(`${icon} ${result.message}\n`);

      if (result.details) {
        for (const detail of result.details) {
          process.stdout.write(`  ${detail}\n`);
        }
      }

      if (result.issues) {
        for (const issue of result.issues) {
          process.stdout.write(`\n  Issue: ${issue.title}\n`);
          process.stdout.write(`  Cause: ${issue.cause}\n`);
          process.stdout.write(`  Fix:   ${issue.suggestedFix}\n`);
          if (issue.manualSteps) {
            process.stdout.write("  Steps:\n");
            for (const s of issue.manualSteps) {
              process.stdout.write(`    - ${s}\n`);
            }
          }
        }
      }

      if (result.status === "failed" && this.options.stopOnFailure) {
        break;
      }
    }

    const overallStatus = deriveOverallStatus(results.map((r) => r.result));
    return { context: ctx, results, overallStatus };
  }
}

function statusIcon(status: StepStatus): string {
  switch (status) {
    case "passed":
      return "✓";
    case "warning":
      return "⚠";
    case "failed":
      return "✗";
    case "skipped":
      return "-";
    case "requiresUserAction":
      return "!";
  }
}

export function deriveOverallStatus(results: StepResult[]): StepStatus {
  if (results.some((r) => r.status === "failed")) return "failed";
  if (results.some((r) => r.status === "requiresUserAction")) return "requiresUserAction";
  if (results.some((r) => r.status === "warning")) return "warning";
  if (results.every((r) => r.status === "skipped")) return "skipped";
  return "passed";
}
