import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  AntigravityCliAgent,
  normalizeAntigravityStdout,
  readAntigravityConversationIdForCwd
} from "../src/agents/antigravity.js";
import {
  buildAntigravityCliArgs,
  ensureAntigravityMcpConfig,
  mapPermissionToAntigravityMode
} from "../src/agents/antigravity-launch.js";
import type { AgentConfig } from "../src/config/types.js";
import type { BuiltContext } from "../src/context/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { CommandRunner, CommandRunnerOptions, CommandRunnerResult } from "../src/utils/command-runner.js";

test("Antigravity launch maps permissions and builds print args", () => {
  assert.equal(mapPermissionToAntigravityMode("read-only"), "sandbox");
  assert.equal(mapPermissionToAntigravityMode("workspace-write"), "always-proceed");

  assert.deepEqual(
    buildAntigravityCliArgs({
      permissionMode: "sandbox",
      model: "Gemini 3.1 Pro (High)",
      conversationId: "conversation-123",
      printTimeout: "20m",
      logFilePath: "/tmp/agy.log",
      promptText: "Do the work"
    }),
    [
      "--print-timeout",
      "20m",
      "--log-file",
      "/tmp/agy.log",
      "--model",
      "Gemini 3.1 Pro (High)",
      "--conversation",
      "conversation-123",
      "--mode",
      "plan",
      "--sandbox",
      "--dangerously-skip-permissions",
      "--print",
      "Do the work"
    ]
  );
});

test("AntigravityCliAgent dispatches prompt via print arg and bootstraps MCP config once", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-agent-test-"));
  const repoDir = path.join(tempDir, "repo-one");
  const configHome = path.join(tempDir, "antigravity-home");
  const legacyGeminiConfigHome = path.join(tempDir, "gemini-config");
  await mkdir(repoDir, { recursive: true });
  await mkdir(configHome, { recursive: true });
  await mkdir(legacyGeminiConfigHome, { recursive: true });
  await mkdir(path.join(configHome, "cache"), { recursive: true });
  await writeFile(path.join(configHome, "settings.json"), "{\"showTips\":false}\n", "utf8");
  await writeFile(
    path.join(configHome, "mcp_config.json"),
    JSON.stringify({
      mcpServers: {
        stitch: {
          serverUrl: "https://stitch.googleapis.com/mcp"
        }
      }
    }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(legacyGeminiConfigHome, "mcp_config.json"),
    JSON.stringify({
      mcpServers: {
        stitch: {
          serverUrl: "https://stitch.googleapis.com/mcp"
        }
      }
    }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(configHome, "cache", "last_conversations.json"),
    JSON.stringify({ [repoDir]: "conversation-after-dispatch" }, null, 2),
    "utf8"
  );

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "I will answer this.\nDone.\n--print-timeout\n",
      stderr: "Logs...",
      exitCode: 0
    });

    const agent = new AntigravityCliAgent({
      commandRunner,
      logDir: tempDir,
      configHome,
      legacyGeminiConfigHome,
      now: () => "2026-06-19T12:00:00.000Z",
      githubBroker: {
        serverName: "githubBroker",
        serverUrl: "http://127.0.0.1:4444/mcp",
        toolAllowList: ["get_issue", "memory_search"]
      }
    });

    const result = await agent.dispatch(
      baseTask({ id: "task:1", kind: "respond_issue_comment", executionPermission: "read-only" }),
      baseContext({ localRepoPath: repoDir }),
      baseAgent({ model: "Gemini 3.5 Flash (Low)", timeoutMs: 1_800_000 })
    );

    assert.equal(commandRunner.calls.length, 1);
    const call = commandRunner.calls[0]!;
    assert.equal(call.command, "agy");
    assert.ok(call.args.includes("--print"));
    assert.equal(call.args.at(-2), "--print");
    assert.match(call.args.at(-1) ?? "", /Global Antigravity Instructions/);
    assert.match(call.args.at(-1) ?? "", /memory_search/);
    assert.ok(call.args.includes("--sandbox"));
    assert.ok(call.args.includes("--dangerously-skip-permissions"));
    assert.equal(call.args[call.args.indexOf("--mode") + 1], "plan");
    assert.equal(call.args[call.args.indexOf("--print-timeout") + 1], "1800000ms");
    assert.equal(call.options.cwd, repoDir);
    assert.equal(call.options.timeoutMs, 1_800_000);
    assert.equal(call.options.input, undefined);
    assert.equal(call.options.env?.HOME, undefined);

    assert.equal(result.taskStatus, "completed");
    assert.equal(result.execution.agentProvider, "antigravity");
    assert.equal(result.execution.agentModel, "Gemini 3.5 Flash (Low)");
    assert.equal(result.execution.result?.triage, undefined);
    assert.deepEqual(result.providerSession, {
      providerSessionId: "conversation-after-dispatch",
      status: "active"
    });

    const stdoutText = await readFile(result.execution.stdoutArtifactPath, "utf8");
    assert.equal(stdoutText, "I will answer this.\nDone.");

    const rawText = await readFile(result.execution.streamArtifactPath!, "utf8");
    assert.match(rawText, /--print-timeout/);

    const settingsJson = JSON.parse(await readFile(result.execution.settingsArtifactPath!, "utf8"));
    assert.equal(settingsJson.toolPermission, "proceed-in-sandbox");
    assert.equal(settingsJson.enableTerminalSandbox, true);
    assert.deepEqual(settingsJson.trustedWorkspaces, [repoDir]);

    const mcpPath = path.join(path.dirname(result.execution.settingsArtifactPath!), "antigravity-mcp-config.json");
    const mcpJson = JSON.parse(await readFile(mcpPath, "utf8"));
    assert.equal(mcpJson.mcpServers.githubBroker.serverUrl, "http://127.0.0.1:4444/mcp");

    const settings = await readFile(path.join(configHome, "settings.json"), "utf8");
    assert.equal(settings, "{\"showTips\":false}\n");
    const liveMcp = JSON.parse(await readFile(path.join(configHome, "mcp_config.json"), "utf8"));
    assert.equal(liveMcp.mcpServers.githubBroker.serverUrl, "http://127.0.0.1:4444/mcp");
    assert.equal(liveMcp.mcpServers.stitch.serverUrl, "https://stitch.googleapis.com/mcp");
    const legacyMcp = JSON.parse(await readFile(path.join(legacyGeminiConfigHome, "mcp_config.json"), "utf8"));
    assert.equal(legacyMcp.mcpServers.githubBroker.serverUrl, "http://127.0.0.1:4444/mcp");
    assert.equal(legacyMcp.mcpServers.stitch.serverUrl, "https://stitch.googleapis.com/mcp");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AntigravityCliAgent resumes by explicit conversation id", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-resume-test-"));
  const repoDir = path.join(tempDir, "repo-one");
  const configHome = path.join(tempDir, "antigravity-home");
  await mkdir(repoDir, { recursive: true });
  await mkdir(path.join(configHome, "cache"), { recursive: true });
  await writeFile(
    path.join(configHome, "cache", "last_conversations.json"),
    JSON.stringify({ [repoDir]: "conversation-resumed" }, null, 2),
    "utf8"
  );

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "done",
      stderr: "",
      exitCode: 0
    });
    const agent = new AntigravityCliAgent({
      commandRunner,
      logDir: tempDir,
      configHome
    });

    const result = await agent.dispatch(
      baseTask({ executionPermission: "read-only" }),
      baseContext({ localRepoPath: repoDir }),
      baseAgent(),
      {
        mode: "native_resume_candidate",
        record: {
          id: "record-1",
          capability: "verified_headless_resume",
          status: "active",
          providerSessionId: "conversation-resumed",
          scope: {
            repoKey: "owner/repo-one",
            workstreamId: "owner/repo-one:issue:1",
            job: "discussion",
            modelClass: "strong",
            configuredAgentId: "antigravity-default",
            provider: "antigravity",
            localRepoPath: repoDir,
            branchName: "main"
          },
          createdAt: "2026-06-19T10:00:00.000Z",
          updatedAt: "2026-06-19T10:00:00.000Z"
        }
      }
    );

    const args = commandRunner.calls[0]!.args;
    assert.ok(args.includes("--conversation"));
    assert.equal(args[args.indexOf("--conversation") + 1], "conversation-resumed");
    assert.deepEqual(result.providerSession, {
      providerSessionId: "conversation-resumed",
      status: "active"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readAntigravityConversationIdForCwd supports realpath cache keys", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-cache-test-"));
  const configHome = path.join(tempDir, "antigravity-home");
  const repoDir = path.join(tempDir, "repo-one");
  await mkdir(path.join(configHome, "cache"), { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const resolvedRepoDir = await realpath(repoDir);
  await writeFile(
    path.join(configHome, "cache", "last_conversations.json"),
    JSON.stringify({ [resolvedRepoDir]: "conversation-from-realpath" }, null, 2),
    "utf8"
  );

  try {
    assert.equal(
      await readAntigravityConversationIdForCwd(configHome, repoDir),
      "conversation-from-realpath"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ensureAntigravityMcpConfig creates and preserves Antigravity MCP config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-mcp-setup-test-"));
  const configHome = path.join(tempDir, "antigravity-home");

  try {
    const first = await ensureAntigravityMcpConfig(
      configHome,
      {
        serverName: "githubBroker",
        serverUrl: "http://127.0.0.1:4444/mcp",
        toolAllowList: ["get_issue"]
      },
      { now: () => "2026-06-19T12:00:00.000Z" }
    );

    assert.equal(first.changed, true);
    assert.equal(first.backupPath, undefined);
    let config = JSON.parse(await readFile(first.configPath, "utf8"));
    assert.equal(config.mcpServers.githubBroker.serverUrl, "http://127.0.0.1:4444/mcp");

    config.mcpServers.context7 = { serverUrl: "https://context7.example/mcp" };
    await writeFile(first.configPath, JSON.stringify(config, null, 2), "utf8");

    const second = await ensureAntigravityMcpConfig(
      configHome,
      {
        serverName: "githubBroker",
        serverUrl: "http://127.0.0.1:4444/mcp",
        toolAllowList: ["get_issue"]
      }
    );
    assert.equal(second.changed, false);

    const third = await ensureAntigravityMcpConfig(
      configHome,
      {
        serverName: "githubBroker",
        serverUrl: "http://127.0.0.1:5555/mcp",
        toolAllowList: ["get_issue"]
      },
      { now: () => "2026-06-19T12:01:00.000Z" }
    );
    assert.equal(third.changed, true);
    assert.ok(third.backupPath?.endsWith("mcp_config.json.backup-before-backburner-2026-06-19T12-01-00-000Z"));
    config = JSON.parse(await readFile(first.configPath, "utf8"));
    assert.equal(config.mcpServers.githubBroker.serverUrl, "http://127.0.0.1:5555/mcp");
    assert.equal(config.mcpServers.context7.serverUrl, "https://context7.example/mcp");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AntigravityCliAgent uses non-interactive permission bypass for workspace writes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-write-test-"));
  const configHome = path.join(tempDir, "antigravity-home");
  await mkdir(configHome, { recursive: true });

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "done",
      stderr: "",
      exitCode: 0
    });
    const agent = new AntigravityCliAgent({
      commandRunner,
      logDir: tempDir,
      configHome,
      printTimeout: "7m"
    });

    await agent.dispatch(baseTask(), baseContext(), baseAgent());

    const args = commandRunner.calls[0]!.args;
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(!args.includes("--sandbox"));
    assert.equal(args[args.indexOf("--print-timeout") + 1], "7m");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AntigravityCliAgent preserves headless permission stderr when review output is empty", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-review-permission-test-"));
  const configHome = path.join(tempDir, "antigravity-home");
  await mkdir(configHome, { recursive: true });

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "",
      stderr: "headless mode auto-denied command permission",
      exitCode: 0
    });
    const agent = new AntigravityCliAgent({
      commandRunner,
      logDir: tempDir,
      configHome
    });

    const result = await agent.dispatch(
      baseTask({
        kind: "review_pr",
        executionPermission: "read-only",
        handoffPolicy: {
          expectsPushableHandoff: false,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        }
      }),
      baseContext(),
      baseAgent({ roles: ["review"] })
    );

    assert.equal(result.taskStatus, "failed");
    assert.equal(result.execution.errorMessage, "headless mode auto-denied command permission");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AntigravityCliAgent retains structured review error for malformed nonempty output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "antigravity-review-malformed-test-"));
  const configHome = path.join(tempDir, "antigravity-home");
  await mkdir(configHome, { recursive: true });

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "I reviewed the pull request, but omitted the required JSON.",
      stderr: "review parser warning",
      exitCode: 0
    });
    const agent = new AntigravityCliAgent({
      commandRunner,
      logDir: tempDir,
      configHome
    });

    const result = await agent.dispatch(
      baseTask({
        kind: "review_pr",
        executionPermission: "read-only",
        handoffPolicy: {
          expectsPushableHandoff: false,
          orchestratorOwnsPush: true,
          remotePublishOwner: "orchestrator"
        }
      }),
      baseContext(),
      baseAgent({ roles: ["review"] })
    );

    assert.equal(result.taskStatus, "failed");
    assert.match(
      result.execution.errorMessage ?? "",
      /Agent output did not contain a valid structured review result/
    );
    assert.match(result.execution.errorMessage ?? "", /review parser warning/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeAntigravityStdout removes stray print-timeout marker", () => {
  assert.equal(normalizeAntigravityStdout("ok\n--print-timeout\n"), "ok");
});

class RecordingCommandRunner implements CommandRunner {
  public readonly calls: Array<{ command: string; args: string[]; options: CommandRunnerOptions }> = [];
  private readonly result: CommandRunnerResult & { reject?: boolean };

  constructor(result: CommandRunnerResult & { reject?: boolean }) {
    this.result = result;
  }

  async run(command: string, args: string[], options: CommandRunnerOptions = {}): Promise<CommandRunnerResult> {
    this.calls.push({ command, args, options });
    if (this.result.reject) {
      throw new FakeCommandExecutionError(this.result.exitCode, this.result.stdout, this.result.stderr);
    }
    return this.result;
  }
}

class FakeCommandExecutionError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    exitCode: number,
    stdout: string,
    stderr: string
  ) {
    super("Command failed.");
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task:test",
    kind: "implement_plan",
    status: "pending",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "owner/repo-one",
    sourceKind: "issue",
    sourceId: "issue:1",
    sourceUrl: "https://github.com/owner/repo-one/issues/1",
    relevant: true,
    reason: "test",
    summary: "test",
    workstreamId: "owner/repo-one:issue:1",
    context: baseContext(),
    createdAt: "2026-06-19T10:00:00.000Z",
    updatedAt: "2026-06-19T10:00:00.000Z",
    ...overrides
  };
}

function baseContext(overrides: Partial<BuiltContext> = {}): BuiltContext {
  return {
    repoIdentifier: "owner/repo-one",
    localRepoPath: "/tmp/repo-one",
    instruction: "Do things.",
    labels: [],
    ...overrides
  };
}

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "antigravity-default",
    provider: "antigravity",
    modelClass: "strong",
    roles: ["discussion"],
    command: "agy",
    enabled: true,
    ...overrides
  } as AgentConfig;
}
