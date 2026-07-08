import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ScopedBrokerToolService } from "../src/github/scoped-broker.js";
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

test("ScopedBrokerToolService filters tools and calls to the active provider allow-list", async () => {
  const delegate = new FakeBrokerService([
    tool("get_issue"),
    tool("cloud7.search_docs"),
    tool("cloud7.write_docs")
  ]);
  const scoped = new ScopedBrokerToolService(delegate);

  scoped.bindAllowedTools(["get_issue", "cloud7.search_docs"]);

  assert.deepEqual(scoped.listTools().map((entry) => entry.name), [
    "get_issue",
    "cloud7.search_docs"
  ]);

  const allowed = await scoped.callTool("cloud7.search_docs", {});
  assert.equal(allowed.ok, true);

  const denied = await scoped.callTool("cloud7.write_docs", {});
  assert.equal(denied.ok, false);
  assert.deepEqual(delegate.calls, ["cloud7.search_docs"]);
});

test("ScopedBrokerToolService clears active allow-list after a provider run", () => {
  const scoped = new ScopedBrokerToolService(new FakeBrokerService([
    tool("get_issue"),
    tool("cloud7.search_docs")
  ]));

  scoped.bindAllowedTools(["get_issue"]);
  assert.deepEqual(scoped.listTools().map((entry) => entry.name), ["get_issue"]);

  scoped.clearAllowedTools();
  assert.deepEqual(scoped.listTools().map((entry) => entry.name), [
    "get_issue",
    "cloud7.search_docs"
  ]);
});

function tool(name: string): BrokerTool {
  return {
    name,
    title: name,
    description: name,
    inputSchema: {}
  };
}
