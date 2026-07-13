import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SmitheryMcpResolver, deriveSmitheryConnectionId } from "../src/mcps/smithery.js";
import type { SmitheryClient, SmitheryServerLookupResult, SmitheryConnectionResult } from "../src/mcps/smithery.js";
import type { McpDependency } from "../src/config/types.js";
import type { McpStatusRecord } from "../src/state/types.js";

class FakeSmitheryClient implements SmitheryClient {
  public serverResponses: Record<string, SmitheryServerLookupResult> = {};
  public connectionResponses: Record<string, SmitheryConnectionResult> = {};
  public serverCalls: string[] = [];
  public connectionCalls: string[] = [];
  public createCalls: Array<{ namespace: string, connectionId: string, smitheryId: string, handle: string, transport?: string, mcpUrl?: string }> = [];

  async getServerByExactId(smitheryId: string): Promise<SmitheryServerLookupResult> {
    this.serverCalls.push(smitheryId);
    const response = this.serverResponses[smitheryId];
    if (!response) return { status: "not_found" };
    if (response.status === "found" && !Object.hasOwn(response, "connection")) {
      return {
        ...response,
        connection: {
          transport: "http",
          mcpUrl: `https://example.test/${smitheryId}`,
          readiness: "unknown",
        },
      };
    }
    return response;
  }

  async getConnection(namespace: string, connectionId: string): Promise<SmitheryConnectionResult> {
    this.connectionCalls.push(`${namespace}/${connectionId}`);
    return this.connectionResponses[`${namespace}/${connectionId}`] || { status: "not_found" };
  }

  async createOrUpdateConnection(input: {
    namespace: string;
    connectionId: string;
    smitheryId: string;
    handle: string;
    transport?: string;
    mcpUrl?: string;
  }): Promise<SmitheryConnectionResult> {
    this.createCalls.push(input);
    const override = this.connectionResponses[`${input.namespace}/${input.connectionId}`];
    return override ?? {
      status: "connected",
      connectionId: input.connectionId,
      namespace: input.namespace,
      transport: input.transport || "http",
      metadata: {
        backburner: "backburner",
        backburnerHandle: input.handle,
        providerMcpId: input.smitheryId,
        localConnectionIdentity: input.connectionId,
      },
    };
  }
}

test("deriveSmitheryConnectionId: produces deterministic stable ID", () => {
  const id1 = deriveSmitheryConnectionId("gh", "github");
  const id2 = deriveSmitheryConnectionId("gh", "github");
  assert.strictEqual(id1, id2);
  assert.ok(id1.startsWith("backburner-gh-"));
  assert.strictEqual(id1.length, 22); // backburner-gh-<8-char-hash> -> 4 + 2 + 1 + 8 = 15
});

test("SmitheryMcpResolver: creates a new connection and becomes ready", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };
  
  const namespace = "my-namespace";
  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];

  const connectionId = deriveSmitheryConnectionId("gh", "github");
  // Do NOT pre-configure connectionResponses, so getConnection returns not_found

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results.length, 1);
  const r0 = results[0]!;
  assert.strictEqual(r0.status, "ready");
  assert.strictEqual(r0.connection?.localConnectionIdentity, connectionId);
  assert.strictEqual(r0.connection?.readiness, "connected");
  assert.strictEqual(client.createCalls.length, 1);
  assert.strictEqual(client.createCalls[0]!.connectionId, connectionId);
});

test("SmitheryMcpResolver: records runtime namespace when provider omits it", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };

  const namespace = "my-namespace";
  const connectionId = deriveSmitheryConnectionId("gh", "github");
  client.connectionResponses[`${namespace}/${connectionId}`] = {
    status: "connected",
    connectionId,
    transport: "http",
    metadata: {
      backburner: "backburner",
      backburnerHandle: "gh",
      providerMcpId: "github",
      localConnectionIdentity: connectionId,
    },
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const results = await resolver.resolveDependencies([{ handle: "gh", smitheryId: "github" }]);

  assert.strictEqual(results[0]!.status, "ready");
  assert.strictEqual(results[0]!.connection?.namespace, namespace);
});

test("SmitheryMcpResolver: threads transport and mcpUrl from lookup", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown"
    }
  };
  
  const namespace = "my-namespace";
  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];

  await resolver.resolveDependencies(deps);

  assert.strictEqual(client.createCalls.length, 1);
  assert.strictEqual(client.createCalls[0]!.transport, "http");
  assert.strictEqual(client.createCalls[0]!.mcpUrl, "https://mcp.github.com");
});

test("SmitheryMcpResolver: reuses existing connection if available", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };
  
  const namespace = "my-namespace";
  const connectionId = "existing-id";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");
  
  client.connectionResponses[`${namespace}/${connectionId}`] = {
    status: "connected",
    connectionId,
    namespace,
    transport: "http",
    metadata: {
      backburner: "backburner",
      backburnerHandle: "gh",
      providerMcpId: "github",
      localConnectionIdentity: localIdentity,
    },
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const previous: McpStatusRecord[] = [{
    handle: "gh",
    providerId: "smithery",
    providerMcpId: "github",
    status: "ready",
    lastCheckedAt: "2024-01-01T00:00:00Z",
    connection: {
      localConnectionIdentity: localIdentity,
      providerConnectionId: connectionId,
      namespace
    }
  }];

  const results = await resolver.resolveDependencies(deps, previous);

  assert.strictEqual(results[0]!.status, "ready");
  assert.strictEqual(results[0]!.connection?.providerConnectionId, connectionId);
  assert.strictEqual(client.connectionCalls.length, 1);
  assert.strictEqual(client.connectionCalls[0], `${namespace}/${connectionId}`);
  assert.strictEqual(client.createCalls.length, 0); // No create call needed
});

test("SmitheryMcpResolver: rejects connection owned by different Backburner handle", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };

  const namespace = "my-namespace";
  const foreignConnectionId = "foreign-conn";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");

  // Persisted connection ID from a different handle
  client.connectionResponses[`${namespace}/${foreignConnectionId}`] = {
    status: "connected",
    connectionId: foreignConnectionId,
    namespace,
    metadata: {
      backburner: "backburner",
      backburnerHandle: "different-handle",   // <-- mismatch
      providerMcpId: "github",
      localConnectionIdentity: foreignConnectionId,
    },
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const previous: McpStatusRecord[] = [{
    handle: "gh",
    providerId: "smithery",
    providerMcpId: "github",
    status: "ready",
    lastCheckedAt: "2024-01-01T00:00:00Z",
    connection: {
      localConnectionIdentity: localIdentity,
      providerConnectionId: foreignConnectionId,
      namespace,
    },
  }];

  const results = await resolver.resolveDependencies(deps, previous);

  // Ownership check fails → resolver must create with localIdentity
  assert.strictEqual(results[0]!.status, "ready");
  assert.deepStrictEqual(client.connectionCalls, [
    `${namespace}/${foreignConnectionId}`,
    `${namespace}/${localIdentity}`,
  ]);
  assert.strictEqual(client.createCalls.length, 1);
  assert.strictEqual(client.createCalls[0]!.connectionId, localIdentity);
  assert.strictEqual(client.createCalls[0]!.handle, "gh");
});

test("SmitheryMcpResolver: reuses owned local identity after unowned persisted providerConnectionId", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };

  const namespace = "my-namespace";
  const foreignConnectionId = "foreign-conn";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");

  client.connectionResponses[`${namespace}/${foreignConnectionId}`] = {
    status: "connected",
    connectionId: foreignConnectionId,
    namespace,
    metadata: {
      backburner: "backburner",
      backburnerHandle: "different-handle",
      providerMcpId: "github",
      localConnectionIdentity: foreignConnectionId,
    },
  };
  client.connectionResponses[`${namespace}/${localIdentity}`] = {
    status: "connected",
    connectionId: localIdentity,
    namespace,
    transport: "http",
    metadata: {
      backburner: "backburner",
      backburnerHandle: "gh",
      providerMcpId: "github",
      localConnectionIdentity: localIdentity,
    },
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const previous: McpStatusRecord[] = [{
    handle: "gh",
    providerId: "smithery",
    providerMcpId: "github",
    status: "ready",
    lastCheckedAt: "2024-01-01T00:00:00Z",
    connection: {
      localConnectionIdentity: localIdentity,
      providerConnectionId: foreignConnectionId,
      namespace,
    },
  }];

  const results = await resolver.resolveDependencies(deps, previous);

  assert.strictEqual(results[0]!.status, "ready");
  assert.strictEqual(results[0]!.connection?.providerConnectionId, localIdentity);
  assert.deepStrictEqual(client.connectionCalls, [
    `${namespace}/${foreignConnectionId}`,
    `${namespace}/${localIdentity}`,
  ]);
  assert.strictEqual(client.createCalls.length, 0);
});

test("SmitheryMcpResolver: rejects connection owned by different Smithery id", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };

  const namespace = "my-namespace";
  const foreignConnectionId = "foreign-conn";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");

  client.connectionResponses[`${namespace}/${foreignConnectionId}`] = {
    status: "connected",
    connectionId: foreignConnectionId,
    namespace,
    metadata: {
      backburner: "backburner",
      backburnerHandle: "gh",
      providerMcpId: "gitlab",   // <-- mismatch
      localConnectionIdentity: foreignConnectionId,
    },
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const previous: McpStatusRecord[] = [{
    handle: "gh",
    providerId: "smithery",
    providerMcpId: "github",
    status: "ready",
    lastCheckedAt: "2024-01-01T00:00:00Z",
    connection: {
      localConnectionIdentity: localIdentity,
      providerConnectionId: foreignConnectionId,
      namespace,
    },
  }];

  const results = await resolver.resolveDependencies(deps, previous);

  assert.strictEqual(results[0]!.status, "ready");
  assert.deepStrictEqual(client.connectionCalls, [
    `${namespace}/${foreignConnectionId}`,
    `${namespace}/${localIdentity}`,
  ]);
  assert.strictEqual(client.createCalls.length, 1);
  assert.strictEqual(client.createCalls[0]!.connectionId, localIdentity);
  assert.strictEqual(client.createCalls[0]!.smitheryId, "github");
});

test("SmitheryMcpResolver: rejects connection owned by different local connection identity", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };

  const namespace = "my-namespace";
  const foreignConnectionId = "foreign-conn";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");

  client.connectionResponses[`${namespace}/${foreignConnectionId}`] = {
    status: "connected",
    connectionId: foreignConnectionId,
    namespace,
    metadata: {
      backburner: "backburner",
      backburnerHandle: "gh",
      providerMcpId: "github",
      localConnectionIdentity: "different-identity", // <-- mismatch
    },
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const previous: McpStatusRecord[] = [{
    handle: "gh",
    providerId: "smithery",
    providerMcpId: "github",
    status: "ready",
    lastCheckedAt: "2024-01-01T00:00:00Z",
    connection: {
      localConnectionIdentity: localIdentity,
      providerConnectionId: foreignConnectionId,
      namespace,
    },
  }];

  const results = await resolver.resolveDependencies(deps, previous);

  assert.strictEqual(results[0]!.status, "ready");
  assert.deepStrictEqual(client.connectionCalls, [
    `${namespace}/${foreignConnectionId}`,
    `${namespace}/${localIdentity}`,
  ]);
  assert.strictEqual(client.createCalls.length, 1);
  assert.strictEqual(client.createCalls[0]!.connectionId, localIdentity);
});

test("SmitheryMcpResolver: unknown id returns resolution_failed", async () => {
  const client = new FakeSmitheryClient();
  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace: "ns" });
  const deps: McpDependency[] = [{ handle: "unknown", smitheryId: "missing-mcp" }];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results[0]!.status, "resolution_failed");
  assert.match(results[0]!.message || "", /not found/i);
});

test("SmitheryMcpResolver: connection requires user action", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["auth-needed"] = {
    status: "found",
    server: { name: "Auth Needed" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.auth-needed.com",
      readiness: "unknown",
    },
  };
  
  const namespace = "ns";
  const connectionId = deriveSmitheryConnectionId("auth", "auth-needed");
  client.connectionResponses[`${namespace}/${connectionId}`] = {
    status: "auth_required",
    connectionId,
    namespace,
    setupUrl: "https://smithery.ai/auth"
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "auth", smitheryId: "auth-needed" }];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results[0]!.status, "action_required");
  assert.strictEqual(results[0]!.actionRequired?.reason, "auth_required");
  assert.strictEqual(results[0]!.actionRequired?.url, "https://smithery.ai/auth");
});

test("SmitheryMcpResolver: input_required maps to action_required", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["input-needed"] = {
    status: "found",
    server: { name: "Input Needed" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.input-needed.com",
      readiness: "unknown",
    },
  };

  const namespace = "ns";
  const connectionId = deriveSmitheryConnectionId("input", "input-needed");
  client.connectionResponses[`${namespace}/${connectionId}`] = {
    status: "input_required",
    connectionId,
    namespace,
    fields: ["token"],
    message: "More information is required",
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "input", smitheryId: "input-needed" }];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results[0]!.status, "action_required");
  assert.strictEqual(results[0]!.actionRequired?.reason, "input_required");
  assert.strictEqual(results[0]!.actionRequired?.message, "More information is required");
  assert.deepStrictEqual(results[0]!.actionRequired?.fields, ["token"]);
});

test("SmitheryMcpResolver: missing Smithery runtime configuration", async () => {
  const client = new FakeSmitheryClient();
  const resolver = new SmitheryMcpResolver(client, {}); // No API key
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results[0]!.status, "error");
  assert.match(results[0]!.message || "", /Missing Smithery API key/i);
});

test("SmitheryMcpResolver: missing Smithery namespace", async () => {
  const client = new FakeSmitheryClient();
  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key" }); // No namespace
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results[0]!.status, "error");
  assert.match(results[0]!.message || "", /Missing Smithery namespace/i);
});

function createFakeOfficialSmitherySdk() {
  const calls = {
    serversGet: [] as string[],
    connectionsGet: [] as Array<{ connectionId: string; namespace: string }>,
    connectionsSet: [] as Array<{
      connectionId: string;
      params: {
        namespace: string;
        server: string;
        name: string;
        transport?: string;
        mcpUrl?: string;
        metadata?: Record<string, unknown>;
        headers?: Record<string, string>;
        mock?: boolean | { enabled: boolean; scenario?: string };
      };
    }>,
  };

  const serverResponses: Record<string, any> = {};
  const connectionResponses: Record<string, any> = {};

  const client = {
    servers: {
      async get(smitheryId: string) {
        calls.serversGet.push(smitheryId);
        const response = serverResponses[smitheryId];
        if (response === undefined) {
          throw { status: 404, message: `Smithery server "${smitheryId}" not found.` };
        }
        return response;
      },
    },
    connections: {
      async get(connectionId: string, params: { namespace: string }) {
        calls.connectionsGet.push({ connectionId, namespace: params.namespace });
        const response = connectionResponses[`${params.namespace}/${connectionId}`];
        if (response === undefined) {
          throw { status: 404, message: `Connection "${connectionId}" not found in namespace "${params.namespace}".` };
        }
        if (response instanceof Error) {
          throw response;
        }
        if (typeof response === "object" && response !== null && "throw" in response) {
          throw (response as { throw: unknown }).throw;
        }
        return response;
      },
      async set(
        connectionId: string,
        params: {
          namespace: string;
          server: string;
          name: string;
          transport?: string;
          mcpUrl?: string;
          metadata?: Record<string, unknown>;
          headers?: Record<string, string>;
          mock?: boolean | { enabled: boolean; scenario?: string };
        }
      ) {
        calls.connectionsSet.push({ connectionId, params });
        const response = connectionResponses[`${params.namespace}/${connectionId}`];
        if (response !== undefined) {
          if (response instanceof Error) {
            throw response;
          }
          if (typeof response === "object" && response !== null && "throw" in response) {
            throw (response as { throw: unknown }).throw;
          }
          return response;
        }
        return {
          connectionId,
          namespace: params.namespace,
          transport: params.transport ?? "http",
          mcpUrl: params.mcpUrl ?? null,
          metadata: params.metadata ?? null,
          status: { state: "connected" },
        };
      },
    },
  };

  return { client, calls, serverResponses, connectionResponses };
}

test("SmitherySdkClient: getServerByExactId maps 200 to found", async () => {
  const fakeSdk = createFakeOfficialSmitherySdk();
  fakeSdk.serverResponses.github = {
    qualifiedName: "github",
    displayName: "GitHub",
    tools: [{ name: "t1" }],
    connections: [{ type: "http", bundleUrl: "https://mcp" }],
  };

  const { SmitherySdkClient } = await import("../src/mcps/smithery-client.js");
  const client = new SmitherySdkClient({ apiKey: "k", namespace: "ns" }, fakeSdk.client as any);

  const result = await client.getServerByExactId("github");
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.server?.name, "GitHub");
  assert.strictEqual(result.connection?.transport, "http");
  assert.strictEqual(result.connection?.mcpUrl, "https://mcp");
  assert.strictEqual(result.connection?.readiness, "unknown");
  assert.deepStrictEqual(fakeSdk.calls.serversGet, ["github"]);
});

test("SmitherySdkClient: getServerByExactId ignores stdio connections", async () => {
  const fakeSdk = createFakeOfficialSmitherySdk();
  fakeSdk.serverResponses["stdio-server"] = {
    qualifiedName: "stdio-server",
    displayName: "Stdio Server",
    connections: [{ type: "stdio", bundleUrl: "https://bundle" }],
  };

  const { SmitherySdkClient } = await import("../src/mcps/smithery-client.js");
  const client = new SmitherySdkClient({ apiKey: "k", namespace: "ns" }, fakeSdk.client as any);

  const result = await client.getServerByExactId("stdio-server");
  assert.strictEqual(result.status, "found");
  assert.strictEqual(result.connection, undefined);
  assert.deepStrictEqual(fakeSdk.calls.serversGet, ["stdio-server"]);
});

test("SmitheryMcpResolver: found server without usable hosted connection resolves without create", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["stdio-server"] = {
    status: "found",
    server: { name: "Stdio Server" },
    connection: undefined,
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace: "ns" });
  const deps: McpDependency[] = [{ handle: "stdio", smitheryId: "stdio-server" }];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results[0]!.status, "resolved");
  assert.match(results[0]!.message || "", /no usable hosted HTTP connection/i);
  assert.strictEqual(results[0]!.connection, undefined);
  assert.strictEqual(client.connectionCalls.length, 0);
  assert.strictEqual(client.createCalls.length, 0);
});

test("SmitherySdkClient: getConnection maps 200 to connected", async () => {
  const fakeSdk = createFakeOfficialSmitherySdk();
  fakeSdk.connectionResponses["ns/conn1"] = {
    connectionId: "conn1",
    namespace: "ns",
    transport: "http",
    name: "gh",
    status: { state: "connected" },
  };
  const { SmitherySdkClient } = await import("../src/mcps/smithery-client.js");
  const client = new SmitherySdkClient({ apiKey: "k", namespace: "ns" }, fakeSdk.client as any);

  const result = await client.getConnection("ns", "conn1");
  assert.strictEqual(result.status, "connected");
  assert.strictEqual(result.connectionId, "conn1");
  assert.deepStrictEqual(fakeSdk.calls.connectionsGet, [{ connectionId: "conn1", namespace: "ns" }]);
});

test("SmitherySdkClient: createOrUpdateConnection sends correct body and maps to connected", async () => {
  const fakeSdk = createFakeOfficialSmitherySdk();
  fakeSdk.connectionResponses["ns/conn1"] = {
    connectionId: "conn1",
    namespace: "ns",
    transport: "http",
    name: "gh",
    status: { state: "connected" },
  };
  const { SmitherySdkClient } = await import("../src/mcps/smithery-client.js");
  const client = new SmitherySdkClient({ apiKey: "k", namespace: "ns" }, fakeSdk.client as any);

  const result = await client.createOrUpdateConnection({
    namespace: "ns",
    connectionId: "conn1",
    smitheryId: "github",
    handle: "gh",
    transport: "http",
    mcpUrl: "https://mcp.github.com"
  });

  assert.strictEqual(result.status, "connected");
  assert.strictEqual(fakeSdk.calls.connectionsSet.length, 1);
  assert.deepStrictEqual(fakeSdk.calls.connectionsSet[0]!.params, {
    namespace: "ns",
    server: "github",
    name: "gh",
    transport: "http",
    metadata: {
      backburner: "backburner",
      backburnerHandle: "gh",
      providerMcpId: "github",
      localConnectionIdentity: "conn1",
    },
  });
});

test("SmitheryMcpResolver: handles stale providerConnectionId (not_found)", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };
  
  const namespace = "my-namespace";
  const staleId = "stale-id";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");
  
  // getConnection will return not_found for staleId
  
  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const previous: McpStatusRecord[] = [{
    handle: "gh",
    providerId: "smithery",
    providerMcpId: "github",
    status: "ready",
    lastCheckedAt: "2024-01-01T00:00:00Z",
    connection: {
      localConnectionIdentity: localIdentity,
      providerConnectionId: staleId,
      namespace
    }
  }];

  const results = await resolver.resolveDependencies(deps, previous);

  assert.strictEqual(results[0]!.status, "ready");
  assert.strictEqual(results[0]!.connection?.localConnectionIdentity, localIdentity);
  assert.strictEqual(results[0]!.connection?.providerConnectionId, localIdentity);
  assert.strictEqual(client.createCalls.length, 1);
  assert.strictEqual(client.createCalls[0]!.connectionId, localIdentity);
});

test("SmitheryMcpResolver: rejects connected create response without ownership metadata", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };

  const namespace = "my-namespace";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");
  client.connectionResponses[`${namespace}/${localIdentity}`] = {
    status: "connected",
    connectionId: localIdentity,
    namespace,
    transport: "http",
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results[0]!.status, "error");
  assert.match(results[0]!.message || "", /metadata does not match/i);
  assert.strictEqual(results[0]!.connection, undefined);
  assert.strictEqual(client.createCalls.length, 1);
  assert.strictEqual(client.createCalls[0]!.connectionId, localIdentity);
});

test("SmitheryMcpResolver: handles stale providerConnectionId (disconnected)", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };
  
  const namespace = "my-namespace";
  const staleId = "stale-id";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");
  
  client.connectionResponses[`${namespace}/${staleId}`] = {
    status: "disconnected",
    connectionId: staleId,
    namespace
  };
  
  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];
  const previous: McpStatusRecord[] = [{
    handle: "gh",
    providerId: "smithery",
    providerMcpId: "github",
    status: "ready",
    lastCheckedAt: "2024-01-01T00:00:00Z",
    connection: {
      localConnectionIdentity: localIdentity,
      providerConnectionId: staleId,
      namespace
    }
  }];

  const results = await resolver.resolveDependencies(deps, previous);

  assert.strictEqual(results[0]!.status, "ready");
  assert.strictEqual(client.createCalls.length, 1);
  assert.strictEqual(client.createCalls[0]!.connectionId, localIdentity);
});

test("SmitheryMcpResolver: handles multiple handles for same smitheryId", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };
  
  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace: "ns" });
  const deps: McpDependency[] = [
    { handle: "gh1", smitheryId: "github" },
    { handle: "gh2", smitheryId: "github" }
  ];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0]!.status, "ready");
  assert.strictEqual(results[1]!.status, "ready");
  
  const id1 = results[0]!.connection?.localConnectionIdentity;
  const id2 = results[1]!.connection?.localConnectionIdentity;
  assert.notStrictEqual(id1, id2);
  assert.strictEqual(client.createCalls.length, 2);
});

test("SmitheryMcpResolver: creation failure returns error", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };
  
  const namespace = "ns";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");
  client.connectionResponses[`${namespace}/${localIdentity}`] = {
    status: "error",
    message: "Failed to create"
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results[0]!.status, "error");
  assert.match(results[0]!.message || "", /Failed to create/i);
});

test("SmitheryMcpResolver: disconnected status maps to resolved", async () => {
  const client = new FakeSmitheryClient();
  client.serverResponses["github"] = {
    status: "found",
    server: { name: "GitHub" },
    connection: {
      transport: "http",
      mcpUrl: "https://mcp.github.com",
      readiness: "unknown",
    },
  };
  
  const namespace = "ns";
  const localIdentity = deriveSmitheryConnectionId("gh", "github");
  // Make createOrUpdateConnection return disconnected
  client.connectionResponses[`${namespace}/${localIdentity}`] = {
    status: "disconnected",
    connectionId: localIdentity,
    namespace
  };

  const resolver = new SmitheryMcpResolver(client, { apiKey: "test-key", namespace });
  const deps: McpDependency[] = [{ handle: "gh", smitheryId: "github" }];

  const results = await resolver.resolveDependencies(deps);

  assert.strictEqual(results[0]!.status, "resolved");
  assert.strictEqual(results[0]!.connection?.readiness, "disconnected");
});

test("SmitherySdkClient: getConnection maps 401/403 to error", async () => {
  const fakeSdk = createFakeOfficialSmitherySdk();
  fakeSdk.connectionResponses["ns/conn1"] = { throw: { status: 401, message: "Unauthorized" } };
  const { SmitherySdkClient } = await import("../src/mcps/smithery-client.js");
  const client = new SmitherySdkClient({ apiKey: "k", namespace: "ns" }, fakeSdk.client as any);

  const result = await client.getConnection("ns", "conn1");
  assert.strictEqual(result.status, "error");
  assert.match(result.message || "", /API key is missing, invalid, or unauthorized/i);
});

test("SmitherySdkClient: createOrUpdateConnection maps 401/403 to error", async () => {
  const fakeSdk = createFakeOfficialSmitherySdk();
  fakeSdk.connectionResponses["ns/conn1"] = { throw: { status: 403, message: "Forbidden" } };
  const { SmitherySdkClient } = await import("../src/mcps/smithery-client.js");
  const client = new SmitherySdkClient({ apiKey: "k", namespace: "ns" }, fakeSdk.client as any);

  const result = await client.createOrUpdateConnection({
    namespace: "ns",
    connectionId: "conn1",
    smitheryId: "github",
    handle: "gh"
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message || "", /API key is missing, invalid, or unauthorized/i);
});

test("SmitherySdkClient: createOrUpdateConnection includes localConnectionIdentity in metadata", async () => {
  const fakeSdk = createFakeOfficialSmitherySdk();
  fakeSdk.connectionResponses["ns/backburner-gh-abc12345"] = {
    connectionId: "backburner-gh-abc12345",
    namespace: "ns",
    transport: "http",
    status: { state: "connected" },
    metadata: {
      backburner: "backburner",
      backburnerHandle: "gh",
      providerMcpId: "github",
      localConnectionIdentity: "backburner-gh-abc12345",
    },
  };
  const { SmitherySdkClient } = await import("../src/mcps/smithery-client.js");
  const client = new SmitherySdkClient({ apiKey: "k", namespace: "ns" }, fakeSdk.client as any);

  const result = await client.createOrUpdateConnection({
    namespace: "ns",
    connectionId: "backburner-gh-abc12345",
    smitheryId: "github",
    handle: "gh",
    transport: "http",
    mcpUrl: "https://mcp.github.com",
  });

  assert.strictEqual(result.status, "connected");
  assert.strictEqual(fakeSdk.calls.connectionsSet[0]!.params.metadata?.localConnectionIdentity, "backburner-gh-abc12345");
  assert.strictEqual(fakeSdk.calls.connectionsSet[0]!.params.metadata?.backburnerHandle, "gh");
  assert.strictEqual(fakeSdk.calls.connectionsSet[0]!.params.metadata?.providerMcpId, "github");
});

test("SmitherySdkClient: getConnection extracts metadata from response", async () => {
  const fakeSdk = createFakeOfficialSmitherySdk();
  fakeSdk.connectionResponses["ns/conn1"] = {
    connectionId: "conn1",
    namespace: "ns",
    transport: "http",
    status: { state: "connected" },
    metadata: {
      backburner: "backburner",
      backburnerHandle: "gh",
      providerMcpId: "github",
      localConnectionIdentity: "conn1",
    },
  };
  const { SmitherySdkClient } = await import("../src/mcps/smithery-client.js");
  const client = new SmitherySdkClient({ apiKey: "k", namespace: "ns" }, fakeSdk.client as any);

  const result = await client.getConnection("ns", "conn1");

  assert.strictEqual(result.status, "connected");
  assert.strictEqual(result.metadata?.backburnerHandle, "gh");
  assert.strictEqual(result.metadata?.providerMcpId, "github");
  assert.strictEqual(result.metadata?.localConnectionIdentity, "conn1");
  assert.deepStrictEqual(fakeSdk.calls.connectionsGet, [{ connectionId: "conn1", namespace: "ns" }]);
});
