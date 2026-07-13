import * as path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { GitGateway, BranchSyncComparison } from "../git/types.js";
import type { GitHubGateway } from "../github/types.js";
import type { StateStore } from "../state/loader.js";
import type {
  ExecutionRecord,
  ParentBranchSyncStatus,
  TaskRecord
} from "../state/types.js";
import type {
  ParentBranchSyncResult,
  ParentBranchSyncService
} from "./parent-branch-sync.js";
import type { Logger } from "../utils/logger.js";

export interface ParentBranchSyncAttempt {
  taskId: string;
  status: ParentBranchSyncStatus;
  attempted: boolean;
  parentBranch: string;
  defaultBranch: string;
  parentPrNumber?: number;
  beforeComparison?: BranchSyncComparison;
  afterComparison?: BranchSyncComparison;
  message: string;
  error?: string;
}

export interface ParentBranchSyncActionCycleResult {
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  attempts: ParentBranchSyncAttempt[];
}

export interface ParentBranchSyncActionOptions {
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  parentBranchSyncService: ParentBranchSyncService;
  gitGateway: GitGateway;
  gitHubGateway: GitHubGateway;
  stateStore: StateStore;
  logDir: string;
  logger?: Logger;
  now?: () => string;
}

export async function executeParentBranchSyncActions(
  options: ParentBranchSyncActionOptions
): Promise<ParentBranchSyncActionCycleResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const tasks = [...options.tasks];
  const executions = [...options.executions];
  const attempts: ParentBranchSyncAttempt[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (
      !task ||
      task.kind !== "sync_parent_branch" ||
      task.status !== "pending" ||
      task.relevant === false
    ) {
      continue;
    }

    const preflight = task.context.preflight;
    if (!preflight) {
      const failedAt = now();
      const execution = await buildActionFailureExecution(
        task,
        failedAt,
        options.logDir,
        "Missing preflight data in task context."
      );
      tasks[i] = {
        ...task,
        status: "failed",
        lastExecutionId: execution.id,
        updatedAt: failedAt
      };
      executions.push(execution);

      await options.stateStore.writeExecutionState(executions);
      await options.stateStore.writeTaskState(tasks);
      continue;
    }

    const localPath = task.context.localRepoPath;
    if (!localPath) {
      const failedAt = now();
      const execution = await buildActionFailureExecution(
        task,
        failedAt,
        options.logDir,
        "Missing local repository path in task context."
      );
      tasks[i] = {
        ...task,
        status: "failed",
        lastExecutionId: execution.id,
        updatedAt: failedAt
      };
      executions.push(execution);

      await options.stateStore.writeExecutionState(executions);
      await options.stateStore.writeTaskState(tasks);

      const { parentPrNumber } = preflight;
      if (parentPrNumber) {
        try {
          const attempt: ParentBranchSyncAttempt = {
            taskId: task.id,
            status: "failed",
            attempted: false,
            parentBranch: preflight.parentIntegrationBranch,
            defaultBranch: preflight.defaultBranch,
            parentPrNumber,
            message: "Missing local repository path in task context."
          };
          const comment = formatParentBranchSyncComment(attempt);
          await options.gitHubGateway.postIssueComment({
            owner: task.repoSlug.split("/")[0] ?? "",
            name: task.repoSlug.split("/")[1] ?? "",
            issueNumber: parentPrNumber,
            body: comment
          });
        } catch (err) {
          options.logger?.warn(
            `Failed to post sync feedback to ${task.repoSlug}#${parentPrNumber}: ${err}`
          );
        }
      }
      continue;
    }

    const { parentIntegrationBranch, defaultBranch, parentPrNumber } = preflight;
    if (parentPrNumber === undefined) {
      const failedAt = now();
      const execution = await buildActionFailureExecution(
        task,
        failedAt,
        options.logDir,
        "Missing parent PR number in preflight data."
      );
      tasks[i] = {
        ...task,
        status: "failed",
        lastExecutionId: execution.id,
        updatedAt: failedAt
      };
      executions.push(execution);

      await options.stateStore.writeExecutionState(executions);
      await options.stateStore.writeTaskState(tasks);
      continue;
    }

    options.logger?.info(
      `Executing orchestrator sync for ${task.repoSlug} branch ${parentIntegrationBranch} (PR #${parentPrNumber})`
    );

    let beforeComparison: BranchSyncComparison | undefined;
    try {
      beforeComparison = await options.gitGateway.compareBranchSyncStatus(
        localPath,
        parentIntegrationBranch,
        defaultBranch
      );
    } catch (err) {
      options.logger?.warn(`Could not obtain before-comparison for sync action: ${err}`);
    }

    const startedAt = now();
    let syncResult: ParentBranchSyncResult;
    try {
      syncResult = await options.parentBranchSyncService.syncParentBranch(
        localPath,
        parentIntegrationBranch,
        defaultBranch
      );
    } catch (err) {
      syncResult = {
        status: "failed",
        message: "Parent branch sync service threw an unexpected error.",
        error: err instanceof Error ? err.message : String(err)
      };
    }

    let afterComparison: BranchSyncComparison | undefined;
    try {
      afterComparison = await options.gitGateway.compareBranchSyncStatus(
        localPath,
        parentIntegrationBranch,
        defaultBranch
      );
    } catch (err) {
      options.logger?.warn(`Could not obtain after-comparison for sync action: ${err}`);
    }

    const endedAt = now();
    const taskStatus =
      syncResult.status === "synced" || syncResult.status === "already_up_to_date"
        ? "completed"
        : "failed";

    const attempt: ParentBranchSyncAttempt = {
      taskId: task.id,
      status: syncResult.status,
      attempted: true,
      parentBranch: parentIntegrationBranch,
      defaultBranch,
      message: syncResult.message,
      ...(parentPrNumber !== undefined ? { parentPrNumber } : {}),
      ...(beforeComparison !== undefined ? { beforeComparison } : {}),
      ...(afterComparison !== undefined ? { afterComparison } : {}),
      ...(syncResult.error !== undefined ? { error: syncResult.error } : {})
    };
    attempts.push(attempt);

    const execution = await buildSyncExecutionRecord({
      task,
      attempt,
      logDir: options.logDir,
      startedAt,
      endedAt
    });

    tasks[i] = {
      ...task,
      status: taskStatus,
      lastExecutionId: execution.id,
      updatedAt: endedAt
    };
    executions.push(execution);

    // Persist incrementally
    await options.stateStore.writeExecutionState(executions);
    await options.stateStore.writeTaskState(tasks);

    // Feedback
    if (parentPrNumber) {
      try {
        const comment = formatParentBranchSyncComment(attempt);
        await options.gitHubGateway.postIssueComment({
          owner: task.repoSlug.split("/")[0] ?? "",
          name: task.repoSlug.split("/")[1] ?? "",
          issueNumber: parentPrNumber,
          body: comment
        });
      } catch (err) {
        options.logger?.warn(
          `Failed to post sync feedback to ${task.repoSlug}#${parentPrNumber}: ${err}`
        );
      }
    }
  }

  return { tasks, executions, attempts };
}

async function buildActionFailureExecution(
  task: TaskRecord,
  timestamp: string,
  logDir: string,
  message: string
): Promise<ExecutionRecord> {
  const executionId = `exec-${task.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}-action-failure-${timestamp.replace(/[:.]/g, "-")}`;
  const artifactRoot = path.join(logDir, "artifacts", executionId);
  await mkdir(artifactRoot, { recursive: true });

  const promptPacketPath = path.join(artifactRoot, "prompt-packet.json");
  const promptArtifactPath = path.join(artifactRoot, "prompt.md");
  const stdoutArtifactPath = path.join(artifactRoot, "stdout.txt");
  const stderrArtifactPath = path.join(artifactRoot, "stderr.txt");
  await Promise.all([
    writeFile(
      promptArtifactPath,
      `Task: ${task.id}\nPhase: parent branch sync action\n\n${message}\n`,
      "utf8"
    ),
    writeFile(stdoutArtifactPath, "", "utf8"),
    writeFile(stderrArtifactPath, `${message}\n`, "utf8")
  ]);
  await writeFile(
    promptPacketPath,
    JSON.stringify(
      {
        taskId: task.id,
        taskKind: task.kind,
        status: "failed",
        error: message
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    id: executionId,
    taskId: task.id,
    taskKind: task.kind,
    taskStatus: "failed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "orchestrator",
    agentProvider: "unassigned",
    command: {
      executable: "orchestrator-action",
      args: [],
      cwd: task.context.localRepoPath ?? process.cwd(),
      timeoutMs: 0
    },
    promptArtifactPath,
    stdoutArtifactPath,
    stderrArtifactPath,
    promptPacketPath,
    startedAt: timestamp,
    endedAt: timestamp,
    exitCode: 1,
    errorMessage: message
  };
}

async function buildSyncExecutionRecord(input: {
  task: TaskRecord;
  attempt: ParentBranchSyncAttempt;
  logDir: string;
  startedAt: string;
  endedAt: string;
}): Promise<ExecutionRecord> {
  const { task, attempt, logDir, startedAt, endedAt } = input;
  const executionId = `exec-${task.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}-sync-action-${startedAt.replace(/[:.]/g, "-")}`;
  const artifactRoot = path.join(logDir, "artifacts", executionId);
  await mkdir(artifactRoot, { recursive: true });

  const promptPacketPath = path.join(artifactRoot, "prompt-packet.json");
  const promptArtifactPath = path.join(artifactRoot, "prompt.md");
  const stdoutArtifactPath = path.join(artifactRoot, "stdout.txt");
  const stderrArtifactPath = path.join(artifactRoot, "stderr.txt");
  const resultPacket = {
    taskId: task.id,
    taskKind: task.kind,
    parentBranchSync: {
      status: attempt.status,
      message: attempt.message,
      parentBranch: attempt.parentBranch,
      defaultBranch: attempt.defaultBranch,
      parentPrNumber: attempt.parentPrNumber,
      beforeComparison: attempt.beforeComparison,
      afterComparison: attempt.afterComparison,
      error: attempt.error
    }
  };

  await Promise.all([
    writeFile(promptPacketPath, JSON.stringify(resultPacket, null, 2), "utf8"),
    writeFile(
      promptArtifactPath,
      `Task: ${task.id}\nPhase: parent branch sync action\n\n${attempt.message}\n`,
      "utf8"
    ),
    writeFile(stdoutArtifactPath, `${attempt.message}\n`, "utf8"),
    writeFile(stderrArtifactPath, attempt.error ? `${attempt.error}\n` : "", "utf8")
  ]);

  return {
    id: executionId,
    taskId: task.id,
    taskKind: task.kind,
    taskStatus:
      attempt.status === "synced" || attempt.status === "already_up_to_date"
        ? "completed"
        : "failed",
    repoId: task.repoId,
    repoSlug: task.repoSlug,
    agentId: "orchestrator",
    agentProvider: "unassigned",
    command: {
      executable: "git-sync-service",
      args: ["merge", attempt.defaultBranch, "into", attempt.parentBranch],
      cwd: task.context.localRepoPath ?? process.cwd(),
      timeoutMs: 0
    },
    promptArtifactPath,
    stdoutArtifactPath,
    stderrArtifactPath,
    promptPacketPath,
    startedAt,
    endedAt,
    exitCode: attempt.status === "synced" || attempt.status === "already_up_to_date" ? 0 : 1,
    ...(attempt.error !== undefined ? { errorMessage: attempt.error } : {}),
    result: {
      parentBranchSync: {
        status: attempt.status,
        message: attempt.message,
        parentBranch: attempt.parentBranch,
        defaultBranch: attempt.defaultBranch,
        ...(attempt.parentPrNumber !== undefined ? { parentPrNumber: attempt.parentPrNumber } : {}),
        ...(attempt.beforeComparison !== undefined ? { beforeComparison: attempt.beforeComparison } : {}),
        ...(attempt.afterComparison !== undefined ? { afterComparison: attempt.afterComparison } : {}),
        ...(attempt.error !== undefined ? { error: attempt.error } : {})
      }
    }
  };
}

export function formatParentBranchSyncComment(attempt: ParentBranchSyncAttempt): string {
  const lines: string[] = ["🤖 **Parent Branch Sync Attempt**", ""];

  const actionText = attempt.attempted
    ? `Attempted to merge the default branch (\`${attempt.defaultBranch}\`) into the parent branch (\`${attempt.parentBranch}\`) through the git sync service, with no rebase or force push.`
    : "Could not attempt merge (precondition failed)";

  lines.push(`- **Action**: ${actionText}`);
  lines.push(`- **Parent Branch**: \`${attempt.parentBranch}\``);
  lines.push(`- **Default Branch**: \`${attempt.defaultBranch}\``);

  if (attempt.beforeComparison) {
    const comp = attempt.beforeComparison;
    lines.push(
      `- **Pre-attempt status**: \`${comp.status}\` (ahead: ${comp.parentAheadCount ?? "?"}, behind: ${comp.parentBehindCount ?? "?"})`
    );
  }

  lines.push(`- **Result**: \`${attempt.status}\``);
  if (attempt.message) {
    lines.push(`  > ${attempt.message}`);
  }
  if (attempt.error) {
    lines.push(`  > **Error**: ${attempt.error}`);
  }

  if (attempt.afterComparison) {
    const comp = attempt.afterComparison;
    lines.push(
      `- **Post-attempt status**: \`${comp.status}\` (ahead: ${comp.parentAheadCount ?? "?"}, behind: ${comp.parentBehindCount ?? "?"})`
    );

    lines.push("");
    if (comp.status === "up_to_date") {
      lines.push(
        "Wave advancement is now eligible. It will be evaluated in the normal orchestration flow."
      );
    } else {
      lines.push(
        "Wave advancement remains blocked because the branch is not yet `up_to_date`."
      );
    }
  } else {
    lines.push("- **Post-attempt status**: `unknown` (comparison failed or unavailable)");
    lines.push("");
    lines.push(
      "Wave advancement remains blocked because the branch status could not be verified after the attempt."
    );
  }

  return lines.join("\n");
}
