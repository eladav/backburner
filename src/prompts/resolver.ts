import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { TaskRecord, TaskKind } from "../tasks/types.js";
import type { PromptsConfigFile, AgentProvider } from "../config/types.js";
import type { Logger } from "../utils/logger.js";
import type { AgentStrategyRole } from "../agents/types.js";
import { resolveScopePath } from "../retrospectives/scopes.js";
import type { LearningScope } from "../retrospectives/scopes.js";

export type PromptKey =
  | "plan"
  | "implement"
  | "review"
  | "discuss"
  | "product"
  | "breakdown"
  | "waveAssessment"
  | "waveReplanning"
  | "retrospectiveExtract"
  | "retrospectiveInvestigate"
  | "retrospectiveProposal";

export interface ResolvedPromptContent {
  source: "built-in" | "config-file";
  filePath?: string;
  content?: string;
  learningOverlays?: string[];
}

export interface OverlayLoadContext {
  repoId: string | undefined;
  provider: AgentProvider | undefined;
  role: AgentStrategyRole | undefined;
  taskKind: TaskKind;
}

export function mapTaskKindToPromptKey(
  taskKind: TaskRecord["kind"]
): PromptKey | undefined {
  switch (taskKind) {
    case "product_discovery":   return "product";
    case "write_product_spec":  return "product";
    case "write_plan":          return "plan";
    case "implement_plan":      return "implement";
    case "review_pr":           return "review";
    case "respond_issue_comment": return "discuss";
    case "plan_breakdown":      return "breakdown";
    case "wave_plan_assessment": return "waveAssessment";
    case "wave_plan_replanning": return "waveReplanning";
    case "extract_retrospective_problems": return "retrospectiveExtract";
    case "investigate_learning_opportunity": return "retrospectiveInvestigate";
    case "draft_management_learning_proposal": return "retrospectiveProposal";
    default:                    return undefined;
  }
}

export function mapTaskToPromptKey(task: TaskRecord): PromptKey | undefined {
  if (
    task.kind === "respond_issue_comment" &&
    (task.workflowPhase === "product_discovery" || task.workflowPhase === "product_specification")
  ) {
    return "product";
  }

  return mapTaskKindToPromptKey(task.kind);
}

export async function resolveTaskPromptContent(
  taskOrKind: TaskRecord | TaskRecord["kind"],
  promptsConfig: PromptsConfigFile | undefined,
  managementRoot: string,
  logger?: Logger
): Promise<ResolvedPromptContent> {
  const taskKind = typeof taskOrKind === "string" ? taskOrKind : taskOrKind.kind;
  const key = typeof taskOrKind === "string"
    ? mapTaskKindToPromptKey(taskOrKind)
    : mapTaskToPromptKey(taskOrKind);

  if (!key || !promptsConfig) {
    logger?.info(`[prompt-resolver] Using built-in constraints for ${taskKind}`);
    return { source: "built-in" };
  }

  const relativeFilePath = promptsConfig.promptProfiles.default[key];

  if (!relativeFilePath) {
    logger?.info(`[prompt-resolver] No config entry for "${key}" (${taskKind}); using built-in`);
    return { source: "built-in" };
  }

  const absoluteFilePath = path.join(managementRoot, relativeFilePath);

  try {
    const content = await readFile(absoluteFilePath, "utf8");
    logger?.info(
      `[prompt-resolver] Using config-file for "${key}" (${taskKind}): ${relativeFilePath}`
    );
    return { source: "config-file", filePath: absoluteFilePath, content };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger?.warn(
        `[prompt-resolver] Prompt file not found for "${key}" (${taskKind}): ${absoluteFilePath}; falling back to built-in`
      );
      return { source: "built-in" };
    }
    throw err;
  }
}

export async function loadLearningOverlays(
  ctx: OverlayLoadContext,
  managementRoot: string,
  logger?: Logger
): Promise<string[]> {
  // Build scopes in broad-to-narrow order:
  // global → provider → role → task_kind → repo → repo+provider → repo+role → repo+task_kind
  const scopes: LearningScope[] = [];

  scopes.push({ kind: "global" });
  if (ctx.provider !== undefined) {
    scopes.push({ kind: "provider", provider: ctx.provider });
  }
  if (ctx.role !== undefined) {
    scopes.push({ kind: "role", role: ctx.role });
  }
  scopes.push({ kind: "task_kind", taskKind: ctx.taskKind });
  if (ctx.repoId !== undefined) {
    scopes.push({ kind: "repo", repoId: ctx.repoId });
    if (ctx.provider !== undefined) {
      scopes.push({ kind: "repo_provider", repoId: ctx.repoId, provider: ctx.provider });
    }
    if (ctx.role !== undefined) {
      scopes.push({ kind: "repo_role", repoId: ctx.repoId, role: ctx.role });
    }
    scopes.push({ kind: "repo_task_kind", repoId: ctx.repoId, taskKind: ctx.taskKind });
  }

  const overlays: string[] = [];
  for (const scope of scopes) {
    let filePath: string;
    try {
      filePath = resolveScopePath(scope, managementRoot);
    } catch {
      // Should never happen for internally-constructed scopes, but log and skip defensively
      logger?.warn(`[learning-overlays] Failed to resolve path for scope ${JSON.stringify(scope)}`);
      continue;
    }

    try {
      const content = await readFile(filePath, "utf8");
      if (content.trim().length > 0) {
        overlays.push(content.trimEnd());
        logger?.info(`[learning-overlays] Loaded overlay: ${filePath}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Missing file is expected for most scopes; silently skip
      } else {
        throw err;
      }
    }
  }

  return overlays;
}
