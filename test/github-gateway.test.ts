import * as assert from "node:assert/strict";
import { test } from "node:test";
import { UnsecuredGhCliGitHubGateway } from "../src/github/gateway.js";
import type { CommandRunner, CommandRunnerOptions, CommandRunnerResult } from "../src/utils/command-runner.js";

test("GhCliGitHubGateway creates a PR without relying on gh pr create --json and resolves it by branch", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: "https://github.com/example-org/repo/pull/42\n",
      stderr: "",
      exitCode: 0
    },
    {
      stdout: JSON.stringify([
        {
          id: "PR_42",
          number: 42,
          title: "agent: plan for issue #2 - Test",
          body: "Body",
          url: "https://github.com/example-org/repo/pull/42",
          state: "OPEN",
          createdAt: "2026-04-19T08:00:00.000Z",
          updatedAt: "2026-04-19T08:00:00.000Z",
          author: { login: "example-org" },
          labels: [],
          headRefName: "agent/example-org-repo/issue-2",
          baseRefName: "main",
          isDraft: false
        }
      ]),
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  const result = await gateway.createPullRequest({
    owner: "example-org",
    name: "repo",
    headBranch: "agent/example-org-repo/issue-2",
    baseBranch: "main",
    title: "agent: plan for issue #2 - Test",
    body: "Body"
  });

  assert.equal(runner.calls[0]?.args.includes("--json"), false);
  assert.equal(result.number, 42);
  assert.equal(result.headRefName, "agent/example-org-repo/issue-2");
});

test("GhCliGitHubGateway falls back to the created PR URL when lookup does not immediately resolve", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: "https://github.com/example-org/repo/pull/43\n",
      stderr: "",
      exitCode: 0
    },
    {
      stdout: "[]",
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  const result = await gateway.createPullRequest({
    owner: "example-org",
    name: "repo",
    headBranch: "agent/example-org-repo/issue-3",
    baseBranch: "main",
    title: "agent: plan for issue #3 - Test",
    body: "Body"
  });

  assert.equal(result.url, "https://github.com/example-org/repo/pull/43");
  assert.equal(result.number, 43);
  assert.equal(result.headRefName, "agent/example-org-repo/issue-3");
});

test("GhCliGitHubGateway submits a structured pull request review", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: JSON.stringify({
        id: 99,
        html_url: "https://github.com/example-org/repo/pull/43#pullrequestreview-99",
        body: "🤖 Looks good.",
        state: "APPROVED",
        submitted_at: "2026-04-19T09:00:00.000Z",
        user: { login: "example-org" }
      }),
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  const result = await gateway.submitPullRequestReview({
    owner: "example-org",
    name: "repo",
    pullRequestNumber: 43,
    event: "APPROVE",
    body: "🤖 Looks good.",
    commitId: "head-sha-123",
    comments: [
      {
        path: "src/app.ts",
        line: 12,
        body: "🤖 Fix this."
      }
    ]
  });

  assert.equal(runner.calls[0]?.args.at(-2), "--input");
  const payload = JSON.parse(runner.calls[0]?.options.input ?? "{}");
  assert.equal(payload.event, "APPROVE");
  assert.equal(payload.body, "🤖 Looks good.");
  assert.equal(payload.commit_id, "head-sha-123");
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0].path, "src/app.ts");
  assert.equal(payload.comments[0].line, 12);
  assert.equal(payload.comments[0].side, "RIGHT");
  assert.equal(payload.comments[0].body, "🤖 Fix this.");
  assert.equal(result.state, "APPROVED");
  assert.equal(result.id, 99);
});

test("GhCliGitHubGateway submits a structured pull request review with extended fields", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: JSON.stringify({
        id: 100,
        html_url: "https://github.com/example-org/repo/pull/43#pullrequestreview-100",
        body: "🤖 Range feedback.",
        state: "COMMENT",
        submitted_at: "2026-04-19T10:00:00.000Z",
        user: { login: "example-org" }
      }),
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  await gateway.submitPullRequestReview({
    owner: "example-org",
    name: "repo",
    pullRequestNumber: 43,
    event: "COMMENT",
    body: "🤖 Range feedback.",
    commitId: "head-sha-123",
    comments: [
      {
        path: "src/app.ts",
        line: 12,
        side: "LEFT",
        startLine: 10,
        startSide: "LEFT",
        body: "🤖 Fix this range."
      }
    ]
  });

  const payload = JSON.parse(runner.calls[0]?.options.input ?? "{}");
  assert.equal(payload.comments[0].side, "LEFT");
  assert.equal(payload.comments[0].start_line, 10);
  assert.equal(payload.comments[0].start_side, "LEFT");
});

test("GhCliGitHubGateway reacts to inline PR review comments through the pulls endpoint", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: "",
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  await gateway.addReaction({
    owner: "example-org",
    name: "repo",
    commentId: "6001",
    commentKind: "pull_request_review_comment",
    content: "eyes"
  });

  assert.deepEqual(runner.calls[0]?.args, [
    "api",
    "-X",
    "POST",
    "/repos/example-org/repo/pulls/comments/6001/reactions",
    "-f",
    "content=eyes"
  ]);
});

test("GhCliGitHubGateway reacts to issue and PR thread comments through the issues endpoint", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: "",
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  await gateway.addReaction({
    owner: "example-org",
    name: "repo",
    commentId: "5001",
    commentKind: "issue_comment",
    content: "+1"
  });

  assert.deepEqual(runner.calls[0]?.args, [
    "api",
    "-X",
    "POST",
    "/repos/example-org/repo/issues/comments/5001/reactions",
    "-f",
    "content=+1"
  ]);
});

test("GhCliGitHubGateway fetches PR top-level comments from the issues REST endpoint with numeric IDs", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: JSON.stringify([
        {
          id: 12345,
          html_url: "https://github.com/example-org/repo/pull/43#issuecomment-12345",
          body: "Top-level comment",
          created_at: "2026-05-03T10:00:00Z",
          updated_at: "2026-05-03T10:00:00Z",
          user: { login: "commenter" }
        }
      ]),
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  const comments = await gateway.listPullRequestComments("example-org", "repo", 43);

  assert.equal(runner.calls[0]?.args[0], "api");
  assert.ok(runner.calls[0]?.args.includes("repos/example-org/repo/issues/43/comments?per_page=100"));
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.id, "12345");
  assert.equal(comments[0]?.url, "https://github.com/example-org/repo/pull/43#issuecomment-12345");
});

test("GhCliGitHubGateway lists pull request changed files and parses patches", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: JSON.stringify([
        {
          filename: "src/app.ts",
          patch: "@@ -10,4 +10,5 @@\n context\n-old line\n+new line\n context\n+another new line"
        },
        {
          filename: "binary.png",
          patch: undefined
        }
      ]),
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  const files = await gateway.listPullRequestChangedFiles("example-org", "repo", 43);

  assert.equal(runner.calls[0]?.args[0], "api");
  assert.ok(runner.calls[0]?.args.includes("repos/example-org/repo/pulls/43/files?per_page=100"));
  assert.equal(files.length, 2);

  assert.equal(files[0]?.path, "src/app.ts");
  assert.deepEqual(files[0]?.leftChangedLines, [11]);
  assert.deepEqual(files[0]?.rightChangedLines, [11, 13]);
  assert.deepEqual(files[0]?.leftCommentableLines, [10, 11, 12]);
  assert.deepEqual(files[0]?.rightCommentableLines, [10, 11, 12, 13]);

  assert.equal(files[1]?.path, "binary.png");
  assert.deepEqual(files[1]?.leftChangedLines, []);
  assert.deepEqual(files[1]?.rightChangedLines, []);
  assert.deepEqual(files[1]?.leftCommentableLines, []);
  assert.deepEqual(files[1]?.rightCommentableLines, []);
});

test("GhCliGitHubGateway parses patches with multiple hunks", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: JSON.stringify([
        {
          filename: "src/multi.ts",
          patch:
            "@@ -1,3 +1,4 @@\n line1\n-line2\n+line2-new\n line3\n+line4\n@@ -10,2 +11,2 @@\n-old1\n+new1\n unchanged"
        }
      ]),
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  const files = await gateway.listPullRequestChangedFiles("example-org", "repo", 43);

  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "src/multi.ts");
  assert.deepEqual(files[0]?.leftChangedLines, [2, 10]);
  assert.deepEqual(files[0]?.rightChangedLines, [2, 4, 11]);
  assert.deepEqual(files[0]?.leftCommentableLines, [1, 2, 3, 10, 11]);
  assert.deepEqual(files[0]?.rightCommentableLines, [1, 2, 3, 4, 11, 12]);
});

test("GhCliGitHubGateway parses context lines as commentable", async () => {
  const runner = new RecordingCommandRunner([
    {
      stdout: JSON.stringify([
        {
          filename: "tasks.json",
          patch: '@@ -1,3 +1,3 @@\n {\n   "tasks": [\n-    "old"\n+    "new"'
        }
      ]),
      stderr: "",
      exitCode: 0
    }
  ]);
  const gateway = new UnsecuredGhCliGitHubGateway(runner);

  const files = await gateway.listPullRequestChangedFiles("example-org", "repo", 43);

  assert.equal(files.length, 1);
  const file = files[0]!;
  assert.deepEqual(file.leftChangedLines, [3]);
  assert.deepEqual(file.rightChangedLines, [3]);
  // Line 1 and 2 are unchanged context
  assert.ok(file.rightCommentableLines.includes(1));
  assert.ok(file.rightCommentableLines.includes(2));
  assert.ok(file.rightCommentableLines.includes(3));
  assert.ok(!file.rightChangedLines.includes(1));
  assert.ok(!file.rightChangedLines.includes(2));
});

class RecordingCommandRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: string[];
    options: CommandRunnerOptions;
  }> = [];

  constructor(private readonly results: CommandRunnerResult[]) {}

  async run(command: string, args: string[], options: CommandRunnerOptions = {}): Promise<CommandRunnerResult> {
    this.calls.push({ command, args, options });
    const next = this.results.shift();
    if (!next) {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }

    return next;
  }
}
