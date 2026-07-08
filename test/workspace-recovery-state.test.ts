import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { StateStore } from "../src/state/loader.js";
import { WorkspaceRecoveryRecord } from "../src/state/types.js";

test("StateStore round-trips workspace recovery records as readable JSON", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-test-recovery-"));
  try {
    const store = new StateStore(tmpDir);

    const records: WorkspaceRecoveryRecord[] = [
      {
        taskId: "task-2",
        taskKind: "implement_plan",
        workspacePath: "/tmp/workspace-2",
        outcome: "recovered",
        reason: "timeout",
        recoveredAt: "2026-06-09T14:00:00.000Z"
      },
      {
        taskId: "task-1",
        taskKind: "write_plan",
        workspacePath: "/tmp/workspace-1",
        outcome: "skipped",
        reason: "no workspace",
        recoveredAt: "2026-06-09T13:00:00.000Z"
      }
    ];

    await store.writeWorkspaceRecoveryState(records);

    // Verify file exists and is pretty-printed JSON
    const filePath = path.join(tmpDir, "workspace-recovery.json");
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);

    assert.ok(content.includes("  "), "JSON should be pretty-printed with spaces");
    assert.equal(parsed.records.length, 2);
    // Records should be sorted by taskId then recoveredAt
    assert.equal(parsed.records[0].taskId, "task-1");
    assert.equal(parsed.records[1].taskId, "task-2");

    const loaded = await store.load();
    assert.equal(loaded.workspaceRecoveries.length, 2);
    assert.equal(loaded.workspaceRecoveries[0]?.taskId, "task-1");
    assert.equal(loaded.workspaceRecoveries[1]?.taskId, "task-2");

    const explicitLoaded = await store.loadWorkspaceRecoveryState();
    assert.equal(explicitLoaded.length, 2);
    assert.equal(explicitLoaded[0]?.taskId, "task-1");
    assert.equal(explicitLoaded[1]?.taskId, "task-2");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
