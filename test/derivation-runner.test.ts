import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  runBlockingHandler,
  runHandlers
} from "../src/tasks/derivation/runner.js";
import type {
  BlockingTaskDerivationHandler,
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler,
  TaskDerivationSink
} from "../src/tasks/derivation/types.js";
import type { TaskRecord } from "../src/tasks/types.js";

test("runHandlers executes handlers in declared order and sends every task to the sink", () => {
  const seen: string[] = [];
  const added: string[] = [];
  const context = {} as ResolvedWorkstreamContext;
  const env = {} as TaskDerivationEnvironment;
  const sink: TaskDerivationSink = {
    add(task) {
      added.push(task.id);
      return task;
    },
    replace(task) {
      return task;
    },
    get() {
      return undefined;
    },
    preserveExisting() {
      return undefined;
    }
  };
  const handlers: TaskDerivationHandler[] = [
    {
      name: "first",
      derive() {
        seen.push("first");
        return [task("task:first")];
      }
    },
    {
      name: "second",
      derive() {
        seen.push("second");
        return [task("task:second-a"), task("task:second-b")];
      }
    }
  ];

  runHandlers(handlers, context, env, sink);

  assert.deepEqual(seen, ["first", "second"]);
  assert.deepEqual(added, ["task:first", "task:second-a", "task:second-b"]);
});

test("runBlockingHandler blocks based on the sink-returned merged task", () => {
  const context = {} as ResolvedWorkstreamContext;
  const env = {} as TaskDerivationEnvironment;
  const handler: BlockingTaskDerivationHandler = {
    name: "plan_breakdown",
    derive() {
      return [task("task:plan_breakdown", "pending")];
    },
    shouldBlockRemainingHandlers(taskRecord) {
      return taskRecord.status === "pending";
    }
  };

  const sink: TaskDerivationSink = {
    add(taskRecord) {
      return {
        ...taskRecord,
        status: "completed"
      };
    },
    replace(taskRecord) {
      return taskRecord;
    },
    get() {
      return undefined;
    },
    preserveExisting() {
      return undefined;
    }
  };

  assert.equal(runBlockingHandler(handler, context, env, sink), false);
});

function task(id: string, status: TaskRecord["status"] = "pending"): TaskRecord {
  return {
    id,
    kind: "triage_issue",
    status,
    executionPermission: "read-only",
    handoffPolicy: {
      expectsPushableHandoff: false,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: "repo-1",
    repoName: "repo",
    repoSlug: "owner/repo",
    sourceKind: "issue",
    sourceId: "issue:owner/repo:1",
    sourceUrl: "https://github.com/owner/repo/issues/1",
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: "owner/repo",
      labels: [],
      instruction: "instruction"
    },
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z"
  };
}
