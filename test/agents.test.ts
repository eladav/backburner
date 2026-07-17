import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { CodexCliAgent } from "../src/agents/codex.js";
import { GeminiCliAgent } from "../src/agents/gemini.js";
import { PlanBreakdownSessionStore } from "../src/workstreams/plan-breakdown-generator/store.js";
import type { PlanBreakdownSession } from "../src/workstreams/plan-breakdown-generator/types.js";

test("CodexCliAgent uses the extended 20 minute default timeout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-timeout-default-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "ok",
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({ commandRunner, logDir: tempDir });

    await agent.dispatch(baseTask(), baseContext(), baseAgent());

    assert.equal(commandRunner.calls[0]?.options.timeoutMs, 20 * 60 * 1000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent prefers the timeout configured on the selected agent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-timeout-config-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "ok",
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({ commandRunner, logDir: tempDir });

    await agent.dispatch(baseTask(), baseContext(), baseAgent({ timeoutMs: 2_400_000 }));

    assert.equal(commandRunner.calls[0]?.options.timeoutMs, 2_400_000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GeminiCliAgent prefers the timeout configured on the selected agent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gemini-timeout-config-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "ok",
      stderr: "",
      exitCode: 0
    });
    const agent = new GeminiCliAgent({ commandRunner, logDir: tempDir });

    await agent.dispatch(
      baseTask(),
      baseContext(),
      baseAgent({
        provider: "gemini",
        command: "gemini",
        timeoutMs: 1_800_000
      })
    );

    assert.equal(commandRunner.calls[0]?.options.timeoutMs, 1_800_000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent fails plan_breakdown when exit code is 0 but sessionId is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-plan-fail-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: 'Thinking...\n{"other":"stuff"}\n',
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      planBreakdownSessionStore: new PlanBreakdownSessionStore(tempDir)
    });

    const result = await agent.dispatch(
      baseTask({ kind: "plan_breakdown" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["implementation_manager"] })
    );

    assert.equal(result.taskStatus, "failed");
    assert.match(result.execution.errorMessage ?? "", /sessionId/);
    assert.strictEqual(result.execution.result?.planBreakdown, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent fails wave_plan_replanning when exit code is 0 but sessionId is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-replan-fail-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "Replanned successfully, no structured handoff.\n",
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      planBreakdownSessionStore: new PlanBreakdownSessionStore(tempDir)
    });

    const result = await agent.dispatch(
      baseTask({ kind: "wave_plan_replanning", workstreamId: "example-org/repo-one:issue:21" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["implementation_manager"] })
    );

    assert.equal(result.taskStatus, "failed");
    assert.match(result.execution.errorMessage ?? "", /No JSON object/);
    assert.strictEqual(result.execution.result?.planBreakdown, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent succeeds plan_breakdown when exit code is 0 and valid sessionId is provided", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-plan-success-"));

  try {
    const store = new PlanBreakdownSessionStore(tempDir);
    const sessionId = "valid-session";
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
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      planBreakdownSessionStore: store
    });

    const result = await agent.dispatch(
      baseTask({ kind: "plan_breakdown", sourceId: "issue:owner/repo:1" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["implementation_manager"] })
    );

    assert.equal(result.taskStatus, "completed");
    assert.equal(result.execution.result?.planBreakdownSessionId, sessionId);
    assert.ok(result.execution.result?.planBreakdown);
    assert.equal(result.execution.result.planBreakdown.title, "Plan");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent does not treat task context in successful JSON stream as provider limit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-plan-limit-text-"));

  try {
    const store = new PlanBreakdownSessionStore(tempDir);
    const sessionId = "valid-session";
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
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            result: {
              content: [
                {
                  type: "text",
                  text: "A GitHub issue comment mentioned a rate limit, but this is task context."
                }
              ]
            }
          }
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: `{"sessionId":"${sessionId}"}`
          }
        })
      ].join("\n"),
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      planBreakdownSessionStore: store
    });

    const result = await agent.dispatch(
      baseTask({ kind: "plan_breakdown", sourceId: "issue:owner/repo:1" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["implementation_manager"] })
    );

    assert.equal(result.taskStatus, "completed");
    assert.equal(result.providerLimitSignal, undefined);
    assert.equal(result.execution.result?.planBreakdownSessionId, sessionId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent does not treat task context in failed JSON stream as provider limit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-failed-limit-text-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            result: {
              content: [
                {
                  type: "text",
                  text: "The issue body says a prior attempt hit a rate limit, but this is task context."
                }
              ]
            }
          }
        })
      ].join("\n"),
      stderr: "",
      exitCode: 1
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const result = await agent.dispatch(
      baseTask({ kind: "write_plan" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["planning"] })
    );

    assert.equal(result.taskStatus, "failed");
    assert.equal(result.providerLimitSignal, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent detects provider limit from JSON error event", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-json-error-limit-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: JSON.stringify({
        type: "error",
        message: "Rate limit exceeded for model sol."
      }),
      stderr: "",
      exitCode: 1
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const result = await agent.dispatch(
      baseTask({ kind: "write_plan" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["planning"] })
    );

    assert.equal(result.taskStatus, "failed");
    assert.equal(result.providerLimitSignal?.provider, "codex");
    assert.equal(result.providerLimitSignal?.isLimited, true);
    assert.equal(result.providerLimitSignal?.rawError, "Rate limit exceeded for model sol.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

import { buildTechnicalFailureComment } from "../src/agents/failure-feedback.js";
import { GitHubTaskLifecycleNotifier } from "../src/agents/lifecycle-feedback.js";
import { GitHubPullRequestReviewPublisher } from "../src/agents/review-feedback.js";
import {
  buildCodexCliArgs,
  buildGlobalCodexLaunchInstructions,
  resolveCodexLaunchConfig,
  prependGlobalLaunchInstructions,
  toCodexCliSafeServerName
} from "../src/agents/codex-launch.js";
import { buildPromptPacket, renderPrompt } from "../src/agents/prompt.js";
import { dispatchPendingTasks } from "../src/agents/service.js";
import { selectAgentForTask } from "../src/agents/selection.js";
import type { AgentConfig } from "../src/config/types.js";
import { DefaultContextBuilder } from "../src/context/types.js";
import type { BuiltContext } from "../src/context/types.js";
import { StateStore } from "../src/state/loader.js";
import type { ExecutionRecord, PersistedState, PlanBreakdownResult, WaveAssessmentResult, WorkstreamRecord } from "../src/state/types.js";
import { workflowRegistry } from "../src/workflows/registry.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { GitHubGateway, GhIssueEvent, GhCheckRun } from "../src/github/types.js";
import type { CommandRunner, CommandRunnerOptions, CommandRunnerResult } from "../src/utils/command-runner.js";

test("selectAgentForTask chooses enabled Codex agents by task strategy", () => {
  const agents = [
    baseAgent({ id: "antigravity-strong", provider: "antigravity", roles: ["planning"] }),
    baseAgent({ id: "codex-cheap", modelClass: "cheap", roles: ["implementation"] }),
    baseAgent({ id: "codex-strong", roles: ["planning", "review", "discussion"] })
  ];

  const originalRandom = Math.random;
  try {
    // Pick the last matching agent (codex-strong) among [antigravity-strong, codex-strong]
    Math.random = () => 0.99;
    assert.equal(selectAgentForTask(baseTask({ kind: "write_plan" }), agents).id, "codex-strong");
  } finally {
    Math.random = originalRandom;
  }

  assert.equal(selectAgentForTask(baseTask({ kind: "implement_plan" }), agents).id, "codex-cheap");
  assert.equal(selectAgentForTask(baseTask({ kind: "respond_issue_comment" }), agents).id, "codex-strong");
});

test("prompt packet rendering is deterministic and includes the GitHub prefix reminder", () => {
  const task = baseTask({ kind: "respond_pr_comment" });
  const context = baseContext({
    pullRequestUrl: "https://github.com/example-org/repo-one/pull/21",
    commentUrl: "https://github.com/example-org/repo-one/pull/21#issuecomment-9001",
    relevantCommentText: "Please update the implementation notes."
  });

  const packet = buildPromptPacket(task, context);
  const prompt = renderPrompt(task, packet);

  assert.deepEqual(packet, {
    taskType: "respond_pr_comment",
    repo: "example-org/repo-one",
    url: "https://github.com/example-org/repo-one/pull/21#issuecomment-9001",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    relevantComment: "Please update the implementation notes.",
    action: "Read the pull request and comment, then resolve the request or respond with the required follow-up.",
    localPaths: ["/tmp/code-root/repo-one"],
    reminder: 'Any GitHub-authored message you post must begin with "🤖".'
  });
  assert.match(prompt, /Prompt packet JSON:/);
  assert.match(prompt, /"taskType": "respond_pr_comment"/);
  assert.match(prompt, /local execution permission: workspace-write/);
  assert.match(prompt, /Keep the workspace on the intended branch and in a pushable state/);
  assert.match(prompt, /must begin with "🤖"/);
});

test("prompt packet for issue comment follow-up includes parent issue intent", () => {
  const task = baseTask({
    kind: "respond_issue_comment",
    sourceKind: "comment",
    sourceId: "comment:example-org/repo-one:issue_comment:5001",
    sourceUrl: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
    parentSourceKind: "issue",
    parentSourceId: "issue:example-org/repo-one:11",
    context: baseContext({
      issueUrl: "https://github.com/example-org/repo-one/issues/11",
      commentUrl: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
      issueTitle: "Just answer this question",
      issueBody: "Do not create a PR. I only want an answer on the issue.",
      relevantCommentText: "come on",
      instruction:
        "Read the parent issue and the new comment, then post a GitHub issue comment through the configured broker MCP. Answer in the context of the active workstream phase. Do not return a JSON routing decision, and do not use answer_only or start_implementation. Implementation authorization comes from explicit workflow labels, not from issue-comment follow-up decisions."
    })
  });

  const packet = buildPromptPacket(task, task.context);
  const prompt = renderPrompt(task, packet);

  assert.equal(packet.issueTitle, "Just answer this question");
  assert.equal(packet.issueBody, "Do not create a PR. I only want an answer on the issue.");
  assert.equal(packet.relevantComment, "come on");
  assert.match(prompt, /parent issue title: Just answer this question/);
  assert.match(prompt, /parent issue body: Do not create a PR\. I only want an answer on the issue\./);
  assert.match(prompt, /Post the response on the GitHub issue through the configured broker MCP/);
  assert.match(prompt, /Answer in the context of the active workstream phase/);
  assert.match(prompt, /Implementation authorization comes from explicit workflow labels/);
  assert.doesNotMatch(prompt, /Output contract: finish with a JSON object/);
  assert.doesNotMatch(prompt, /choose start_implementation/i);
});

test("product phase issue comment prompts require broker publication", () => {
  const builder = new DefaultContextBuilder();
  const context = builder.build({
    taskKind: "respond_issue_comment",
    workflowPhase: "product_discovery",
    repoIdentifier: "example-org/repo-one",
    sourceKind: "comment",
    sourceUrl: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
    labels: [],
    parentUrl: "https://github.com/example-org/repo-one/issues/11",
    issueTitle: "Clarify product direction",
    issueBody: "We need product discovery before implementation.",
    commentUrl: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
    commentText: "Scope accepted. Keep it small."
  });
  const task = baseTask({
    kind: "respond_issue_comment",
    workflowPhase: "product_discovery",
    sourceKind: "comment",
    sourceId: "comment:example-org/repo-one:issue_comment:5001",
    sourceUrl: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
    parentSourceKind: "issue",
    parentSourceId: "issue:example-org/repo-one:11",
    context
  });

  const packet = buildPromptPacket(task, context);
  const prompt = renderPrompt(task, packet);

  assert.match(packet.action, /post a GitHub issue comment through the configured broker/);
  assert.match(prompt, /Post the response on the GitHub issue through the configured broker MCP/);
  assert.match(prompt, /Do not return a JSON routing decision/);
});

test("DefaultContextBuilder preserves full comment text without truncation for respond tasks", () => {
  const longComment = "A".repeat(2000) + " important context at the end";
  const builder = new DefaultContextBuilder();

  const prCtx = builder.build({
    taskKind: "respond_pr_comment",
    repoIdentifier: "example-org/repo-one",
    sourceKind: "pull_request",
    sourceUrl: "https://github.com/example-org/repo-one/pull/21",
    labels: [],
    headSha: "abc123",
    commentUrl: "https://github.com/example-org/repo-one/pull/21#issuecomment-9001",
    commentText: longComment
  });
  assert.equal(prCtx.relevantCommentText, longComment);
  assert.match(prCtx.relevantCommentText ?? "", /important context at the end/);

  const issueCtx = builder.build({
    taskKind: "respond_issue_comment",
    repoIdentifier: "example-org/repo-one",
    sourceKind: "comment",
    sourceUrl: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
    labels: [],
    parentUrl: "https://github.com/example-org/repo-one/issues/11",
    commentUrl: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
    commentText: longComment
  });
  assert.equal(issueCtx.relevantCommentText, longComment);
  assert.match(issueCtx.relevantCommentText ?? "", /important context at the end/);
});

test("CodexCliAgent persists prompt and output artifacts and invokes the command runner", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-agent-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "mock stdout\n",
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      now: sequenceNow([
        "2026-04-18T10:00:00.000Z",
        "2026-04-18T10:00:05.000Z"
      ])
    });

    const result = await agent.dispatch(
      baseTask({ kind: "write_plan" }),
      baseContext({
        pullRequestUrl: "https://github.com/example-org/repo-one/pull/21",
        instruction:
          "Write or update docs/agents/agent-example-org-repo-one-issue-21/issue-21-agent-plan.md with a comprehensive implementation plan for a later cheap-model implementation pass, and document the planning work in docs/agents/agent-example-org-repo-one-issue-21/issue-21-agent-log.md. Do not begin implementation."
      }),
      baseAgent({ id: "codex-strong", roles: ["planning"] })
    );

    assert.equal(commandRunner.calls.length, 1);
    assert.equal(commandRunner.calls[0]?.command, "codex");
    assert.deepEqual(commandRunner.calls[0]?.args, [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-"
    ]);
    assert.equal(commandRunner.calls[0]?.options.cwd, "/tmp/code-root/repo-one");
    assert.match(
      commandRunner.calls[0]?.options.input ?? "",
      /docs\/agents\/agent-example-org-repo-one-issue-21\/issue-21-agent-plan\.md/
    );
    assert.equal(result.taskStatus, "completed");

    const promptPacket = JSON.parse(await readFile(result.execution.promptPacketPath, "utf8")) as Record<string, unknown>;
    const promptText = await readFile(result.execution.promptArtifactPath, "utf8");
    const stdout = await readFile(result.execution.stdoutArtifactPath, "utf8");

    assert.equal(promptPacket.taskType, "write_plan");
    assert.match(promptText, /"taskType": "write_plan"/);
    assert.equal(stdout, "mock stdout\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent captures provider session ids from normal Codex output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-session-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout:
        "OpenAI Codex v0.133.0\n" +
        "session id: 019e7f10-3a5a-71d3-81c2-541542f3b105\n" +
        "Done.\n",
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      now: sequenceNow([
        "2026-04-18T10:00:00.000Z",
        "2026-04-18T10:00:05.000Z"
      ])
    });

    const result = await agent.dispatch(
      baseTask({ kind: "write_plan" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["planning"] })
    );

    assert.deepEqual(result.providerSession, {
      providerSessionId: "019e7f10-3a5a-71d3-81c2-541542f3b105",
      status: "active"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent captures raw JSONL output to streamArtifactPath and extracts assistant text for stdout.txt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-stream-artifact-"));

  try {
    const rawEvents = [
      '{"type":"thread.started","thread_id":"019ebfe4-49ae-72e1-a4e1-37eb5d2fcb1a"}\n',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Here is my reply."}}\n'
    ].join("");

    const commandRunner = new RecordingCommandRunner({
      stdout: rawEvents,
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      now: sequenceNow([
        "2026-04-18T10:00:00.000Z",
        "2026-04-18T10:00:05.000Z"
      ])
    });

    const result = await agent.dispatch(
      baseTask({ kind: "write_plan" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["planning"] })
    );

    assert.equal(result.taskStatus, "completed");
    assert.deepEqual(result.providerSession, {
      providerSessionId: "019ebfe4-49ae-72e1-a4e1-37eb5d2fcb1a",
      status: "active"
    });

    // Check that streamArtifactPath exists and contains raw events
    assert.ok(result.execution.streamArtifactPath);
    const rawCaptured = await readFile(result.execution.streamArtifactPath, "utf8");
    assert.equal(rawCaptured, rawEvents);

    // Check that stdout.txt contains only the extracted assistant message text
    const stdoutContent = await readFile(result.execution.stdoutArtifactPath, "utf8");
    assert.equal(stdoutContent, "Here is my reply.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildCodexCliArgs writes the GitHub broker MCP entry as a config override", () => {
  const args = buildCodexCliArgs({
    sandboxMode: "workspace-write",
    githubBroker: {
      serverName: "github-broker",
      serverUrl: "http://127.0.0.1:4318/mcp",
      toolAllowList: ["get_issue", "create_pr"]
    }
  });

  assert.deepEqual(args, [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    'mcp_servers.githubBroker.url="http://127.0.0.1:4318/mcp"',
    "-c",
    'mcp_servers.githubBroker.default_tools_approval_mode="approve"',
    "-"
  ]);
});

test("buildCodexCliArgs auto-approves an allowed broker in read-only mode without enabling workspace writes", () => {
  const args = buildCodexCliArgs({
    sandboxMode: "read-only",
    githubBroker: {
      serverName: "github-broker",
      serverUrl: "http://127.0.0.1:4318/mcp",
      toolAllowList: ["plan_breakdown.start_session"]
    }
  });

  assert.deepEqual(args, [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-c",
    'mcp_servers.githubBroker.url="http://127.0.0.1:4318/mcp"',
    "-c",
    'mcp_servers.githubBroker.default_tools_approval_mode="approve"',
    "-"
  ]);
  assert.equal(args.includes("sandbox_workspace_write.network_access=true"), false);
});

test("buildCodexCliArgs places resume after exec-level sandbox options", () => {
  const args = buildCodexCliArgs({
    sandboxMode: "workspace-write",
    resumeThreadId: "019e7f0e-aa9a-7420-b4a6-0a1d7068051b"
  });

  assert.deepEqual(args, [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "resume",
    "019e7f0e-aa9a-7420-b4a6-0a1d7068051b",
    "-"
  ]);
});

test("buildCodexCliArgs includes --model flag when model is provided", () => {
  const args = buildCodexCliArgs({
    sandboxMode: "workspace-write",
    model: "gpt-5.4"
  });

  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.4");
  assert.equal(args[args.length - 1], "-");
});

test("buildCodexCliArgs places --model before resume to ensure sub-command compatibility", () => {
  const args = buildCodexCliArgs({
    sandboxMode: "workspace-write",
    model: "gpt-5.4",
    resumeThreadId: "019e7f0e-aa9a-7420-b4a6-0a1d7068051b"
  });

  const modelIdx = args.indexOf("--model");
  const resumeIdx = args.indexOf("resume");

  assert.ok(modelIdx !== -1, "Should include --model");
  assert.ok(resumeIdx !== -1, "Should include resume");
  assert.ok(modelIdx < resumeIdx, "Engine flags (--model) should precede sub-commands (resume)");
});

test("buildCodexCliArgs omits --model flag when model is absent", () => {
  const args = buildCodexCliArgs({
    sandboxMode: "workspace-write"
  });

  assert.ok(!args.includes("--model"));
});

test("toCodexCliSafeServerName normalizes names for dotted config overrides", () => {
  assert.equal(toCodexCliSafeServerName("github-broker"), "githubBroker");
  assert.equal(toCodexCliSafeServerName("github broker"), "githubBroker");
  assert.equal(toCodexCliSafeServerName("github_broker"), "githubBroker");
});

test("resolveTaskExecutionPolicy maps review tasks to read-only and coding tasks to workspace-write", () => {
  assert.deepEqual(workflowRegistry.resolveTaskExecutionPolicy("respond_issue_comment"), {
    executionPermission: "read-only",
    handoffPolicy: {
      expectsPushableHandoff: false,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    }
  });
  assert.deepEqual(workflowRegistry.resolveTaskExecutionPolicy("review_pr"), {
    executionPermission: "read-only",
    handoffPolicy: {
      expectsPushableHandoff: false,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    }
  });
  assert.deepEqual(workflowRegistry.resolveTaskExecutionPolicy("write_plan"), {
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    }
  });
  assert.deepEqual(workflowRegistry.resolveTaskExecutionPolicy("implement_plan"), {
    executionPermission: "workspace-write",
    handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" }
  });

  assert.deepEqual(workflowRegistry.resolveTaskExecutionPolicy("sync_parent_branch"), {
    executionPermission: "workspace-write",
    handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" }
  });
  });

test("resolveCodexLaunchConfig maps read-only and workspace-write permissions to explicit sandbox modes", () => {
  assert.deepEqual(
    resolveCodexLaunchConfig({
      executionPermission: "read-only",
      handoffPolicy: {
        expectsPushableHandoff: false,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      }
    }),
    {
      executionPermission: "read-only",
      sandboxMode: "read-only",
      expectsPushableHandoff: false,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    }
  );
  assert.deepEqual(
    resolveCodexLaunchConfig({
      executionPermission: "workspace-write",
      handoffPolicy: {
        expectsPushableHandoff: true,
        orchestratorOwnsPush: true,
        remotePublishOwner: "orchestrator"
      }
    }),
    {
      executionPermission: "workspace-write",
      sandboxMode: "workspace-write",
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    }
  );
});

test("buildGlobalCodexLaunchInstructions tells Codex to use the broker instead of gh", () => {
  const instructions = buildGlobalCodexLaunchInstructions({
    githubBroker: {
      serverName: "github-broker",
      serverUrl: "http://127.0.0.1:4318/mcp",
      toolAllowList: ["get_issue", "post_issue_comment"]
    }
  });

  assert.match(instructions, /Use the local MCP server `github-broker`/);
  assert.match(instructions, /## MCP Server/);
  assert.match(instructions, /## When To Use It/);
  assert.match(instructions, /## Fallback/);
  assert.match(instructions, /Do not call `gh` directly/);
  assert.match(instructions, /If a needed GitHub capability is missing/);
  assert.match(instructions, /Repo-local `AGENTS\.md` files still apply/);
  assert.match(instructions, /already starts in the exact target repository/);
  assert.match(instructions, /copy the exact local path from the task packet/);
  assert.match(instructions, /verify the workdir first/);
  assert.match(instructions, /`get_issue`/);
  assert.match(instructions, /`post_issue_comment`/);
});

test("workspace-write prompts make push handoff ownership explicit", () => {
  const prompt = renderPrompt(
    baseTask({ kind: "implement_plan" }),
    buildPromptPacket(baseTask({ kind: "implement_plan" }), baseContext())
  );

  assert.match(prompt, /workspace-write/);
  assert.match(prompt, /Keep the workspace on the intended branch and in a pushable state/);
  assert.match(prompt, /The orchestrator owns remote push and PR publication/);
  assert.match(prompt, /the orchestrator will handle the push/i);
});

test("packet implementation prompt does not describe packet plan as Product Spec", () => {
  const context = baseContext({
    planDocumentPath: "/tmp/code-root/repo-one/docs/agents/packets/T1.md",
    logDocumentPath: "/tmp/code-root/repo-one/docs/agents/packets/T1-log.md",
    pullRequestUrl: "https://github.com/example-org/repo-one/pull/21"
  });
  const task = baseTask({
    kind: "implement_plan",
    context
  });
  const prompt = renderPrompt(task, buildPromptPacket(task, context));

  assert.match(prompt, /Use docs\/agents\/packets\/T1\.md as the source of truth for the implementation task/);
  assert.doesNotMatch(prompt, /The Product Spec is the product source of truth/);
  assert.doesNotMatch(prompt, /product spec document:/);
});

test("normal implementation prompt includes Product Spec guidance when a spec path is present", () => {
  const context = baseContext({
    planDocumentPath: "/tmp/code-root/repo-one/docs/agents/issue-21-plan.md",
    productSpecDocumentPath: "/tmp/code-root/repo-one/docs/agents/issue-21-product-spec.md",
    logDocumentPath: "/tmp/code-root/repo-one/docs/agents/issue-21-log.md",
    pullRequestUrl: "https://github.com/example-org/repo-one/pull/21"
  });
  const task = baseTask({
    kind: "implement_plan",
    context
  });
  const prompt = renderPrompt(task, buildPromptPacket(task, context));

  assert.match(prompt, /The Product Spec is the product source of truth/);
  assert.match(prompt, /docs\/agents\/issue-21-product-spec\.md/);
  assert.match(prompt, /product spec document: \/tmp\/code-root\/repo-one\/docs\/agents\/issue-21-product-spec\.md/);
});

test("plan_breakdown prompt includes JSON output contract", () => {
  const task = baseTask({ kind: "plan_breakdown" });
  const context = baseContext({
    instruction: "Break down the issue."
  });

  const packet = buildPromptPacket(task, context);
  const prompt = renderPrompt(task, packet);

  assert.match(prompt, /Return exactly one JSON object: \{ "sessionId": "<selected generator session id>" \}/);
  assert.match(prompt, /Do not wrap the JSON in a Markdown code fence/);
  assert.match(prompt, /Do not include prose before or after the JSON/);
  assert.match(prompt, /You must use the Plan Breakdown Generator tool/);
  assert.match(prompt, /Start a new session, build candidate packet plans using patches, and validate them/);
  assert.match(prompt, /Plan breakdown is a one-time decomposition step/);
  assert.match(prompt, /Do not artificially cap packet count or wave count/);
  assert.match(prompt, /more than 10 packets/);
  assert.match(prompt, /cheap or weaker implementation agent/);
  assert.match(prompt, /Packet PRs are planning shells/);
  assert.match(prompt, /Detailed per-packet plan documents are written later by write_plan tasks/);
  assert.match(prompt, /If no valid session can be produced, publish details to GitHub/);
  assert.match(prompt, /After failure details are published, finish without returning a valid sessionId/);
  assert.match(prompt, /No valid sessionId means the orchestrator treats the plan_breakdown task as failed/);
  assert.match(prompt, /Do not return raw PlanBreakdownResult JSON directly/);
  assert.match(prompt, /The orchestrator will export the selected session/);
  assert.doesNotMatch(prompt, /## Breakdown recommendation/);
  assert.doesNotMatch(prompt, /Output contract: your output MUST end with a single valid JSON object/);
  assert.doesNotMatch(prompt, /"tasks": \[/);
  assert.doesNotMatch(prompt, /"waves": \[/);
});

test("prependGlobalLaunchInstructions adds the run-scoped guidance ahead of the task prompt", () => {
  const combined = prependGlobalLaunchInstructions("Task prompt body", {
    githubBroker: {
      serverName: "github-broker",
      serverUrl: "http://127.0.0.1:4318/mcp",
      toolAllowList: ["get_issue"]
    }
  });

  assert.match(combined, /# Global Codex Instructions/);
  assert.match(combined, /Task prompt body$/);
});

test("CodexCliAgent parses structured review JSON decisions from stdout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-review-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout:
        'Review notes...\n{"action":"REQUEST_CHANGES","summary":"Two blocking issues.","inlineComments":[{"path":"src/app.ts","line":12,"body":"Guard against undefined state."}]}\n',
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      now: sequenceNow([
        "2026-04-18T10:00:00.000Z",
        "2026-04-18T10:00:05.000Z"
      ])
    });

    const result = await agent.dispatch(
      baseTask({
        kind: "review_pr",
        sourceKind: "pull_request",
        sourceId: "pull_request:example-org/repo-one:21",
        sourceUrl: "https://github.com/example-org/repo-one/pull/21",
        context: baseContext({
          pullRequestUrl: "https://github.com/example-org/repo-one/pull/21",
          instruction:
            'Review the pull request and finish with JSON. Use {"action":"APPROVE","summary":"..."} when there are no actionable findings. Use {"action":"REQUEST_CHANGES","summary":"...","inlineComments":[{"path":"relative/file.ts","line":12,"body":"..."}]} when changes are required.'
        })
      }),
      baseContext({
        pullRequestUrl: "https://github.com/example-org/repo-one/pull/21",
        instruction:
          'Review the pull request and finish with JSON. Use {"action":"APPROVE","summary":"..."} when there are no actionable findings. Use {"action":"REQUEST_CHANGES","summary":"...","inlineComments":[{"path":"relative/file.ts","line":12,"body":"..."}]} when changes are required.'
      }),
      baseAgent({ id: "codex-strong", roles: ["review"] })
    );

    assert.equal(result.execution.result?.review?.action, "REQUEST_CHANGES");
    assert.equal(result.execution.result?.review?.summary, "Two blocking issues.");
    assert.deepEqual(result.execution.result?.review?.inlineComments, [
      {
        path: "src/app.ts",
        line: 12,
        body: "Guard against undefined state."
      }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent fails review_pr when stdout has no valid structured review result", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-review-missing-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "Review notes...\n{\"summary\":\"Missing action.\"}\n",
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      now: sequenceNow([
        "2026-04-18T10:00:00.000Z",
        "2026-04-18T10:00:05.000Z"
      ])
    });

    const result = await agent.dispatch(
      baseTask({
        kind: "review_pr",
        sourceKind: "pull_request",
        sourceId: "pull_request:example-org/repo-one:21",
        sourceUrl: "https://github.com/example-org/repo-one/pull/21",
        context: baseContext({
          pullRequestUrl: "https://github.com/example-org/repo-one/pull/21",
          instruction:
            'Review the pull request and finish with JSON. Use {"action":"APPROVE","summary":"..."} when there are no actionable findings. Use {"action":"REQUEST_CHANGES","summary":"...","inlineComments":[{"path":"relative/file.ts","line":12,"body":"..."}]} when changes are required.'
        })
      }),
      baseContext({
        pullRequestUrl: "https://github.com/example-org/repo-one/pull/21",
        instruction:
          'Review the pull request and finish with JSON. Use {"action":"APPROVE","summary":"..."} when there are no actionable findings. Use {"action":"REQUEST_CHANGES","summary":"...","inlineComments":[{"path":"relative/file.ts","line":12,"body":"..."}]} when changes are required.'
      }),
      baseAgent({ id: "codex-strong", roles: ["review"] })
    );

    assert.equal(result.taskStatus, "failed");
    assert.equal(result.execution.result?.review, undefined);
    assert.match(
      result.execution.errorMessage ?? "",
      /valid structured review result/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent populates execution record with agentModel when provided", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-model-record-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout: "Success",
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir
    });

    const agentConfig = baseAgent({ model: "codex-test-model" });
    const result = await agent.dispatch(baseTask(), baseContext(), agentConfig);

    assert.equal(result.execution.agentModel, "codex-test-model");
    const call = commandRunner.calls[0];
    assert.ok(call);
    assert.ok(call.args.includes("--model"));
    assert.ok(call.args.includes("codex-test-model"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent preserves invalid inline comments in structured review JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-review-invalid-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout:
        'Review notes...\n{"action":"COMMENT","summary":"Summary.","inlineComments":[{"path":"src/app.ts","body":"Missing line."},{"line":12,"body":"Missing path."},{"path":"src/app.ts","line":12,"body":"Valid."}]}\n',
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      now: sequenceNow(["2026-04-18T10:00:00.000Z", "2026-04-18T10:00:05.000Z"])
    });

    const result = await agent.dispatch(
      baseTask({ kind: "review_pr" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["review"] })
    );

    assert.equal(result.execution.result?.review?.inlineComments?.length, 3);
    assert.deepEqual(result.execution.result?.review?.inlineComments, [
      { path: "src/app.ts", body: "Missing line." },
      { line: 12, body: "Missing path." },
      { path: "src/app.ts", line: 12, body: "Valid." }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent preserves invalid legacy findings in review JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-legacy-invalid-"));

  try {
    const commandRunner = new RecordingCommandRunner({
      stdout:
        'Review notes...\n{"decision":"approve","summary":"LGTM.","findings":[{"path":"src/app.ts","body":"Missing line."}]}\n',
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      now: sequenceNow(["2026-04-18T10:00:00.000Z", "2026-04-18T10:00:05.000Z"])
    });

    const result = await agent.dispatch(
      baseTask({ kind: "review_pr" }),
      baseContext(),
      baseAgent({ id: "codex-strong", roles: ["review"] })
    );

    assert.equal(result.execution.result?.review?.findings?.length, 1);
    assert.deepEqual(result.execution.result?.review?.findings, [
      { path: "src/app.ts", body: "Missing line." }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliAgent uses config overrides and leaves repo-local AGENTS.md untouched", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-launch-"));
  const repoDir = path.join(tempDir, "repo-one");

  try {
    await mkdir(repoDir, { recursive: true });
    await writeFile(path.join(repoDir, "AGENTS.md"), "# Repo Instructions\n", "utf8");

    const commandRunner = new RecordingCommandRunner({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      now: sequenceNow([
        "2026-04-18T10:00:00.000Z",
        "2026-04-18T10:00:05.000Z"
      ]),
      githubBroker: {
        serverName: "github-broker",
        serverUrl: "http://127.0.0.1:4318/mcp",
        toolAllowList: ["get_issue", "post_issue_comment"]
      }
    });

    await agent.dispatch(
      baseTask({ kind: "write_plan" }),
      baseContext({
        localRepoPath: repoDir,
        pullRequestUrl: "https://github.com/example-org/repo-one/pull/21",
        instruction: "Write the plan."
      }),
      baseAgent({ id: "codex-strong", roles: ["planning"] })
    );

    assert.equal(commandRunner.calls[0]?.options.cwd, repoDir);
    assert.equal(commandRunner.calls[0]?.options.env?.CODEX_HOME, undefined);
    assert.deepEqual(commandRunner.calls[0]?.args, [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      'mcp_servers.githubBroker.url="http://127.0.0.1:4318/mcp"',
      "-c",
      'mcp_servers.githubBroker.default_tools_approval_mode="approve"',
      "-"
    ]);
    assert.match(commandRunner.calls[0]?.options.input ?? "", /# Global Codex Instructions/);
    assert.match(commandRunner.calls[0]?.options.input ?? "", /Use the local MCP server `githubBroker`/);
    assert.match(commandRunner.calls[0]?.options.input ?? "", /Do not call `gh` directly/);
    assert.equal(await readFile(path.join(repoDir, "AGENTS.md"), "utf8"), "# Repo Instructions\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks persists task transitions and records failures cleanly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-dispatch-"));

  try {
    const store = new StateStore(tempDir);
    const state = await store.load();
    const task = baseTask({ kind: "implement_plan" });
    const failureNotifications: Array<{ taskId: string; executionId: string }> = [];
    await store.writeTaskState([task]);

    const result = await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-cheap", modelClass: "cheap", roles: ["implementation"] })],
      existingExecutions: state.executions,
      stateStore: store,
      logDir: tempDir,
      failureNotifier: {
        async notifyFailure(failedTask, execution) {
          failureNotifications.push({ taskId: failedTask.id, executionId: execution.id });
          return undefined;
        }
      },
      agentRunner: {
        async dispatch() {
          return {
            taskStatus: "failed",
            execution: {
              id: "exec:test:1",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "failed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "codex-cheap",
              agentProvider: "codex",
              command: {
                executable: "codex",
                args: ["exec", "-"],
                cwd: task.context.localRepoPath ?? "/tmp/code-root/repo-one",
                timeoutMs: 600000
              },
              promptArtifactPath: path.join(tempDir, "artifacts", "exec:test:1", "prompt.md"),
              stdoutArtifactPath: path.join(tempDir, "artifacts", "exec:test:1", "stdout.txt"),
              stderrArtifactPath: path.join(tempDir, "artifacts", "exec:test:1", "stderr.txt"),
              promptPacketPath: path.join(tempDir, "artifacts", "exec:test:1", "prompt-packet.json"),
              startedAt: "2026-04-18T10:01:00.000Z",
              endedAt: "2026-04-18T10:01:10.000Z",
              exitCode: 1,
              errorMessage: "mock failure"
            } satisfies ExecutionRecord
          };
        }
      },
      now: sequenceNow(["2026-04-18T10:01:00.000Z"])
    });

    const persistedState = JSON.parse(await readFile(path.join(tempDir, "tasks.json"), "utf8")) as {
      tasks: TaskRecord[];
    };
    const executionState = JSON.parse(await readFile(path.join(tempDir, "executions.json"), "utf8")) as {
      executions: ExecutionRecord[];
    };

    assert.equal(result.tasks[0]?.status, "failed");
    assert.equal(persistedState.tasks[0]?.status, "failed");
    assert.equal(persistedState.tasks[0]?.lastExecutionId, "exec:test:1");
    assert.equal(executionState.executions[0]?.id, "exec:test:1");
    assert.deepEqual(failureNotifications, [{ taskId: task.id, executionId: "exec:test:1" }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks publishes replanning completion as a superseding wave assessment", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-wave-replanning-dispatch-"));

  try {
    const store = new StateStore(tempDir);
    const checkpoint = {
      id: "checkpoint-1",
      sessionId: "checkpoint-1",
      identity: {
        repoKey: "example-org/repo-one",
        workstreamId: "example-org/repo-one:issue:21",
        waveId: "wave-0",
        parentPrNumber: 21,
        parentHeadSha: "abc123",
        parentIntegrationBranch: "agent/example-org-repo-one/issue-21",
        defaultBranch: "main",
        planRevision: "rev-1",
        originalPlanningSessionId: "planner-session-1",
        currentWaveIndex: 0,
        nextWaveIndex: 1,
        completedPacketIds: ["T1"],
        pendingFuturePacketIds: ["T2"],
        planNodeIds: ["T1", "T2"]
      }
    };
    const replanAssessment: WaveAssessmentResult = {
      id: "assessment-replan",
      sessionId: "assessment-replan",
      checkpoint,
      decision: "replan",
      summary: "Replan required.",
      findings: [],
      status: "finalized",
      postedCommentId: "old-comment",
      finalizedAt: "2026-04-18T09:30:00.000Z"
    };
    const workstream: WorkstreamRecord = {
      id: "example-org/repo-one:issue:21",
      repoKey: "example-org/repo-one",
      origin: { type: "issue", number: 21 },
      linkedIssueNumber: 21,
      linkedPrs: [{ number: 21, role: "implementation" }],
      activePrNumber: 21,
      phase: "implementing",
      attention: "idle",
      status: "open",
      resolution: "unresolved",
      integration: { branchName: "agent/example-org-repo-one/issue-21", prNumber: 21 },
      packetPlan: {
        status: "approved",
        packets: {
          T1: {
            id: "T1",
            title: "T1",
            summary: "T1",
            acceptanceCriteria: [],
            filesLikelyTouched: [],
            dependsOn: [],
            canRunInParallelWith: [],
            blocks: [],
            status: "merged_to_parent"
          },
          T2: {
            id: "T2",
            title: "T2",
            summary: "T2",
            acceptanceCriteria: [],
            filesLikelyTouched: [],
            dependsOn: [],
            canRunInParallelWith: [],
            blocks: [],
            status: "planned"
          }
        },
        waves: [["T1"], ["T2"]],
        currentWaveIndex: 0,
        updatedAt: "2026-04-18T09:00:00.000Z",
        waveAssessments: [replanAssessment]
      }
    };
    const task = baseTask({
      id: `task:wave_plan_replanning:${checkpoint.id}`,
      kind: "wave_plan_replanning",
      status: "pending",
      workstreamId: workstream.id,
      context: baseContext({
        waveAssessmentCheckpoint: checkpoint,
        finalizedWaveAssessment: replanAssessment,
        pullRequestUrl: "https://github.com/example-org/repo-one/pull/21"
      })
    });
    await store.writeTaskState([task]);
    await store.writeWorkstreamState([workstream]);
    const planBreakdown: PlanBreakdownResult = {
      title: "Replanned packet plan",
      summary: "A revised plan after wave assessment.",
      tasks: [
        {
          id: "R1",
          title: "Replanned task",
          description: "Carry the revised parent plan forward.",
          dependsOn: [],
          blocks: [],
          canRunInParallelWith: [],
          risk: "low",
          filesLikelyInvolved: ["src/replanned.ts"],
          acceptanceCriteria: ["The revised task is represented."],
          verification: ["Run focused tests."]
        }
      ],
      waves: [
        {
          id: "RW1",
          taskIds: ["R1"],
          rationale: "Start with the revised work."
        }
      ],
      recommendedFirstWaveId: "RW1",
      graphConcerns: [],
      humanDecisionsNeeded: [],
      suggestedNextAction: "Dispatch the revised wave."
    };

    let publishedAssessment: WaveAssessmentResult | undefined;
    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-manager", roles: ["implementation_manager"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      waveAssessmentPublisher: {
        async publishWaveAssessment(_task, execution) {
          publishedAssessment = execution.result?.waveAssessment;
          return "new-comment";
        }
      },
      agentRunner: {
        async dispatch() {
          return {
            taskStatus: "completed",
            execution: {
              id: "exec:replanning:1",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "codex-manager",
              agentProvider: "codex",
              command: {
                executable: "codex",
                args: ["exec", "-"],
                cwd: task.context.localRepoPath ?? "/tmp/code-root/repo-one",
                timeoutMs: 600000
              },
              promptArtifactPath: path.join(tempDir, "artifacts", "exec:replanning:1", "prompt.md"),
              stdoutArtifactPath: path.join(tempDir, "artifacts", "exec:replanning:1", "stdout.txt"),
              stderrArtifactPath: path.join(tempDir, "artifacts", "exec:replanning:1", "stderr.txt"),
              promptPacketPath: path.join(tempDir, "artifacts", "exec:replanning:1", "prompt-packet.json"),
              startedAt: "2026-04-18T10:01:00.000Z",
              endedAt: "2026-04-18T10:01:10.000Z",
              exitCode: 0,
              result: {
                planBreakdown
              }
            } satisfies ExecutionRecord
          };
        }
      },
      now: sequenceNow([
        "2026-04-18T10:01:00.000Z",
        "2026-04-18T10:01:10.000Z",
        "2026-04-18T10:01:11.000Z",
        "2026-04-18T10:01:12.000Z"
      ])
    });

    assert.equal(publishedAssessment?.decision, "continue");
    const state = await store.load();
    const persistedExecution = state.executions.find((execution) => execution.id === "exec:replanning:1");
    assert.equal(persistedExecution?.result?.waveAssessment?.decision, "continue");
    assert.equal(persistedExecution?.result?.waveAssessment?.postedCommentId, "new-comment");
    const persistedWorkstream = state.workstreams.find((item) => item.id === workstream.id);
    const continueAssessment = persistedWorkstream?.packetPlan?.waveAssessments?.find(
      (assessment) => assessment.decision === "continue"
    );
    assert.equal(continueAssessment?.postedCommentId, "new-comment");
    assert.equal(persistedWorkstream?.packetPlan?.status, "approved");
    assert.equal(persistedWorkstream?.packetPlan?.source?.generatedAt, "2026-04-18T10:01:10.000Z");
    assert.equal(
      continueAssessment?.checkpoint.identity.planRevision,
      persistedWorkstream?.packetPlan?.source?.generatedAt
    );
    assert.deepEqual(continueAssessment?.checkpoint.identity.planNodeIds, ["R1"]);
    assert.notEqual(continueAssessment?.checkpoint.id, checkpoint.id);
    assert.deepEqual(persistedWorkstream?.packetPlan?.waves, [["R1"]]);
    assert.equal(persistedWorkstream?.packetPlan?.packets.R1?.title, "Replanned task");
    assert.equal(persistedWorkstream?.packetPlan?.packets.T1, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks keeps wave assessment publication failures retryable across repeated attempts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-wave-assessment-publish-fail-"));
  try {
    const store = new StateStore(tempDir);
    const checkpoint = {
      id: "checkpoint-retry",
      sessionId: "checkpoint-retry",
      identity: {
        repoKey: "example-org/repo-one",
        workstreamId: "example-org/repo-one:issue:21",
        waveId: "wave-0",
        parentPrNumber: 21,
        parentHeadSha: "abc123",
        parentIntegrationBranch: "agent/example-org-repo-one/issue-21",
        defaultBranch: "main",
        planRevision: "rev-1",
        originalPlanningSessionId: "planner-session-1",
        currentWaveIndex: 0,
        nextWaveIndex: 1,
        completedPacketIds: ["T1"],
        pendingFuturePacketIds: ["T2"],
        planNodeIds: ["T1", "T2"]
      }
    };
    const workstream: WorkstreamRecord = {
      id: "example-org/repo-one:issue:21",
      repoKey: "example-org/repo-one",
      origin: { type: "issue", number: 21 },
      linkedIssueNumber: 21,
      linkedPrs: [{ number: 21, role: "implementation" }],
      activePrNumber: 21,
      phase: "implementing",
      attention: "idle",
      status: "open",
      resolution: "unresolved",
      integration: { branchName: "agent/example-org-repo-one/issue-21", prNumber: 21 },
      packetPlan: {
        status: "in_progress",
        source: {
          kind: "plan_breakdown_result",
          workstreamId: "example-org/repo-one:issue:21",
          generatedAt: "rev-1"
        },
        packets: {},
        waves: [["T1"], ["T2"]],
        currentWaveIndex: 0,
        updatedAt: "2026-04-18T09:00:00.000Z",
        waveAssessments: []
      }
    };
    const task = baseTask({
      id: `task:wave_plan_assessment:${checkpoint.id}`,
      kind: "wave_plan_assessment",
      status: "pending",
      workstreamId: workstream.id,
      context: baseContext({
        waveAssessmentCheckpoint: checkpoint,
        pullRequestUrl: "https://github.com/example-org/repo-one/pull/21"
      })
    });
    await store.writeTaskState([task]);
    await store.writeWorkstreamState([workstream]);

    let attempt = 0;
    const dispatchOnce = async () => {
      attempt += 1;
      await dispatchPendingTasks({
        tasks: [(await store.load()).tasks[0]!],
        agents: [baseAgent({ id: "codex-planner", roles: ["planning"] })],
        existingExecutions: (await store.load()).executions,
        stateStore: store,
        logDir: tempDir,
        waveAssessmentPublisher: {
          async publishWaveAssessment() {
            return undefined;
          }
        },
        agentRunner: {
          async dispatch(currentTask) {
            const assessment: WaveAssessmentResult = {
              id: `assessment-${attempt}`,
              sessionId: checkpoint.sessionId,
              checkpoint,
              decision: "continue",
              summary: "Continue.",
              findings: [],
              status: "finalized",
              createdAt: `2026-04-18T10:0${attempt}:00.000Z`,
              finalizedAt: `2026-04-18T10:0${attempt}:00.000Z`
            };
            return {
              taskStatus: "completed",
              execution: {
                id: `exec:assessment:${attempt}`,
                taskId: currentTask.id,
                taskKind: currentTask.kind,
                taskStatus: "completed",
                repoId: currentTask.repoId,
                repoSlug: currentTask.repoSlug,
                agentId: "codex-planner",
                agentProvider: "codex",
                command: {
                  executable: "codex",
                  args: ["exec", "-"],
                  cwd: currentTask.context.localRepoPath ?? "/tmp/code-root/repo-one",
                  timeoutMs: 600000
                },
                promptArtifactPath: path.join(tempDir, "artifacts", `exec:assessment:${attempt}`, "prompt.md"),
                stdoutArtifactPath: path.join(tempDir, "artifacts", `exec:assessment:${attempt}`, "stdout.txt"),
                stderrArtifactPath: path.join(tempDir, "artifacts", `exec:assessment:${attempt}`, "stderr.txt"),
                promptPacketPath: path.join(tempDir, "artifacts", `exec:assessment:${attempt}`, "prompt-packet.json"),
                startedAt: `2026-04-18T10:0${attempt}:00.000Z`,
                endedAt: `2026-04-18T10:0${attempt}:10.000Z`,
                exitCode: 0,
                result: {
                  waveAssessment: assessment
                }
              } satisfies ExecutionRecord
            };
          }
        },
        now: sequenceNow([
          `2026-04-18T10:0${attempt}:11.000Z`,
          `2026-04-18T10:0${attempt}:12.000Z`,
          `2026-04-18T10:0${attempt}:13.000Z`
        ])
      });
    };

    await dispatchOnce();
    let state = await store.load();
    assert.equal(state.tasks[0]?.status, "failed");
    assert.equal(state.tasks[0]?.context.recoveryNeeded, true);
    assert.equal(state.executions.length, 2);
    assert.equal(state.executions[1]?.taskStatus, "failed");
    assert.match(state.executions[1]?.errorMessage ?? "", /publishing the required parent PR assessment comment failed/);
    assert.equal(state.workstreams[0]?.packetPlan?.waveAssessments?.length, 0);

    await store.writeTaskState([
      {
        ...state.tasks[0]!,
        status: "pending",
        updatedAt: "2026-04-18T10:02:00.000Z"
      }
    ]);

    await dispatchOnce();
    state = await store.load();
    assert.equal(state.tasks[0]?.status, "failed");
    assert.equal(state.tasks[0]?.context.recoveryNeeded, true);
    assert.equal(state.executions.length, 4);
    assert.equal(state.executions.filter((execution) => execution.taskStatus === "failed").length, 2);
    assert.match(state.executions[3]?.errorMessage ?? "", /publishing the required parent PR assessment comment failed/);
    assert.equal(state.workstreams[0]?.packetPlan?.waveAssessments?.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks respects executionCwdByTaskId override", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-cwd-override-"));
  try {
    const store = new StateStore(tempDir);
    const task = baseTask({ id: "T1", kind: "implement_plan" });
    await store.writeTaskState([task]);

    let capturedCwd = "";
    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-cheap", modelClass: "cheap", roles: ["implementation"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      executionCwdByTaskId: new Map([["T1", "/overridden/path"]]),
      agentRunner: {
        async dispatch(_t, context) {
          capturedCwd = context.localRepoPath ?? "";
          return {
            taskStatus: "completed",
            execution: { id: "e1", endedAt: "now" } as any
          };
        }
      }
    });

    assert.strictEqual(capturedCwd, "/overridden/path");

    // Plan requirement: Durable task state MUST retain original localRepoPath, NOT the override.
    const tasksState = JSON.parse(await readFile(path.join(tempDir, "tasks.json"), "utf8")) as { tasks: TaskRecord[] };
    const persistedTask = tasksState.tasks.find(t => t.id === "T1");
    assert.strictEqual(persistedTask?.context.localRepoPath, "/tmp/code-root/repo-one");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks disables nativeResumeEnabled for prepare_pr_for_merge tasks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-resume-disable-"));
  try {
    const store = new StateStore(tempDir);
    const task = baseTask({
      id: "T1",
      kind: "prepare_pr_for_merge",
      workstreamId: "WS1",
      context: baseContext({ branchName: "feat" })
    });
    await store.writeTaskState([task]);

    let capturedDecisionReason: string | undefined = undefined;
    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", modelClass: "strong", roles: ["implementation_manager"], provider: "codex" })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      agentRunner: {
        async dispatch(_t, _c, _a, decision) {
          if (decision?.mode === "fallback") {
            capturedDecisionReason = decision.reason;
          }
          return {
            taskStatus: "completed",
            execution: { id: "e1", endedAt: "now" } as any
          };
        }
      }
    });

    assert.strictEqual(capturedDecisionReason, "native_resume_not_enabled");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

import { buildSinglePostDispatchHandoffFailureExecution } from "../src/agents/service.js";

test("buildSinglePostDispatchHandoffFailureExecution builds a correct record", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-handoff-fail-"));
  try {
    const task = baseTask({ id: "T1", kind: "prepare_pr_for_merge" });
    const { updatedTask, execution } = await buildSinglePostDispatchHandoffFailureExecution({
      task,
      reason: "Lease failed",
      logDir: tempDir,
      now: () => "2026-06-04T12:00:00Z"
    });

    assert.strictEqual(updatedTask.status, "failed");
    assert.strictEqual(execution.taskStatus, "failed");
    assert.strictEqual(execution.errorMessage, "Lease failed");
    assert.match(execution.id, /post-dispatch-handoff-failure/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildTechnicalFailureComment uses the bot prefix and asks for retry", () => {
  const task = baseTask({ kind: "product_discovery", sourceKind: "issue", sourceId: "issue:example-org/repo-one:11" });
  const execution: ExecutionRecord = {
    id: "exec:test:failure",
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: "failed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "codex-strong",
    agentProvider: "codex",
    command: {
      executable: "codex",
      args: ["exec", "-"],
      cwd: "/tmp/code-root/repo-one",
      timeoutMs: 600000
    },
    promptArtifactPath: "",
    stdoutArtifactPath: "",
    stderrArtifactPath: "",
    promptPacketPath: "",
    startedAt: "2026-04-21T08:00:00.000Z",
    endedAt: "2026-04-21T08:00:10.000Z",
    exitCode: 1,
    errorMessage: "ERROR: You've hit your usage limit."
  };

  const body = buildTechnicalFailureComment(task, execution);
  assert.match(body, /^🤖 /);
  assert.match(body, /product_discovery/);
  assert.match(body, /retry/);
});

test("buildTechnicalFailureComment prefers timeout details over noisy stderr banners", () => {
  const task = baseTask({
    kind: "implement_plan",
    sourceKind: "pull_request",
    sourceId: "pull_request:example-org/repo-one:25"
  });
  const execution: ExecutionRecord = {
    id: "exec:test:timeout",
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: "failed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "antigravity-cheap",
    agentProvider: "antigravity",
    command: {
      executable: "agy",
      args: ["-p"],
      cwd: "/tmp/code-root/repo-one",
      timeoutMs: 900000
    },
    promptArtifactPath: "",
    stdoutArtifactPath: "",
    stderrArtifactPath: "",
    promptPacketPath: "",
    startedAt: "2026-04-21T08:00:00.000Z",
    endedAt: "2026-04-21T08:15:00.000Z",
    exitCode: 124,
    errorMessage: "Failure: YOLO mode is enabled. Use plan mode instead."
  };

  const body = buildTechnicalFailureComment(task, execution);
  assert.match(body, /Timed out after 900000ms \(exitCode: 124\)\./);
  assert.doesNotMatch(body, /YOLO mode is enabled/);
});

test("GitHubTaskLifecycleNotifier posts dispatch comments to issue parents for issue comments", async () => {
  const reactions: unknown[] = [];
  const comments: unknown[] = [];
  const notifier = new GitHubTaskLifecycleNotifier(
    {
      async addReaction(input: unknown) {
        reactions.push(input);
      },
      async postIssueComment(input: unknown) {
        comments.push(input);
        return {
          id: 1,
          url: "https://github.com/example-org/repo-one/issues/11#issuecomment-1",
          body: "",
          createdAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:00.000Z",
          author: { login: "owner" }
        };
      }
    } as unknown as GitHubGateway,
    [
      {
        id: "repo-1",
        owner: "example-org",
        name: "repo-one",
        localPath: "repo-one",
        defaultBranch: "main",
        enabled: true,
        labels: {
          agentInProgress: "agent-in-progress",
          agentPlanApproved: "agent-plan-approved",
          agentProductApproved: "agent-product-approved",
          agentReview: "agent-review",
          planBreakdownNeeded: "plan-breakdown-needed",
          agentSyncParentBranch: "agent-sync-parent-branch",
          prepareForMerge: "prepare-for-merge"
        }
      }
    ]
  );

  await notifier.notifyDispatch(
    baseTask({
      kind: "respond_issue_comment",
      sourceKind: "comment",
      sourceId: "comment:example-org/repo-one:issue_comment:5001",
      sourceUrl: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
      parentSourceKind: "issue",
      parentSourceId: "issue:example-org/repo-one:11",
      summary: "Respond to issue comment"
    }),
    { isRetry: true }
  );

  assert.deepEqual(reactions, [
    {
      owner: "example-org",
      name: "repo-one",
      commentId: "5001",
      commentKind: "issue_comment",
      content: "eyes"
    }
  ]);
  assert.deepEqual(comments, [
    {
      owner: "example-org",
      name: "repo-one",
      issueNumber: 11,
      body:
        "🤖 I noticed this task and I'm starting work on it: **Respond to issue comment** (this is a re-run)"
    }
  ]);
});

test("GitHubTaskLifecycleNotifier carries review-comment kind when reacting to inline PR comments", async () => {
  const reactions: unknown[] = [];
  const notifier = new GitHubTaskLifecycleNotifier(
    {
      async addReaction(input: unknown) {
        reactions.push(input);
      }
    } as unknown as GitHubGateway,
    [
      {
        id: "repo-1",
        owner: "example-org",
        name: "repo-one",
        localPath: "repo-one",
        defaultBranch: "main",
        enabled: true,
        labels: {
          agentInProgress: "agent-in-progress",
          agentPlanApproved: "agent-plan-approved",
          agentProductApproved: "agent-product-approved",
          agentReview: "agent-review",
          planBreakdownNeeded: "plan-breakdown-needed",
          agentSyncParentBranch: "agent-sync-parent-branch",
          prepareForMerge: "prepare-for-merge"
        }
      }
    ]
  );

  await notifier.notifyCompletionStatus(
    baseTask({
      kind: "respond_pr_comment",
      sourceKind: "comment",
      sourceId: "comment:example-org/repo-one:pull_request_review_comment:6001",
      sourceUrl: "https://github.com/example-org/repo-one/pull/21#discussion_r6001",
      parentSourceKind: "pull_request",
      parentSourceId: "pull_request:example-org/repo-one:21",
      summary: "Respond to inline review comment"
    }),
    "completed"
  );

  assert.deepEqual(reactions, [
    {
      owner: "example-org",
      name: "repo-one",
      commentId: "6001",
      commentKind: "pull_request_review_comment",
      content: "+1"
    }
  ]);
});

test("dispatchPendingTasks skips irrelevant pending tasks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-dispatch-skip-"));

  try {
    const task = {
      ...baseTask({ kind: "review_pr" }),
      relevant: false
    };
    const commandRunner = new RecordingCommandRunner({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0
    });
    const agent = new CodexCliAgent({
      commandRunner,
      logDir: tempDir,
      now: sequenceNow([
        "2026-04-18T10:00:00.000Z",
        "2026-04-18T10:00:05.000Z"
      ])
    });
    const store = new StateStore(tempDir);

    const result = await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", roles: ["review"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      agentRunner: agent
    });

    assert.equal(commandRunner.calls.length, 0);
    assert.equal(result.tasks[0]?.status, "pending");
    assert.equal(result.executions.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks never dispatches sync_parent_branch tasks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-dispatch-sync-"));

  try {
    const task = baseTask({ kind: "sync_parent_branch" });
    let dispatched = false;
    const agentRunner = {
      async dispatch() {
        dispatched = true;
        return {
          status: "success",
          outputs: {},
          completedAt: new Date().toISOString(),
          source: { commitSha: "abc" }
        } as any;
      }
    };
    const store = new StateStore(tempDir);

    const result = await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", roles: ["implementation"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      agentRunner: agentRunner as any
    });

    assert.equal(dispatched, false, "Should not have dispatched sync_parent_branch task");
    assert.equal(result.tasks[0]?.status, "pending");
    assert.equal(result.executions.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks publishes completed review outcomes as PR reviews", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-review-publish-"));

  try {
    const task = baseTask({ kind: "review_pr" });
    const store = new StateStore(tempDir);
    const reviews: Array<Record<string, unknown>> = [];

    const publisher = new GitHubPullRequestReviewPublisher(
      {
        async getRepositoryMetadata() {
          throw new Error("unused");
        },
        async getRepositoryDefaultBranch() {
          throw new Error("unused");
        },
        async getIssue() {
          throw new Error("unused");
        },
        async getPullRequest() {
          return {
            id: "pull_request:example-org/repo-one:21",
            number: 21,
            title: "PR",
            body: "",
            url: "https://github.com/example-org/repo-one/pull/21",
            state: "OPEN",
            createdAt: "",
            updatedAt: "",
            author: null,
            labels: [],
            headRefName: "feature/test",
            headSha: "head-sha-123",
            baseRefName: "main",
            isDraft: false
          };
        },
        async findOpenPullRequestByHeadBranch() {
          throw new Error("unused");
        },
        async createPullRequest() {
          throw new Error("unused");
        },
        async searchCode() {
          throw new Error("unused");
        },
        async postIssueComment() {
          throw new Error("should not call postIssueComment for reviews anymore");
        },
        async updateIssueComment() {
          throw new Error("unused");
        },
        async postPullRequestReviewCommentReply() {
          throw new Error("unused");
        },
        async submitPullRequestReview(input: any) {
          reviews.push(input);
          return {
            id: 1,
            url: "https://github.com/example-org/repo-one/pull/21#review-1",
            body: input.body,
            state: input.event,
            submittedAt: "2026-04-18T10:00:10.000Z",
            author: { login: "owner" }
          };
        },
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
        async listPullRequestChangedFiles() {
          return [
            {
              path: "src/app.ts",
              rightChangedLines: [12],
              leftChangedLines: [],
              rightCommentableLines: [12],
              leftCommentableLines: []
            }
          ];
        },
        async listIssueEvents(): Promise<GhIssueEvent[]> {
          return [];
        },
        async listPullRequestCheckRuns(): Promise<GhCheckRun[]> {
          return [];
        },
        async addReaction() {
          return;
        }
      },
      [
        {
          id: "repo-1",
          owner: "example-org",
          name: "repo-one",
          localPath: "repo-one",
          defaultBranch: "main",
          enabled: true,
          labels: {
            agentInProgress: "agent-in-progress",
            agentPlanApproved: "agent-plan-approved",
            agentProductApproved: "agent-product-approved",
            agentReview: "agent-review",
            planBreakdownNeeded: "plan-breakdown-needed",
            agentSyncParentBranch: "agent-sync-parent-branch",
          prepareForMerge: "prepare-for-merge"
          }
        }
      ]
    );

    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", roles: ["review"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      reviewPublisher: publisher,
      agentRunner: {
        async dispatch() {
          return {
            taskStatus: "completed",
            execution: {
              id: "exec:test:review",
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: "codex-strong",
              agentProvider: "codex",
              command: {
                executable: "codex",
                args: ["exec", "-"],
                cwd: task.context.localRepoPath ?? "/tmp/code-root/repo-one",
                timeoutMs: 600000
              },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: "2026-04-18T10:01:00.000Z",
              endedAt: "2026-04-18T10:01:10.000Z",
              exitCode: 0,
              result: {
                review: {
                  action: "REQUEST_CHANGES",
                  summary: "Two changes required.",
                  inlineComments: [
                    {
                      path: "src/app.ts",
                      line: 12,
                      body: "Guard against undefined state."
                    }
                  ]
                }
              }
            } satisfies ExecutionRecord
          };
        }
      },
      now: sequenceNow(["2026-04-18T10:01:00.000Z"])
    });

    assert.deepEqual(reviews, [
      {
        owner: "example-org",
        name: "repo-one",
        pullRequestNumber: 21,
        event: "COMMENT",
        body: "🤖 Review result: changes requested\n\nTwo changes required.",
        commitId: "head-sha-123",
        comments: [
          {
            path: "src/app.ts",
            line: 12,
            body: "Guard against undefined state.",
            side: "RIGHT"
          }
        ]
      }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks moves invalid inline comments into the summary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-review-invalid-fallback-"));

  try {
    const task = baseTask({ kind: "review_pr" });
    const store = new StateStore(tempDir);
    const reviews: Array<Record<string, unknown>> = [];

    const publisher = new GitHubPullRequestReviewPublisher(
      {
        async getPullRequest() {
          return { headSha: "head-sha" } as any;
        },
        async listPullRequestChangedFiles() {
          return [{ path: "src/app.ts", rightChangedLines: [12], leftChangedLines: [], rightCommentableLines: [12], leftCommentableLines: [] }];
        },
        async submitPullRequestReview(input: any) {
          reviews.push(input);
          return { id: 1 } as any;
        }
      } as any,
      [
        {
          id: "repo-1",
          owner: "example-org",
          name: "repo-one",
          localPath: "repo-one",
          enabled: true,
          labels: {} as any
        }
      ]
    );

    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", roles: ["review"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      reviewPublisher: publisher,
      agentRunner: {
        async dispatch() {
          return {
            taskStatus: "completed",
            execution: {
              taskStatus: "completed",
              result: {
                review: {
                  action: "COMMENT",
                  summary: "Review summary.",
                  inlineComments: [
                    { path: "", line: 0, body: "" }, // Invalid
                    { path: "src/app.ts", line: 12, body: "Valid comment." }
                  ]
                }
              }
            } as any
          };
        }
      },
      now: sequenceNow(["2026-04-18T10:01:00.000Z"])
    });

    assert.equal(reviews.length, 1);
    assert.match(reviews[0]?.body as string, /Inline comment publication: 1 posted inline, 1 moved into this summary/);
    assert.match(reviews[0]?.body as string, /Moved from inline comments:/);
    assert.equal((reviews[0]?.comments as any[]).length, 1);
    assert.equal((reviews[0]?.comments as any[])[0].body, "Valid comment.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks retries with summary-only if GitHub rejects inline comments", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-review-retry-"));

  try {
    const task = baseTask({ kind: "review_pr" });
    const store = new StateStore(tempDir);
    const reviews: Array<Record<string, unknown>> = [];

    const publisher = new GitHubPullRequestReviewPublisher(
      {
        async getPullRequest() {
          return { headSha: "head-sha" } as any;
        },
        async listPullRequestChangedFiles() {
          return [{ path: "src/app.ts", rightChangedLines: [12], leftChangedLines: [], rightCommentableLines: [12], leftCommentableLines: [] }];
        },
        async submitPullRequestReview(input: any) {
          if (input.comments?.length > 0) {
            throw new Error("GitHub rejected inline placement");
          }
          reviews.push(input);
          return { id: 1 } as any;
        }
      } as any,
      [
        {
          id: "repo-1",
          owner: "example-org",
          name: "repo-one",
          localPath: "repo-one",
          enabled: true,
          labels: {} as any
        }
      ]
    );

    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", roles: ["review"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      reviewPublisher: publisher,
      agentRunner: {
        async dispatch() {
          return {
            taskStatus: "completed",
            execution: {
              taskStatus: "completed",
              result: {
                review: {
                  action: "APPROVE",
                  summary: "LGTM.",
                  inlineComments: [{ path: "src/app.ts", line: 12, body: "Minor nit." }]
                }
              }
            } as any
          };
        }
      },
      now: sequenceNow(["2026-04-18T10:01:00.000Z"])
    });

    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.event, "COMMENT");
    assert.match(reviews[0]?.body as string, /GitHub rejected inline placement/);
    assert.ok(!reviews[0]?.comments || (reviews[0]?.comments as any).length === 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks posts a PR thread comment if summary-only review publication fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-review-thread-fallback-"));

  try {
    const task = baseTask({ kind: "review_pr" });
    const store = new StateStore(tempDir);
    const threadComments: Array<Record<string, unknown>> = [];

    const publisher = new GitHubPullRequestReviewPublisher(
      {
        async getPullRequest() {
          return { headSha: "head-sha" } as any;
        },
        async listPullRequestChangedFiles() {
          return [{ path: "src/app.ts", rightChangedLines: [12], leftChangedLines: [], rightCommentableLines: [12], leftCommentableLines: [] }];
        },
        async submitPullRequestReview() {
          throw new Error("GitHub rejected review event");
        },
        async postIssueComment(input: any) {
          threadComments.push(input);
          return { id: 1 } as any;
        }
      } as any,
      [
        {
          id: "repo-1",
          owner: "example-org",
          name: "repo-one",
          localPath: "repo-one",
          enabled: true,
          labels: {} as any
        }
      ]
    );

    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", roles: ["review"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      reviewPublisher: publisher,
      agentRunner: {
        async dispatch() {
          return {
            taskStatus: "completed",
            execution: {
              taskStatus: "completed",
              result: {
                review: {
                  action: "REQUEST_CHANGES",
                  summary: "Needs changes.",
                  inlineComments: [{ path: "src/app.ts", line: 12, body: "Fix this." }]
                }
              }
            } as any
          };
        }
      },
      now: sequenceNow(["2026-04-18T10:01:00.000Z"])
    });

    assert.equal(threadComments.length, 1);
    assert.equal(threadComments[0]?.issueNumber, 21);
    assert.match(threadComments[0]?.body as string, /Review result: changes requested/);
    assert.match(threadComments[0]?.body as string, /GitHub rejected inline placement/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks moves inline comments on files not in diff to summary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-review-diff-missing-file-"));

  try {
    const task = baseTask({ kind: "review_pr" });
    const store = new StateStore(tempDir);
    const reviews: Array<Record<string, unknown>> = [];

    const publisher = new GitHubPullRequestReviewPublisher(
      {
        async getPullRequest() {
          return { headSha: "head-sha" } as any;
        },
        async listPullRequestChangedFiles() {
          return [{ path: "src/app.ts", rightChangedLines: [12], leftChangedLines: [], rightCommentableLines: [12], leftCommentableLines: [] }];
        },
        async submitPullRequestReview(input: any) {
          reviews.push(input);
          return { id: 1 } as any;
        }
      } as any,
      [
        {
          id: "repo-1",
          owner: "example-org",
          name: "repo-one",
          localPath: "repo-one",
          enabled: true,
          labels: {} as any
        }
      ]
    );

    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", roles: ["review"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      reviewPublisher: publisher,
      agentRunner: {
        async dispatch() {
          return {
            taskStatus: "completed",
            execution: {
              taskStatus: "completed",
              result: {
                review: {
                  action: "COMMENT",
                  summary: "Review summary.",
                  inlineComments: [
                    { path: "src/missing.ts", line: 12, body: "Missing file." },
                    { path: "src/app.ts", line: 40, body: "Unavailable line." },
                    { path: "src/app.ts", line: 12, body: "Valid comment." }
                  ]
                }
              }
            } as any
          };
        }
      },
      now: sequenceNow(["2026-04-18T10:01:00.000Z"])
    });

    assert.equal(reviews.length, 1);
    const body = reviews[0]?.body as string;
    assert.match(body, /Inline comment publication: 1 posted inline, 2 moved into this summary/);
    assert.match(body, /src\/missing.ts:12: Missing file. \(Reason: file is not in the PR diff\)/);
    assert.match(
      body,
      /src\/app.ts:40: Unavailable line. \(Reason: line 40 on RIGHT side is not available in the PR diff\)/
    );
    assert.equal((reviews[0]?.comments as any[]).length, 1);
    assert.equal((reviews[0]?.comments as any[])[0].body, "Valid comment.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatchPendingTasks validates range comments against the diff", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-review-diff-range-"));

  try {
    const task = baseTask({ kind: "review_pr" });
    const store = new StateStore(tempDir);
    const reviews: Array<Record<string, unknown>> = [];

    const publisher = new GitHubPullRequestReviewPublisher(
      {
        async getPullRequest() {
          return { headSha: "head-sha" } as any;
        },
        async listPullRequestChangedFiles() {
          return [{ path: "src/app.ts", rightChangedLines: [10, 11, 12], leftChangedLines: [5], rightCommentableLines: [10, 11, 12], leftCommentableLines: [5, 7] }];
        },
        async submitPullRequestReview(input: any) {
          reviews.push(input);
          return { id: 1 } as any;
        }
      } as any,
      [
        {
          id: "repo-1",
          owner: "example-org",
          name: "repo-one",
          localPath: "repo-one",
          enabled: true,
          labels: {} as any
        }
      ]
    );

    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", roles: ["review"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      reviewPublisher: publisher,
      agentRunner: {
        async dispatch() {
          return {
            taskStatus: "completed",
            execution: {
              taskStatus: "completed",
              result: {
                review: {
                  action: "COMMENT",
                  summary: "Review summary.",
                  inlineComments: [
                    { path: "src/app.ts", line: 12, startLine: 10, body: "Valid right range." },
                    { path: "src/app.ts", line: 12, startLine: 8, body: "Invalid right range." },
                    {
                      path: "src/app.ts",
                      line: 12,
                      side: "RIGHT",
                      startLine: 5,
                      startSide: "LEFT",
                      body: "Valid cross range."
                    },
                    {
                      path: "src/app.ts",
                      line: 12,
                      side: "RIGHT",
                      startLine: 6,
                      startSide: "LEFT",
                      body: "Invalid cross range."
                    },
                    { path: "src/app.ts", line: 7, side: "LEFT", body: "Valid left context." }
                  ]
                }
              }
            } as any
          };
        }
      },
      now: sequenceNow(["2026-04-18T10:01:00.000Z"])
    });

    assert.equal(reviews.length, 1);
    const body = reviews[0]?.body as string;
    assert.match(body, /Inline comment publication: 3 posted inline, 2 moved into this summary/);
    assert.match(
      body,
      /Invalid right range. \(Reason: line 8 in range 8-12 on RIGHT side is not available in the PR diff\)/
    );
    assert.match(body, /Invalid cross range. \(Reason: start line 6 on LEFT side is not available in the PR diff\)/);
    assert.equal((reviews[0]?.comments as any[]).length, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitHubPullRequestReviewPublisher publishes inline comments on unchanged context lines", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-review-context-line-"));

  try {
    const store = new StateStore(tempDir);
    const task = baseTask({ kind: "review_pr", summary: "Review context line" });
    const reviews: any[] = [];

    const publisher = new GitHubPullRequestReviewPublisher(
      {
        async getPullRequest() {
          return { headSha: "head-sha" } as any;
        },
        async listPullRequestChangedFiles() {
          return [
            {
              path: "management/state/tasks.json",
              rightChangedLines: [4],
              leftChangedLines: [4],
              rightCommentableLines: [1, 2, 3, 4],
              leftCommentableLines: [1, 2, 3, 4]
            }
          ];
        },
        async submitPullRequestReview(input: any) {
          reviews.push(input);
          return { id: 1 } as any;
        }
      } as any,
      [
        {
          id: "repo-1",
          owner: "example-org",
          name: "repo-one",
          localPath: "repo-one",
          enabled: true,
          labels: {} as any
        }
      ]
    );

    await dispatchPendingTasks({
      tasks: [task],
      agents: [baseAgent({ id: "codex-strong", roles: ["review"] })],
      existingExecutions: [],
      stateStore: store,
      logDir: tempDir,
      reviewPublisher: publisher,
      agentRunner: {
        async dispatch() {
          return {
            taskStatus: "completed",
            execution: {
              taskStatus: "completed",
              result: {
                review: {
                  action: "COMMENT",
                  summary: "Review summary.",
                  inlineComments: [
                    {
                      path: "management/state/tasks.json",
                      line: 3,
                      side: "RIGHT",
                      body: "Context-line comment."
                    }
                  ]
                }
              }
            } as any
          };
        }
      },
      now: sequenceNow(["2026-04-18T10:01:00.000Z"])
    });

    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].comments.length, 1);
    assert.equal(reviews[0].comments[0].line, 3);
    assert.equal(reviews[0].comments[0].side, "RIGHT");
    assert.ok(!reviews[0].body.includes("Moved from inline comments"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitHubTaskLifecycleNotifier uses sourceReactionTargetId for dispatch eyes reaction when provided", async () => {
  const reactions: any[] = [];
  const notifier = new GitHubTaskLifecycleNotifier(
    {
      async addReaction(input: any) {
        reactions.push(input);
      },
      async postIssueComment() {
        return { id: 1 } as any;
      }
    } as unknown as GitHubGateway,
    [
      {
        id: "repo-1",
        owner: "example-org",
        name: "repo-one",
        localPath: "repo-one",
        defaultBranch: "main",
        enabled: true,
        labels: {}
      } as any
    ]
  );

  await notifier.notifyDispatch(
    baseTask({
      kind: "respond_pr_comment",
      sourceKind: "comment",
      sourceId: "comment:example-org/repo-one:pull_request_comment:926817920",
      sourceReactionTargetId: "123456789",
      summary: "REST source ID test"
    }),
    { isRetry: false }
  );

  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].commentId, "123456789");
  assert.equal(reactions[0].commentKind, "pull_request_comment");
  assert.equal(reactions[0].content, "eyes");
});

test("GitHubTaskLifecycleNotifier uses sourceReactionTargetId for completion reactions when provided", async () => {
  const reactions: any[] = [];
  const notifier = new GitHubTaskLifecycleNotifier(
    {
      async addReaction(input: any) {
        reactions.push(input);
      }
    } as unknown as GitHubGateway,
    [
      {
        id: "repo-1",
        owner: "example-org",
        name: "repo-one",
        localPath: "repo-one",
        defaultBranch: "main",
        enabled: true,
        labels: {}
      } as any
    ]
  );

  const task = baseTask({
    kind: "respond_pr_comment",
    sourceKind: "comment",
    sourceId: "comment:example-org/repo-one:pull_request_comment:926817920",
    sourceReactionTargetId: "987654321",
    summary: "REST source ID test"
  });

  await notifier.notifyCompletionStatus(task, "completed");
  await notifier.notifyCompletionStatus(task, "failed");

  assert.equal(reactions.length, 2);
  assert.equal(reactions[0].commentId, "987654321");
  assert.equal(reactions[0].commentKind, "pull_request_comment");
  assert.equal(reactions[0].content, "+1");
  assert.equal(reactions[1].commentId, "987654321");
  assert.equal(reactions[1].commentKind, "pull_request_comment");
  assert.equal(reactions[1].content, "-1");
});

test("GitHubTaskLifecycleNotifier handles top-level PR comments using numeric REST IDs", async () => {
  const reactions: any[] = [];
  const notifier = new GitHubTaskLifecycleNotifier(
    {
      async addReaction(input: any) {
        reactions.push(input);
      }
    } as unknown as GitHubGateway,
    [
      {
        id: "repo-1",
        owner: "example-org",
        name: "repo-one",
        localPath: "repo-one",
        defaultBranch: "main",
        enabled: true,
        labels: {}
      } as any
    ]
  );

  const task = baseTask({
    kind: "respond_pr_comment",
    sourceKind: "comment",
    sourceId: "comment:example-org/repo-one:pull_request_comment:123456789",
    sourceReactionTargetId: "123456789",
    parentSourceKind: "pull_request",
    parentSourceId: "pull_request:example-org/repo-one:21",
    summary: "Top-level PR comment test"
  });

  await notifier.notifyDispatch(task, { isRetry: false });
  await notifier.notifyCompletionStatus(task, "completed");

  assert.equal(reactions.length, 2);
  assert.equal(reactions[0].commentId, "123456789");
  assert.equal(reactions[0].commentKind, "pull_request_comment");
  assert.equal(reactions[0].content, "eyes");
  assert.equal(reactions[1].commentId, "123456789");
  assert.equal(reactions[1].commentKind, "pull_request_comment");
  assert.equal(reactions[1].content, "+1");
});

test("GitHubTaskLifecycleNotifier continues to post dispatch comment even if eyes reaction fails", async () => {
  const comments: any[] = [];
  const notifier = new GitHubTaskLifecycleNotifier(
    {
      async addReaction() {
        throw new Error("Simulated reaction failure");
      },
      async postIssueComment(input: any) {
        comments.push(input);
        return {
          id: 1,
          url: "https://github.com/example-org/repo-one/pull/21#issuecomment-1",
          body: input.body,
          createdAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:00.000Z",
          author: { login: "owner" }
        };
      }
    } as unknown as GitHubGateway,
    [
      {
        id: "repo-1",
        owner: "example-org",
        name: "repo-one",
        localPath: "repo-one",
        defaultBranch: "main",
        enabled: true,
        labels: {}
      } as any
    ]
  );

  const task = baseTask({
    kind: "respond_pr_comment",
    sourceKind: "comment",
    sourceId: "comment:example-org/repo-one:pull_request_comment:926817920",
    sourceReactionTargetId: "123456789",
    parentSourceKind: "pull_request",
    parentSourceId: "pull_request:example-org/repo-one:21",
    summary: "Regression test for reaction failure"
  });

  await assert.doesNotReject(async () => {
    await notifier.notifyDispatch(task, { isRetry: false });
  });

  assert.equal(comments.length, 1);
  assert.equal(comments[0].owner, "example-org");
  assert.equal(comments[0].name, "repo-one");
  assert.equal(comments[0].issueNumber, 21);
  assert.match(comments[0].body, /🤖 I noticed this task and I'm starting work on it: \*\*Regression test for reaction failure\*\*/);
});

test("GitHubTaskLifecycleNotifier posts dispatch comments and completion reactions to packet PR", async () => {
  const reactions: any[] = [];
  const comments: any[] = [];
  const notifier = new GitHubTaskLifecycleNotifier(
    {
      async addReaction(input: any) {
        reactions.push(input);
      },
      async postIssueComment(input: any) {
        comments.push(input);
        return { id: 1 } as any;
      }
    } as unknown as GitHubGateway,
    [
      {
        id: "repo-1",
        owner: "example-org",
        name: "repo-one",
        localPath: "repo-one",
        defaultBranch: "main",
        enabled: true,
        labels: {}
      } as any
    ]
  );

  const task = baseTask({
    kind: "implement_plan",
    sourceKind: "pull_request",
    sourceId: "pull_request:example-org/repo-one:100",
    sourceUrl: "https://github.com/example-org/repo-one/pull/100",
    summary: "Implement approved packet \"T1\" in wave 0",
    context: baseContext({
      pullRequestUrl: "https://github.com/example-org/repo-one/pull/100",
      issueUrl: "https://github.com/example-org/repo-one/issues/96"
    })
  });

  await notifier.notifyDispatch(task, { isRetry: false });
  await notifier.notifyCompletionStatus(task, "completed");

  assert.equal(reactions.length, 2);
  // Dispatch reaction
  assert.equal(reactions[0].issueNumber, 100);
  assert.equal(reactions[0].content, "eyes");
  // Completion reaction
  assert.equal(reactions[1].issueNumber, 100);
  assert.equal(reactions[1].content, "+1");

  // Dispatch comment
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issueNumber, 100);
  assert.match(comments[0].body, /🤖 I noticed this task and I'm starting work on it/);
});

test("GitHubTaskLifecycleNotifier posts queued comments to issue parents when provider is rate-limited", async () => {
  const comments: any[] = [];
  const notifier = new GitHubTaskLifecycleNotifier(
    {
      async postIssueComment(input: any) {
        comments.push(input);
        return {
          id: 1,
          url: "https://github.com/example-org/repo-one/issues/11#issuecomment-1",
          body: "",
          createdAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:00.000Z",
          author: { login: "owner" }
        };
      }
    } as unknown as GitHubGateway,
    [
      {
        id: "repo-1",
        owner: "example-org",
        name: "repo-one",
        localPath: "repo-one",
        defaultBranch: "main",
        enabled: true,
        labels: {
          agentInProgress: "agent-in-progress",
          agentPlanApproved: "agent-plan-approved",
          agentProductApproved: "agent-product-approved",
          agentReview: "agent-review",
          planBreakdownNeeded: "plan-breakdown-needed",
          agentSyncParentBranch: "agent-sync-parent-branch",
          prepareForMerge: "prepare-for-merge"
        }
      }
    ]
  );

  const task = baseTask({
    kind: "respond_issue_comment",
    sourceKind: "comment",
    sourceId: "comment:example-org/repo-one:issue_comment:5001",
    sourceUrl: "https://github.com/example-org/repo-one/issues/11#issuecomment-5001",
    parentSourceKind: "issue",
    parentSourceId: "issue:example-org/repo-one:11",
    summary: "Respond to issue comment"
  });

  await notifier.notifyQueued(task, "claude");

  assert.equal(comments.length, 1);
  assert.equal(comments[0].issueNumber, 11);
  assert.match(comments[0].body, /🤖 I've queued this task because the AI provider \(`claude`\) has hit its session\/rate limit\. It will resume automatically once the limit resets\./);
});

test("prompt rendering for sync_parent_branch_preflight includes preflight details", () => {
  const task = baseTask({
    kind: "sync_parent_branch_preflight",
    sourceKind: "issue",
    sourceId: "issue:example-org/repo-one:11",
    sourceUrl: "https://github.com/example-org/repo-one/issues/11",
    context: baseContext({
      issueUrl: "https://github.com/example-org/repo-one/issues/11",
      issueTitle: "Need a workflow",
      instruction: "Do not modify files or run git sync commands. Analyze the repo state and the preflight data below to determine if a parent branch sync is required before implementing the next packet wave.",
      preflight: {
        workstreamId: "example-org/repo-one:issue:11",
        repoKey: "example-org/repo-one",
        parentIntegrationBranch: "agent/example-org-repo-one/issue-11",
        parentPrNumber: 31,
        defaultBranch: "main",
        currentWaveIndex: 0,
        nextWaveIndex: 1,
        completedPacketIds: ["T1"],
        pendingFuturePacketIds: ["T2"]
      }
    })
  });

  const packet = buildPromptPacket(task, task.context);
  const prompt = renderPrompt(task, packet);

  assert.deepEqual(packet.preflight, task.context.preflight);
  assert.match(prompt, /Current packet wave: 0/);
  assert.match(prompt, /Next packet wave: 1/);
  assert.match(prompt, /Parent integration branch: agent\/example-org-repo-one\/issue-11/);
  assert.match(prompt, /Default branch: main/);
  assert.match(prompt, /Completed packet IDs: T1/);
  assert.match(prompt, /Pending future packet IDs: T2/);
  assert.match(prompt, /Parent PR: #31/);
});

test("prompt rendering for sync_parent_branch_preflight handles missing parentPrNumber safely", () => {
  const task = baseTask({
    kind: "sync_parent_branch_preflight",
    context: baseContext({
      preflight: {
        workstreamId: "example-org/repo-one:issue:11",
        repoKey: "example-org/repo-one",
        parentIntegrationBranch: "agent/example-org-repo-one/issue-11",
        defaultBranch: "main",
        currentWaveIndex: 0,
        nextWaveIndex: 1,
        completedPacketIds: ["T1"],
        pendingFuturePacketIds: ["T2"]
      }
    })
  });

  const packet = buildPromptPacket(task, task.context);
  const prompt = renderPrompt(task, packet);

  assert.match(prompt, /Parent integration branch: agent\/example-org-repo-one\/issue-11/);
  assert.doesNotMatch(prompt, /Parent PR: #undefined/);
  assert.doesNotMatch(prompt, /Parent PR: #0/);
  assert.ok(!prompt.includes("Parent PR:"), "Should not include Parent PR line when parentPrNumber is missing");
});

test("prompt rendering for sync_parent_branch includes preflight details and workspace-write instructions", () => {
  const task = baseTask({
    kind: "sync_parent_branch",
    sourceKind: "pull_request",
    sourceId: "pull_request:example-org/repo-one:31",
    sourceUrl: "https://github.com/example-org/repo-one/pull/31",
    context: baseContext({
      pullRequestUrl: "https://github.com/example-org/repo-one/pull/31",
      instruction: "Resolve the requested parent branch sync for the packet workstream using the provided preflight context. Preserve the safety distinction between behind_default, diverged, and unknown/missing refs; leave the workspace clean after success or failure; do not advance the packet wave manually. The orchestrator remains responsible for remote publication handoff.",
      preflight: {
        workstreamId: "example-org/repo-one:issue:11",
        repoKey: "example-org/repo-one",
        parentIntegrationBranch: "agent/example-org-repo-one/issue-11",
        parentPrNumber: 31,
        defaultBranch: "main",
        currentWaveIndex: 0,
        nextWaveIndex: 1,
        completedPacketIds: ["T1"],
        pendingFuturePacketIds: ["T2"]
      }
    })
  });

  const packet = buildPromptPacket(task, task.context);
  const prompt = renderPrompt(task, packet);

  assert.deepEqual(packet.preflight, task.context.preflight);
  assert.equal(packet.executionPermission, "workspace-write");
  assert.match(prompt, /Current packet wave: 0/);
  assert.match(prompt, /Next packet wave: 1/);
  assert.match(prompt, /Parent integration branch: agent\/example-org-repo-one\/issue-11/);
  assert.match(prompt, /Default branch: main/);
  assert.match(prompt, /Completed packet IDs: T1/);
  assert.match(prompt, /Pending future packet IDs: T2/);
  assert.match(prompt, /Parent PR: #31/);
  assert.match(prompt, /local execution permission: workspace-write/);
  assert.match(prompt, /Resolve the requested parent branch sync/);
  assert.match(prompt, /Preserve the safety distinction/);
  assert.match(prompt, /leave the workspace clean/);
});

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "codex-default",
    provider: "codex",
    modelClass: "strong",
    roles: ["discussion"],
    command: "codex",
    enabled: true,
    ...overrides
  } as AgentConfig;
}

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const kind = overrides.kind ?? "write_plan";
  const executionPolicy = workflowRegistry.resolveTaskExecutionPolicy(kind);

  return {
    id: "task:write_plan:pull_request:example-org/repo-one:21",
    kind,
    status: "pending",
    executionPermission: executionPolicy.executionPermission,
    handoffPolicy: executionPolicy.handoffPolicy,
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    sourceKind: "pull_request",
    sourceId: "pull_request:example-org/repo-one:21",
    sourceUrl: "https://github.com/example-org/repo-one/pull/21",
    relevant: true,
    reason: "PR is ready.",
    summary: "Write a plan",
    workstreamId: "example-org/repo-one:issue:21",
    context: baseContext({
      pullRequestUrl: "https://github.com/example-org/repo-one/pull/21"
    }),
    createdAt: "2026-04-18T09:00:00.000Z",
    updatedAt: "2026-04-18T09:00:00.000Z",
    ...overrides
  };
}

function baseContext(overrides: Partial<BuiltContext> = {}): BuiltContext {
  return {
    taskId: "task:write_plan:pull_request:example-org/repo-one:21",
    repoIdentifier: "example-org/repo-one",
    localRepoPath: "/tmp/code-root/repo-one",
    labels: ["agent-in-progress"],
    instruction:
      "Read the pull request and comment, then resolve the request or respond with the required follow-up.",
    ...overrides
  };
}

function sequenceNow(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

class RecordingCommandRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: string[];
    options: CommandRunnerOptions;
  }> = [];

  constructor(private readonly result: CommandRunnerResult) {}

  async run(command: string, args: string[], options: CommandRunnerOptions = {}): Promise<CommandRunnerResult> {
    this.calls.push({
      command,
      args,
      options
    });
    if (this.result.stdout && options.onOutputChunk) {
      options.onOutputChunk("stdout", this.result.stdout);
    }
    if (this.result.stderr && options.onOutputChunk) {
      options.onOutputChunk("stderr", this.result.stderr);
    }
    return this.result;
  }
}
