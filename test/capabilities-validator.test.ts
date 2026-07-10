import * as assert from "node:assert/strict";
import { test } from "node:test";
import { validateCapabilities } from "../src/capabilities/validator.js";
import type {
  BackburnerSensorCapability,
  BackburnerControllerCapability,
  McpDependency,
  NormalizedCapabilities,
} from "../src/config/types.js";
import type { McpStatusRecord } from "../src/state/types.js";

// Test helpers
function makeSensors(uses: string): BackburnerSensorCapability[] {
  return [{ name: "s1", uses, observes: "issues-and-prs" }];
}

function makeControllers(uses: string): BackburnerControllerCapability[] {
  return [
    {
      name: "c1",
      uses,
      grants: ["comment-on-prs"],
      approval: "required",
    },
  ];
}

function makeDep(handle: string): McpDependency {
  return { handle, smitheryId: `smithery-id-for-${handle}` };
}

function makeStatus(
  handle: string,
  status: McpStatusRecord["status"],
  message?: string
): McpStatusRecord {
  return {
    handle,
    providerId: "smithery",
    providerMcpId: `smithery-id-for-${handle}`,
    status,
    lastCheckedAt: "2026-06-09T00:00:00Z",
    ...(message ? { message } : {}),
  };
}

test("empty capability config produces empty valid and blocked", () => {
  const result = validateCapabilities({ sensors: [], controllers: [] }, [], []);
  assert.deepEqual(result, { valid: [], blocked: [] });
});

test("sensor referencing declared MCP with ready status is valid", () => {
  const sensors = makeSensors("gh");
  const deps = [makeDep("gh")];
  const statuses = [makeStatus("gh", "ready")];

  const result = validateCapabilities({ sensors, controllers: [] }, deps, statuses);
  assert.equal(result.valid.length, 1);
  const v0 = result.valid[0];
  assert.ok(v0);
  assert.deepEqual(v0, {
    name: "s1",
    kind: "sensor",
    uses: "gh",
    mcpStatus: "ready",
  });
  assert.equal(result.blocked.length, 0);
});

test("controller referencing declared MCP with ready status is valid", () => {
  const controllers = makeControllers("gh");
  const deps = [makeDep("gh")];
  const statuses = [makeStatus("gh", "ready")];

  const result = validateCapabilities({ sensors: [], controllers }, deps, statuses);
  assert.equal(result.valid.length, 1);
  const v0 = result.valid[0];
  assert.ok(v0);
  assert.deepEqual(v0, {
    name: "c1",
    kind: "controller",
    uses: "gh",
    mcpStatus: "ready",
  });
  assert.equal(result.blocked.length, 0);
});

test("mixed sensors and controllers are both validated", () => {
  const sensors: BackburnerSensorCapability[] = [
    { name: "s1", uses: "mcp-a", observes: "issues-and-prs" },
  ];
  const controllers: BackburnerControllerCapability[] = [
    {
      name: "c1",
      uses: "mcp-b",
      grants: ["comment-on-prs"],
      approval: "required",
    },
  ];
  const deps = [makeDep("mcp-a"), makeDep("mcp-b")];
  const statuses = [makeStatus("mcp-a", "ready"), makeStatus("mcp-b", "ready")];

  const result = validateCapabilities({ sensors, controllers }, deps, statuses);
  assert.equal(result.valid.length, 2);
  assert.ok(result.valid.some((v) => v.kind === "sensor" && v.name === "s1"));
  assert.ok(
    result.valid.some((v) => v.kind === "controller" && v.name === "c1")
  );
});

test("capability referencing missing MCP handle is blocked with missing_mcp_handle", () => {
  const sensors = makeSensors("unknown-mcp");
  const deps: McpDependency[] = [];
  const statuses: McpStatusRecord[] = [];

  const result = validateCapabilities({ sensors, controllers: [] }, deps, statuses);
  assert.equal(result.valid.length, 0);
  assert.equal(result.blocked.length, 1);
  const b0 = result.blocked[0];
  assert.ok(b0);
  assert.equal(b0.name, "s1");
  assert.equal(b0.reason, "missing_mcp_handle");
});

test("capability with declared MCP but no status record is blocked with mcp_not_connection_ready", () => {
  const sensors = makeSensors("gh");
  const deps = [makeDep("gh")];
  const statuses: McpStatusRecord[] = [];

  const result = validateCapabilities({ sensors, controllers: [] }, deps, statuses);
  assert.equal(result.valid.length, 0);
  assert.equal(result.blocked.length, 1);
  const b0 = result.blocked[0];
  assert.ok(b0);
  assert.equal(b0.name, "s1");
  assert.equal(b0.reason, "mcp_not_connection_ready");
  assert.match(b0.message ?? "", /no status record available/);
});

test("capability using MCP with resolved status is blocked with mcp_not_connection_ready", () => {
  const sensors = makeSensors("gh");
  const deps = [makeDep("gh")];
  const statuses = [makeStatus("gh", "resolved", "Server found but no URL")];

  const result = validateCapabilities({ sensors, controllers: [] }, deps, statuses);
  assert.equal(result.blocked.length, 1);
  const b0 = result.blocked[0];
  assert.ok(b0);
  assert.equal(b0.reason, "mcp_not_connection_ready");
  assert.equal(b0.mcpStatus, "resolved");
  assert.equal(b0.message, "Server found but no URL");
});

test("capability using MCP with action_required status is blocked with mcp_action_required", () => {
  const sensors = makeSensors("gh");
  const deps = [makeDep("gh")];
  const statuses = [makeStatus("gh", "action_required", "Auth needed")];

  const result = validateCapabilities({ sensors, controllers: [] }, deps, statuses);
  assert.equal(result.blocked.length, 1);
  const b0 = result.blocked[0];
  assert.ok(b0);
  assert.equal(b0.reason, "mcp_action_required");
  assert.equal(b0.mcpStatus, "action_required");
  assert.equal(b0.message, "Auth needed");
});

test("capability using MCP with resolution_failed status is blocked with mcp_resolution_failed", () => {
  const sensors = makeSensors("gh");
  const deps = [makeDep("gh")];
  const statuses = [makeStatus("gh", "resolution_failed", "Not found")];

  const result = validateCapabilities({ sensors, controllers: [] }, deps, statuses);
  assert.equal(result.blocked.length, 1);
  const b0 = result.blocked[0];
  assert.ok(b0);
  assert.equal(b0.reason, "mcp_resolution_failed");
  assert.equal(b0.mcpStatus, "resolution_failed");
  assert.equal(b0.message, "Not found");
});

test("capability using MCP with error status is blocked with mcp_error", () => {
  const sensors = makeSensors("gh");
  const deps = [makeDep("gh")];
  const statuses = [makeStatus("gh", "error", "Network error")];

  const result = validateCapabilities({ sensors, controllers: [] }, deps, statuses);
  assert.equal(result.blocked.length, 1);
  const b0 = result.blocked[0];
  assert.ok(b0);
  assert.equal(b0.reason, "mcp_error");
  assert.equal(b0.mcpStatus, "error");
  assert.equal(b0.message, "Network error");
});

test("sensor entries have kind sensor", () => {
  const sensors = makeSensors("gh");
  const deps = [makeDep("gh")];
  const statuses = [makeStatus("gh", "ready")];

  const result = validateCapabilities({ sensors, controllers: [] }, deps, statuses);
  const v0 = result.valid[0];
  assert.ok(v0);
  assert.equal(v0.kind, "sensor");
});

test("controller entries have kind controller", () => {
  const controllers = makeControllers("gh");
  const deps = [makeDep("gh")];
  const statuses = [makeStatus("gh", "ready")];

  const result = validateCapabilities({ sensors: [], controllers }, deps, statuses);
  const v0 = result.valid[0];
  assert.ok(v0);
  assert.equal(v0.kind, "controller");
});

test("blocked capability includes message from status record", () => {
  const sensors = makeSensors("gh");
  const deps = [makeDep("gh")];
  const statuses = [makeStatus("gh", "error", "some error")];

  const result = validateCapabilities({ sensors, controllers: [] }, deps, statuses);
  const b0 = result.blocked[0];
  assert.ok(b0);
  assert.equal(b0.message, "some error");
});

test("validateCapabilities does not expose sensitive mcpUrl from status record", () => {
  const sensors = makeSensors("gh");
  const deps = [makeDep("gh")];
  // Construct a status record that includes sensitive connection info via cast
  const statusWithSensitiveData = {
    ...makeStatus("gh", "ready"),
    connection: {
      transport: "stdio",
      mcpUrl: "https://secret-token@mcp.example.com",
    },
  } as McpStatusRecord;

  const result = validateCapabilities(
    { sensors, controllers: [] },
    deps,
    [statusWithSensitiveData]
  );

  // Verify it's valid but does not leak mcpUrl
  assert.equal(result.valid.length, 1);
  const v0 = result.valid[0] as any;
  assert.equal(v0.uses, "gh");
  assert.equal(v0.mcpStatus, "ready");
  assert.equal(v0.connection?.mcpUrl, undefined, "mcpUrl should not be leaked in valid results");

  // Also verify for blocked results
  const sensorsBlocked = makeSensors("gh-error");
  const depsBlocked = [makeDep("gh-error")];
  const statusBlockedWithSensitiveData = {
    ...makeStatus("gh-error", "error", "some error"),
    connection: {
      transport: "stdio",
      mcpUrl: "https://secret-token@mcp.example.com",
    },
  } as McpStatusRecord;

  const resultBlocked = validateCapabilities(
    { sensors: sensorsBlocked, controllers: [] },
    depsBlocked,
    [statusBlockedWithSensitiveData]
  );
  assert.equal(resultBlocked.blocked.length, 1);
  const b0 = resultBlocked.blocked[0] as any;
  assert.equal(b0.connection?.mcpUrl, undefined, "mcpUrl should not be leaked in blocked results");
});

test("mixed results: some valid, some blocked", () => {
  const sensors: BackburnerSensorCapability[] = [
    { name: "s1", uses: "mcp-a", observes: "issues-and-prs" },
    { name: "s2", uses: "mcp-c", observes: "package-docs" },
  ];
  const controllers: BackburnerControllerCapability[] = [
    {
      name: "c1",
      uses: "mcp-b",
      grants: ["comment-on-prs"],
      approval: "required",
    },
  ];
  const deps = [makeDep("mcp-a"), makeDep("mcp-b")]; // mcp-c is missing from deps
  const statuses = [
    makeStatus("mcp-a", "ready"),
    makeStatus("mcp-b", "error", "some error"),
  ];

  const result = validateCapabilities({ sensors, controllers }, deps, statuses);

  assert.equal(result.valid.length, 1);
  const v0 = result.valid[0];
  assert.ok(v0);
  assert.equal(v0.name, "s1");

  assert.equal(result.blocked.length, 2);
  assert.ok(result.blocked.some((b) => b.name === "s2" && b.reason === "missing_mcp_handle"));
  assert.ok(result.blocked.some((b) => b.name === "c1" && b.reason === "mcp_error"));
});
