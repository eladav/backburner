import * as path from "node:path";
import { ExecFileCommandRunner } from "../utils/command-runner.js";
import {
  defaultBackburnerCodeRoot,
  defaultBackburnerManagementRoot,
  defaultBackburnerOutputsRoot,
  defaultWorkspacesRootForCodeRoot
} from "../utils/paths.js";
import { OnboardingEngine } from "../onboarding/engine.js";
import { NodeReadlinePrompter, NonInteractivePrompter } from "../onboarding/prompt.js";
import type { OnboardingContext, OnboardingResult, Prompter } from "../onboarding/types.js";
import { WelcomeStep } from "../onboarding/steps/welcome.js";
import { CheckRequirementsStep } from "../onboarding/steps/check-requirements.js";
import { CheckGitHubAuthStep } from "../onboarding/steps/check-github-auth.js";
import { DiscoverReposStep } from "../onboarding/steps/discover-repos.js";
import { SelectReposStep } from "../onboarding/steps/select-repos.js";
import { ConfigurePathsStep } from "../onboarding/steps/configure-paths.js";
import { DiscoverProvidersStep } from "../onboarding/steps/discover-providers.js";
import { ConfigureModelsStep } from "../onboarding/steps/configure-models.js";
import { GenerateConfigStep } from "../onboarding/steps/generate-config.js";
import { ReadinessValidationStep } from "../onboarding/steps/readiness-validation.js";
import { ShowSummaryStep } from "../onboarding/steps/show-summary.js";

export interface InitOptions {
  codeRoot: string;
  managementDir?: string;
  outputsDir?: string;
  logDir?: string;
  workspacesDir?: string;
  /** When true, accept all defaults without prompting. */
  nonInteractive?: boolean;
}

export async function runInitCli(argv: string[]): Promise<void> {
  const codeRoot = readStringFlag(argv, "--code-root") ?? defaultBackburnerCodeRoot();
  const managementDir = readStringFlag(argv, "--management-dir");
  const outputsDir = readStringFlag(argv, "--outputs-dir");
  const logDir = readStringFlag(argv, "--log-dir");
  const workspacesDir = readStringFlag(argv, "--workspaces-dir");
  const nonInteractive = argv.includes("--yes") || argv.includes("-y");

  const result = await runInit({
    codeRoot,
    ...(managementDir !== undefined ? { managementDir } : {}),
    ...(outputsDir !== undefined ? { outputsDir } : {}),
    ...(logDir !== undefined ? { logDir } : {}),
    ...(workspacesDir !== undefined ? { workspacesDir } : {}),
    nonInteractive
  });

  // Let the summary print first, then signal failure via exit code.
  if (result.overallStatus === "failed" || result.overallStatus === "requiresUserAction") {
    process.exitCode = 1;
  }
}

export async function runInit(options: InitOptions): Promise<OnboardingResult> {
  const commandRunner = new ExecFileCommandRunner();
  const { codeRoot, nonInteractive = false } = options;
  const resolvedCodeRoot = path.resolve(codeRoot);
  const resolvedOutputsDir = path.resolve(options.outputsDir ?? defaultBackburnerOutputsRoot());

  const ctx: OnboardingContext = {
    codeRoot: resolvedCodeRoot,
    managementDir: path.resolve(options.managementDir ?? defaultBackburnerManagementRoot()),
    outputsDir: resolvedOutputsDir,
    logDir: path.resolve(
      options.logDir ?? path.join(resolvedOutputsDir, "logs")
    ),
    workspacesDir: path.resolve(
      options.workspacesDir ?? defaultWorkspacesRootForCodeRoot(resolvedCodeRoot)
    ),
    discoveredRepos: [],
    selectedRepos: [],
    discoveredProviders: [],
    warnings: [],
    stepResults: new Map()
  };

  const steps = [
    new WelcomeStep(),
    new CheckRequirementsStep(commandRunner),
    new CheckGitHubAuthStep(commandRunner),
    new DiscoverReposStep(commandRunner, ctx.codeRoot),
    new SelectReposStep(),
    new ConfigurePathsStep(),
    new DiscoverProvidersStep(commandRunner),
    new ConfigureModelsStep(),
    new GenerateConfigStep(),
    new ReadinessValidationStep(commandRunner),
    new ShowSummaryStep()
  ];

  let prompter: Prompter;
  let interactivePrompter: NodeReadlinePrompter | undefined;

  if (nonInteractive) {
    prompter = new NonInteractivePrompter();
  } else {
    interactivePrompter = new NodeReadlinePrompter();
    prompter = interactivePrompter;
  }

  const engine = new OnboardingEngine(steps, prompter);

  try {
    return await engine.run(ctx);
  } finally {
    interactivePrompter?.close();
  }
}

function readStringFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}
