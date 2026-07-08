import * as assert from "node:assert/strict";
import { test } from "node:test";
import { buildEffectiveProviderBrokerToolAllowLists } from "../src/cli/run.js";
import { ScopedBrokerToolService } from "../src/github/scoped-broker.js";
import type { AgentConfig } from "../src/config/types.js";
import type { AgentVisibleCapabilities } from "../src/capabilities/types.js";
import type { BrokerTool, BrokerToolCallResult, BrokerToolService } from "../src/github/types.js";

class FakeBrokerService implements BrokerToolService {
  public readonly calls: string[] = [];

  constructor(private readonly tools: BrokerTool[]) {}

  listTools(): BrokerTool[] {
    return [...this.tools];
  }

  async callTool(name: string): Promise<BrokerToolCallResult> {
    this.calls.push(name);
    return {
      ok: true,
      tool: name,
      result: { name },
      summary: `called ${name}`
    };
  }
}

const codexAgent: AgentConfig = {
  id: "codex-strong",
  provider: "codex",
  modelClass: "strong",
  roles: ["implementation"],
  command: "codex",
  enabled: true
};

test("effective runtime scope denies over-allowlisted hosted MCP tools outside projection", async () => {
  const internalTools = ["plan_breakdown.start_session", "memory_search", "backburner_git_get_state"];
  const effective = buildEffectiveProviderBrokerToolAllowLists({
    declaredMcps: [{ handle: "cloud7", smitheryId: "@example/cloud7" }],
    enabledAgents: [codexAgent],
    providerBrokerToolAllowLists: new Map([
      [
        "codex",
        [
          "get_issue",
          "cloud7.resolve-library-id",
          "cloud7.write-docs",
          ...internalTools
        ]
      ]
    ]),
    capabilitiesByProvider: new Map([
      [
        "codex",
        {
          sensors: [
            {
              name: "docs",
              uses: "cloud7",
              observes: "package-docs",
              tools: ["cloud7.resolve-library-id"]
            }
          ],
          controllers: [],
          blocked: []
        } satisfies AgentVisibleCapabilities
      ]
    ]),
    registeredPublicBrokerToolNames: [
      "get_issue",
      "cloud7.resolve-library-id",
      "cloud7.write-docs",
      ...internalTools
    ],
    internalAlwaysAllowedTools: internalTools
  });

  const allowed = effective.get("codex") ?? [];
  assert.deepEqual(allowed, [
    ...internalTools,
    "get_issue",
    "cloud7.resolve-library-id"
  ]);
  assert.equal(allowed.includes("cloud7.write-docs"), false);

  const delegate = new FakeBrokerService([
    tool("get_issue"),
    tool("cloud7.resolve-library-id"),
    tool("cloud7.write-docs"),
    ...internalTools.map((name) => tool(name))
  ]);
  const scoped = new ScopedBrokerToolService(delegate);
  scoped.bindAllowedTools(allowed);

  assert.deepEqual(scoped.listTools().map((entry) => entry.name), [
    "get_issue",
    "cloud7.resolve-library-id",
    ...internalTools
  ]);

  const denied = await scoped.callTool("cloud7.write-docs", {});
  assert.equal(denied.ok, false);
  assert.deepEqual(delegate.calls, []);

  const internal = await scoped.callTool("memory_search", {});
  assert.equal(internal.ok, true);
  assert.deepEqual(delegate.calls, ["memory_search"]);
});

test("empty capability projection preserves GitHub and internal tools but denies hosted MCP tools", () => {
  const effective = buildEffectiveProviderBrokerToolAllowLists({
    declaredMcps: [{ handle: "cloud7", smitheryId: "@example/cloud7" }],
    enabledAgents: [codexAgent],
    providerBrokerToolAllowLists: new Map([
      ["codex", ["get_issue", "cloud7.resolve-library-id", "memory_search"]]
    ]),
    capabilitiesByProvider: new Map(),
    registeredPublicBrokerToolNames: ["get_issue", "cloud7.resolve-library-id", "memory_search"],
    internalAlwaysAllowedTools: ["memory_search"]
  });

  assert.deepEqual(effective.get("codex"), ["memory_search", "get_issue"]);
});

test("hosted MCP runtime scope requires exact provider allow-list entry", () => {
  const effective = buildEffectiveProviderBrokerToolAllowLists({
    declaredMcps: [{ handle: "cloud7", smitheryId: "@example/cloud7" }],
    enabledAgents: [codexAgent],
    providerBrokerToolAllowLists: new Map([
      ["codex", ["cloud7.*"]]
    ]),
    capabilitiesByProvider: new Map([
      [
        "codex",
        {
          sensors: [
            {
              name: "docs",
              uses: "cloud7",
              observes: "package-docs",
              tools: ["cloud7.resolve-library-id"]
            }
          ],
          controllers: [],
          blocked: []
        } satisfies AgentVisibleCapabilities
      ]
    ]),
    registeredPublicBrokerToolNames: ["cloud7.resolve-library-id"],
    internalAlwaysAllowedTools: []
  });

  assert.deepEqual(effective.get("codex"), []);
});

test("effective runtime scope excludes wrong-handle hosted MCP tools", () => {
  const effective = buildEffectiveProviderBrokerToolAllowLists({
    declaredMcps: [
      { handle: "pkg", smitheryId: "@example/pkg" },
      { handle: "cloud7", smitheryId: "@example/cloud7" }
    ],
    enabledAgents: [codexAgent],
    providerBrokerToolAllowLists: new Map([
      ["codex", ["pkg.query-docs", "cloud7.query-docs"]]
    ]),
    capabilitiesByProvider: new Map([
      [
        "codex",
        {
          sensors: [
            {
              name: "pkg-docs",
              uses: "pkg",
              observes: "package-docs",
              tools: ["pkg.query-docs"]
            }
          ],
          controllers: [],
          blocked: []
        } satisfies AgentVisibleCapabilities
      ]
    ]),
    registeredPublicBrokerToolNames: ["pkg.query-docs", "cloud7.query-docs"],
    internalAlwaysAllowedTools: []
  });

  assert.deepEqual(effective.get("codex"), ["pkg.query-docs"]);
});

function tool(name: string): BrokerTool {
  return {
    name,
    title: name,
    description: name,
    inputSchema: {}
  };
}
