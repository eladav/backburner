import * as assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubAuthChecker } from "../src/onboarding/validators/github-auth.js";
import type { CommandRunner, CommandRunnerResult } from "../src/utils/command-runner.js";

function stubRunner(
  responses: Record<string, CommandRunnerResult | Error>
): CommandRunner {
  return {
    run(command, args) {
      const key = [command, ...args].join(" ");
      const response = responses[key];
      if (response === undefined) {
        return Promise.reject(new Error(`Unexpected: ${key}`));
      }
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response);
    }
  };
}

function ok(stdout = "", stderr = ""): CommandRunnerResult {
  return { stdout, stderr, exitCode: 0 };
}

test("GitHubAuthChecker: authenticated with username in output", async () => {
  const runner = stubRunner({
    "gh auth status": ok(
      "",
      "Logged in to github.com account octocat (keyring)"
    )
  });

  const checker = new GitHubAuthChecker(runner);
  const result = await checker.check();

  assert.equal(result.authenticated, true);
  assert.equal(result.username, "octocat");
});

test("GitHubAuthChecker: known not-authenticated error returns user-action issue", async () => {
  const runner = stubRunner({
    "gh auth status": new Error(
      "You are not logged into any GitHub host. Run gh auth login to authenticate."
    )
  });

  const checker = new GitHubAuthChecker(runner);
  const result = await checker.check();

  assert.equal(result.authenticated, false);
  assert.ok(result.issue !== undefined);
  assert.match(result.issue.title, /not authenticated/i);
  assert.equal(result.issue.canAutoRemediate, false);
  assert.ok(result.issue.manualSteps !== undefined && result.issue.manualSteps.length > 0);
  assert.ok(result.issue.manualSteps.some((s) => s.includes("gh auth login")));
  assert.ok(result.issue.manualSteps.some((s) => s.includes("PowerShell")));
});

test("GitHubAuthChecker: unexpected gh failure is surfaced honestly", async () => {
  // This simulates a network timeout or a CLI crash — not a 'not logged in' error.
  const runner = stubRunner({
    "gh auth status": new Error("dial tcp: connection refused")
  });

  const checker = new GitHubAuthChecker(runner);
  const result = await checker.check();

  assert.equal(result.authenticated, false);
  assert.ok(result.issue !== undefined);
  // Must NOT report this as a 'not authenticated' issue
  assert.doesNotMatch(result.issue.title, /not authenticated/i);
  // Should mention the actual error
  assert.match(result.issue.cause, /connection refused/);
  assert.ok(
    result.issue.manualSteps !== undefined &&
    result.issue.manualSteps.some((s) => s.includes("gh auth status"))
  );
  assert.ok(result.issue.manualSteps.some((s) => s.includes("`gh --version`")));
});

test("GitHubAuthChecker.getAuthenticatedUser: returns trimmed username", async () => {
  const runner = stubRunner({
    "gh api user --jq .login": ok("octocat\n")
  });

  const checker = new GitHubAuthChecker(runner);
  const user = await checker.getAuthenticatedUser();
  assert.equal(user, "octocat");
});

test("GitHubAuthChecker.getAuthenticatedUser: returns undefined on error", async () => {
  const runner = stubRunner({
    "gh api user --jq .login": new Error("network error")
  });

  const checker = new GitHubAuthChecker(runner);
  const user = await checker.getAuthenticatedUser();
  assert.equal(user, undefined);
});
