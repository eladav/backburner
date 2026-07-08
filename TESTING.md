# Testing and Dogfooding

This repository orchestrates real local agents through GitHub state. Tests must cover both pure logic and the real integration constraints that shape the product: labels, `gh`, `git`, local worktrees, same-user GitHub credentials, readable JSON state, and run-scoped agent execution.

## Required Local Checks

Run these before claiming an implementation is complete:

```sh
npm run build
npm run typecheck
npm test
```

When you touch a focused area, also run the relevant compiled test directly after `npm run build`, for example:

```sh
node --test dist/test/agents.test.js
node --test dist/test/tasks.test.js
node --test dist/test/github-scan.test.js
node --test dist/test/workstreams.test.js
```

## Test the Product Shape, Not Only the Helper

This code is full of small pure helpers, but the important failures usually happen at the workflow boundaries:

- scan result -> persisted state
- persisted state -> attention
- attention -> workstream phase
- workstream phase -> task derivation
- task dispatch -> external side effect
- completed task -> next-cycle task merge
- structured agent result -> GitHub publication

When fixing a bug, write at least one test at the lowest useful level and one regression that crosses the boundary where the bug escaped.

Examples:

- A scan carry-forward bug needs focused `GitHubScanService` tests and a regression showing old comments are not reclassified as new after a partial scan.
- A label/attention bug needs tests that include the configured repo labels, current PR labels, derived attention, and derived tasks.
- A dispatch publication bug needs tests around `dispatchPendingTasks` plus the publisher, not only the JSON parser.

## Dogfooding Rules

Dogfooding is required when a change depends on behavior that local fakes cannot honestly prove.

Use a disposable test repository you control for live GitHub behavior when appropriate. Keep live tests small, reversible, and clearly marked.

Good dogfood targets:

- `gh` API shape and permissions
- same-user GitHub restrictions
- inline PR review comment placement
- PR thread comments
- label names and label-driven control flow
- run-loop behavior against real persisted state

Never touch files outside the assigned workspace. For dogfooding, run the process from the assigned workspace and keep its management, log, and code-root directories inside that workspace:

```sh
mkdir -p .dogfood/management .dogfood/logs .dogfood/code-root
```

Use a minimal config for live scans, and disable agents unless dispatch itself is the thing being tested.

## Dogfood Matrix

Before relying on a live integration behavior, test the exact variant the orchestrator will use.

For GitHub review publication, test all event shapes you depend on:

- same-user PR + `event: COMMENT` + inline comments
- same-user PR + summary-only `event: COMMENT`
- fallback to a normal PR thread comment

Do not assume that because one review endpoint call succeeds, all review endpoint calls succeed. GitHub accepts same-user `COMMENT` reviews with inline comments, but rejects formal same-user `APPROVE` / `REQUEST_CHANGES` reviews on the user's own PR.

## Incident Example: Review Publication Escaped Testing

We had a bug where a review agent returned:

```json
{
  "action": "REQUEST_CHANGES",
  "summary": "Typecheck passed, but ...",
  "inlineComments": [
    {
      "path": "src/workstreams/packet-candidates.ts",
      "line": 30,
      "body": "..."
    }
  ]
}
```

The orchestrator tried to publish that result as a formal GitHub review with:

```json
{
  "event": "REQUEST_CHANGES",
  "comments": [...]
}
```

GitHub rejected it with HTTP 422 because the orchestrator was using the same user's credentials as the PR author. The fallback removed inline comments, but still used:

```json
{
  "event": "REQUEST_CHANGES"
}
```

So the fallback failed for the same reason.

The local tests passed because they used fake GitHub gateways that accepted every review event. The tests did include `COMMENT` cases, but the main `REQUEST_CHANGES` and `APPROVE` paths were never dogfooded against a same-user PR.

The fix was to treat the agent's review action as internal orchestration data and publish GitHub reviews as non-blocking comments:

- GitHub event: `COMMENT`
- Body includes the preserved decision, such as `🤖 Review result: changes requested`
- Inline comments are attempted under `COMMENT`
- Summary-only `COMMENT` is the first fallback
- Normal PR thread comment is the final fallback

Lesson: a fake that accepts all API variants is not enough. If a behavior depends on provider permission semantics, dogfood the exact provider call shape.

## What to Report

When finishing an implementation, report:

- changed files
- exact commands run
- local checks that passed
- live dogfood performed, including target repo/PR/issue
- any live side effects created, with URLs or IDs when available
- assumptions and remaining risks

Never claim a live integration works because a mock accepted it. Say what was actually exercised.
