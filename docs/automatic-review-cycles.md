# Automatic review and fix cycles

Backburner can drive an open pull request from review feedback through fixes and
back to review. The repository's configured `agentReview` label authorizes the
cycle. The label may remain on the pull request: Backburner records the head at
which a session ends, so commits pushed by the cycle do not create an unbounded
label loop.

This behavior applies to regular workstream pull requests and packet pull
requests. For a regular PR that does not already have a Backburner worktree,
Backburner first materializes an isolated, PR-scoped checkout of the exact
`origin/<head-branch>` SHA. A session is not admitted without that durable
checkout; fork or otherwise unpushable heads are left untouched and retried on
a later scan after checkout access is resolved. Each pull request has its own
review session and turn budget.

## Lifecycle

A session starts from the pull request's current head. Backburner then:

1. Runs a review agent against that exact SHA.
2. Publishes the ordinary GitHub review comment, including actionable findings.
3. Stops if the result is `APPROVE` or has no actionable findings.
4. Otherwise runs one implementation agent for each finding. Findings are
   handled in dependency order, against the head left by earlier fixes.
5. Validates, commits, and pushes each successful fix; publishes the fix agent's
   report; and reviews the resulting head again.

One **fix turn** is one review result followed by the complete batch of fix
agents it requested. `maxTurns` limits fix batches, not reviewer invocations.
With the default of five, Backburner may run five fix batches followed by a
sixth, verification-only review. A value of zero runs a review but dispatches no
fix agent.

The session ends when the reviewer approves, reports no actionable findings,
the configured turn budget is exhausted, an agent or handoff fails, the label is
removed, the pull request closes, or a different head appears unexpectedly.
Backburner records the terminal head and posts a compact timeline showing each
review and fix agent, what it handled, and links to its GitHub output.

## Configuration

Set a per-repository budget in `repos.json`:

```json
{
  "id": "your-github-user-example-repo",
  "owner": "your-github-user",
  "name": "example-repo",
  "defaultBranch": "main",
  "localPath": "your-github-user/example-repo",
  "enabled": true,
  "reviewAutomation": {
    "maxTurns": 5
  },
  "labels": {
    "agentReview": "backburner:review"
  }
}
```

`reviewAutomation.maxTurns` defaults to `5` and accepts integers from `0` to
`50`. A session snapshots the configured value when it starts; changing the
configuration affects the next session.

## Steering and restarting

A human discussion or implementation task takes precedence over automatic
review work. If it pushes a different head, the next scan starts a fresh review
session with a reset budget. This lets a user steer the pull request while the
review label stays present.

After `max_turns`, copy the URL of Backburner's terminal timeline comment and
post this exact top-level pull request comment:

```text
continue: https://github.com/OWNER/REPO/pull/NUMBER#issuecomment-COMMENT_ID
```

After `failed`, use the same form with `retry:`:

```text
retry: https://github.com/OWNER/REPO/pull/NUMBER#issuecomment-COMMENT_ID
```

The author must be in `allowedUsers`, the URL must identify the terminal comment
on the same pull request, and the terminal state must match the command. Both
commands create a new session at the current head with a fresh configured
budget. They do not resume or retry an individual review or fix child.

## Review and fix contract

Cycle agents return versioned, strict JSON contracts. A review result identifies
the exact reviewed SHA and gives every finding a stable ID, actionability,
severity, evidence, impact, fix instruction, acceptance criteria, verification
steps, location when available, and dependency/overlap IDs. This is enough for
the orchestrator to create an explicit `fix_review_finding` task per actionable
finding without turning the review's own comments into discussion tasks.

A fix result identifies its finding, reports `fixed`, `already_covered`, or
`blocked`, lists changed paths and bounded checks, and can flag other findings
that the work also covered. A fix agent sees the complete review, the finding it
owns, and every finding disposition completed before it (including a dependency
that appeared later in the reviewer's original list). It must re-check the
current worktree because a previous fix may already have resolved its finding.
`fixed` and `already_covered` require at least one passing check and may not
contain failed or timed-out checks; an agent that cannot obtain passing evidence
must return `blocked`.

Backburner verifies the task-attributable diff, requires the expected remote
head, and stores an exact push intent before it uses a normal non-force push.
The successful push is then stored separately from GitHub's observation of the
new PR head. If GitHub is temporarily stale, the same session waits without
repushing or resetting its turn budget. A clean remote commit is accepted as
crash recovery only when it matches the durable orchestrator push intent; an
agent self-push is never inferred from local/remote ancestry alone. A blocked or
malformed result fails the entire session. Completed turn snapshots retain the
full review and final finding results, checks, files, and commit SHAs after the
next review begins.

## GitHub visibility and comment ownership

Review-cycle output starts with `🤖` and carries a hidden, session-scoped marker.
Backburner stores the GitHub IDs, authors, and URLs of review bodies, inline
comments, fix reports, command explanations, and the terminal timeline. The
receipt ID plus author index is authoritative for this flow; the visible prefix
is defense in depth and helps users recognize the team's output. A human comment
that starts with `🤖` is still steering unless it matches an owned receipt.
For submitted PR reviews the receipt records both GitHub's REST numeric ID and
GraphQL node alias, because scans expose the latter while review creation returns
the former.
Indexed orchestrator comments never dispatch ordinary
`respond_pr_comment` work.

Malformed, stale, inline, wrong-state, or wrong-target `continue:`/`retry:`
commands receive one marker-idempotent explanation on GitHub instead of being
silently discarded.

Publication is reconciled by the hidden marker before posting, so a process
restart after a GitHub write does not intentionally duplicate output. A failed
publication remains pending and is retried; it is never treated as handled.

## Failure and recovery

Any review agent, fix agent, strict-contract, workspace, commit, push, or head
verification failure makes the session `failed`. Individual cycle children are
not resumable or addressable by the generic failed-task retry command. Use the
terminal `retry:` command to restart the whole process, or push a human-directed
change and let the new head start a fresh session.

If a child finishes but its result, handoff, or post-edit verification fails,
Backburner rewrites that child and execution as failed, marks its provider
conversation stale, and requires workspace recovery before another session can
start. This prevents retrying a partially trusted child conversation or carrying
dirty/ahead state into the whole-session retry.

Every implementation prompt requires local commands to have explicit wall-clock
bounds below the agent timeout. Agents should use the platform's available
timeout mechanism and report a timed-out check instead of waiting indefinitely.

Durable state is stored in `review-sessions.json`. When troubleshooting, compare
`expectedHeadSha`, `terminalHeadSha`, task/execution IDs, publication receipts,
and the ordered event timeline with the pull request's live head and comments.

## Chosen architecture

The orchestrator owns a narrow, per-pull-request review-session aggregate and a
pure state machine. Normal task dispatch still runs each review and finding fix;
the session owns conditional sequencing, turn accounting, exact-head checks,
GitHub publication receipts, and terminal state. There is no separate generic
cycle primitive: `continue:` and `retry:` create a new task-scoped session from
durable terminal state.
