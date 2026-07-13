import * as assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BACKBURNER_LABELS } from "../src/onboarding/config-writer.js";
import { GitHubLabelProvisioner } from "../src/onboarding/services/label-provisioner.js";
import { ProvisionLabelsStep } from "../src/onboarding/steps/provision-labels.js";
import { NonInteractivePrompter } from "../src/onboarding/prompt.js";
import type { CommandRunner, CommandRunnerResult } from "../src/utils/command-runner.js";
import type { ConfigDraft, OnboardingContext } from "../src/onboarding/types.js";

function ok(): CommandRunnerResult {
  return { stdout: "", stderr: "", exitCode: 0 };
}

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
    stepResults: new Map(),
    configDraft: makeDraft()
  };
}

function makeDraft(): ConfigDraft {
  return {
    codeRoot: "/code",
    managementDir: "/management",
    outputsDir: "/outputs",
    logDir: "/outputs/logs",
    workspacesDir: "/workspaces",
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
}

test("GitHubLabelProvisioner creates or updates labels with gh label create --force", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(command, args) {
      calls.push([command, ...args]);
      return Promise.resolve(ok());
    }
  };

  const provisioner = new GitHubLabelProvisioner(runner);
  const results = await provisioner.provisionLabels([
    {
      owner: "octocat",
      name: "test-work-agent",
      labels: [
        {
          name: "backburner:product-approved",
          description: "Approve Backburner to start product discovery from this issue.",
          color: "2DA44E"
        }
      ]
    }
  ]);

  assert.deepEqual(results, [
    {
      repoSlug: "octocat/test-work-agent",
      labelName: "backburner:product-approved",
      status: "created_or_updated"
    }
  ]);
  assert.deepEqual(calls[0], [
    "gh",
    "label",
    "create",
    "backburner:product-approved",
    "--repo",
    "octocat/test-work-agent",
    "--description",
    "Approve Backburner to start product discovery from this issue.",
    "--color",
    "2DA44E",
    "--force"
  ]);
});

test("ProvisionLabelsStep warns but does not fail when label creation fails", async () => {
  const runner: CommandRunner = {
    run() {
      return Promise.reject(new Error("permission denied"));
    }
  };

  const ctx = makeCtx();
  const result = await new ProvisionLabelsStep(runner).run(ctx, new NonInteractivePrompter());

  assert.equal(result.status, "warning");
  assert.match(result.message, /Created labels with 7 failures/);
  assert.ok(result.details?.some((detail) => detail.includes("https://github.com/octocat/test-work-agent/labels")));
  assert.ok(result.details?.some((detail) => detail.includes("backburner:product-approved")));
  assert.equal(ctx.warnings.length, 1);
});

test("ProvisionLabelsStep skips when no repositories are configured", async () => {
  const ctx = makeCtx();
  ctx.configDraft = { ...makeDraft(), repos: [] };
  const runner: CommandRunner = {
    run() {
      throw new Error("should not be called");
    }
  };

  const result = await new ProvisionLabelsStep(runner).run(ctx, new NonInteractivePrompter());

  assert.equal(result.status, "skipped");
});
