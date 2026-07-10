import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Task } from "../src/tasks/task.js";
import type { TaskRecord } from "../src/tasks/types.js";

test("Task.getSourceCommentId prioritizes sourceReactionTargetId", () => {
  const recordWithReaction: TaskRecord = {
    id: "task-1",
    kind: "respond_pr_comment",
    status: "pending",
    executionPermission: "workspace-write",
    handoffPolicy: { expectsPushableHandoff: true, orchestratorOwnsPush: true, remotePublishOwner: "orchestrator" },
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    sourceKind: "comment",
    sourceId: "comment:example-org/repo-one:12345",
    sourceUrl: "url",
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
        repoIdentifier: "repo-1",
        labels: [],
        instruction: "instr"
    },
    sourceReactionTargetId: "12345",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z"
  } as TaskRecord;

  const task = Task.from(recordWithReaction);
  assert.equal(task.getSourceCommentId(), "12345");

  const recordWithoutReaction: TaskRecord = {
    ...recordWithReaction,
    sourceReactionTargetId: undefined,
    sourceId: "comment:example-org/repo-one:999"
  };

  const task2 = Task.from(recordWithoutReaction);
  assert.equal(task2.getSourceCommentId(), "999");
});
