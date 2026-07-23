import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { RepoConfig } from "../src/config/types.js";
import { GitCliGateway } from "../src/git/types.js";
import {
  CommandExecutionError,
  type CommandRunner,
  type CommandRunnerOptions,
  type CommandRunnerResult
} from "../src/utils/command-runner.js";

class RecordingCommandRunner implements CommandRunner {
  public readonly calls: Array<{
    command: string;
    args: string[];
    options: CommandRunnerOptions;
  }> = [];

  async run(
    command: string,
    args: string[],
    options: CommandRunnerOptions = {}
  ): Promise<CommandRunnerResult> {
    this.calls.push({ command, args, options });
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

interface QueuedResult extends CommandRunnerResult {
  throws?: boolean;
}

class SequenceCommandRunner implements CommandRunner {
  public readonly calls: Array<{
    command: string;
    args: string[];
    options: CommandRunnerOptions;
  }> = [];

  constructor(private readonly results: QueuedResult[]) {}

  async run(
    command: string,
    args: string[],
    options: CommandRunnerOptions = {}
  ): Promise<CommandRunnerResult> {
    this.calls.push({ command, args, options });
    const result = this.results.shift();
    if (!result) {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }
    if (result.throws) {
      throw new CommandExecutionError(
        result.stderr || "command failed",
        command,
        args,
        result.exitCode,
        result.stdout,
        result.stderr
      );
    }
    return result;
  }
}

function repoConfig(): RepoConfig {
  return {
    id: "repo-1",
    owner: "example-org",
    name: "repo-one",
    localPath: "repo-one",
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

test("GitCliGateway.cloneRepository creates the destination parent and runs clone from it", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-git-clone-"));

  try {
    const destinationPath = path.join(tempDir, "nested", "repo-one");
    await gateway.cloneRepository(repoConfig(), destinationPath);

    assert.strictEqual(runner.calls.length, 1);
    const call = runner.calls[0]!;

    assert.strictEqual(call.command, "git");
    assert.deepEqual(call.args, ["clone", "git@github.com:example-org/repo-one.git", destinationPath]);
    assert.strictEqual(call.options.cwd, path.dirname(destinationPath));

  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitCliGateway.compareBranchSyncStatus: up_to_date (ahead=0, behind=0)", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "ok", stderr: "", exitCode: 0 }, // show-ref default
    { stdout: "ok", stderr: "", exitCode: 0 }, // show-ref parent
    { stdout: "0\t0\n", stderr: "", exitCode: 0 } // rev-list
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "up_to_date");
  assert.strictEqual(result.parentAheadCount, 0);
  assert.strictEqual(result.parentBehindCount, 0);
  assert.strictEqual(result.message, "Parent branch contains the default branch.");
});

test("GitCliGateway.compareBranchSyncStatus: up_to_date (ahead=5, behind=0)", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "0\t5\n", stderr: "", exitCode: 0 }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "up_to_date");
  assert.strictEqual(result.parentAheadCount, 5);
  assert.strictEqual(result.parentBehindCount, 0);
});

test("GitCliGateway.compareBranchSyncStatus: behind_default (ahead=0, behind=3)", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "3\t0\n", stderr: "", exitCode: 0 }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "behind_default");
  assert.strictEqual(result.parentAheadCount, 0);
  assert.strictEqual(result.parentBehindCount, 3);
  assert.strictEqual(result.message, "Parent branch is behind the default branch.");
});

test("GitCliGateway.compareBranchSyncStatus: diverged (ahead=2, behind=4)", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "4\t2\n", stderr: "", exitCode: 0 }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "diverged");
  assert.strictEqual(result.parentAheadCount, 2);
  assert.strictEqual(result.parentBehindCount, 4);
  assert.strictEqual(result.message, "Parent branch and default branch have diverged.");
});

test("GitCliGateway.compareBranchSyncStatus: missing_default_branch", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "ok", stderr: "", exitCode: 0 }, // show-ref parent
    { stdout: "", stderr: "fatal: ...", exitCode: 1, throws: true }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "missing_default_branch");
  assert.strictEqual(result.message, "Default branch ref was not found locally.");
});

test("GitCliGateway.compareBranchSyncStatus: missing_parent_branch", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "fatal: ...", exitCode: 1, throws: true }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "missing_parent_branch");
  assert.strictEqual(result.message, "Parent branch ref was not found locally.");
});

test("GitCliGateway.compareBranchSyncStatus reports a missing parent when both refs are absent", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "fatal: ...", exitCode: 1, throws: true }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "missing_parent_branch");
  assert.strictEqual(runner.calls.length, 1);
});

test("GitCliGateway.compareBranchSyncStatus: unknown (show-ref fatal error)", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "fatal: not a git repo", exitCode: 128, throws: true }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "unknown");
  assert.strictEqual(result.message, "Could not compare branch sync status.");
});

test("GitCliGateway.compareBranchSyncStatus: unknown (rev-list failure)", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "fatal: ...", exitCode: 128, throws: true }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "unknown");
  assert.strictEqual(result.message, "Could not compare branch sync status.");
});

test("GitCliGateway.compareBranchSyncStatus: unknown (unparsable output)", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "not-a-count\n", stderr: "", exitCode: 0 }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  assert.strictEqual(result.status, "unknown");
  assert.strictEqual(result.message, "Could not compare branch sync status.");
});

test("GitCliGateway.compareBranchSyncStatus: happy path calls correct commands", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "1\t2\n", stderr: "", exitCode: 0 }
  ]);
  const gateway = new GitCliGateway(runner);
  await gateway.compareBranchSyncStatus("/tmp/code", "agent/my-feature", "main");

  assert.strictEqual(runner.calls.length, 3);

  assert.deepEqual(runner.calls[0]!.args, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/agent/my-feature"]);
  assert.deepEqual(runner.calls[1]!.args, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"]);
  assert.deepEqual(runner.calls[2]!.args, [
    "rev-list",
    "--left-right",
    "--count",
    "refs/remotes/origin/main...refs/remotes/origin/agent/my-feature"
  ]);

  for (const call of runner.calls) {
    assert.strictEqual(call.command, "git");
    assert.strictEqual(call.options.cwd, "/tmp/code");
  }
});

test("GitCliGateway.compareBranchSyncStatus does not call forbidden commands", async () => {
  const forbiddenCommands = new Set(["fetch", "checkout", "merge", "rebase", "reset", "push", "update-ref"]);
  const runner = new SequenceCommandRunner([
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "ok", stderr: "", exitCode: 0 },
    { stdout: "0\t0\n", stderr: "", exitCode: 0 }
  ]);
  const gateway = new GitCliGateway(runner);
  await gateway.compareBranchSyncStatus("/tmp", "agent/feat", "main");

  for (const call of runner.calls) {
    assert.strictEqual(call.command, "git");
    const subCommand = call.args[0] ?? "";
    assert.ok(!forbiddenCommands.has(subCommand), `Command '${subCommand}' is forbidden`);
    assert.notDeepEqual(call.args.slice(0, 2), ["branch", "-f"], "Force-updating branches is forbidden");
  }
});

test("GitCliGateway.checkoutBranch calls git checkout", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.checkoutBranch("/tmp", "feature-branch");

  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], {
    command: "git",
    args: ["checkout", "feature-branch"],
    options: { cwd: "/tmp" }
  });
});

test("GitCliGateway.mergeRemoteBranch calls git merge --no-edit", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.mergeRemoteBranch("/tmp", "origin", "main");

  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], {
    command: "git",
    args: ["merge", "--no-edit", "origin/main"],
    options: { cwd: "/tmp" }
  });
});

test("GitCliGateway.abortMerge calls git merge --abort", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.abortMerge("/tmp");

  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], {
    command: "git",
    args: ["merge", "--abort"],
    options: { cwd: "/tmp" }
  });
});

test("GitCliGateway.abortRebase calls git rebase --abort", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.abortRebase("/tmp");

  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], {
    command: "git",
    args: ["rebase", "--abort"],
    options: { cwd: "/tmp" }
  });
});

test("GitCliGateway.abortCherryPick calls git cherry-pick --abort", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.abortCherryPick("/tmp");

  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], {
    command: "git",
    args: ["cherry-pick", "--abort"],
    options: { cwd: "/tmp" }
  });
});

test("GitCliGateway.abortRevert calls git revert --abort", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.abortRevert("/tmp");

  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0], {
    command: "git",
    args: ["revert", "--abort"],
    options: { cwd: "/tmp" }
  });
});

test("GitCliGateway.isInsideWorkingTree returns true when git rev-parse returns true", async () => {
  const runner = new SequenceCommandRunner([{ stdout: "true\n", stderr: "", exitCode: 0 }]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.isInsideWorkingTree(os.tmpdir());

  assert.strictEqual(result, true);
  assert.deepEqual(runner.calls[0]!.args, ["rev-parse", "--is-inside-work-tree"]);
});

test("GitCliGateway.isInsideWorkingTree returns false when path does not exist", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  const result = await gateway.isInsideWorkingTree(path.join(os.tmpdir(), "non-existent-dir-12345"));

  assert.strictEqual(result, false);
  assert.strictEqual(runner.calls.length, 0); // Should not even call git
});

test("GitCliGateway.isInsideWorkingTree returns false when git rev-parse fails with 'not a git repository'", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git", exitCode: 128, throws: true }
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.isInsideWorkingTree(os.tmpdir());

  assert.strictEqual(result, false);
});

test("GitCliGateway.isInsideWorkingTree throws on unexpected command failures", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "fatal: some other error", exitCode: 1, throws: true }
  ]);
  const gateway = new GitCliGateway(runner);
  await assert.rejects(
    gateway.isInsideWorkingTree(os.tmpdir()),
    (err: any) => err instanceof CommandExecutionError && err.stderr.includes("some other error")
  );
});

test("GitCliGateway.pullFastForwardOnly runs git pull --ff-only", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.pullFastForwardOnly("/tmp");

  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]!.args, ["pull", "--ff-only"]);
});

test("GitCliGateway.getHeadCommitSha returns the trimmed HEAD SHA", async () => {
  const runner = new SequenceCommandRunner([{ stdout: "abc123456789\n", stderr: "", exitCode: 0 }]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.getHeadCommitSha("/tmp");

  assert.strictEqual(result, "abc123456789");
  assert.deepEqual(runner.calls[0]!.args, ["rev-parse", "HEAD"]);
});

test("GitCliGateway.isWorkingTreeClean calls git status --porcelain .", async () => {
  const runner = new SequenceCommandRunner([{ stdout: "", stderr: "", exitCode: 0 }]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.isWorkingTreeClean("/tmp/outputs");

  assert.strictEqual(result, true);
  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]!.args, ["status", "--porcelain", "."]);
  assert.strictEqual(runner.calls[0]!.options.cwd, "/tmp/outputs");
});

test("GitCliGateway.commitAll calls git add --all ., status, and commit .", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "", exitCode: 0 }, // add
    { stdout: "A  file.txt\n", stderr: "", exitCode: 0 }, // status
    { stdout: "", stderr: "", exitCode: 0 } // commit
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.commitAll("/tmp/outputs", "Record run");

  assert.strictEqual(result, true);
  assert.strictEqual(runner.calls.length, 3);
  assert.deepEqual(runner.calls[0]!.args, ["add", "--all", "."]);
  assert.deepEqual(runner.calls[1]!.args, ["status", "--porcelain", "."]);
  assert.deepEqual(runner.calls[2]!.args, ["commit", "-m", "Record run", "."]);
  for (const call of runner.calls) {
    assert.strictEqual(call.options.cwd, "/tmp/outputs");
  }
});

test("GitCliGateway.commitAll returns false if nothing to commit", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "", exitCode: 0 }, // add
    { stdout: "", stderr: "", exitCode: 0 } // status (empty)
  ]);
  const gateway = new GitCliGateway(runner);
  const result = await gateway.commitAll("/tmp/outputs", "Record run");

  assert.strictEqual(result, false);
  assert.strictEqual(runner.calls.length, 2);
  assert.deepEqual(runner.calls[1]!.args, ["status", "--porcelain", "."]);
});

test("GitCliGateway.cloneRepositoryFromUrl runs git clone", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clone-url-"));
  try {
    const destinationPath = path.join(tempDir, "repo");
    await gateway.cloneRepositoryFromUrl("git@github.com:foo/bar.git", destinationPath);

    assert.strictEqual(runner.calls.length, 1);
    assert.deepEqual(runner.calls[0], {
      command: "git",
      args: ["clone", "git@github.com:foo/bar.git", destinationPath],
      options: { cwd: tempDir }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitCliGateway.checkoutBranchAtRemote runs fetch and checkout -B", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.checkoutBranchAtRemote("/path", "feat");

  assert.strictEqual(runner.calls.length, 2);
  assert.deepEqual(runner.calls[0]!.args, ["fetch", "origin"]);
  assert.deepEqual(runner.calls[1]!.args, ["checkout", "-B", "feat", "origin/feat"]);
  for (const call of runner.calls) {
    assert.strictEqual(call.options.cwd, "/path");
  }
});

test("GitCliGateway.checkoutBranchAtRemote skips fetch if options.skipFetch is true", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.checkoutBranchAtRemote("/path", "feat", { skipFetch: true });

  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]!.args, ["checkout", "-B", "feat", "origin/feat"]);
  assert.strictEqual(runner.calls[0]!.options.cwd, "/path");
});

test("GitCliGateway.getAheadBehindVsRemote parses rev-list output", async () => {
  const runner = new SequenceCommandRunner([{ stdout: "3\t1\n", stderr: "", exitCode: 0 }]);
  const gateway = new GitCliGateway(runner);
  const res = await gateway.getAheadBehindVsRemote("/path", "feat");

  assert.deepStrictEqual(res, { behind: 3, ahead: 1 });
  assert.deepEqual(runner.calls[0]!.args, ["rev-list", "--left-right", "--count", "origin/feat...HEAD"]);
  assert.strictEqual(runner.calls[0]!.options.cwd, "/path");
});

test("GitCliGateway.isAncestorOf returns true if merge-base --is-ancestor succeeds", async () => {
  const runner = new SequenceCommandRunner([{ stdout: "", stderr: "", exitCode: 0 }]);
  const gateway = new GitCliGateway(runner);
  const res = await gateway.isAncestorOf("/path", "sha1", "sha2");
  assert.strictEqual(res, true);
  assert.deepEqual(runner.calls[0]!.args, ["merge-base", "--is-ancestor", "sha1", "sha2"]);
});

test("GitCliGateway.isAncestorOf returns false if merge-base --is-ancestor fails", async () => {
  const runner = new SequenceCommandRunner([{ stdout: "", stderr: "", exitCode: 1, throws: true }]);
  const gateway = new GitCliGateway(runner);
  const res = await gateway.isAncestorOf("/path", "sha1", "sha2");
  assert.strictEqual(res, false);
});

test("GitCliGateway.isAncestorOf returns true immediately if SHAs are equal", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  const res = await gateway.isAncestorOf("/path", "sha", "sha");
  assert.strictEqual(res, true);
  assert.strictEqual(runner.calls.length, 0);
});

test("GitCliGateway.countCommitsAheadOf parses rev-list --count output", async () => {
  const runner = new SequenceCommandRunner([{ stdout: "4\n", stderr: "", exitCode: 0 }]);
  const gateway = new GitCliGateway(runner);
  const res = await gateway.countCommitsAheadOf("/path", "base-sha");
  assert.strictEqual(res, 4);
  assert.deepEqual(runner.calls[0]!.args, ["rev-list", "--count", "base-sha..HEAD"]);
});

test("GitCliGateway.getActiveMergeState detects merging (MERGE_HEAD)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "git-state-"));
  try {
    const runner = new SequenceCommandRunner([{ stdout: tempDir + "\n", stderr: "", exitCode: 0 }]);
    const gateway = new GitCliGateway(runner);
    await writeFile(path.join(tempDir, "MERGE_HEAD"), "abc");
    assert.strictEqual(await gateway.getActiveMergeState("/dummy"), "merging");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitCliGateway.getActiveMergeState detects rebasing (REBASE_HEAD)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "git-state-"));
  try {
    const runner = new SequenceCommandRunner([{ stdout: tempDir + "\n", stderr: "", exitCode: 0 }]);
    const gateway = new GitCliGateway(runner);
    await writeFile(path.join(tempDir, "REBASE_HEAD"), "abc");
    assert.strictEqual(await gateway.getActiveMergeState("/dummy"), "rebasing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitCliGateway.getActiveMergeState detects cherry-picking (CHERRY_PICK_HEAD)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "git-state-"));
  try {
    const runner = new SequenceCommandRunner([{ stdout: tempDir + "\n", stderr: "", exitCode: 0 }]);
    const gateway = new GitCliGateway(runner);
    await writeFile(path.join(tempDir, "CHERRY_PICK_HEAD"), "abc");
    assert.strictEqual(await gateway.getActiveMergeState("/dummy"), "cherry-picking");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitCliGateway.getActiveMergeState detects reverting (REVERT_HEAD)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "git-state-"));
  try {
    const runner = new SequenceCommandRunner([{ stdout: tempDir + "\n", stderr: "", exitCode: 0 }]);
    const gateway = new GitCliGateway(runner);
    await writeFile(path.join(tempDir, "REVERT_HEAD"), "abc");
    assert.strictEqual(await gateway.getActiveMergeState("/dummy"), "reverting");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitCliGateway.getActiveMergeState detects rebasing (rebase-merge dir)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "git-state-"));
  try {
    const runner = new SequenceCommandRunner([{ stdout: tempDir + "\n", stderr: "", exitCode: 0 }]);
    const gateway = new GitCliGateway(runner);
    await mkdir(path.join(tempDir, "rebase-merge"));
    assert.strictEqual(await gateway.getActiveMergeState("/dummy"), "rebasing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitCliGateway.getActiveMergeState detects rebasing (rebase-apply dir)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "git-state-"));
  try {
    const runner = new SequenceCommandRunner([{ stdout: tempDir + "\n", stderr: "", exitCode: 0 }]);
    const gateway = new GitCliGateway(runner);
    await mkdir(path.join(tempDir, "rebase-apply"));
    assert.strictEqual(await gateway.getActiveMergeState("/dummy"), "rebasing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitCliGateway.getActiveMergeState detects none", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "git-state-"));
  try {
    const runner = new SequenceCommandRunner([{ stdout: tempDir + "\n", stderr: "", exitCode: 0 }]);
    const gateway = new GitCliGateway(runner);
    assert.strictEqual(await gateway.getActiveMergeState("/dummy"), "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("GitCliGateway.pushWithLease runs git push --force-with-lease", async () => {
  const runner = new RecordingCommandRunner();
  const gateway = new GitCliGateway(runner);
  await gateway.pushWithLease("/path", "feat", "old-sha");

  assert.strictEqual(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]!.args, [
    "push",
    `--force-with-lease=refs/heads/feat:old-sha`,
    "origin",
    `HEAD:refs/heads/feat`
  ]);
  assert.strictEqual(runner.calls[0]!.options.cwd, "/path");
});

test("GitCliGateway.removeDirectory calls rm -rf", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "rm-dir-test-"));
  const gateway = new GitCliGateway({} as any);
  await gateway.removeDirectory(tempDir);

  try {
    await stat(tempDir);
    assert.fail("Directory should be removed");
  } catch (err: any) {
    assert.strictEqual(err.code, "ENOENT");
  }
});

test("GitCliGateway.createWorktree preserves the requested start point by default", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "", exitCode: 0 }
  ]);
  const gateway = new GitCliGateway(runner);

  await gateway.createWorktree(
    "/code/repo-one",
    "/code",
    "/code/_worktrees/example-org/repo-one/issue-17",
    "agent/issue-17",
    "origin/agent/issue-17"
  );

  assert.deepEqual(runner.calls.map((call) => call.args), [
    [
      "worktree",
      "add",
      "-b",
      "agent/issue-17",
      path.resolve("/code/_worktrees/example-org/repo-one/issue-17"),
      "origin/agent/issue-17"
    ]
  ]);
});

test("GitCliGateway.createWorktree can recreate a pruned branch for recovery", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "missing", exitCode: 1, throws: true },
    { stdout: "", stderr: "", exitCode: 0 }
  ]);
  const gateway = new GitCliGateway(runner);

  await gateway.createWorktree(
    "/code/repo-one",
    "/code",
    "/code/_worktrees/example-org/repo-one/issue-17",
    "agent/issue-17",
    "origin/agent/issue-17",
    { reuseExistingBranch: true }
  );

  assert.deepEqual(runner.calls.map((call) => call.args), [
    ["worktree", "prune"],
    ["show-ref", "--verify", "--quiet", "refs/heads/agent/issue-17"],
    [
      "worktree",
      "add",
      "-b",
      "agent/issue-17",
      path.resolve("/code/_worktrees/example-org/repo-one/issue-17"),
      "origin/agent/issue-17"
    ]
  ]);
});

test("GitCliGateway.createWorktree reuses an existing local branch only for recovery", async () => {
  const runner = new SequenceCommandRunner([
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 }
  ]);
  const gateway = new GitCliGateway(runner);

  await gateway.createWorktree(
    "/code/repo-one",
    "/code",
    "/code/_worktrees/example-org/repo-one/issue-17",
    "agent/issue-17",
    "origin/agent/issue-17",
    { reuseExistingBranch: true }
  );

  assert.deepEqual(runner.calls[2]?.args, [
    "worktree",
    "add",
    path.resolve("/code/_worktrees/example-org/repo-one/issue-17"),
    "agent/issue-17"
  ]);
});

test("GitCliGateway.getCommitLogSince returns trimmed output", async () => {
  const runner = new SequenceCommandRunner([{ stdout: " abc commit\n", stderr: "", exitCode: 0 }]);
  const gateway = new GitCliGateway(runner);
  const res = await gateway.getCommitLogSince("/path", "base-sha");
  assert.strictEqual(res, "abc commit");
  assert.deepEqual(runner.calls[0]!.args, ["log", "--oneline", "base-sha..HEAD"]);
});

test("GitCliGateway.getDiffStatSince returns trimmed output", async () => {
  const runner = new SequenceCommandRunner([{ stdout: " file | 1 +\n", stderr: "", exitCode: 0 }]);
  const gateway = new GitCliGateway(runner);
  const res = await gateway.getDiffStatSince("/path", "base-sha");
  assert.strictEqual(res, "file | 1 +");
  assert.deepEqual(runner.calls[0]!.args, ["diff", "--stat", "base-sha..HEAD"]);
});
