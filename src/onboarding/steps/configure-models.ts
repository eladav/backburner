import type {
  AgentDraft,
  AgentRole,
  ConfigDraft,
  ModelClass,
  OnboardingContext,
  OnboardingStep,
  Prompter,
  ProviderName,
  StepResult
} from "../types.js";

const STRONG_ROLES: AgentRole[] = [
  "product",
  "planning",
  "review",
  "discussion",
  "implementation_manager",
  "retrospective"
];

const CHEAP_ROLES: AgentRole[] = ["implementation", "discussion"];

/** Suggested default model names per provider. */
const DEFAULT_MODELS: Record<ProviderName, { strong?: string; cheap?: string }> = {
  claude: { strong: "claude-sonnet-4-6" },
  codex: { strong: "o3" },
  gemini: { strong: "gemini-3.1-pro-preview", cheap: "gemini-3-flash-preview" },
  opencode: { strong: "anthropic/claude-sonnet-4-6", cheap: "google/gemini-2.0-flash" },
  antigravity: { strong: "Gemini 3.1 Pro (High)", cheap: "Gemini 3.5 Flash (Low)" }
};

/** Preference order when choosing defaults for the user. */
const STRONG_PREFERENCE: ProviderName[] = ["antigravity", "gemini", "claude", "codex", "opencode"];
const CHEAP_PREFERENCE: ProviderName[] = ["antigravity", "gemini", "claude", "codex", "opencode"];

export class ConfigureModelsStep implements OnboardingStep {
  readonly name = "configure-models";
  readonly description = "Configure model assignments";

  async run(ctx: OnboardingContext, prompter: Prompter): Promise<StepResult> {
    const available = ctx.discoveredProviders.filter((p) => p.available);

    if (available.length === 0) {
      return {
        status: "skipped",
        message: "Skipped: no providers available to configure"
      };
    }

    const providerOptions = available.map(
      (p) => `${p.name}${p.version !== undefined ? ` (${p.version})` : ""}`
    );
    const providerNames = available.map((p) => p.name);

    const defaultStrongIdx = indexOfFirstMatch(providerNames, STRONG_PREFERENCE);
    const defaultCheapIdx = indexOfFirstMatch(providerNames, CHEAP_PREFERENCE);

    let strongIdx: number;
    let cheapIdx: number;

    if (available.length === 1) {
      strongIdx = 0;
      cheapIdx = 0;
    } else {
      process.stdout.write(
        "\nStrong role tasks: product, planning, review, discussion, implementation_manager, retrospective\n"
      );
      strongIdx = await prompter.choose(
        "Provider for strong tasks:",
        providerOptions,
        defaultStrongIdx
      );

      process.stdout.write("\nCheap role tasks: implementation, discussion\n");
      cheapIdx = await prompter.choose(
        "Provider for cheap tasks:",
        providerOptions,
        defaultCheapIdx
      );
    }

    const strongProvider = available[strongIdx];
    const cheapProvider = available[cheapIdx];

    if (strongProvider === undefined || cheapProvider === undefined) {
      return { status: "failed", message: "Provider selection out of range" };
    }

    const strongDefaults = DEFAULT_MODELS[strongProvider.name];
    const cheapDefaults = DEFAULT_MODELS[cheapProvider.name];

    const strongModel = await prompter.ask(
      `Model for ${strongProvider.name} (strong):`,
      strongDefaults.strong
    );

    const cheapModel = await prompter.ask(
      `Model for ${cheapProvider.name} (cheap):`,
      cheapDefaults.cheap ?? cheapDefaults.strong
    );

    const agents: AgentDraft[] = [
      buildAgent(
        `${strongProvider.name}-strong`,
        strongProvider.name,
        strongProvider.command,
        "strong",
        STRONG_ROLES,
        strongModel || strongDefaults.strong
      ),
      buildAgent(
        `${cheapProvider.name}-cheap`,
        cheapProvider.name,
        cheapProvider.command,
        "cheap",
        CHEAP_ROLES,
        cheapModel || (cheapDefaults.cheap ?? cheapDefaults.strong)
      )
    ];

    if (ctx.configDraft === undefined) {
      ctx.configDraft = buildEmptyDraft(ctx);
    }
    ctx.configDraft.agents = agents;

    return {
      status: "passed",
      message: `Configured ${agents.length} agents`,
      details: agents.map((a) => {
        const modelNote = a.model !== undefined ? ` (${a.model})` : "";
        return `${a.id}: ${a.provider}${modelNote} [${a.modelClass}] → ${a.roles.join(", ")}`;
      })
    };
  }
}

function indexOfFirstMatch(names: ProviderName[], preference: ProviderName[]): number {
  for (const pref of preference) {
    const idx = names.indexOf(pref);
    if (idx >= 0) return idx;
  }
  return 0;
}

function buildAgent(
  id: string,
  provider: ProviderName,
  command: string,
  modelClass: ModelClass,
  roles: AgentRole[],
  model: string | undefined
): AgentDraft {
  return {
    id,
    provider,
    command,
    modelClass,
    roles,
    enabled: true,
    ...(model !== undefined && model.length > 0 ? { model } : {})
  };
}

function buildEmptyDraft(ctx: OnboardingContext): ConfigDraft {
  return {
    codeRoot: ctx.codeRoot,
    managementDir: ctx.managementDir,
    outputsDir: ctx.outputsDir,
    logDir: ctx.logDir,
    workspacesDir: ctx.workspacesDir,
    allowedUsers: ctx.githubUser !== undefined ? [ctx.githubUser] : [],
    repos: [],
    agents: []
  };
}
