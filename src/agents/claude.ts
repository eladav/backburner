import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
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
  buildClaudeAllowedTools,
  buildClaudeCliArgs,
  mapPermissionToClaudePermissionMode,
  prependGlobalClaudeLaunchInstructions,
  writeClaudeMcpConfig,
  writeClaudeSettings,
  type ClaudeMcpRuntime
} from "./claude-launch.js";
import {
  buildExecutionId,
  extractExitCode,
  extractAndExportPlanBreakdownResult,
  extractAndExportWaveAssessmentResult,
  extractReviewCycleResult,
  extractReviewFixResult,
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

export interface ClaudeCodeCliAgentOptions {
  commandRunner: CommandRunner;
  logDir: string;
  logger?: Logger;
  now?: () => string;
  timeoutMs?: number;
  claudeProjectsDir?: string;
  githubBroker?: ClaudeMcpRuntime;
  planBreakdownSessionStore?: PlanBreakdownSessionStore;
  waveAssessmentSessionStore?: WaveAssessmentSessionStore;
}

export class ClaudeCodeCliAgent implements AgentRunner {
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;

  constructor(private readonly options: ClaudeCodeCliAgentOptions) {
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
    const promptText = prependGlobalClaudeLaunchInstructions(
      renderPrompt(task, promptPacket, {
        providerIdentity: "Claude Code CLI",
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
    const providerTranscriptArtifactPath = path.join(artifactDir, "claude-project-transcript.jsonl");
    const mcpConfigPath = path.join(artifactDir, "claude-mcp-config.json");
    const settingsArtifactPath = path.join(artifactDir, "claude-settings.json");

    await mkdir(artifactDir, { recursive: true });

    const cwd = context.localRepoPath ?? process.cwd();
    const timeoutMs = agentConfig.timeoutMs ?? this.timeoutMs;

    const writeTasks: Promise<void>[] = [
      writeJsonFileAtomic(promptPacketPath, promptPacket),
      writeFile(promptArtifactPath, promptText, "utf8")
    ];

    if (this.options.githubBroker) {
      writeTasks.push(writeClaudeMcpConfig(mcpConfigPath, this.options.githubBroker));
      writeTasks.push(
        writeClaudeSettings(settingsArtifactPath, {
          mcp: this.options.githubBroker,
          workspacePath: cwd
        })
      );
    }

    await Promise.all(writeTasks);

    const permissionMode = mapPermissionToClaudePermissionMode(task.executionPermission);

    const resumeSessionId =
      sessionDecision?.mode === "native_resume_candidate"
        ? sessionDecision.record.providerSessionId
        : undefined;

    const plannedSessionId =
      sessionDecision?.mode === "new_session"
        ? sessionDecision.providerSessionId
        : undefined;

    const sessionName =
      sessionDecision?.mode === "new_session"
        ? sessionDecision.providerSessionName
        : undefined;

    const args = buildClaudeCliArgs({
      permissionMode,
      resumeSessionId,
      plannedSessionId,
      sessionName,
      ...(agentConfig.model ? { model: agentConfig.model } : {}),
      ...(this.options.githubBroker
        ? {
            mcpConfigPath,
            settingsPath: settingsArtifactPath,
            allowedTools: buildClaudeAllowedTools(this.options.githubBroker)
          }
        : {})
    });


    this.logger?.info(
      JSON.stringify({
        component: "claude-launch",
        taskKind: task.kind,
        targetRepoPath: cwd,
        mcpConfigPath: this.options.githubBroker ? mcpConfigPath : undefined,
        mcpServerUrl: this.options.githubBroker?.serverUrl
      })
    );

    let exitCode = 0;
    let stdout = "";
    let stderr = "";

    try {
      const result = await this.options.commandRunner.run(agentConfig.command, args, {
        cwd,
        input: promptText,
        timeoutMs
      });
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      exitCode = extractExitCode(error);
      stdout = extractStdout(error);
      stderr = extractStderr(error);
    }

    const endedAt = this.now();
    const originalStderr = stderr;
    const transcriptCapture = await captureClaudeProjectTranscript({
      cwd,
      startedAt,
      artifactPath: providerTranscriptArtifactPath,
      ...(this.options.claudeProjectsDir ? { projectsDir: this.options.claudeProjectsDir } : {}),
      ...(this.logger ? { logger: this.logger } : {})
    });

    if (transcriptCapture && exitCode !== 0 && stderr.trim() === "") {
      stderr = [
        `Claude project transcript captured at ${providerTranscriptArtifactPath}`,
        `Source: ${transcriptCapture.sourcePath}`
      ].join("\n");
    }

    await Promise.all([
      writeFile(stdoutArtifactPath, stdout, "utf8"),
      writeFile(stderrArtifactPath, stderr, "utf8")
    ]);

    const triageResult = extractTriageResult(task, stdout);
    const reviewResult = extractReviewResult(task, stdout);
    const reviewCycleResult = extractReviewCycleResult(task, stdout);
    const reviewFixResult = extractReviewFixResult(task, stdout);
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

    let taskStatus: ExecutionRecord["taskStatus"] = exitCode === 0 ? "completed" : "failed";
    let errorMessage =
      exitCode === 0 ? undefined : originalStderr.trim() || "Claude Code CLI exited with a non-zero status.";

    if (task.kind === "review_pr" && exitCode === 0 && !(task.context.reviewCycle ? reviewCycleResult : reviewResult)) {
      taskStatus = "failed";
      errorMessage = "Agent output did not contain a valid structured review result.";
    }
    if (task.kind === "fix_review_finding" && exitCode === 0 && !reviewFixResult) {
      taskStatus = "failed";
      errorMessage = "Agent output did not contain a valid structured review-fix result.";
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
      agentProvider: "claude",
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
      ...(transcriptCapture ? { providerTranscriptArtifactPath } : {}),
      promptPacketPath,
      ...(this.options.githubBroker ? { settingsArtifactPath } : {}),
      startedAt,
      endedAt,
      exitCode,
      ...(errorMessage ? { errorMessage } : {}),
      ...(triageResult || reviewResult || reviewCycleResult || reviewFixResult || planBreakdownExtraction.ok || waveAssessmentExtraction.ok
        ? {
            result: {
              ...(triageResult ? { triage: triageResult } : {}),
              ...(reviewResult ? { review: reviewResult } : {}),
              ...(reviewCycleResult ? { reviewCycleReview: reviewCycleResult } : {}),
              ...(reviewFixResult ? { reviewCycleFix: reviewFixResult } : {}),
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

    const parsedSessionId = extractSessionIdFromClaudeOutput(stdout);
    const finalSessionId = parsedSessionId || plannedSessionId || resumeSessionId;
    const finalSessionName = parsedSessionId ? undefined : (sessionName || (sessionDecision?.mode === "native_resume_candidate" ? sessionDecision.record.providerSessionName : undefined));

    const providerLimitSignal = detectProviderLimit("claude", exitCode, stdout, stderr);

    return {
      taskStatus: execution.taskStatus,
      execution,
      ...(providerLimitSignal ? { providerLimitSignal } : {}),
      ...(finalSessionId
        ? {
            providerSession: {
              providerSessionId: finalSessionId,
              status: "active" as const,
              ...(finalSessionName ? { providerSessionName: finalSessionName } : {})
            }
          }
        : {})
    };
  }
}

interface TranscriptCaptureInput {
  cwd: string;
  startedAt: string;
  artifactPath: string;
  projectsDir?: string;
  logger?: Logger;
}

interface TranscriptCaptureResult {
  sourcePath: string;
}

async function captureClaudeProjectTranscript(
  input: TranscriptCaptureInput
): Promise<TranscriptCaptureResult | undefined> {
  const projectsDir = input.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  const projectDir = path.join(projectsDir, encodeClaudeProjectPath(input.cwd));
  const startedAtMs = Date.parse(input.startedAt);
  const minMtimeMs = Number.isFinite(startedAtMs) ? startedAtMs - 5_000 : 0;

  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    const candidates: Array<{ filePath: string; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(projectDir, entry.name);
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs >= minMtimeMs) {
        candidates.push({ filePath, mtimeMs: fileStat.mtimeMs });
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = candidates[0];
    if (!latest) {
      return undefined;
    }

    await copyFile(latest.filePath, input.artifactPath);
    return { sourcePath: latest.filePath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      input.logger?.warn(
        `[claude-transcript] Failed to capture Claude project transcript for ${input.cwd}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return undefined;
  }
}

function encodeClaudeProjectPath(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function extractSessionIdFromClaudeOutput(stdoutText: string): string | undefined {
  if (!stdoutText.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(stdoutText);
    if (parsed && typeof parsed === "object" && typeof parsed.session_id === "string") {
      return parsed.session_id;
    }
  } catch {
    // Substring parse candidate
    const start = stdoutText.indexOf("{");
    const end = stdoutText.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(stdoutText.substring(start, end + 1));
        if (parsed && typeof parsed === "object" && typeof parsed.session_id === "string") {
          return parsed.session_id;
        }
      } catch {
        // ignore
      }
    }
  }

  return undefined;
}
