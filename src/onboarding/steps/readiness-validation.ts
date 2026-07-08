import type { CommandRunner } from "../../utils/command-runner.js";
import type {
  OnboardingContext,
  OnboardingStep,
  Prompter,
  StepResult,
  ValidationIssue
} from "../types.js";
import { ToolChecker, type PlatformHelper } from "../validators/tool-checker.js";
import { GitHubAuthChecker } from "../validators/github-auth.js";
import { GitAccessChecker } from "../validators/git-access.js";
import { WorkspaceChecker } from "../validators/workspace.js";

export class ReadinessValidationStep implements OnboardingStep {
  readonly name = "readiness-validation";
  readonly description = "Running final readiness check";

  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly platformHelper?: PlatformHelper
  ) {}

  async run(ctx: OnboardingContext, _prompter: Prompter): Promise<StepResult> {
    const issues: ValidationIssue[] = [];
    const details: string[] = [];

    // 1. Tool check
    const toolChecker = new ToolChecker(this.commandRunner, this.platformHelper);
    const toolResults = await toolChecker.checkAll();
    for (const r of toolResults) {
      if (r.available) {
        details.push(`✓ ${r.name}: ${r.version ?? "found"}`);
      } else {
        details.push(`✗ ${r.name}: not found`);
        if (r.issue !== undefined) issues.push(r.issue);
      }
    }

    // 2. GitHub auth check
    const authChecker = new GitHubAuthChecker(this.commandRunner);
    const authResult = await authChecker.check();
    if (authResult.authenticated) {
      details.push(`✓ GitHub: authenticated as ${authResult.username ?? ctx.githubUser ?? "unknown"}`);
    } else {
      details.push("✗ GitHub: not authenticated");
      if (authResult.issue !== undefined) issues.push(authResult.issue);
    }

    // 3. Git access for repos that have a local clone
    const accessChecker = new GitAccessChecker(this.commandRunner);
    const reposWithClone = ctx.selectedRepos.filter((r) => r.localPath !== undefined);
    const skippedCount = ctx.selectedRepos.length - reposWithClone.length;

    for (const repo of reposWithClone) {
      const access = await accessChecker.check(repo.localPath!);

      if (access.canFetch && access.canPush) {
        details.push(`✓ ${repo.owner}/${repo.name}: fetch and push OK`);
      } else {
        if (!access.canFetch) {
          details.push(`✗ ${repo.owner}/${repo.name}: cannot fetch`);
          if (access.fetchIssue !== undefined) issues.push(access.fetchIssue);
        }
        if (!access.canPush) {
          details.push(`⚠ ${repo.owner}/${repo.name}: cannot push (agents will not be able to commit)`);
          if (access.pushIssue !== undefined) issues.push(access.pushIssue);
        }
      }
    }

    if (skippedCount > 0) {
      details.push(`- ${skippedCount} repo${skippedCount === 1 ? "" : "s"} without a local clone — git access check skipped`);
    }

    // 4. Ensure configured directories exist and are writable
    const wsChecker = new WorkspaceChecker(this.platformHelper);
    const directoryPaths = [
      ctx.managementDir,
      ctx.outputsDir,
      ctx.logDir,
      ctx.workspacesDir
    ];

    for (const dirPath of directoryPaths) {
      const check = await wsChecker.check(dirPath);
      if (check.writable) {
        if (!check.exists) {
          try {
            await wsChecker.ensureDir(check.path);
            details.push(`✓ ${check.path}: created`);
          } catch (err) {
            details.push(`✗ ${check.path}: could not be created`);
            issues.push({
              title: `Cannot create directory: ${check.path}`,
              cause: err instanceof Error ? err.message : String(err),
              suggestedFix: "Choose a different directory or fix the permissions",
              canAutoRemediate: false,
              ...(check.issue?.manualSteps !== undefined
                ? { manualSteps: check.issue.manualSteps }
                : {})
            });
          }
        } else {
          details.push(`✓ ${check.path}: exists and writable`);
        }
      } else {
        details.push(`✗ ${check.path}: not writable`);
        if (check.issue !== undefined) issues.push(check.issue);
      }
    }

    // 5. Providers
    const available = ctx.discoveredProviders.filter((p) => p.available);
    if (available.length === 0) {
      details.push("✗ No AI providers available");
      issues.push({
        title: "No AI providers installed",
        cause: "None of agy, gemini, claude, codex, or opencode were found on PATH",
        suggestedFix: "Install at least one AI provider before running agents",
        canAutoRemediate: false,
        manualSteps: [
          "Install antigravity: https://antigravity.google/cli",
          "Install gemini CLI",
          "Install claude: https://claude.ai/code",
          "Install codex: https://openai.com/codex",
          "Install opencode: https://opencode.ai"
        ]
      });
    } else {
      details.push(`✓ AI providers: ${available.map((p) => p.name).join(", ")}`);
    }

    const hasStrongProductAgent = ctx.configDraft?.agents.some(
      (agent) => agent.enabled && agent.modelClass === "strong" && agent.roles.includes("product")
    ) ?? false;
    if (hasStrongProductAgent) {
      details.push("✓ Product role: enabled strong agent configured");
    } else {
      details.push("✗ Product role: no enabled strong agent configured");
      issues.push({
        title: "No Product agent configured",
        cause: "Product Discovery and Product Spec tasks require an enabled strong agent with the product role",
        suggestedFix: "Add product to the roles for an enabled strong agent in agents.json",
        canAutoRemediate: false,
        manualSteps: [
          'Edit management/agents.json and add "product" to a strong enabled agent roles array',
          "Re-run backburner init or the readiness check"
        ]
      });
    }

    if (issues.length === 0) {
      return {
        status: "passed",
        message: "All readiness checks passed",
        details
      };
    }

    const hasFatal = toolResults.some((r) => !r.available) || !authResult.authenticated;

    return {
      status: hasFatal ? "failed" : "warning",
      message: `${issues.length} issue${issues.length === 1 ? "" : "s"} found`,
      details,
      issues
    };
  }
}
