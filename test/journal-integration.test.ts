import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runCli, runJournalCli } from "../src/cli/run.js";
import type { RepoConfig } from "../src/config/types.js";
import type { NormalizedComment, NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import type { RepoSyncRecord, ExecutionRecord } from "../src/state/types.js";
import { JournalService } from "../src/journal/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseRepo(id: string, name: string): RepoConfig {
  return {
    id,
    owner: "testowner",
    name,
    localPath: name,
    enabled: true,
    labels: {
      agentInProgress: "agent-in-progress",
      agentPlanApproved: "agent-plan-approved",
      agentProductApproved: "agent-product-approved",
      agentReview: "agent-review",
      planBreakdownNeeded: "plan-breakdown-needed",
      agentSyncParentBranch: "agent-sync-parent-branch",
      prepareForMerge: "prepare-for-merge"
    }
  };
}

function syncedResult(id: string, name: string, codeRoot: string): RepoSyncRecord {
  return {
    repoId: id,
    repoName: name,
    repoSlug: `testowner/${name}`,
    localPath: path.join(codeRoot, name),
    codeRoot,
    status: "synced",
    existedBeforeSync: true,
    cloned: false,
    fetched: true,
    defaultBranch: "main",
    defaultBranchSource: "github",
    currentBranchBefore: "main",
    currentBranchAfter: "main",
    syncedAt: "2026-06-17T10:00:00.000Z",
    message: "ok"
  };
}

function issueFixture(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    kind: "issue",
    id: "issue:testowner/repo-a:42",
    repoId: "repo-a",
    repoKey: "testowner/repo-a",
    repoOwner: "testowner",
    repoName: "repo-a",
    repoSlug: "testowner/repo-a",
    number: 42,
    key: "testowner/repo-a:issue:42",
    sourceId: "ISSUE_42",
    url: "https://github.com/testowner/repo-a/issues/42",
    title: "Fix the bug",
    body: "Details here",
    labels: ["agent-in-progress"],
    author: "human",
    createdAt: "2026-06-17T09:00:00.000Z",
    updatedAt: "2026-06-17T09:30:00.000Z",
    lastCommentAt: "2026-06-17T09:31:00.000Z",
    lastSeenAt: "2026-06-17T10:00:00.000Z",
    state: "open",
    ...overrides
  };
}

function prFixture(overrides: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  return {
    kind: "pull_request",
    id: "pull_request:testowner/repo-a:99",
    repoId: "repo-a",
    repoKey: "testowner/repo-a",
    repoOwner: "testowner",
    repoName: "repo-a",
    repoSlug: "testowner/repo-a",
    number: 99,
    key: "testowner/repo-a:pull_request:99",
    sourceId: "PR_99",
    url: "https://github.com/testowner/repo-a/pull/99",
    title: "Implement fix",
    body: "PR body",
    labels: ["agent-plan-approved"],
    author: "human",
    createdAt: "2026-06-17T09:00:00.000Z",
    updatedAt: "2026-06-17T09:30:00.000Z",
    lastCommentAt: "2026-06-17T09:31:00.000Z",
    lastSeenAt: "2026-06-17T10:00:00.000Z",
    state: "open",
    headBranch: "feature/fix",
    headSha: "sha123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false,
    ...overrides
  };
}

const noopLogger = { info: () => undefined, warn: () => undefined };

async function setupTmp() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-journal-integ-"));
  const managementDir = path.join(tmpDir, "management");
  const stateDir = path.join(tmpDir, "state");
  const codeRoot = path.join(tmpDir, "code");
  const journalDir = path.join(tmpDir, "journal");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(managementDir, { recursive: true });
  return { tmpDir, managementDir, stateDir, codeRoot, journalDir };
}

async function writeConfig(managementDir: string, repos: RepoConfig[]) {
  await fs.writeFile(
    path.join(managementDir, "repos.json"),
    JSON.stringify({ allowedUsers: ["human", "reviewer"], repos }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(managementDir, "agents.json"),
    JSON.stringify(
      {
        agents: [
          {
            id: "codex-main",
            provider: "codex",
            modelClass: "strong",
            roles: ["product", "discussion", "review", "planning"],
            command: "codex",
            enabled: true
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
}

function makeAgentRunner(stateDir: string) {
  return {
    async dispatch(task: any, _context: unknown, agentConfig: any): Promise<any> {
      const safeId = (task.id as string).replaceAll(/[:/]/g, "_");
      const execution: ExecutionRecord = {
        id: `exec:${task.id}`,
        taskId: task.id as string,
        taskKind: task.kind,
        taskStatus: "completed",
        repoId: task.repoId as string,
        repoSlug: task.repoSlug as string,
        agentId: agentConfig.id as string,
        agentProvider: "codex",
        command: { executable: "codex", args: [], cwd: stateDir, timeoutMs: 0 },
        promptArtifactPath: path.join(stateDir, `${safeId}-prompt.md`),
        stdoutArtifactPath: path.join(stateDir, `${safeId}-stdout.txt`),
        stderrArtifactPath: path.join(stateDir, `${safeId}-stderr.txt`),
        promptPacketPath: path.join(stateDir, `${safeId}-packet.json`),
        startedAt: "2026-06-17T10:05:00.000Z",
        endedAt: "2026-06-17T10:06:00.000Z",
        exitCode: 0
      };
      await fs.mkdir(stateDir, { recursive: true });
      await Promise.all([
        fs.writeFile(execution.promptArtifactPath, "", "utf8"),
        fs.writeFile(execution.stdoutArtifactPath, "done\n", "utf8"),
        fs.writeFile(execution.stderrArtifactPath, "", "utf8"),
        fs.writeFile(execution.promptPacketPath, "{}", "utf8")
      ]);
      return { taskStatus: "completed" as const, execution };
    }
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("journal: issue-sourced task entry has issueNumber populated", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);
    const issue = issueFixture();
    const synced = syncedResult("repo-a", "repo-a", codeRoot);

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository() { return synced; } },
      scanService: {
        async scanRepositories() {
          return {
            issues: [issue],
            prs: [],
            comments: [] as NormalizedComment[],
            repoResults: [
              {
                ...synced,
                githubScan: {
                  status: "scanned" as const,
                  scannedAt: "2026-06-17T10:01:00.000Z",
                  issueCount: 1,
                  pullRequestCount: 0,
                  commentCount: 0,
                  failures: []
                }
              }
            ],
            failures: []
          };
        }
      },
      agentRunner: makeAgentRunner(stateDir) as any,
      logger: noopLogger
    });

    const entries = await journal.reader.query({ issueNumber: 42 });
    assert.ok(entries.length > 0, "Expected at least one journal entry with issueNumber: 42");

    const taskCreated = entries.find((e) => e.category === "task_created");
    assert.ok(taskCreated !== undefined, "Expected a task_created entry for issue #42");
    assert.equal(taskCreated.issueNumber, 42);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("journal: PR-sourced task entry has prNumber populated", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);
    const pr = prFixture();
    const synced = syncedResult("repo-a", "repo-a", codeRoot);

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository() { return synced; } },
      scanService: {
        async scanRepositories() {
          return {
            issues: [],
            prs: [pr],
            comments: [] as NormalizedComment[],
            repoResults: [
              {
                ...synced,
                githubScan: {
                  status: "scanned" as const,
                  scannedAt: "2026-06-17T10:01:00.000Z",
                  issueCount: 0,
                  pullRequestCount: 1,
                  commentCount: 0,
                  failures: []
                }
              }
            ],
            failures: []
          };
        }
      },
      agentRunner: makeAgentRunner(stateDir) as any,
      logger: noopLogger
    });

    const entries = await journal.reader.query({ prNumber: 99 });
    assert.ok(entries.length > 0, "Expected at least one journal entry with prNumber: 99");
    assert.ok(
      entries.some((e) => e.category === "task_created" || e.category === "task_skipped"),
      "Expected a task entry (created or skipped) for PR #99"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("journal: sync failure produces no_action with sync error reason", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);
    const failedSync: RepoSyncRecord = {
      repoId: "repo-a",
      repoName: "repo-a",
      repoSlug: "testowner/repo-a",
      localPath: path.join(codeRoot, "repo-a"),
      codeRoot,
      status: "failed",
      existedBeforeSync: true,
      cloned: false,
      fetched: false,
      defaultBranch: "main",
      defaultBranchSource: "github",
      currentBranchBefore: "main",
      currentBranchAfter: "main",
      syncedAt: "2026-06-17T10:00:00.000Z",
      message: "working tree is dirty",
      error: { step: "sync", message: "working tree is dirty" }
    };

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository(): Promise<RepoSyncRecord> { return failedSync; } },
      scanService: {
        async scanRepositories() {
          return {
            issues: [],
            prs: [],
            comments: [] as NormalizedComment[],
            repoResults: [
              {
                ...failedSync,
                githubScan: {
                  status: "failed" as const,
                  scannedAt: "2026-06-17T10:01:00.000Z",
                  issueCount: 0,
                  pullRequestCount: 0,
                  commentCount: 0,
                  failures: []
                }
              }
            ],
            failures: []
          };
        }
      },
      logger: noopLogger
    });

    const entries = await journal.reader.query({ repoId: "repo-a" });
    const noAction = entries.find((e) => e.category === "no_action");
    assert.ok(noAction !== undefined, "Expected a no_action entry for repo with failed sync");
    assert.ok(
      noAction.noActionReason !== undefined &&
        (noAction.noActionReason.includes("failed to sync") || noAction.noActionReason.includes("Repository failed")),
      `Expected sync failure reason, got: "${noAction.noActionReason}"`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("journal: GitHub scan failure produces no_action with scan error reason", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);
    const synced = syncedResult("repo-a", "repo-a", codeRoot);

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository(): Promise<RepoSyncRecord> { return synced; } },
      scanService: {
        async scanRepositories() {
          return {
            issues: [],
            prs: [],
            comments: [] as NormalizedComment[],
            repoResults: [
              {
                ...synced,
                githubScan: {
                  status: "failed" as const,
                  scannedAt: "2026-06-17T10:01:00.000Z",
                  issueCount: 0,
                  pullRequestCount: 0,
                  commentCount: 0,
                  failures: [
                    {
                      repoId: "repo-a",
                      repoSlug: "testowner/repo-a",
                      step: "list_issues" as const,
                      scope: "repo",
                      message: "GitHub API rate limit"
                    }
                  ]
                }
              }
            ],
            failures: []
          };
        }
      },
      logger: noopLogger
    });

    const entries = await journal.reader.query({ repoId: "repo-a" });
    const noAction = entries.find((e) => e.category === "no_action");
    assert.ok(noAction !== undefined, "Expected a no_action entry for repo with failed GitHub scan");
    assert.ok(
      noAction.noActionReason !== undefined &&
        (noAction.noActionReason.includes("scan") || noAction.noActionReason.includes("GitHub")),
      `Expected scan failure reason, got: "${noAction.noActionReason}"`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("journal: executions from first cycle are not re-journaled in second cycle", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);
    const issue = issueFixture();
    const synced = syncedResult("repo-a", "repo-a", codeRoot);
    const scanResult = {
      issues: [issue],
      prs: [],
      comments: [] as NormalizedComment[],
      repoResults: [
        {
          ...synced,
          githubScan: {
            status: "scanned" as const,
            scannedAt: "2026-06-17T10:01:00.000Z",
            issueCount: 1,
            pullRequestCount: 0,
            commentCount: 0,
            failures: []
          }
        }
      ],
      failures: []
    };
    const baseOptions = {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository() { return synced; } },
      scanService: { async scanRepositories() { return scanResult; } },
      agentRunner: makeAgentRunner(stateDir) as any,
      logger: noopLogger
    };

    // First run: triage_issue gets dispatched and completed
    await runCli(["run", "--code-root", codeRoot], baseOptions);
    const afterFirst = await journal.reader.query({});
    const execCountAfterFirst = afterFirst.filter((e) => e.category === "execution_completed").length;
    assert.ok(execCountAfterFirst > 0, "Expected execution_completed entries after first run");

    // Second run: previousState.executions now has the first run's executions
    // journalNewExecutions must filter them out via executionIdsBeforeCycle
    await runCli(["run", "--code-root", codeRoot], baseOptions);
    const afterSecond = await journal.reader.query({});
    const execCountAfterSecond = afterSecond.filter((e) => e.category === "execution_completed").length;

    const newExecEntries = execCountAfterSecond - execCountAfterFirst;
    assert.equal(
      newExecEntries,
      0,
      `Second cycle re-journaled ${newExecEntries} execution(s) that already existed. executionIdsBeforeCycle dedup is broken.`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("journal: --json output contains top-level issueNumber field queryable by runJournalCli", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository() { return syncedResult("repo-a", "repo-a", codeRoot); } },
      scanService: {
        async scanRepositories() {
          return {
            issues: [issueFixture()],
            prs: [],
            comments: [] as NormalizedComment[],
            repoResults: [
              {
                ...syncedResult("repo-a", "repo-a", codeRoot),
                githubScan: {
                  status: "scanned" as const,
                  scannedAt: "2026-06-17T10:01:00.000Z",
                  issueCount: 1,
                  pullRequestCount: 0,
                  commentCount: 0,
                  failures: []
                }
              }
            ],
            failures: []
          };
        }
      },
      agentRunner: makeAgentRunner(stateDir) as any,
      logger: noopLogger
    });

    // Capture stdout from runJournalCli with --json and --issue 42
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: unknown, ..._rest: unknown[]) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      await runJournalCli(["--issue", "42", "--json"], journal);
    } finally {
      (process.stdout as any).write = origWrite;
    }

    const parsed = JSON.parse(chunks.join("")) as unknown;
    assert.ok(Array.isArray(parsed), "Expected JSON array from runJournalCli --json");
    assert.ok((parsed as unknown[]).length > 0, "Expected at least one entry for issue #42");
    const first = (parsed as unknown[])[0] as Record<string, unknown>;
    assert.ok(
      "issueNumber" in first,
      `Expected top-level issueNumber field in JSON entry, got keys: ${Object.keys(first).join(", ")}`
    );
    assert.equal(first.issueNumber, 42, "issueNumber should equal 42");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Issue 1: pre-dispatch setup failure creates execution_failed entries ───────

test("journal: pre-dispatch setup failure creates execution_failed entries", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);
    const issue = issueFixture();
    const synced = syncedResult("repo-a", "repo-a", codeRoot);

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository() { return synced; } },
      scanService: {
        async scanRepositories() {
          return {
            issues: [issue],
            prs: [],
            comments: [] as NormalizedComment[],
            repoResults: [
              {
                ...synced,
                githubScan: {
                  status: "scanned" as const,
                  scannedAt: "2026-06-17T10:01:00.000Z",
                  issueCount: 1,
                  pullRequestCount: 0,
                  commentCount: 0,
                  failures: []
                }
              }
            ],
            failures: []
          };
        }
      },
      // No agentRunner — the broker setup runs; inject a failing broker server
      startBrokerServer: async () => {
        throw new Error("Broker port already in use");
      },
      logger: noopLogger
    });

    const entries = await journal.reader.query({});
    const execFailed = entries.filter((e) => e.category === "execution_failed");
    assert.ok(
      execFailed.length >= 1,
      `Expected at least one execution_failed entry from pre-dispatch failure, got ${execFailed.length}`
    );
    assert.ok(execFailed.every((e) => e.severity === "error"));

    // The entries must reference the issue
    const withIssue = execFailed.filter((e) => e.issueNumber === 42);
    assert.ok(withIssue.length >= 1, "execution_failed entry should have issueNumber: 42");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Issue 2: successful task creates state_transition entry ───────────────────

test("journal: successful task completion creates a state_transition entry for the task", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);
    const issue = issueFixture();
    const synced = syncedResult("repo-a", "repo-a", codeRoot);

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository() { return synced; } },
      scanService: {
        async scanRepositories() {
          return {
            issues: [issue],
            prs: [],
            comments: [] as NormalizedComment[],
            repoResults: [
              {
                ...synced,
                githubScan: {
                  status: "scanned" as const,
                  scannedAt: "2026-06-17T10:01:00.000Z",
                  issueCount: 1,
                  pullRequestCount: 0,
                  commentCount: 0,
                  failures: []
                }
              }
            ],
            failures: []
          };
        }
      },
      agentRunner: makeAgentRunner(stateDir) as any,
      logger: noopLogger
    });

    const entries = await journal.reader.query({});
    const transitions = entries.filter((e) => e.category === "state_transition");
    const taskTransition = transitions.find(
      (e) =>
        e.stateTransition !== undefined &&
        (e.stateTransition.to === "completed" || e.stateTransition.from === "pending")
    );
    assert.ok(
      taskTransition !== undefined,
      `Expected a state_transition entry for task completion. Got ${transitions.length} state_transition entries: ${JSON.stringify(transitions.map((t) => t.stateTransition))}`
    );
    assert.equal(taskTransition.repoId, "repo-a");
    assert.ok(taskTransition.derivedState !== undefined, "state_transition entry should include derivedState");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Issue 6: no_action not emitted when pending task exists ───────────────────

test("journal: no_action not emitted for a repo with a pending relevant task", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);
    const issue = issueFixture(); // agent-in-progress → derives triage_issue → pending
    const synced = syncedResult("repo-a", "repo-a", codeRoot);

    // No agentRunner: task is derived as pending but not dispatched
    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository() { return synced; } },
      scanService: {
        async scanRepositories() {
          return {
            issues: [issue],
            prs: [],
            comments: [] as NormalizedComment[],
            repoResults: [
              {
                ...synced,
                githubScan: {
                  status: "scanned" as const,
                  scannedAt: "2026-06-17T10:01:00.000Z",
                  issueCount: 1,
                  pullRequestCount: 0,
                  commentCount: 0,
                  failures: []
                }
              }
            ],
            failures: []
          };
        }
      },
      // No agentRunner — pending task stays pending; resolveRepoActionState should detect it
      logger: noopLogger
    });

    const entries = await journal.reader.query({ repoId: "repo-a" });
    const noAction = entries.find((e) => e.category === "no_action");
    assert.equal(
      noAction,
      undefined,
      `Expected no no_action entry when a pending relevant task exists, but got: "${noAction?.noActionReason}"`
    );

    // Verify there is in fact a task_created entry (sanity check that the task was derived)
    const taskCreated = entries.find((e) => e.category === "task_created");
    assert.ok(
      taskCreated !== undefined,
      "Expected a task_created entry for the pending issue task"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Issue 6b: no_action suppressed when task was in previousState (not newly derived) ────

test("journal: no_action not emitted when previousState already has a pending relevant task", async () => {
  const { tmpDir, managementDir, stateDir, codeRoot, journalDir } = await setupTmp();
  try {
    await writeConfig(managementDir, [baseRepo("repo-a", "repo-a")]);
    const journal = new JournalService(journalDir);
    const issue = issueFixture(); // agent-in-progress → triage_issue → pending
    const synced = syncedResult("repo-a", "repo-a", codeRoot);

    // Pre-populate state with a pending task for issue #42, as if it was created in a prior cycle.
    // The task ID must match what deriveTasks would generate: task:<kind>:<sourceId>
    const previousPendingTask = {
      id: "task:triage_issue:issue:testowner/repo-a:42",
      kind: "triage_issue",
      status: "pending",
      executionPermission: "read-only",
      handoffPolicy: {
        expectsPushableHandoff: false,
        orchestratorOwnsPush: false,
        remotePublishOwner: "orchestrator"
      },
      repoId: "repo-a",
      repoName: "repo-a",
      repoSlug: "testowner/repo-a",
      sourceKind: "issue",
      sourceId: "issue:testowner/repo-a:42",
      sourceUrl: "https://github.com/testowner/repo-a/issues/42",
      relevant: true,
      reason: "Issue has agent-in-progress label",
      summary: "Triage issue #42",
      context: {
        repoIdentifier: "testowner/repo-a",
        labels: ["agent-in-progress"],
        instruction: "Triage this issue"
      },
      createdAt: "2026-06-17T09:00:00.000Z",
      updatedAt: "2026-06-17T09:00:00.000Z"
    };
    await fs.writeFile(
      path.join(stateDir, "tasks.json"),
      JSON.stringify({ tasks: [previousPendingTask] }, null, 2),
      "utf8"
    );

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      journalService: journal,
      syncService: { async syncRepository() { return synced; } },
      scanService: {
        async scanRepositories() {
          return {
            issues: [issue],
            prs: [],
            comments: [] as NormalizedComment[],
            repoResults: [
              {
                ...synced,
                githubScan: {
                  status: "scanned" as const,
                  scannedAt: "2026-06-17T10:01:00.000Z",
                  issueCount: 1,
                  pullRequestCount: 0,
                  commentCount: 0,
                  failures: []
                }
              }
            ],
            failures: []
          };
        }
      },
      // No agentRunner — task stays pending; resolveRepoActionState must see it and suppress no_action
      logger: noopLogger
    });

    const entries = await journal.reader.query({ repoId: "repo-a" });

    // The task was in previousState, so deriveTasks should NOT create it anew
    const taskCreated = entries.find(
      (e) => e.category === "task_created" && e.derivedState?.taskId === previousPendingTask.id
    );
    assert.equal(
      taskCreated,
      undefined,
      "Task was in previousState — should not appear as task_created this cycle"
    );

    // The pending task in previousState must suppress no_action emission
    const noAction = entries.find((e) => e.category === "no_action");
    assert.equal(
      noAction,
      undefined,
      `Expected no no_action when previousState has a pending task, but got: "${noAction?.noActionReason}"`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
