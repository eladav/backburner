import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { JournalWriter } from "../src/journal/writer.js";
import { JournalReader } from "../src/journal/reader.js";
import { JournalService } from "../src/journal/service.js";
import { renderJournalEntries } from "../src/journal/renderer.js";
import type { JournalEntry } from "../src/journal/types.js";
import {
  journalWorkstreamTransitions,
  journalWorktreeTransitions,
  buildEntityMaps,
  resolveRepoActionState
} from "../src/cli/run-journal.js";
import { runJournalCli } from "../src/cli/run.js";
import type { WorkstreamRecord, WorktreeRecord } from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aog-journal-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── Writer ────────────────────────────────────────────────────────────────────

test("JournalWriter creates a JSONL file and stamps id and timestamp", async () => {
  await withTmpDir(async (dir) => {
    const writer = new JournalWriter(dir);
    const entry = await writer.write({
      scope: "system",
      scopeId: "cycle-1",
      category: "observation",
      severity: "info",
      summary: "Cycle started"
    });

    assert.ok(entry.id, "entry should have an id");
    assert.ok(entry.timestamp, "entry should have a timestamp");
    assert.equal(entry.scope, "system");
    assert.equal(entry.summary, "Cycle started");

    const raw = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] ?? "{}") as JournalEntry;
    assert.equal(parsed.id, entry.id);
    assert.equal(parsed.summary, "Cycle started");
  });
});

test("JournalWriter appends multiple entries, one per line", async () => {
  await withTmpDir(async (dir) => {
    const writer = new JournalWriter(dir);
    await writer.write({ scope: "system", scopeId: "c1", category: "observation", severity: "info", summary: "first" });
    await writer.write({ scope: "repo", scopeId: "repo-1", category: "sync", severity: "info", summary: "second" });

    const raw = await fs.readFile(path.join(dir, "journal.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok((JSON.parse(lines[0] ?? "{}") as JournalEntry).summary === "first");
    assert.ok((JSON.parse(lines[1] ?? "{}") as JournalEntry).summary === "second");
  });
});

test("JournalWriter creates the journal directory if it does not exist", async () => {
  await withTmpDir(async (dir) => {
    const nested = path.join(dir, "deep", "journal");
    const writer = new JournalWriter(nested);
    await writer.write({ scope: "system", scopeId: "x", category: "observation", severity: "info", summary: "ok" });

    const stat = await fs.stat(path.join(nested, "journal.jsonl"));
    assert.ok(stat.isFile());
  });
});

// ── Reader ────────────────────────────────────────────────────────────────────

test("JournalReader returns empty array when file does not exist", async () => {
  await withTmpDir(async (dir) => {
    const reader = new JournalReader(dir);
    const entries = await reader.read();
    assert.deepEqual(entries, []);
  });
});

test("JournalReader parses all entries from JSONL file", async () => {
  await withTmpDir(async (dir) => {
    const writer = new JournalWriter(dir);
    await writer.write({ scope: "system", scopeId: "c1", category: "observation", severity: "info", summary: "one" });
    await writer.write({ scope: "repo", scopeId: "r1", category: "sync", severity: "info", summary: "two" });

    const reader = new JournalReader(dir);
    const entries = await reader.read();
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.summary, "one");
    assert.equal(entries[1]?.summary, "two");
  });
});

// ── Query filtering ───────────────────────────────────────────────────────────

test("JournalReader.query filters by repoId", async () => {
  await withTmpDir(async (dir) => {
    const writer = new JournalWriter(dir);
    await writer.write({ scope: "repo", scopeId: "r1", repoId: "repo-alpha", category: "sync", severity: "info", summary: "alpha" });
    await writer.write({ scope: "repo", scopeId: "r2", repoId: "repo-beta", category: "sync", severity: "info", summary: "beta" });

    const reader = new JournalReader(dir);
    const entries = await reader.query({ repoId: "repo-alpha" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.summary, "alpha");
  });
});

test("JournalReader.query filters by workstreamId", async () => {
  await withTmpDir(async (dir) => {
    const writer = new JournalWriter(dir);
    await writer.write({ scope: "workstream", scopeId: "ws-1", workstreamId: "ws-1", category: "task_created", severity: "info", summary: "ws1 task" });
    await writer.write({ scope: "workstream", scopeId: "ws-2", workstreamId: "ws-2", category: "task_created", severity: "info", summary: "ws2 task" });

    const reader = new JournalReader(dir);
    const entries = await reader.query({ workstreamId: "ws-1" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.summary, "ws1 task");
  });
});

test("JournalReader.query filters by issueNumber", async () => {
  await withTmpDir(async (dir) => {
    const writer = new JournalWriter(dir);
    await writer.write({ scope: "issue", scopeId: "i-42", issueNumber: 42, category: "observation", severity: "info", summary: "issue 42" });
    await writer.write({ scope: "issue", scopeId: "i-99", issueNumber: 99, category: "observation", severity: "info", summary: "issue 99" });

    const reader = new JournalReader(dir);
    const entries = await reader.query({ issueNumber: 42 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.summary, "issue 42");
  });
});

test("JournalReader.query filters by prNumber", async () => {
  await withTmpDir(async (dir) => {
    const writer = new JournalWriter(dir);
    await writer.write({ scope: "pull_request", scopeId: "pr-7", prNumber: 7, category: "observation", severity: "info", summary: "pr 7" });
    await writer.write({ scope: "pull_request", scopeId: "pr-8", prNumber: 8, category: "observation", severity: "info", summary: "pr 8" });

    const reader = new JournalReader(dir);
    const entries = await reader.query({ prNumber: 7 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.summary, "pr 7");
  });
});

test("JournalReader.query filters by since timestamp", async () => {
  await withTmpDir(async (dir) => {
    const writer = new JournalWriter(dir);
    const old: JournalEntry = {
      id: "id-old",
      timestamp: "2025-01-01T00:00:00.000Z",
      scope: "system",
      scopeId: "c1",
      category: "observation",
      severity: "info",
      summary: "old entry"
    };
    const recent: JournalEntry = {
      id: "id-new",
      timestamp: "2026-06-01T00:00:00.000Z",
      scope: "system",
      scopeId: "c2",
      category: "observation",
      severity: "info",
      summary: "recent entry"
    };
    await fs.writeFile(
      path.join(dir, "journal.jsonl"),
      [JSON.stringify(old), JSON.stringify(recent)].join("\n") + "\n"
    );

    const reader = new JournalReader(dir);
    const entries = await reader.query({ since: "2026-01-01T00:00:00.000Z" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.summary, "recent entry");
  });
});

test("JournalReader.query limit returns the last N entries", async () => {
  await withTmpDir(async (dir) => {
    const writer = new JournalWriter(dir);
    for (let i = 1; i <= 5; i++) {
      await writer.write({ scope: "system", scopeId: `c${i}`, category: "observation", severity: "info", summary: `entry ${i}` });
    }

    const reader = new JournalReader(dir);
    const entries = await reader.query({ limit: 2 });
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.summary, "entry 4");
    assert.equal(entries[1]?.summary, "entry 5");
  });
});

// ── JournalService convenience methods ────────────────────────────────────────

test("JournalService.recordNoAction sets category and noActionReason", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    const entry = await svc.recordNoAction({
      scope: "repo",
      scopeId: "repo-1",
      repoId: "repo-1",
      reason: "No actionable issues found"
    });

    assert.equal(entry.category, "no_action");
    assert.equal(entry.severity, "info");
    assert.equal(entry.noActionReason, "No actionable issues found");
    assert.equal(entry.summary, "No actionable issues found");
    assert.equal(entry.repoId, "repo-1");
  });
});

test("JournalService.recordStateTransition populates stateTransition", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    const entry = await svc.recordStateTransition({
      scope: "workstream",
      scopeId: "ws-1",
      workstreamId: "ws-1",
      from: "planning",
      to: "implementation_ready",
      trigger: "plan_approved",
      summary: "Workstream moved to implementation_ready"
    });

    assert.equal(entry.category, "state_transition");
    assert.equal(entry.severity, "info");
    assert.deepEqual(entry.stateTransition, {
      from: "planning",
      to: "implementation_ready",
      trigger: "plan_approved"
    });
  });
});

test("JournalService.recordBlocked sets severity warning", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    const entry = await svc.recordBlocked({
      scope: "workstream",
      scopeId: "ws-2",
      workstreamId: "ws-2",
      reason: "Blocked by failed prior execution"
    });

    assert.equal(entry.category, "blocked");
    assert.equal(entry.severity, "warning");
    assert.equal(entry.noActionReason, "Blocked by failed prior execution");
  });
});

test("resolveRepoActionState reports failed Product Discovery before waiting for approval", () => {
  const workstream: WorkstreamRecord = {
    id: "eladaviv/repo-one:issue:17",
    repoKey: "eladaviv/repo-one",
    origin: { type: "issue", number: 17 },
    linkedIssueNumber: 17,
    linkedPrs: [],
    phase: "product_discovery",
    attention: "idle",
    status: "open",
    resolution: "unresolved",
    product: {
      status: "in_discovery",
      approvalLabel: "agent-product-approved"
    }
  };
  const failedTask: TaskRecord = {
    id: "task:product_discovery:issue:eladaviv/repo-one:17",
    kind: "product_discovery",
    status: "failed",
    executionPermission: "read-only",
    handoffPolicy: {
      expectsPushableHandoff: false,
      orchestratorOwnsPush: false,
      remotePublishOwner: "orchestrator"
    },
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "eladaviv/repo-one",
    sourceKind: "issue",
    sourceId: "issue:eladaviv/repo-one:17",
    sourceUrl: "https://github.com/eladaviv/repo-one/issues/17",
    relevant: true,
    reason: "New issue needs Product Discovery.",
    summary: "Product Discovery for issue #17",
    workstreamId: workstream.id,
    workflowPhase: "product_discovery",
    context: {
      repoIdentifier: "eladaviv/repo-one",
      issueUrl: "https://github.com/eladaviv/repo-one/issues/17",
      labels: [],
      instruction: "Analyze product direction."
    },
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:01:00.000Z"
  };

  const state = resolveRepoActionState({
    repoId: "repo-1",
    repoSlug: "eladaviv/repo-one",
    syncRecord: undefined,
    tasks: [failedTask],
    workstreams: [workstream],
    issues: [],
    prs: []
  });

  assert.deepEqual(state, {
    hasAction: false,
    noActionReason: "Workstream blocked by failed prior execution"
  });
});

test("JournalService.write records observed and derived state", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    const entry = await svc.write({
      scope: "repo",
      scopeId: "r1",
      repoId: "r1",
      category: "observation",
      severity: "info",
      summary: "Scan complete",
      observedState: { issueCount: 5, prCount: 2 },
      derivedState: { hasActionableItems: true }
    });

    assert.deepEqual(entry.observedState, { issueCount: 5, prCount: 2 });
    assert.deepEqual(entry.derivedState, { hasActionableItems: true });

    const entries = await svc.query();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]?.observedState, { issueCount: 5, prCount: 2 });
  });
});

test("JournalService.write records execution failure", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    const entry = await svc.write({
      scope: "execution",
      scopeId: "exec-1",
      executionId: "exec-1",
      repoId: "r1",
      category: "execution_failed",
      severity: "error",
      summary: "Agent execution failed with exit code 1",
      noActionReason: "Non-zero exit code"
    });

    assert.equal(entry.category, "execution_failed");
    assert.equal(entry.severity, "error");
    assert.equal(entry.noActionReason, "Non-zero exit code");
  });
});

// ── Renderer ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "test-id",
    timestamp: "2026-06-16T12:00:00.000Z",
    scope: "repo",
    scopeId: "repo-1",
    repoId: "owner/repo",
    category: "sync",
    severity: "info",
    summary: "Synced owner/repo",
    ...overrides
  };
}

test("renderJournalEntries produces one line per entry in default mode", () => {
  const entries = [makeEntry({ summary: "Synced owner/repo" })];
  const output = renderJournalEntries(entries);
  const lines = output.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.includes("Synced owner/repo"));
  assert.ok(lines[0]?.includes("2026-06-16"));
  assert.ok(lines[0]?.includes("[owner/repo]"));
});

test("renderJournalEntries returns 'No journal entries found.' for empty input", () => {
  const output = renderJournalEntries([]);
  assert.equal(output, "No journal entries found.\n");
});

test("renderJournalEntries with json:true produces valid JSON array", () => {
  const entries = [makeEntry(), makeEntry({ id: "id-2", summary: "second" })];
  const output = renderJournalEntries(entries, { json: true });
  const parsed = JSON.parse(output) as JournalEntry[];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.summary, "Synced owner/repo");
  assert.equal(parsed[1]?.summary, "second");
});

test("renderJournalEntries with verbose:true includes detail lines", () => {
  const entry = makeEntry({
    category: "state_transition",
    expectedNextAction: "Dispatch agent",
    stateTransition: { from: "planning", to: "implementation_ready", trigger: "approved" },
    observedState: { prCount: 1 },
    derivedState: { ready: true }
  });
  const output = renderJournalEntries([entry], { verbose: true });
  assert.ok(output.includes("category: state_transition"));
  assert.ok(output.includes("next:     Dispatch agent"));
  assert.ok(output.includes("from:     planning"));
  assert.ok(output.includes("to:       implementation_ready"));
  assert.ok(output.includes("trigger:  approved"));
  assert.ok(output.includes('"prCount":1') || output.includes('"prCount": 1'));
});

test("renderJournalEntries prefixes errors with ✗", () => {
  const entry = makeEntry({ severity: "error", summary: "Sync failed" });
  const output = renderJournalEntries([entry]);
  assert.ok(output.includes("✗ "));
});

test("renderJournalEntries prefixes warnings with !", () => {
  const entry = makeEntry({ severity: "warning", summary: "Partial scan" });
  const output = renderJournalEntries([entry]);
  assert.ok(output.includes("! "));
});

// ── Round-trip ────────────────────────────────────────────────────────────────

test("full round-trip: write entries then query by cycleId", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    const cycleId = "cycle-abc-123";

    await svc.write({ scope: "system", scopeId: cycleId, cycleId, category: "observation", severity: "info", summary: "cycle started" });
    await svc.write({ scope: "repo", scopeId: "r1", repoId: "r1", cycleId, category: "sync", severity: "info", summary: "repo synced" });
    await svc.write({ scope: "system", scopeId: "other-cycle", cycleId: "other-cycle", category: "observation", severity: "info", summary: "different cycle" });

    const entries = await svc.query({ cycleId });
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.cycleId === cycleId));
  });
});

// ── Issue 3: workstream transitions include repoId ────────────────────────────

test("journalWorkstreamTransitions includes repoId resolved from repoKey", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);

    const baseWs: WorkstreamRecord = {
      id: "ws-1",
      repoKey: "owner/repo-a",
      origin: { type: "issue", number: 5 },
      linkedPrs: [],
      phase: "planning",
      attention: "idle",
      status: "open",
      resolution: "unresolved"
    };
    const prev: WorkstreamRecord = { ...baseWs };
    const next: WorkstreamRecord = { ...baseWs, phase: "plan_feedback" };

    const entityMaps = buildEntityMaps([], [], [
      { id: "repo-a", owner: "owner", name: "repo-a", localPath: "repo-a", enabled: true, labels: { agentInProgress: "", agentPlanApproved: "", agentProductApproved: "", agentReview: "", planBreakdownNeeded: "", agentSyncParentBranch: "", prepareForMerge: "" } }
    ]);

    await journalWorkstreamTransitions({
      cycleId: "cycle-1",
      previousWorkstreams: [prev],
      currentWorkstreams: [next],
      journal: svc,
      entityMaps
    });

    const all = await svc.reader.query({});
    assert.equal(all.length, 1);
    const entry = all[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.repoId, "repo-a", "Workstream transition entry should have repoId resolved from repoKey");
    assert.equal(entry.workstreamId, "ws-1");
    assert.equal(entry.issueNumber, 5);

    // Must be queryable by repoId
    const byRepo = await svc.reader.query({ repoId: "repo-a" });
    assert.equal(byRepo.length, 1, "Workstream transition should be queryable by repoId");
  });
});

test("buildEntityMaps: repoSlugToId resolves repo id when repoKey is already a repo id", async () => {
  const entityMaps = buildEntityMaps([], [], [
    { id: "repo-a", owner: "owner", name: "repo-a", localPath: "repo-a", enabled: true, labels: { agentInProgress: "", agentPlanApproved: "", agentProductApproved: "", agentReview: "", planBreakdownNeeded: "", agentSyncParentBranch: "", prepareForMerge: "" } }
  ]);
  // slug-based lookup (the normal case)
  assert.equal(entityMaps.repoSlugToId.get("owner/repo-a"), "repo-a");
  // id-based lookup (the fallback case: ws.repoKey stored as id)
  assert.equal(entityMaps.repoSlugToId.get("repo-a"), "repo-a");
});

// ── Issue 4: worktree transitions use "worktree" scope ────────────────────────

test("journalWorktreeTransitions uses 'worktree' scope and is queryable by repo and workstream", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);

    const baseWt: WorktreeRecord = {
      id: "wt-1",
      repoId: "repo-a",
      repoSlug: "owner/repo-a",
      repoName: "repo-a",
      issueNumber: 7,
      packet: {
        parentWorkstreamId: "ws-2",
        packetId: "pkt-1",
        waveIndex: 0,
        parentIntegrationBranch: "main"
      },
      branchName: "feature/fix",
      path: "/tmp/wt-1",
      planDocumentPath: "/tmp/wt-1/plan.md",
      logDocumentPath: "/tmp/wt-1/log.md",
      status: "planning",
      createdAt: "2026-06-17T10:00:00.000Z",
      updatedAt: "2026-06-17T10:00:00.000Z"
    };
    const prev: WorktreeRecord = { ...baseWt };
    const next: WorktreeRecord = { ...baseWt, status: "implementation_ready" };

    await journalWorktreeTransitions({
      cycleId: "cycle-1",
      previousWorktrees: [prev],
      currentWorktrees: [next],
      journal: svc
    });

    const all = await svc.reader.query({});
    assert.equal(all.length, 1);
    const entry = all[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.scope, "worktree", "Worktree transition must use scope 'worktree', not 'workstream'");
    assert.equal(entry.scopeId, "wt-1", "scopeId must be the worktree id");
    assert.equal(entry.repoId, "repo-a");
    assert.equal(entry.workstreamId, "ws-2", "workstreamId must be resolved from wt.packet.parentWorkstreamId");
    assert.equal(entry.issueNumber, 7);

    // Must be queryable by repo
    const byRepo = await svc.reader.query({ repoId: "repo-a" });
    assert.equal(byRepo.length, 1, "Worktree transition should be queryable by repoId");

    // Must be queryable by workstream
    const byWorkstream = await svc.reader.query({ workstreamId: "ws-2" });
    assert.equal(byWorkstream.length, 1, "Worktree transition should be queryable by workstreamId");
  });
});

// ── Issue 5: CLI validation ───────────────────────────────────────────────────

test("runJournalCli: --issue abc throws CliUsageError", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    await assert.rejects(
      () => runJournalCli(["--issue", "abc"], svc),
      /positive integer/
    );
  });
});

test("runJournalCli: --issue 0 throws CliUsageError", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    await assert.rejects(
      () => runJournalCli(["--issue", "0"], svc),
      /positive integer/
    );
  });
});

test("runJournalCli: --issue -1 throws CliUsageError", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    await assert.rejects(
      () => runJournalCli(["--issue", "-1"], svc),
      /positive integer/
    );
  });
});

test("runJournalCli: --pr abc throws CliUsageError", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    await assert.rejects(
      () => runJournalCli(["--pr", "abc"], svc),
      /positive integer/
    );
  });
});

test("runJournalCli: --pr 0 throws CliUsageError", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    await assert.rejects(
      () => runJournalCli(["--pr", "0"], svc),
      /positive integer/
    );
  });
});

test("runJournalCli: --last abc throws CliUsageError", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    await assert.rejects(
      () => runJournalCli(["--last", "abc"], svc),
      /positive integer/
    );
  });
});

test("runJournalCli: --last 0 throws CliUsageError", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    await assert.rejects(
      () => runJournalCli(["--last", "0"], svc),
      /positive integer/
    );
  });
});

test("runJournalCli: --since garbage throws CliUsageError", async () => {
  await withTmpDir(async (dir) => {
    const svc = new JournalService(dir);
    await assert.rejects(
      () => runJournalCli(["--since", "not-a-date"], svc),
      /valid ISO date/
    );
  });
});
