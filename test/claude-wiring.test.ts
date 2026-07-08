import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli/run.js";

test("runCli uses ClaudeCodeCliAgent when Claude agents are enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-claude-wiring-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(codeRoot, { recursive: true });

    // 1. Setup config with only Claude enabled
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify(
        {
          allowedUsers: ["user"],
          repos: [
            {
              id: "repo-1",
              owner: "eladaviv",
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
            }
          ]
        },
        null,
        2
      )
    );

    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify(
        {
          agents: [
            {
              id: "claude-triage",
              provider: "claude",
              modelClass: "strong",
              roles: ["product", "discussion"],
              command: "claude",
              enabled: true
            }
          ]
        },
        null,
        2
      )
    );

    // 2. Run CLI with mocked services
    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository() {
          return {
            repoId: "repo-1",
            repoName: "repo-one",
            repoSlug: "eladaviv/repo-one",
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
            issues: [
              {
                kind: "issue",
                id: "issue:eladaviv/repo-one:1",
                repoId: "repo-1",
                repoKey: "eladaviv/repo-one",
                repoOwner: "eladaviv",
                repoName: "repo-one",
                repoSlug: "eladaviv/repo-one",
                number: 1,
                key: "eladaviv/repo-one:issue:1",
                sourceId: "I1",
                url: "https://github.com/eladaviv/repo-one/issues/1",
                title: "Test",
                body: "Body",
                labels: ["agent-in-progress"],
                author: "user",
                state: "open",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              }
            ],
            prs: [],
            comments: [],
            repoResults: [],
            failures: []
          } as any;
        }
      },
      gitHubGateway: {
        async listOpenIssues() {
          return [];
        },
        async listOpenPullRequests() {
          return [];
        },
        async listIssueComments() {
          return [];
        },
        async listPullRequestComments() {
          return [];
        },
        async listPullRequestReviews() {
          return [];
        },
        async listPullRequestReviewComments() {
          return [];
        },
        async postIssueComment() {
          return {} as any;
        }
      } as any,
      startBrokerServer: async () => ({
        url: "http://127.0.0.1:9999/mcp",
        host: "127.0.0.1",
        port: 9999,
        close: async () => {}
      }),
      commandRunner: {
        async run(executable: string, args: string[]) {
          // Verify that -p and --permission-mode dontAsk are passed
          if (
            executable === "claude" &&
            args.includes("-p") &&
            args.includes("--permission-mode") &&
            args.includes("dontAsk")
          ) {
            (this as any).claudeArgsPassed = true;
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              triage: {
                decision: "comment",
                summary: "wiring works"
              }
            }),
            stderr: ""
          };
        }
      } as any,
      logger: { info: () => {}, warn: () => {} }
    });

    const executionsData = JSON.parse(
      await readFile(path.join(stateDir, "executions.json"), "utf8")
    );
    const claudeExec = executionsData.executions.find((e: any) => e.agentProvider === "claude");

    assert.ok(claudeExec, "Should have attempted an execution with claude provider");
    assert.equal(claudeExec.agentId, "claude-triage");
    assert.ok(claudeExec.command.args.includes("-p"));
    assert.ok(claudeExec.command.args.includes("--permission-mode"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
