import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { dispatchPendingTasks } from "../src/agents/service.js";
import { StateStore } from "../src/state/loader.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { AgentConfig } from "../src/config/types.js";
import type { CommandRunner, CommandRunnerOptions, CommandRunnerResult } from "../src/utils/command-runner.js";
import { ClaudeCodeCliAgent } from "../src/agents/claude.js";

test("dispatchPendingTasks persists Claude session as active even on timeout / exitCode 124", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-session-persistence-test-"));

  try {
    const store = new StateStore(tempDir);
    const task: TaskRecord = {
      id: "task-1",
      kind: "write_plan",
      repoSlug: "owner/repo",
      workstreamId: "ws-1",
      status: "pending",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      repoId: "repo-1",
      repoName: "repo",
      sourceKind: "issue",
      sourceId: "issue-1",
      sourceUrl: "url",
      relevant: true,
      reason: "reason",
      summary: "summary",
      context: {
        repoIdentifier: "owner/repo",
        labels: [],
        instruction: "do it",
        localRepoPath: "/tmp/repo",
        branchName: "feature-branch"
      },
      createdAt: "now",
      updatedAt: "now"
    };

    await store.writeTaskState([task]);

    // CLI exits with 124 (timeout)
    const commandRunner = new FakeCommandRunner({
      stdout: "",
      stderr: "Command timed out",
      exitCode: 124
    });

    const agentRunner = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const agent: AgentConfig = {
      id: "claude-strong",
      provider: "claude",
      modelClass: "strong",
      roles: ["planning"],
      enabled: true,
      command: "claude"
    };

    const cycleResult = await dispatchPendingTasks({
      tasks: [task],
      agents: [agent],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      agentRunner,
      now: () => "2026-06-13T10:00:00Z"
    });

    assert.equal(cycleResult.tasks[0]?.status, "failed");

    // Load state store and verify provider session was saved with status "active"
    const finalState = await store.load();
    assert.equal(finalState.providerSessions.length, 1);
    const sessionRecord = finalState.providerSessions[0]!;
    assert.equal(sessionRecord.status, "active");
    assert.ok(sessionRecord.providerSessionId); // Generated planned UUID
    assert.equal(sessionRecord.providerSessionName, "backburner:owner/repo:write_plan:ws-1");
    assert.ok(sessionRecord.lastFailedAt);

    // Run dispatch again. Since it's active, it should be resumed!
    const task2 = { ...task, status: "pending" as const };
    await store.writeTaskState([task2]);

    const cycleResult2 = await dispatchPendingTasks({
      tasks: [task2],
      agents: [agent],
      existingExecutions: cycleResult.executions,
      stateStore: store,
      logDir: tempDir,
      agentRunner,
      now: () => "2026-06-13T10:05:00Z"
    });

    assert.equal(commandRunner.calls.length, 2);
    const call2 = commandRunner.calls[1]!;
    const resumeIndex = call2.args.indexOf("--resume");
    assert.ok(resumeIndex !== -1);
    assert.equal(call2.args[resumeIndex + 1], sessionRecord.providerSessionId);

  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks stales Claude session on non-timeout failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-session-persistence-fail-test-"));

  try {
    const store = new StateStore(tempDir);
    const task: TaskRecord = {
      id: "task-1",
      kind: "write_plan",
      repoSlug: "owner/repo",
      workstreamId: "ws-1",
      status: "pending",
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      },
      repoId: "repo-1",
      repoName: "repo",
      sourceKind: "issue",
      sourceId: "issue-1",
      sourceUrl: "url",
      relevant: true,
      reason: "reason",
      summary: "summary",
      context: {
        repoIdentifier: "owner/repo",
        labels: [],
        instruction: "do it",
        localRepoPath: "/tmp/repo",
        branchName: "feature-branch"
      },
      createdAt: "now",
      updatedAt: "now"
    };

    await store.writeTaskState([task]);

    // CLI exits with non-zero non-timeout code
    const commandRunner = new FakeCommandRunner({
      stdout: "",
      stderr: "Compilation failed",
      exitCode: 1
    });

    const agentRunner = new ClaudeCodeCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const agent: AgentConfig = {
      id: "claude-strong",
      provider: "claude",
      modelClass: "strong",
      roles: ["planning"],
      enabled: true,
      command: "claude"
    };

    await dispatchPendingTasks({
      tasks: [task],
      agents: [agent],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      agentRunner,
      now: () => "2026-06-13T10:00:00Z"
    });

    // Load state store and verify provider session was saved with status "stale"
    const finalState = await store.load();
    assert.equal(finalState.providerSessions.length, 1);
    const sessionRecord = finalState.providerSessions[0]!;
    assert.equal(sessionRecord.status, "stale");

  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

class FakeCommandRunner implements CommandRunner {
  public readonly calls: Array<{ command: string; args: string[]; options: CommandRunnerOptions }> = [];

  constructor(private readonly result: CommandRunnerResult) { }

  async run(command: string, args: string[], options: CommandRunnerOptions = {}): Promise<CommandRunnerResult> {
    this.calls.push({ command, args, options });
    if (this.result.exitCode !== 0) {
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
