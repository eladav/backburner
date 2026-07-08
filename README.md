# Backburner CLI

Backburner is a local GitHub-driven agent orchestration CLI. It uses GitHub labels, issues, and pull requests as the control plane, keeps configuration and state as readable JSON on your machine, and dispatches eligible work to provider CLIs that you already have installed locally.

Backburner currently supports:

- `backburner init` for interactive or non-interactive local setup
- `backburner run` for one orchestration cycle
- `backburner run-loop` for repeated cycles on a fixed interval
- `backburner journal` for reading persisted run and workflow events
- `backburner broker` for a local GitHub broker MCP endpoint
- a plan-first label workflow for product approval, plan approval, review requests, and parent-branch sync approval
- local provider CLIs for Antigravity, Codex, Gemini, Claude, and OpenCode

## Prerequisites

- Node.js `>=20`
- npm
- git
- GitHub CLI authenticated for the account and repositories you want Backburner to manage:

```sh
gh auth status
```

- at least one supported provider CLI on `PATH`: `agy`, `codex`, `gemini`, `claude`, or `opencode`

Backburner uses your local `git`, `gh`, and provider CLI credentials. It does not provide hosted execution or cloud credentials.

## Install

From a source checkout:

```sh
npm install
npm run build
node dist/src/cli/run.js init
```

Windows PowerShell:

```powershell
npm install
npm run build
node .\dist\src\cli\run.js init
```

For active local development, link this checkout into your global npm bin directory:

```sh
npm run link:local
backburner init
```

To install and verify the locally packed package:

```sh
npm run install:local
backburner journal --json
```

To install the local package into a temporary npm prefix:

macOS/Linux:

```sh
npm run install:local -- --prefix /tmp/backburner-local
/tmp/backburner-local/bin/backburner journal --json
```

Windows PowerShell:

```powershell
npm run install:local -- --prefix "$env:TEMP\backburner-local"
& "$env:TEMP\backburner-local\backburner.cmd" journal --json
```

Once the current package is published:

```sh
npm install -g @backburner/cli
backburner init
```

The package bin is `backburner`.

The npm package intentionally includes the compiled CLI under `dist/src`, `README.md`, `LICENSE`, and package metadata. Contributor docs and generated docs are kept in the source repository and are not part of the install tarball.

## Quick Start

Run onboarding:

```sh
backburner init
```

Source checkout equivalent:

```sh
node dist/src/cli/run.js init
```

Non-interactive setup accepts defaults:

```sh
backburner init --yes
```

Useful `init` flags:

```text
--code-root <path>       Root where managed repos are cloned
--management-dir <path>  Directory for configuration files
--outputs-dir <path>     Directory for generated state, journal, and logs
--log-dir <path>         Directory for execution logs
--workspaces-dir <path>  Directory used by onboarding readiness checks
--yes, -y                Accept defaults without prompts
```

`backburner init` checks local requirements, confirms `gh auth status`, discovers repositories, detects provider CLIs, and writes these files into the management directory:

- `repos.json`
- `agents.json`

If either file already exists, onboarding asks before overwriting it. With `--yes`, defaults are accepted non-interactively.

## Default Directories

By default, Backburner stores data under `~/.backburner`:

- code root: `~/.backburner/code`
- management directory: `~/.backburner/management`
- outputs directory: `~/.backburner/outputs`
- state directory: `~/.backburner/outputs/state`
- journal directory: `~/.backburner/outputs/journal`
- log directory: `~/.backburner/outputs/logs`
- onboarding workspaces directory: `<code-root>/_worktrees`

Set `BACKBURNER_ROOT` to change the root used for the default code, management, and outputs directories.

## Configuration

Backburner configuration lives in the management directory.

Minimal `repos.json`:

```json
{
  "allowedUsers": [
    "your-github-user"
  ],
  "repos": [
    {
      "id": "your-github-user-example-repo",
      "owner": "your-github-user",
      "name": "example-repo",
      "defaultBranch": "main",
      "localPath": "your-github-user/example-repo",
      "enabled": true,
      "labels": {
        "agentInProgress": "agent-in-progress",
        "agentProductApproved": "agent-product-approved",
        "agentPlanApproved": "agent-plan-approved",
        "agentReview": "agent-review",
        "planBreakdownNeeded": "plan-breakdown-needed",
        "agentSyncParentBranch": "agent-sync-parent-branch",
        "prepareForMerge": "prepare-for-merge"
      }
    }
  ]
}
```

Minimal `agents.json`:

```json
{
  "agents": [
    {
      "id": "codex-strong",
      "provider": "codex",
      "modelClass": "strong",
      "model": "gpt-5",
      "roles": [
        "product",
        "planning",
        "review",
        "discussion",
        "implementation_manager"
      ],
      "command": "codex",
      "enabled": true
    },
    {
      "id": "opencode-cheap",
      "provider": "opencode",
      "modelClass": "cheap",
      "model": "your-fast-model",
      "roles": [
        "implementation",
        "discussion"
      ],
      "command": "opencode",
      "enabled": true
    }
  ]
}
```

`allowedUsers` limits which GitHub users can feed issues, comments, reviews, and pull requests into task derivation. `localPath` must be relative to `--code-root`.

Agent selection filters enabled agents by required role and `modelClass`, then breaks ties by lowest agent `id`. Provider model names are passed through to the provider CLI and are not validated against vendor catalogs.

## Label Control Plane

Configure labels per repository in `repos.json`. The common defaults are:

- `agent-product-approved`: approves product discovery and allows Backburner to create the implementation PR/worktree flow for an issue
- `agent-plan-approved`: approves an implementation plan and allows implementation tasks to run
- `agent-review`: requests an explicit code review; review tasks are dispatched when the PR has this label and its head SHA changed since the last review
- `agent-sync-parent-branch`: authorizes Backburner to sync a blocked parent implementation branch from the repository default branch

Backburner also uses `agent-in-progress`, `plan-breakdown-needed`, and `prepare-for-merge` when those labels are configured.

## Commands

Run one cycle:

```sh
backburner run
```

Source checkout:

```sh
node dist/src/cli/run.js run
```

Common run flags:

```text
--code-root <path>
--management-dir <path>
--outputs-dir <path>
--log-dir <path>
--broker-port <port>
--headless
--once
```

Run continuously:

```sh
backburner run-loop --interval-minutes 5
```

`run-loop` accepts the same path and broker flags as `run`, plus either `--interval-seconds <seconds>` or `--interval-minutes <minutes>`. The default interval is 5 minutes. `SIGINT` and `SIGTERM` request a graceful stop after the current cycle.

Read the journal:

```sh
backburner journal --last 20
backburner journal --repo your-github-user-example-repo --json
```

Journal filters:

```text
--outputs-dir <path>
--repo <id>
--workstream <id>
--issue <number>
--pr <number>
--since <ISO timestamp>
--last <number>
--json
--verbose
```

Start the GitHub broker MCP:

```sh
backburner broker --port 4444
```

Broker flags:

```text
--management-dir <path>
--host <host>
--port <port>
```

The broker serves:

- `POST /mcp`
- `GET /health`

It exposes managed-repository tools for issue, PR, comment, check-run, code-search, PR creation, and PR review-comment reply workflows, plus plan-breakdown and wave-assessment tools used by Backburner providers.

Smoke-test the broker after building:

```sh
npm run smoke:github-broker
npm run smoke:github-broker -- --repo your-github-user/example-repo --issue-number 123
```

## What A Run Does

`backburner run` loads configuration, prepares local management and outputs directories, loads state, syncs enabled repositories, scans GitHub through `gh`, derives tasks, starts a local GitHub broker for provider access, dispatches eligible tasks to configured provider CLIs, writes state and logs, and prints a run summary.

Generated files are readable JSON. Control-plane state is written under `<outputs-dir>/state`, including repository sync status, issues, PRs, comments, tasks, worktrees, attention records, MCP status, provider limits, and job memory. Execution logs and artifacts are written under `<outputs-dir>/logs`. Journal events are written under `<outputs-dir>/journal`.

## Platform Support

Backburner is intended to run on macOS, Linux, and Windows with Node.js 20 or newer. The current CI workflow in this checkout runs on Ubuntu, macOS, and Windows with Node 20 and 22, and includes build, typecheck, tests, package dry-run, and local package install smoke checks.

## Verification

Use these checks before publishing or changing behavior:

```sh
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

For docs-only changes, at minimum verify that documented commands, package contents, and public-safety scrub patterns still match the repository.
