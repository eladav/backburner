import * as assert from "node:assert/strict";
import { test } from "node:test";
import { NonInteractivePrompter } from "../src/onboarding/prompt.js";
import { ConfigureModelsStep } from "../src/onboarding/steps/configure-models.js";
import type { OnboardingContext, Prompter } from "../src/onboarding/types.js";

function makeCtx(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    codeRoot: "/code",
    managementDir: "/management",
    outputsDir: "/outputs",
    logDir: "/outputs/logs",
    workspacesDir: "/workspaces",
    discoveredRepos: [],
    selectedRepos: [],
    discoveredProviders: [],
    warnings: [],
    stepResults: new Map(),
    ...overrides
  };
}

class SelectivePrompter implements Prompter {
  constructor(private readonly selected: number[]) {}

  ask(_question: string, defaultValue?: string): Promise<string> {
    return Promise.resolve(defaultValue ?? "");
  }

  confirm(_question: string, defaultValue?: boolean): Promise<boolean> {
    return Promise.resolve(defaultValue ?? true);
  }

  choose(_question: string, _options: string[], defaultIndex?: number): Promise<number> {
    return Promise.resolve(defaultIndex ?? 0);
  }

  multiSelect(): Promise<number[]> {
    return Promise.resolve(this.selected);
  }
}

test("ConfigureModelsStep: --yes configures strong and cheap agents for every available provider", async () => {
  const ctx = makeCtx({
    discoveredProviders: [
      {
        name: "codex",
        command: "codex",
        available: true,
        version: "codex 1.0.0",
        models: ["sol", "terra", "luna"]
      },
      {
        name: "gemini",
        command: "gemini",
        available: true,
        version: "gemini 1.0.0"
      },
      {
        name: "claude",
        command: "claude",
        available: false
      }
    ]
  });

  const result = await new ConfigureModelsStep().run(ctx, new NonInteractivePrompter());

  assert.equal(result.status, "passed");
  assert.equal(ctx.configDraft?.agents.length, 4);
  assert.deepEqual(
    ctx.configDraft?.agents.map((agent) => agent.id),
    ["codex-strong", "codex-cheap", "gemini-strong", "gemini-cheap"]
  );

  const codexStrong = ctx.configDraft?.agents.find((agent) => agent.id === "codex-strong");
  const codexCheap = ctx.configDraft?.agents.find((agent) => agent.id === "codex-cheap");
  assert.equal(codexStrong?.model, "sol");
  assert.equal(codexCheap?.model, "luna");
});

test("ConfigureModelsStep: interactive selection configures only selected providers", async () => {
  const ctx = makeCtx({
    discoveredProviders: [
      {
        name: "codex",
        command: "codex",
        available: true
      },
      {
        name: "opencode",
        command: "opencode",
        available: true,
        models: [
          "openrouter/openai/gpt-5.6-sol",
          "openrouter/openai/gpt-5.6-luna",
          "anthropic/claude-sonnet-4-6"
        ]
      }
    ]
  });

  const result = await new ConfigureModelsStep().run(ctx, new SelectivePrompter([1]));

  assert.equal(result.status, "passed");
  assert.deepEqual(
    ctx.configDraft?.agents.map((agent) => ({
      id: agent.id,
      provider: agent.provider,
      model: agent.model
    })),
    [
      {
        id: "opencode-strong",
        provider: "opencode",
        model: "openrouter/openai/gpt-5.6-sol"
      },
      {
        id: "opencode-cheap",
        provider: "opencode",
        model: "openrouter/openai/gpt-5.6-luna"
      }
    ]
  );
});

test("ConfigureModelsStep: shows discovered model options while keeping defaults", async () => {
  const ctx = makeCtx({
    discoveredProviders: [
      {
        name: "opencode",
        command: "opencode",
        available: true,
        models: [
          "openrouter/openai/gpt-5.6-sol",
          "openrouter/openai/gpt-5.6-terra",
          "openrouter/openai/gpt-5.6-luna",
          "anthropic/claude-sonnet-4-6"
        ]
      }
    ]
  });

  const output = await captureStdout(async () => {
    await new ConfigureModelsStep().run(ctx, new SelectivePrompter([0]));
  });

  assert.match(output, /Available opencode models/);
  assert.match(output, /openrouter\/openai\/gpt-5\.6-sol \(strong default\)/);
  assert.match(output, /openrouter\/openai\/gpt-5\.6-luna \(cheap default\)/);
  assert.match(output, /openrouter\/openai\/gpt-5\.6-terra/);
  assert.match(output, /Press enter at each prompt to accept the default/);
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite as typeof process.stdout.write;
  }
}
