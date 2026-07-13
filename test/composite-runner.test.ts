import * as assert from "node:assert/strict";
import { test } from "node:test";
import { CompositeAgentRunner } from "../src/agents/composite-runner.js";
import type { AgentConfig } from "../src/config/types.js";
import type { BuiltContext } from "../src/context/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { AgentRunner, DispatchResult } from "../src/agents/types.js";

test("CompositeAgentRunner routes to correct registered provider", async () => {
  const composite = new CompositeAgentRunner();
  const codexResult = { taskStatus: "completed" } as DispatchResult;
  const antigravityResult = { taskStatus: "failed" } as DispatchResult;

  const codexRunner: AgentRunner = {
    dispatch: async () => codexResult
  };
  const antigravityRunner: AgentRunner = {
    dispatch: async () => antigravityResult
  };

  composite.register("codex", codexRunner);
  composite.register("antigravity", antigravityRunner);

  const task = {} as TaskRecord;
  const context = {} as BuiltContext;

  const r1 = await composite.dispatch(task, context, { provider: "codex" } as AgentConfig);
  assert.equal(r1, codexResult);

  const r2 = await composite.dispatch(task, context, { provider: "antigravity" } as AgentConfig);
  assert.equal(r2, antigravityResult);
});

test("CompositeAgentRunner errors for unregistered provider", async () => {
  const composite = new CompositeAgentRunner();
  const task = {} as TaskRecord;
  const context = {} as BuiltContext;

  await assert.rejects(
    () => composite.dispatch(task, context, { provider: "unknown", id: "a1" } as any),
    { message: /No runner registered for agent provider "unknown" \(agent: a1\)/ }
  );
});

test("CompositeAgentRunner propagates promptContent to the registered runner", async () => {
  const composite = new CompositeAgentRunner();
  let passedPromptContent: any;

  const mockRunner: AgentRunner = {
    dispatch: async (task, context, agentConfig, sessionDecision, promptContent) => {
      passedPromptContent = promptContent;
      return { taskStatus: "completed" } as DispatchResult;
    }
  };

  composite.register("mock", mockRunner);

  const task = {} as TaskRecord;
  const context = {} as BuiltContext;
  const promptContent = { content: "stricter plan instructions" } as any;

  await composite.dispatch(
    task,
    context,
    { provider: "mock" } as unknown as AgentConfig,
    undefined,
    promptContent
  );

  assert.deepEqual(passedPromptContent, promptContent);
});
