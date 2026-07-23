import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { GitGateway } from "../src/git/types.js";
import type { RepoSyncRecord, WorktreeRecord } from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import { slugify } from "../src/utils/slug.js";
import { reconcileDurableWorktreeLocations } from "../src/worktrees/workspace-relocation.js";

test("recreates a stale-root worktree and rebases durable paths", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  const canonicalPath = path.join(
    codeRoot,
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  const calls: string[] = [];
  const gitGateway = createGitGateway({
    createWorktree: async (_repoPath, _codeRoot, worktreePath, branch, startPoint) => {
      calls.push(`create:${branch}:${startPoint}`);
      await mkdir(worktreePath, { recursive: true });
      return worktreePath;
    },
    resetHard: async (worktreePath, ref) => {
      calls.push(`reset:${worktreePath}:${ref}`);
    },
    cleanUntrackedFiles: async () => {
      calls.push("clean");
    }
  });
  const worktree = createWorktreeRecord(oldPath);
  const task = createTask(worktree);

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [worktree],
      tasks: [task],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway
    });

    assert.equal(result.relocatedCount, 1);
    assert.equal(result.recreatedCount, 1);
    assert.equal(result.taskRelocatedCount, 1);
    assert.deepEqual(result.failures, []);
    assert.equal(result.worktrees[0]?.path, canonicalPath);
    assert.equal(
      result.worktrees[0]?.planDocumentPath,
      path.join(canonicalPath, "docs", "agent-plan.md")
    );
    assert.equal(result.tasks[0]?.context.localRepoPath, canonicalPath);
    assert.equal(
      result.tasks[0]?.context.logDocumentPath,
      path.join(canonicalPath, "docs", "agent-log.md")
    );
    assert.deepEqual(calls, [
      "create:agent/example-org-repo-one/issue-17:origin/agent/example-org-repo-one/issue-17",
      `reset:${canonicalPath}:origin/agent/example-org-repo-one/issue-17`,
      "clean"
    ]);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("uses an existing canonical worktree without recreating it", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const canonicalPath = path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17");
  await mkdir(canonicalPath, { recursive: true });
  let createCalls = 0;
  const gitGateway = createGitGateway({
    listWorktrees: async () => [
      {
        path: canonicalPath,
        branch: "agent/example-org-repo-one/issue-17"
      }
    ],
    createWorktree: async () => {
      createCalls += 1;
      return canonicalPath;
    }
  });
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [createWorktreeRecord(oldPath)],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway
    });

    assert.equal(result.relocatedCount, 1);
    assert.equal(result.recreatedCount, 0);
    assert.equal(createCalls, 0);
    assert.equal(result.worktrees[0]?.path, canonicalPath);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("does not overwrite an existing path that is not the expected worktree", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const canonicalPath = path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17");
  await mkdir(canonicalPath, { recursive: true });
  let createCalls = 0;
  const gitGateway = createGitGateway({
    createWorktree: async () => {
      createCalls += 1;
      return canonicalPath;
    }
  });
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [createWorktreeRecord(oldPath)],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway
    });

    assert.equal(result.relocatedCount, 0);
    assert.equal(result.recreatedCount, 0);
    assert.equal(createCalls, 0);
    assert.equal(result.worktrees[0]?.path, oldPath);
    assert.match(result.failures[0]?.reason ?? "", /exists but is not a worktree/);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("heals stale task paths when worktree state was already persisted", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const canonicalPath = path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17");
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  await mkdir(canonicalPath, { recursive: true });
  const canonicalWorktree = createWorktreeRecord(canonicalPath);
  const staleTask = createTask(createWorktreeRecord(oldPath));
  const gitGateway = createGitGateway({
    listWorktrees: async () => [
      { path: canonicalPath, branch: canonicalWorktree.branchName }
    ]
  });

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [canonicalWorktree],
      tasks: [staleTask],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway
    });

    assert.equal(result.relocatedCount, 0);
    assert.equal(result.recreatedCount, 0);
    assert.equal(result.taskRelocatedCount, 1);
    assert.equal(result.tasks[0]?.context.localRepoPath, canonicalPath);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("does not use a failed same-branch worktree as a task relocation authority", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const oldRoot = path.join(os.tmpdir(), "old-code-root");
  const oldGoodPath = path.join(
    oldRoot,
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  const oldFailedPath = path.join(
    oldRoot,
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-18"
  );
  const canonicalGoodPath = path.join(
    codeRoot,
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  const canonicalFailedPath = path.join(
    codeRoot,
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-18"
  );
  await mkdir(canonicalGoodPath, { recursive: true });
  await mkdir(canonicalFailedPath, { recursive: true });
  const goodWorktree = createWorktreeRecord(oldGoodPath);
  const failedWorktree = {
    ...createWorktreeRecord(oldFailedPath),
    id: "worktree:example-org/repo-one:issue:18"
  };
  const failedTask = createTask(failedWorktree);
  const gitGateway = createGitGateway({
    listWorktrees: async () => [
      { path: canonicalGoodPath, branch: goodWorktree.branchName }
    ]
  });

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [goodWorktree, failedWorktree],
      tasks: [failedTask],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway
    });

    assert.equal(result.relocatedCount, 1);
    assert.equal(result.taskRelocatedCount, 0);
    assert.equal(result.tasks[0]?.context.localRepoPath, oldFailedPath);
    assert.equal(result.failures.length, 1);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("relocates every merge-prep task path", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  const worktree = createWorktreeRecord(oldPath);
  const baseTask = createTask(worktree);
  const task = {
    ...baseTask,
    kind: "prepare_pr_for_merge",
    context: {
      ...baseTask.context,
      prepareForMerge: {
        prNumber: 24,
        headBranch: worktree.branchName,
        headSha: "abc123",
        baseBranch: "main",
        prTitle: "Feature",
        persistentWorktreePath: oldPath,
        persistentPlanDocumentPath: worktree.planDocumentPath,
        persistentLogDocumentPath: worktree.logDocumentPath
      }
    }
  } as TaskRecord;
  const gitGateway = createGitGateway({
    createWorktree: async (_repoPath, _codeRoot, worktreePath) => {
      await mkdir(worktreePath, { recursive: true });
      return worktreePath;
    }
  });

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [worktree],
      tasks: [task],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway
    });
    const canonicalPath = result.worktrees[0]!.path;
    const context = result.tasks[0]!.context;

    assert.equal(result.taskRelocatedCount, 1);
    assert.equal(context.localRepoPath, canonicalPath);
    assert.equal(context.planDocumentPath, path.join(canonicalPath, "docs", "agent-plan.md"));
    assert.equal(context.logDocumentPath, path.join(canonicalPath, "docs", "agent-log.md"));
    assert.equal(context.prepareForMerge?.persistentWorktreePath, canonicalPath);
    assert.equal(
      context.prepareForMerge?.persistentPlanDocumentPath,
      path.join(canonicalPath, "docs", "agent-plan.md")
    );
    assert.equal(
      context.prepareForMerge?.persistentLogDocumentPath,
      path.join(canonicalPath, "docs", "agent-log.md")
    );
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("rejects a synchronized repository whose slug does not match worktree state", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  const repoSync = {
    ...createRepoSyncRecord(codeRoot),
    repoSlug: "other-org/other-repo"
  };

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [createWorktreeRecord(oldPath)],
      tasks: [],
      repoSyncRecords: [repoSync],
      gitGateway: createGitGateway()
    });

    assert.equal(result.recreatedCount, 0);
    assert.match(result.failures[0]?.reason ?? "", /Repository identity mismatch/);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("rejects a configured clone whose GitHub origin does not match", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [createWorktreeRecord(oldPath)],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway: createGitGateway({
        getRemoteUrl: async () => "git@github.com:other-org/other-repo.git"
      })
    });

    assert.equal(result.recreatedCount, 0);
    assert.match(result.failures[0]?.reason ?? "", /Repository origin mismatch/);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("fails closed when repository origin identity cannot be validated", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  const gatewayWithOrigin = createGitGateway();
  const { getRemoteUrl: _ignored, ...gatewayWithoutOrigin } = gatewayWithOrigin;

  try {
    const missingCapability = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [createWorktreeRecord(oldPath)],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway: gatewayWithoutOrigin as GitGateway
    });
    assert.match(missingCapability.failures[0]?.reason ?? "", /does not expose remote URLs/);

    const unknownOrigin = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [createWorktreeRecord(oldPath)],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway: createGitGateway({
        getRemoteUrl: async () => "git@example.test:example-org/repo-one.git"
      })
    });
    assert.match(unknownOrigin.failures[0]?.reason ?? "", /unrecognized GitHub remote URL/);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("accepts alternate SSH GitHub origins and compares identity case-insensitively", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [createWorktreeRecord(oldPath)],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway: createGitGateway({
        getRemoteUrl: async () => "ssh://git@github.com/Example-Org/Repo-One.git",
        createWorktree: async (_repoPath, _codeRoot, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          return worktreePath;
        }
      })
    });

    assert.equal(result.recreatedCount, 1);
    assert.deepEqual(result.failures, []);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("compares persisted and synchronized repository slugs case-insensitively", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  const worktree = {
    ...createWorktreeRecord(oldPath),
    repoSlug: "Example-Org/Repo-One"
  };

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [worktree],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway: createGitGateway({
        createWorktree: async (_repoPath, _codeRoot, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          return worktreePath;
        }
      })
    });

    assert.equal(result.recreatedCount, 1);
    assert.deepEqual(result.failures, []);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("rejects a stored worktree suffix that belongs to another repository", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const wrongPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "other-org",
    "other-repo",
    "issue-17"
  );

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [createWorktreeRecord(wrongPath)],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway: createGitGateway()
    });

    assert.equal(result.recreatedCount, 0);
    assert.match(result.failures[0]?.reason ?? "", /Cannot derive a canonical _worktrees path/);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

test("rejects a canonical destination beneath a symlinked path component", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-outside-"));
  await symlink(outsideRoot, path.join(codeRoot, "_worktrees"));
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  let createCalls = 0;

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [createWorktreeRecord(oldPath)],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway: createGitGateway({
        createWorktree: async () => {
          createCalls += 1;
          return "unexpected";
        }
      })
    });

    assert.equal(createCalls, 0);
    assert.match(result.failures[0]?.reason ?? "", /traverses symbolic link/);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("rejects an alternate registered worktree beneath a symlinked path component", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-outside-"));
  const symlinkParent = path.join(
    codeRoot,
    "_worktrees",
    "example-org",
    "repo-one",
    "linked"
  );
  await mkdir(path.dirname(symlinkParent), { recursive: true });
  await symlink(outsideRoot, symlinkParent);
  const alternatePath = path.join(symlinkParent, "issue-17");
  await mkdir(path.join(outsideRoot, "issue-17"), { recursive: true });
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    "example-org",
    "repo-one",
    "issue-17"
  );
  const worktree = createWorktreeRecord(oldPath);

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [worktree],
      tasks: [],
      repoSyncRecords: [createRepoSyncRecord(codeRoot)],
      gitGateway: createGitGateway({
        listWorktrees: async () => [
          { path: alternatePath, branch: worktree.branchName }
        ]
      })
    });

    assert.equal(result.relocatedCount, 0);
    assert.match(result.failures[0]?.reason ?? "", /traverses symbolic link/);
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("matches worktree paths using the same slug rules as worktree creation", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-relocation-"));
  const owner = "MyOrg";
  const repoName = `Repo_Name.${"Long".repeat(20)}`;
  const repoSlug = `${owner}/${repoName}`;
  const oldPath = path.join(
    os.tmpdir(),
    "old-code-root",
    "_worktrees",
    slugify(owner),
    slugify(repoName),
    "issue-17"
  );
  const worktree = {
    ...createWorktreeRecord(oldPath),
    repoSlug,
    repoName
  };
  const repoSync = {
    ...createRepoSyncRecord(codeRoot),
    repoSlug,
    repoName
  };

  try {
    const result = await reconcileDurableWorktreeLocations({
      codeRoot,
      worktrees: [worktree],
      tasks: [],
      repoSyncRecords: [repoSync],
      gitGateway: createGitGateway({
        getRemoteUrl: async () => `git@github.com:${repoSlug}.git`,
        createWorktree: async (_repoPath, _codeRoot, worktreePath) => {
          await mkdir(worktreePath, { recursive: true });
          return worktreePath;
        }
      })
    });

    assert.equal(result.recreatedCount, 1);
    assert.deepEqual(result.failures, []);
    assert.equal(
      result.worktrees[0]?.path,
      path.join(codeRoot, "_worktrees", slugify(owner), slugify(repoName), "issue-17")
    );
  } finally {
    await rm(codeRoot, { recursive: true, force: true });
  }
});

function createGitGateway(overrides: Partial<GitGateway> = {}): GitGateway {
  return {
    getRemoteUrl: async () => "git@github.com:example-org/repo-one.git",
    fetchRepository: async () => {},
    listWorktrees: async () => [],
    createWorktree: async (
      _repoPath: string,
      _codeRoot: string,
      worktreePath: string
    ) => worktreePath,
    getCurrentBranch: async () => "agent/example-org-repo-one/issue-17",
    resetHard: async () => {},
    cleanUntrackedFiles: async () => {},
    ...overrides
  } as unknown as GitGateway;
}

function createWorktreeRecord(worktreePath: string): WorktreeRecord {
  return {
    id: "worktree:example-org/repo-one:issue:17",
    repoId: "repo-1",
    repoSlug: "example-org/repo-one",
    repoName: "repo-one",
    issueId: "issue:example-org/repo-one:17",
    issueNumber: 17,
    branchName: "agent/example-org-repo-one/issue-17",
    path: worktreePath,
    planDocumentPath: path.join(worktreePath, "docs", "agent-plan.md"),
    logDocumentPath: path.join(worktreePath, "docs", "agent-log.md"),
    status: "implementation_done",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T11:00:00.000Z"
  };
}

function createTask(worktree: WorktreeRecord): TaskRecord {
  return {
    id: "task:respond_pr_comment:comment:1",
    kind: "respond_pr_comment",
    status: "failed",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: worktree.repoId,
    repoName: worktree.repoName,
    repoSlug: worktree.repoSlug,
    sourceKind: "comment",
    sourceId: "comment:1",
    sourceUrl: "https://github.com/example-org/repo-one/pull/24#issuecomment-1",
    relevant: true,
    reason: "Retry requested",
    summary: "Respond to comment",
    context: {
      repoIdentifier: worktree.repoSlug,
      localRepoPath: worktree.path,
      branchName: worktree.branchName,
      planDocumentPath: worktree.planDocumentPath,
      logDocumentPath: worktree.logDocumentPath,
      labels: [],
      instruction: "Respond"
    },
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T11:00:00.000Z"
  };
}

function createRepoSyncRecord(codeRoot: string): RepoSyncRecord {
  return {
    repoId: "repo-1",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    localPath: path.join(codeRoot, "repo-one"),
    codeRoot,
    status: "synced",
    existedBeforeSync: true,
    cloned: false,
    fetched: true,
    defaultBranchSyncStatus: "synced",
    defaultBranch: "main",
    defaultBranchSource: "git",
    currentBranchBefore: "main",
    currentBranchAfter: "main",
    syncedAt: "2026-07-01T12:00:00.000Z",
    message: "synced"
  };
}
