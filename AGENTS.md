You are implementing a local GitHub-based agent orchestration MVP in Node.js + TypeScript.

Repository rules:
- Preserve the GitHub-driven control-plane model: labels drive workflow, worktrees are the implementation unit, and context is rebuilt each cycle.
- Optimize for a fast, correct MVP, not a framework.
- Keep the design modular, but avoid speculative abstractions.
- Do not add features that were not requested in the current step.
- Prefer simple, explicit code over cleverness.
- Use strict TypeScript.
- Minimize dependencies. Prefer Node built-ins unless a package clearly helps.
- Keep persisted config and state human-readable JSON.
- Keep modules small and testable.
- Do not fake real external integrations. If `gh`, `git`, Codex CLI, or Gemini CLI behavior must be represented, keep it behind explicit interfaces and use stub implementations or explicit test doubles.

Implementation guidance:
- The management repo is the control plane and owner of orchestration state.
- Current scope is scaffold only: config loading, state loading, types, interfaces, placeholder implementations, and a minimal CLI bootstrap.
- Required boundaries are:
  - `GitHubGateway`
  - `GitGateway`
  - `AgentRunner`
  - `ContextBuilder`
- Persist control-plane orchestration state in `<management-dir>/state/*.json`.
- Persist execution logs in a separate log directory when configured.
- Keep all JSON pretty-printed and readable.
- Use one module system consistently across the repo.
- Do not introduce a plugin framework, MCP server, or dynamic workflow engine yet.
- Do not implement real GitHub scanning, git syncing, or agent dispatch in this step.
- Preserve the product intent that labels act as the GitHub control plane, worktrees are the implementation unit, and context is rebuilt each cycle.
- Repository labels used by the orchestrator (configured per-repo in `repos.json`):
  - `agentInProgress` (default: `agent-in-progress`): Marks a PR as being actively worked on by an agent.
  - `agentPlanApproved` (default: `agent-plan-approved`): Signals the plan is approved and implementation can begin.
  - `agentReview` (default: `agent-review`): Requests an explicit code review. The orchestrator only dispatches `review_pr` tasks when this label is present AND the PR has new commits (head SHA changed) since the last review.

Verification requirements for implementation tasks:
- Install dependencies.
- Run build.
- Run typecheck.
- Run tests.
- Run the CLI once with a sample `--code-root`.
- Confirm required files exist.
- Report:
  - what changed
  - exact commands run
  - which checks passed
  - which checks failed
  - assumptions or follow-up risks
- Do not claim success unless all required checks pass.
