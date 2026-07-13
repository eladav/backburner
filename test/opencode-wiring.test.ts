import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli/run.js";

test("runCli uses OpenCodeCliAgent when OpenCode agents are enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-opencode-wiring-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");
  let selectedBrokerPort: number | undefined;

  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(codeRoot, { recursive: true });

    // 1. Setup config with only OpenCode enabled
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["user"],
        repos: [{
          id: "repo-1",
          owner: "owner",
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
            id: "opencode-agent",
            provider: "opencode",
            modelClass: "strong",
            model: "gemma",
            roles: ["product", "discussion"],
            command: "opencode",
            enabled: true
          }
        ]
      }, null, 2)
    );

    // 2. Run CLI with mocked services
    await runCli(["run", "--code-root", codeRoot, "--broker-port", "45512"], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository() {
          return {
            repoId: "repo-1",
            repoName: "repo-one",
            repoSlug: "owner/repo-one",
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
              id: "issue:owner/repo-one:1",
              repoId: "repo-1",
              repoKey: "owner/repo-one",
              repoOwner: "owner",
              repoName: "repo-one",
              repoSlug: "owner/repo-one",
              number: 1,
              key: "owner/repo-one:issue:1",
              sourceId: "I1",
              url: "https://github.com/owner/repo-one/issues/1",
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
        async run(executable: string, args: string[]) {
          if (executable === "opencode" && args.includes("run") && args.includes("--model") && args.includes("gemma")) {
            (this as any).opencodeCalled = true;
          }
          return {
            exitCode: 0,
            stdout: '{"type":"text","part":{"text":"{\\"decision\\":\\"answer_only\\",\\"reply\\":\\"wiring works\\"}"}}',
            stderr: ""
          };
        }
      } as any,
      logger: { info: () => {}, warn: () => {} }
    });

    const executionsData = JSON.parse(await readFile(path.join(stateDir, "executions.json"), "utf8"));
    const opencodeExec = executionsData.executions.find((e: any) => e.agentProvider === "opencode");

    assert.ok(opencodeExec, "Should have attempted an execution with opencode provider");
    assert.equal(opencodeExec.agentId, "opencode-agent");
    assert.equal(opencodeExec.agentModel, "gemma");
    assert.equal(selectedBrokerPort, 45512);

    // Verify config file written by agent has correct mcp key shape
    const settingsPath = opencodeExec.settingsArtifactPath;
    const settingsJson = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(settingsJson.mcp, "Config must have top-level 'mcp' key");
    assert.ok(settingsJson.mcp.githubBroker, "Config must have githubBroker MCP server entry");
    assert.equal(settingsJson.mcp.githubBroker.type, "remote");
    assert.equal(settingsJson.mcpServers, undefined, "Config must NOT have 'mcpServers' key");

  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
