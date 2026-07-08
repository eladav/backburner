import * as assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import { JobMemoryToolService } from "../src/memory/tool-service.js";
import type { JobMemoryStore } from "../src/memory/store.js";
import type { Logger } from "../src/utils/logger.js";
import type { JobMemoryScope } from "../src/memory/types.js";

describe("JobMemoryToolService", () => {
  let mockStore: JobMemoryStore;
  let mockLogger: Logger & { messages: string[] };
  let service: JobMemoryToolService;

  const scope: JobMemoryScope = {
    repoKey: "owner/repo",
    workstreamId: "ws-1",
    job: "planning",
    modelClass: "strong"
  };
  const bankId = "bank-1";
  const taskId = "task-1";

  beforeEach(() => {
    mockLogger = {
      messages: [],
      info(msg: string) { this.messages.push(msg); },
      warn(msg: string) { this.messages.push(msg); },
      error(msg: string) { this.messages.push(msg); }
    };

    mockStore = {
      async add() {
        return {
          id: "entry-1",
          bankId: "bank-1",
          scope,
          type: "decision",
          text: "test",
          source: { taskId: "task-1" },
          createdAt: "now",
          updatedAt: "now"
        } as any;
      },
      async search() {
        return [] as any;
      }
    };

    service = new JobMemoryToolService(mockStore, mockLogger);
  });

  test("lists tools", () => {
    const tools = service.listTools();
    assert.equal(tools.length, 2);
    assert.ok(tools.find(t => t.name === "memory_add"));
    assert.ok(tools.find(t => t.name === "memory_search"));
  });

  test("fails if unbound", async () => {
    const result = await service.callTool("memory_add", { type: "decision", text: "test" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "memory_scope_unbound");
    }
    assert.ok(mockLogger.messages.some(m => m.includes("DENIED")));
  });

  test("succeeds when bound", async () => {
    service.bind(scope, bankId, taskId);
    const result = await service.callTool("memory_add", { type: "decision", text: "test" });
    assert.equal(result.ok, true);
    assert.ok(mockLogger.messages.some(m => m.includes("status=success")));
  });

  test("unbinds correctly", async () => {
    service.bind(scope, bankId, taskId);
    service.unbind();
    const result = await service.callTool("memory_search", {});
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "memory_scope_unbound");
    }
  });

  describe("validation", () => {
    beforeEach(() => {
      service.bind(scope, bankId, taskId);
    });

    test("memory_add: fails with invalid type", async () => {
      const result = await service.callTool("memory_add", { type: "invalid", text: "test" });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.message.includes("Invalid memory type"));
      }
    });

    test("memory_add: fails with missing text", async () => {
      const result = await service.callTool("memory_add", { type: "decision" });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.message.includes("Memory text is required"));
      }
    });

    test("memory_add: fails with empty text", async () => {
      const result = await service.callTool("memory_add", { type: "decision", text: "" });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.message.includes("Memory text is required"));
      }
    });

    test("memory_add: fails with too long text", async () => {
      const longText = "a".repeat(2001);
      const result = await service.callTool("memory_add", { type: "decision", text: longText });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.message.includes("exceeds maximum length"));
      }
    });

    test("memory_search: fails with invalid type", async () => {
      const result = await service.callTool("memory_search", { type: "invalid" });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.message.includes("Invalid search type"));
      }
    });
  });
});
