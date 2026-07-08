import type { CommandRunner } from "../../utils/command-runner.js";
import type { ValidationIssue } from "../types.js";

export interface GitHubAuthCheckResult {
  authenticated: boolean;
  username?: string;
  /** Present when authentication is missing or an unexpected error occurred. */
  issue?: ValidationIssue;
}

/** Substrings in `gh auth status` error output that indicate the user is simply not logged in. */
const AUTH_ERROR_SIGNALS = [
  "not logged",
  "not authenticated",
  "You are not",
  "no credentials",
  "authentication required"
];

export class GitHubAuthChecker {
  constructor(private readonly commandRunner: CommandRunner) {}

  async check(): Promise<GitHubAuthCheckResult> {
    try {
      const result = await this.commandRunner.run("gh", ["auth", "status"], {
        timeoutMs: 15_000
      });

      const output = result.stdout + result.stderr;
      const username = extractUsername(output);

      return {
        authenticated: true,
        ...(username !== undefined ? { username } : {})
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAuthError = AUTH_ERROR_SIGNALS.some((signal) =>
        message.toLowerCase().includes(signal.toLowerCase())
      );

      if (isAuthError) {
        return {
          authenticated: false,
          issue: {
            title: "Not authenticated with GitHub",
            cause: "The GitHub CLI is not authenticated with a GitHub account",
            suggestedFix: "Run: gh auth login",
            canAutoRemediate: false,
            manualSteps: [
              "In PowerShell, Command Prompt, or a POSIX shell, run: gh auth login",
              "Follow the prompts to authenticate with your GitHub account",
              "Then re-run: backburner init"
            ]
          }
        };
      }

      // Unexpected failure (network error, Enterprise config, CLI crash, etc.).
      // Surface it honestly rather than misreporting it as a login problem.
      return {
        authenticated: false,
        issue: {
          title: "GitHub CLI check failed unexpectedly",
          cause: message,
          suggestedFix:
            "Check that the GitHub CLI is installed and working, then re-run: backburner init",
          canAutoRemediate: false,
          manualSteps: [
            "Run `gh auth status` manually to see the full error",
            "Run `gh --version` to verify the CLI is installed and on PATH"
          ]
        }
      };
    }
  }

  async getAuthenticatedUser(): Promise<string | undefined> {
    try {
      const result = await this.commandRunner.run(
        "gh",
        ["api", "user", "--jq", ".login"],
        { timeoutMs: 10_000 }
      );
      const user = result.stdout.trim();
      return user.length > 0 ? user : undefined;
    } catch {
      return undefined;
    }
  }
}

function extractUsername(output: string): string | undefined {
  const patterns = [
    /Logged in to github\.com account ([^\s]+)/i,
    /account:\s+([^\s]+)/i,
    /as ([^\s]+)\s*\(/i
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) return match[1];
  }

  return undefined;
}
