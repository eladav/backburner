import * as assert from "node:assert/strict";
import { test } from "node:test";
import { selectAgentForTask } from "../src/agents/selection.js";
import type { AgentConfig } from "../src/config/types.js";
import type { TaskRecord } from "../src/tasks/types.js";

test("selectAgentForTask can pick Antigravity agents when enabled", () => {
  const agents: AgentConfig[] = [
    { id: "c1", provider: "codex", modelClass: "strong", roles: ["review"], command: "c", enabled: false },
    { id: "a1", provider: "antigravity", modelClass: "strong", roles: ["review"], command: "agy", enabled: true }
  ];

  const task = { kind: "review_pr", id: "t1" } as TaskRecord;
  const selected = selectAgentForTask(task, agents);

  assert.equal(selected.id, "a1");
  assert.equal(selected.provider, "antigravity");
});

test("selectAgentForTask throws descriptive error when no agent matches", () => {
  const agents: AgentConfig[] = [];
  const task = { kind: "write_plan", id: "t2" } as TaskRecord;

  assert.throws(() => selectAgentForTask(task, agents), {
    message: /No enabled agent configured for task t2 with role "planning" and modelClass "strong"/
  });
});
