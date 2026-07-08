import * as assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reconcileMcpStatus } from "../src/mcps/reconcile.js";
import { StateStore } from "../src/state/loader.js";
import type { ResolvedMcp } from "../src/mcps/types.js";
import type { McpStatusRecord } from "../src/state/types.js";
import type { McpDependency } from "../src/config/types.js";

test("reconcileMcpStatus: creates new record for first-seen handle with connection metadata", () => {
  const previous: McpStatusRecord[] = [];
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const results: ResolvedMcp[] = [
    {
      handle: "gh",
      provider: "smithery",
      providerMcpId: "github",
      status: "ready",
      connection: { 
        localConnectionIdentity: "aog-gh-123",
        providerConnectionId: "p-123",
        namespace: "ns",
        transport: "http", 
        mcpUrl: "https://mcp.example.com",
        readiness: "connected"
      },
    },
  ];
  const now = "2026-06-08T10:00:00Z";

  const { records, added, updated, unchanged, removed } = reconcileMcpStatus(
    deps,
    previous,
    results,
    now
  );

  assert.deepEqual(added, ["gh"]);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0]!.handle, "gh");
  assert.strictEqual(records[0]!.status, "ready");
  assert.strictEqual(records[0]!.connection?.localConnectionIdentity, "aog-gh-123");
  assert.strictEqual(records[0]!.connection?.providerConnectionId, "p-123");
  assert.strictEqual(records[0]!.connection?.namespace, "ns");
  assert.strictEqual(records[0]!.connection?.transport, "http");
  assert.strictEqual(records[0]!.connection?.readinessProof, "connected");
  assert.strictEqual(records[0]!.connection?.readinessCheckedAt, now);
  assert.strictEqual((records[0]!.connection as any)?.mcpUrl, undefined);
  assert.strictEqual(records[0]!.lastCheckedAt, now);
});

test("reconcileMcpStatus: updates record when connection identity changes", () => {
  const previous: McpStatusRecord[] = [
    {
      handle: "gh",
      providerId: "smithery",
      providerMcpId: "github",
      status: "ready",
      lastCheckedAt: "2026-06-08T09:00:00Z",
      connection: {
        localConnectionIdentity: "aog-gh-123",
        providerConnectionId: "p-123",
        readinessProof: "connected"
      }
    },
  ];
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const results: ResolvedMcp[] = [
    {
      handle: "gh",
      provider: "smithery",
      providerMcpId: "github",
      status: "ready",
      connection: { 
        localConnectionIdentity: "aog-gh-123",
        providerConnectionId: "p-456", // changed
        readiness: "connected"
      },
    },
  ];
  const now = "2026-06-08T10:00:00Z";

  const { records, added, updated, unchanged, removed } = reconcileMcpStatus(
    deps,
    previous,
    results,
    now
  );

  assert.deepEqual(updated, ["gh"]);
  assert.strictEqual(records[0]!.connection?.providerConnectionId, "p-456");
});

test("reconcileMcpStatus: unchanged connection is detected as unchanged", () => {
  const previous: McpStatusRecord[] = [
    {
      handle: "gh",
      providerId: "smithery",
      providerMcpId: "github",
      status: "ready",
      lastCheckedAt: "2026-06-08T09:00:00Z",
      connection: {
        localConnectionIdentity: "aog-gh-123",
        providerConnectionId: "p-123",
        readinessProof: "connected"
      }
    },
  ];
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const results: ResolvedMcp[] = [
    {
      handle: "gh",
      provider: "smithery",
      providerMcpId: "github",
      status: "ready",
      connection: { 
        localConnectionIdentity: "aog-gh-123",
        providerConnectionId: "p-123",
        readiness: "connected"
      },
    },
  ];
  const now = "2026-06-08T10:00:00Z";

  const { records, added, updated, unchanged, removed } = reconcileMcpStatus(
    deps,
    previous,
    results,
    now
  );

  assert.deepEqual(unchanged, ["gh"]);
  assert.strictEqual(records[0]!.lastCheckedAt, now);
});

test("reconcileMcpStatus: does not persist secrets or credentials", () => {
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const results: ResolvedMcp[] = [
    {
      handle: "gh",
      provider: "smithery",
      providerMcpId: "github",
      status: "ready",
      connection: {
        transport: "http",
        mcpUrl: "https://mcp.example.com/SECRET_TOKEN",
        localConnectionIdentity: "safe-id",
        readiness: "connected"
      },
      actionRequired: {
        reason: "auth_required",
        url: "https://auth.example.com/secret-token",
      },
    },
  ];
  const now = "2026-06-08T10:00:00Z";

  const { records } = reconcileMcpStatus(deps, [], results, now);

  assert.strictEqual(records[0]!.connection?.transport, "http");
  assert.strictEqual((records[0]!.connection as any)?.mcpUrl, undefined);
  assert.strictEqual((records[0]!.actionRequired as any).url, undefined);
});

test("reconcileMcpStatus: removes stale connection proof when status changes to action_required", () => {
  const previous: McpStatusRecord[] = [
    {
      handle: "gh",
      providerId: "smithery",
      providerMcpId: "github",
      status: "ready",
      lastCheckedAt: "2026-06-08T09:00:00Z",
      connection: {
        localConnectionIdentity: "aog-gh-123",
        providerConnectionId: "p-123",
        readinessProof: "connected",
        readinessCheckedAt: "2026-06-08T09:00:00Z"
      }
    },
  ];
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const results: ResolvedMcp[] = [
    {
      handle: "gh",
      provider: "smithery",
      providerMcpId: "github",
      status: "action_required",
      actionRequired: { reason: "auth_required", message: "Needs auth" }
    },
  ];
  const now = "2026-06-08T10:00:00Z";

  const { records } = reconcileMcpStatus(deps, previous, results, now);

  assert.strictEqual(records[0]!.status, "action_required");
  assert.strictEqual(records[0]!.connection, undefined);
  assert.strictEqual(records[0]!.actionRequired?.reason, "auth_required");
});

test("reconcileMcpStatus: removes stale connection proof when status changes to resolved (disconnected)", () => {
  const previous: McpStatusRecord[] = [
    {
      handle: "gh",
      providerId: "smithery",
      providerMcpId: "github",
      status: "ready",
      lastCheckedAt: "2026-06-08T09:00:00Z",
      connection: {
        localConnectionIdentity: "aog-gh-123",
        providerConnectionId: "p-123",
        readinessProof: "connected"
      }
    },
  ];
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const results: ResolvedMcp[] = [
    {
      handle: "gh",
      provider: "smithery",
      providerMcpId: "github",
      status: "resolved",
      connection: {
        localConnectionIdentity: "aog-gh-123",
        providerConnectionId: "p-123",
        readiness: "disconnected"
      }
    },
  ];
  const now = "2026-06-08T10:00:00Z";

  const { records } = reconcileMcpStatus(deps, previous, results, now);

  assert.strictEqual(records[0]!.status, "resolved");
  assert.strictEqual(records[0]!.connection?.readinessProof, undefined);
});

test("reconcileMcpStatus: never persists ready proof for non-ready statuses", () => {
  const deps: McpDependency[] = [
    { handle: "action", smitheryId: "action-server" },
    { handle: "resolved", smitheryId: "resolved-server" },
    { handle: "missing", smitheryId: "missing-server" },
    { handle: "error", smitheryId: "error-server" },
  ];
  const results: ResolvedMcp[] = [
    {
      handle: "action",
      provider: "smithery",
      providerMcpId: "action-server",
      status: "action_required",
      connection: {
        localConnectionIdentity: "action-id",
        readiness: "connected",
      },
      actionRequired: { reason: "auth_required" },
    },
    {
      handle: "resolved",
      provider: "smithery",
      providerMcpId: "resolved-server",
      status: "resolved",
      connection: {
        localConnectionIdentity: "resolved-id",
        readiness: "connected",
      },
    },
    {
      handle: "missing",
      provider: "smithery",
      providerMcpId: "missing-server",
      status: "resolution_failed",
      connection: {
        localConnectionIdentity: "missing-id",
        readiness: "connected",
      },
    },
    {
      handle: "error",
      provider: "smithery",
      providerMcpId: "error-server",
      status: "error",
      connection: {
        localConnectionIdentity: "error-id",
        readiness: "connected",
      },
    },
  ];

  const { records } = reconcileMcpStatus(deps, [], results, "2026-06-08T10:00:00Z");

  assert.strictEqual(records.length, 4);
  for (const record of records) {
    assert.notStrictEqual(record.status, "ready");
    assert.strictEqual(record.connection?.readinessProof, undefined);
    assert.strictEqual(record.connection?.readinessCheckedAt, undefined);
  }
});


test("StateStore: writeMcpStatusState persists and load() returns mcpStatuses", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aog-state-store-mcp-"));
  try {
    const store = new StateStore(tempDir);
    const records: McpStatusRecord[] = [
      {
        handle: "zzz",
        providerId: "smithery",
        providerMcpId: "z",
        status: "ready",
        lastCheckedAt: "2026-06-08T10:00:00Z",
        connection: {
          localConnectionIdentity: "z-id",
          readinessProof: "connected"
        }
      },
    ];

    await store.writeMcpStatusState(records);

    const loadedState = await store.load();
    assert.ok(loadedState.mcpStatuses);
    assert.strictEqual(loadedState.mcpStatuses.length, 1);
    assert.strictEqual(loadedState.mcpStatuses[0]!.connection?.localConnectionIdentity, "z-id");
    assert.strictEqual(loadedState.mcpStatuses[0]!.connection?.readinessProof, "connected");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
