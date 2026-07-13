import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  ToolChecker,
  getInstallHint,
  parseNodeMajor
} from "../src/onboarding/validators/tool-checker.js";
import type { CommandRunner, CommandRunnerResult } from "../src/utils/command-runner.js";

function stubRunner(
  responses: Record<string, CommandRunnerResult | Error>
): CommandRunner {
  return {
    run(command, args) {
      const key = [command, ...args].join(" ");
      const response = responses[key];
      if (response === undefined) {
        return Promise.reject(new Error(`Unexpected command: ${key}`));
      }
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response);
    }
  };
}

function ok(stdout = ""): CommandRunnerResult {
  return { stdout, stderr: "", exitCode: 0 };
}

test("ToolChecker: all tools available", async () => {
  const runner = stubRunner({
    "git --version": ok("git version 2.45.0"),
    "gh --version": ok("gh version 2.50.0\nhttps://github.com/cli/cli"),
    "node --version": ok("v22.0.0")
  });

  const checker = new ToolChecker(runner);
  const results = await checker.checkAll();

  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.available));
  assert.equal(results[0]?.version, "2.45.0");
});

test("ToolChecker: git missing", async () => {
  const runner = stubRunner({
    "git --version": new Error("ENOENT"),
    "gh --version": ok("gh version 2.50.0"),
    "node --version": ok("v22.0.0")
  });

  const checker = new ToolChecker(runner);
  const results = await checker.checkAll();

  const git = results.find((r) => r.name === "Git");
  assert.ok(git !== undefined);
  assert.equal(git.available, false);
  assert.ok(git.issue !== undefined);
  assert.match(git.issue.title, /Git not found/i);
  assert.equal(git.issue.canAutoRemediate, false);
  assert.ok(git.issue.manualSteps !== undefined && git.issue.manualSteps.length > 0);
});

test("ToolChecker: git missing uses platform-specific Windows hint", async () => {
  const runner = stubRunner({
    "git --version": new Error("ENOENT"),
    "gh --version": ok("gh version 2.50.0"),
    "node --version": ok("v22.0.0")
  });

  const checker = new ToolChecker(runner, () => "win32");
  const results = await checker.checkAll();

  const git = results.find((r) => r.name === "Git");
  assert.ok(git !== undefined);
  assert.equal(git.available, false);
  assert.match(git.issue?.suggestedFix ?? "", /winget install Git\.Git/);
  assert.match(git.issue?.suggestedFix ?? "", /Git for Windows/);
});

test("ToolChecker: gh missing", async () => {
  const runner = stubRunner({
    "git --version": ok("git version 2.45.0"),
    "gh --version": new Error("ENOENT"),
    "node --version": ok("v22.0.0")
  });

  const checker = new ToolChecker(runner);
  const results = await checker.checkAll();

  const gh = results.find((r) => r.name === "GitHub CLI");
  assert.ok(gh !== undefined);
  assert.equal(gh.available, false);
  assert.match(gh.issue?.suggestedFix ?? "", /cli\.github\.com/);
});

test("ToolChecker: gh missing uses platform-specific Linux hint", async () => {
  const runner = stubRunner({
    "git --version": ok("git version 2.45.0"),
    "gh --version": new Error("ENOENT"),
    "node --version": ok("v22.0.0")
  });

  const checker = new ToolChecker(runner, () => "linux");
  const results = await checker.checkAll();

  const gh = results.find((r) => r.name === "GitHub CLI");
  assert.ok(gh !== undefined);
  assert.equal(gh.available, false);
  assert.match(gh.issue?.suggestedFix ?? "", /official Linux package instructions/);
  assert.match(gh.issue?.suggestedFix ?? "", /cli\.github\.com/);
});

// ── Node.js version enforcement ──────────────────────────────────────────────

test("ToolChecker: Node v18 is rejected with platform-specific hint", async () => {
  const runner = stubRunner({
    "git --version": ok("git version 2.45.0"),
    "gh --version": ok("gh version 2.50.0"),
    "node --version": ok("v18.20.8")
  });

  const checker = new ToolChecker(runner, () => "win32");
  const results = await checker.checkAll();

  const node = results.find((r) => r.name === "Node.js");
  assert.ok(node !== undefined);
  assert.equal(node.available, false, "Node v18 must be marked unavailable");
  assert.ok(node.issue !== undefined);
  assert.match(node.issue.cause, /18/);
  assert.match(node.issue.cause, /20/);
  assert.match(node.issue.suggestedFix, /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(node.issue.suggestedFix, /fnm/);
});

test("ToolChecker: Node v20 is accepted", async () => {
  const runner = stubRunner({
    "git --version": ok("git version 2.45.0"),
    "gh --version": ok("gh version 2.50.0"),
    "node --version": ok("v20.0.0")
  });

  const checker = new ToolChecker(runner);
  const results = await checker.checkAll();

  const node = results.find((r) => r.name === "Node.js");
  assert.ok(node !== undefined);
  assert.equal(node.available, true);
});

test("ToolChecker: Node v22 is accepted", async () => {
  const runner = stubRunner({
    "git --version": ok("git version 2.45.0"),
    "gh --version": ok("gh version 2.50.0"),
    "node --version": ok("v22.3.0")
  });

  const checker = new ToolChecker(runner);
  const results = await checker.checkAll();

  const node = results.find((r) => r.name === "Node.js");
  assert.ok(node !== undefined);
  assert.equal(node.available, true);
});

// ── parseNodeMajor ───────────────────────────────────────────────────────────

test("parseNodeMajor: parses v18.x", () => {
  assert.equal(parseNodeMajor("v18.20.8"), 18);
});

test("parseNodeMajor: parses v20.0.0 without leading v", () => {
  assert.equal(parseNodeMajor("20.0.0"), 20);
});

test("parseNodeMajor: returns undefined for garbage", () => {
  assert.equal(parseNodeMajor("not-a-version"), undefined);
});

test("ToolChecker: getRequiredTools returns stable list", () => {
  const tools = ToolChecker.getRequiredTools();
  assert.ok(tools.length >= 3);
  assert.ok(tools.some((t) => t.command === "git"));
  assert.ok(tools.some((t) => t.command === "gh"));
  assert.ok(tools.some((t) => t.command === "node"));
});

test("getInstallHint: returns deterministic platform hints", () => {
  assert.match(getInstallHint("git", "darwin"), /brew install git/);
  assert.match(getInstallHint("git", "win32"), /winget install Git\.Git/);
  assert.match(getInstallHint("git", "linux"), /sudo apt install git/);
  assert.match(getInstallHint("git", "linux"), /sudo dnf install git/);

  assert.match(getInstallHint("gh", "darwin"), /brew install gh/);
  assert.match(getInstallHint("gh", "win32"), /winget install GitHub\.cli/);
  assert.match(getInstallHint("gh", "linux"), /cli\.github\.com/);

  assert.match(getInstallHint("node", "darwin"), /nvm/);
  assert.match(getInstallHint("node", "linux"), /fnm/);
  assert.match(getInstallHint("node", "win32"), /winget install OpenJS\.NodeJS\.LTS/);
});
