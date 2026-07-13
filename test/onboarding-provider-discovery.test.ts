import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderDiscoveryService } from "../src/onboarding/services/provider-discovery.js";
import type { CommandRunner, CommandRunnerResult } from "../src/utils/command-runner.js";

function stubRunner(
  responses: Record<string, CommandRunnerResult | Error>
): CommandRunner {
  return {
    run(command, args) {
      const key = [command, ...args].join(" ");
      const response = responses[key];
      if (response === undefined) {
        return Promise.reject(new Error(`Unexpected: ${key}`));
      }
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response);
    }
  };
}

function ok(stdout = ""): CommandRunnerResult {
  return { stdout, stderr: "", exitCode: 0 };
}

test("ProviderDiscoveryService: no providers found", async () => {
  const runner = stubRunner({
    "claude --version": new Error("not found"),
    "codex --version": new Error("not found"),
    "gemini --version": new Error("not found"),
    "opencode --version": new Error("not found"),
    "agy --version": new Error("not found")
  });

  const service = new ProviderDiscoveryService(runner);
  const providers = await service.discoverAll();

  assert.equal(providers.length, 5);
  assert.ok(providers.every((p) => !p.available));
});

test("ProviderDiscoveryService: one provider found (claude)", async () => {
  const runner = stubRunner({
    "claude --version": ok("Claude Code 1.5.0"),
    "codex --version": new Error("not found"),
    "gemini --version": new Error("not found"),
    "opencode --version": new Error("not found"),
    "agy --version": new Error("not found")
  });

  const service = new ProviderDiscoveryService(runner);
  const providers = await service.discoverAll();

  const available = providers.filter((p) => p.available);
  assert.equal(available.length, 1);
  assert.equal(available[0]?.name, "claude");
  assert.ok(available[0]?.version !== undefined);
});

test("ProviderDiscoveryService: multiple providers found", async () => {
  const runner = stubRunner({
    "claude --version": ok("Claude Code 1.5.0"),
    "codex --version": new Error("not found"),
    "gemini --version": new Error("not found"),
    "opencode --version": new Error("not found"),
    "agy --version": ok("1.0.10")
  });

  const service = new ProviderDiscoveryService(runner);
  const providers = await service.discoverAll();

  const available = providers.filter((p) => p.available);
  assert.equal(available.length, 2);

  const names = available.map((p) => p.name);
  assert.ok(names.includes("claude"));
  assert.ok(names.includes("antigravity"));
});

test("ProviderDiscoveryService: all providers found", async () => {
  const runner = stubRunner({
    "claude --version": ok("Claude Code 1.5.0"),
    "codex --version": ok("codex 0.1.0"),
    "gemini --version": ok("gemini 0.1.0"),
    "opencode --version": ok("opencode 0.3.0"),
    "agy --version": ok("1.0.10")
  });

  const service = new ProviderDiscoveryService(runner);
  const providers = await service.discoverAll();

  assert.ok(providers.every((p) => p.available));
  assert.equal(providers.length, 5);
});

test("ProviderDiscoveryService: discovers models when a local CLI supports model listing", async () => {
  const runner = stubRunner({
    "claude --version": new Error("not found"),
    "codex --version": ok("codex 0.1.0"),
    "codex models": ok("sol\nterra\nluna\n"),
    "gemini --version": new Error("not found"),
    "opencode --version": new Error("not found"),
    "agy --version": new Error("not found")
  });

  const service = new ProviderDiscoveryService(runner);
  const providers = await service.discoverAll();

  const codex = providers.find((p) => p.name === "codex");
  assert.equal(codex?.available, true);
  assert.deepEqual(codex?.models, ["sol", "terra", "luna"]);
});

test("ProviderDiscoveryService: keeps provider available when model listing fails", async () => {
  const runner = stubRunner({
    "claude --version": new Error("not found"),
    "codex --version": ok("codex 0.1.0"),
    "codex models": new Error("unsupported"),
    "codex models list": new Error("unsupported"),
    "codex model list": new Error("unsupported"),
    "gemini --version": new Error("not found"),
    "opencode --version": new Error("not found"),
    "agy --version": new Error("not found")
  });

  const service = new ProviderDiscoveryService(runner);
  const providers = await service.discoverAll();

  const codex = providers.find((p) => p.name === "codex");
  assert.equal(codex?.available, true);
  assert.equal(codex?.models, undefined);
});
