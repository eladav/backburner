import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CommandRunner } from "../../utils/command-runner.js";
import type { DiscoveredRepo } from "../types.js";

export interface DemoRepoCreateOptions {
  owner: string;
  name: string;
  codeRoot: string;
}

export class DemoRepoCreator {
  constructor(private readonly commandRunner: CommandRunner) {}

  async createPrivateDemoRepo(options: DemoRepoCreateOptions): Promise<DiscoveredRepo> {
    await fs.mkdir(options.codeRoot, { recursive: true });

    await this.commandRunner.run(
      "gh",
      [
        "repo",
        "create",
        `${options.owner}/${options.name}`,
        "--private",
        "--clone",
        "--add-readme",
        "--description",
        "Private Backburner onboarding demo repository"
      ],
      { cwd: options.codeRoot, timeoutMs: 60_000 }
    );

    return {
      owner: options.owner,
      name: options.name,
      localPath: path.join(options.codeRoot, options.name),
      defaultBranch: "main",
      isLocalClone: true,
      canFetch: true,
      canPush: true
    };
  }
}

export function defaultDemoRepoName(): string {
  return "backburner-demo";
}
