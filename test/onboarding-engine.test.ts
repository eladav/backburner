import * as assert from "node:assert/strict";
import { test } from "node:test";
import { OnboardingEngine, deriveOverallStatus } from "../src/onboarding/engine.js";
import { ShowSummaryStep } from "../src/onboarding/steps/show-summary.js";
import type {
  OnboardingContext,
  OnboardingStep,
  Prompter,
  StepResult
} from "../src/onboarding/types.js";
import { NonInteractivePrompter } from "../src/onboarding/prompt.js";
import { DEFAULT_BACKBURNER_LABELS } from "../src/onboarding/config-writer.js";

function makeCtx(): OnboardingContext {
  return {
    codeRoot: "/code",
    managementDir: "/management",
    outputsDir: "/outputs",
    logDir: "/outputs/logs",
    workspacesDir: "/workspaces",
    discoveredRepos: [],
    selectedRepos: [],
    discoveredProviders: [],
    warnings: [],
    stepResults: new Map()
  };
}

function makeStep(name: string, result: StepResult): OnboardingStep {
  return {
    name,
    description: name,
    run: async () => result
  };
}

function makeThrowingStep(name: string): OnboardingStep {
  return {
    name,
    description: name,
    run: async () => {
      throw new Error("Step exploded");
    }
  };
}

test("OnboardingEngine: runs all steps and collects results", async () => {
  const steps = [
    makeStep("a", { status: "passed", message: "A ok" }),
    makeStep("b", { status: "passed", message: "B ok" }),
    makeStep("c", { status: "warning", message: "C warning" })
  ];

  const engine = new OnboardingEngine(steps, new NonInteractivePrompter());
  const result = await engine.run(makeCtx());

  assert.equal(result.results.length, 3);
  assert.equal(result.overallStatus, "warning");
  assert.equal(result.results[0]?.stepName, "a");
  assert.equal(result.results[2]?.result.status, "warning");
});

test("OnboardingEngine: catches step errors and marks as failed", async () => {
  const steps = [
    makeStep("a", { status: "passed", message: "ok" }),
    makeThrowingStep("boom"),
    makeStep("c", { status: "passed", message: "ok" })
  ];

  const engine = new OnboardingEngine(steps, new NonInteractivePrompter());
  const result = await engine.run(makeCtx());

  const boom = result.results.find((r) => r.stepName === "boom");
  assert.ok(boom !== undefined);
  assert.equal(boom.result.status, "failed");
  assert.match(boom.result.message, /exploded/);

  // Subsequent steps still ran
  assert.equal(result.results.length, 3);
  assert.equal(result.overallStatus, "failed");
});

test("OnboardingEngine: stopOnFailure stops after first failure", async () => {
  const steps = [
    makeStep("a", { status: "failed", message: "failed" }),
    makeStep("b", { status: "passed", message: "should not run" })
  ];

  const engine = new OnboardingEngine(steps, new NonInteractivePrompter(), {
    stopOnFailure: true
  });
  const result = await engine.run(makeCtx());

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.stepName, "a");
});

test("OnboardingEngine: stores step results on context", async () => {
  const steps = [makeStep("check", { status: "passed", message: "ok" })];
  const ctx = makeCtx();
  const engine = new OnboardingEngine(steps, new NonInteractivePrompter());
  await engine.run(ctx);

  assert.ok(ctx.stepResults.has("check"));
  assert.equal(ctx.stepResults.get("check")?.status, "passed");
});

// ── ShowSummaryStep reads ctx.stepResults, not a finalResult callback ─────────

test("ShowSummaryStep: prints remediation path when a prior step failed", async () => {
  let capturedOutput = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    capturedOutput += String(chunk);
    return true;
  };

  try {
    const ctx = makeCtx();
    // Simulate a failed earlier step already recorded in stepResults
    ctx.stepResults.set("check-requirements", {
      status: "failed",
      message: "git not found"
    });

    const step = new ShowSummaryStep();
    await step.run(ctx, new NonInteractivePrompter());

    assert.ok(
      capturedOutput.includes("Fix the issues listed above"),
      "Summary must show remediation message after failure"
    );
    assert.ok(
      !capturedOutput.includes("Next steps:"),
      "Summary must NOT print next steps after failure"
    );
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("ShowSummaryStep: prints next steps when all prior steps passed", async () => {
  let capturedOutput = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    capturedOutput += String(chunk);
    return true;
  };

  try {
    const ctx = makeCtx();
    ctx.stepResults.set("check-requirements", {
      status: "passed",
      message: "all good"
    });

    const step = new ShowSummaryStep();
    await step.run(ctx, new NonInteractivePrompter());

    assert.ok(
      capturedOutput.includes("Next steps:"),
      "Summary must print next steps when prior steps passed"
    );
    assert.ok(
      !capturedOutput.includes("Fix the issues"),
      "Summary must NOT show remediation when all passed"
    );
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("ShowSummaryStep: prints run command and configured issue URL", async () => {
  let capturedOutput = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    capturedOutput += String(chunk);
    return true;
  };

  try {
    const ctx = makeCtx();
    ctx.configDraft = {
      codeRoot: ctx.codeRoot,
      managementDir: ctx.managementDir,
      outputsDir: ctx.outputsDir,
      logDir: ctx.logDir,
      workspacesDir: ctx.workspacesDir,
      allowedUsers: ["octocat"],
      repos: [
        {
          owner: "octocat",
          name: "test-work-agent",
          localPath: "octocat/test-work-agent",
          defaultBranch: "main",
          enabled: true,
          labels: { ...DEFAULT_BACKBURNER_LABELS }
        }
      ],
      agents: []
    };
    ctx.stepResults.set("check-requirements", {
      status: "passed",
      message: "all good"
    });

    const step = new ShowSummaryStep();
    await step.run(ctx, new NonInteractivePrompter());

    assert.match(capturedOutput, /backburner run/);
    assert.match(capturedOutput, /https:\/\/github\.com\/octocat\/test-work-agent\/issues\/new/);
    assert.match(capturedOutput, /Initialize\+a\+TypeScript\+React\+Native\+kitchen\+measurement\+converter/);
    assert.match(capturedOutput, /Support\+cups/);
    assert.match(capturedOutput, /labels=backburner%3Aproduct-approved/);
    assert.match(capturedOutput, /Repository issues QR:/);
    const issueStep = capturedOutput.indexOf("1. Open and submit your first Backburner issue:");
    const runStep = capturedOutput.indexOf("2. Start the orchestrator and leave it running:");
    assert.ok(issueStep >= 0 && runStep > issueStep, "Issue creation must come before starting Backburner");
    assert.match(capturedOutput, /Continue from GitHub on your phone/);
    assert.doesNotMatch(capturedOutput, /press r/i);
  } finally {
    process.stdout.write = originalWrite;
  }
});

// ── deriveOverallStatus ───────────────────────────────────────────────────────

test("deriveOverallStatus: passed when all passed", () => {
  const results: StepResult[] = [
    { status: "passed", message: "ok" },
    { status: "skipped", message: "skipped" }
  ];
  assert.equal(deriveOverallStatus(results), "passed");
});

test("deriveOverallStatus: failed when any failed", () => {
  const results: StepResult[] = [
    { status: "passed", message: "ok" },
    { status: "failed", message: "bad" }
  ];
  assert.equal(deriveOverallStatus(results), "failed");
});

test("deriveOverallStatus: requiresUserAction when present and no failures", () => {
  const results: StepResult[] = [
    { status: "passed", message: "ok" },
    { status: "requiresUserAction", message: "do something" }
  ];
  assert.equal(deriveOverallStatus(results), "requiresUserAction");
});

test("deriveOverallStatus: warning when present and no failures/requiresUserAction", () => {
  const results: StepResult[] = [
    { status: "passed", message: "ok" },
    { status: "warning", message: "watch out" }
  ];
  assert.equal(deriveOverallStatus(results), "warning");
});

test("deriveOverallStatus: skipped when all skipped", () => {
  const results: StepResult[] = [
    { status: "skipped", message: "skip" },
    { status: "skipped", message: "skip" }
  ];
  assert.equal(deriveOverallStatus(results), "skipped");
});
