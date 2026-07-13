import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ComposedBrokerService } from "../src/github/composed.js";
import type { BrokerTool, BrokerToolCallResult } from "../src/github/types.js";
import {
  ReadyMcpBridgeService,
  createReadyMcpBridgeService,
  createReadyMcpBridgeServices,
  createSmitheryMcpBridgeServicesFromStatuses,
  projectReadyMcpBridge
} from "../src/mcps/index.js";
import type { McpStatusRecord } from "../src/state/types.js";

class FakeBridgedMcpClient {
  public readonly calls: Array<{ name: string; args: unknown }> = [];

  constructor(private readonly tools: BrokerTool[]) {}

  listTools(): BrokerTool[] {
    return [...this.tools];
  }

  async callTool(name: string, rawArguments: unknown): Promise<BrokerToolCallResult> {
    this.calls.push({ name, args: rawArguments });
    const tool = this.tools.find((entry) => entry.name === name);
    if (!tool) {
      return {
        ok: false,
        tool: name,
        error: { code: "tool_not_found", message: `Tool "${name}" not found` }
      };
    }

    return {
      ok: true,
      tool: name,
      result: { echoed: rawArguments, tool: name },
      summary: `Called ${name}`
    };
  }
}

function makeReadyStatus(handle: string): McpStatusRecord {
  return {
    handle,
    providerId: "smithery",
    providerMcpId: `${handle}-smithery`,
    status: "ready",
    lastCheckedAt: "2026-06-19T00:00:00Z",
    connection: {
      localConnectionIdentity: `backburner-${handle}`,
      providerConnectionId: `${handle}-connection`,
      namespace: "smithery-runtime",
      transport: "http",
      readinessProof: "connected",
      readinessCheckedAt: "2026-06-19T00:00:00Z"
    }
  };
}

test("ready MCP bridge registers tools under the MCP handle namespace", async () => {
  const client = new FakeBridgedMcpClient([
    {
      name: "search_docs",
      title: "Search docs",
      description: "Search documentation",
      inputSchema: {}
    },
    {
      name: "get_library_docs",
      title: "Get library docs",
      description: "Fetch docs for a library",
      inputSchema: {}
    }
  ]);

  const service = new ReadyMcpBridgeService("cloud7", client);
  await service.initialize();
  const composed = new ComposedBrokerService([service]);

  assert.deepEqual(
    composed.listTools().map((tool) => tool.name),
    ["cloud7.get_library_docs", "cloud7.search_docs"]
  );
});

test("ready MCP bridge routes calls through the fake client", async () => {
  const client = new FakeBridgedMcpClient([
    {
      name: "search_docs",
      title: "Search docs",
      description: "Search documentation",
      inputSchema: {}
    }
  ]);
  const service = new ReadyMcpBridgeService("cloud7", client);
  await service.initialize();
  const composed = new ComposedBrokerService([service]);

  const result = await composed.callTool("cloud7.search_docs", { query: "state machine" });

  assert.equal(result.ok, true);
  assert.deepEqual(client.calls, [{ name: "search_docs", args: { query: "state machine" } }]);
  if (result.ok) {
    assert.deepEqual(result.result, {
      echoed: { query: "state machine" },
      tool: "search_docs"
    });
    assert.equal(result.tool, "cloud7.search_docs");
  }
});

test("ready MCP bridge projection does not expose raw URLs or credentials", async () => {
  const client = new FakeBridgedMcpClient([
    {
      name: "search_docs",
      title: "Search docs",
      description: "Search documentation",
      inputSchema: {}
    }
  ]);
  const service = new ReadyMcpBridgeService("cloud7", client);
  await service.initialize();
  const status = {
    ...makeReadyStatus("cloud7"),
    connection: {
      ...makeReadyStatus("cloud7").connection,
      mcpUrl: "https://cloud7.example.invalid/mcp?token=secret",
      credentials: { apiKey: "secret" }
    }
  } as McpStatusRecord & {
    connection: {
      mcpUrl: string;
      credentials: { apiKey: string };
    };
  };

  const projection = projectReadyMcpBridge(service, status);

  assert.deepEqual(projection, {
    handle: "cloud7",
    tools: ["search_docs"]
  });
  assert.equal((projection as any).connection, undefined);
  assert.equal((projection as any).mcpUrl, undefined);
  assert.equal((projection as any).credentials, undefined);
});

test("createReadyMcpBridgeService returns undefined for non-ready status", () => {
  const client = new FakeBridgedMcpClient([]);
  const service = createReadyMcpBridgeService({
    status: {
      handle: "cloud7",
      providerId: "smithery",
      providerMcpId: "cloud7",
      status: "resolved",
      lastCheckedAt: "2026-06-19T00:00:00Z"
    },
    client
  });

  assert.equal(service, undefined);
});

test("createReadyMcpBridgeServices keeps only ready handles", () => {
  const services = createReadyMcpBridgeServices([
    {
      status: makeReadyStatus("cloud7"),
      client: new FakeBridgedMcpClient([])
    },
    {
      status: {
        handle: "other",
        providerId: "smithery",
        providerMcpId: "other",
        status: "action_required",
        lastCheckedAt: "2026-06-19T00:00:00Z"
      },
      client: new FakeBridgedMcpClient([])
    }
  ]);

  assert.equal(services.length, 1);
  assert.equal(services[0]?.namespace, "cloud7");
});

test("Smithery bridge services list and call tools through connection tools API", async () => {
  const calls: Array<{ toolPath: string; params: unknown }> = [];
  const fakeSmithery = {
    connections: {
      tools: {
        async list(connectionId: string, params: { namespace: string }) {
          assert.equal(connectionId, "cloud7-connection");
          assert.deepEqual(params, { namespace: "smithery-runtime" });
          return {
            tools: [
              {
                name: "search_docs",
                title: "Search docs",
                description: "Search documentation",
                inputSchema: { type: "object", properties: { query: { type: "string" } } }
              }
            ]
          };
        },
        async call(toolPath: string, params: unknown) {
          calls.push({ toolPath, params });
          return { content: [{ type: "text", text: "docs result" }] };
        }
      }
    }
  };

  const services = await createSmitheryMcpBridgeServicesFromStatuses(
    [makeReadyStatus("cloud7")],
    {},
    fakeSmithery as any,
    ["cloud7.search_docs"]
  );
  const composed = new ComposedBrokerService(services);

  assert.deepEqual(composed.listTools().map((tool) => tool.name), ["cloud7.search_docs"]);

  const result = await composed.callTool("cloud7.search_docs", { query: "react" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      toolPath: "search_docs",
      params: {
        namespace: "smithery-runtime",
        connectionId: "cloud7-connection",
        body: { query: "react" }
      }
    }
  ]);
});

test("Smithery bridge services respect allowed public tool names", async () => {
  const fakeSmithery = {
    connections: {
      tools: {
        async list() {
          return {
            tools: [
              { name: "search_docs", inputSchema: { type: "object" } },
              { name: "write_docs", inputSchema: { type: "object" } }
            ]
          };
        },
        async call() {
          return {};
        }
      }
    }
  };

  const services = await createSmitheryMcpBridgeServicesFromStatuses(
    [makeReadyStatus("cloud7")],
    {},
    fakeSmithery as any,
    ["cloud7.search_docs"]
  );
  const composed = new ComposedBrokerService(services);

  assert.deepEqual(composed.listTools().map((tool) => tool.name), ["cloud7.search_docs"]);
  const denied = await composed.callTool("cloud7.write_docs", {});
  assert.equal(denied.ok, false);
});

test("Smithery bridge services fall back to exact allowed tool schemas when list fails", async () => {
  const getCalls: string[] = [];
  const fakeSmithery = {
    connections: {
      tools: {
        async list() {
          throw new Error("Failed to fetch tool list");
        },
        async get(toolPath: string, params: { namespace: string; connectionId: string }) {
          getCalls.push(toolPath);
          assert.deepEqual(params, {
            namespace: "smithery-runtime",
            connectionId: "cloud7-connection"
          });
          if (toolPath !== "search_docs") {
            throw new Error("not found");
          }
          return {
            name: "search_docs",
            title: "Search docs",
            description: "Search documentation",
            inputSchema: { type: "object", properties: { query: { type: "string" } } }
          };
        },
        async call() {
          return {};
        }
      }
    }
  };

  const services = await createSmitheryMcpBridgeServicesFromStatuses(
    [makeReadyStatus("cloud7")],
    {},
    fakeSmithery as any,
    ["cloud7.search_docs", "cloud7.write_docs", "other.unrelated"]
  );
  const composed = new ComposedBrokerService(services);

  assert.deepEqual(getCalls, ["search_docs", "write_docs"]);
  assert.deepEqual(composed.listTools().map((tool) => tool.name), ["cloud7.search_docs"]);
});

test("Smithery bridge services do not expand namespace wildcard allow-list entries", async () => {
  const fakeSmithery = {
    connections: {
      tools: {
        async list() {
          return {
            tools: [
              { name: "search_docs", inputSchema: { type: "object" } },
              { name: "write_docs", inputSchema: { type: "object" } }
            ]
          };
        },
        async call() {
          return {};
        }
      }
    }
  };

  const services = await createSmitheryMcpBridgeServicesFromStatuses(
    [makeReadyStatus("cloud7")],
    {},
    fakeSmithery as any,
    ["cloud7.*"]
  );
  const composed = new ComposedBrokerService(services);

  assert.deepEqual(composed.listTools(), []);
  const denied = await composed.callTool("cloud7.search_docs", {});
  assert.equal(denied.ok, false);
});
