import type {
  PlanBreakdownResult,
  PlanBreakdownTaskResult,
  PlanBreakdownWaveResult,
  ReviewAction,
  ReviewDecisionResult,
  ReviewInlineComment,
  TriageDecisionResult,
  ProviderLimitSignal
} from "../state/types.js";
import type { TaskRecord } from "../tasks/types.js";
import type { AgentProvider } from "../config/types.js";
import {
  parseFixResultV1,
  parseReviewResultV2,
  type FixResultV1,
  type ReviewResultV2
} from "../reviews/contracts.js";
import { PlanBreakdownSessionStore } from "../workstreams/plan-breakdown-generator/store.js";
import { exportSession } from "../workstreams/plan-breakdown-generator/export.js";
import { buildPacketPlanFromPlanBreakdown } from "../workstreams/packet-plan.js";
import { WaveAssessmentSessionStore } from "../workstreams/wave-assessment/store.js";
import { exportWaveAssessmentSession } from "../workstreams/wave-assessment/session.js";
import type { WaveAssessmentResult as SessionWaveAssessmentResult } from "../workstreams/wave-assessment/session.js";

export type PlanBreakdownExtractionResult =
  | { ok: true; sessionId: string; planBreakdown: PlanBreakdownResult }
  | {
      ok: false;
      reason:
        | "not_plan_breakdown"
        | "empty_stdout"
        | "missing_json"
        | "malformed_json"
        | "missing_session_id"
        | "unknown_session_id"
        | "export_failed"
        | "packet_plan_invalid"
        | "session_store_unavailable"
        | "missing_workstream_id";
      message: string;
    };

export function extractAndExportPlanBreakdownResult(
  task: TaskRecord,
  stdout: string,
  sessionStore?: PlanBreakdownSessionStore
): PlanBreakdownExtractionResult {
  if (!requiresPlanBreakdownResult(task)) {
    return { ok: false, reason: "not_plan_breakdown", message: "Task does not require a plan breakdown result." };
  }

  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty_stdout", message: "Agent output is empty." };
  }

  const candidate = extractTrailingJsonObject(trimmed);
  if (!candidate) {
    return { ok: false, reason: "missing_json", message: "No JSON object found in agent output." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "malformed_json", message: "Malformed JSON object in agent output." };
  }

  if (!isRecord(parsed) || typeof parsed.sessionId !== "string") {
    return {
      ok: false,
      reason: "missing_session_id",
      message: 'Agent response must be a JSON object with a "sessionId" string.'
    };
  }

  const { sessionId } = parsed;
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return {
      ok: false,
      reason: "missing_session_id",
      message: 'Agent response "sessionId" must not be empty.'
    };
  }

  if (!sessionStore) {
    return {
      ok: false,
      reason: "session_store_unavailable",
      message: "Plan breakdown session store is unavailable for this agent."
    };
  }

  const session = sessionStore.getSessionSync(normalizedSessionId);
  if (!session) {
    return {
      ok: false,
      reason: "unknown_session_id",
      message: `Unknown session ID: "${normalizedSessionId}"`
    };
  }

  let planBreakdown: PlanBreakdownResult;
  try {
    planBreakdown = exportSession(session);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: "export_failed",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const workstreamId = getTaskWorkstreamId(task);
  if (!workstreamId) {
    return {
      ok: false,
      reason: "missing_workstream_id",
      message: "Plan breakdown task is missing canonical workstream identity."
    };
  }

  try {
    buildPacketPlanFromPlanBreakdown({
      workstreamId,
      planBreakdown,
      generatedAt: new Date().toISOString()
    });
  } catch (error: unknown) {
    return {
      ok: false,
      reason: "packet_plan_invalid",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  return { ok: true, sessionId: normalizedSessionId, planBreakdown };
}

export type WaveAssessmentExtractionResult =
  | { ok: true; sessionId: string; waveAssessment: import("../state/types.js").WaveAssessmentResult }
  | {
      ok: false;
      reason:
        | "not_wave_plan_assessment"
        | "empty_stdout"
        | "missing_json"
        | "malformed_json"
        | "missing_session_id"
        | "unknown_session_id"
        | "export_failed"
        | "checkpoint_missing"
        | "checkpoint_mismatch"
        | "session_store_unavailable";
      message: string;
    };

export function extractAndExportWaveAssessmentResult(
  task: TaskRecord,
  stdout: string,
  sessionStore?: WaveAssessmentSessionStore
): WaveAssessmentExtractionResult {
  if (task.kind !== "wave_plan_assessment") {
    return {
      ok: false,
      reason: "not_wave_plan_assessment",
      message: "Task is not a wave plan assessment."
    };
  }

  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty_stdout", message: "Agent output is empty." };
  }

  const candidate = extractTrailingJsonObject(trimmed);
  if (!candidate) {
    return { ok: false, reason: "missing_json", message: "No JSON object found in agent output." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "malformed_json", message: "Malformed JSON object in agent output." };
  }

  if (!isRecord(parsed) || typeof parsed.sessionId !== "string" || parsed.sessionId.trim() === "") {
    return {
      ok: false,
      reason: "missing_session_id",
      message: 'Agent response must be a JSON object with a non-empty "sessionId" string.'
    };
  }

  if (!sessionStore) {
    return {
      ok: false,
      reason: "session_store_unavailable",
      message: "Wave assessment session store is unavailable for this agent."
    };
  }

  const checkpoint = task.context.waveAssessmentCheckpoint;
  if (!checkpoint) {
    return {
      ok: false,
      reason: "checkpoint_missing",
      message: "Wave assessment task is missing checkpoint context."
    };
  }

  const sessionId = parsed.sessionId.trim();
  if (task.context.waveReassessment && sessionId !== checkpoint.sessionId) {
    return {
      ok: false,
      reason: "checkpoint_mismatch",
      message: `Wave reassessment must export its assigned session "${checkpoint.sessionId}", received "${sessionId}".`
    };
  }
  const session = sessionStore.getSessionSync(sessionId);
  if (!session) {
    return {
      ok: false,
      reason: "unknown_session_id",
      message: `Unknown wave assessment session ID: "${sessionId}"`
    };
  }

  let exported: SessionWaveAssessmentResult;
  try {
    exported = exportWaveAssessmentSession(session);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: "export_failed",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const mismatch = findWaveAssessmentCheckpointMismatch(exported, checkpoint.identity);
  if (mismatch) {
    return {
      ok: false,
      reason: "checkpoint_mismatch",
      message: mismatch
    };
  }

  return {
    ok: true,
    sessionId,
    waveAssessment: {
      id: task.context.waveReassessment
        ? `assessment:${checkpoint.id}:reassess:${task.context.waveReassessment.sourceCommentId}`
        : `assessment:${checkpoint.id}`,
      sessionId,
      checkpoint,
      decision: exported.decision,
      summary: exported.summary,
      findings: exported.findings,
      status: "finalized",
      createdAt: exported.timestamps.createdAt,
      finalizedAt: exported.timestamps.finalizedAt,
      updatedAt: exported.timestamps.finalizedAt
    }
  };
}

function findWaveAssessmentCheckpointMismatch(
  exported: SessionWaveAssessmentResult,
  identity: NonNullable<TaskRecord["context"]["waveAssessmentCheckpoint"]>["identity"]
): string | undefined {
  const checks: Array<[string, unknown, unknown]> = [
    ["workstreamId", exported.workstreamId, identity.workstreamId],
    ["waveId", exported.waveId, identity.waveId],
    ["parentPrNumber", exported.parentPrNumber, identity.parentPrNumber],
    ["parentHeadSha", exported.assessedParentHeadSha, identity.parentHeadSha],
    ["planRevision", exported.currentPlanRevision, identity.planRevision],
    ["originalPlanningSessionId", exported.originalPlanningSessionId, identity.originalPlanningSessionId]
  ];

  const mismatch = checks.find(([, left, right]) => left !== right);
  if (mismatch) {
    return `Wave assessment session ${mismatch[0]} "${mismatch[1]}" does not match checkpoint "${mismatch[2]}".`;
  }
  if (!arraysEqual(exported.planNodeIds, identity.planNodeIds)) {
    return `Wave assessment session planNodeIds "${formatStringArray(exported.planNodeIds)}" do not match checkpoint "${formatStringArray(identity.planNodeIds)}".`;
  }
  return undefined;
}

function arraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatStringArray(values: string[] | undefined): string {
  return values?.join(",") ?? "<missing>";
}

function getTaskWorkstreamId(task: TaskRecord): string | undefined {
  return typeof task.workstreamId === "string" && task.workstreamId.trim()
    ? task.workstreamId
    : undefined;
}

export function extractTriageResult(task: TaskRecord, stdout: string): TriageDecisionResult | undefined {
  if (task.kind !== "triage_issue") {
    return undefined;
  }

  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const candidate = extractTrailingJsonObject(trimmed);
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (parsed.decision !== "answer_only" && parsed.decision !== "start_implementation") {
      return undefined;
    }

    return {
      decision: parsed.decision,
      ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
      ...(typeof parsed.reply === "string" ? { reply: parsed.reply } : {})
    };
  } catch {
    return undefined;
  }
}

export function extractReviewResult(task: TaskRecord, stdout: string): ReviewDecisionResult | undefined {
  if (task.kind !== "review_pr" || task.context.reviewCycle !== undefined) {
    return undefined;
  }

  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const candidate = extractTrailingJsonObject(trimmed);
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;

    // Handle new shape
    if (typeof parsed.action === "string" && ["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(parsed.action)) {
      const action = parsed.action as ReviewAction;
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      if (!summary) {
        return undefined;
      }

      const inlineComments = Array.isArray(parsed.inlineComments)
        ? parsed.inlineComments
            .map((comment): ReviewInlineComment | undefined => {
              if (!isRecord(comment)) {
                return undefined;
              }
              const path = typeof comment.path === "string" ? comment.path.trim() : undefined;
              const line = typeof comment.line === "number" ? comment.line : undefined;
              const body = typeof comment.body === "string" ? comment.body.trim() : undefined;

              const side =
                comment.side === "LEFT" || comment.side === "RIGHT"
                  ? (comment.side as ReviewInlineComment["side"])
                  : undefined;
              const startLine = typeof comment.startLine === "number" ? comment.startLine : undefined;
              const startSide =
                comment.startSide === "LEFT" || comment.startSide === "RIGHT"
                  ? (comment.startSide as ReviewInlineComment["startSide"])
                  : undefined;

              return {
                ...(path ? { path } : {}),
                ...(line !== undefined ? { line } : {}),
                ...(body ? { body } : {}),
                ...(side ? { side } : {}),
                ...(startLine !== undefined ? { startLine } : {}),
                ...(startSide ? { startSide } : {})
              };
            })
            .filter((c): c is ReviewInlineComment => c !== undefined)
        : undefined;

      return {
        action,
        summary,
        ...(inlineComments && inlineComments.length > 0 ? { inlineComments } : {})
      };
    }

    // Handle legacy shape
    if (parsed.decision === "approve" || parsed.decision === "request_changes") {
      const action = parsed.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES";
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "Review submitted.";

      const findings = Array.isArray(parsed.findings)
        ? parsed.findings
            .map((finding) => {
              if (!isRecord(finding)) {
                return undefined;
              }

              const path = typeof finding.path === "string" ? finding.path.trim() : undefined;
              const line = typeof finding.line === "number" ? finding.line : undefined;
              const body = typeof finding.body === "string" ? finding.body.trim() : undefined;

              return {
                ...(path ? { path } : {}),
                ...(line !== undefined ? { line } : {}),
                ...(body ? { body } : {})
              };
            })
            .filter((finding): finding is NonNullable<typeof finding> => finding !== undefined)
        : undefined;

      return {
        action,
        summary,
        decision: parsed.decision,
        ...(findings && findings.length > 0
          ? {
              inlineComments: findings.map((f) => ({ ...f, side: "RIGHT" as const })),
              findings
            }
          : {})
      };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export function extractReviewCycleResult(
  task: TaskRecord,
  stdout: string
): ReviewResultV2 | undefined {
  if (task.kind !== "review_pr" || task.context.reviewCycle === undefined) {
    return undefined;
  }
  const candidate = extractTrailingJsonObject(stdout.trim());
  if (!candidate) {
    return undefined;
  }
  try {
    return parseReviewResultV2(candidate, {
      targetHeadSha: task.context.reviewCycle.targetHeadSha
    });
  } catch {
    return undefined;
  }
}

export function extractReviewFixResult(
  task: TaskRecord,
  stdout: string
): FixResultV1 | undefined {
  if (
    task.kind !== "fix_review_finding" ||
    task.context.reviewCycle?.findingId === undefined ||
    task.context.reviewCycleFix === undefined
  ) {
    return undefined;
  }
  const candidate = extractTrailingJsonObject(stdout.trim());
  if (!candidate) {
    return undefined;
  }
  try {
    return parseFixResultV1(candidate, {
      findingId: task.context.reviewCycle.findingId,
      knownFindingIds: task.context.reviewCycleFix.findings.map((finding) => finding.id)
    });
  } catch {
    return undefined;
  }
}

export function extractPlanBreakdownResult(
  task: TaskRecord,
  stdout: string,
  sessionStore?: PlanBreakdownSessionStore
): PlanBreakdownResult | undefined {
  if (!requiresPlanBreakdownResult(task)) {
    return undefined;
  }

  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const candidate = extractTrailingJsonObject(trimmed);
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(candidate);

    // Support for sessionId format
    if (isRecord(parsed) && typeof parsed.sessionId === "string" && sessionStore) {
      const sessionId = parsed.sessionId.trim();
      if (!sessionId) {
        return undefined;
      }

      const session = sessionStore.getSessionSync(sessionId);
      if (session) {
        return exportSession(session);
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function requiresPlanBreakdownResult(task: TaskRecord): boolean {
  return task.kind === "plan_breakdown" || task.kind === "wave_plan_replanning";
}

function requiredStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((v) => typeof v !== "string")) return undefined;
  return value as string[];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractTrailingJsonObject(value: string): string | undefined {
  const end = value.lastIndexOf("}");
  if (end === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = end; index >= 0; index -= 1) {
    const character = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "}") {
      depth += 1;
      continue;
    }

    if (character === "{") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(index, end + 1);
      }
    }
  }

  return undefined;
}

export function buildExecutionId(taskId: string, startedAt: string): string {
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const safeTimestamp = startedAt.replace(/[:.]/g, "-");
  return `exec-${safeTaskId}-${safeTimestamp}`;
}

export function extractExitCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number") {
    return error.exitCode;
  }

  return 1;
}

export function extractStdout(error: unknown): string {
  if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") {
    return error.stdout;
  }

  return "";
}

export function extractStderr(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string") {
    return error.stderr;
  }

  return error instanceof Error ? error.message : String(error);
}

export { detectProviderLimit } from "./limit-detector.js";
