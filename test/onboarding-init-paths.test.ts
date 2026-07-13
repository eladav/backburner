/**
 * Tests for Fix #1 and Fix #3:
 *
 * Fix #1: ConfigurePathsStep must use ctx values as prompt defaults,
 * so when NonInteractivePrompter returns the default, it returns the
 * flag-supplied value rather than a re-hardcoded ~/backburner-* path.
 *
 * Fix #3: deriveOverallStatus returns "failed" / "requiresUserAction" so
 * the CLI can set process.exitCode = 1.
 */
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ConfigurePathsStep } from "../src/onboarding/steps/configure-paths.js";
import { NonInteractivePrompter } from "../src/onboarding/prompt.js";
import { deriveOverallStatus } from "../src/onboarding/engine.js";
import type { OnboardingContext, StepResult } from "../src/onboarding/types.js";
import { expandHomePath, resolveUserPath } from "../src/utils/paths.js";

function makeCtx(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    codeRoot: "/code",
    managementDir: "/default/management",
    outputsDir: "/default/outputs",
    logDir: "/default/outputs/logs",
    workspacesDir: "/default/workspaces",
    discoveredRepos: [],
    selectedRepos: [],
    discoveredProviders: [],
    warnings: [],
    stepResults: new Map(),
    ...overrides
  };
}

// ── Fix #1: ctx values must survive ConfigurePathsStep in --yes mode ──────────

test("ConfigurePathsStep: preserves --management-dir flag in non-interactive mode", async () => {
  const ctx = makeCtx({ managementDir: "/tmp/mgmt" });
  const step = new ConfigurePathsStep();
  await step.run(ctx, new NonInteractivePrompter());
  assert.equal(ctx.managementDir, "/tmp/mgmt");
});

test("ConfigurePathsStep: preserves --outputs-dir flag in non-interactive mode", async () => {
  const ctx = makeCtx({ outputsDir: "/tmp/out" });
  const step = new ConfigurePathsStep();
  await step.run(ctx, new NonInteractivePrompter());
  assert.equal(ctx.outputsDir, "/tmp/out");
});

test("ConfigurePathsStep: preserves --log-dir flag in non-interactive mode", async () => {
  const ctx = makeCtx({ logDir: "/tmp/logs" });
  const step = new ConfigurePathsStep();
  await step.run(ctx, new NonInteractivePrompter());
  assert.equal(ctx.logDir, "/tmp/logs");
});

test("ConfigurePathsStep: preserves --workspaces-dir flag in non-interactive mode", async () => {
  const ctx = makeCtx({ workspacesDir: "/tmp/ws" });
  const step = new ConfigurePathsStep();
  await step.run(ctx, new NonInteractivePrompter());
  assert.equal(ctx.workspacesDir, "/tmp/ws");
});

test("ConfigurePathsStep: workspaces default is nested under code root", async () => {
  const ctx = makeCtx({ codeRoot: "/tmp/code", workspacesDir: "" });
  const step = new ConfigurePathsStep();
  await step.run(ctx, new NonInteractivePrompter());
  assert.equal(ctx.workspacesDir, "/tmp/code/_worktrees");
});

test("ConfigurePathsStep: all four flags preserved simultaneously", async () => {
  const ctx = makeCtx({
    managementDir: "/tmp/mgmt",
    outputsDir: "/tmp/out",
    logDir: "/tmp/logs",
    workspacesDir: "/tmp/ws"
  });
  const step = new ConfigurePathsStep();
  await step.run(ctx, new NonInteractivePrompter());

  assert.equal(ctx.managementDir, "/tmp/mgmt");
  assert.equal(ctx.outputsDir, "/tmp/out");
  assert.equal(ctx.logDir, "/tmp/logs");
  assert.equal(ctx.workspacesDir, "/tmp/ws");
});

test("ConfigurePathsStep: log dir default does not use hardcoded legacy output paths", async () => {
  // When logDir is empty but outputsDir is set, the computed default for logDir
  // must derive from outputsDir, not re-hardcode a legacy output location.
  const ctx = makeCtx({ outputsDir: "/custom/outputs", logDir: "" });
  const step = new ConfigurePathsStep();
  await step.run(ctx, new NonInteractivePrompter());

  assert.equal(ctx.outputsDir, "/custom/outputs");
  assert.ok(
    !ctx.logDir.includes("backburner-outputs"),
    `logDir must not reference hardcoded legacy outputs, got: ${ctx.logDir}`
  );
});

test("expandHomePath: expands only home-prefixed paths", () => {
  assert.equal(expandHomePath("~"), os.homedir());
  assert.equal(expandHomePath("~/backburner"), path.join(os.homedir(), "backburner"));
  assert.equal(expandHomePath("~literal"), "~literal");
});

test("resolveUserPath: expands home before resolving", () => {
  assert.equal(resolveUserPath("~/backburner"), path.resolve(os.homedir(), "backburner"));
});

test("ConfigurePathsStep: expands home-prefixed prompted paths", async () => {
  const ctx = makeCtx({
    managementDir: "~/.bb-demo/management",
    outputsDir: "~/.bb-demo/outputs",
    logDir: "~/.bb-demo/logs",
    workspacesDir: "~/.bb-demo/code/_worktrees"
  });
  const step = new ConfigurePathsStep();
  await step.run(ctx, new NonInteractivePrompter());

  assert.equal(ctx.managementDir, path.join(os.homedir(), ".bb-demo", "management"));
  assert.equal(ctx.outputsDir, path.join(os.homedir(), ".bb-demo", "outputs"));
  assert.equal(ctx.logDir, path.join(os.homedir(), ".bb-demo", "logs"));
  assert.equal(ctx.workspacesDir, path.join(os.homedir(), ".bb-demo", "code", "_worktrees"));
});

// ── Fix #3: deriveOverallStatus reflects failures so the CLI can exit(1) ──────

test("deriveOverallStatus: returns 'failed' when any step failed", () => {
  const results: StepResult[] = [
    { status: "passed", message: "ok" },
    { status: "failed", message: "something broke" }
  ];
  assert.equal(deriveOverallStatus(results), "failed");
});

test("deriveOverallStatus: returns 'requiresUserAction' when present and no failures", () => {
  const results: StepResult[] = [
    { status: "passed", message: "ok" },
    { status: "requiresUserAction", message: "please do something" }
  ];
  assert.equal(deriveOverallStatus(results), "requiresUserAction");
});

test("deriveOverallStatus: returns 'passed' when all passed", () => {
  const results: StepResult[] = [
    { status: "passed", message: "ok" },
    { status: "passed", message: "also ok" }
  ];
  assert.equal(deriveOverallStatus(results), "passed");
});
