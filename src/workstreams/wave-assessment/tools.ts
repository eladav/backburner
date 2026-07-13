import type {
  BrokerTool,
  BrokerToolCallFailure,
  BrokerToolCallResult,
  BrokerToolService
} from "../../github/types.js";
import type { Logger } from "../../utils/logger.js";
import {
  WAVE_ASSESSMENT_DECISIONS,
  WAVE_ASSESSMENT_FINDING_CATEGORIES,
  addWaveAssessmentFinding,
  completeWaveAssessmentSession,
  createWaveAssessmentSession,
  exportWaveAssessmentSession,
  type WaveAssessmentCurrentIdentity,
  type WaveAssessmentDecision,
  type WaveAssessmentFindingCategory,
  type WaveAssessmentSession
} from "./session.js";
import type { WaveAssessmentSessionStore } from "./store.js";
import { validateWaveAssessmentSession } from "./validate.js";

export class WaveAssessmentToolService implements BrokerToolService {
  readonly namespace = "wave_assessment";

  constructor(
    private readonly store: WaveAssessmentSessionStore,
    private readonly logger: Logger
  ) {}

  listTools(): BrokerTool[] {
    return TOOL_DEFINITIONS;
  }

  async callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    const startedAt = new Date().toISOString();

    try {
      switch (name) {
        case "start_session": {
          const args = validateStartSessionArgs(rawArguments);
          const existing = await this.store.getSession(args.sessionId);
          if (existing) {
            const identityIssues = validateWaveAssessmentSession(existing, {
              currentIdentity: {
                workstreamId: args.workstreamId,
                waveId: args.waveId,
                parentPrNumber: args.parentPrNumber,
                parentHeadSha: args.assessedParentHeadSha,
                planRevision: args.currentPlanRevision
              }
            }).filter((issue) => issue.code.startsWith("stale-"));
            if (
              identityIssues.length > 0 ||
              existing.originalPlanningSessionId !== args.originalPlanningSessionId ||
              !arraysEqual(existing.planNodeIds, args.planNodeIds)
            ) {
              return invalidSessionFailure(name, args.sessionId, [
                ...identityIssues,
                ...(existing.originalPlanningSessionId !== args.originalPlanningSessionId
                  ? [{
                      severity: "error" as const,
                      code: "stale-plan-revision" as const,
                      message: `Original planning session ${args.originalPlanningSessionId} does not match existing session ${existing.originalPlanningSessionId}.`,
                      path: ["originalPlanningSessionId"]
                    }]
                  : []),
                ...(!arraysEqual(existing.planNodeIds, args.planNodeIds)
                  ? [{
                      severity: "error" as const,
                      code: "unknown-node-reference" as const,
                      message: "Provided plan node IDs do not match the existing session.",
                      path: ["planNodeIds"]
                    }]
                  : [])
              ]);
            }

            this.logInvocation(startedAt, name, { sessionId: args.sessionId }, "ok");
            return success(name, `Loaded existing wave assessment session: ${args.sessionId}`, {
              sessionId: args.sessionId,
              status: existing.status
            });
          }

          const session = createWaveAssessmentSession(args);
          await this.store.saveSession(session);
          this.logInvocation(startedAt, name, { sessionId: session.sessionId }, "ok");
          return success(name, `Started wave assessment session: ${session.sessionId}`, {
            sessionId: session.sessionId,
            status: session.status
          });
        }

        case "add_finding": {
          const args = validateAddFindingArgs(rawArguments);
          const session = await this.requireSession(args.sessionId);
          ensureOpenSession(session);
          assertAffectedPlanNodeIdsKnown(session, args.affectedPlanNodeIds);

          const updatedSession = addWaveAssessmentFinding(session, args);
          await this.store.saveSession(updatedSession);
          this.logInvocation(startedAt, name, { sessionId: args.sessionId }, "ok");
          return success(name, `Added finding to wave assessment session: ${args.sessionId}`, {
            sessionId: args.sessionId,
            findingCount: updatedSession.findings.length
          });
        }

        case "complete_session": {
          const args = validateCompleteSessionArgs(rawArguments);
          const session = await this.requireSession(args.sessionId);
          ensureOpenSession(session);

          const issues = validateWaveAssessmentSession(session, {
            decision: args.decision,
            summary: args.summary,
            currentIdentity: args.currentIdentity
          });
          if (issues.length > 0) {
            const updatedSession = { ...session, validationIssues: issues };
            await this.store.saveSession(updatedSession);
            return invalidSessionFailure(name, args.sessionId, issues);
          }

          const updatedSession = completeWaveAssessmentSession(session, args);
          await this.store.saveSession(updatedSession);
          this.logInvocation(startedAt, name, { sessionId: args.sessionId }, "ok");
          return success(name, `Completed wave assessment session: ${args.sessionId}`, {
            sessionId: args.sessionId,
            decision: updatedSession.decision,
            findingCount: updatedSession.findings.length
          });
        }

        case "export_session": {
          const args = validateExportSessionArgs(rawArguments);
          const session = await this.requireSession(args.sessionId);

          const issues = validateWaveAssessmentSession(session, {
            currentIdentity: args.currentIdentity
          });
          if (issues.length > 0) {
            return invalidSessionFailure(name, args.sessionId, issues);
          }

          if (session.status !== "completed") {
            return {
              ok: false,
              tool: name,
              error: {
                code: "session_not_completed",
                message: `Cannot export incomplete wave assessment session ${args.sessionId}.`
              }
            };
          }

          const result = exportWaveAssessmentSession(session);
          this.logInvocation(startedAt, name, { sessionId: args.sessionId }, "ok");
          return success(name, `Exported wave assessment session: ${args.sessionId}`, result as any);
        }

        default:
          return {
            ok: false,
            tool: name,
            error: {
              code: "tool_not_found",
              message: `Unknown wave assessment tool "${name}"`
            }
          };
      }
    } catch (error: unknown) {
      const failure = toFailure(name, error);
      this.logInvocation(
        startedAt,
        name,
        rawArguments as Record<string, unknown>,
        "error",
        failure.error.message
      );
      return failure;
    }
  }

  private async requireSession(sessionId: string): Promise<WaveAssessmentSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new WaveAssessmentToolError("session_not_found", `Session not found: ${sessionId}`);
    }
    return session;
  }

  private logInvocation(
    timestamp: string,
    toolName: string,
    args: Record<string, unknown>,
    status: "ok" | "error",
    message?: string
  ): void {
    this.logger.info(
      JSON.stringify({
        component: "wave-assessment-tool-service",
        timestamp,
        toolName,
        resultStatus: status,
        arguments: args,
        ...(message ? { message } : {})
      })
    );
  }
}

class WaveAssessmentToolError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function success(
  tool: string,
  summary: string,
  result: Record<string, unknown>
): BrokerToolCallResult {
  return { ok: true, tool, summary, result };
}

function invalidSessionFailure(
  tool: string,
  sessionId: string,
  issues: ReturnType<typeof validateWaveAssessmentSession>
): BrokerToolCallFailure {
  return {
    ok: false,
    tool,
    error: {
      code: "invalid_session",
      message: `Wave assessment session ${sessionId} failed validation: ${issues.map((issue) => issue.code).join(", ")}`
    }
  };
}

function toFailure(name: string, error: unknown): BrokerToolCallFailure {
  if (error instanceof WaveAssessmentToolError) {
    return {
      ok: false,
      tool: name,
      error: {
        code: error.code,
        message: error.message
      }
    };
  }

  return {
    ok: false,
    tool: name,
    error: {
      code: "internal_error",
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

function validateStartSessionArgs(args: unknown): {
  sessionId: string;
  workstreamId: string;
  waveId: string;
  parentPrNumber: number;
  assessedParentHeadSha: string;
  originalPlanningSessionId: string;
  currentPlanRevision: string;
  planNodeIds: string[];
} {
  const obj = expectObject(args);
  return {
    sessionId: expectString(obj.sessionId, "sessionId"),
    workstreamId: expectString(obj.workstreamId, "workstreamId"),
    waveId: expectString(obj.waveId, "waveId"),
    parentPrNumber: expectPositiveInteger(obj.parentPrNumber, "parentPrNumber"),
    assessedParentHeadSha: expectString(obj.assessedParentHeadSha, "assessedParentHeadSha"),
    originalPlanningSessionId: expectString(
      obj.originalPlanningSessionId,
      "originalPlanningSessionId"
    ),
    currentPlanRevision: expectStringOrNumber(obj.currentPlanRevision, "currentPlanRevision"),
    planNodeIds: expectUniqueStringArray(obj.planNodeIds, "planNodeIds")
  };
}

function validateAddFindingArgs(args: unknown): {
  sessionId: string;
  category: WaveAssessmentFindingCategory;
  summary: string;
  details: string;
  affectedPlanNodeIds: string[];
} {
  const obj = expectObject(args);
  return {
    sessionId: expectString(obj.sessionId, "sessionId"),
    category: expectEnum(
      obj.category,
      "category",
      WAVE_ASSESSMENT_FINDING_CATEGORIES
    ),
    summary: expectString(obj.summary, "summary"),
    details: expectString(obj.details, "details"),
    affectedPlanNodeIds: expectStringArray(
      obj.affectedPlanNodeIds ?? [],
      "affectedPlanNodeIds"
    )
  };
}

function validateCompleteSessionArgs(args: unknown): {
  sessionId: string;
  decision: WaveAssessmentDecision;
  summary: string;
  currentIdentity?: WaveAssessmentCurrentIdentity | undefined;
} {
  const obj = expectObject(args);
  return {
    sessionId: expectString(obj.sessionId, "sessionId"),
    decision: expectEnum(obj.decision, "decision", WAVE_ASSESSMENT_DECISIONS),
    summary: expectString(obj.summary, "summary"),
    currentIdentity: expectCurrentIdentity(obj.currentIdentity)
  };
}

function validateExportSessionArgs(args: unknown): {
  sessionId: string;
  currentIdentity?: WaveAssessmentCurrentIdentity | undefined;
} {
  const obj = expectObject(args);
  return {
    sessionId: expectString(obj.sessionId, "sessionId"),
    currentIdentity: expectCurrentIdentity(obj.currentIdentity)
  };
}

function expectCurrentIdentity(value: unknown): WaveAssessmentCurrentIdentity | undefined {
  if (value === undefined) {
    return undefined;
  }

  const obj = expectObject(value, "currentIdentity");
  const result: WaveAssessmentCurrentIdentity = {};
  if (obj.workstreamId !== undefined) result.workstreamId = expectString(obj.workstreamId, "currentIdentity.workstreamId");
  if (obj.waveId !== undefined) result.waveId = expectString(obj.waveId, "currentIdentity.waveId");
  if (obj.parentPrNumber !== undefined) result.parentPrNumber = expectPositiveInteger(obj.parentPrNumber, "currentIdentity.parentPrNumber");
  if (obj.parentHeadSha !== undefined) result.parentHeadSha = expectString(obj.parentHeadSha, "currentIdentity.parentHeadSha");
  if (obj.planRevision !== undefined) result.planRevision = expectStringOrNumber(obj.planRevision, "currentIdentity.planRevision");
  return result;
}

function ensureOpenSession(session: WaveAssessmentSession): void {
  if (session.status !== "open") {
    throw new WaveAssessmentToolError(
      "session_already_completed",
      `Wave assessment session ${session.sessionId} is already completed.`
    );
  }
}

function assertAffectedPlanNodeIdsKnown(
  session: WaveAssessmentSession,
  affectedPlanNodeIds: string[]
): void {
  const knownPlanNodeIds = new Set(session.planNodeIds);
  const unknownNodeIds = affectedPlanNodeIds.filter((nodeId) => !knownPlanNodeIds.has(nodeId));
  if (unknownNodeIds.length > 0) {
    throw new WaveAssessmentToolError(
      "unknown_node_reference",
      `Unknown affected plan node IDs: ${unknownNodeIds.join(", ")}`
    );
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectObject(value: unknown, name = "arguments"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WaveAssessmentToolError("invalid_arguments", `Expected ${name} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WaveAssessmentToolError(
      "invalid_arguments",
      `Expected ${name} to be a non-empty string.`
    );
  }
  return value.trim();
}

function expectStringOrNumber(value: unknown, name: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return expectString(value, name);
}

function expectPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new WaveAssessmentToolError(
      "invalid_arguments",
      `Expected ${name} to be a positive integer.`
    );
  }
  return value;
}

function expectStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new WaveAssessmentToolError("invalid_arguments", `Expected ${name} to be an array.`);
  }
  return value.map((item, index) => expectString(item, `${name}[${index}]`));
}

function expectUniqueStringArray(value: unknown, name: string): string[] {
  const items = expectStringArray(value, name);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) {
      throw new WaveAssessmentToolError(
        "invalid_arguments",
        `Expected ${name} to contain unique values. Duplicate: ${item}`
      );
    }
    seen.add(item);
  }
  return items;
}

function expectEnum<T extends readonly string[]>(value: unknown, name: string, choices: T): T[number] {
  const str = expectString(value, name);
  if (!choices.includes(str)) {
    throw new WaveAssessmentToolError(
      "invalid_arguments",
      `Expected ${name} to be one of: ${choices.join(", ")}.`
    );
  }
  return str as T[number];
}

const TOOL_DEFINITIONS: BrokerTool[] = [
  {
    name: "start_session",
    title: "Start Wave Assessment Session",
    description: "Start or load a wave assessment session for one parent PR head and plan revision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "sessionId",
        "workstreamId",
        "waveId",
        "parentPrNumber",
        "assessedParentHeadSha",
        "originalPlanningSessionId",
        "currentPlanRevision",
        "planNodeIds"
      ],
      properties: {
        sessionId: { type: "string" },
        workstreamId: { type: "string" },
        waveId: { type: "string" },
        parentPrNumber: { type: "number" },
        assessedParentHeadSha: { type: "string" },
        originalPlanningSessionId: { type: "string" },
        currentPlanRevision: { oneOf: [{ type: "string" }, { type: "number" }] },
        planNodeIds: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "add_finding",
    title: "Add Wave Assessment Finding",
    description: "Record a finding discovered while assessing the integrated parent PR.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "category", "summary", "details", "affectedPlanNodeIds"],
      properties: {
        sessionId: { type: "string" },
        category: { type: "string", enum: [...WAVE_ASSESSMENT_FINDING_CATEGORIES] },
        summary: { type: "string" },
        details: { type: "string" },
        affectedPlanNodeIds: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "complete_session",
    title: "Complete Wave Assessment Session",
    description: "Finalize a wave assessment decision after validating summary, findings, plan nodes, and optional freshness identity.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "decision", "summary"],
      properties: {
        sessionId: { type: "string" },
        decision: { type: "string", enum: [...WAVE_ASSESSMENT_DECISIONS] },
        summary: { type: "string" },
        currentIdentity: {
          type: "object",
          additionalProperties: false,
          properties: {
            workstreamId: { type: "string" },
            waveId: { type: "string" },
            parentPrNumber: { type: "number" },
            parentHeadSha: { type: "string" },
            planRevision: { oneOf: [{ type: "string" }, { type: "number" }] }
          }
        }
      }
    }
  },
  {
    name: "export_session",
    title: "Export Wave Assessment Session",
    description: "Export a completed and still-fresh wave assessment result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        currentIdentity: {
          type: "object",
          additionalProperties: false,
          properties: {
            workstreamId: { type: "string" },
            waveId: { type: "string" },
            parentPrNumber: { type: "number" },
            parentHeadSha: { type: "string" },
            planRevision: { oneOf: [{ type: "string" }, { type: "number" }] }
          }
        }
      }
    }
  }
];
