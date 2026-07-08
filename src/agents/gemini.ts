import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { AgentConfig } from "../config/types.js";
import type { BuiltContext } from "../context/types.js";
import type { ExecutionRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import type { CommandRunner } from "../utils/command-runner.js";
import { writeJsonFileAtomic } from "../utils/json.js";
import type { Logger } from "../utils/logger.js";
import type { ProviderSessionDecision } from "./provider-sessions.js";
import {
  buildGeminiCliArgs,
  GEMINI_MODEL_FALLBACKS,
  getGeminiEnvOverrides,
  mapPermissionToApprovalMode,
  prependGlobalGeminiLaunchInstructions,
  writeGeminiSystemSettings,
  type GeminiMcpRuntime
} from "./gemini-launch.js";
import {
  buildExecutionId,
  extractExitCode,
  extractAndExportPlanBreakdownResult,
  extractAndExportWaveAssessmentResult,
  isRecord,
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

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const GEMINI_RETRYABLE_EXHAUSTION_PATTERN =
  /\b(?:QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED)\b|no capacity available|model capacity|quota/i;

export interface GeminiCliAgentOptions {
  commandRunner: CommandRunner;
  logDir: string;
  logger?: Logger;
  now?: () => string;
  timeoutMs?: number;
  githubBroker?: GeminiMcpRuntime;
  planBreakdownSessionStore?: PlanBreakdownSessionStore;
  waveAssessmentSessionStore?: WaveAssessmentSessionStore;
}

export class GeminiCliAgent implements AgentRunner {
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;

  constructor(private readonly options: GeminiCliAgentOptions) {
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
    const promptPacket = buildPromptPacket(task, context);
    const promptText = prependGlobalGeminiLaunchInstructions(
      renderPrompt(task, promptPacket, {
        providerIdentity: "Gemini CLI",
        customConstraints: promptContent?.content,
        learningOverlays: promptContent?.learningOverlays
      }),
      { ...(this.options.githubBroker ? { mcp: this.options.githubBroker } : {}) }
    );

    const startedAt = this.now();
    const executionId = buildExecutionId(task.id, startedAt);
    const artifactDir = path.join(this.options.logDir, "artifacts", executionId);
    const promptPacketPath = path.join(artifactDir, "prompt-packet.json");
    const promptArtifactPath = path.join(artifactDir, "prompt.md");
    const stdoutArtifactPath = path.join(artifactDir, "stdout.txt");
    const stderrArtifactPath = path.join(artifactDir, "stderr.txt");
    const streamArtifactPath = path.join(artifactDir, "stdout-stream.jsonl");
    const settingsArtifactPath = path.join(artifactDir, "gemini-system-settings.json");

    await mkdir(artifactDir, { recursive: true });
    await writeGeminiSystemSettings(settingsArtifactPath, {
      ...(this.options.githubBroker ? { mcp: this.options.githubBroker } : {})
    });

    await Promise.all([
      writeJsonFileAtomic(promptPacketPath, promptPacket),
      writeFile(promptArtifactPath, promptText, "utf8")
    ]);

    const approvalMode = mapPermissionToApprovalMode(task.executionPermission);
    const envOverrides = getGeminiEnvOverrides(settingsArtifactPath);
    const cwd = context.localRepoPath ?? process.cwd();

    this.logger?.info(
      JSON.stringify({
        component: "gemini-launch",
        taskKind: task.kind,
        targetRepoPath: cwd,
        systemSettingsPath: settingsArtifactPath,
        mcpServerUrl: this.options.githubBroker?.serverUrl
      })
    );

    let stdoutStreamFd: number | undefined;
    let stderrStreamFd: number | undefined;

    const resumeSessionId =
      sessionDecision?.mode === "native_resume_candidate"
        ? sessionDecision.record.providerSessionId
        : undefined;

    try {
      stdoutStreamFd = openSync(streamArtifactPath, "w");
      stderrStreamFd = openSync(stderrArtifactPath, "w");

      const result = await this.runWithModelFallbacks({
        command: agentConfig.command,
        approvalMode,
        cwd,
        env: envOverrides,
        promptText,
        resumeSessionId,
        ...(agentConfig.model ? { model: agentConfig.model } : {}),
        onOutputChunk: (stream, chunk) => {
          if (stream === "stdout" && stdoutStreamFd !== undefined) {
            writeSync(stdoutStreamFd, chunk);
          }

          if (stream === "stderr" && stderrStreamFd !== undefined) {
            writeSync(stderrStreamFd, chunk);
          }
        }
      });

      const derivedStdout =
        result.exitCode === 0 ? extractGeminiStreamJsonAssistantText(result.stdout) ?? result.stdout : result.stdout;
      const stdout = withAttemptNotes(derivedStdout, result.attemptNotes);
      const stderr = result.stderr;
      const endedAt = this.now();

      await Promise.all([
        writeFile(stdoutArtifactPath, stdout, "utf8"),
        writeFile(stderrArtifactPath, stderr, "utf8")
      ]);

      const triageResult = extractTriageResult(task, stdout);
      const reviewResult = extractReviewResult(task, stdout);
      const planBreakdownExtraction = extractAndExportPlanBreakdownResult(
        task,
        stdout,
        this.options.planBreakdownSessionStore
      );
      const waveAssessmentExtraction = extractAndExportWaveAssessmentResult(
        task,
        stdout,
        this.options.waveAssessmentSessionStore
      );

      let taskStatus: ExecutionRecord["taskStatus"] = result.exitCode === 0 ? "completed" : "failed";
      let errorMessage =
        result.exitCode === 0 ? undefined : stderr.trim() || "Gemini CLI exited with a non-zero status.";

      if (task.kind === "review_pr" && result.exitCode === 0 && !reviewResult) {
        taskStatus = "failed";
        errorMessage = "Agent output did not contain a valid structured review result.";
      }

      if ((task.kind === "plan_breakdown" || task.kind === "wave_plan_replanning") && result.exitCode === 0) {
        if (!planBreakdownExtraction.ok) {
          taskStatus = "failed";
          errorMessage = planBreakdownExtraction.message;
        }
      }

      if (task.kind === "wave_plan_assessment" && result.exitCode === 0) {
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
        agentProvider: "gemini",
        ...(agentConfig.model ? { agentModel: agentConfig.model } : {}),
        command: {
          executable: agentConfig.command,
          args: result.args,
          cwd,
          timeoutMs: this.timeoutMs
        },
        promptArtifactPath,
        stdoutArtifactPath,
        stderrArtifactPath,
        streamArtifactPath,
        promptPacketPath,
        settingsArtifactPath,
        startedAt,
        endedAt,
        exitCode: result.exitCode,
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

      const parsedSessionId = extractSessionIdFromGeminiStream(result.stdout);
      const providerLimitSignal = detectProviderLimit("gemini", result.exitCode, result.stdout, result.stderr);

      return {
        taskStatus: execution.taskStatus,
        execution,
        ...(providerLimitSignal ? { providerLimitSignal } : {}),
        ...(parsedSessionId ? { providerSession: { providerSessionId: parsedSessionId, status: "active" } } : {})
      };
    } finally {
      if (stdoutStreamFd !== undefined) {
        const fd = stdoutStreamFd;
        stdoutStreamFd = undefined;
        closeSync(fd);
      }

      if (stderrStreamFd !== undefined) {
        const fd = stderrStreamFd;
        stderrStreamFd = undefined;
        closeSync(fd);
      }
    }
  }

  private async runWithModelFallbacks(input: {
    command: string;
    approvalMode: ReturnType<typeof mapPermissionToApprovalMode>;
    cwd: string;
    env: NodeJS.ProcessEnv;
    promptText: string;
    resumeSessionId?: string | undefined;
    model?: string;
    onOutputChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
  }): Promise<{
    args: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
    attemptNotes: string[];
  }> {
    let lastResult:
      | { args: string[]; exitCode: number; stdout: string; stderr: string }
      | undefined;
    const attemptNotes: string[] = [];
    let resumeSessionId = input.resumeSessionId;

    const models = input.model ? [input.model] : [...GEMINI_MODEL_FALLBACKS];

    for (const [index, model] of models.entries()) {
      const args = buildGeminiCliArgs({
        approvalMode: input.approvalMode,
        model,
        outputFormat: "stream-json",
        resumeSessionId
      });

      try {
        const result = await this.options.commandRunner.run(input.command, args, {
          cwd: input.cwd,
          env: input.env,
          input: input.promptText,
          timeoutMs: this.timeoutMs,
          ...(input.onOutputChunk ? { onOutputChunk: input.onOutputChunk } : {})
        });
        return { args, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, attemptNotes };
      } catch (error: unknown) {
        const exitCode = extractExitCode(error);
        const stdout = extractStdout(error);
        const stderr = extractStderr(error);
        lastResult = { args, exitCode, stdout, stderr };
        resumeSessionId = undefined; // Do not attempt to resume on fallback models!

        if (!isGeminiQuotaExhaustion(stdout, stderr) || index === models.length - 1) {
          break;
        }

        const nextModel = models[index + 1];
        attemptNotes.push(`Gemini model ${model} hit quota exhaustion; retrying with ${nextModel}.`);
        this.logger?.info(
          JSON.stringify({
            component: "gemini-launch",
            event: "quota-fallback",
            exhaustedModel: model,
            nextModel
          })
        );
      }
    }

    if (!lastResult) {
      return {
        args: buildGeminiCliArgs({
          approvalMode: input.approvalMode,
          model: GEMINI_MODEL_FALLBACKS[0],
          outputFormat: "stream-json"
        }),
        exitCode: 1,
        stdout: "",
        stderr: "Gemini CLI did not return an execution result.",
        attemptNotes
      };
    }

    return {
      ...lastResult,
      attemptNotes
    };
  }
}

function extractGeminiStreamJsonAssistantText(streamText: string): string | undefined {
  if (!streamText.trim()) {
    return undefined;
  }

  let assistantText = "";
  let sawAssistantMessage = false;
  let resultText: string | undefined;

  for (const line of streamText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isRecord(event)) {
      continue;
    }

    if (event.type === "message" && getStreamRole(event) === "assistant") {
      const messageText = extractStreamText(event);
      if (messageText) {
        assistantText += messageText;
        sawAssistantMessage = true;
      }
      continue;
    }

    if (resultText === undefined && event.type === "result") {
      const candidate = extractStreamText(event);
      if (candidate) {
        resultText = candidate;
      }
    }
  }

  if (sawAssistantMessage && assistantText.trim()) {
    return assistantText;
  }

  return resultText;
}

function extractStreamText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractStreamText(item) ?? "").join("");
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const keys = ["content", "text", "delta", "response", "output", "message", "result"] as const;
  const parts: string[] = [];
  for (const key of keys) {
    const candidate = extractStreamText(value[key]);
    if (candidate) {
      parts.push(candidate);
    }
  }

  return parts.length > 0 ? parts.join("") : undefined;
}

function getStreamRole(value: Record<string, unknown>): string | undefined {
  if (typeof value.role === "string") {
    return value.role;
  }

  if (isRecord(value.message) && typeof value.message.role === "string") {
    return value.message.role;
  }

  if (isRecord(value.metadata) && typeof value.metadata.role === "string") {
    return value.metadata.role;
  }

  return undefined;
}

function isGeminiQuotaExhaustion(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  if (GEMINI_RETRYABLE_EXHAUSTION_PATTERN.test(combined)) {
    return true;
  }

  const jsonCandidates = [parseJsonObject(stdout), parseJsonObject(stderr)];
  for (const json of jsonCandidates) {
    if (json && hasRetryableValue(json)) {
      return true;
    }
  }

  return false;
}

function hasRetryableValue(obj: unknown): boolean {
  if (typeof obj === "string") {
    return GEMINI_RETRYABLE_EXHAUSTION_PATTERN.test(obj);
  }

  if (Array.isArray(obj)) {
    return obj.some((val) => hasRetryableValue(val));
  }

  if (obj !== null && typeof obj === "object") {
    return Object.values(obj).some((val) => hasRetryableValue(val));
  }

  return false;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Attempt substring extraction if full parse failed
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    try {
      const substring = text.substring(start, end + 1);
      const parsed: unknown = JSON.parse(substring);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore parse errors for candidates
    }
  }

  return undefined;
}

function withAttemptNotes(stdout: string, attemptNotes: string[]): string {
  if (attemptNotes.length === 0) {
    return stdout;
  }

  return `${attemptNotes.map((note) => `[orchestrator] ${note}`).join("\n")}\n${stdout}`;
}

function extractSessionIdFromGeminiStream(streamText: string): string | undefined {
  if (!streamText.trim()) {
    return undefined;
  }

  for (const line of streamText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === "object" && event.type === "init" && typeof event.session_id === "string") {
        return event.session_id;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}
