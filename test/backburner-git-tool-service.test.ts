import * as assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BackburnerGitToolService } from "../src/git/backburner-git-tool-service.js";
import { CommandExecutionError, ExecFileCommandRunner } from "../src/utils/command-runner.js";

const runner = new ExecFileCommandRunner();
const logger = {
  info: () => undefined,
  warn: () => undefined
};

test("Backburner Git tools reject unknown workstreams", async () => {
  const service = new BackburnerGitToolService(runner, logger);
  const result = await service.callTool("backburner_git_get_state", { backburnerGitSessionId: "missing" });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.code, "unknown_workstream");
});

test("Backburner Git tools reject path escapes before touching Git", async () => {
  const repo = await createConflictedRepo();
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-1",
    workstreamId: "ws-1",
    repoRoot: repo.path,
    expectedHeadSha: repo.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    const relativeEscape = await service.callTool("backburner_git_get_conflict_versions", {
      backburnerGitSessionId: "session-1",
      path: "../outside.txt"
    });
    const absoluteEscape = await service.callTool("backburner_git_get_conflict_versions", {
      backburnerGitSessionId: "session-1",
      path: path.join(repo.path, "file.txt")
    });
    const gitPath = await service.callTool("backburner_git_get_conflict_versions", {
      backburnerGitSessionId: "session-1",
      path: ".git/config"
    });

    assert.equal(relativeEscape.ok, false);
    assert.equal(relativeEscape.ok ? undefined : relativeEscape.error.code, "invalid_path");
    assert.equal(absoluteEscape.ok, false);
    assert.equal(absoluteEscape.ok ? undefined : absoluteEscape.error.code, "invalid_path");
    assert.equal(gitPath.ok, false);
    assert.equal(gitPath.ok ? undefined : gitPath.error.code, "invalid_path");
  } finally {
    await rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git tools list conflicts, reject unresolved markers, and complete a merge", async () => {
  const repo = await createConflictedRepo();
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-merge",
    workstreamId: "ws-merge",
    repoRoot: repo.path,
    expectedHeadSha: repo.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    const conflicts = await service.callTool("backburner_git_get_conflicts", { backburnerGitSessionId: "session-merge" });
    assert.equal(conflicts.ok, true);
    assert.deepEqual((conflicts as any).result.conflicts[0], {
      path: "file.txt",
      type: "both modified",
      exists: true,
      conflictMarkersPresent: true
    });

    const versions = await service.callTool("backburner_git_get_conflict_versions", {
      backburnerGitSessionId: "session-merge",
      path: "file.txt"
    });
    assert.equal(versions.ok, true);
    assert.match((versions as any).result.base, /initial/);
    assert.match((versions as any).result.ours, /feature change/);
    assert.match((versions as any).result.theirs, /main change/);
    assert.equal((versions as any).result.stages.base, true);

    const markerRejected = await service.callTool("backburner_git_mark_resolved", {
      backburnerGitSessionId: "session-merge",
      paths: ["file.txt"]
    });
    assert.equal(markerRejected.ok, false);
    assert.equal(markerRejected.ok ? undefined : markerRejected.error.code, "conflict_markers_present");

    await writeFile(path.join(repo.path, "file.txt"), "main change\nfeature change\n", "utf8");
    const marked = await service.callTool("backburner_git_mark_resolved", {
      backburnerGitSessionId: "session-merge",
      paths: ["file.txt"]
    });
    assert.equal(marked.ok, true);

    const continued = await service.callTool("backburner_git_continue_merge", { backburnerGitSessionId: "session-merge" });
    assert.equal(continued.ok, true);
    assert.match((continued as any).result.commitSha, /^[0-9a-f]{40}$/);

    const state = await service.callTool("backburner_git_get_state", { backburnerGitSessionId: "session-merge" });
    assert.equal(state.ok, true);
    assert.equal((state as any).result.operation, "none");
    assert.equal((state as any).result.indexHasUnresolvedConflicts, false);
    assert.equal((state as any).result.worktreeClean, true);
  } finally {
    await rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git continue merge rejects unstaged verification fixes before committing", async () => {
  const repo = await createConflictedRepo();
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-dirty-continue",
    workstreamId: "ws-dirty-continue",
    repoRoot: repo.path,
    expectedHeadSha: repo.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    await writeFile(path.join(repo.path, "file.txt"), "main change\nfeature change\n", "utf8");
    const marked = await service.callTool("backburner_git_mark_resolved", {
      backburnerGitSessionId: "session-dirty-continue",
      paths: ["file.txt"]
    });
    assert.equal(marked.ok, true);

    await writeFile(path.join(repo.path, "file.txt"), "main change\nfeature change\nformat fix\n", "utf8");
    const rejected = await service.callTool("backburner_git_continue_merge", {
      backburnerGitSessionId: "session-dirty-continue"
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? undefined : rejected.error.code, "dirty_worktree");
    assert.match(rejected.ok ? "" : rejected.error.message, /unstaged tracked: file\.txt/);
    assert.match(rejected.ok ? "" : rejected.error.message, /backburner_git_mark_resolved/);
    assert.match(rejected.ok ? "" : rejected.error.message, /backburner_git_mark_deleted/);
    assert.match(rejected.ok ? "" : rejected.error.message, /backburner_git_restore_worktree/);

    const state = await service.callTool("backburner_git_get_state", { backburnerGitSessionId: "session-dirty-continue" });
    assert.equal(state.ok, true);
    assert.equal((state as any).result.operation, "merge");
    assert.deepEqual((state as any).result.unstagedFiles, ["file.txt"]);

    const remarked = await service.callTool("backburner_git_mark_resolved", {
      backburnerGitSessionId: "session-dirty-continue",
      paths: ["file.txt"]
    });
    assert.equal(remarked.ok, true);

    const continued = await service.callTool("backburner_git_continue_merge", {
      backburnerGitSessionId: "session-dirty-continue"
    });
    assert.equal(continued.ok, true);
    assert.match((continued as any).result.commitSha, /^[0-9a-f]{40}$/);
  } finally {
    await rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git continue merge rejects untracked files before committing staged merge resolution", async () => {
  const repo = await createConflictedRepo();
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-untracked-continue",
    workstreamId: "ws-untracked-continue",
    repoRoot: repo.path,
    expectedHeadSha: repo.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    await writeFile(path.join(repo.path, "file.txt"), "main change\nfeature change\n", "utf8");
    const marked = await service.callTool("backburner_git_mark_resolved", {
      backburnerGitSessionId: "session-untracked-continue",
      paths: ["file.txt"]
    });
    assert.equal(marked.ok, true);

    await writeFile(path.join(repo.path, "scratch.log"), "temporary output\n", "utf8");
    const continued = await service.callTool("backburner_git_continue_merge", {
      backburnerGitSessionId: "session-untracked-continue"
    });

    assert.equal(continued.ok, false);
    assert.equal(continued.ok ? undefined : continued.error.code, "dirty_worktree");
    assert.match(continued.ok ? "" : continued.error.message, /untracked: scratch\.log/);
    assert.match(continued.ok ? "" : continued.error.message, /Remove unintended untracked files/);

    await rm(path.join(repo.path, "scratch.log"));
    const retried = await service.callTool("backburner_git_continue_merge", {
      backburnerGitSessionId: "session-untracked-continue"
    });

    assert.equal(retried.ok, true);
    assert.match((retried as any).result.commitSha, /^[0-9a-f]{40}$/);
    assert.deepEqual((retried as any).result.state.untrackedFiles, []);
  } finally {
    await rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git mark deleted handles staged-different files deleted from the worktree", async () => {
  const repo = await createConflictedRepo();
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-md-delete",
    workstreamId: "ws-md-delete",
    repoRoot: repo.path,
    expectedHeadSha: repo.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    await writeFile(path.join(repo.path, "file.txt"), "main change\nfeature change\n", "utf8");
    const marked = await service.callTool("backburner_git_mark_resolved", {
      backburnerGitSessionId: "session-md-delete",
      paths: ["file.txt"]
    });
    assert.equal(marked.ok, true);

    await rm(path.join(repo.path, "file.txt"));
    const rejected = await service.callTool("backburner_git_continue_merge", {
      backburnerGitSessionId: "session-md-delete"
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? undefined : rejected.error.code, "dirty_worktree");
    assert.match(rejected.ok ? "" : rejected.error.message, /backburner_git_mark_deleted/);

    const deleted = await service.callTool("backburner_git_mark_deleted", {
      backburnerGitSessionId: "session-md-delete",
      paths: ["file.txt"]
    });
    assert.equal(deleted.ok, true);
    assert.deepEqual((deleted as any).result.state.unstagedFiles, []);
    assert.deepEqual((deleted as any).result.state.stagedFiles, ["file.txt"]);

    const alreadyDeleted = await service.callTool("backburner_git_mark_deleted", {
      backburnerGitSessionId: "session-md-delete",
      paths: ["file.txt"]
    });
    assert.equal(alreadyDeleted.ok, false);
    assert.equal(alreadyDeleted.ok ? undefined : alreadyDeleted.error.code, "path_not_deleted");

    const continued = await service.callTool("backburner_git_continue_merge", {
      backburnerGitSessionId: "session-md-delete"
    });
    assert.equal(continued.ok, true);
    assert.match((continued as any).result.commitSha, /^[0-9a-f]{40}$/);
  } finally {
    await rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git mark deleted rejects non-deleted modified files", async () => {
  const repo = await createConflictedRepo();
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-delete-reject",
    workstreamId: "ws-delete-reject",
    repoRoot: repo.path,
    expectedHeadSha: repo.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    await writeFile(path.join(repo.path, "file.txt"), "main change\nfeature change\n", "utf8");
    const marked = await service.callTool("backburner_git_mark_resolved", {
      backburnerGitSessionId: "session-delete-reject",
      paths: ["file.txt"]
    });
    assert.equal(marked.ok, true);

    const rejected = await service.callTool("backburner_git_mark_deleted", {
      backburnerGitSessionId: "session-delete-reject",
      paths: ["file.txt"]
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? undefined : rejected.error.code, "path_not_deleted");

    const state = await service.callTool("backburner_git_get_state", { backburnerGitSessionId: "session-delete-reject" });
    assert.equal(state.ok, true);
    assert.deepEqual((state as any).result.stagedFiles, ["file.txt"]);
    assert.deepEqual((state as any).result.unstagedFiles, []);
  } finally {
    await rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git mark deleted rejects unresolved non-deletion conflicts", async () => {
  const repo = await createConflictedRepo();
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-delete-uu-reject",
    workstreamId: "ws-delete-uu-reject",
    repoRoot: repo.path,
    expectedHeadSha: repo.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    const rejected = await service.callTool("backburner_git_mark_deleted", {
      backburnerGitSessionId: "session-delete-uu-reject",
      paths: ["file.txt"]
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? undefined : rejected.error.code, "path_not_deleted");

    const conflicts = await service.callTool("backburner_git_get_conflicts", {
      backburnerGitSessionId: "session-delete-uu-reject"
    });
    assert.equal(conflicts.ok, true);
    assert.deepEqual((conflicts as any).result.conflicts.map((conflict: any) => conflict.path), ["file.txt"]);
  } finally {
    await rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git continue merge reports DD entries as unresolved conflicts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-git-tools-dd-"));
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(path.join(repoPath, ".git"), { recursive: true });
  await writeFile(path.join(repoPath, ".git", "MERGE_HEAD"), "main\n", "utf8");
  const commands: string[] = [];
  const service = new BackburnerGitToolService({
    async run(command: string, args: string[]) {
      commands.push([command, ...args].join(" "));
      if (args.join(" ") === "rev-parse --git-dir") {
        return { stdout: ".git\n", stderr: "", exitCode: 0 };
      }
      if (args.join(" ") === "status --porcelain") {
        return { stdout: "DD file.txt\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }
  }, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-dd-continue",
    workstreamId: "ws-dd-continue",
    repoRoot: repoPath,
    expectedHeadSha: "head-sha",
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    const rejected = await service.callTool("backburner_git_continue_merge", {
      backburnerGitSessionId: "session-dd-continue"
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? undefined : rejected.error.code, "unresolved_conflicts");
    assert.match(rejected.ok ? "" : rejected.error.message, /file\.txt/);
    assert.ok(!commands.includes("git commit --no-edit"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git diff normalizes native repo-relative separators before invoking Git", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-git-tools-paths-"));
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(repoPath, { recursive: true });

  const commands: string[][] = [];
  const service = new BackburnerGitToolService({
    async run(command: string, args: string[]) {
      commands.push([command, ...args]);
      const invocation = args.join(" ");
      if (invocation === "status --porcelain") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (invocation === "ls-files") {
        return { stdout: "nested/file.txt\n", stderr: "", exitCode: 0 };
      }
      if (invocation === "diff -- nested/file.txt") {
        return { stdout: "diff --git a/nested/file.txt b/nested/file.txt\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }
  }, logger);

  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-native-separators",
    workstreamId: "ws-native-separators",
    repoRoot: repoPath,
    expectedHeadSha: "head-sha",
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    const result = await service.callTool("backburner_git_get_diff", {
      backburnerGitSessionId: "session-native-separators",
      options: {
        staged: false,
        unstaged: true,
        path: path.join("nested", "file.txt")
      }
    });

    assert.equal(result.ok, true);
    assert.equal((result as any).result.path, "nested/file.txt");
    assert.deepEqual(commands.at(-1), ["git", "diff", "--", "nested/file.txt"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git diff accepts Windows-style repo-relative separators on any host", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-git-tools-windows-paths-"));
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(repoPath, { recursive: true });

  const commands: string[][] = [];
  const service = new BackburnerGitToolService({
    async run(command: string, args: string[]) {
      commands.push([command, ...args]);
      const invocation = args.join(" ");
      if (invocation === "status --porcelain") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (invocation === "ls-files") {
        return { stdout: "nested/file.txt\n", stderr: "", exitCode: 0 };
      }
      if (invocation === "diff -- nested/file.txt") {
        return { stdout: "diff --git a/nested/file.txt b/nested/file.txt\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }
  }, logger);

  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-windows-separators",
    workstreamId: "ws-windows-separators",
    repoRoot: repoPath,
    expectedHeadSha: "head-sha",
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    const result = await service.callTool("backburner_git_get_diff", {
      backburnerGitSessionId: "session-windows-separators",
      options: {
        staged: false,
        unstaged: true,
        path: "nested\\file.txt"
      }
    });

    assert.equal(result.ok, true);
    assert.equal((result as any).result.path, "nested/file.txt");
    assert.deepEqual(commands.at(-1), ["git", "diff", "--", "nested/file.txt"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git tools reject Windows-style path escapes and absolute paths", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-git-tools-windows-escapes-"));
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(repoPath, { recursive: true });

  const service = new BackburnerGitToolService({
    async run(_command: string, args: string[]) {
      if (args.join(" ") === "status --porcelain") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args.join(" ") === "ls-files") {
        return { stdout: "nested/file.txt\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    }
  }, logger);

  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-windows-escapes",
    workstreamId: "ws-windows-escapes",
    repoRoot: repoPath,
    expectedHeadSha: "head-sha",
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    for (const badPath of [
      "..\\outside.txt",
      "nested\\..\\..\\outside.txt",
      "C:\\code\\file.txt",
      "C:relative.txt",
      "C:..\\outside.txt",
      "D:file.txt",
      "\\\\server\\share\\file.txt"
    ]) {
      const result = await service.callTool("backburner_git_get_diff", {
        backburnerGitSessionId: "session-windows-escapes",
        options: {
          staged: false,
          unstaged: true,
          path: badPath
        }
      });

      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.error.code, "invalid_path");
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git restore worktree recovers an accidentally deleted staged resolution", async () => {
  const repo = await createConflictedRepo();
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-restore-worktree",
    workstreamId: "ws-restore-worktree",
    repoRoot: repo.path,
    expectedHeadSha: repo.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    await writeFile(path.join(repo.path, "file.txt"), "main change\nfeature change\n", "utf8");
    const marked = await service.callTool("backburner_git_mark_resolved", {
      backburnerGitSessionId: "session-restore-worktree",
      paths: ["file.txt"]
    });
    assert.equal(marked.ok, true);

    await rm(path.join(repo.path, "file.txt"));
    const rejected = await service.callTool("backburner_git_continue_merge", {
      backburnerGitSessionId: "session-restore-worktree"
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? undefined : rejected.error.code, "dirty_worktree");
    assert.match(rejected.ok ? "" : rejected.error.message, /backburner_git_restore_worktree/);

    const restored = await service.callTool("backburner_git_restore_worktree", {
      backburnerGitSessionId: "session-restore-worktree",
      paths: ["file.txt"]
    });
    assert.equal(restored.ok, true);
    assert.deepEqual((restored as any).result.state.stagedFiles, ["file.txt"]);
    assert.deepEqual((restored as any).result.state.unstagedFiles, []);

    const alreadyClean = await service.callTool("backburner_git_restore_worktree", {
      backburnerGitSessionId: "session-restore-worktree",
      paths: ["file.txt"]
    });
    assert.equal(alreadyClean.ok, false);
    assert.equal(alreadyClean.ok ? undefined : alreadyClean.error.code, "path_not_restorable");
    assert.match(alreadyClean.ok ? "" : alreadyClean.error.message, /backburner_git_unstage/);

    const continued = await service.callTool("backburner_git_continue_merge", {
      backburnerGitSessionId: "session-restore-worktree"
    });
    assert.equal(continued.ok, true);
    assert.match((continued as any).result.commitSha, /^[0-9a-f]{40}$/);
  } finally {
    await rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git abort makes merge-prep session terminal for resolution tools", async () => {
  const repo = await createConflictedRepo();
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "session-abort",
    workstreamId: "ws-abort",
    repoRoot: repo.path,
    expectedHeadSha: repo.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    const aborted = await service.callTool("backburner_git_abort_merge", { backburnerGitSessionId: "session-abort" });
    assert.equal(aborted.ok, true);

    const marked = await service.callTool("backburner_git_mark_resolved", {
      backburnerGitSessionId: "session-abort",
      paths: ["file.txt"]
    });
    const unstaged = await service.callTool("backburner_git_unstage", {
      backburnerGitSessionId: "session-abort",
      paths: ["file.txt"]
    });
    const continued = await service.callTool("backburner_git_continue_merge", { backburnerGitSessionId: "session-abort" });

    assert.equal(marked.ok, false);
    assert.equal(marked.ok ? undefined : marked.error.code, "invalid_workstream_state");
    assert.match(marked.ok ? "" : marked.error.message, /session-abort/);
    assert.match(marked.ok ? "" : marked.error.message, /merge_aborted/);
    assert.equal(unstaged.ok, false);
    assert.equal(unstaged.ok ? undefined : unstaged.error.code, "invalid_workstream_state");
    assert.match(unstaged.ok ? "" : unstaged.error.message, /session-abort/);
    assert.match(unstaged.ok ? "" : unstaged.error.message, /merge_aborted/);
    assert.equal(continued.ok, false);
    assert.equal(continued.ok ? undefined : continued.error.code, "invalid_workstream_state");
    assert.match(continued.ok ? "" : continued.error.message, /session-abort/);
    assert.match(continued.ok ? "" : continued.error.message, /merge_aborted/);
  } finally {
    await rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git tools keep packet merge-prep sessions distinct for one parent workstream", async () => {
  const repoA = await createConflictedRepo("packet-a");
  const repoB = await createConflictedRepo("packet-b");
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "task:prepare_pr_for_merge:owner/repo#327",
    workstreamId: "owner/repo:issue:319",
    repoRoot: repoA.path,
    expectedHeadSha: repoA.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "task:prepare_pr_for_merge:owner/repo#329",
    workstreamId: "owner/repo:issue:319",
    repoRoot: repoB.path,
    expectedHeadSha: repoB.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    const versionsA = await service.callTool("backburner_git_get_conflict_versions", {
      backburnerGitSessionId: "task:prepare_pr_for_merge:owner/repo#327",
      path: "file.txt"
    });
    const versionsB = await service.callTool("backburner_git_get_conflict_versions", {
      backburnerGitSessionId: "task:prepare_pr_for_merge:owner/repo#329",
      path: "file.txt"
    });

    assert.equal(versionsA.ok, true);
    assert.equal(versionsB.ok, true);
    assert.match((versionsA as any).result.current, /packet-a/);
    assert.match((versionsB as any).result.current, /packet-b/);

    service.unregisterBackburnerGitSession("task:prepare_pr_for_merge:owner/repo#327");

    const unregistered = await service.callTool("backburner_git_get_state", {
      backburnerGitSessionId: "task:prepare_pr_for_merge:owner/repo#327"
    });
    const stillRegistered = await service.callTool("backburner_git_get_state", {
      backburnerGitSessionId: "task:prepare_pr_for_merge:owner/repo#329"
    });

    assert.equal(unregistered.ok, false);
    assert.equal(unregistered.ok ? undefined : unregistered.error.code, "unknown_workstream");
    assert.equal(stillRegistered.ok, true);
  } finally {
    await rm(repoA.tempRoot, { recursive: true, force: true });
    await rm(repoB.tempRoot, { recursive: true, force: true });
  }
});

test("Backburner Git tools reject duplicate session IDs instead of overwriting", async () => {
  const repoA = await createConflictedRepo("packet-a");
  const repoB = await createConflictedRepo("packet-b");
  const service = new BackburnerGitToolService(runner, logger);
  service.registerPrepareForMergeWorkstream({
    backburnerGitSessionId: "task:prepare_pr_for_merge:owner/repo#327",
    workstreamId: "owner/repo:issue:319",
    repoRoot: repoA.path,
    expectedHeadSha: repoA.featureHeadSha,
    baseRef: "main",
    currentBranch: "feature",
    state: "merge_conflict"
  });

  try {
    assert.throws(
      () => service.registerPrepareForMergeWorkstream({
        backburnerGitSessionId: "task:prepare_pr_for_merge:owner/repo#327",
        workstreamId: "owner/repo:issue:319",
        repoRoot: repoB.path,
        expectedHeadSha: repoB.featureHeadSha,
        baseRef: "main",
        currentBranch: "feature",
        state: "merge_conflict"
      }),
      /already registered/
    );

    const versions = await service.callTool("backburner_git_get_conflict_versions", {
      backburnerGitSessionId: "task:prepare_pr_for_merge:owner/repo#327",
      path: "file.txt"
    });
    assert.equal(versions.ok, true);
    assert.match((versions as any).result.current, /packet-a/);
  } finally {
    await rm(repoA.tempRoot, { recursive: true, force: true });
    await rm(repoB.tempRoot, { recursive: true, force: true });
  }
});

async function createConflictedRepo(label = "default"): Promise<{
  tempRoot: string;
  path: string;
  featureHeadSha: string;
}> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "backburner-git-tools-"));
  const repoPath = path.join(tempRoot, "repo");
  await mkdir(repoPath);
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "backburner@example.test"]);
  await git(repoPath, ["config", "user.name", "Backburner Test"]);

  await writeFile(path.join(repoPath, "file.txt"), "initial\n", "utf8");
  await git(repoPath, ["add", "--", "file.txt"]);
  await git(repoPath, ["commit", "-m", "initial"]);

  await git(repoPath, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repoPath, "file.txt"), `feature change ${label}\n`, "utf8");
  await git(repoPath, ["commit", "-am", "feature change"]);
  const featureHeadSha = (await git(repoPath, ["rev-parse", "HEAD"])).stdout.trim();

  await git(repoPath, ["checkout", "main"]);
  await writeFile(path.join(repoPath, "file.txt"), `main change ${label}\n`, "utf8");
  await git(repoPath, ["commit", "-am", "main change"]);

  await git(repoPath, ["checkout", "feature"]);
  try {
    await git(repoPath, ["merge", "--no-edit", "main"]);
  } catch (error) {
    if (!(error instanceof CommandExecutionError)) {
      throw error;
    }
  }

  return { tempRoot, path: repoPath, featureHeadSha };
}

async function git(cwd: string, args: string[]) {
  return await runner.run("git", args, { cwd });
}
