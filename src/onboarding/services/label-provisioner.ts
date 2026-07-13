import type { CommandRunner } from "../../utils/command-runner.js";

export interface LabelDefinition {
  name: string;
  description: string;
  color: string;
}

export interface LabelProvisionTarget {
  owner: string;
  name: string;
  labels: LabelDefinition[];
}

export interface LabelProvisionResult {
  repoSlug: string;
  labelName: string;
  status: "created_or_updated" | "failed";
  message?: string;
}

const LABEL_TIMEOUT_MS = 30_000;

export class GitHubLabelProvisioner {
  constructor(private readonly commandRunner: CommandRunner) {}

  async provisionLabels(targets: LabelProvisionTarget[]): Promise<LabelProvisionResult[]> {
    const results: LabelProvisionResult[] = [];

    for (const target of targets) {
      const repoSlug = `${target.owner}/${target.name}`;
      for (const label of target.labels) {
        try {
          await this.commandRunner.run(
            "gh",
            [
              "label",
              "create",
              label.name,
              "--repo",
              repoSlug,
              "--description",
              label.description,
              "--color",
              label.color,
              "--force"
            ],
            { timeoutMs: LABEL_TIMEOUT_MS }
          );
          results.push({ repoSlug, labelName: label.name, status: "created_or_updated" });
        } catch (err) {
          results.push({
            repoSlug,
            labelName: label.name,
            status: "failed",
            message: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    return results;
  }
}
