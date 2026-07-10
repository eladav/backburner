import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli/run.js";

test("runCli uses AntigravityCliAgent when Antigravity agents are enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-antigravity-wiring-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");
  let selectedBrokerPort: number | undefined;
  let sawAntigravityLaunch = false;
  const previousConfigHome = process.env.BACKBURNER_ANTIGRAVITY_CONFIG_HOME;
  const previousGeminiConfigHome = process.env.BACKBURNER_GEMINI_CONFIG_HOME;

  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(codeRoot, "repo-one"), { recursive: true });
    const fakeHome = path.join(tempDir, "fake-agy-home");
    const fakeGeminiConfigHome = path.join(tempDir, "fake-gemini-config");
    await mkdir(fakeHome, { recursive: true });
    await mkdir(fakeGeminiConfigHome, { recursive: true });
    await writeFile(
      path.join(fakeHome, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          githubBroker: {
            serverUrl: "http://127.0.0.1:9999/mcp"
          }
        }
      }, null, 2)
    );
    await writeFile(
      path.join(fakeGeminiConfigHome, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          stitch: {
            serverUrl: "https://stitch.googleapis.com/mcp"
          }
        }
      }, null, 2)
    );
    process.env.BACKBURNER_ANTIGRAVITY_CONFIG_HOME = fakeHome;
    process.env.BACKBURNER_GEMINI_CONFIG_HOME = fakeGeminiConfigHome;

    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["user"],
        repos: [{
          id: "repo-1",
          owner: "example-org",
          name: "repo-one",
          localPath: "repo-one",
          enabled: true,
          labels: {
            agentInProgress: "agent-in-progress",
            agentPlanApproved: "agent-plan-approved",
            agentProductApproved: "agent-product-approved",
            agentReview: "agent-review",
            planBreakdownNeeded: "plan-breakdown-needed"
          }
        }]
      }, null, 2)
    );

    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "antigravity-triage",
            provider: "antigravity",
            modelClass: "strong",
            roles: ["product", "discussion"],
            command: "agy",
            model: "Gemini 3.5 Flash (Low)",
            enabled: true
          }
        ],
        antigravity: {
          githubBroker: {
            serverName: "githubBroker",
            toolAllowList: ["get_issue"]
          }
        }
      }, null, 2)
    );

    await runCli(["run", "--code-root", codeRoot, "--broker-port", "45512"], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository() {
          return {
            repoId: "repo-1",
            repoName: "repo-one",
            repoSlug: "example-org/repo-one",
            localPath: path.join(codeRoot, "repo-one"),
            codeRoot,
            status: "synced",
            existedBeforeSync: true,
            cloned: false,
            fetched: true,
            defaultBranch: "main",
            defaultBranchSource: "github",
            currentBranchBefore: "main",
            currentBranchAfter: "main",
            syncedAt: new Date().toISOString(),
            message: "ok"
          } as any;
        }
      },
      scanService: {
        async scanRepositories() {
          return {
            issues: [{
              kind: "issue",
              id: "issue:example-org/repo-one:1",
              repoId: "repo-1",
              repoKey: "example-org/repo-one",
              repoOwner: "example-org",
              repoName: "repo-one",
              repoSlug: "example-org/repo-one",
              number: 1,
              key: "example-org/repo-one:issue:1",
              sourceId: "I1",
              url: "https://github.com/example-org/repo-one/issues/1",
              title: "Test",
              body: "Body",
              labels: ["agent-in-progress"],
              author: "user",
              state: "open",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }],
            prs: [],
            comments: [],
            repoResults: [],
            failures: []
          } as any;
        }
      },
      gitHubGateway: {
        async listOpenIssues() { return []; },
        async listOpenPullRequests() { return []; },
        async listIssueComments() { return []; },
        async listPullRequestComments() { return []; },
        async listPullRequestReviews() { return []; },
        async listPullRequestReviewComments() { return []; },
        async postIssueComment() { return {} as any; }
      } as any,
      startBrokerServer: async ({ port }) => {
        selectedBrokerPort = port;
        return {
          url: "http://127.0.0.1:9999/mcp",
          host: "127.0.0.1",
          port: 9999,
          close: async () => {}
        };
      },
      commandRunner: {
        async run(executable: string, args: string[], options: any) {
          if (executable !== "agy") {
            return {
              exitCode: 0,
              stdout: "",
              stderr: ""
            };
          }
          sawAntigravityLaunch = true;
          assert.equal(executable, "agy");
          assert.ok(args.includes("--print"));
          assert.ok(args.includes("--sandbox"));
          assert.equal(options.env.HOME, undefined);
          return {
            exitCode: 0,
            stdout: "{\"decision\":\"comment\",\"summary\":\"wiring works\"}",
            stderr: ""
          };
        }
      } as any,
      logger: { info: () => {}, warn: () => {} }
    });

    const executionsData = JSON.parse(await readFile(path.join(stateDir, "executions.json"), "utf8"));
    const antigravityExec = executionsData.executions.find((e: any) => e.agentProvider === "antigravity");

    assert.ok(antigravityExec, "Should have attempted an execution with antigravity provider");
    assert.equal(antigravityExec.agentId, "antigravity-triage");
    assert.equal(selectedBrokerPort, 45512);
    assert.equal(sawAntigravityLaunch, true);
    const liveLegacyMcp = JSON.parse(await readFile(path.join(fakeGeminiConfigHome, "mcp_config.json"), "utf8"));
    assert.equal(liveLegacyMcp.mcpServers.githubBroker.serverUrl, "http://127.0.0.1:9999/mcp");
    assert.equal(liveLegacyMcp.mcpServers.stitch.serverUrl, "https://stitch.googleapis.com/mcp");
  } finally {
    if (previousConfigHome === undefined) {
      delete process.env.BACKBURNER_ANTIGRAVITY_CONFIG_HOME;
    } else {
      process.env.BACKBURNER_ANTIGRAVITY_CONFIG_HOME = previousConfigHome;
    }
    if (previousGeminiConfigHome === undefined) {
      delete process.env.BACKBURNER_GEMINI_CONFIG_HOME;
    } else {
      process.env.BACKBURNER_GEMINI_CONFIG_HOME = previousGeminiConfigHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
