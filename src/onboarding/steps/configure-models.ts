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

/** Provider-specific fallbacks used when the CLI cannot list Backburner model names. */
const DEFAULT_MODELS: Record<ProviderName, { strong?: string; cheap?: string }> = {
  claude: { strong: "claude-sonnet-4-6" },
  codex: { strong: "sol", cheap: "luna" },
  gemini: { strong: "gemini-3.1-pro-preview", cheap: "gemini-3-flash-preview" },
  opencode: { strong: "anthropic/claude-sonnet-4-6", cheap: "google/gemini-2.0-flash" },
  antigravity: { strong: "Gemini 3.1 Pro (High)", cheap: "Gemini 3.5 Flash (Low)" }
};

const BACKBURNER_MODEL_DEFAULTS: Record<ModelClass | "balanced", string> = {
  strong: "sol",
  balanced: "terra",
  cheap: "luna"
};

const DEFAULT_TIMEOUT_MS: Record<ProviderName, number> = {
  codex: 20 * 60 * 1000,
  gemini: 15 * 60 * 1000,
  claude: 20 * 60 * 1000,
  opencode: 15 * 60 * 1000,
  antigravity: 20 * 60 * 1000
};

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

    const providerOptions = available.map((p) => {
      const modelNote =
        p.models !== undefined && p.models.length > 0
          ? `, ${p.models.length} model${p.models.length === 1 ? "" : "s"}`
          : "";
      return `${p.name}${p.version !== undefined ? ` (${p.version}${modelNote})` : modelNote}`;
    });

    process.stdout.write(
      "\nSelect providers to enable. Backburner will configure strong and cheap agents for each selected provider.\n"
    );
    process.stdout.write(
      "Strong role tasks: product, planning, review, discussion, implementation_manager, retrospective\n"
    );
    process.stdout.write("Cheap role tasks: implementation, discussion\n");

    const selectedProviderIndices = await prompter.multiSelect(
      "Providers to enable:",
      providerOptions,
      available.map((_, index) => index)
    );
    const selectedProviders = selectedProviderIndices
      .map((index) => available[index])
      .filter((provider) => provider !== undefined);

    if (selectedProviders.length === 0) {
      return { status: "failed", message: "No providers selected for agent configuration" };
    }

    const agents: AgentDraft[] = [];
    for (const provider of selectedProviders) {
      const strongDefault = selectDefaultModel(provider, "strong");
      const cheapDefault = selectDefaultModel(provider, "cheap");
      showAvailableModels(provider, strongDefault, cheapDefault);
      const strongModel = await prompter.ask(
        `Model for ${provider.name} (strong):`,
        strongDefault
      );
      const cheapModel = await prompter.ask(
        `Model for ${provider.name} (cheap):`,
        cheapDefault
      );

      agents.push(
        buildAgent(
          `${provider.name}-strong`,
          provider.name,
          provider.command,
          "strong",
          STRONG_ROLES,
          strongModel || strongDefault
        ),
        buildAgent(
          `${provider.name}-cheap`,
          provider.name,
          provider.command,
          "cheap",
          CHEAP_ROLES,
          cheapModel || cheapDefault
        )
      );
    }

    if (ctx.configDraft === undefined) {
      ctx.configDraft = buildEmptyDraft(ctx);
    }
    ctx.configDraft.agents = agents;

    return {
      status: "passed",
      message: `Configured ${agents.length} agents`,
      details: agents.map((a) => {
        const modelNote = a.model !== undefined ? ` (${a.model})` : "";
        return `${a.id}: ${a.provider}${modelNote} [${a.modelClass}] -> ${a.roles.join(", ")}`;
      })
    };
  }
}

function showAvailableModels(
  provider: { name: ProviderName; models?: string[] },
  strongDefault: string | undefined,
  cheapDefault: string | undefined
): void {
  const models = provider.models ?? [];
  if (models.length === 0) {
    process.stdout.write(`\n${provider.name} did not expose a model list. Press enter to use the defaults.\n`);
    return;
  }

  const shownModels = rankModelOptions(models, [strongDefault, cheapDefault]);
  process.stdout.write(`\nAvailable ${provider.name} models`);
  if (shownModels.length < models.length) {
    process.stdout.write(` (showing ${shownModels.length} of ${models.length})`);
  }
  process.stdout.write(":\n");

  for (const model of shownModels) {
    const labels = [
      model === strongDefault ? "strong default" : undefined,
      model === cheapDefault ? "cheap default" : undefined
    ].filter((label): label is string => label !== undefined);
    const suffix = labels.length > 0 ? ` (${labels.join(", ")})` : "";
    process.stdout.write(`  - ${model}${suffix}\n`);
  }

  process.stdout.write("Press enter at each prompt to accept the default, or type any model name.\n");
}

function rankModelOptions(models: string[], defaults: Array<string | undefined>): string[] {
  const ranked: string[] = [];
  const add = (model: string | undefined): void => {
    if (model !== undefined && model.length > 0 && !ranked.includes(model)) {
      ranked.push(model);
    }
  };

  for (const defaultModel of defaults) {
    add(defaultModel);
  }

  for (const target of ["sol", "terra", "luna"]) {
    add(findDiscoveredModel(models, [target]));
  }

  for (const model of models) {
    add(model);
    if (ranked.length >= 12) {
      break;
    }
  }

  return ranked;
}

function selectDefaultModel(
  provider: { name: ProviderName; models?: string[] },
  modelClass: ModelClass
): string | undefined {
  const configuredDefaults = DEFAULT_MODELS[provider.name];
  const backburnerDefault = BACKBURNER_MODEL_DEFAULTS[modelClass];
  const providerDefault = configuredDefaults[modelClass] ?? configuredDefaults.strong;
  const discoveredBackburnerDefault = findDiscoveredModel(provider.models ?? [], [
    backburnerDefault
  ]);
  const discoveredProviderDefault =
    providerDefault !== undefined
      ? findDiscoveredModel(provider.models ?? [], [providerDefault])
      : undefined;

  return discoveredBackburnerDefault ?? discoveredProviderDefault ?? providerDefault ?? backburnerDefault;
}

function findDiscoveredModel(models: string[], candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const match = models.find((model) => model.toLowerCase() === candidate.toLowerCase());
    if (match !== undefined) {
      return match;
    }
  }

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase();
    const match = models.find((model) => model.toLowerCase().includes(normalizedCandidate));
    if (match !== undefined) {
      return match;
    }
  }

  return undefined;
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
    timeoutMs: DEFAULT_TIMEOUT_MS[provider],
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
