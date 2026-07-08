import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildClaudeAllowedTools,
  buildClaudeCliArgs,
  buildClaudeMcpConfig,
  buildClaudeSettings,
  buildGlobalClaudeLaunchInstructions,
  mapPermissionToClaudePermissionMode,
  writeClaudeMcpConfig,
  writeClaudeSettings
} from "../src/agents/claude-launch.js";

test("mapPermissionToClaudePermissionMode maps read-only to dontAsk and workspace-write to bypassPermissions", () => {
  assert.equal(mapPermissionToClaudePermissionMode("read-only"), "dontAsk");
  assert.equal(mapPermissionToClaudePermissionMode("workspace-write"), "bypassPermissions");
});

test("buildClaudeCliArgs includes print mode and permission flags", () => {
  const args = buildClaudeCliArgs({
    permissionMode: "dontAsk"
  });
  assert.deepEqual(args, ["-p", "--permission-mode", "dontAsk"]);
});

test("buildClaudeCliArgs includes artifact paths and allowed tools when provided", () => {
  const args = buildClaudeCliArgs({
    permissionMode: "bypassPermissions",
    mcpConfigPath: "/tmp/mcp.json",
    settingsPath: "/tmp/settings.json",
    allowedTools: ["mcp__githubBroker__get_issue"]
  });
  assert.deepEqual(args, [
    "-p",
    "--permission-mode",
    "bypassPermissions",
    "--settings",
    "/tmp/settings.json",
    "--mcp-config",
    "/tmp/mcp.json",
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__githubBroker__get_issue"
  ]);
});

test("buildClaudeCliArgs includes --model flag when model is provided", () => {
  const args = buildClaudeCliArgs({
    permissionMode: "dontAsk",
    model: "opus"
  });
  assert.deepEqual(args, ["-p", "--permission-mode", "dontAsk", "--model", "opus"]);
});

test("buildClaudeCliArgs omits --model flag when model is absent", () => {
  const args = buildClaudeCliArgs({
    permissionMode: "dontAsk"
  });
  assert.ok(!args.includes("--model"));
});

test("buildClaudeMcpConfig creates a valid HTTP MCP server config", () => {
  const mcp = {
    serverName: "githubBroker",
    serverUrl: "http://127.0.0.1:4444/mcp",
    toolAllowList: ["get_issue"]
  };
  const config = buildClaudeMcpConfig(mcp);
  assert.deepEqual(config, {
    mcpServers: {
      githubBroker: {
        type: "http",
        url: "http://127.0.0.1:4444/mcp"
      }
    }
  });
});

test("buildClaudeSettings returns an empty object when no workspacePath is provided", () => {
  assert.deepEqual(buildClaudeSettings({}), {});
});

test("buildClaudeSettings includes trustedWorkspaces when workspacePath is provided", () => {
  const settings = buildClaudeSettings({ workspacePath: "/workspace/my-repo" });
  assert.deepEqual(settings, { trustedWorkspaces: ["/workspace/my-repo"] });
});

test("writeClaudeMcpConfig writes MCP config to disk", async () => {
  const tempBase = await mkdtemp(path.join(os.tmpdir(), "claude-test-mcp-"));
  const mcpPath = path.join(tempBase, "claude-mcp-config.json");
  const mcp = {
    serverName: "githubBroker",
    serverUrl: "http://127.0.0.1:4444/mcp",
    toolAllowList: ["get_issue"]
  };

  try {
    await writeClaudeMcpConfig(mcpPath, mcp);
    const content = JSON.parse(await readFile(mcpPath, "utf8"));
    assert.deepEqual(content.mcpServers.githubBroker.type, "http");
    assert.deepEqual(content.mcpServers.githubBroker.url, "http://127.0.0.1:4444/mcp");
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
});

test("writeClaudeSettings writes settings to disk", async () => {
  const tempBase = await mkdtemp(path.join(os.tmpdir(), "claude-test-settings-"));
  const settingsPath = path.join(tempBase, "claude-settings.json");

  try {
    await writeClaudeSettings(settingsPath, {});
    const content = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(content, {});
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
});

test("writeClaudeSettings writes trustedWorkspaces when workspacePath is provided", async () => {
  const tempBase = await mkdtemp(path.join(os.tmpdir(), "claude-test-settings-"));
  const settingsPath = path.join(tempBase, "claude-settings.json");
  try {
    await writeClaudeSettings(settingsPath, { workspacePath: "/repo/my-project" });
    const content = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(content, { trustedWorkspaces: ["/repo/my-project"] });
  } finally {
    await rm(tempBase, { recursive: true, force: true });
  }
});

test("buildClaudeAllowedTools keeps simple GitHub tool names intact", () => {
  const mcp = {
    serverName: "myBroker",
    serverUrl: "http://...",
    toolAllowList: ["tool1", "tool2"]
  };
  const tools = buildClaudeAllowedTools(mcp);
  assert.deepEqual(tools, ["mcp__myBroker__tool1", "mcp__myBroker__tool2"]);
});

test("buildClaudeAllowedTools normalizes namespaced plan breakdown tools for Claude", () => {
  const mcp = {
    serverName: "githubBroker",
    serverUrl: "http://127.0.0.1:4444/mcp",
    toolAllowList: ["plan_breakdown.start_session", "plan_breakdown.export_session"]
  };

  const tools = buildClaudeAllowedTools(mcp);

  assert.deepEqual(tools, [
    "mcp__githubBroker__plan_breakdown_start_session",
    "mcp__githubBroker__plan_breakdown_export_session"
  ]);
});

test("buildGlobalClaudeLaunchInstructions includes mandatory rules and emoji", () => {
  const mcp = {
    serverName: "githubBroker",
    serverUrl: "http://127.0.0.1:4444/mcp",
    toolAllowList: ["get_issue"]
  };
  const instructions = buildGlobalClaudeLaunchInstructions({ mcp });
  assert.ok(instructions.includes('named "githubBroker"'));
  assert.ok(instructions.includes("mcp__githubBroker__get_issue"));
  assert.ok(instructions.includes("🤖"));
});

test("buildClaudeCliArgs includes --session-id and --name when planned session options are provided", () => {
  const args = buildClaudeCliArgs({
    permissionMode: "dontAsk",
    plannedSessionId: "uuid-1234",
    sessionName: "aog-session-name"
  });
  assert.deepEqual(args, [
    "-p",
    "--permission-mode",
    "dontAsk",
    "--session-id",
    "uuid-1234",
    "--name",
    "aog-session-name"
  ]);
});

test("buildClaudeCliArgs prefers resumeSessionId over plannedSessionId", () => {
  const args = buildClaudeCliArgs({
    permissionMode: "dontAsk",
    resumeSessionId: "resume-uuid",
    plannedSessionId: "planned-uuid",
    sessionName: "planned-name"
  });
  assert.deepEqual(args, [
    "-p",
    "--permission-mode",
    "dontAsk",
    "--resume",
    "resume-uuid"
  ]);
});
