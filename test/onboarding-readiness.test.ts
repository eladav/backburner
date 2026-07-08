import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ReadinessValidationStep } from "../src/onboarding/steps/readiness-validation.js";
import { NonInteractivePrompter } from "../src/onboarding/prompt.js";
import { buildWorkspacePermissionManualSteps } from "../src/onboarding/validators/workspace.js";
import type { CommandRunner, CommandRunnerResult } from "../src/utils/command-runner.js";
import type { OnboardingContext } from "../src/onboarding/types.js";

function stubRunner(
  responses: Record<string, CommandRunnerResult | Error>
): CommandRunner {
  return {
    run(command, args) {
      const key = [command, ...args].join(" ");
      for (const [pattern, response] of Object.entries(responses)) {
        if (key === pattern || key.startsWith(pattern)) {
          if (response instanceof Error) return Promise.reject(response);
          return Promise.resolve(response);
        }
      }
      return Promise.reject(new Error(`Unexpected: ${key}`));
    }
  };
}

function ok(stdout = "", stderr = ""): CommandRunnerResult {
  return { stdout, stderr, exitCode: 0 };
}

function makeCtx(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    codeRoot: "/code",
    managementDir: "/management",
    outputsDir: "/outputs",
    logDir: "/outputs/logs",
    workspacesDir: "/workspaces",
    discoveredRepos: [],
    selectedRepos: [],
    discoveredProviders: [],
    configDraft: {
      codeRoot: "/code",
      managementDir: "/management",
      outputsDir: "/outputs",
      logDir: "/outputs/logs",
      workspacesDir: "/workspaces",
      allowedUsers: ["octocat"],
      repos: [],
      agents: [
        {
          id: "strong",
          provider: "claude",
          command: "claude",
          modelClass: "strong",
          roles: ["product", "planning", "review", "discussion"],
          enabled: true
        }
      ]
    },
    warnings: [],
    stepResults: new Map(),
    ...overrides
  };
}

test("ReadinessValidationStep: all checks pass", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-readiness-pass-"));

  try {
    const runner = stubRunner({
      "git --version": ok("git version 2.45.0"),
      "gh --version": ok("gh version 2.50.0"),
      "node --version": ok("v22.0.0"),
      "gh auth status": ok("", "Logged in to github.com account octocat (keyring)")
    });

    const ctx = makeCtx({
      managementDir: tmpDir,
      outputsDir: tmpDir,
      logDir: tmpDir,
      workspacesDir: tmpDir,
      discoveredProviders: [
        { name: "claude", command: "claude", available: true, version: "1.0.0" }
      ]
    });

    const step = new ReadinessValidationStep(runner);
    const result = await step.run(ctx, new NonInteractivePrompter());

    assert.equal(result.status, "passed");
    assert.ok(!result.issues || result.issues.length === 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ReadinessValidationStep: creates configured directories", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-readiness-create-dirs-"));

  try {
    const runner = stubRunner({
      "git --version": ok("git version 2.45.0"),
      "gh --version": ok("gh version 2.50.0"),
      "node --version": ok("v22.0.0"),
      "gh auth status": ok("", "Logged in to github.com account octocat (keyring)")
    });

    const managementDir = path.join(tmpDir, "management");
    const outputsDir = path.join(tmpDir, "outputs");
    const logDir = path.join(outputsDir, "logs");
    const workspacesDir = path.join(tmpDir, "workspaces");
    const ctx = makeCtx({
      managementDir,
      outputsDir,
      logDir,
      workspacesDir,
      discoveredProviders: [
        { name: "claude", command: "claude", available: true, version: "1.0.0" }
      ]
    });

    const step = new ReadinessValidationStep(runner);
    const result = await step.run(ctx, new NonInteractivePrompter());

    assert.equal(result.status, "passed");
    assert.equal((await fs.stat(managementDir)).isDirectory(), true);
    assert.equal((await fs.stat(outputsDir)).isDirectory(), true);
    assert.equal((await fs.stat(logDir)).isDirectory(), true);
    assert.equal((await fs.stat(workspacesDir)).isDirectory(), true);
    assert.ok(result.details?.some((detail) => detail === `✓ ${logDir}: created`));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ReadinessValidationStep: creates nested workspace directory under missing code root", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-readiness-nested-workspaces-"));

  try {
    const runner = stubRunner({
      "git --version": ok("git version 2.45.0"),
      "gh --version": ok("gh version 2.50.0"),
      "node --version": ok("v22.0.0"),
      "gh auth status": ok("", "Logged in to github.com account octocat (keyring)")
    });

    const managementDir = path.join(tmpDir, "management");
    const outputsDir = path.join(tmpDir, "outputs");
    const logDir = path.join(outputsDir, "logs");
    const workspacesDir = path.join(tmpDir, "code", "_worktrees");
    const ctx = makeCtx({
      managementDir,
      outputsDir,
      logDir,
      workspacesDir,
      discoveredProviders: [
        { name: "claude", command: "claude", available: true, version: "1.0.0" }
      ]
    });

    const step = new ReadinessValidationStep(runner);
    const result = await step.run(ctx, new NonInteractivePrompter());

    assert.equal(result.status, "passed");
    assert.equal((await fs.stat(workspacesDir)).isDirectory(), true);
    assert.ok(result.details?.some((detail) => detail === `✓ ${workspacesDir}: created`));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ReadinessValidationStep: missing git fails", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-readiness-no-git-"));

  try {
    const runner = stubRunner({
      "git --version": new Error("ENOENT"),
      "gh --version": ok("gh version 2.50.0"),
      "node --version": ok("v22.0.0"),
      "gh auth status": ok("", "Logged in to github.com account octocat (keyring)")
    });

    const ctx = makeCtx({
      managementDir: tmpDir,
      outputsDir: tmpDir,
      workspacesDir: tmpDir,
      discoveredProviders: [
        { name: "claude", command: "claude", available: true }
      ]
    });

    const step = new ReadinessValidationStep(runner, () => "win32");
    const result = await step.run(ctx, new NonInteractivePrompter());

    assert.equal(result.status, "failed");
    const gitIssue = result.issues?.find((i) => i.title.includes("Git"));
    assert.ok(gitIssue !== undefined);
    assert.match(gitIssue.suggestedFix, /winget install Git\.Git/);
    assert.match(gitIssue.manualSteps?.join("\n") ?? "", /Git for Windows/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ReadinessValidationStep: missing GitHub auth fails", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-readiness-no-auth-"));

  try {
    const runner = stubRunner({
      "git --version": ok("git version 2.45.0"),
      "gh --version": ok("gh version 2.50.0"),
      "node --version": ok("v22.0.0"),
      "gh auth status": new Error("not logged in")
    });

    const ctx = makeCtx({
      managementDir: tmpDir,
      outputsDir: tmpDir,
      workspacesDir: tmpDir,
      discoveredProviders: [
        { name: "claude", command: "claude", available: true }
      ]
    });

    const step = new ReadinessValidationStep(runner);
    const result = await step.run(ctx, new NonInteractivePrompter());

    assert.equal(result.status, "failed");
    const authIssue = result.issues?.find((i) =>
      i.title.toLowerCase().includes("authenticated")
    );
    assert.ok(authIssue !== undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ReadinessValidationStep: missing push permissions is warning not failure", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-readiness-no-push-"));

  try {
    const repoDir = path.join(tmpDir, "my-repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });

    const runner = stubRunner({
      "git --version": ok("git version 2.45.0"),
      "gh --version": ok("gh version 2.50.0"),
      "node --version": ok("v22.0.0"),
      "gh auth status": ok("", "Logged in to github.com account octocat (keyring)"),
      "git fetch --dry-run origin": ok(),
      "git push --dry-run --porcelain origin HEAD": new Error("403 Forbidden")
    });

    const ctx = makeCtx({
      managementDir: tmpDir,
      outputsDir: tmpDir,
      workspacesDir: tmpDir,
      selectedRepos: [
        {
          owner: "myorg",
          name: "my-repo",
          localPath: repoDir,
          isLocalClone: true
        }
      ],
      discoveredProviders: [
        { name: "claude", command: "claude", available: true }
      ]
    });

    const step = new ReadinessValidationStep(runner);
    const result = await step.run(ctx, new NonInteractivePrompter());

    // Push failure is a warning, not fatal
    assert.equal(result.status, "warning");
    const pushIssue = result.issues?.find((i) =>
      i.title.toLowerCase().includes("push")
    );
    assert.ok(pushIssue !== undefined);
    assert.match(pushIssue.cause, new RegExp(`"${repoDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.ok(pushIssue.manualSteps?.some((stepText) => stepText.includes(`"${repoDir}"`)));
    assert.ok(!pushIssue.manualSteps?.some((stepText) => stepText.startsWith("cd ")));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ReadinessValidationStep: no providers found is warning", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-readiness-no-providers-"));

  try {
    const runner = stubRunner({
      "git --version": ok("git version 2.45.0"),
      "gh --version": ok("gh version 2.50.0"),
      "node --version": ok("v22.0.0"),
      "gh auth status": ok("", "Logged in to github.com account octocat (keyring)")
    });

    const ctx = makeCtx({
      managementDir: tmpDir,
      outputsDir: tmpDir,
      workspacesDir: tmpDir,
      discoveredProviders: [
        { name: "claude", command: "claude", available: false },
        { name: "codex", command: "codex", available: false },
        { name: "opencode", command: "opencode", available: false },
        { name: "antigravity", command: "agy", available: false }
      ]
    });

    const step = new ReadinessValidationStep(runner);
    const result = await step.run(ctx, new NonInteractivePrompter());

    // No providers is a warning (tools and auth are fine)
    assert.equal(result.status, "warning");
    const providerIssue = result.issues?.find((i) =>
      i.title.toLowerCase().includes("provider")
    );
    assert.ok(providerIssue !== undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ReadinessValidationStep: missing product agent is warning", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-readiness-no-product-"));

  try {
    const runner = stubRunner({
      "git --version": ok("git version 2.45.0"),
      "gh --version": ok("gh version 2.50.0"),
      "node --version": ok("v22.0.0"),
      "gh auth status": ok("", "Logged in to github.com account octocat (keyring)")
    });

    const ctx = makeCtx({
      managementDir: tmpDir,
      outputsDir: tmpDir,
      workspacesDir: tmpDir,
      discoveredProviders: [
        { name: "claude", command: "claude", available: true, version: "1.0.0" }
      ],
      configDraft: {
        codeRoot: "/code",
        managementDir: tmpDir,
        outputsDir: tmpDir,
        logDir: path.join(tmpDir, "logs"),
        workspacesDir: tmpDir,
        allowedUsers: ["octocat"],
        repos: [],
        agents: [
          {
            id: "strong",
            provider: "claude",
            command: "claude",
            modelClass: "strong",
            roles: ["planning", "review", "discussion"],
            enabled: true
          }
        ]
      }
    });

    const step = new ReadinessValidationStep(runner);
    const result = await step.run(ctx, new NonInteractivePrompter());

    assert.equal(result.status, "warning");
    assert.ok(result.issues?.some((issue) => issue.title === "No Product agent configured"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("WorkspaceChecker: permission remediation is platform-aware", () => {
  const windowsSteps = buildWorkspacePermissionManualSteps("C:\\work\\management", "win32");
  const linuxSteps = buildWorkspacePermissionManualSteps("/work/management", "linux");

  assert.match(windowsSteps.join("\n"), /directory properties/i);
  assert.doesNotMatch(windowsSteps.join("\n"), /chmod/);
  assert.match(linuxSteps.join("\n"), /chmod u\+w/);
});
