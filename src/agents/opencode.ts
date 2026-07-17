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
  buildOpenCodeCliArgs,
  extractOpenCodeAssistantText,
  getOpenCodeEnvOverrides,
  prependGlobalOpenCodeLaunchInstructions,
  writeOpenCodeConfig,
  type OpenCodeMcpRuntime
} from "./opencode-launch.js";
import {
  buildExecutionId,
  extractAndExportPlanBreakdownResult,
  extractAndExportWaveAssessmentResult,
  extractExitCode,
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

export interface OpenCodeCliAgentOptions {
  commandRunner: CommandRunner;
  logDir: string;
  logger?: Logger;
  now?: () => string;
  timeoutMs?: number;
  githubBroker?: OpenCodeMcpRuntime;
  planBreakdownSessionStore?: PlanBreakdownSessionStore;
  waveAssessmentSessionStore?: WaveAssessmentSessionStore;
}

export class OpenCodeCliAgent implements AgentRunner {
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;

  constructor(private readonly options: OpenCodeCliAgentOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
  }

  async dispatch(
    task: TaskRecord,
    context: BuiltContext,
    agentConfig: AgentConfig,
    _sessionDecision?: ProviderSessionDecision,
    promptContent?: ResolvedPromptContent
  ): Promise<DispatchResult> {
    const promptPacket = buildPromptPacket(task, context);
    const promptText = prependGlobalOpenCodeLaunchInstructions(
      renderPrompt(task, promptPacket, {
        providerIdentity: "OpenCode CLI",
        customConstraints: promptContent?.content
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
    const streamArtifactPath = path.join(artifactDir, "stdout-events.jsonl");
    const settingsArtifactPath = path.join(artifactDir, "opencode-config.json");

    await mkdir(artifactDir, { recursive: true });
    await writeOpenCodeConfig(settingsArtifactPath, {
      ...(this.options.githubBroker ? { mcp: this.options.githubBroker } : {})
    });

    await Promise.all([
      writeJsonFileAtomic(promptPacketPath, promptPacket),
      writeFile(promptArtifactPath, promptText, "utf8")
    ]);

    const envOverrides = getOpenCodeEnvOverrides(settingsArtifactPath);
    const cwd = context.localRepoPath ?? process.cwd();
    const timeoutMs = agentConfig.timeoutMs ?? this.timeoutMs;

    this.logger?.info(
      JSON.stringify({
        component: "opencode-launch",
        taskKind: task.kind,
        targetRepoPath: cwd,
        configPath: settingsArtifactPath,
        mcpServerUrl: this.options.githubBroker?.serverUrl
      })
    );

    const args = buildOpenCodeCliArgs({
      model: agentConfig.model!, // Schema ensures model is present for opencode
      repoPath: cwd,
      promptText
    });

    let rawStdout = "";
    let rawStderr = "";
    let exitCode = 0;

    try {
      const result = await this.options.commandRunner.run(agentConfig.command, args, {
        cwd,
        env: { ...process.env, ...envOverrides },
        timeoutMs
      });
      rawStdout = result.stdout;
      rawStderr = result.stderr;
      exitCode = result.exitCode;
    } catch (error: unknown) {
      exitCode = extractExitCode(error);
      rawStdout = extractStdout(error);
      rawStderr = extractStderr(error);
    }

    const normalizedStdout = extractOpenCodeAssistantText(rawStdout) ?? rawStdout;
    const endedAt = this.now();

    await Promise.all([
      writeFile(streamArtifactPath, rawStdout, "utf8"),
      writeFile(stdoutArtifactPath, normalizedStdout, "utf8"),
      writeFile(stderrArtifactPath, rawStderr, "utf8")
    ]);

    const triageResult = extractTriageResult(task, normalizedStdout);
    const reviewResult = extractReviewResult(task, normalizedStdout);
    const planBreakdownExtraction = extractAndExportPlanBreakdownResult(
      task,
      normalizedStdout,
      this.options.planBreakdownSessionStore
    );
    const waveAssessmentExtraction = extractAndExportWaveAssessmentResult(
      task,
      normalizedStdout,
      this.options.waveAssessmentSessionStore
    );

    let taskStatus: ExecutionRecord["taskStatus"] = exitCode === 0 ? "completed" : "failed";
    let errorMessage =
      exitCode === 0 ? undefined : rawStderr.trim() || "OpenCode CLI exited with a non-zero status.";

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
      agentProvider: "opencode",
      agentModel: agentConfig.model!,
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
      settingsArtifactPath,
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

    const providerLimitSignal = detectProviderLimit("opencode", exitCode, rawStdout, rawStderr);

    return {
      taskStatus: execution.taskStatus,
      execution,
      ...(providerLimitSignal ? { providerLimitSignal } : {})
    };
  }
}
