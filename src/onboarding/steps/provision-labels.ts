import { DEFAULT_BACKBURNER_LABELS } from "../config-writer.js";
import type {
  ConfigDraft,
  OnboardingContext,
  OnboardingStep,
  Prompter,
  RepoDraft,
  StepResult
} from "../types.js";
import type { LabelDefinition, LabelProvisionTarget } from "../services/label-provisioner.js";
import { GitHubLabelProvisioner } from "../services/label-provisioner.js";
import type { CommandRunner } from "../../utils/command-runner.js";

const LABEL_DEFINITIONS: Record<keyof typeof DEFAULT_BACKBURNER_LABELS, Omit<LabelDefinition, "name">> = {
  agentInProgress: {
    description: "Backburner is actively working on this item.",
    color: "6F42C1"
  },
  agentProductApproved: {
    description: "Approve Backburner to start product discovery from this issue.",
    color: "2DA44E"
  },
  agentPlanApproved: {
    description: "Approve Backburner to implement an accepted plan.",
    color: "0969DA"
  },
  agentReview: {
    description: "Ask Backburner to review this pull request.",
    color: "BF8700"
  },
  planBreakdownNeeded: {
    description: "Ask Backburner to break a plan into implementation packets.",
    color: "8250DF"
  },
  agentSyncParentBranch: {
    description: "Allow Backburner to sync the parent branch from the default branch.",
    color: "1F883D"
  },
  prepareForMerge: {
    description: "Ask Backburner to prepare this pull request for merge.",
    color: "CF222E"
  }
};

export class ProvisionLabelsStep implements OnboardingStep {
  readonly name = "provision-labels";
  readonly description = "Creating GitHub labels";

  constructor(private readonly commandRunner: CommandRunner) {}

  async run(ctx: OnboardingContext, _prompter: Prompter): Promise<StepResult> {
    const draft = ctx.configDraft;
    if (draft === undefined || draft.repos.length === 0) {
      return {
        status: "skipped",
        message: "Skipped: no repositories selected for label creation"
      };
    }

    const targets = buildLabelTargets(draft);
    const provisioner = new GitHubLabelProvisioner(this.commandRunner);
    const results = await provisioner.provisionLabels(targets);
    const failures = results.filter((result) => result.status === "failed");

    if (failures.length > 0) {
      ctx.warnings.push(
        "Some GitHub labels could not be created. You can retry onboarding or create them manually from repos.json."
      );
      return {
        status: "warning",
        message: `Created labels with ${failures.length} failure${failures.length === 1 ? "" : "s"}`,
        details: [
          ...failures.map((failure) => {
            const suffix = failure.message !== undefined ? `: ${failure.message}` : "";
            return `${failure.repoSlug}: ${failure.labelName}${suffix}`;
          }),
          ...buildManualLabelDetails(targets)
        ]
      };
    }

    return {
      status: "passed",
      message: `Created or updated ${results.length} GitHub label${results.length === 1 ? "" : "s"}`,
      details: targets.map((target) => `${target.owner}/${target.name}: ${target.labels.length} labels`)
    };
  }
}

function buildManualLabelDetails(targets: LabelProvisionTarget[]): string[] {
  return targets.flatMap((target) => {
    const repoSlug = `${target.owner}/${target.name}`;
    return [
      `Manual labels page for ${repoSlug}: https://github.com/${repoSlug}/labels`,
      `Required labels: ${target.labels.map((label) => label.name).join(", ")}`
    ];
  });
}

function buildLabelTargets(draft: ConfigDraft): LabelProvisionTarget[] {
  return draft.repos.map((repo) => ({
    owner: repo.owner,
    name: repo.name,
    labels: buildRepoLabels(repo)
  }));
}

function buildRepoLabels(repo: RepoDraft): LabelDefinition[] {
  return [
    buildLabel("agentInProgress", repo.labels.agentInProgress),
    buildLabel("agentProductApproved", repo.labels.agentProductApproved),
    buildLabel("agentPlanApproved", repo.labels.agentPlanApproved),
    buildLabel("agentReview", repo.labels.agentReview),
    buildLabel("planBreakdownNeeded", repo.labels.planBreakdownNeeded),
    buildLabel("agentSyncParentBranch", repo.labels.agentSyncParentBranch),
    buildLabel("prepareForMerge", repo.labels.prepareForMerge)
  ];
}

function buildLabel(
  key: keyof typeof DEFAULT_BACKBURNER_LABELS,
  name: string
): LabelDefinition {
  return {
    name,
    ...LABEL_DEFINITIONS[key]
  };
}
