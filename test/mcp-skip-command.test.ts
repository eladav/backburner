import * as assert from "node:assert/strict";
import { test } from "node:test";
import { extractMcpSkipCommand } from "../src/tasks/mcp-skip.js";

test("extractMcpSkipCommand parses valid commands correctly", () => {
  const result = extractMcpSkipCommand("mcp-skip: task-123 context7");
  assert.deepEqual(result, { taskId: "task-123", mcpHandle: "context7" });
});

test("extractMcpSkipCommand handles case-insensitive prefix", () => {
  const result = extractMcpSkipCommand("MCP-SKIP: task-123 context7");
  assert.deepEqual(result, { taskId: "task-123", mcpHandle: "context7" });
});

test("extractMcpSkipCommand tolerates extra internal, leading, and trailing whitespace", () => {
  const result = extractMcpSkipCommand("   mcp-skip:   task-123   context7   ");
  assert.deepEqual(result, { taskId: "task-123", mcpHandle: "context7" });
});

test("extractMcpSkipCommand returns undefined for missing handle", () => {
  const result = extractMcpSkipCommand("mcp-skip: task-123");
  assert.equal(result, undefined);
});

test("extractMcpSkipCommand returns undefined for missing colon", () => {
  const result = extractMcpSkipCommand("mcp-skip task-123 context7");
  assert.equal(result, undefined);
});

test("extractMcpSkipCommand returns undefined for extra trailing prose", () => {
  const result = extractMcpSkipCommand("mcp-skip: task-123 context7 please");
  assert.equal(result, undefined);
});

test("extractMcpSkipCommand returns undefined for unrelated body", () => {
  const result = extractMcpSkipCommand("please skip the mcp context7 for task-123");
  assert.equal(result, undefined);
});
