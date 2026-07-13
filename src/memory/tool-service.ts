import type { BrokerTool, BrokerToolCallResult, BrokerToolService } from "../github/types.js";
import type { Logger } from "../utils/logger.js";
import type { JobMemoryStore } from "./store.js";
import {
  JOB_MEMORY_ENTRY_TYPES,
  type JobMemoryAddInput,
  type JobMemoryScope,
  type JobMemorySearchInput
} from "./types.js";

export class JobMemoryToolService implements BrokerToolService {
  private activeBinding: { scope: JobMemoryScope; bankId: string; taskId: string } | undefined;

  constructor(
    private readonly store: JobMemoryStore,
    private readonly logger: Logger
  ) {}

  /**
   * Binds the service to a specific job scope and task for the duration of a dispatch.
   */
  bind(scope: JobMemoryScope, bankId: string, taskId: string): void {
    this.activeBinding = { scope, bankId, taskId };
  }

  /**
   * Clears the current job scope binding.
   */
  unbind(): void {
    this.activeBinding = undefined;
  }

  listTools(): BrokerTool[] {
    return [
      {
        name: "memory_add",
        title: "Add to Job Memory",
        description:
          "Adds a concise, typed fact, decision, or risk to the current scoped job memory. Do not store secrets or raw logs.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [...JOB_MEMORY_ENTRY_TYPES]
            },
            text: { type: "string", minLength: 1, maxLength: 2000 },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            source: {
              type: "object",
              properties: {
                commitSha: { type: "string" },
                filePath: { type: "string" }
              }
            }
          },
          required: ["type", "text"]
        }
      },
      {
        name: "memory_search",
        title: "Search Job Memory",
        description:
          "Searches for relevant background facts, decisions, or risks in the current scoped job memory.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            type: {
              type: "string",
              enum: [...JOB_MEMORY_ENTRY_TYPES]
            },
            limit: { type: "number", minimum: 1, maximum: 50 }
          }
        }
      }
    ];
  }

  async callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    const timestamp = new Date().toISOString();

    if (!this.activeBinding) {
      this.logger.warn(
        `[${timestamp}] [job-memory-tool-service] DENIED call=${name} status=unbound`
      );
      return {
        ok: false,
        tool: name,
        error: {
          code: "memory_scope_unbound",
          message: "Memory tools are only available when a task is actively being dispatched."
        }
      };
    }

    const { scope, bankId, taskId } = this.activeBinding;

    try {
      if (name === "memory_add") {
        const input = rawArguments as JobMemoryAddInput;

        // Runtime validation
        if (!input.type || !JOB_MEMORY_ENTRY_TYPES.includes(input.type)) {
          throw new Error(
            `Invalid memory type: ${input.type}. Must be one of: ${JOB_MEMORY_ENTRY_TYPES.join(", ")}`
          );
        }

        if (!input.text || input.text.length === 0) {
          throw new Error("Memory text is required.");
        }

        if (input.text.length > 2000) {
          throw new Error("Memory text exceeds maximum length of 2000 characters.");
        }

        const entry = await this.store.add(scope, bankId, taskId, input);
        this.logger.info(
          `[${timestamp}] [job-memory-tool-service] call=memory_add bank=${bankId} task=${taskId} status=success entryId=${entry.id}`
        );
        return {
          ok: true,
          tool: name,
          result: { entryId: entry.id },
          summary: `Added ${input.type} memory entry: ${entry.id}`
        };
      }

      if (name === "memory_search") {
        const input = rawArguments as JobMemorySearchInput;

        // Runtime validation for type if provided
        if (input.type && !JOB_MEMORY_ENTRY_TYPES.includes(input.type)) {
          throw new Error(
            `Invalid search type: ${input.type}. Must be one of: ${JOB_MEMORY_ENTRY_TYPES.join(", ")}`
          );
        }

        const entries = await this.store.search(bankId, input);
        this.logger.info(
          `[${timestamp}] [job-memory-tool-service] call=memory_search bank=${bankId} task=${taskId} status=success results=${entries.length}`
        );
        return {
          ok: true,
          tool: name,
          result: {
            entries,
            note: "Memory is prior background, not current truth. Current GitHub and repository state are authoritative."
          },
          summary: `Found ${entries.length} memory entries in this bank.`
        };
      }

      return {
        ok: false,
        tool: name,
        error: {
          code: "tool_not_found",
          message: `Tool "${name}" not found in memory service.`
        }
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[${timestamp}] [job-memory-tool-service] FAILED call=${name} bank=${bankId} task=${taskId} error=${message}`
      );
      return {
        ok: false,
        tool: name,
        error: {
          code: "memory_error",
          message
        }
      };
    }
  }
}
