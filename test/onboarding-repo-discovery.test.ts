import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { RepoDiscoveryService } from "../src/onboarding/services/repo-discovery.js";
import type { CommandRunner, CommandRunnerResult } from "../src/utils/command-runner.js";

function stubRunner(
  responses: Record<string, CommandRunnerResult | Error>
): CommandRunner {
  return {
    run(command, args) {
      const key = [command, ...args].join(" ");
      // Support prefix matching for commands with variable cwd
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

function ok(stdout = ""): CommandRunnerResult {
  return { stdout, stderr: "", exitCode: 0 };
}

const SAMPLE_GH_REPOS = JSON.stringify([
  {
    name: "my-repo",
    owner: { login: "myorg" },
    defaultBranchRef: { name: "main" }
  },
  {
    name: "other-repo",
    owner: { login: "myorg" },
    defaultBranchRef: { name: "develop" }
  }
]);

test("RepoDiscoveryService: discovers GitHub repos for personal account", async () => {
  const runner = stubRunner({
    "gh api user --jq .login": ok("myorg\n"),
    "gh api user/orgs --jq .[].login": ok(""),
    "gh repo list myorg --json name,owner,defaultBranchRef --limit 100": ok(SAMPLE_GH_REPOS)
  });

  const service = new RepoDiscoveryService(runner);
  const repos = await service.discoverGitHubRepos();

  assert.equal(repos.length, 2);
  assert.equal(repos[0]?.owner, "myorg");
  assert.equal(repos[0]?.name, "my-repo");
  assert.equal(repos[0]?.defaultBranch, "main");
  assert.equal(repos[0]?.isLocalClone, false);
});

test("RepoDiscoveryService: discovers repos from orgs in addition to personal account", async () => {
  const orgRepos = JSON.stringify([
    { name: "api", owner: { login: "lama-finance" }, defaultBranchRef: { name: "main" } },
    { name: "frontend", owner: { login: "lama-finance" }, defaultBranchRef: null }
  ]);

  const runner = stubRunner({
    "gh api user --jq .login": ok("itayper\n"),
    "gh api user/orgs --jq .[].login": ok("lama-finance\n"),
    "gh repo list itayper --json name,owner,defaultBranchRef --limit 100": ok(SAMPLE_GH_REPOS),
    "gh repo list lama-finance --json name,owner,defaultBranchRef --limit 100": ok(orgRepos)
  });

  const service = new RepoDiscoveryService(runner);
  const repos = await service.discoverGitHubRepos();

  assert.equal(repos.length, 4);
  assert.ok(repos.some((r) => r.owner === "myorg" && r.name === "my-repo"));
  assert.ok(repos.some((r) => r.owner === "lama-finance" && r.name === "api"));
  assert.ok(repos.some((r) => r.owner === "lama-finance" && r.name === "frontend"));
});

test("RepoDiscoveryService: falls back to unscoped list when API calls fail", async () => {
  const runner = stubRunner({
    "gh api user --jq .login": new Error("no auth"),
    "gh api user/orgs --jq .[].login": new Error("no auth"),
    "gh repo list --json name,owner,defaultBranchRef --limit 100": ok(SAMPLE_GH_REPOS)
  });

  const service = new RepoDiscoveryService(runner);
  const repos = await service.discoverGitHubRepos();
  assert.equal(repos.length, 2);
});

test("RepoDiscoveryService: returns empty list when gh fails", async () => {
  const runner = stubRunner({
    "gh api user --jq .login": new Error("no auth"),
    "gh api user/orgs --jq .[].login": new Error("no auth"),
    "gh repo list --json name,owner,defaultBranchRef --limit 100": new Error("no auth")
  });

  const service = new RepoDiscoveryService(runner);
  const repos = await service.discoverGitHubRepos();
  assert.equal(repos.length, 0);
});

test("RepoDiscoveryService: discovers local repos via SSH remote (flat layout)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-repo-discovery-flat-"));

  try {
    const repoDir = path.join(tmpDir, "my-local-repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });

    const runner = stubRunner({
      "git remote get-url origin": ok("git@github.com:myorg/my-local-repo.git\n")
    });

    const service = new RepoDiscoveryService(runner);
    const repos = await service.discoverLocalRepos([tmpDir]);

    assert.equal(repos.length, 1);
    assert.equal(repos[0]?.owner, "myorg");
    assert.equal(repos[0]?.name, "my-local-repo");
    assert.equal(repos[0]?.isLocalClone, true);
    assert.equal(repos[0]?.localPath, repoDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("RepoDiscoveryService: discovers local repos via HTTPS remote", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-repo-discovery-https-"));

  try {
    const repoDir = path.join(tmpDir, "another-repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });

    const runner = stubRunner({
      "git remote get-url origin": ok("https://github.com/myorg/another-repo.git\n")
    });

    const service = new RepoDiscoveryService(runner);
    const repos = await service.discoverLocalRepos([tmpDir]);

    assert.equal(repos.length, 1);
    assert.equal(repos[0]?.owner, "myorg");
    assert.equal(repos[0]?.name, "another-repo");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("RepoDiscoveryService: discovers repos in owner/name layout (codeRoot/org/repo)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-repo-discovery-owner-name-"));

  try {
    // Simulate: /tmp/<dir>/myorg/example-repo/.git
    const repoDir = path.join(tmpDir, "myorg", "example-repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });

    const runner = stubRunner({
      "git remote get-url origin": ok(
        "git@github.com:myorg/example-repo.git\n"
      )
    });

    const service = new RepoDiscoveryService(runner);
    const repos = await service.discoverLocalRepos([tmpDir]);

    assert.equal(repos.length, 1);
    assert.equal(repos[0]?.owner, "myorg");
    assert.equal(repos[0]?.name, "example-repo");
    assert.equal(repos[0]?.localPath, repoDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("RepoDiscoveryService: skips node_modules and hidden directories", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-repo-skip-"));

  try {
    // These should be skipped entirely
    await fs.mkdir(path.join(tmpDir, "node_modules", "some-pkg", ".git"), {
      recursive: true
    });
    await fs.mkdir(path.join(tmpDir, ".hidden-dir", ".git"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "dist", ".git"), { recursive: true });

    const runner = stubRunner({});
    const service = new RepoDiscoveryService(runner);
    const repos = await service.discoverLocalRepos([tmpDir]);
    assert.equal(repos.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("RepoDiscoveryService: skips directories without .git", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-no-git-"));

  try {
    await fs.mkdir(path.join(tmpDir, "not-a-repo"), { recursive: true });

    const runner = stubRunner({});
    const service = new RepoDiscoveryService(runner);
    const repos = await service.discoverLocalRepos([tmpDir]);
    assert.equal(repos.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("RepoDiscoveryService: mergeRepos combines GitHub and local", () => {
  const service = new RepoDiscoveryService({
    run: () => Promise.reject(new Error("unused"))
  });

  const github = [
    { owner: "org", name: "repo1", isLocalClone: false, defaultBranch: "main" },
    { owner: "org", name: "repo2", isLocalClone: false }
  ];

  const local = [
    { owner: "org", name: "repo1", localPath: "/code/repo1", isLocalClone: true },
    { owner: "org", name: "repo3", localPath: "/code/repo3", isLocalClone: true }
  ];

  const merged = service.mergeRepos(github, local);

  assert.equal(merged.length, 3);

  const repo1 = merged.find((r) => r.name === "repo1");
  assert.ok(repo1 !== undefined);
  assert.equal(repo1.isLocalClone, true);
  assert.equal(repo1.localPath, "/code/repo1");
  assert.equal(repo1.defaultBranch, "main");

  const repo3 = merged.find((r) => r.name === "repo3");
  assert.ok(repo3 !== undefined);
  assert.equal(repo3.isLocalClone, true);
});
