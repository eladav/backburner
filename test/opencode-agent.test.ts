import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { OpenCodeCliAgent } from "../src/agents/opencode.js";
import { PlanBreakdownSessionStore } from "../src/workstreams/plan-breakdown-generator/store.js";
import type { AgentConfig } from "../src/config/types.js";
import type { BuiltContext } from "../src/context/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { CommandRunner, CommandRunnerOptions, CommandRunnerResult } from "../src/utils/command-runner.js";

test("OpenCodeCliAgent successful dispatch with normalization", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-agent-test-"));
  const repoDir = path.join(tempDir, "repo-one");
  await mkdir(repoDir, { recursive: true });

  try {
    const rawStdout = [
      '{"type":"text","part":{"text":"I will answer this."}}',
      '{"type":"text","part":{"text":"\\nDone."}}'
    ].join("\n");

    const commandRunner = new RecordingCommandRunner({
      stdout: rawStdout,
      stderr: "Logs...",
      exitCode: 0
    });

    const agent = new OpenCodeCliAgent({
      commandRunner,
      logDir: tempDir,
      now: () => "2026-06-07T12:00:00.000Z",
      githubBroker: {
        serverName: "githubBroker",
        serverUrl: "http://127.0.0.1:4444",
        toolAllowList: ["get_issue"]
      }
    });

    const task = baseTask({ id: "task:1", kind: "respond_issue_comment" });
    const context = baseContext({ localRepoPath: repoDir });
    const config = baseAgent({
      id: "opencode-agent",
      command: "opencode",
      model: "gemma",
      timeoutMs: 1_800_000
    });

    const result = await agent.dispatch(task, context, config);

    // Verify Call
    assert.equal(commandRunner.calls.length, 1);
    const call = commandRunner.calls[0]!;
    assert.equal(call.command, "opencode");
    assert.deepEqual(call.args.slice(0, 7), [
      "run",
      "--model",
      "gemma",
      "--format",
      "json",
      "--dir",
      repoDir
    ]);
    assert.equal(call.args[7], await readFile(result.execution.promptArtifactPath, "utf8"));
    assert.equal(call.options.env?.OPENCODE_CONFIG, result.execution.settingsArtifactPath);
    assert.equal(call.options.timeoutMs, 1_800_000);

    // Verify Result
    assert.equal(result.taskStatus, "completed");
    assert.equal(result.execution.agentProvider, "opencode");
    assert.equal(result.execution.agentModel, "gemma");
    assert.equal(result.execution.result?.triage, undefined);

    // Verify Artifacts
    const stdoutText = await readFile(result.execution.stdoutArtifactPath, "utf8");
    assert.equal(stdoutText, "I will answer this.\nDone.");

    const streamText = await readFile(result.execution.streamArtifactPath!, "utf8");
    assert.equal(streamText, rawStdout);

    const configJson = JSON.parse(await readFile(result.execution.settingsArtifactPath!, "utf8"));
    assert.equal(configJson.mcp.githubBroker.type, "remote");
    assert.equal(configJson.mcp.githubBroker.url, "http://127.0.0.1:4444");
    assert.equal(configJson.tools["githubBroker_*"], false);
    assert.equal(configJson.tools["githubBroker_get_issue"], true);
    assert.equal(configJson.mcpServers, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenCodeCliAgent fails on non-zero exit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-fail-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "",
      stderr: "Model not found",
      exitCode: 1,
      reject: true
    });
    const agent = new OpenCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const result = await agent.dispatch(
      baseTask(),
      baseContext(),
      baseAgent({ model: "unknown" })
    );

    assert.equal(result.taskStatus, "failed");
    assert.equal(result.execution.exitCode, 1);
    assert.equal(result.execution.errorMessage, "Model not found");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenCodeCliAgent fails review_pr guard when no review result found", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-review-fail-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: '{"type":"text","part":{"text":"I reviewed it but forgot the JSON."}}',
      stderr: "",
      exitCode: 0
    });
    const agent = new OpenCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const result = await agent.dispatch(
      baseTask({ kind: "review_pr" }),
      baseContext(),
      baseAgent({ model: "gemma" })
    );

    assert.equal(result.taskStatus, "failed");
    assert.match(result.execution.errorMessage ?? "", /valid structured review result/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenCodeCliAgent fails plan_breakdown guard when extraction fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-plan-fail-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: '{"type":"text","part":{"text":"I planned it but forgot the JSON."}}',
      stderr: "",
      exitCode: 0
    });
    const agent = new OpenCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const result = await agent.dispatch(
      baseTask({ kind: "plan_breakdown" }),
      baseContext(),
      baseAgent({ model: "gemma" })
    );

    assert.equal(result.taskStatus, "failed");
    assert.match(result.execution.errorMessage ?? "", /No JSON object found/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

class RecordingCommandRunner implements CommandRunner {
  public readonly calls: Array<{ command: string; args: string[]; options: CommandRunnerOptions }> = [];

  constructor(private readonly result: CommandRunnerResult & { reject?: boolean }) { }

  async run(command: string, args: string[], options: CommandRunnerOptions = {}): Promise<CommandRunnerResult> {
    this.calls.push({ command, args, options });
    if (this.result.reject) {
      throw new FakeCommandExecutionError(this.result.exitCode, this.result.stdout, this.result.stderr);
    }
    return this.result;
  }
}

class FakeCommandExecutionError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super("Command failed.");
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
    createdAt: "2026-06-07T10:00:00.000Z",
    updatedAt: "2026-06-07T10:00:00.000Z",
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
    id: "opencode-default",
    provider: "opencode",
    modelClass: "strong",
    roles: ["discussion"],
    command: "opencode",
    model: "gemma",
    enabled: true,
    ...overrides
  } as AgentConfig;
}
