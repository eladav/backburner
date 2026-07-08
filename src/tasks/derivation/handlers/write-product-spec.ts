import type { NormalizedIssue } from "../../../domain/entities.js";
import type { WorktreeRecord } from "../../../state/types.js";
import type { TaskRecord } from "../../types.js";
import { buildTaskRecord } from "../builders.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler
} from "../types.js";

export const writeProductSpecHandler: TaskDerivationHandler = {
  name: "write_product_spec",
  derive(context, env) {
    const task = deriveWriteProductSpecTask(context, env);
    return task ? [task] : [];
  }
};

function deriveWriteProductSpecTask(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord | undefined {
  const { workstream, issue, activeWorktree } = context;
  if (!issue || workstream.origin.type !== "issue") {
    return undefined;
  }

  if (workstream.phase !== "product_specification") {
    return undefined;
  }

  if (!activeWorktree || activeWorktree.status !== "product_specification") {
    return undefined;
  }

  if (activeWorktree.productSpecWrittenAt) {
    return undefined;
  }

  return createWorktreeProductSpecTask(issue, activeWorktree, {
    contextBuilder: env.input.contextBuilder,
    now: env.input.now
  }, workstream.id);
}

function createWorktreeProductSpecTask(
  issue: NormalizedIssue,
  worktree: WorktreeRecord,
  input: {
    contextBuilder: TaskDerivationEnvironment["input"]["contextBuilder"];
    now: string;
  },
  workstreamId: string
): TaskRecord {
  const productSpecDocumentPath = worktree.productSpecDocumentPath;
  return buildTaskRecord(
    `task:write_product_spec:worktree:${worktree.id}`,
    "write_product_spec",
    issue,
    undefined,
    {
      reason: "Issue has Product approval; Product Manager must write the Product Spec before engineering planning.",
      summary: `Write Product Spec for issue #${issue.number}: ${issue.title}`,
      contextBuilder: input.contextBuilder,
      now: input.now
    },
    input.contextBuilder.build({
      taskKind: "write_product_spec",
      repoIdentifier: issue.repoSlug,
      sourceKind: "issue",
      sourceUrl: issue.url,
      labels: issue.labels,
      localRepoPath: worktree.path,
      branchName: worktree.branchName,
      planDocumentPath: worktree.planDocumentPath,
      ...(productSpecDocumentPath ? { productSpecDocumentPath } : {}),
      logDocumentPath: worktree.logDocumentPath,
      issueTitle: issue.title,
      issueBody: issue.body
    }),
    workstreamId
  );
}
