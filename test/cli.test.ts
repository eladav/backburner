import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli/run.js";
import { buildPromptPacket, renderPrompt } from "../src/agents/prompt.js";
import type { RepoConfig } from "../src/config/types.js";
import type { NormalizedComment, NormalizedIssue, NormalizedPullRequest } from "../src/domain/entities.js";
import type { BranchSyncComparison, GitGateway } from "../src/git/types.js";
import type { GitHubGateway, GhComment, GhIssueCommentMutationResult, GhIssueSummary, GhPullRequestReview, GhPullRequestReviewComment, GhPullRequestChangedFile, GhPullRequestReviewCommentReplyResult, GhPullRequestReviewSubmissionResult, GhPullRequestSummary, GhSearchCodeResult, GitHubRepositoryMetadata, GhIssueEvent, GhCheckRun } from "../src/github/types.js";
import type { ExecutionRecord, RepoSyncRecord, WorktreeRecord } from "../src/state/types.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { CommandRunner, CommandRunnerResult } from "../src/utils/command-runner.js";

test("runCli records partial failures, dispatches pending tasks, and persists audit state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-cli-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify(
        {
          allowedUsers: ["owner", "reviewer", "human"],
          repos: [
            baseRepoConfig("repo-1", "repo-one", "repo-one"),
            baseRepoConfig("repo-2", "repo-two", "repo-two")
          ]
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify(
        {
          agents: [
            {
              id: "codex-discussion",
              provider: "codex",
              modelClass: "strong",
              roles: ["product", "discussion", "review", "planning"],
              command: "codex",
              enabled: true
            },
            {
              id: "codex-implementation",
              provider: "codex",
              modelClass: "cheap",
              roles: ["implementation"],
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

    const syncResults = new Map<string, RepoSyncRecord>([
      [
        "repo-1",
        createRepoResult("repo-1", "repo-one", codeRoot, "synced", "Repository fetched and synchronized to the latest default branch.")
      ],
      [
        "repo-2",
        {
          ...createRepoResult(
            "repo-2",
            "repo-two",
            codeRoot,
            "failed",
            "Repository synchronization failed."
          ),
          error: {
            step: "sync",
            message: "working tree is dirty"
          }
        }
      ]
    ]);

    const scanResults = {
      issues: [sampleIssue()],
      prs: [samplePullRequest()],
      comments: [sampleComment()],
      repoResults: [
        {
          ...syncResults.get("repo-1")!,
          githubScan: {
            status: "scanned" as const,
            scannedAt: "2026-04-18T09:05:00.000Z",
            issueCount: 1,
            pullRequestCount: 1,
            commentCount: 1,
            failures: []
          }
        },
        {
          ...syncResults.get("repo-2")!,
          githubScan: {
            status: "failed" as const,
            scannedAt: "2026-04-18T09:05:00.000Z",
            issueCount: 0,
            pullRequestCount: 0,
            commentCount: 0,
            failures: [
              {
                repoId: "repo-2",
                repoSlug: "example-org/repo-two",
                step: "list_issues" as const,
                scope: "repo",
                message: "gh unavailable"
              }
            ]
          }
        }
      ],
      failures: [
        {
          repoId: "repo-2",
          repoSlug: "example-org/repo-two",
          step: "list_issues" as const,
          scope: "repo",
          message: "gh unavailable"
        }
      ]
    };

    const summary = await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return syncResults.get(repo.id)!;
        }
      },
      scanService: {
        async scanRepositories(): Promise<typeof scanResults> {
          return scanResults;
        }
      },
      agentRunner: {
        async dispatch(task, context, agentConfig) {
          const promptPacket = buildPromptPacket(task, context);
          const safeTaskId = task.id.replace(/[^a-zA-Z0-9_-]+/g, "_");
          const execution = {
            id: `exec:${task.id}:mock`,
            taskId: task.id,
            taskKind: task.kind,
            taskStatus: task.kind === "review_pr" ? "failed" : "completed",
            repoId: task.repoId,
            repoSlug: task.repoSlug,
            agentId: agentConfig.id,
            agentProvider: "codex",
            command: {
              executable: agentConfig.command,
              args: ["exec", "--skip-git-repo-check", "--color", "never", "-"],
              cwd: context.localRepoPath ?? codeRoot,
              timeoutMs: 600000
            },
            promptArtifactPath: path.join(stateDir, "artifacts", `${safeTaskId}-prompt.md`),
            stdoutArtifactPath: path.join(stateDir, "artifacts", `${safeTaskId}-stdout.txt`),
            stderrArtifactPath: path.join(stateDir, "artifacts", `${safeTaskId}-stderr.txt`),
            promptPacketPath: path.join(stateDir, "artifacts", `${safeTaskId}-packet.json`),
            startedAt: "2026-04-18T09:10:00.000Z",
            endedAt: "2026-04-18T09:11:00.000Z",
            exitCode: task.kind === "review_pr" ? 1 : 0,
            ...(task.kind === "review_pr" ? { errorMessage: "mock dispatch failure" } : {})
          } satisfies ExecutionRecord;

          await mkdir(path.join(stateDir, "artifacts"), { recursive: true });
          await Promise.all([
            writeFile(execution.promptPacketPath, JSON.stringify(promptPacket, null, 2), "utf8"),
            writeFile(execution.promptArtifactPath, renderPrompt(task, promptPacket), "utf8"),
            writeFile(execution.stdoutArtifactPath, "mock stdout\n", "utf8"),
            writeFile(execution.stderrArtifactPath, execution.errorMessage ?? "", "utf8")
          ]);

          return {
            taskStatus: execution.taskStatus,
            execution
          };
        }
      },
      logger: {
        info: () => undefined,
        warn: () => undefined
      }
    });

    assert.equal(summary.repoCount, 2);
    assert.equal(summary.syncedRepoCount, 1);
    assert.equal(summary.failedRepoCount, 1);
    assert.equal(summary.scannedRepoCount, 1);
    assert.equal(summary.failedScanRepoCount, 1);
    assert.equal(summary.issueCount, 1);
    assert.equal(summary.pullRequestCount, 1);
    assert.equal(summary.commentCount, 1);
    assert.equal(summary.taskCount, 2);
    assert.equal(summary.pendingTaskCount, 0);
    assert.equal(summary.completedTaskCount, 2);
    assert.equal(summary.failedTaskCount, 0);
    assert.equal(summary.executionCount, 2);

    const issuesState = JSON.parse(await readFile(path.join(stateDir, "issues.json"), "utf8")) as {
      metadata: { entityCount: number; partialFailures: unknown[] };
      issues: NormalizedIssue[];
    };
    const prsState = JSON.parse(await readFile(path.join(stateDir, "prs.json"), "utf8")) as {
      prs: NormalizedPullRequest[];
    };
    const commentsState = JSON.parse(await readFile(path.join(stateDir, "comments.json"), "utf8")) as {
      comments: NormalizedComment[];
    };
    const reposState = JSON.parse(await readFile(path.join(stateDir, "repos.json"), "utf8")) as {
      repos: RepoSyncRecord[];
    };
    const tasksState = JSON.parse(await readFile(path.join(stateDir, "tasks.json"), "utf8")) as {
      tasks: TaskRecord[];
    };
    const executionsState = JSON.parse(await readFile(path.join(stateDir, "executions.json"), "utf8")) as {
      executions: ExecutionRecord[];
    };

    assert.equal(issuesState.metadata.entityCount, 1);
    assert.equal(issuesState.metadata.partialFailures.length, 1);
    assert.equal(issuesState.issues[0]?.repoSlug, "example-org/repo-one");
    assert.equal(prsState.prs[0]?.headBranch, "feature/scan");
    assert.equal(commentsState.comments[0]?.commentKind, "pull_request_comment");
    assert.equal(reposState.repos[1]?.githubScan?.status, "failed");
    assert.deepEqual(
      tasksState.tasks.map((task) => task.kind),
      ["implement_plan", "product_discovery"]
    );
    assert.deepEqual(
      tasksState.tasks.map((task) => task.status),
      ["completed", "completed"]
    );
    assert.equal(tasksState.tasks[0]?.lastExecutionId, "exec:task:implement_plan:pull_request:example-org/repo-one:23:mock");
    assert.equal(tasksState.tasks[0]?.context.pullRequestUrl, "https://github.com/example-org/repo-one/pull/23");
    assert.equal(executionsState.executions.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli materializes product-approved issue into a worktree record and write_product_spec task", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-cli-worktree-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["owner", "reviewer", "human"], repos: [baseRepoConfig("repo-1", "repo-one", "repo-one")] }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify(
        {
          agents: [
            {
              id: "codex-discussion",
              provider: "codex",
              modelClass: "strong",
              roles: ["product", "discussion", "planning"],
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

    const summary = await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      gitGateway: new TestGitGateway(),
      gitHubGateway: new TestGitHubGateway(),
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<{
          issues: NormalizedIssue[];
          prs: NormalizedPullRequest[];
          comments: NormalizedComment[];
          repoResults: RepoSyncRecord[];
          failures: [];
        }> {
          return {
            issues: [sampleIssue({ labels: ["agent-product-approved"] })],
            prs: [],
            comments: [],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: []
          };
        }
      },
      agentRunner: {
        async dispatch(task, context, agentConfig) {
          return {
            taskStatus: "completed",
            execution: {
              id: `exec:${task.id}`,
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: agentConfig.id,
              agentProvider: "codex",
              command: {
                executable: agentConfig.command,
                args: ["exec", "-"],
                cwd: context.localRepoPath ?? codeRoot,
                timeoutMs: 600000
              },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: "2026-04-18T11:00:00.000Z",
              endedAt: "2026-04-18T11:00:05.000Z",
              exitCode: 0,
            }
          };
        }
      },
      logger: { info: () => undefined, warn: () => undefined }
    });

    const worktreesState = JSON.parse(await readFile(path.join(stateDir, "worktrees.json"), "utf8")) as {
      worktrees: WorktreeRecord[];
    };
    const tasksState = JSON.parse(await readFile(path.join(stateDir, "tasks.json"), "utf8")) as {
      tasks: TaskRecord[];
    };

    assert.equal(summary.taskCount, 1);
    assert.equal(worktreesState.worktrees.length, 1);
    assert.equal(worktreesState.worktrees[0]?.status, "product_specification");
    assert.equal(worktreesState.worktrees[0]?.prNumber, 101);
    assert.equal(tasksState.tasks.some((task) => task.kind === "write_product_spec"), true);
    assert.equal(tasksState.tasks.some((task) => task.kind === "write_plan"), false);
    const writeProductSpecTask = tasksState.tasks.find((task) => task.kind === "write_product_spec");
    assert.equal(writeProductSpecTask?.status, "completed");
    assert.equal(
      writeProductSpecTask?.context.productSpecDocumentPath?.endsWith(
        path.join(
          "docs",
          "agents",
          "agent-example-org-repo-one-issue-17",
          "issue-17-product-spec.md"
        )
      ),
      true
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli maps a plan-approved PR to an implement_plan task using the linked worktree path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-cli-plan-approved-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["owner", "reviewer", "human"], repos: [baseRepoConfig("repo-1", "repo-one", "repo-one")] }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify(
        {
          agents: [
            {
              id: "codex-implementation",
              provider: "codex",
              modelClass: "cheap",
              roles: ["implementation"],
              command: "codex",
              enabled: true
            },
            {
              id: "codex-review",
              provider: "codex",
              modelClass: "strong",
              roles: ["review"],
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
    await writeFile(
      path.join(stateDir, "worktrees.json"),
      JSON.stringify(
        {
          worktrees: [
            {
              id: "worktree:example-org/repo-one:issue:17",
              repoId: "repo-1",
              repoSlug: "example-org/repo-one",
              repoName: "repo-one",
              issueId: "issue:example-org/repo-one:17",
              issueNumber: 17,
              branchName: "agent/example-org-repo-one/issue-17",
              path: path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17"),
              planDocumentPath: path.join(
                codeRoot,
                "_worktrees",
                "example-org",
                "repo-one",
                "issue-17",
                "docs",
                "agents",
                "agent-example-org-repo-one-issue-17",
                "issue-17-agent-plan.md"
              ),
              logDocumentPath: path.join(
                codeRoot,
                "_worktrees",
                "example-org",
                "repo-one",
                "issue-17",
                "docs",
                "agents",
                "agent-example-org-repo-one-issue-17",
                "issue-17-agent-log.md"
              ),
              status: "awaiting_plan_approval",
              createdAt: "2026-04-18T11:00:00.000Z",
              updatedAt: "2026-04-18T11:00:00.000Z"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const dispatched: TaskRecord[] = [];
    const summary = await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      gitGateway: new TestGitGateway(),
      gitHubGateway: new TestGitHubGateway({
        existingByHeadBranch: {
          "agent/example-org-repo-one/issue-17": {
            id: "pull_request:example-org/repo-one:23",
            number: 23,
            title: "Implement workflow",
            body: "Body",
            url: "https://github.com/example-org/repo-one/pull/23",
            state: "OPEN",
            createdAt: "2026-04-18T11:00:00.000Z",
            updatedAt: "2026-04-18T11:00:00.000Z",
            author: { login: "owner" },
            labels: [],
            headRefName: "agent/example-org-repo-one/issue-17",
            headSha: "abc123",
            baseRefName: "main",
            isDraft: false
          }
        }
      }),
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories(): Promise<{
          issues: NormalizedIssue[];
          prs: NormalizedPullRequest[];
          comments: NormalizedComment[];
          repoResults: RepoSyncRecord[];
          failures: [];
        }> {
          return {
            issues: [],
            prs: [
              samplePullRequest({
                labels: ["agent-plan-approved"],
                headBranch: "agent/example-org-repo-one/issue-17"
              })
            ],
            comments: [],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: []
          };
        }
      },
      agentRunner: {
        async dispatch(task, context, agentConfig) {
          dispatched.push({
            ...task,
            context: {
              ...task.context,
              ...(context.localRepoPath ? { localRepoPath: context.localRepoPath } : {})
            }
          });
          return {
            taskStatus: "completed",
            execution: {
              id: `exec:${task.id}`,
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: agentConfig.id,
              agentProvider: "codex",
              command: {
                executable: agentConfig.command,
                args: ["exec", "-"],
                cwd: context.localRepoPath ?? codeRoot,
                timeoutMs: 600000
              },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: "2026-04-18T11:00:00.000Z",
              endedAt: "2026-04-18T11:00:05.000Z",
              exitCode: 0
            }
          };
        }
      },
      logger: { info: () => undefined, warn: () => undefined }
    });

    const implementTask = dispatched.find((task) => task.kind === "implement_plan");
    assert.equal(summary.taskCount, 1);
    assert.equal(
      implementTask?.context.localRepoPath?.includes(
        path.join("_worktrees", "example-org", "repo-one", "issue-17")
      ),
      true
    );
    assert.equal(
      implementTask?.context.planDocumentPath?.endsWith(
        path.join(
          "docs",
          "agents",
          "agent-example-org-repo-one-issue-17",
          "issue-17-agent-plan.md"
        )
      ),
      true
    );
    const worktreesState = JSON.parse(await readFile(path.join(stateDir, "worktrees.json"), "utf8")) as {
      worktrees: WorktreeRecord[];
    };
    assert.equal(worktreesState.worktrees[0]?.status, "implementation_done");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCli commits and pushes completed workspace-write handoffs from the orchestrator", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-cli-handoff-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");
  const gitGateway = new RecordingHandoffGitGateway();

  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["owner", "reviewer", "human"], repos: [baseRepoConfig("repo-1", "repo-one", "repo-one")] }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify(
        {
          agents: [
            {
              id: "codex-implementation",
              provider: "codex",
              modelClass: "cheap",
              roles: ["implementation"],
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
    await writeFile(
      path.join(stateDir, "worktrees.json"),
      JSON.stringify(
        {
          worktrees: [
            {
              id: "worktree:example-org/repo-one:issue:17",
              repoId: "repo-1",
              repoSlug: "example-org/repo-one",
              repoName: "repo-one",
              issueId: "issue:example-org/repo-one:17",
              issueNumber: 17,
              prId: "pull_request:example-org/repo-one:23",
              prNumber: 23,
              prUrl: "https://github.com/example-org/repo-one/pull/23",
              branchName: "agent/example-org-repo-one/issue-17",
              path: path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17"),
              planDocumentPath: path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17", "docs", "agents", "agent-example-org-repo-one-issue-17", "issue-17-agent-plan.md"),
              logDocumentPath: path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17", "docs", "agents", "agent-example-org-repo-one-issue-17", "issue-17-agent-log.md"),
              status: "implementation_ready",
              createdAt: "2026-04-18T11:00:00.000Z",
              updatedAt: "2026-04-18T11:00:00.000Z"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      gitGateway,
      gitHubGateway: new TestGitHubGateway({
        existingByHeadBranch: {
          "agent/example-org-repo-one/issue-17": {
            id: "pull_request:example-org/repo-one:23",
            number: 23,
            title: "Implement workflow",
            body: "Body",
            url: "https://github.com/example-org/repo-one/pull/23",
            state: "OPEN",
            createdAt: "2026-04-18T11:00:00.000Z",
            updatedAt: "2026-04-18T11:00:00.000Z",
            author: { login: "owner" },
            labels: [],
            headRefName: "agent/example-org-repo-one/issue-17",
            headSha: "abc123",
            baseRefName: "main",
            isDraft: false
          }
        }
      }),
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      scanService: {
        async scanRepositories() {
          return {
            issues: [],
            prs: [
              samplePullRequest({
                labels: ["agent-plan-approved"],
                headBranch: "agent/example-org-repo-one/issue-17"
              })
            ],
            comments: [],
            repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
            failures: []
          };
        }
      },
      agentRunner: {
        async dispatch(task, context, agentConfig) {
          return {
            taskStatus: "completed",
            execution: {
              id: `exec:${task.id}`,
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: agentConfig.id,
              agentProvider: "codex",
              command: {
                executable: agentConfig.command,
                args: ["exec", "-"],
                cwd: context.localRepoPath ?? codeRoot,
                timeoutMs: 600000
              },
              promptArtifactPath: "",
              stdoutArtifactPath: "",
              stderrArtifactPath: "",
              promptPacketPath: "",
              startedAt: "2026-04-18T11:00:00.000Z",
              endedAt: "2026-04-18T11:00:05.000Z",
              exitCode: 0
            }
          };
        }
      },
      logger: { info: () => undefined, warn: () => undefined }
    });

    assert.deepEqual(gitGateway.commitAllCalls, [
      {
        localPath: path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17"),
        message: "feat(agent): capture implementation updates for #17"
      }
    ]);
    assert.deepEqual(gitGateway.pushBranchCalls, [
      {
        localPath: path.join(codeRoot, "_worktrees", "example-org", "repo-one", "issue-17"),
        branch: "agent/example-org-repo-one/issue-17"
      }
    ]);

    const worktreesState = JSON.parse(await readFile(path.join(stateDir, "worktrees.json"), "utf8")) as {
      worktrees: WorktreeRecord[];
    };
    assert.equal(worktreesState.worktrees[0]?.status, "implementation_done");
    assert.ok(worktreesState.worktrees[0]?.branchPushedAt);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function baseRepoConfig(id: string, name: string, localPath: string): RepoConfig {
  return {
    id,
    owner: "example-org",
    name,
    localPath,
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

function createRepoResult(
  id: string,
  name: string,
  codeRoot: string,
  status: "synced" | "failed",
  message: string
): RepoSyncRecord {
  return {
    repoId: id,
    repoName: name,
    repoSlug: `example-org/${name}`,
    localPath: path.join(codeRoot, name),
    codeRoot,
    status,
    existedBeforeSync: true,
    cloned: false,
    fetched: true,
    defaultBranch: "main",
    defaultBranchSource: "github",
    currentBranchBefore: "main",
    currentBranchAfter: "main",
    syncedAt: "2026-04-18T09:00:00.000Z",
    message
  };
}

function sampleIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    kind: "issue",
    id: "issue:example-org/repo-one:17",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    number: 17,
    key: "example-org/repo-one:issue:17",
    sourceId: "ISSUE_17",
    url: "https://github.com/example-org/repo-one/issues/17",
    title: "Need scan coverage",
    body: "Track comments and labels.",
    labels: ["agent-in-progress"],
    author: "owner",
    createdAt: "2026-04-18T08:00:00.000Z",
    updatedAt: "2026-04-18T08:30:00.000Z",
    lastCommentAt: "2026-04-18T08:31:00.000Z",
    lastSeenAt: "2026-04-18T09:05:00.000Z",
    state: "open",
    ...overrides
  };
}

function samplePullRequest(overrides: Partial<NormalizedPullRequest> = {}): NormalizedPullRequest {
  return {
    kind: "pull_request",
    id: "pull_request:example-org/repo-one:23",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    number: 23,
    key: "example-org/repo-one:pull_request:23",
    sourceId: "PR_23",
    url: "https://github.com/example-org/repo-one/pull/23",
    title: "Implement scanning",
    body: "Open PR body",
    labels: ["agent-plan-approved"],
    author: "owner",
    createdAt: "2026-04-18T08:10:00.000Z",
    updatedAt: "2026-04-18T08:40:00.000Z",
    lastCommentAt: "2026-04-18T08:41:00.000Z",
    lastSeenAt: "2026-04-18T09:05:00.000Z",
    state: "open",
    headBranch: "feature/scan",
    headSha: "abc123",
    baseBranch: "main",
    defaultBranch: "main",
    baseClassification: "top_level",
    isDraft: false,
    ...overrides
  };
}

function sampleComment(): NormalizedComment {
  return {
    kind: "comment",
    commentKind: "pull_request_comment",
    id: "comment:example-org/repo-one:pull_request_comment:9001",
    sourceId: "9001",
    repoId: "repo-1",
    repoKey: "example-org/repo-one",
    repoOwner: "example-org",
    repoName: "repo-one",
    repoSlug: "example-org/repo-one",
    parentType: "pull_request",
    parentNumber: 23,
    parentKey: "example-org/repo-one:pull_request:23",
    url: "https://github.com/example-org/repo-one/pull/23#issuecomment-9001",
    body: "Please handle the new review note.",
    author: "reviewer",
    createdAt: "2026-04-18T08:41:00.000Z",
    updatedAt: "2026-04-18T08:41:00.000Z",
    lastSeenAt: "2026-04-18T09:05:00.000Z"
  };
}

class TestGitGateway implements GitGateway {
  async resetHard() {}
  async cleanUntrackedFiles() {}
  async cloneRepository(): Promise<void> {}
  async fetchRepository(): Promise<void> {}
  async getCurrentBranch(localPath: string): Promise<string | null> {
    if (localPath.includes("issue-17")) return "agent/example-org-repo-one/issue-17";
    return "main";
  }
  async getRemoteDefaultBranch(_localPath: string): Promise<string> {
    return "main";
  }
  async isWorkingTreeClean(_localPath: string): Promise<boolean> {
    return true;
  }
  async ensureDefaultBranchCheckedOut(_localPath: string, _branch: string): Promise<void> {}
  async fastForwardDefaultBranch(_localPath: string, _branch: string): Promise<void> {}
  validatePathWithinCodeRoot(codeRoot: string, candidatePath: string): string {
    const resolved = path.resolve(codeRoot, candidatePath);
    const relative = path.relative(path.resolve(codeRoot), resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("escape");
    }
    return resolved;
  }
  async createWorktree(
    _repoPath: string,
    codeRoot: string,
    worktreePath: string
  ): Promise<string> {
    const resolved = this.validatePathWithinCodeRoot(codeRoot, worktreePath);
    await mkdir(resolved, { recursive: true });
    return resolved;
  }
  async hasCommitsAhead(_localPath: string, _baseRef: string): Promise<boolean> {
    return false;
  }
  async commitAll(_localPath: string, _message: string): Promise<boolean> {
    return true;
  }
  async pushBranch(_localPath: string, _branch: string): Promise<void> {}
  async checkoutBranch(_localPath: string, _branch: string): Promise<void> {}
  async mergeRemoteBranch(_localPath: string, _remote: string, _branch: string): Promise<void> {}
  async abortMerge(_localPath: string): Promise<void> {}
  async abortRebase(_localPath: string): Promise<void> {}
  async abortCherryPick(_localPath: string): Promise<void> {}
  async abortRevert(_localPath: string): Promise<void> {}
  async isInsideWorkingTree(_localPath: string): Promise<boolean> {
    return true;
  }
  async pullFastForwardOnly(_localPath: string): Promise<void> {}
  async getHeadCommitSha(_localPath: string): Promise<string> {
    return "abc123456789";
  }

  async cloneRepositoryFromUrl(_sshUrl: string, _destinationPath: string): Promise<void> {}
  async checkoutBranchAtRemote(_localPath: string, _branch: string, _options?: { skipFetch?: boolean }): Promise<void> {}
  async getAheadBehindVsRemote(
    _localPath: string,
    _branch: string
  ): Promise<{ ahead: number; behind: number }> {
    return { ahead: 0, behind: 0 };
  }
  async isAncestorOf(
    _localPath: string,
    _ancestorSha: string,
    _descendantSha: string
  ): Promise<boolean> {
    return true;
  }
  async countCommitsAheadOf(_localPath: string, _baseSha: string): Promise<number> {
    return 0;
  }
  async getActiveMergeState(
    _localPath: string
  ): Promise<"none" | "merging" | "rebasing" | "cherry-picking" | "reverting"> {
    return "none";
  }
  async pushWithLease(
    _localPath: string,
    _branch: string,
    _expectedOldSha: string
  ): Promise<void> {}
  async removeDirectory(_dirPath: string): Promise<void> {}
  async getCommitLogSince(_localPath: string, _baseSha: string): Promise<string> {
    return "";
  }
  async getDiffStatSince(_localPath: string, _baseSha: string): Promise<string> {
    return "";
  }

  async listWorktrees(_repoPath: string): Promise<{ path: string; branch: string }[]> {
    return [];
  }

  async getWorktreeForBranch(_repoPath: string, _branch: string): Promise<string | null> {
    return null;
  }

  async compareBranchSyncStatus(
    _localPath: string,
    parentBranch: string,
    defaultBranch: string
  ): Promise<BranchSyncComparison> {
    return {
      parentBranch,
      defaultBranch,
      parentRef: `refs/remotes/origin/${parentBranch}`,
      defaultRef: `refs/remotes/origin/${defaultBranch}`,
      status: "up_to_date",
      parentAheadCount: 0,
      parentBehindCount: 0,
      message: "Parent branch contains the default branch."
    };
  }
}

class RecordingHandoffGitGateway extends TestGitGateway {
  readonly commitAllCalls: Array<{ localPath: string; message: string }> = [];
  readonly pushBranchCalls: Array<{ localPath: string; branch: string }> = [];

  private readonly cleanCheckCounts = new Map<string, number>();

  override async isWorkingTreeClean(localPath: string): Promise<boolean> {
    if (localPath.includes("management") || localPath.includes("outputs")) {
      return true;
    }
    if (localPath.includes("_worktrees")) {
      const count = this.cleanCheckCounts.get(localPath) ?? 0;
      this.cleanCheckCounts.set(localPath, count + 1);
      return count === 0;
    }
    return true;
  }

  override async isInsideWorkingTree(localPath: string): Promise<boolean> {
    if (localPath.includes("_worktrees")) {
      return true;
    }
    return false;
  }

  override async commitAll(localPath: string, message: string): Promise<boolean> {
    this.commitAllCalls.push({ localPath, message });
    return true;
  }

  override async pushBranch(localPath: string, branch: string): Promise<void> {
    this.pushBranchCalls.push({ localPath, branch });
  }
}

test("runCli: prepare_pr_for_merge fails if normal push fails after agent completion", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-cli-merge-prep-fail-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(managementDir, { recursive: true });
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["owner"], repos: [baseRepoConfig("repo-1", "repo-one", "repo-one")] }, null, 2)
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [{
          id: "codex-strong", provider: "codex", modelClass: "strong", roles: ["implementation_manager"], command: "codex", enabled: true
        }]
      }, null, 2)
    );

    const pr = samplePullRequest({
      id: "pull_request:example-org/repo-one:101",
      number: 101,
      labels: ["prepare-for-merge"],
      headSha: "abc123456789"
    });

    const scanResult = {
      issues: [],
      prs: [pr],
      comments: [],
      repoResults: [createRepoResult("repo-1", "repo-one", codeRoot, "synced", "ok")],
      failures: []
    };

    class FailingPushGitGateway extends TestGitGateway {
      override async getCurrentBranch(localPath: string): Promise<string | null> {
        if (localPath.includes("pr-101")) {
          return "feature/scan";
        }
        return super.getCurrentBranch(localPath);
      }
      override async countCommitsAheadOf(): Promise<number> {
        return 1;
      }
      override async pushBranch(): Promise<void> {
        throw new Error("non-fast-forward");
      }
    }

    const mergeStartCommandRunner: CommandRunner = {
      async run(command: string, args: string[]): Promise<CommandRunnerResult> {
        assert.equal(command, "git");
        const key = args.join(" ");
        if (key === "rev-parse HEAD") {
          return { stdout: "abc123456789\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    };

    const summary = await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      gitGateway: new FailingPushGitGateway(),
      commandRunner: mergeStartCommandRunner,
      scanService: {
        async scanRepositories(): Promise<any> { return scanResult; }
      },
      syncService: {
        async syncRepository(repo: RepoConfig): Promise<RepoSyncRecord> {
          return createRepoResult(repo.id, repo.name, codeRoot, "synced", "ok");
        }
      },
      agentRunner: {
        async dispatch(task, context, agentConfig) {
          return {
            taskStatus: "completed",
            execution: {
              id: `exec:${task.id}:agent`,
              taskId: task.id,
              taskKind: task.kind,
              taskStatus: "completed",
              repoId: task.repoId,
              repoSlug: task.repoSlug,
              agentId: agentConfig.id,
              agentProvider: "codex",
              command: { executable: "codex", args: [], cwd: context.localRepoPath ?? codeRoot, timeoutMs: 0 },
              promptArtifactPath: "", stdoutArtifactPath: "", stderrArtifactPath: "", promptPacketPath: "",
              startedAt: "2026-06-04T12:00:00Z", endedAt: "2026-06-04T12:00:05Z", exitCode: 0
            } as any
          };
        }
      },
      logger: { info: () => undefined, warn: () => undefined }
    });

    const tasksState = JSON.parse(await readFile(path.join(stateDir, "tasks.json"), "utf8")) as { tasks: TaskRecord[] };
    const mergeTask = tasksState.tasks.find(t => t.kind === "prepare_pr_for_merge");

    assert.strictEqual(mergeTask?.status, "failed");

    const executionsState = JSON.parse(await readFile(path.join(stateDir, "executions.json"), "utf8")) as { executions: ExecutionRecord[] };
    const failureExecution = executionsState.executions.find(e => e.id.includes("post-dispatch-handoff-failure"));
    assert.ok(failureExecution);
    assert.ok(failureExecution.errorMessage?.includes("Push rejected: remote branch"));
    assert.ok(failureExecution.errorMessage?.includes("Lease expired"));
    assert.strictEqual(summary.failedTaskCount >= 1, true);

  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

class TestGitHubGateway implements GitHubGateway {
  constructor(
    private readonly options: {
      existingByHeadBranch?: Record<string, GhPullRequestSummary>;
    } = {}
  ) {}

  async getRepositoryMetadata(): Promise<GitHubRepositoryMetadata> {
    return {
      id: "repo-meta",
      owner: "example-org",
      name: "repo-one",
      nameWithOwner: "example-org/repo-one",
      url: "https://github.com/example-org/repo-one",
      defaultBranch: "main"
    };
  }
  async getRepositoryDefaultBranch(): Promise<string> {
    return "main";
  }
  async getIssue(_owner: string, _name: string, issueNumber: number): Promise<GhIssueSummary> {
    return {
      id: `ISSUE_${issueNumber}`,
      number: issueNumber,
      title: "Need scan coverage",
      body: "Track comments and labels.",
      url: `https://github.com/example-org/repo-one/issues/${issueNumber}`,
      state: "OPEN",
      createdAt: "2026-04-18T08:00:00.000Z",
      updatedAt: "2026-04-18T08:30:00.000Z",
      author: { login: "owner" },
      labels: [{ name: "agent-in-progress" }]
    };
  }
  async getPullRequest(_owner: string, _name: string, prNumber: number): Promise<GhPullRequestSummary> {
    return {
      id: `PR_${prNumber}`,
      number: prNumber,
      title: "Implement scanning",
      body: "Open PR body",
      url: `https://github.com/example-org/repo-one/pull/${prNumber}`,
      state: "OPEN",
      createdAt: "2026-04-18T08:10:00.000Z",
      updatedAt: "2026-04-18T08:40:00.000Z",
      author: { login: "owner" },
      labels: [{ name: "agent-plan-approved" }],
      headRefName: "feature/scan",
      headSha: "abc123",
      baseRefName: "main",
      isDraft: false
    };
  }
  async findOpenPullRequestByHeadBranch(
    _owner: string,
    _name: string,
    headBranch: string
  ): Promise<GhPullRequestSummary | null> {
    return this.options.existingByHeadBranch?.[headBranch] ?? null;
  }
  async createPullRequest(input: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<GhPullRequestSummary> {
    return {
      id: "pull_request:example-org/repo-one:101",
      number: 101,
      title: input.title,
      body: input.body,
      url: "https://github.com/example-org/repo-one/pull/101",
      state: "OPEN",
      createdAt: "2026-04-18T11:00:00.000Z",
      updatedAt: "2026-04-18T11:00:00.000Z",
      author: { login: "owner" },
      labels: [],
      headRefName: input.headBranch,
      headSha: "",
      baseRefName: input.baseBranch,
      isDraft: false
    };
  }
  async listOpenIssues(): Promise<GhIssueSummary[]> {
    return [];
  }
  async searchCode(): Promise<GhSearchCodeResult> {
    return {
      totalCount: 0,
      incompleteResults: false,
      items: []
    };
  }
  async postIssueComment(): Promise<GhIssueCommentMutationResult> {
    return {
      id: 1,
      url: "https://github.com/example-org/repo-one/issues/17#issuecomment-1",
      body: "comment",
      createdAt: "2026-04-18T11:00:00.000Z",
      updatedAt: "2026-04-18T11:00:00.000Z",
      author: { login: "owner" }
    };
  }
  async updateIssueComment(input: { body: string }): Promise<GhIssueCommentMutationResult> {
    return {
      id: 1,
      url: "https://github.com/example-org/repo-one/issues/17#issuecomment-1",
      body: input.body,
      createdAt: "2026-04-18T11:00:00.000Z",
      updatedAt: "2026-04-18T11:00:00.000Z",
      author: { login: "owner" }
    };
  }
  async postPullRequestReviewCommentReply(): Promise<GhPullRequestReviewCommentReplyResult> {
    return {
      id: 2,
      url: "https://github.com/example-org/repo-one/pull/17#discussion_r2",
      body: "🤖 reply",
      createdAt: "2026-04-18T11:00:00.000Z",
      updatedAt: "2026-04-18T11:00:00.000Z",
      author: { login: "owner" }
    };
  }
  async submitPullRequestReview(): Promise<GhPullRequestReviewSubmissionResult> {
    return {
      id: 3,
      url: "https://github.com/example-org/repo-one/pull/17#pullrequestreview-3",
      body: "🤖 Approved.",
      state: "APPROVED",
      submittedAt: "2026-04-18T11:00:00.000Z",
      author: { login: "owner" }
    };
  }
  async listOpenPullRequests(): Promise<GhPullRequestSummary[]> {
    return [];
  }
  async listIssueComments(): Promise<GhComment[]> {
    return [];
  }
  async listPullRequestComments(): Promise<GhComment[]> {
    return [];
  }
  async listPullRequestReviews(): Promise<GhPullRequestReview[]> {
    return [];
  }
  async listPullRequestReviewComments(): Promise<GhPullRequestReviewComment[]> {
    return [];
  }
  async listPullRequestChangedFiles(): Promise<GhPullRequestChangedFile[]> {
    return [];
  }
  async listIssueEvents(owner: string, name: string, issueNumber: number): Promise<GhIssueEvent[]> {
    try {
      const issue = await this.getIssue(owner, name, issueNumber);
      if (issue && issue.number === issueNumber) {
        return issue.labels.map((label) => ({
          event: "labeled",
          createdAt: issue.createdAt,
          actor: issue.author,
          label
        }));
      }
    } catch {}

    try {
      const pr = await this.getPullRequest(owner, name, issueNumber);
      if (pr && pr.number === issueNumber) {
        return pr.labels.map((label) => ({
          event: "labeled",
          createdAt: pr.createdAt,
          actor: pr.author,
          label
        }));
      }
    } catch {}

    if (this.options.existingByHeadBranch) {
      for (const pr of Object.values(this.options.existingByHeadBranch)) {
        if (pr.number === issueNumber) {
          return pr.labels.map((label) => ({
            event: "labeled",
            createdAt: pr.createdAt,
            actor: pr.author,
            label
          }));
        }
      }
    }

    return [];
  }
  async listPullRequestCheckRuns(): Promise<GhCheckRun[]> {
    return [];
  }
  async addReaction(): Promise<void> {}
}
