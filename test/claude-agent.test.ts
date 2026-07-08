import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ClaudeCodeCliAgent } from "../src/agents/claude.js";
import { PlanBreakdownSessionStore } from "../src/workstreams/plan-breakdown-generator/store.js";
import type { PlanBreakdownSession } from "../src/workstreams/plan-breakdown-generator/types.js";

test("ClaudeCodeCliAgent fails plan_breakdown when exit code is 0 but sessionId is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-plan-fail-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: 'Thinking...\n{"other":"stuff"}\n',
      stderr: "",
      exitCode: 0
    });
    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir,
      planBreakdownSessionStore: new PlanBreakdownSessionStore(tempDir)
    });

    const result = await agent.dispatch(
      baseTask({ kind: "plan_breakdown" }),
      baseContext(),
      baseAgent({ id: "claude-strong", roles: ["implementation_manager"] })
    );

    assert.equal(result.taskStatus, "failed");
    assert.match(result.execution.errorMessage ?? "", /sessionId/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ClaudeCodeCliAgent succeeds plan_breakdown when exit code is 0 and valid sessionId is provided", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-plan-success-"));

  try {
    const store = new PlanBreakdownSessionStore(tempDir);
    const sessionId = "claude-session";
    const session: PlanBreakdownSession = {
      id: sessionId,
      title: "Plan",
      summary: "Summary",
      tasks: {
        T1: {
          id: "T1",
          title: "T1",
          description: "D1",
          risk: "low",
          dependsOn: [],
          blocks: [],
          canRunInParallelWith: [],
          filesLikelyInvolved: [],
          acceptanceCriteria: [],
          verification: []
        }
      },
      waves: { W1: { id: "W1", taskIds: ["T1"], rationale: "R1" } },
      waveOrder: ["W1"],
      recommendedFirstWaveId: "W1",
      graphConcerns: [],
      humanDecisionsNeeded: [],
      suggestedNextAction: "Next",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      validationIssues: []
    };
    await store.saveSession(session);

    const commandRunner = new RecordingCommandRunner({
      stdout: `Done.\n{"sessionId":"${sessionId}"}\n`,
      stderr: "",
      exitCode: 0
    });
    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir,
      planBreakdownSessionStore: store
    });

    const result = await agent.dispatch(
      baseTask({ kind: "plan_breakdown", sourceId: "issue:owner/repo:1" }),
      baseContext(),
      baseAgent({ id: "claude-strong", roles: ["implementation_manager"] })
    );

    assert.equal(result.taskStatus, "completed");
    assert.equal(result.execution.result?.planBreakdownSessionId, sessionId);
    assert.ok(result.execution.result?.planBreakdown);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ClaudeCodeCliAgent fails review_pr when stdout has no valid structured review result", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-review-missing-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "Review notes...\n{\"summary\":\"Missing action.\"}\n",
      stderr: "",
      exitCode: 0
    });
    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const result = await agent.dispatch(
      baseTask({
        kind: "review_pr",
        sourceKind: "pull_request",
        sourceId: "pull_request:owner/repo:21",
        sourceUrl: "https://github.com/owner/repo/pull/21",
        context: baseContext({
          pullRequestUrl: "https://github.com/owner/repo/pull/21",
          instruction:
            'Review the pull request and finish with JSON. Use {"action":"APPROVE","summary":"..."} when there are no actionable findings. Use {"action":"REQUEST_CHANGES","summary":"...","inlineComments":[{"path":"relative/file.ts","line":12,"body":"..."}]} when changes are required.'
        })
      }),
      baseContext({
        pullRequestUrl: "https://github.com/owner/repo/pull/21",
        instruction:
          'Review the pull request and finish with JSON. Use {"action":"APPROVE","summary":"..."} when there are no actionable findings. Use {"action":"REQUEST_CHANGES","summary":"...","inlineComments":[{"path":"relative/file.ts","line":12,"body":"..."}]} when changes are required.'
      }),
      baseAgent({ id: "claude-strong", roles: ["review"] })
    );

    assert.equal(result.taskStatus, "failed");
    assert.equal(result.execution.result?.review, undefined);
    assert.match(result.execution.errorMessage ?? "", /valid structured review result/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ClaudeCodeCliAgent populates execution record with agentModel when provided", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-model-record-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "Success",
      stderr: "",
      exitCode: 0
    });
    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const agentConfig = baseAgent({ model: "claude-test-model" });
    const result = await agent.dispatch(baseTask(), baseContext(), agentConfig);

    assert.equal(result.execution.agentModel, "claude-test-model");
    const call = commandRunner.calls[0];
    assert.ok(call);
    assert.ok(call.args.includes("--model"));
    assert.ok(call.args.includes("claude-test-model"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

import type { AgentConfig } from "../src/config/types.js";
import type { BuiltContext } from "../src/context/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type {
  CommandRunner,
  CommandRunnerOptions,
  CommandRunnerResult
} from "../src/utils/command-runner.js";

test("ClaudeCodeCliAgent persists artifacts, handles args, and parses results", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-agent-test-"));
  const repoDir = path.join(tempDir, "repo-one");
  await mkdir(repoDir, { recursive: true });

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout:
        'Decision notes...\n{"decision":"start_implementation","summary":"Plan updated."}\n',
      stderr: "",
      exitCode: 0
    });

    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir,
      now: () => "2026-05-17T12:00:00.000Z",
      githubBroker: {
        serverName: "githubBroker",
        serverUrl: "http://127.0.0.1:4444/mcp",
        toolAllowList: ["get_issue"]
      }
    });

    const task = baseTask({
      id: "task:1",
      kind: "respond_issue_comment",
      executionPermission: "read-only"
    });
    const context = baseContext({ localRepoPath: repoDir });
    const config = baseAgent({ id: "claude-strong", command: "claude" });

    const result = await agent.dispatch(task, context, config);

    // Verify Recording
    assert.equal(commandRunner.calls.length, 1);
    const call = commandRunner.calls[0]!;
    assert.equal(call.command, "claude");
    assert.equal(call.options.cwd, repoDir);

    assert.ok(call.args.includes("-p"), "Should include -p flag");
    assert.ok(call.args.includes("--permission-mode"), "Should include --permission-mode flag");
    assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.ok(call.args.includes("--mcp-config"), "Should include --mcp-config flag");
    assert.ok(call.args.includes("--settings"), "Should include --settings flag");
    assert.ok(call.args.includes("--allowedTools"), "Should include --allowedTools flag");
    assert.equal(
      call.args[call.args.indexOf("--allowedTools") + 1],
      "mcp__githubBroker__get_issue"
    );

    assert.match(call.options.input ?? "", /# Claude Code CLI Launch Instructions/);
    assert.match(call.options.input ?? "", /"taskType": "respond_issue_comment"/);

    // Verify Result
    assert.equal(result.taskStatus, "completed");
    assert.equal(result.execution.agentProvider, "claude");
    assert.equal(result.execution.result?.triage, undefined);

    // Verify Artifacts
    const promptText = await readFile(result.execution.promptArtifactPath, "utf8");
    assert.match(promptText, /# Claude Code CLI Launch Instructions/);
    assert.match(promptText, /🤖/);

    const mcpConfigText = await readFile(
      path.join(tempDir, "artifacts", result.execution.id, "claude-mcp-config.json"),
      "utf8"
    );
    const mcpConfig = JSON.parse(mcpConfigText);
    assert.deepEqual(mcpConfig.mcpServers.githubBroker.type, "http");
    assert.equal(mcpConfig.mcpServers.githubBroker.url, "http://127.0.0.1:4444/mcp");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ClaudeCodeCliAgent handles non-zero exit code", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-agent-fail-test-"));
  const repoDir = path.join(tempDir, "repo-one");
  await mkdir(repoDir, { recursive: true });

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "Partial output",
      stderr: "Something went wrong",
      exitCode: 1
    });

    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir,
      now: () => "2026-05-17T12:00:00.000Z"
    });

    const task = baseTask({ id: "task:fail" });
    const context = baseContext({ localRepoPath: repoDir });
    const config = baseAgent({ id: "claude-strong", command: "claude" });

    const result = await agent.dispatch(task, context, config);

    assert.equal(result.taskStatus, "failed");
    assert.equal(result.execution.exitCode, 1);
    assert.equal(result.execution.errorMessage, "Something went wrong");
    assert.equal(await readFile(result.execution.stdoutArtifactPath, "utf8"), "Partial output");
    assert.equal(await readFile(result.execution.stderrArtifactPath, "utf8"), "Something went wrong");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ClaudeCodeCliAgent uses a 20 minute default timeout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-timeout-default-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "ok",
      stderr: "",
      exitCode: 0
    });
    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    await agent.dispatch(baseTask(), baseContext(), baseAgent({ command: "claude" }));

    assert.equal(commandRunner.calls[0]?.options.timeoutMs, 20 * 60 * 1000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ClaudeCodeCliAgent captures latest Claude project transcript on failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-transcript-capture-"));
  const repoDir = path.join(tempDir, "repo-one");
  const projectsDir = path.join(tempDir, "claude-projects");
  const encodedProjectPath = path.resolve(repoDir).replace(/[^A-Za-z0-9]/g, "-");
  const projectDir = path.join(projectsDir, encodedProjectPath);
  await mkdir(projectDir, { recursive: true });

  const transcriptContent = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"internal trace\"}]}}\n";
  await writeFile(path.join(projectDir, "session.jsonl"), transcriptContent, "utf8");

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "",
      stderr: "",
      exitCode: 124
    });
    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir,
      now: () => "2026-05-17T12:00:00.000Z",
      claudeProjectsDir: projectsDir
    });

    const result = await agent.dispatch(
      baseTask({ id: "task:timeout" }),
      baseContext({ localRepoPath: repoDir }),
      baseAgent({ command: "claude" })
    );

    assert.equal(result.taskStatus, "failed");
    assert.ok(result.execution.providerTranscriptArtifactPath);
    assert.equal(
      await readFile(result.execution.providerTranscriptArtifactPath!, "utf8"),
      transcriptContent
    );
    assert.match(
      await readFile(result.execution.stderrArtifactPath, "utf8"),
      /Claude project transcript captured/
    );
    assert.equal(result.execution.errorMessage, "Claude Code CLI exited with a non-zero status.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

class RecordingCommandRunner implements CommandRunner {
  public readonly calls: Array<{
    command: string;
    args: string[];
    options: CommandRunnerOptions;
  }> = [];

  constructor(private readonly result: CommandRunnerResult) {}

  async run(
    command: string,
    args: string[],
    options: CommandRunnerOptions = {}
  ): Promise<CommandRunnerResult> {
    this.calls.push({ command, args, options });
    if (this.result.exitCode !== 0) {
      throw new FakeCommandExecutionError(
        this.result.exitCode,
        this.result.stdout,
        this.result.stderr
      );
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
    repoSlug: "eladaviv/repo-one",
    sourceKind: "issue",
    sourceId: "issue:1",
    sourceUrl: "https://github.com/eladaviv/repo-one/issues/1",
    relevant: true,
    reason: "test",
    summary: "test",
    workstreamId: "eladaviv/repo-one:issue:1",
    context: baseContext(),
    createdAt: "2026-05-17T10:00:00.000Z",
    updatedAt: "2026-05-17T10:00:00.000Z",
    ...overrides
  };
}

function baseContext(overrides: Partial<BuiltContext> = {}): BuiltContext {
  return {
    repoIdentifier: "eladaviv/repo-one",
    localRepoPath: "/tmp/code-root/repo-one",
    instruction: "Do things.",
    labels: [],
    ...overrides
  };
}

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "claude-default",
    provider: "claude",
    modelClass: "strong",
    roles: ["discussion"],
    command: "claude",
    enabled: true,
    ...overrides
  } as AgentConfig;
}

test("ClaudeCodeCliAgent upfront session assignment passes planned session ID and name, and returns them", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-upfront-session-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "Success prose",
      stderr: "",
      exitCode: 0
    });
    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const decision: any = {
      mode: "new_session",
      providerSessionId: "planned-uuid-5678",
      providerSessionName: "backburner-planned-name"
    };

    const result = await agent.dispatch(
      baseTask(),
      baseContext(),
      baseAgent(),
      decision
    );

    assert.equal(result.taskStatus, "completed");
    assert.deepEqual(result.providerSession, {
      providerSessionId: "planned-uuid-5678",
      providerSessionName: "backburner-planned-name",
      status: "active"
    });

    const call = commandRunner.calls[0];
    assert.ok(call);
    const idIdx = call.args.indexOf("--session-id");
    assert.ok(idIdx !== -1);
    assert.equal(call.args[idIdx + 1], "planned-uuid-5678");

    const nameIdx = call.args.indexOf("--name");
    assert.ok(nameIdx !== -1);
    assert.equal(call.args[nameIdx + 1], "backburner-planned-name");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ClaudeCodeCliAgent upfront session assignment falls back to planned UUID even on failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-upfront-fail-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "",
      stderr: "Timeout or failure",
      exitCode: 124
    });
    const agent = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const decision: any = {
      mode: "new_session",
      providerSessionId: "planned-uuid-9999",
      providerSessionName: "backburner-planned-name-fail"
    };

    const result = await agent.dispatch(
      baseTask(),
      baseContext(),
      baseAgent(),
      decision
    );

    assert.equal(result.taskStatus, "failed");
    assert.deepEqual(result.providerSession, {
      providerSessionId: "planned-uuid-9999",
      providerSessionName: "backburner-planned-name-fail",
      status: "active"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
