import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildOpenCodeCliArgs,
  extractOpenCodeAssistantText,
  getOpenCodeEnvOverrides,
  writeOpenCodeConfig,
  buildGlobalOpenCodeLaunchInstructions,
  prependGlobalOpenCodeLaunchInstructions,
  normalizeOpenCodeMcpToolName
} from "../src/agents/opencode-launch.js";

test("normalizeOpenCodeMcpToolName replaces non-alphanumeric characters with underscore", () => {
  const normalized = normalizeOpenCodeMcpToolName("githubBroker", "plan_breakdown.start_session");
  assert.equal(normalized, "githubBroker_plan_breakdown_start_session");
});

test("buildOpenCodeCliArgs returns args with prompt as last positional argument", () => {
  const args = buildOpenCodeCliArgs({
    model: "gemma-it",
    repoPath: "/tmp/repo",
    promptText: "Hello world"
  });
  assert.deepEqual(args, [
    "run",
    "--model",
    "gemma-it",
    "--format",
    "json",
    "--dir",
    "/tmp/repo",
    "Hello world"
  ]);
});

test("getOpenCodeEnvOverrides sets OPENCODE_CONFIG", () => {
  const configPath = "/tmp/opencode-config.json";
  const overrides = getOpenCodeEnvOverrides(configPath);
  assert.equal(overrides.OPENCODE_CONFIG, configPath);
});

test("writeOpenCodeConfig writes MCP config with correct mcp key", async () => {
  const tempBase = await mkdtemp(path.join(os.tmpdir(), "opencode-test-"));
  const configPath = path.join(tempBase, "opencode-config.json");

  try {
    await writeOpenCodeConfig(configPath, {
      mcp: {
        serverName: "githubBroker",
        serverUrl: "http://127.0.0.1:4444",
        toolAllowList: ["get_issue"]
      }
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.mcp.githubBroker.type, "remote");
    assert.equal(config.mcp.githubBroker.url, "http://127.0.0.1:4444");
    assert.equal(config.tools["githubBroker_*"], false);
    assert.equal(config.tools["githubBroker_get_issue"], true);
    assert.equal(config.mcpServers, undefined);
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
});

test("writeOpenCodeConfig writes empty config when no mcp options given", async () => {
  const tempBase = await mkdtemp(path.join(os.tmpdir(), "opencode-empty-"));
  const configPath = path.join(tempBase, "opencode-config.json");

  try {
    await writeOpenCodeConfig(configPath, {});
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config, {});
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
});

test("writeOpenCodeConfig includes all tools in top-level tools object", async () => {
  const tempBase = await mkdtemp(path.join(os.tmpdir(), "opencode-tools-"));
  const configPath = path.join(tempBase, "opencode-config.json");
  const tools = ["get_issue", "post_issue_comment", "create_pr", "plan_breakdown.start_session"];

  try {
    await writeOpenCodeConfig(configPath, {
      mcp: { serverName: "githubBroker", serverUrl: "http://127.0.0.1:4444", toolAllowList: tools }
    });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.tools["githubBroker_*"], false);
    for (const tool of tools) {
      assert.equal(config.tools[normalizeOpenCodeMcpToolName("githubBroker", tool)], true);
    }
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
});

test("extractOpenCodeAssistantText normalizes JSONL stream from text events", () => {
  const stream = [
    '{"type":"step_start","timestamp":123}',
    '{"type":"text","part":{"text":"Hello "}}',
    '{"type":"text","part":{"text":"world!"}}',
    '{"type":"step_finish","timestamp":456}'
  ].join("\n");

  const normalized = extractOpenCodeAssistantText(stream);
  assert.equal(normalized, "Hello world!");
});

test("extractOpenCodeAssistantText handles message/assistant events", () => {
  const stream = [
    '{"type":"message","role":"assistant","content":"Done."}'
  ].join("\n");

  const normalized = extractOpenCodeAssistantText(stream);
  assert.equal(normalized, "Done.");
});

test("extractOpenCodeAssistantText falls back to result/output", () => {
  const stream = [
    '{"type":"result","text":"Final result"}'
  ].join("\n");

  const normalized = extractOpenCodeAssistantText(stream);
  assert.equal(normalized, "Final result");
});

test("extractOpenCodeAssistantText returns undefined for empty or invalid stream", () => {
  assert.equal(extractOpenCodeAssistantText(""), undefined);
  assert.equal(extractOpenCodeAssistantText("not json"), undefined);
});

test("buildGlobalOpenCodeLaunchInstructions includes broker policy", () => {
  const instructions = buildGlobalOpenCodeLaunchInstructions({
    mcp: {
      serverName: "githubBroker",
      serverUrl: "http://127.0.0.1:4444",
      toolAllowList: ["get_issue", "post_issue_comment"]
    }
  });

  assert.ok(instructions.includes("githubBroker"));
  assert.ok(instructions.includes("githubBroker_get_issue"));
  assert.ok(instructions.includes("githubBroker_post_issue_comment"));
  assert.ok(instructions.includes("gh"));
  assert.ok(instructions.includes("🤖"));
});

test("prependGlobalOpenCodeLaunchInstructions prepends when mcp is present", () => {
  const prompt = "Do work.";
  const mcp = {
    serverName: "githubBroker",
    serverUrl: "http://127.0.0.1:4444",
    toolAllowList: ["get_issue"]
  };
  const prepended = prependGlobalOpenCodeLaunchInstructions(prompt, { mcp });
  assert.ok(prepended.startsWith("# Global OpenCode Instructions"));
  assert.ok(prepended.endsWith("Do work."));
});

test("prependGlobalOpenCodeLaunchInstructions is no-op when mcp is absent", () => {
  const prompt = "Do work.";
  const prepended = prependGlobalOpenCodeLaunchInstructions(prompt, {});
  assert.equal(prepended, "Do work.");
});
