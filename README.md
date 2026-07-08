# backburner-cli

`backburner-cli` is a local GitHub-driven orchestration MVP. It treats a management folder as the control plane for configuration, and an independent `outputs/` folder as the root for generated readable orchestration state and execution logs. It scans configured GitHub repositories for open issues and pull requests, derives deterministic tasks, and dispatches eligible work to local CLI agents like Antigravity, Codex, Claude, and OpenCode.

The current MVP supports:

- syncing configured repos into a supplied code root
- scanning GitHub issues, PRs, and comments through `gh`
- deriving stable product discovery, review, planning, and implementation tasks
- creating deterministic implementation worktrees after product approval
- enforcing a plan-first flow with PR label approval gating
- persisting readable JSON control-plane state in `outputs/state/`
- persisting execution logs for each run in `outputs/logs/`
- local agent dispatching to Antigravity, Codex, Claude, and OpenCode CLIs

## Quick Start — `backburner init`

The fastest way to get a working local configuration is to run the interactive onboarding wizard:

macOS/Linux:

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

Or, if you have installed the package globally:

```sh
backburner init
```

The wizard walks through the following steps automatically:

| Step | What it does |
|------|-------------|
| **Check requirements** | Verifies `git`, `gh`, and `node ≥ 20` are on PATH |
| **GitHub authentication** | Confirms `gh auth status`; extracts your GitHub username |
| **Repository discovery** | Lists your GitHub repos via `gh repo list`; scans your code root for local clones |
| **Repository selection** | Lets you pick which repos Backburner should manage |
| **Directory configuration** | Asks for management, outputs, logs, and workspaces directories |
| **Provider detection** | Finds available AI CLIs: `agy`, `claude`, `codex`, `opencode` |
| **Model assignment** | Lets you assign a provider + model to the strong and cheap agent roles |
| **Config generation** | Writes `repos.json` and `agents.json` into your management directory |
| **Readiness check** | Re-runs all validations against the generated config |
| **Summary** | Prints configured repos, agents, paths, warnings, and next steps |

### `backburner init` flags

```
--code-root <path>       Root directory where repos will be cloned (default: ~/.backburner/code)
--management-dir <path>  Override the management directory
--outputs-dir <path>     Override the outputs directory
--log-dir <path>         Override the log directory
--workspaces-dir <path>  Override the onboarding workspaces readiness directory (default: <code-root>/_worktrees)
--yes  -y                Non-interactive: accept all defaults without prompting
```

### Re-running `backburner init`

If a `repos.json` or `agents.json` already exists in the management directory, `backburner init` will detect them, print a summary, and ask whether to overwrite. Answering **no** preserves the existing files and skips config generation.

### Running `backburner init` in CI or scripts

Pass `--yes` to skip all interactive prompts and accept defaults:

```sh
node dist/src/cli/run.js init --yes
```

---

## Prerequisites

- Node.js `>=20`
- `npm`
- `git` installed and authenticated for the repositories you manage
- `gh` installed and authenticated for the same GitHub account
- at least one supported agent CLI installed locally and available on `PATH`: `agy`, `codex`, `claude`, or `opencode`

Assumptions in the current MVP:

- `gh` can read repo metadata, issues, PRs, comments, reviews, and create PRs
- `git` can clone repos, fetch `origin`, create worktrees, commit, and push branches
- configured provider CLIs are correctly authenticated
- the orchestrator uses your local `git` and `gh` credentials
- GitHub messages authored by the agents should begin with `🤖`; prompts remind runners of this

## Install And Build

```sh
npm install
npm run build
```

`npm run build` cleans `dist/`, compiles the TypeScript runtime, verifies that
`dist/src/cli/run.js` has a Node shebang, and marks it executable.

## Configuration

The management repo is configured through:

- `management/repos.json`
- `management/agents.json`

### `management/repos.json`

Each repo entry tells the orchestrator which repository to manage, where to clone it under the code root, and which labels act as the control plane.

```json
{
  "allowedUsers": [
    "eladav"
  ],
  "repos": [
    {
      "id": "testing-management",
      "owner": "eladav",
      "name": "testing-management",
      "defaultBranch": "main",
      "localPath": "testing-management",
      "enabled": true,
      "labels": {
        "agentProductApproved": "agent-product-approved",
        "agentInProgress": "agent-in-progress",
        "agentPlanApproved": "agent-plan-approved",
        "agentReview": "agent-review",
        "agentSyncParentBranch": "agent-sync-parent-branch"
      }
    }
  ]
}
```

Rules:

- `allowedUsers` is required and lists the GitHub logins whose issues, PRs, comments, and reviews may enter task derivation
- `localPath` must be relative and stay inside the supplied `--code-root`
- `enabled: false` skips the repo entirely
- `defaultBranch` is optional; if omitted, the orchestrator asks GitHub first and `git` second
- `labels.agentProductApproved` is optional and defaults to `agent-product-approved`; add this label to an issue to approve Product Discovery and authorize PR/worktree creation
- `labels.agentSyncParentBranch` is optional and defaults to `agent-sync-parent-branch`; add this label to a parent implementation PR to authorize the orchestrator to resolve a packet-wave parent branch sync blocker

### `management/agents.json`

Agent entries tell the orchestrator which local CLI to use for each task class.

```json
{
  "agents": [
    {
      "id": "antigravity-strong",
      "provider": "antigravity",
      "modelClass": "strong",
      "model": "Gemini 3.1 Pro (High)",
      "roles": ["product", "planning", "review", "discussion"],
      "command": "agy",
      "enabled": true
    },
    {
      "id": "antigravity-cheap",
      "provider": "antigravity",
      "modelClass": "cheap",
      "model": "Gemini 3.5 Flash (Low)",
      "roles": ["implementation", "discussion"],
      "command": "agy",
      "enabled": true
    },
    {
      "id": "codex-strong",
      "provider": "codex",
      "modelClass": "strong",
      "model": "gpt-4o",
      "roles": ["product", "planning", "review", "discussion"],
      "command": "codex",
      "enabled": true
    },
    {
      "id": "claude-cheap",
      "provider": "claude",
      "modelClass": "cheap",
      "model": "claude-haiku-4-6",
      "roles": ["discussion", "implementation"],
      "command": "claude",
      "enabled": true
    }
  ]
}
```

The orchestrator selects an agent for each task by:
1. Finding all **enabled** agents.
2. Filtering by the **role** required for the task.
3. Filtering by the **modelClass** required for the task.
4. Breaking ties by selecting the agent with the lowest **id**.

The `provider` field does not participate in task routing; it only chooses the concrete runner after an agent has been selected.

#### `modelClass` vs `model`

- `modelClass` (`"strong"` or `"cheap"`) controls **routing only**. The orchestrator uses it to match tasks to agents; it has no inherent meaning beyond the user's own classification.
- `model` controls the **provider runtime model**. When present, the provider CLI receives this exact string as the model argument. When absent, each provider uses its built-in default.
- The same physical model may appear as `"strong"` for one user and `"cheap"` for another. The orchestrator does not interpret or validate these labels.
- Provider model names are passed through as-is and are not validated against vendor catalogs.

#### Required Model Class Mapping

Each workflow task requires an exact `modelClass`:

| Task kind | Required `modelClass` | Role |
| --- | --- | --- |
| `product_discovery` | `strong` | `product` |
| `write_product_spec` | `strong` | `product` |
| `respond_issue_comment` during Product Discovery or Product Specification | `strong` | `product` |
| `respond_issue_comment` outside product phases | `strong` | `discussion` |
| `review_pr` | `strong` | `review` |
| `write_plan` | `strong` | `planning` |
| `plan_breakdown` | `strong` | `implementation_manager` |
| `sync_parent_branch_preflight` | `strong` | `implementation_manager` |
| `implement_plan` | `cheap` | `implementation` |
| `respond_pr_comment` | `cheap` | `discussion` |

`sync_parent_branch` is an orchestrator-owned git action, not an agent-dispatched task.

## Run The Orchestrator

With the default layout, use a single command:

```sh
npm run build
node dist/src/cli/run.js run
```

## Package CLI

The package exposes the CLI as the `backburner` npm bin:

```json
{
  "bin": {
    "backburner": "./dist/src/cli/run.js"
  }
}
```

After building, the compiled entrypoint can be run directly:

macOS/Linux:

```sh
./dist/src/cli/run.js run
```

Windows PowerShell:

```powershell
node .\dist\src\cli\run.js run
```

For local development, link this checkout into your global npm bin directory:

```sh
npm run link:local
backburner run
```

This is convenient while editing, but it points the global command at the
mutable checkout. Use this script instead of a bare `npm install -g .` from a
clean checkout; folder installs do not run the package build before linking the
bin. To test the same tarball shape that npm will install later, install a
packed local copy instead:

```sh
npm run install:local
backburner run-loop --interval-minutes 5
```

To install into a temporary npm prefix without changing your real global npm
packages:

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

The command:

- loads `management/repos.json` and `management/agents.json`
- loads or initializes `outputs/state/*.json`
- syncs each enabled repo into the supplied code root
- scans GitHub state
- derives tasks
- starts new issues in Product Discovery and waits for the issue `agentProductApproved` label before creating an implementation worktree and PR
- dispatches eligible pending tasks to the configured agents
- runs explicitly authorized parent branch sync actions for blocked packet waves
- writes updated control-plane state to `outputs/state/` plus execution logs to `outputs/logs/`
- prints a readable run summary

You can also split the configuration folder from the generated outputs folder:

macOS/Linux:

```sh
node dist/src/cli/run.js run \
  --code-root /absolute/path/to/code-root \
  --management-dir /absolute/path/to/management \
  --outputs-dir /absolute/path/to/outputs \
  --broker-port 4444
```

Windows PowerShell:

```powershell
node .\dist\src\cli\run.js run `
  --code-root "C:\absolute\path\to\code-root" `
  --management-dir "C:\absolute\path\to\management" `
  --outputs-dir "C:\absolute\path\to\outputs" `
  --broker-port 4444
```

Default behavior:

- `--code-root` defaults to `~/.backburner/code`
- `--management-dir` defaults to `~/.backburner/management`
- `--outputs-dir` defaults to `~/.backburner/outputs`
- `--log-dir` defaults to `<outputs-dir>/logs`
- `--broker-port` defaults to `4444`; assign different ports to concurrent orchestrator runs

With configuration and outputs in the default folders, the normal background
loop can be:

```sh
backburner run-loop --interval-minutes 5
```

## Resolve Packet Parent Branch Sync Blockers

When a packet wave is complete, the next wave can start only after the parent implementation branch is up to date with the repo default branch. If the parent branch is behind or diverged, the orchestrator reports a parent branch sync blocker in the run summary and in the parent PR packet lifecycle comment.

To authorize the orchestrator to resolve it:

1. Add the configured sync label to the parent implementation PR. By default this is `agent-sync-parent-branch`.
2. Run the orchestrator again.
3. Read the robot-prefixed PR feedback comment for the result.

The action is intentionally narrow:

- without the label, sync preflight stays read-only
- for `behind_default`, the orchestrator merges the default branch into the parent branch and pushes
- for `diverged`, the orchestrator attempts one normal merge and reports conflicts if they occur
- it never rebases or force-pushes
- packet wave advancement still requires a refreshed branch comparison of `up_to_date`

## Run The Orchestrator Continuously

To keep the orchestrator running and execute another cycle on a fixed interval:

```sh
node dist/src/cli/run.js run-loop --broker-port 4444
```

Interval options:

- default interval: 5 minutes
- `--interval-seconds <seconds>` sets the loop interval in seconds
- `--interval-minutes <minutes>` sets the loop interval in minutes

Shutdown behavior:

- `SIGINT` / `SIGTERM` request a graceful stop
- the current orchestration cycle is allowed to finish
- the next cycle is not started after shutdown is requested
- broker shutdown still happens through the existing per-run cleanup path

## Run The GitHub Broker MCP

The orchestrator can also host a local GitHub broker MCP over HTTP:

```sh
node dist/src/cli/run.js broker --port 4318
```

This serves:

- `POST /mcp` for MCP JSON-RPC
- `GET /health` for a simple local health check

The broker exposes typed tools for managed repos only:

- `get_issue`
- `get_issue_comments`
- `get_pr`
- `get_pr_comments`
- `search_code`
- `post_issue_comment`
- `create_pr`

For a quick local probe after `npm run build`:

```sh
npm run smoke:github-broker
```

To include a real issue fetch in the smoke command:

```sh
npm run smoke:github-broker -- --repo owner/name --issue-number 123
```

## State Files

Control-plane state is pretty-printed JSON under `outputs/state`.

- `repos.json`: local sync results and GitHub scan status per configured repo
- `issues.json`: normalized open issues plus scan metadata
- `prs.json`: normalized open pull requests plus scan metadata
- `comments.json`: normalized comments, reviews, and inline review comments plus scan metadata
- `tasks.json`: deterministic task records and current task status
- `worktrees.json`: deterministic implementation worktrees and their current workflow state
- `attention.json`: current workstream attention reasons

Execution logs live under `outputs/logs`.

- `executions.json`: persisted dispatch results and artifact paths
- `artifacts/<execution-id>/`: prompt packet, rendered prompt, stdout, and stderr for each agent execution

## Current Workflow

At a high level:

- new issues become Product Discovery tasks
- issue comments during Product Discovery and Product Specification route back to the Product role
- issue-comment responses answer in phase context; they do not choose `start_implementation`
- adding the repo’s `agentProductApproved` label to the issue creates the deterministic worktree and PR
- the first PR task asks the Product role to write the Product Spec
- planning starts only after the Product Spec exists as a non-empty artifact
- new PRs become review tasks
- new or edited comments on already-known items become response tasks
- `implement_plan` is only derived after the linked PR has the repo’s `agentPlanApproved` label

## Verification Commands

The repository uses these commands:

```sh
npm run build
npm run typecheck
npm test
```

Onboarding:

macOS/Linux:

```sh
node dist/src/cli/run.js init               # interactive wizard
node dist/src/cli/run.js init --yes         # non-interactive, accept defaults
npm run init                                # alias for the above
```

Windows PowerShell:

```powershell
node .\dist\src\cli\run.js init             # interactive wizard
node .\dist\src\cli\run.js init --yes       # non-interactive, accept defaults
npm run init                                # alias for the above
```

Single orchestration cycle:

macOS/Linux:

```sh
node dist/src/cli/run.js run
```

Windows PowerShell:

```powershell
node .\dist\src\cli\run.js run
```

The sample CLI run depends on your local `git`, `gh`, and agent CLI setup plus whatever repos are configured in the selected management folder's `repos.json`.
