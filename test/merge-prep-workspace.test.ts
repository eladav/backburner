import { describe, it } from "node:test";
import * as assert from "node:assert";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  MergePrepWorkspaceService,
  buildMergePrepPrComment,
  type MergePrepAuditData
} from "../src/git/merge-prep-workspace.js";

describe("MergePrepWorkspaceService", () => {
  const mockGitGateway = {
    isInsideWorkingTree: async () => true,
    isWorkingTreeClean: async () => true,
    fetchRepository: async () => {},
    getCurrentBranch: async () => "head-branch",
    getAheadBehindVsRemote: async () => ({ ahead: 0, behind: 0 }),
    fastForwardDefaultBranch: async () => {},
    cloneRepositoryFromUrl: async () => {},
    checkoutBranchAtRemote: async () => {},
    getHeadCommitSha: async () => "new-sha",
    removeDirectory: async () => {},
    getActiveMergeState: async () => "none" as const,
    isAncestorOf: async () => true,
    countCommitsAheadOf: async () => 1,
    getCommitLogSince: async () => "commit log",
    getDiffStatSince: async () => "diff stats",
    pushWithLease: async () => {},
    pushBranch: async () => {},
    checkoutBranch: async () => {}
  } as any;

  const service = new MergePrepWorkspaceService(mockGitGateway);

  describe("refreshPersistentWorktreeBeforeDispatch", () => {
    it("returns fast_forwarded when behind remote", async () => {
      const git = {
        ...mockGitGateway,
        getAheadBehindVsRemote: async () => ({ ahead: 0, behind: 2 })
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.refreshPersistentWorktreeBeforeDispatch({
        localPath: "/path",
        expectedBranch: "head-branch"
      });
      assert.strictEqual(res.status, "fast_forwarded");
    });

    it("returns blocked_dirty when tree is dirty", async () => {
      const git = {
        ...mockGitGateway,
        isWorkingTreeClean: async () => false
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.refreshPersistentWorktreeBeforeDispatch({
        localPath: "/path",
        expectedBranch: "head-branch"
      });
      assert.strictEqual(res.status, "blocked_dirty");
    });

    it("returns blocked_not_git when not inside working tree", async () => {
      const git = {
        ...mockGitGateway,
        isInsideWorkingTree: async () => false
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.refreshPersistentWorktreeBeforeDispatch({
        localPath: "/path",
        expectedBranch: "head-branch"
      });
      assert.strictEqual(res.status, "blocked_not_git");
    });

    it("returns blocked_wrong_branch when on wrong branch", async () => {
      const git = {
        ...mockGitGateway,
        getCurrentBranch: async () => "wrong-branch"
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.refreshPersistentWorktreeBeforeDispatch({
        localPath: "/path",
        expectedBranch: "head-branch"
      });
      assert.strictEqual(res.status, "blocked_wrong_branch");
    });

    it("returns already_up_to_date when ahead=0, behind=0", async () => {
      let ffCalled = false;
      const git = {
        ...mockGitGateway,
        getAheadBehindVsRemote: async () => ({ ahead: 0, behind: 0 }),
        fastForwardDefaultBranch: async () => { ffCalled = true; }
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.refreshPersistentWorktreeBeforeDispatch({
        localPath: "/path",
        expectedBranch: "head-branch"
      });
      assert.strictEqual(res.status, "already_up_to_date");
      assert.strictEqual(ffCalled, false);
    });

    it("returns blocked_ahead when ahead > 0, behind = 0", async () => {
      const git = {
        ...mockGitGateway,
        getAheadBehindVsRemote: async () => ({ ahead: 2, behind: 0 })
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.refreshPersistentWorktreeBeforeDispatch({
        localPath: "/path",
        expectedBranch: "head-branch"
      });
      assert.strictEqual(res.status, "blocked_ahead");
    });

    it("returns blocked_diverged when ahead > 0, behind > 0", async () => {
      const git = {
        ...mockGitGateway,
        getAheadBehindVsRemote: async () => ({ ahead: 1, behind: 1 })
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.refreshPersistentWorktreeBeforeDispatch({
        localPath: "/path",
        expectedBranch: "head-branch"
      });
      assert.strictEqual(res.status, "blocked_diverged");
    });
  });

  describe("prepareMergePrepClone", () => {
    it("clones and checks out branch", async () => {
      let cloned = false;
      let checkedOut = false;
      const git = {
        ...mockGitGateway,
        cloneRepositoryFromUrl: async () => { cloned = true; },
        checkoutBranchAtRemote: async () => { checkedOut = true; },
        getHeadCommitSha: async () => "expected-sha"
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.prepareMergePrepClone({
        codeRoot: "/tmp",
        repoSshUrl: "git@github.com:foo/bar.git",
        owner: "foo",
        repoName: "bar",
        prNumber: 123,
        headBranch: "feat",
        expectedHeadSha: "expected-sha"
      });
      assert.ok(cloned);
      assert.ok(checkedOut);
      assert.strictEqual(res.verifiedHeadSha, "expected-sha");
      assert.ok(res.clonePath.includes("pr-123-"));
    });

    it("throws and cleans up on SHA mismatch", async () => {
      let removed = false;
      const git = {
        ...mockGitGateway,
        getHeadCommitSha: async () => "wrong-sha",
        removeDirectory: async () => { removed = true; }
      };
      const s = new MergePrepWorkspaceService(git);
      await assert.rejects(
        s.prepareMergePrepClone({
          codeRoot: "/tmp",
          repoSshUrl: "url",
          owner: "o",
          repoName: "r",
          prNumber: 1,
          headBranch: "b",
          expectedHeadSha: "exp"
        }),
        /SHA mismatch/
      );
      assert.ok(removed);
    });
  });

  describe("inspectMergePrepCloneResult", () => {
    it("returns ready_to_push on happy path", async () => {
      const res = await service.inspectMergePrepCloneResult({
        clonePath: "/path",
        expectedBranch: "head-branch",
        originalHeadSha: "base-sha"
      });
      assert.strictEqual(res.status, "ready_to_push");
      assert.strictEqual(res.localSha, "new-sha");
      assert.strictEqual(res.aheadCount, 1);
    });

    it("returns active_merge_state if merge in progress", async () => {
      const git = {
        ...mockGitGateway,
        getActiveMergeState: async () => "merging"
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.inspectMergePrepCloneResult({
        clonePath: "/path",
        expectedBranch: "head-branch",
        originalHeadSha: "base-sha"
      });
      assert.strictEqual(res.status, "active_merge_state");
    });

    it("returns clone_missing when not inside working tree", async () => {
      const git = {
        ...mockGitGateway,
        isInsideWorkingTree: async () => false
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.inspectMergePrepCloneResult({
        clonePath: "/path",
        expectedBranch: "head-branch",
        originalHeadSha: "base-sha"
      });
      assert.strictEqual(res.status, "clone_missing");
    });

    it("returns wrong_branch when on wrong branch", async () => {
      const git = {
        ...mockGitGateway,
        getCurrentBranch: async () => "wrong-branch"
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.inspectMergePrepCloneResult({
        clonePath: "/path",
        expectedBranch: "head-branch",
        originalHeadSha: "base-sha"
      });
      assert.strictEqual(res.status, "wrong_branch");
    });

    it("returns dirty_uncommitted when tree is dirty", async () => {
      const git = {
        ...mockGitGateway,
        isWorkingTreeClean: async () => false
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.inspectMergePrepCloneResult({
        clonePath: "/path",
        expectedBranch: "head-branch",
        originalHeadSha: "base-sha"
      });
      assert.strictEqual(res.status, "dirty_uncommitted");
    });

    it("returns sha_baseline_mismatch when local head is not descendant", async () => {
      const git = {
        ...mockGitGateway,
        isAncestorOf: async () => false
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.inspectMergePrepCloneResult({
        clonePath: "/path",
        expectedBranch: "head-branch",
        originalHeadSha: "base-sha"
      });
      assert.strictEqual(res.status, "sha_baseline_mismatch");
    });

    it("returns no_commits_ahead when ahead count is 0", async () => {
      const git = {
        ...mockGitGateway,
        countCommitsAheadOf: async () => 0
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.inspectMergePrepCloneResult({
        clonePath: "/path",
        expectedBranch: "head-branch",
        originalHeadSha: "base-sha"
      });
      assert.strictEqual(res.status, "no_commits_ahead");
    });
  });

  describe("publishMergePrepResult", () => {
    it("returns pushed on success", async () => {
      const res = await service.publishMergePrepResult({
        clonePath: "/path",
        headBranch: "feat",
        originalHeadSha: "old"
      });
      assert.strictEqual(res.status, "pushed");
      assert.strictEqual(res.pushedSha, "new-sha");
    });

    it("returns lease_failed on stale info error", async () => {
      const git = {
        ...mockGitGateway,
        pushBranch: async () => { throw new Error("non-fast-forward"); }
      };
      const s = new MergePrepWorkspaceService(git);
      const res = await s.publishMergePrepResult({
        clonePath: "/path",
        headBranch: "feat",
        originalHeadSha: "old"
      });
      assert.strictEqual(res.status, "lease_failed");
    });
  });

  describe("buildMergePrepPrComment", () => {
    it("renders a comprehensive markdown comment", () => {
      const audit = {
        prNumber: 42,
        headBranch: "feat",
        baseBranch: "main",
        originalHeadSha: "old",
        finalLocalSha: "new",
        pushed: true,
        pushedSha: "new",
        commitLog: "one commit",
        diffStats: "one file changed",
        persistentRefreshStatus: "succeeded" as const
      };
      const comment = buildMergePrepPrComment(audit);
      assert.ok(comment.includes("**Merge preparation result**"));
      assert.ok(comment.includes("**PR**: #42"));
      assert.ok(comment.includes("**Branch pushed**: Yes"));
      assert.ok(comment.includes("one commit"));
    });
  });

  describe("commitAuditInClone", () => {
    const sampleAudit: MergePrepAuditData = {
      prNumber: 42,
      headBranch: "feat",
      baseBranch: "main",
      originalHeadSha: "old-sha",
      finalLocalSha: "new-sha",
      pushed: true,
      persistentRefreshStatus: "skipped"
    };

    it("writes log file to clone and calls commitAll", async () => {
      const tempCloneRoot = await mkdtemp(path.join(tmpdir(), "backburner-test-clone-"));
      try {
        let committedPath: string | undefined;
        let commitMessage: string | undefined;

        const git = {
          ...mockGitGateway,
          commitAll: async (localPath: string, message: string) => {
            committedPath = localPath;
            commitMessage = message;
            return true;
          }
        };
        const s = new MergePrepWorkspaceService(git);

        const persistentLogPath = "/worktree/docs/agents/log.md";
        const persistentWorktreePath = "/worktree";

        await s.commitAuditInClone({
          clonePath: tempCloneRoot,
          persistentWorktreePath,
          persistentLogDocumentPath: persistentLogPath,
          audit: sampleAudit
        });

        assert.strictEqual(committedPath, tempCloneRoot);
        assert.ok(commitMessage?.includes("PR #42"));

        const expectedFileInClone = path.join(tempCloneRoot, "docs/agents/log.md");
        const content = await readFile(expectedFileInClone, "utf-8");
        assert.ok(content.includes("merge-prep for PR #42 — SUCCESS"));
        assert.ok(content.includes("original-head: old-sha"));
      } finally {
        await rm(tempCloneRoot, { recursive: true, force: true });
      }
    });

    it("skips if relative log path escapes worktree root", async () => {
      let commitCalled = false;
      const git = {
        ...mockGitGateway,
        commitAll: async () => {
          commitCalled = true;
          return true;
        }
      };
      const s = new MergePrepWorkspaceService(git);
      await s.commitAuditInClone({
        clonePath: "/clone",
        persistentWorktreePath: "/worktree/sub",
        persistentLogDocumentPath: "/other/path/log.md", // escapes /worktree/sub
        audit: sampleAudit
      });
      assert.strictEqual(commitCalled, false);
    });

    it("does not throw when commitAll fails", async () => {
      const git = {
        ...mockGitGateway,
        commitAll: async () => {
          throw new Error("git error");
        }
      };
      const s = new MergePrepWorkspaceService(git);
      // Should not throw
      await assert.doesNotReject(
        s.commitAuditInClone({
          clonePath: "/clone",
          persistentWorktreePath: "/worktree",
          persistentLogDocumentPath: "/worktree/docs/log.md",
          audit: sampleAudit
        })
      );
    });
  });
});
