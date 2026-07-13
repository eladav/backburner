import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildPromptPacket, renderPrompt } from "../src/agents/prompt.js";
import { dispatchPendingTasks } from "../src/agents/service.js";
import type { AgentRunner, DispatchResult } from "../src/agents/types.js";
import type { AgentConfig } from "../src/config/types.js";
import type { BuiltContext } from "../src/context/types.js";
import { StateStore } from "../src/state/loader.js";
import type { ExecutionRecord } from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { AgentVisibleCapabilities } from "../src/capabilities/types.js";

test("prompt packet and rendered prompt include projected capabilities", () => {
  const task = buildTask("review_pr");
  const capabilities = buildCapabilities();
  const packet = buildPromptPacket(task, {
    repoIdentifier: "owner/repo",
    labels: [],
    instruction: "Review the pull request and finish with JSON.",
    capabilities
  });

  const prompt = renderPrompt(task, packet);

  assert.deepEqual(packet.capabilities, capabilities);
  assert.match(prompt, /Capability projection:/);
  assert.match(prompt, /Available sensors:/);
  assert.match(prompt, /github-context: uses gh; observes issues-and-prs; scope repository; tools gh\.get_issue, gh\.get_pr/);
  assert.match(prompt, /Available controllers:/);
  assert.match(prompt, /github-comments: uses gh; grants comment-on-prs; approval not-required; tools gh\.post_issue_comment/);
  assert.match(prompt, /Blocked capabilities:/);
  assert.match(prompt, /linear-context/);
  assert.match(prompt, /Do not use blocked capabilities/);
  assert.match(prompt, /"capabilities": \{/);
});

test("dispatchPendingTasks passes projected capabilities into every task context", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-capabilities-dispatch-"));

  try {
    const store = new StateStore(tempDir);
    const task = buildTask("review_pr");
    await store.writeTaskState([task]);

    let capturedContext: BuiltContext | undefined;
    const agentRunner: AgentRunner = {
      dispatch: async (_task, context) => {
        capturedContext = context;
        return {
          taskStatus: "completed",
          execution: buildExecution(task),
        } satisfies DispatchResult;
      }
    };

    const agent: AgentConfig = {
      id: "codex-review",
      provider: "codex",
      modelClass: "strong",
      roles: ["review"],
      command: "codex",
      enabled: true
    };

    const capabilities = buildCapabilities();
    const cycleResult = await dispatchPendingTasks({
      tasks: [task],
      agents: [agent],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      agentRunner,
      capabilitiesByProvider: new Map([["codex", capabilities]]),
      now: () => "2026-06-19T10:00:00.000Z"
    });

    assert.equal(cycleResult.tasks[0]?.status, "completed");
    assert.deepEqual(capturedContext?.capabilities, capabilities);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks binds provider broker tool scope during agent dispatch", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-broker-scope-dispatch-"));

  try {
    const store = new StateStore(tempDir);
    const task = buildTask("review_pr");
    await store.writeTaskState([task]);

    const activeAllowedTools: string[][] = [];
    const bindCalls: string[][] = [];
    let clearCount = 0;
    const brokerToolScope = {
      bindAllowedTools: (allowedToolNames: readonly string[]) => {
        bindCalls.push([...allowedToolNames]);
        activeAllowedTools.push([...allowedToolNames]);
      },
      clearAllowedTools: () => {
        clearCount += 1;
      }
    };

    const agentRunner: AgentRunner = {
      dispatch: async () => {
        assert.deepEqual(activeAllowedTools.at(-1), ["get_issue"]);
        return {
          taskStatus: "completed",
          execution: buildExecution(task),
        } satisfies DispatchResult;
      }
    };

    const agent: AgentConfig = {
      id: "codex-review",
      provider: "codex",
      modelClass: "strong",
      roles: ["review"],
      command: "codex",
      enabled: true
    };

    await dispatchPendingTasks({
      tasks: [task],
      agents: [agent],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      agentRunner,
      providerBrokerToolAllowLists: new Map([["codex", ["get_issue"]]]),
      brokerToolScope,
      now: () => "2026-06-19T10:00:00.000Z"
    });

    assert.deepEqual(bindCalls, [["get_issue"]]);
    assert.equal(clearCount, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function buildTask(kind: TaskRecord["kind"]): TaskRecord {
  return {
    id: `task-${kind}`,
    kind,
    status: "pending",
    executionPermission: kind === "review_pr" ? "read-only" : "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: "repo-1",
    repoName: "repo",
    repoSlug: "owner/repo",
    sourceKind: "pull_request",
    sourceId: "pull-request-1",
    sourceUrl: "https://github.com/owner/repo/pull/1",
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: "owner/repo",
      labels: [],
      instruction: "Review the pull request and finish with JSON."
    },
    createdAt: "2026-06-19T10:00:00.000Z",
    updatedAt: "2026-06-19T10:00:00.000Z"
  };
}

function buildCapabilities(): AgentVisibleCapabilities {
  return {
    sensors: [
      {
        name: "github-context",
        uses: "gh",
        observes: "issues-and-prs",
        scope: "repository",
        tools: ["gh.get_issue", "gh.get_pr"]
      }
    ],
    controllers: [
      {
        name: "github-comments",
        uses: "gh",
        grants: ["comment-on-prs"],
        approval: "not-required",
        tools: ["gh.post_issue_comment"]
      }
    ],
    blocked: [
      {
        name: "linear-context",
        kind: "sensor",
        uses: "linear",
        reason: "capability_tools_unavailable",
        message: "Authorization required"
      }
    ]
  };
}

function buildExecution(task: TaskRecord): ExecutionRecord {
  const timestamp = "2026-06-19T10:00:01.000Z";
  return {
    id: `exec-${task.id}`,
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: "completed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "codex-review",
    agentProvider: "codex",
    command: {
      executable: "codex",
      args: [],
      cwd: "/tmp",
      timeoutMs: 600000
    },
    promptArtifactPath: path.join("/tmp", "prompt.md"),
    stdoutArtifactPath: path.join("/tmp", "stdout.txt"),
    stderrArtifactPath: path.join("/tmp", "stderr.txt"),
    promptPacketPath: path.join("/tmp", "prompt-packet.json"),
    startedAt: timestamp,
    endedAt: timestamp,
    exitCode: 0
  } as ExecutionRecord;
}
