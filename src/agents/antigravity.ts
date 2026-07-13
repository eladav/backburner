import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../config/types.js";
import type { BuiltContext } from "../context/types.js";
import type { ExecutionRecord } from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import type { CommandRunner } from "../utils/command-runner.js";
import { writeJsonFileAtomic } from "../utils/json.js";
import type { Logger } from "../utils/logger.js";
import { PlanBreakdownSessionStore } from "../workstreams/plan-breakdown-generator/store.js";
import { WaveAssessmentSessionStore } from "../workstreams/wave-assessment/store.js";
import type { ResolvedPromptContent } from "../prompts/resolver.js";
import {
  buildAntigravityCliArgs,
  ensureAntigravityMcpConfig,
  getAntigravityEnvOverrides,
  mapPermissionToAntigravityMode,
  prependGlobalAntigravityLaunchInstructions,
  writeAntigravityMcpConfig,
  writeAntigravitySettings,
  type AntigravityMcpRuntime
} from "./antigravity-launch.js";
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
import type { ProviderSessionDecision } from "./provider-sessions.js";
import type { AgentRunner, DispatchResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_PRINT_TIMEOUT = "20m";

export interface AntigravityCliAgentOptions {
  commandRunner: CommandRunner;
  logDir: string;
  logger?: Logger;
  now?: () => string;
  timeoutMs?: number;
  printTimeout?: string;
  configHome?: string;
  legacyGeminiConfigHome?: string;
  githubBroker?: AntigravityMcpRuntime;
  planBreakdownSessionStore?: PlanBreakdownSessionStore;
  waveAssessmentSessionStore?: WaveAssessmentSessionStore;
}

export class AntigravityCliAgent implements AgentRunner {
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private readonly printTimeout: string;
  private readonly logger: Logger | undefined;

  constructor(private readonly options: AntigravityCliAgentOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.printTimeout = options.printTimeout ?? DEFAULT_PRINT_TIMEOUT;
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
    const promptText = prependGlobalAntigravityLaunchInstructions(
      renderPrompt(task, promptPacket, {
        providerIdentity: "Antigravity CLI",
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
    const streamArtifactPath = path.join(artifactDir, "stdout-raw.txt");
    const settingsArtifactPath = path.join(artifactDir, "antigravity-settings.json");
    const mcpConfigArtifactPath = path.join(artifactDir, "antigravity-mcp-config.json");
    const logFilePath = path.join(artifactDir, "antigravity.log");
    const antigravityHome = this.options.configHome ?? path.join(os.homedir(), ".gemini", "antigravity-cli");
    const legacyGeminiConfigHome =
      this.options.legacyGeminiConfigHome ??
      (this.options.configHome ? undefined : path.join(os.homedir(), ".gemini", "config"));
    const cwd = context.localRepoPath ?? process.cwd();
    const permissionMode = mapPermissionToAntigravityMode(task.executionPermission);
    const resumeConversationId =
      _sessionDecision?.mode === "native_resume_candidate"
        ? _sessionDecision.record.providerSessionId
        : undefined;

    await mkdir(artifactDir, { recursive: true });
    await Promise.all([
      writeJsonFileAtomic(promptPacketPath, promptPacket),
      writeFile(promptArtifactPath, promptText, "utf8"),
      writeAntigravitySettings(settingsArtifactPath, {
        permissionMode,
        cwd,
        ...(agentConfig.model ? { model: agentConfig.model } : {})
      }),
      writeAntigravityMcpConfig(mcpConfigArtifactPath, {
        ...(this.options.githubBroker ? { mcp: this.options.githubBroker } : {})
      })
    ]);

    const args = buildAntigravityCliArgs({
      permissionMode,
      ...(agentConfig.model ? { model: agentConfig.model } : {}),
      ...(resumeConversationId ? { conversationId: resumeConversationId } : {}),
      printTimeout: this.printTimeout,
      logFilePath,
      promptText
    });

    this.logger?.info(
      JSON.stringify({
        component: "antigravity-launch",
        taskKind: task.kind,
        targetRepoPath: cwd,
        antigravityHome,
        settingsPath: settingsArtifactPath,
        mcpConfigPath: mcpConfigArtifactPath,
        legacyGeminiMcpConfigPath: legacyGeminiConfigHome
          ? path.join(legacyGeminiConfigHome, "mcp_config.json")
          : undefined,
        mcpServerUrl: this.options.githubBroker?.serverUrl
      })
    );

    let exitCode = 0;
    let rawStdout = "";
    let rawStderr = "";

    try {
      if (this.options.githubBroker) {
        const setup = await ensureAntigravityMcpConfig(antigravityHome, this.options.githubBroker);
        this.logger?.info(
          JSON.stringify({
            component: "antigravity-mcp-bootstrap",
            configPath: setup.configPath,
            changed: setup.changed,
            backupPath: setup.backupPath
          })
        );
        if (legacyGeminiConfigHome) {
          const legacySetup = await ensureAntigravityMcpConfig(
            legacyGeminiConfigHome,
            this.options.githubBroker
          );
          this.logger?.info(
            JSON.stringify({
              component: "antigravity-legacy-gemini-mcp-bootstrap",
              configPath: legacySetup.configPath,
              changed: legacySetup.changed,
              backupPath: legacySetup.backupPath
            })
          );
        }
      }
      const result = await this.options.commandRunner.run(agentConfig.command, args, {
        cwd,
        env: getAntigravityEnvOverrides(),
        timeoutMs: this.timeoutMs
      });
      exitCode = result.exitCode;
      rawStdout = result.stdout;
      rawStderr = result.stderr;
    } catch (error: unknown) {
      exitCode = extractExitCode(error);
      rawStdout = extractStdout(error);
      rawStderr = extractStderr(error) || (error instanceof Error ? error.message : String(error));
    }

    const stdout = normalizeAntigravityStdout(rawStdout);
    const endedAt = this.now();
    const observedConversationId =
      await readAntigravityConversationIdForCwd(antigravityHome, cwd)
        .catch((err) => {
          this.logger?.warn(
            `[antigravity-session] Failed to read conversation id for ${cwd}: ${err instanceof Error ? err.message : String(err)}`
          );
          return undefined;
        });
    const finalConversationId = observedConversationId ?? resumeConversationId;

    await Promise.all([
      writeFile(streamArtifactPath, rawStdout, "utf8"),
      writeFile(stdoutArtifactPath, stdout, "utf8"),
      writeFile(stderrArtifactPath, rawStderr, "utf8")
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

    let taskStatus: ExecutionRecord["taskStatus"] = exitCode === 0 ? "completed" : "failed";
    let errorMessage =
      exitCode === 0 ? undefined : rawStderr.trim() || "Antigravity CLI exited with a non-zero status.";

    if (task.kind === "review_pr" && exitCode === 0 && !reviewResult) {
      taskStatus = "failed";
      errorMessage = "Agent output did not contain a valid structured review result.";
    }

    if (
      (task.kind === "plan_breakdown" || task.kind === "wave_plan_replanning") &&
      exitCode === 0 &&
      !planBreakdownExtraction.ok
    ) {
      taskStatus = "failed";
      errorMessage = planBreakdownExtraction.message;
    }

    if (task.kind === "wave_plan_assessment" && exitCode === 0 && !waveAssessmentExtraction.ok) {
      taskStatus = "failed";
      errorMessage = waveAssessmentExtraction.message;
    }

    const execution: ExecutionRecord = {
      id: executionId,
      taskId: task.id,
      taskKind: task.kind,
      taskStatus,
      repoId: task.repoId,
      repoSlug: task.repoSlug,
      agentId: agentConfig.id,
      agentProvider: "antigravity",
      ...(agentConfig.model ? { agentModel: agentConfig.model } : {}),
      command: {
        executable: agentConfig.command,
        args,
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

    const providerLimitSignal = detectProviderLimit("antigravity", exitCode, rawStdout, rawStderr);

    return {
      taskStatus: execution.taskStatus,
      execution,
      ...(providerLimitSignal ? { providerLimitSignal } : {}),
      ...(finalConversationId
        ? {
            providerSession: {
              providerSessionId: finalConversationId,
              status: "active" as const
            }
          }
        : {})
    };
  }
}

export function normalizeAntigravityStdout(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "--print-timeout")
    .join("\n")
    .trimEnd();
}

export async function readAntigravityConversationIdForCwd(
  antigravityHome: string,
  cwd: string
): Promise<string | undefined> {
  const cachePath = path.join(antigravityHome, "cache", "last_conversations.json");
  let raw: string;
  try {
    raw = await readFile(cachePath, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const conversations = parsed as Record<string, unknown>;
  const candidates = new Set<string>([cwd]);
  try {
    candidates.add(await realpath(cwd));
  } catch {
    // The cwd may have been removed after the run; fall back to the literal path.
  }

  for (const candidate of candidates) {
    const value = conversations[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}
