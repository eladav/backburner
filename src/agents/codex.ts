import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { AgentConfig } from "../config/types.js";
import type { BuiltContext } from "../context/types.js";
import type {
  ExecutionRecord,
  ReviewDecisionResult,
  TriageDecisionResult
} from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import type { CommandRunner } from "../utils/command-runner.js";
import { writeJsonFileAtomic } from "../utils/json.js";
import type { Logger } from "../utils/logger.js";
import type { ProviderSessionDecision } from "./provider-sessions.js";
import {
  buildCodexCliArgs,
  prependGlobalLaunchInstructions,
  resolveCodexLaunchConfig,
  toCodexCliSafeServerName
} from "./codex-launch.js";
import {
  buildExecutionId,
  extractExitCode,
  extractAndExportPlanBreakdownResult,
  extractAndExportWaveAssessmentResult,
  extractReviewResult,
  extractStderr,
  extractStdout,
  extractTriageResult,
  detectProviderLimit
} from "./extraction.js";
import { buildPromptPacket, renderPrompt } from "./prompt.js";
import type { AgentRunner, DispatchResult } from "./types.js";
import { PlanBreakdownSessionStore } from "../workstreams/plan-breakdown-generator/store.js";
import { WaveAssessmentSessionStore } from "../workstreams/wave-assessment/store.js";
import type { ResolvedPromptContent } from "../prompts/resolver.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export interface CodexGitHubBrokerConfig {
  serverName: string;
  serverUrl: string;
  toolAllowList: string[];
}

export interface CodexCliAgentOptions {
  commandRunner: CommandRunner;
  logDir: string;
  logger?: Logger;
  now?: () => string;
  timeoutMs?: number;
  githubBroker?: CodexGitHubBrokerConfig;
  planBreakdownSessionStore?: PlanBreakdownSessionStore;
  waveAssessmentSessionStore?: WaveAssessmentSessionStore;
}

export class CodexCliAgent implements AgentRunner {
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;

  constructor(private readonly options: CodexCliAgentOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
  }

  async dispatch(
    task: TaskRecord,
    context: BuiltContext,
    agentConfig: AgentConfig,
    sessionDecision?: ProviderSessionDecision,
    promptContent?: ResolvedPromptContent
  ): Promise<DispatchResult> {
    const launchConfig = resolveCodexLaunchConfig({
      executionPermission: task.executionPermission,
      handoffPolicy: task.handoffPolicy
    });
    const githubBroker = this.options.githubBroker
      ? {
          ...this.options.githubBroker,
          serverName: toCodexCliSafeServerName(this.options.githubBroker.serverName)
        }
      : undefined;
    const promptPacket = buildPromptPacket(task, context);
    const promptText = prependGlobalLaunchInstructions(
      renderPrompt(task, promptPacket, {
        customConstraints: promptContent?.content,
        learningOverlays: promptContent?.learningOverlays
      }),
      githubBroker ? { githubBroker } : {}
    );
    const startedAt = this.now();
    const executionId = buildExecutionId(task.id, startedAt);
    const artifactDir = path.join(this.options.logDir, "artifacts", executionId);
    const promptPacketPath = path.join(artifactDir, "prompt-packet.json");
    const promptArtifactPath = path.join(artifactDir, "prompt.md");
    const stdoutArtifactPath = path.join(artifactDir, "stdout.txt");
    const stderrArtifactPath = path.join(artifactDir, "stderr.txt");
    const streamArtifactPath = path.join(artifactDir, "stdout-stream.jsonl");
    const resumeThreadId =
      sessionDecision?.mode === "native_resume_candidate"
        ? sessionDecision.record.providerSessionId
        : undefined;
    const args = buildCodexCliArgs({
      sandboxMode: launchConfig.sandboxMode,
      resumeThreadId,
      ...(githubBroker ? { githubBroker } : {}),
      ...(agentConfig.model ? { model: agentConfig.model } : {})
    });
    const cwd = context.localRepoPath ?? process.cwd();
    const timeoutMs = agentConfig.timeoutMs ?? this.timeoutMs;

    await mkdir(artifactDir, { recursive: true });
    await Promise.all([
      writeJsonFileAtomic(promptPacketPath, promptPacket),
      writeFile(promptArtifactPath, promptText, "utf8")
    ]);
    if (githubBroker) {
      this.logger?.info(
        JSON.stringify({
          component: "codex-launch",
          taskKind: task.kind,
          targetRepoPath: cwd,
          executionPermission: launchConfig.executionPermission,
          sandboxMode: launchConfig.sandboxMode,
          expectsPushableHandoff: launchConfig.expectsPushableHandoff,
          orchestratorOwnsPush: launchConfig.orchestratorOwnsPush,
          remotePublishOwner: launchConfig.remotePublishOwner,
          mcpServerName: githubBroker.serverName,
          mcpServerUrl: githubBroker.serverUrl,
          enabledToolAllowList: githubBroker.toolAllowList,
          configOverrides: args.filter((_, index) => args[index - 1] === "-c")
        })
      );
    } else {
      this.logger?.info(
        JSON.stringify({
          component: "codex-launch",
          taskKind: task.kind,
          targetRepoPath: cwd,
          executionPermission: launchConfig.executionPermission,
          sandboxMode: launchConfig.sandboxMode,
          expectsPushableHandoff: launchConfig.expectsPushableHandoff,
          orchestratorOwnsPush: launchConfig.orchestratorOwnsPush,
          remotePublishOwner: launchConfig.remotePublishOwner
        })
      );
    }

    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    let endedAt = startedAt;
    let stdoutStreamFd: number | undefined;

    try {
      stdoutStreamFd = openSync(streamArtifactPath, "w");

      const result = await this.options.commandRunner.run(agentConfig.command, args, {
        cwd,
        input: promptText,
        timeoutMs,
        onOutputChunk: (stream, chunk) => {
          if (stream === "stdout" && stdoutStreamFd !== undefined) {
            writeSync(stdoutStreamFd, chunk);
          }
        }
      });

      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
      endedAt = this.now();
    } catch (error: unknown) {
      exitCode = extractExitCode(error);
      stdout = extractStdout(error);
      stderr = extractStderr(error);
      endedAt = this.now();
    } finally {
      if (stdoutStreamFd !== undefined) {
        closeSync(stdoutStreamFd);
      }
    }

    const derivedStdout =
      exitCode === 0
        ? extractCodexStreamJsonAssistantText(stdout) ?? stdout
        : stdout;

    await Promise.all([
      writeFile(stdoutArtifactPath, derivedStdout, "utf8"),
      writeFile(stderrArtifactPath, stderr, "utf8")
    ]);

    const triageResult = extractTriageResult(task, derivedStdout);
    const reviewResult = extractReviewResult(task, derivedStdout);
    const planBreakdownExtraction = extractAndExportPlanBreakdownResult(
      task,
      derivedStdout,
      this.options.planBreakdownSessionStore
    );
    const waveAssessmentExtraction = extractAndExportWaveAssessmentResult(
      task,
      derivedStdout,
      this.options.waveAssessmentSessionStore
    );

    let taskStatus: ExecutionRecord["taskStatus"] = exitCode === 0 ? "completed" : "failed";
    let errorMessage =
      exitCode === 0 ? undefined : stderr.trim() || "Codex CLI exited with a non-zero status.";

    if (task.kind === "review_pr" && exitCode === 0 && !reviewResult) {
      taskStatus = "failed";
      errorMessage = "Agent output did not contain a valid structured review result.";
    }

    if ((task.kind === "plan_breakdown" || task.kind === "wave_plan_replanning") && exitCode === 0) {
      if (!planBreakdownExtraction.ok) {
        taskStatus = "failed";
        errorMessage = planBreakdownExtraction.message;
      }
    }

    if (task.kind === "wave_plan_assessment" && exitCode === 0) {
      if (!waveAssessmentExtraction.ok) {
        taskStatus = "failed";
        errorMessage = waveAssessmentExtraction.message;
      }
    }

    const execution: ExecutionRecord = {
      id: executionId,
      taskId: task.id,
      taskKind: task.kind,
      taskStatus,
      repoId: task.repoId,
      repoSlug: task.repoSlug,
      agentId: agentConfig.id,
      agentProvider: "codex",
      ...(agentConfig.model ? { agentModel: agentConfig.model } : {}),
      command: {
        executable: agentConfig.command,
        args,
        cwd,
        timeoutMs
      },
      promptArtifactPath,
      stdoutArtifactPath,
      stderrArtifactPath,
      streamArtifactPath,
      promptPacketPath,
      startedAt,
      endedAt,
      exitCode,
      ...(errorMessage ? { errorMessage } : {}),
      ...(triageResult || reviewResult || planBreakdownExtraction.ok || waveAssessmentExtraction.ok
        ? {
            result: {
              ...(triageResult ? { triage: triageResult } : {}),
              ...(reviewResult ? { review: reviewResult } : {}),
              ...(planBreakdownExtraction.ok
                ? {
                    planBreakdown: planBreakdownExtraction.planBreakdown,
                    planBreakdownSessionId: planBreakdownExtraction.sessionId
                  }
                : {}),
              ...(waveAssessmentExtraction.ok
                ? {
                    waveAssessment: waveAssessmentExtraction.waveAssessment
                  }
                : {})
            }
          }
        : {})
    };

    const parsedThreadId = extractThreadIdFromCodexOutput(stdout);
    const providerLimitSignal =
      exitCode === 0
        ? undefined
        : detectProviderLimit("codex", exitCode, extractCodexProviderErrorText(stdout), stderr);

    return {
      taskStatus: execution.taskStatus,
      execution,
      ...(providerLimitSignal ? { providerLimitSignal } : {}),
      ...(parsedThreadId ? { providerSession: { providerSessionId: parsedThreadId, status: "active" } } : {})
    };
  }
}

function extractThreadIdFromCodexOutput(streamText: string): string | undefined {
  if (!streamText.trim()) {
    return undefined;
  }

  const plainTextMatch = /\bsession id:\s*([0-9a-f-]{36})\b/i.exec(streamText);
  if (plainTextMatch?.[1]) {
    return plainTextMatch[1];
  }

  for (const line of streamText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === "object" && event.type === "thread.started" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function extractCodexStreamJsonAssistantText(streamText: string): string | undefined {
  if (!streamText.trim()) {
    return undefined;
  }

  let assistantText = "";
  let sawAssistantMessage = false;

  for (const line of streamText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed);
      if (
        event &&
        typeof event === "object" &&
        event.type === "item.completed" &&
        event.item &&
        typeof event.item === "object" &&
        event.item.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        assistantText += event.item.text;
        sawAssistantMessage = true;
      }
    } catch {
      continue;
    }
  }

  if (sawAssistantMessage) {
    return assistantText;
  }

  return undefined;
}

function extractCodexProviderErrorText(streamText: string): string {
  if (!streamText.trim()) {
    return "";
  }

  const extractedErrors: string[] = [];
  let sawJsonLine = false;

  for (const line of streamText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed);
      sawJsonLine = true;
      collectCodexErrorStrings(event, extractedErrors);
    } catch {
      // Non-JSON Codex output is a direct process surface and can be scanned.
      extractedErrors.push(trimmed);
    }
  }

  return sawJsonLine ? extractedErrors.join("\n") : streamText;
}

function collectCodexErrorStrings(value: unknown, out: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const isErrorEvent = type.toLowerCase().includes("error");

  if (isErrorEvent) {
    for (const key of ["message", "error", "details"]) {
      const text = stringifyCodexErrorField(record[key]);
      if (text) {
        out.push(text);
      }
    }
  }

  const errorText = stringifyCodexErrorField(record.error);
  if (errorText && (isErrorEvent || record.status === "failed")) {
    out.push(errorText);
  }
}

function stringifyCodexErrorField(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
    if (typeof record.code === "string") {
      return record.code;
    }
  }
  return undefined;
}
