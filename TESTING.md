# Testing And Dogfooding

Backburner coordinates real local tools through GitHub state. Tests need to cover both pure TypeScript logic and the integration boundaries that shape behavior: labels, `gh`, `git`, local worktrees, provider CLIs, readable JSON state, package installation, and run-scoped execution.

## Required Local Checks

Run these before claiming an implementation is complete:

```sh
npm run build
npm run typecheck
npm test
```

Run a package check when package contents, docs inclusion, install instructions, bin wiring, or release metadata change:

```sh
npm pack --dry-run
```

For docs-only changes, the full test suite is optional unless examples or scripts changed. Run focused checks that prove the edited docs are public-safe and reference real commands.

## Focused Tests

When a change touches a specific area, run the compiled tests for that area after `npm run build`:

```sh
node --import ./dist/test/setup.js --test dist/test/<name>.test.js
```

Useful focus areas:

- Onboarding: config generation, path defaults, provider discovery, GitHub auth checks, and readiness validation.
- GitHub broker: scoped repo access, typed tool behavior, MCP transport, and broker smoke coverage.
- Provider launch: command construction, model selection, execution records, limit detection, and failure handling.
- Workstreams: label gates, phase transitions, packet planning, parent-branch sync, task derivation, and attention state.
- Packaging: compiled CLI entrypoint, shebang and executable bit, npm bin wiring, local link, local packed install, and tarball contents.

## Test The Product Shape

Small helper tests are useful, but the important failures usually happen at workflow boundaries:

- scan result -> persisted state
- persisted state -> attention
- attention -> workstream phase
- workstream phase -> task derivation
- task dispatch -> external side effect
- completed task -> next-cycle task merge
- structured agent result -> GitHub publication

When fixing a bug, write at least one test at the lowest useful level and one regression that crosses the boundary where the bug escaped.

Examples:

- A scan carry-forward bug needs focused scan tests and a regression showing old comments are not reclassified as new after a partial scan.
- A label or attention bug needs tests that include configured repo labels, current issue or PR labels, derived attention, and derived tasks.
- A publication bug needs tests around dispatch and publisher behavior, not only the JSON parser that produced the result.

## Live GitHub Dogfooding

Dogfooding is required when a change depends on behavior that local fakes cannot honestly prove.

Use a disposable repository you control, for example `your-github-user/backburner-dogfood`. Keep live tests small, reversible, and clearly marked. Do not use production repositories unless the task explicitly requires it.

Good dogfood targets:

- `gh` API shape and permissions
- same-user GitHub restrictions
- inline PR review comment placement
- PR thread comments
- label names and label-driven control flow
- run-loop behavior against real persisted state
- local package install and executable `backburner` bin behavior

Keep state and logs isolated in project-local ignored folders or OS temp directories with generic names:

```sh
mkdir -p .dogfood/management .dogfood/outputs .dogfood/logs .dogfood/code-root
```

or:

```sh
mkdir -p /tmp/backburner-dogfood/management /tmp/backburner-dogfood/outputs /tmp/backburner-dogfood/code-root
```

Use minimal config for live scans, and disable agents unless dispatch itself is the thing being tested.

## Dogfood Matrix

Before relying on live integration behavior, test the exact variant Backburner will use.

For GitHub review publication, test all event shapes you depend on:

- same-user PR + `event: COMMENT` + inline comments
- same-user PR + summary-only `event: COMMENT`
- fallback to a normal PR thread comment

Do not assume that because one review endpoint call succeeds, all review endpoint calls succeed. GitHub can accept same-user comment reviews while rejecting formal same-user approval or request-changes reviews on the author's own PR.

## Provider-Permission Lesson

A local fake that accepts every API variant can hide real provider restrictions. One class of failure is treating an agent's internal review decision as the exact GitHub review event to publish. If the local credential belongs to the PR author, formal review events such as approval or request-changes may be rejected even when a non-blocking comment review would be accepted.

For review publication behavior, keep the internal decision and the GitHub event separate:

- publish non-blocking GitHub comments for same-user-safe feedback paths
- attempt inline comments only with an event shape GitHub accepts for the scenario
- fall back to summary comments when inline comments fail
- fall back to normal PR thread comments when review publication fails
- cover these fallbacks with tests and dogfood the live call shape when permission semantics matter

Lesson: mocks prove that Backburner called an interface. They do not prove that GitHub, git, or a provider CLI will accept the real command shape.

## Public Doc Checks

For public documentation edits, scan for private or stale residue such as old product names, private absolute paths, personal repository names, generated artifact paths, stale command aliases, and unresolved placeholder notes.

If docs include command examples, verify those scripts or CLI commands exist before claiming the docs are accurate.

## What To Report

When finishing an implementation, report:

- changed files
- exact commands run
- local checks that passed
- local checks that failed
- live dogfood performed, including target repo, issue, or PR when applicable
- live side effects created, with URLs or IDs when available
- assumptions and remaining risks

Never claim a live integration works because a mock accepted it. Say what was actually exercised.
