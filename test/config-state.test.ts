import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/loader.js";
import { StateStore } from "../src/state/loader.js";
import { resolveOutputsStateRoot, resolveOutputsLogsRoot } from "../src/utils/paths.js";

test("loadConfig validates repos.json with useful errors", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["eladav"],
        repos: [
          {
            id: "repo-1",
            name: "repo-1",
            localPath: "repo-1",
            enabled: true,
            labels: {
              agentInProgress: "agent-in-progress",
              agentPlanApproved: "agent-plan-approved"
            }
          }
        ]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "codex-strong",
            provider: "codex",
            modelClass: "strong",
            roles: ["planning"],
            command: "codex",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /repos\.json: repos\[0\]\.owner must be a non-empty string/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig defaults planBreakdownNeeded label", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-default-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["eladav"],
        repos: [
          {
            id: "repo-1",
            owner: "eladav",
            name: "repo-1",
            localPath: "repo-1",
            enabled: true,
            labels: {
              agentInProgress: "agent-in-progress",
              agentPlanApproved: "agent-plan-approved",
              agentProductApproved: "agent-product-approved",
              agentReview: "agent-review"
            }
          }
        ]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({ agents: [] }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.ok(config.repos[0]);
    assert.equal(config.repos[0].labels.planBreakdownNeeded, "plan-breakdown-needed");
    assert.equal(config.repos[0].labels.agentSyncParentBranch, "agent-sync-parent-branch");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts custom agentSyncParentBranch label", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-custom-sync-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["eladav"],
        repos: [
          {
            id: "repo-1",
            owner: "eladav",
            name: "repo-1",
            localPath: "repo-1",
            enabled: true,
            labels: {
              agentInProgress: "agent-in-progress",
              agentPlanApproved: "agent-plan-approved",
              agentProductApproved: "agent-product-approved",
              agentReview: "agent-review",
              agentSyncParentBranch: "custom-sync-label"
            }
          }
        ]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({ agents: [] }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.ok(config.repos[0]);
    assert.equal(config.repos[0].labels.agentSyncParentBranch, "custom-sync-label");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts custom planBreakdownNeeded label", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-custom-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["eladav"],
        repos: [
          {
            id: "repo-1",
            owner: "eladav",
            name: "repo-1",
            localPath: "repo-1",
            enabled: true,
            labels: {
              agentInProgress: "agent-in-progress",
              agentPlanApproved: "agent-plan-approved",
              agentProductApproved: "agent-product-approved",
              agentReview: "agent-review",
              planBreakdownNeeded: "custom-breakdown-label"
            }
          }
        ]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({ agents: [] }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.ok(config.repos[0]);
    assert.equal(config.repos[0].labels.planBreakdownNeeded, "custom-breakdown-label");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore initializes missing readable JSON files with defaults", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-state-"));

  try {
    const store = new StateStore(tempDir);
    const state = await store.load();

    assert.deepEqual(state.repos, []);
    assert.deepEqual(state.tasks, []);
    assert.deepEqual(state.executions, []);
    assert.deepEqual(state.workstreams, []);
    assert.deepEqual(state.attention, []);
    assert.deepEqual(state.issueMetadata, { partialFailures: [] });

    const reposState = await readFile(path.join(tempDir, "repos.json"), "utf8");
    const issuesState = await readFile(path.join(tempDir, "issues.json"), "utf8");
    const executionsState = await readFile(path.join(tempDir, "executions.json"), "utf8");
    const workstreamsState = await readFile(path.join(tempDir, "workstreams.json"), "utf8");
    const attentionState = await readFile(path.join(tempDir, "attention.json"), "utf8");

    assert.equal(reposState, '{\n  "repos": []\n}\n');
    assert.equal(executionsState, '{\n  "executions": []\n}\n');
    assert.equal(workstreamsState, '{\n  "workstreams": []\n}\n');
    assert.equal(attentionState, '{\n  "attention": []\n}\n');
    assert.equal(
      issuesState,
      '{\n  "metadata": {\n    "partialFailures": []\n  },\n  "issues": []\n}\n'
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore co-locates executions if only stateDir is provided (backward compatibility)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-colocated-"));

  try {
    const store = new StateStore({ stateDir: tempDir });
    await store.load();

    assert.ok(await readFile(path.join(tempDir, "repos.json"), "utf8"));
    assert.ok(await readFile(path.join(tempDir, "executions.json"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveOutputsStateRoot returns dir/state", () => {
  assert.equal(resolveOutputsStateRoot("/tmp/foo"), path.join("/tmp/foo", "state"));
});

test("resolveOutputsLogsRoot returns dir/logs", () => {
  assert.equal(resolveOutputsLogsRoot("/tmp/foo"), path.join("/tmp/foo", "logs"));
});

test("StateStore can split control-plane state from execution log files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-split-state-"));
  const stateDir = path.join(tempDir, "management-state");
  const logDir = path.join(tempDir, "agent-log");

  try {
    const store = new StateStore({ stateDir, executionDir: logDir });
    const state = await store.load();

    assert.deepEqual(state.executions, []);
    assert.equal(await readFile(path.join(stateDir, "repos.json"), "utf8"), '{\n  "repos": []\n}\n');
    assert.equal(await readFile(path.join(logDir, "executions.json"), "utf8"), '{\n  "executions": []\n}\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore round-trips workstreams as readable JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-workstreams-"));

  try {
    const store = new StateStore(tempDir);
    await store.writeWorkstreamState([
      {
        id: "eladaviv/repo-one:issue:17",
        repoKey: "eladaviv/repo-one",
        origin: {
          type: "issue",
          number: 17
        },
        linkedIssueNumber: 17,
        linkedPrs: [
          {
            number: 23,
            status: "open",
            role: "implementation"
          }
        ],
        activePrNumber: 23,
        activeWorktreeId: "worktree:eladaviv/repo-one:issue:17",
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved"
      }
    ]);

    const persisted = await readFile(path.join(tempDir, "workstreams.json"), "utf8");
    assert.equal(
      persisted,
      '{\n' +
        '  "workstreams": [\n' +
        '    {\n' +
        '      "id": "eladaviv/repo-one:issue:17",\n' +
        '      "repoKey": "eladaviv/repo-one",\n' +
        '      "origin": {\n' +
        '        "type": "issue",\n' +
        '        "number": 17\n' +
        '      },\n' +
        '      "linkedIssueNumber": 17,\n' +
        '      "linkedPrs": [\n' +
        '        {\n' +
        '          "number": 23,\n' +
        '          "status": "open",\n' +
        '          "role": "implementation"\n' +
        '        }\n' +
        '      ],\n' +
        '      "activePrNumber": 23,\n' +
        '      "activeWorktreeId": "worktree:eladaviv/repo-one:issue:17",\n' +
        '      "phase": "planning",\n' +
        '      "attention": "idle",\n' +
        '      "status": "open",\n' +
        '      "resolution": "unresolved"\n' +
        '    }\n' +
        '  ]\n' +
        '}\n'
    );

    const state = await store.load();
    assert.deepEqual(state.workstreams, [
      {
        id: "eladaviv/repo-one:issue:17",
        repoKey: "eladaviv/repo-one",
        origin: {
          type: "issue",
          number: 17
        },
        linkedIssueNumber: 17,
        linkedPrs: [
          {
            number: 23,
            status: "open",
            role: "implementation"
          }
        ],
        activePrNumber: 23,
        activeWorktreeId: "worktree:eladaviv/repo-one:issue:17",
        phase: "planning",
        attention: "idle",
        status: "open",
        resolution: "unresolved"
      }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore round-trips attention records as readable JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-attention-"));

  try {
    const store = new StateStore(tempDir);
    await store.writeAttentionState([
      {
        workstreamId: "eladaviv/repo-one:issue:17",
        repoKey: "eladaviv/repo-one",
        needsAction: true,
        reasons: ["plan_approved", "pr_comment_added"],
        issueNumber: 17,
        pullRequestNumbers: [23],
        commentIds: ["comment:eladaviv/repo-one:pull_request_comment:6001"],
        retryTargetCommentId: "9999",
        lastObservedAt: "2026-04-20T10:00:00.000Z",
        currentPullRequestHeadSha: "head-sha-23",
        lastHandledReviewHeadSha: "old-head-sha",
        gaps: ["Review handling is inferred from persisted review_pr task state; external or unlabeled reviews are not tracked yet."]
      }
    ]);

    const persisted = await readFile(path.join(tempDir, "attention.json"), "utf8");
    assert.equal(
      persisted,
      '{\n' +
        '  "attention": [\n' +
        '    {\n' +
        '      "workstreamId": "eladaviv/repo-one:issue:17",\n' +
        '      "repoKey": "eladaviv/repo-one",\n' +
        '      "needsAction": true,\n' +
        '      "reasons": [\n' +
        '        "plan_approved",\n' +
        '        "pr_comment_added"\n' +
        '      ],\n' +
        '      "issueNumber": 17,\n' +
        '      "pullRequestNumbers": [\n' +
        '        23\n' +
        '      ],\n' +
        '      "commentIds": [\n' +
        '        "comment:eladaviv/repo-one:pull_request_comment:6001"\n' +
        '      ],\n' +
        '      "retryTargetCommentId": "9999",\n' +
        '      "lastObservedAt": "2026-04-20T10:00:00.000Z",\n' +
        '      "currentPullRequestHeadSha": "head-sha-23",\n' +
        '      "lastHandledReviewHeadSha": "old-head-sha",\n' +
        '      "gaps": [\n' +
        '        "Review handling is inferred from persisted review_pr task state; external or unlabeled reviews are not tracked yet."\n' +
        '      ]\n' +
        '    }\n' +
        '  ]\n' +
        '}\n'
    );

    const state = await store.load();
    assert.deepEqual(state.attention, [
      {
        workstreamId: "eladaviv/repo-one:issue:17",
        repoKey: "eladaviv/repo-one",
        needsAction: true,
        reasons: ["plan_approved", "pr_comment_added"],
        issueNumber: 17,
        pullRequestNumbers: [23],
        commentIds: ["comment:eladaviv/repo-one:pull_request_comment:6001"],
        retryTargetCommentId: "9999",
        lastObservedAt: "2026-04-20T10:00:00.000Z",
        currentPullRequestHeadSha: "head-sha-23",
        lastHandledReviewHeadSha: "old-head-sha",
        gaps: ["Review handling is inferred from persisted review_pr task state; external or unlabeled reviews are not tracked yet."]
      }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore round-trips provider sessions as readable JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-provider-sessions-"));

  try {
    const store = new StateStore(tempDir);
    const records = [
      {
        id: "session-1",
        scope: {
          repoKey: "owner/repo",
          workstreamId: "ws-1",
          job: "planning",
          modelClass: "strong",
          configuredAgentId: "agent-1",
          provider: "codex",
          localRepoPath: "/tmp/repo",
          branchName: "main"
        },
        capability: "verified_headless_resume",
        status: "available",
        providerSessionId: "native-1",
        createdAt: "2026-05-27T10:00:00Z",
        updatedAt: "2026-05-27T10:00:00Z"
      }
    ];

    await store.writeProviderSessionState(records as any);

    const persisted = await readFile(path.join(tempDir, "provider-sessions.json"), "utf8");
    assert.ok(persisted.includes('"session-1"'));
    assert.ok(persisted.includes('"native-1"'));
    assert.ok(persisted.includes('"verified_headless_resume"'));

    const state = await store.load();
    assert.deepEqual(state.providerSessions, records);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts optional model in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-model-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            provider: "codex",
            modelClass: "strong",
            model: "gpt-5.4",
            roles: ["planning"],
            command: "codex",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.equal(config.agents[0]?.model, "gpt-5.4");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts missing model in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-no-model-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            provider: "codex",
            modelClass: "strong",
            roles: ["planning"],
            command: "codex",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.equal(config.agents[0]?.model, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects empty model string in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-empty-model-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            provider: "codex",
            modelClass: "strong",
            model: "",
            roles: ["planning"],
            command: "codex",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /agents\[0\]\.model must be a non-empty string when provided/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects whitespace-only model string in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-ws-model-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            provider: "codex",
            modelClass: "strong",
            model: "   ",
            roles: ["planning"],
            command: "codex",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /agents\[0\]\.model must be a non-empty string when provided/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects null model in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-null-model-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            provider: "codex",
            modelClass: "strong",
            model: null,
            roles: ["planning"],
            command: "codex",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /agents\[0\]\.model must be a non-empty string when provided/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown provider in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-unknown-provider-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            provider: "unknown-provider",
            modelClass: "strong",
            roles: ["planning"],
            command: "unknown-command",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /agents\[0\]\.provider (Invalid discriminator value|must be "codex", "gemini", "claude", "opencode" or "antigravity")/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts Gemini agent and broker config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-gemini-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "gemini-strong",
            provider: "gemini",
            modelClass: "strong",
            roles: ["planning"],
            command: "gemini",
            model: "gemini-3.1-pro-preview",
            enabled: true
          }
        ],
        gemini: {
          githubBroker: {
            serverName: "githubBroker",
            toolAllowList: ["get_issue"]
          }
        }
      }, null, 2),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.equal(config.agents[0]?.provider, "gemini");
    assert.equal(config.agents[0]?.model, "gemini-3.1-pro-preview");
    assert.equal(config.gemini.githubBroker.serverName, "githubBroker");
    assert.deepEqual(config.gemini.githubBroker.toolAllowList, ["get_issue"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts Antigravity agent and broker defaults", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-antigravity-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "antigravity-1",
            provider: "antigravity",
            modelClass: "cheap",
            roles: ["implementation"],
            command: "agy",
            model: "Gemini 3.5 Flash (Low)",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.equal(config.agents[0]?.provider, "antigravity");
    assert.equal(config.agents[0]?.model, "Gemini 3.5 Flash (Low)");
    assert.equal(config.antigravity.githubBroker.serverName, "githubBroker");
    assert.ok(config.antigravity.githubBroker.toolAllowList.includes("get_issue"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts valid OpenCode agent with required model", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-opencode-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "opencode-1",
            provider: "opencode",
            modelClass: "cheap",
            model: "gemma-it",
            roles: ["implementation"],
            command: "opencode",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.equal(config.agents[0]?.provider, "opencode");
    assert.equal(config.agents[0]?.model, "gemma-it");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects OpenCode agent with missing model", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-opencode-no-model-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "opencode-1",
            provider: "opencode",
            modelClass: "cheap",
            roles: ["implementation"],
            command: "opencode",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /agents\[0\]\.model must be a non-empty string/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects OpenCode agent with whitespace-only model", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-opencode-whitespace-model-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "opencode-1",
            provider: "opencode",
            modelClass: "cheap",
            model: "   ",
            roles: ["implementation"],
            command: "opencode",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /agents\[0\]\.model must be a non-empty string/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts root opencode.githubBroker config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-opencode-broker-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [],
        opencode: {
          githubBroker: {
            serverName: "custom-broker",
            toolAllowList: ["get_issue"]
          }
        }
      }, null, 2),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.equal(config.opencode.githubBroker.serverName, "custom-broker");
    assert.deepEqual(config.opencode.githubBroker.toolAllowList, ["get_issue"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig uses default opencode.githubBroker config when omitted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-opencode-broker-default-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: []
      }, null, 2),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.equal(config.opencode.githubBroker.serverName, "githubBroker");
    assert.ok(config.opencode.githubBroker.toolAllowList.length > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid modelClass in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-invalid-modelclass-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            provider: "codex",
            modelClass: "ultra",
            roles: ["planning"],
            command: "codex",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /agents\[0\]\.modelClass must be "strong" or "cheap"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid roles in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-invalid-roles-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            provider: "codex",
            modelClass: "strong",
            roles: ["planning", ""],
            command: "codex",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /agents\[0\]\.roles/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects missing command in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-missing-command-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            provider: "codex",
            modelClass: "strong",
            roles: ["planning"],
            command: "",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /agents\[0\]\.command must be a non-empty string/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid broker toolAllowList in agents.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-invalid-broker-tools-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [],
        codex: {
          githubBroker: {
            toolAllowList: [42]
          }
        }
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /codex\.githubBroker\.toolAllowList/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid repo localPath (absolute) in repos.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-absolute-path-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["eladav"],
        repos: [
          {
            id: "repo-1",
            owner: "eladav",
            name: "repo-1",
            localPath: "/tmp/repo-1",
            enabled: true,
            labels: {
              agentInProgress: "in-progress",
              agentPlanApproved: "approved",
              agentReview: "review"
            }
          }
        ]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({ agents: [] }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /repos\[0\]\.localPath must be relative/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid repo localPath (traversal) in repos.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-traversal-path-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["eladav"],
        repos: [
          {
            id: "repo-1",
            owner: "eladav",
            name: "repo-1",
            localPath: "../outside",
            enabled: true,
            labels: {
              agentInProgress: "in-progress",
              agentPlanApproved: "approved",
              agentReview: "review"
            }
          }
        ]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({ agents: [] }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /repos\[0\]\.localPath must stay within the provided code root/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects repo localPath traversal after separator normalization", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-normalized-traversal-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["eladav"],
        repos: [
          {
            id: "repo-1",
            owner: "eladav",
            name: "repo-1",
            localPath: ["repo", "..", "..", "outside"].join(path.sep),
            enabled: true,
            labels: {
              agentInProgress: "in-progress",
              agentPlanApproved: "approved",
              agentReview: "review"
            }
          }
        ]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({ agents: [] }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /repos\[0\]\.localPath must stay within the provided code root/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects Windows-shaped repo localPath traversal and absolute paths on any host", async () => {
  const badPaths = [
    "..\\outside",
    "repo\\..\\..\\outside",
    "C:\\code\\repo",
    "C:repo",
    "C:..\\outside",
    "D:file.txt",
    "\\rooted",
    "\\\\server\\share\\repo"
  ];

  for (const [index, localPath] of badPaths.entries()) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `orchestrator-config-windows-path-${index}-`));
    const managementDir = path.join(tempDir, "management");

    try {
      await mkdir(managementDir, { recursive: true });
      await writeFile(
        path.join(managementDir, "repos.json"),
        JSON.stringify({
          allowedUsers: ["eladav"],
          repos: [
            {
              id: "repo-1",
              owner: "eladav",
              name: "repo-1",
              localPath,
              enabled: true,
              labels: {
                agentInProgress: "in-progress",
                agentPlanApproved: "approved",
                agentReview: "review"
              }
            }
          ]
        }, null, 2),
        "utf8"
      );
      await writeFile(
        path.join(managementDir, "agents.json"),
        JSON.stringify({ agents: [] }),
        "utf8"
      );

      await assert.rejects(
        () => loadConfig(managementDir),
        /repos\[0\]\.localPath (must stay within the provided code root|must be relative)/
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test("loadConfig normalizes (trims) string fields", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-trim-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({
        allowedUsers: ["  eladav  "],
        repos: [
          {
            id: "  repo-1  ",
            owner: "  eladav  ",
            name: "  repo-one  ",
            localPath: "  repo-one  ",
            enabled: true,
            labels: {
              agentInProgress: "  in-progress  ",
              agentPlanApproved: "  approved  ",
              agentReview: "  review  "
            }
          }
        ]
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "  agent-1  ",
            provider: "  codex  ",
            modelClass: "  strong  ",
            model: "  gpt-5.4  ",
            roles: ["  planning  "],
            command: "  codex  ",
            enabled: true
          }
        ]
      }, null, 2),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.ok(config.repos[0]);
    assert.ok(config.agents[0]);
    assert.strictEqual(config.allowedUsers[0], "eladav");
    assert.strictEqual(config.repos[0].id, "repo-1");
    assert.strictEqual(config.repos[0].owner, "eladav");
    assert.strictEqual(config.repos[0].name, "repo-one");
    assert.strictEqual(config.repos[0].localPath, "repo-one");
    assert.strictEqual(config.repos[0].labels.agentInProgress, "in-progress");
    assert.strictEqual(config.agents[0].id, "agent-1");
    assert.strictEqual(config.agents[0].model, "gpt-5.4");
    assert.strictEqual(config.agents[0].roles[0], "planning");
    assert.strictEqual(config.agents[0].command, "codex");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid prompt profile path (absolute) in prompts.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-prompts-absolute-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({ agents: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "prompts.json"),
      JSON.stringify({
        promptProfiles: {
          default: {
            plan: "/tmp/plan.md"
          }
        }
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /promptProfiles\.default\.plan must be relative/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid prompt profile path (traversal) in prompts.json", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-config-prompts-traversal-"));
  const managementDir = path.join(tempDir, "management");

  try {
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["eladav"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({ agents: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "prompts.json"),
      JSON.stringify({
        promptProfiles: {
          default: {
            plan: "../outside/plan.md"
          }
        }
      }, null, 2),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /promptProfiles\.default\.plan must stay within the management directory/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
