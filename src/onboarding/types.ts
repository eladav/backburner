export type StepStatus = "passed" | "warning" | "failed" | "skipped" | "requiresUserAction";

export interface ValidationIssue {
  title: string;
  cause: string;
  suggestedFix: string;
  canAutoRemediate: boolean;
  manualSteps?: string[];
}

export interface StepResult {
  status: StepStatus;
  message: string;
  details?: string[];
  issues?: ValidationIssue[];
}

export type ProviderName = "codex" | "gemini" | "claude" | "opencode" | "antigravity";
export type ModelClass = "strong" | "cheap";

/** Maps directly to AgentStrategyRole in src/agents/types.ts */
export type AgentRole =
  | "product"
  | "discussion"
  | "review"
  | "planning"
  | "implementation"
  | "implementation_manager"
  | "retrospective";

export interface DiscoveredRepo {
  owner: string;
  name: string;
  /** Absolute path to the local clone, if one exists. */
  localPath?: string;
  defaultBranch?: string;
  isLocalClone: boolean;
  canFetch?: boolean;
  canPush?: boolean;
}

export interface DiscoveredProvider {
  name: ProviderName;
  command: string;
  available: boolean;
  version?: string;
}

/** Draft for a single agent entry in agents.json */
export interface AgentDraft {
  id: string;
  provider: ProviderName;
  command: string;
  /** Optional for most providers; required for opencode. */
  model?: string;
  modelClass: ModelClass;
  roles: AgentRole[];
  enabled: boolean;
}

/** Draft for a single repo entry in repos.json */
export interface RepoDraft {
  owner: string;
  name: string;
  /** Relative path from codeRoot — stored in repos.json as localPath. */
  localPath: string;
  defaultBranch: string;
  enabled: boolean;
}

/** Complete configuration draft built up during the onboarding flow. */
export interface ConfigDraft {
  codeRoot: string;
  managementDir: string;
  outputsDir: string;
  logDir: string;
  workspacesDir: string;
  allowedUsers: string[];
  repos: RepoDraft[];
  agents: AgentDraft[];
}

/**
 * Mutable state carried through every onboarding step.
 * Steps read from and write to this object.
 */
export interface OnboardingContext {
  codeRoot: string;
  managementDir: string;
  outputsDir: string;
  logDir: string;
  workspacesDir: string;
  githubUser?: string;
  discoveredRepos: DiscoveredRepo[];
  selectedRepos: DiscoveredRepo[];
  discoveredProviders: DiscoveredProvider[];
  /** Accumulated during configure-models and generate-config steps. */
  configDraft?: ConfigDraft;
  warnings: string[];
  stepResults: Map<string, StepResult>;
}

/** Single step in the onboarding pipeline. */
export interface OnboardingStep {
  readonly name: string;
  readonly description: string;
  run(ctx: OnboardingContext, prompter: Prompter): Promise<StepResult>;
}

/** Abstraction over user interaction; allows non-interactive / test overrides. */
export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  choose(question: string, options: string[], defaultIndex?: number): Promise<number>;
  multiSelect(question: string, options: string[], preSelected?: number[]): Promise<number[]>;
}

export interface OnboardingResult {
  context: OnboardingContext;
  results: Array<{ stepName: string; result: StepResult }>;
  overallStatus: StepStatus;
}
