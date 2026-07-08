import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ComposedBrokerService } from "../src/github/composed.js";
import type { BrokerTool, BrokerToolService, BrokerToolCallResult } from "../src/github/types.js";

class MockToolService implements BrokerToolService {
  public readonly namespace?: string | undefined;
  private readonly tools: string[];

  constructor(
    namespace: string | undefined,
    tools: string[]
  ) {
    this.namespace = namespace;
    this.tools = tools;
  }

  listTools(): BrokerTool[] {
    return this.tools.map((name) => ({
      name,
      title: name,
      description: name,
      inputSchema: {}
    }));
  }

  async callTool(name: string, _args: unknown): Promise<BrokerToolCallResult> {
    if (this.tools.includes(name)) {
      return {
        ok: true,
        tool: name,
        result: { called: name },
        summary: `Called ${name}`
      };
    }
    return {
      ok: false,
      tool: name,
      error: { code: "tool_not_found", message: "Not found" }
    };
  }
}

describe("ComposedBrokerService", () => {
  it("lists tools with namespaced names", () => {
    const s1 = new MockToolService("ns1", ["t1", "t2"]);
    const s2 = new MockToolService(undefined, ["t3"]);
    const composed = new ComposedBrokerService([s1, s2]);

    const tools = composed.listTools();
    assert.deepEqual(tools.map(t => t.name), ["ns1.t1", "ns1.t2", "t3"]);
  });

  it("routes namespaced tools to correct service with local name", async () => {
    const s1 = new MockToolService("ns1", ["t1"]);
    const composed = new ComposedBrokerService([s1]);

    const result = await composed.callTool("ns1.t1", {});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.tool, "ns1.t1");
    assert.deepEqual((result as any).result, { called: "t1" });
  });

  it("routes flat tools to correct service", async () => {
    const s1 = new MockToolService(undefined, ["t1"]);
    const composed = new ComposedBrokerService([s1]);

    const result = await composed.callTool("t1", {});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.tool, "t1");
    assert.deepEqual((result as any).result, { called: "t1" });
  });

  it("returns tool_not_found for unknown tools", async () => {
    const s1 = new MockToolService("ns1", ["t1"]);
    const composed = new ComposedBrokerService([s1]);

    const result = await composed.callTool("unknown", {});
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error.code, "tool_not_found");
    }
  });

  it("throws on duplicate public names (flat collision)", () => {
    const s1 = new MockToolService(undefined, ["t1"]);
    const s2 = new MockToolService(undefined, ["t1"]);
    assert.throws(() => new ComposedBrokerService([s1, s2]), /Duplicate tool registration for public name "t1"/);
  });

  it("throws on duplicate public names (namespaced collision)", () => {
    const s1 = new MockToolService("ns1", ["t1"]);
    const s2 = new MockToolService("ns1", ["t1"]);
    assert.throws(() => new ComposedBrokerService([s1, s2]), /Duplicate tool registration for public name "ns1.t1"/);
  });

  it("allows same local name in different namespaces", () => {
    const s1 = new MockToolService("ns1", ["t1"]);
    const s2 = new MockToolService("ns2", ["t1"]);
    const composed = new ComposedBrokerService([s1, s2]);
    assert.deepEqual(composed.listTools().map(t => t.name), ["ns1.t1", "ns2.t1"]);
  });

  it("throws on invalid namespace (empty)", () => {
    const s1 = new MockToolService("", ["t1"]);
    assert.throws(() => new ComposedBrokerService([s1]), /Invalid namespace ""/);
  });

  it("throws on invalid namespace (contains dot)", () => {
    const s1 = new MockToolService("ns.1", ["t1"]);
    assert.throws(() => new ComposedBrokerService([s1]), /Invalid namespace "ns.1"/);
  });

  it("throws on invalid tool name (empty)", () => {
    const s1 = new MockToolService("ns1", [""]);
    assert.throws(() => new ComposedBrokerService([s1]), /Tool local name must be non-empty/);
  });
});
