# Security Policy

Backburner coordinates coding agents that run on your machine with access to source code, local tools, GitHub credentials, and model-provider credentials. That is the product's core capability and its primary security boundary.

Read this document before granting Backburner access to an important repository.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, discussion, pull request, or Hacker News thread.

Use GitHub's private vulnerability reporting for this repository when it is available. If the repository does not show a **Report a vulnerability** option on its Security page, open a public issue containing only a request for a private security contact channel—do not include exploit details, secrets, affected repository names, or logs.

Include, when possible:

- the affected Backburner version and operating system;
- the impact and the trust boundary that was crossed;
- minimal reproduction steps;
- whether credentials or private repository data may have been exposed; and
- any suggested mitigation.

You should receive an acknowledgement within seven days. This is a best-effort policy for a pre-1.0 open source project, not a service-level agreement.

## Supported versions

Backburner is pre-1.0. Security fixes are applied to the latest published version and the current default branch. Older versions are not supported unless a release note explicitly says otherwise.

## Threat model

### Assets to protect

- GitHub authentication available through `gh`
- provider credentials and any other environment variables inherited by local subprocesses
- private repository source, history, issues, comments, and pull requests
- the integrity of branches, commits, comments, labels, and pull requests
- the developer machine and files reachable by provider tools
- local Backburner configuration, state, journal entries, and execution logs

### Trusted components and people

Backburner assumes that you trust:

- the machine and operating-system account running it;
- the selected repositories and their existing build/test tooling;
- the GitHub users listed in `allowedUsers`;
- the installed `git`, `gh`, Node.js, npm, and provider CLIs;
- the configured model providers and the accounts used to reach them; and
- the npm package or source revision you installed.

If any of these are compromised, Backburner is not designed to contain that compromise.

### Untrusted input

Treat all of the following as potentially adversarial:

- issue bodies, comments, PR descriptions, reviews, code, and repository documentation;
- generated model output;
- dependency install scripts, test commands, git hooks, and other repository tooling;
- MCP/tool responses and provider output; and
- network traffic that can reach a broker bound outside loopback.

GitHub content can contain prompt-injection instructions. `allowedUsers` reduces who can feed content into task derivation, but it does not make that content safe and it is not an operating-system sandbox.

### Current security controls

- Repositories must be explicitly configured and enabled.
- GitHub actors are filtered through `allowedUsers` before their issues, PRs, comments, reviews, or label actions drive normal workflow decisions.
- Product approval, plan approval, review, parent-sync, and merge-preparation actions use configurable labels.
- Implementation happens in dedicated git worktrees instead of directly in the primary checkout.
- GitHub operations are routed through the authenticated `gh` CLI and constrained to configured repositories by Backburner's gateway and broker services.
- The orchestrator's broker binds to `127.0.0.1` by default.
- Read-only and workspace-write tasks are distinguished and mapped to provider-specific modes.
- Backburner creates and updates branches and pull requests, but does not silently perform the final merge.
- Configuration and state remain readable local JSON so operators can inspect them.

These are defense-in-depth controls, not a guarantee that an agent cannot make a harmful change.

### Important limitations

#### Coding-agent permissions

Workspace-write tasks are intentionally powerful. Depending on the provider, Backburner may select modes that allow unattended edits and command execution—for example Codex workspace-write, Claude `bypassPermissions`, or Gemini `yolo`. Provider implementations and semantics can change independently of Backburner.

An agent can run repository commands, and those commands can execute arbitrary code available to your user account. Backburner is not a virtual machine or a security sandbox. Use a dedicated machine, operating-system account, container, or VM when you need a stronger boundary.

#### Credentials and environment

Local subprocesses normally inherit the Backburner process environment. Avoid launching Backburner from a shell containing unrelated long-lived secrets. Prefer narrowly scoped GitHub and provider credentials, enable MFA, and periodically review active tokens and sessions.

#### Model-provider data

Local-first does not mean offline. Prompts can include source code and GitHub content, and provider CLIs may send them to third-party services under those providers' terms, retention settings, and account policies. Do not onboard a repository whose data policy forbids that transfer.

#### Local broker

The HTTP broker has no application-level authentication. Its default loopback binding is the expected trust boundary. Do not run `backburner broker --host 0.0.0.0`, publish its port, place it behind a public tunnel, or expose it to an untrusted local network.

Other processes running as your user may be able to reach a loopback service. If your local account is not trusted, use a separate account or stronger isolation.

#### Logs and persisted state

Files under `~/.backburner` can include repository paths, issue and PR content, agent output, errors, and command results. Restrict filesystem access to your user, do not commit this directory, redact logs before sharing them, and remove it securely when retiring the installation.

#### Generated code

Backburner does not guarantee that generated changes are correct or secure. Keep repository branch protection and CI checks enabled, review the diff, and own the final merge decision.

## Safe onboarding checklist

Before the first real run:

1. Start with the private demo repository.
2. Review the repositories and `allowedUsers` in `repos.json`.
3. Review the configured provider commands, models, and roles in `agents.json`.
4. Confirm what data each provider CLI sends remotely and what permission mode it uses.
5. Remove unrelated secrets from the launching shell environment.
6. Confirm the configured code, management, output, and log directories are private to your user.
7. Keep the broker on its default loopback address.
8. Keep branch protection, required CI, and human review on important repositories.
9. Leave final merging to a trusted human.

## Repository and package supply chain

For maintainers:

- require MFA for GitHub and npm maintainer accounts;
- use branch protection or repository rulesets for the default branch once public;
- enable private vulnerability reporting, dependency alerts, secret scanning, and push protection where available;
- review lockfile changes and keep `npm audit` results visible;
- publish releases from a protected GitHub Actions workflow using npm trusted publishing or `npm publish --provenance`;
- tag each published npm version and attach release notes to the same commit;
- keep workflow permissions minimal and pin or deliberately review third-party actions; and
- never publish from a dirty working tree.

npm provenance makes the package's source and build origin verifiable. It does not prove the source is benign or remove the need for review.

## Out of scope

The following are not security vulnerabilities by themselves:

- a model producing incorrect, insecure, or low-quality code without crossing an advertised security boundary;
- provider rate limits, exhausted budgets, or unavailable third-party services;
- actions performed by a GitHub user intentionally listed in `allowedUsers`;
- damage caused by intentionally running a malicious repository's own scripts with agent write permissions; or
- disclosure that is already inherent in sending configured repository context to the chosen model provider.

Reports showing a bypass of repository scoping, actor filtering, task permission gates, broker boundaries, or credential isolation are in scope.
