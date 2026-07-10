import * as assert from "node:assert/strict";
import { test } from "node:test";
import { SelectReposStep } from "../src/onboarding/steps/select-repos.js";
import { NonInteractivePrompter } from "../src/onboarding/prompt.js";
import type { DiscoveredRepo, OnboardingContext, Prompter } from "../src/onboarding/types.js";

function makeCtx(repos: DiscoveredRepo[] = []): OnboardingContext {
  return {
    codeRoot: "/code",
    managementDir: "/management",
    outputsDir: "/outputs",
    logDir: "/outputs/logs",
    workspacesDir: "/workspaces",
    discoveredRepos: repos,
    selectedRepos: [],
    discoveredProviders: [],
    warnings: [],
    stepResults: new Map()
  };
}

/**
 * Prompter that answers each successive multiSelect call with the corresponding
 * entry from `indicesPerCall`. Falls back to the last entry for any extra calls.
 */
function selectingPrompter(indicesPerCall: number[][]): Prompter {
  let call = 0;
  return {
    ask: (_q, def) => Promise.resolve(def ?? ""),
    confirm: (_q, def) => Promise.resolve(def ?? true),
    choose: (_q, _opts, def) => Promise.resolve(def ?? 0),
    multiSelect: (_q, _opts, _pre) => {
      const indices = indicesPerCall[call] ?? indicesPerCall[indicesPerCall.length - 1] ?? [];
      call++;
      return Promise.resolve(indices);
    }
  };
}

const REPOS: DiscoveredRepo[] = [
  { owner: "org", name: "repo1", localPath: "/code/repo1", isLocalClone: true },
  { owner: "org", name: "repo2", isLocalClone: false },
  { owner: "org", name: "repo3", localPath: "/code/repo3", isLocalClone: true }
];

test("SelectReposStep: non-interactive mode pre-selects only local clones", async () => {
  const ctx = makeCtx(REPOS);
  const step = new SelectReposStep();
  const result = await step.run(ctx, new NonInteractivePrompter());

  assert.equal(result.status, "passed");
  assert.equal(ctx.selectedRepos.length, 2);
  assert.ok(ctx.selectedRepos.every((r) => r.isLocalClone));
});

test("SelectReposStep: selects subset of repos", async () => {
  const ctx = makeCtx(REPOS);
  const step = new SelectReposStep();
  const result = await step.run(ctx, selectingPrompter([[0, 2]]));

  assert.equal(result.status, "passed");
  assert.equal(ctx.selectedRepos.length, 2);
  assert.ok(ctx.selectedRepos.some((r) => r.name === "repo1"));
  assert.ok(ctx.selectedRepos.some((r) => r.name === "repo3"));
});

test("SelectReposStep: returns warning when no repos selected and user declines manual entry", async () => {
  const ctx = makeCtx(REPOS);
  const step = new SelectReposStep();
  const prompter: Prompter = {
    ask: (_q, def) => Promise.resolve(def ?? ""),
    confirm: (_q, _def) => Promise.resolve(false),  // declines manual entry
    choose: (_q, _opts, def) => Promise.resolve(def ?? 0),
    multiSelect: (_q, _opts, _pre) => Promise.resolve([])  // selects nothing
  };

  const result = await step.run(ctx, prompter);

  assert.equal(result.status, "warning");
  assert.equal(ctx.selectedRepos.length, 0);
});

test("SelectReposStep: prompts manual entry when no repos discovered", async () => {
  const ctx = makeCtx([]);  // no discovered repos
  const step = new SelectReposStep();
  const prompter: Prompter = {
    ask: (q, def) => {
      if (q.includes("owner")) return Promise.resolve("myorg");
      if (q.includes("name")) return Promise.resolve("my-repo");
      return Promise.resolve(def ?? "");  // empty local path
    },
    confirm: (_q, def) => Promise.resolve(def ?? true),
    choose: (_q, _opts, def) => Promise.resolve(def ?? 0),
    multiSelect: (_q, _opts, pre) => Promise.resolve(pre ?? [])
  };

  const result = await step.run(ctx, prompter);

  assert.equal(result.status, "passed");
  assert.equal(ctx.selectedRepos.length, 1);
  assert.equal(ctx.selectedRepos[0]?.owner, "myorg");
  assert.equal(ctx.selectedRepos[0]?.name, "my-repo");
});

test("SelectReposStep: returns warning when no repos and manual entry is empty", async () => {
  const ctx = makeCtx([]);
  const step = new SelectReposStep();
  const prompter: Prompter = {
    ask: () => Promise.resolve(""),  // empty owner and name
    confirm: (_q, def) => Promise.resolve(def ?? true),
    choose: (_q, _opts, def) => Promise.resolve(def ?? 0),
    multiSelect: (_q, _opts, pre) => Promise.resolve(pre ?? [])
  };

  const result = await step.run(ctx, prompter);
  assert.equal(result.status, "warning");
});

test("SelectReposStep: groups repos by account and prompts each separately", async () => {
  const multiOwnerRepos: DiscoveredRepo[] = [
    { owner: "example-org", name: "repo-a", localPath: "/code/repo-a", isLocalClone: true },
    { owner: "example-org", name: "repo-b", isLocalClone: false },
    { owner: "lama-finance", name: "api", localPath: "/code/api", isLocalClone: true },
    { owner: "lama-finance", name: "frontend", isLocalClone: false }
  ];

  const ctx = makeCtx(multiOwnerRepos);
  const step = new SelectReposStep();

  // First multiSelect call = example-org/ repos: select index 0 (repo-a)
  // Second multiSelect call = lama-finance/ repos: select index 0 and 1 (api, frontend)
  const questions: string[] = [];
  const prompter: Prompter = {
    ask: (_q, def) => Promise.resolve(def ?? ""),
    confirm: (_q, def) => Promise.resolve(def ?? true),
    choose: (_q, _opts, def) => Promise.resolve(def ?? 0),
    multiSelect: (q, _opts, _pre) => {
      questions.push(q);
      if (q.includes("example-org")) return Promise.resolve([0]);
      if (q.includes("lama-finance")) return Promise.resolve([0, 1]);
      return Promise.resolve([]);
    }
  };

  const result = await step.run(ctx, prompter);

  assert.equal(result.status, "passed");
  assert.equal(ctx.selectedRepos.length, 3);
  assert.ok(ctx.selectedRepos.some((r) => r.owner === "example-org" && r.name === "repo-a"));
  assert.ok(ctx.selectedRepos.some((r) => r.owner === "lama-finance" && r.name === "api"));
  assert.ok(ctx.selectedRepos.some((r) => r.owner === "lama-finance" && r.name === "frontend"));
  // Prompts are phrased per account
  assert.ok(questions.some((q) => q.includes("example-org/")));
  assert.ok(questions.some((q) => q.includes("lama-finance/")));
});
