import type { BrokerTool, BrokerToolService, BrokerToolCallResult, BrokerToolCallFailure } from "../../github/types.js";
import type { Logger } from "../../utils/logger.js";
import {
  createSession,
  applyPatches,
  inspectSession,
  validateSession,
  exportSession,
  PatchError
} from "./index.js";
import type { PatchOperation, PlanBreakdownSession, GeneratorTask, GeneratorWave } from "./types.js";
import type { PlanBreakdownSessionStore } from "./store.js";

export class PlanBreakdownToolService implements BrokerToolService {
  readonly namespace = "plan_breakdown";

  constructor(
    private readonly store: PlanBreakdownSessionStore,
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
          const session = createSession({ title: args.title, summary: args.summary });
          await this.store.saveSession(session);

          this.logInvocation(startedAt, name, { sessionId: session.id }, "ok");
          return {
            ok: true,
            tool: name,
            summary: `Started new plan breakdown session: ${session.id}`,
            result: { sessionId: session.id }
          };
        }

        case "apply_patch": {
          const args = validateApplyPatchArgs(rawArguments);
          const session = await this.requireSession(args.sessionId);

          const updatedSession = applyPatches(session, [args.patch]);
          await this.store.saveSession(updatedSession);

          const issues = validateSession(updatedSession);
          const hasErrors = issues.some(issue => issue.severity === "error");

          this.logInvocation(startedAt, name, { sessionId: args.sessionId }, "ok");
          return {
            ok: true,
            tool: name,
            summary: `Applied patch to session: ${args.sessionId}${hasErrors ? " (now has validation errors)" : ""}`,
            result: {
              sessionId: args.sessionId,
              isValid: !hasErrors,
              issueCount: issues.length
            }
          };
        }

        case "inspect_session": {
          const args = validateSessionLookupArgs(rawArguments);
          const session = await this.requireSession(args.sessionId);

          const inspection = inspectSession(session);
          this.logInvocation(startedAt, name, { sessionId: args.sessionId }, "ok");
          return {
            ok: true,
            tool: name,
            summary: `Inspected session: ${args.sessionId}`,
            result: inspection as any
          };
        }

        case "validate_session": {
          const args = validateSessionLookupArgs(rawArguments);
          const session = await this.requireSession(args.sessionId);

          const issues = validateSession(session);
          const hasErrors = issues.some(issue => issue.severity === "error");
          this.logInvocation(startedAt, name, { sessionId: args.sessionId }, "ok");
          return {
            ok: true,
            tool: name,
            summary: `Validated session: ${args.sessionId} (${issues.length} issues)`,
            result: { sessionId: args.sessionId, issues, isValid: !hasErrors }
          };
        }

        case "export_session": {
          const args = validateSessionLookupArgs(rawArguments);
          const session = await this.requireSession(args.sessionId);

          const issues = validateSession(session);
          const hasErrors = issues.some(issue => issue.severity === "error");
          if (hasErrors) {
            return {
              ok: false,
              tool: name,
              error: {
                code: "invalid_session",
                message: `Cannot export invalid session ${args.sessionId}. Call validate_session for details.`
              }
            };
          }

          const result = exportSession(session);
          this.logInvocation(startedAt, name, { sessionId: args.sessionId }, "ok");
          return {
            ok: true,
            tool: name,
            summary: `Exported session: ${args.sessionId}`,
            result: result as any
          };
        }

        default:
          return {
            ok: false,
            tool: name,
            error: {
              code: "tool_not_found",
              message: `Unknown plan breakdown tool "${name}"`
            }
          };
      }
    } catch (error: unknown) {
      const failure = toFailure(name, error);
      this.logInvocation(startedAt, name, rawArguments as any, "error", failure.error.message);
      return failure;
    }
  }

  private async requireSession(sessionId: string): Promise<PlanBreakdownSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(`Session not found: ${sessionId}`);
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
        component: "plan-breakdown-tool-service",
        timestamp,
        toolName,
        resultStatus: status,
        arguments: args,
        ...(message ? { message } : {})
      })
    );
  }
}

class SessionNotFoundError extends Error {}
class ValidationError extends Error {}

function toFailure(name: string, error: unknown): BrokerToolCallFailure {
  if (error instanceof SessionNotFoundError) {
    return {
      ok: false,
      tool: name,
      error: {
        code: "session_not_found",
        message: error.message
      }
    };
  }

  if (error instanceof ValidationError) {
    return {
      ok: false,
      tool: name,
      error: {
        code: "invalid_arguments",
        message: error.message
      }
    };
  }

  if (error instanceof PatchError) {
    return {
      ok: false,
      tool: name,
      error: {
        code: "invalid_patch",
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

function validateStartSessionArgs(args: unknown): { title: string; summary: string } {
  const obj = expectObject(args);
  return {
    title: expectString(obj.title, "title"),
    summary: expectString(obj.summary, "summary")
  };
}

function validateApplyPatchArgs(args: unknown): { sessionId: string; patch: PatchOperation } {
  const obj = expectObject(args);
  const patch = expectObject(obj.patch, "patch");

  return {
    sessionId: expectString(obj.sessionId, "sessionId"),
    patch: validatePatchOperation(patch)
  };
}

function validatePatchOperation(patch: Record<string, unknown>): PatchOperation {
  const op = expectString(patch.op, "patch.op");

  switch (op) {
    case "set-title":
      return { op, value: expectString(patch.value, "patch.value") };

    case "set-summary":
      return { op, value: expectString(patch.value, "patch.value") };

    case "add-task":
      return {
        op,
        task: validateTask(expectObject(patch.task, "patch.task"), "patch.task")
      };

    case "update-task":
      return {
        op,
        id: expectString(patch.id, "patch.id"),
        patch: validateTaskPatch(expectObject(patch.patch, "patch.patch"), "patch.patch")
      };

    case "remove-task":
      return { op, id: expectString(patch.id, "patch.id") };

    case "add-wave": {
      const result: PatchOperation = {
        op,
        wave: validateWave(expectObject(patch.wave, "patch.wave"), "patch.wave")
      };
      if (patch.index !== undefined) {
        (result as any).index = expectInteger(patch.index, "patch.index");
      }
      return result;
    }

    case "update-wave":
      return {
        op,
        id: expectString(patch.id, "patch.id"),
        patch: validateWavePatch(expectObject(patch.patch, "patch.patch"), "patch.patch")
      };

    case "remove-wave":
      return { op, id: expectString(patch.id, "patch.id") };

    case "reorder-waves":
      return { op, waveIds: expectStringArray(patch.waveIds, "patch.waveIds") };

    case "set-recommended-first-wave":
      return { op, id: expectString(patch.id, "patch.id") };

    case "add-graph-concern":
      return { op, value: expectString(patch.value, "patch.value") };

    case "remove-graph-concern":
      return { op, index: expectInteger(patch.index, "patch.index") };

    case "add-human-decision":
      return { op, value: expectString(patch.value, "patch.value") };

    case "remove-human-decision":
      return { op, index: expectInteger(patch.index, "patch.index") };

    case "set-suggested-next-action":
      return { op, value: expectString(patch.value, "patch.value") };

    default:
      throw new ValidationError(`Unknown patch operation: ${op}`);
  }
}

function validateTask(task: Record<string, unknown>, prefix: string): GeneratorTask {
  return {
    id: expectString(task.id, `${prefix}.id`),
    title: expectString(task.title, `${prefix}.title`),
    description: expectString(task.description, `${prefix}.description`),
    dependsOn: expectStringArray(task.dependsOn || task.dependencies || [], `${prefix}.dependsOn`),
    blocks: expectStringArray(task.blocks || [], `${prefix}.blocks`),
    canRunInParallelWith: expectStringArray(task.canRunInParallelWith || [], `${prefix}.canRunInParallelWith`),
    risk: validateRisk(task.risk || "medium", `${prefix}.risk`),
    filesLikelyInvolved: expectStringArray(task.filesLikelyInvolved || [], `${prefix}.filesLikelyInvolved`),
    acceptanceCriteria: expectStringArray(task.acceptanceCriteria || [], `${prefix}.acceptanceCriteria`),
    verification: expectStringArray(task.verification || [], `${prefix}.verification`)
  };
}

function validateTaskPatch(patch: Record<string, unknown>, prefix: string): Partial<Omit<GeneratorTask, "id">> {
  const result: Partial<Omit<GeneratorTask, "id">> = {};

  if (patch.title !== undefined) result.title = expectString(patch.title, `${prefix}.title`);
  if (patch.description !== undefined) result.description = expectString(patch.description, `${prefix}.description`);

  const dependsOn = patch.dependsOn || patch.dependencies;
  if (dependsOn !== undefined) result.dependsOn = expectStringArray(dependsOn, `${prefix}.dependsOn`);

  if (patch.blocks !== undefined) result.blocks = expectStringArray(patch.blocks, `${prefix}.blocks`);
  if (patch.canRunInParallelWith !== undefined) result.canRunInParallelWith = expectStringArray(patch.canRunInParallelWith, `${prefix}.canRunInParallelWith`);
  if (patch.risk !== undefined) result.risk = validateRisk(patch.risk, `${prefix}.risk`);
  if (patch.filesLikelyInvolved !== undefined) result.filesLikelyInvolved = expectStringArray(patch.filesLikelyInvolved, `${prefix}.filesLikelyInvolved`);
  if (patch.acceptanceCriteria !== undefined) result.acceptanceCriteria = expectStringArray(patch.acceptanceCriteria, `${prefix}.acceptanceCriteria`);
  if (patch.verification !== undefined) result.verification = expectStringArray(patch.verification, `${prefix}.verification`);

  return result;
}

function validateWave(wave: Record<string, unknown>, prefix: string): GeneratorWave {
  return {
    id: expectString(wave.id, `${prefix}.id`),
    taskIds: expectStringArray(wave.taskIds, `${prefix}.taskIds`),
    rationale: typeof wave.rationale === "string" ? wave.rationale.trim() : ""
  };
}

function validateWavePatch(patch: Record<string, unknown>, prefix: string): Partial<Omit<GeneratorWave, "id">> {
  const result: Partial<Omit<GeneratorWave, "id">> = {};

  if (patch.taskIds !== undefined) result.taskIds = expectStringArray(patch.taskIds, `${prefix}.taskIds`);
  if (patch.rationale !== undefined) result.rationale = expectString(patch.rationale, `${prefix}.rationale`);

  return result;
}

function validateRisk(risk: unknown, name: string): GeneratorTask["risk"] {
  const r = expectString(risk, name);
  if (r !== "low" && r !== "medium" && r !== "high") {
    throw new ValidationError(`Expected ${name} to be one of: low, medium, high`);
  }
  return r as GeneratorTask["risk"];
}

function validateSessionLookupArgs(args: unknown): { sessionId: string } {
  const obj = expectObject(args);
  return {
    sessionId: expectString(obj.sessionId, "sessionId")
  };
}

function expectObject(val: unknown, name: string = "arguments"): Record<string, unknown> {
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    throw new ValidationError(`Expected ${name} to be an object`);
  }
  return val as Record<string, unknown>;
}

function expectString(val: unknown, name: string): string {
  if (typeof val !== "string" || val.trim() === "") {
    throw new ValidationError(`Expected ${name} to be a non-empty string`);
  }
  return val.trim();
}

function expectStringArray(val: unknown, name: string): string[] {
  if (!Array.isArray(val)) {
    throw new ValidationError(`Expected ${name} to be an array`);
  }
  return val.map((item, i) => expectString(item, `${name}[${i}]`));
}

function expectInteger(val: unknown, name: string): number {
  if (typeof val !== "number" || !Number.isInteger(val)) {
    throw new ValidationError(`Expected ${name} to be an integer`);
  }
  return val;
}


const TOOL_DEFINITIONS: BrokerTool[] = [
  {
    name: "start_session",
    title: "Start Plan Breakdown Session",
    description: "Start a new plan breakdown session for generating packet plans.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "summary"],
      properties: {
        title: { type: "string", description: "The title of the plan breakdown." },
        summary: { type: "string", description: "A high-level summary of the breakdown." }
      }
    }
  },
  {
    name: "apply_patch",
    title: "Apply Patch to Session",
    description: "Apply a patch operation to an existing plan breakdown session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "patch"],
      properties: {
        sessionId: { type: "string" },
        patch: {
          type: "object",
          description: "A single patch operation (e.g., add-task, update-task, add-wave)."
        }
      }
    }
  },
  {
    name: "inspect_session",
    title: "Inspect Session",
    description: "Return a human-readable overview of the current session state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      }
    }
  },
  {
    name: "validate_session",
    title: "Validate Session",
    description: "Run validation rules on the session and return any issues.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      }
    }
  },
  {
    name: "export_session",
    title: "Export Session",
    description: "Export a valid session to a PlanBreakdownResult artifact.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      }
    }
  }
];
