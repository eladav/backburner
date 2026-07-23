import * as path from "node:path";
import type { BuiltContext } from "../context/types.js";
import { PLAN_BREAKDOWN_EXTRA_INSTRUCTIONS } from "../context/types.js";
import type {
  ParentBranchSyncPreflight,
  PrepareForMergePreflight,
  PullRequestReviewCommentLocationContext,
  TaskRecord
} from "../tasks/types.js";
import type { PromptPacket } from "./types.js";
import { toPrettyJson } from "../utils/json.js";

export function buildPromptPacket(task: TaskRecord, context: BuiltContext): PromptPacket {
  const url = context.commentUrl ?? context.pullRequestUrl ?? context.issueUrl ?? task.sourceUrl;
  const localPaths = context.localRepoPath ? [context.localRepoPath] : [];

  return {
    taskType: task.kind,
    repo: task.repoSlug,
    url,
    executionPermission: task.executionPermission,
    handoffPolicy: task.handoffPolicy,
    ...(context.issueTitle ? { issueTitle: context.issueTitle } : {}),
    ...(context.issueBody ? { issueBody: context.issueBody } : {}),
    ...(context.productSpecDocumentPath ? { productSpecDocumentPath: context.productSpecDocumentPath } : {}),
    ...(context.relevantCommentText ? { relevantComment: context.relevantCommentText } : {}),
    ...(context.pullRequestReviewLocation ? { pullRequestReviewLocation: context.pullRequestReviewLocation } : {}),
    ...(task.kind === "prepare_pr_for_merge" ? { backburnerGitSessionId: task.id } : {}),
    ...(context.preflight ? { preflight: context.preflight } : {}),
    ...(context.prepareForMerge ? { prepareForMerge: context.prepareForMerge } : {}),
    ...(context.waveAssessmentCheckpoint ? { waveAssessmentCheckpoint: context.waveAssessmentCheckpoint } : {}),
    ...(context.finalizedWaveAssessment ? { finalizedWaveAssessment: context.finalizedWaveAssessment } : {}),
    ...(context.retrospectiveCandidate ? { retrospectiveCandidate: context.retrospectiveCandidate } : {}),
    ...(context.retrospectiveProblem ? { retrospectiveProblem: context.retrospectiveProblem } : {}),
    ...(context.learningOpportunity ? { learningOpportunity: context.learningOpportunity } : {}),
    ...(context.capabilities ? { capabilities: context.capabilities } : {}),
    ...(context.nativeResumeRetry ? { nativeResumeRetry: context.nativeResumeRetry } : {}),
    action: context.instruction,
    localPaths,
    reminder: 'Any GitHub-authored message you post must begin with "🤖".'
  };
}

export function renderPrompt(
  task: TaskRecord,
  packet: PromptPacket,
  options: {
    providerIdentity?: string;
    customConstraints?: string | undefined;
    learningOverlays?: string[] | undefined;
  } = {}
): string {
  const providerIdentity = options.providerIdentity ?? "Codex CLI";
  const localRepoPath = packet.localPaths[0];
  const targetPath = localRepoPath ?? ".";
  const relevantUrl = packet.url;
  const localPathLine =
    localRepoPath === undefined
      ? "- local paths: []"
      : `- local paths:\n  - ${normalizeForPrompt(localRepoPath)}`;

  const overlayLines: string[] =
    options.learningOverlays && options.learningOverlays.length > 0
      ? [
          "",
          "Approved learning overlays (apply as additional guidance, from broadest to narrowest scope):",
          ...options.learningOverlays.flatMap((overlay, i) => [
            "",
            `--- Learning overlay ${i + 1} ---`,
            overlay
          ])
        ]
      : [];

  return [
    `You are ${providerIdentity} running inside the Backburner local GitHub-driven orchestrator.`,
    "Work only from the prompt packet below. Keep actions aligned with the task and current repository state.",
    "",
    "Execution rules:",
    `- task type: ${task.kind}`,
    `- local execution permission: ${task.executionPermission}`,
    `- expects pushable handoff: ${task.handoffPolicy.expectsPushableHandoff ? "yes" : "no"}`,
    `- remote push owner: ${task.handoffPolicy.remotePublishOwner}`,
    `- repo: ${task.repoSlug}`,
    ...(task.workstreamId ? [`- workstream id: ${task.workstreamId}`] : []),
    ...(packet.backburnerGitSessionId ? [`- Backburner Git session ID: ${packet.backburnerGitSessionId}`] : []),
    `- target url: ${relevantUrl}`,
    localPathLine,
    `- action: ${packet.action}`,
    `- reminder: ${packet.reminder}`,
    ...(packet.issueTitle ? [`- parent issue title: ${packet.issueTitle}`] : []),
    ...(packet.issueBody ? [`- parent issue body: ${packet.issueBody}`] : []),
    ...(packet.productSpecDocumentPath ? [`- product spec document: ${packet.productSpecDocumentPath}`] : []),
    ...(packet.relevantComment ? [`- relevant comment: ${packet.relevantComment}`] : []),
    ...(packet.pullRequestReviewLocation ? renderReviewCommentLocation(packet.pullRequestReviewLocation) : []),
    ...(packet.preflight ? renderPreflight(packet.preflight) : []),
    ...(packet.prepareForMerge ? renderPrepareForMerge(packet.prepareForMerge) : []),
    ...(packet.waveAssessmentCheckpoint ? renderWaveAssessmentCheckpoint(packet.waveAssessmentCheckpoint) : []),
    ...(packet.finalizedWaveAssessment ? renderFinalizedWaveAssessment(packet.finalizedWaveAssessment) : []),
    ...(packet.retrospectiveCandidate ? [`- retrospective candidate: ${packet.retrospectiveCandidate.id}`] : []),
    ...(packet.retrospectiveProblem ? [`- retrospective problem: ${packet.retrospectiveProblem.id}`] : []),
    ...(packet.learningOpportunity ? [`- learning opportunity: ${packet.learningOpportunity.id}`] : []),
    ...(packet.capabilities ? renderCapabilities(packet.capabilities) : []),
    ...(packet.nativeResumeRetry?.previousExecutionFailed
      ? [
          "",
          "Native resume retry context:",
          "- This provider session is resuming after the prior execution failed.",
          "- Backburner may have preserved, recovered, or reset the workspace after that failure.",
          "- Claims in the resumed conversation about prior edits or checkout state may therefore be stale.",
          "- Before continuing, re-read `git status`, the current files, and the current diff. Trust the current checkout over the prior conversation."
        ]
      : []),
    "",
    "Constraints:",
    `- Run inside the repository at ${normalizeForPrompt(targetPath)} when a local path is provided.`,
    "- Stay inside the assigned worktree or repository path; do not operate outside it.",
    "- Rebuild your understanding from the local checkout and the packet; do not assume hidden orchestration state.",
    "- Do not claim files changed unless you actually changed them.",
    "- Use sensors for read/context needs and controllers for write/action needs.",
    "- Do not use a blocked capability.",
    "- Orchestrator-owned publication stays separate unless the task packet explicitly delegates that publication to an agent-visible controller.",
    ...(options.customConstraints !== undefined
      ? splitLines(options.customConstraints)
      : buildTaskSpecificConstraints(task)),
    ...buildMcpSkipConstraints(task),
    "",
    "Prompt packet JSON:",
    "```json",
    toPrettyJson(packet).trimEnd(),
    "```",
    ...overlayLines
  ].join("\n");
}

function renderPreflight(preflight: ParentBranchSyncPreflight): string[] {
  return [
    `Preflight details:`,
    `- Current packet wave: ${preflight.currentWaveIndex}`,
    `- Next packet wave: ${preflight.nextWaveIndex}`,
    `- Parent integration branch: ${preflight.parentIntegrationBranch}`,
    `- Default branch: ${preflight.defaultBranch}`,
    `- Completed packet IDs: ${preflight.completedPacketIds.join(", ")}`,
    `- Pending future packet IDs: ${preflight.pendingFuturePacketIds.join(", ")}`,
    ...(preflight.parentPrNumber !== undefined ? [`- Parent PR: #${preflight.parentPrNumber}`] : [])
  ];
}

function renderPrepareForMerge(preflight: PrepareForMergePreflight): string[] {
  return [
    `Prepare for merge details:`,
    `- PR: #${preflight.prNumber}`,
    `- Title: ${preflight.prTitle}`,
    `- Head branch: ${preflight.headBranch}`,
    `- Head SHA: ${preflight.headSha}`,
    `- Base branch: ${preflight.baseBranch}`
  ];
}

function renderWaveAssessmentCheckpoint(checkpoint: NonNullable<PromptPacket["waveAssessmentCheckpoint"]>): string[] {
  return [
    "Wave assessment checkpoint:",
    `- Checkpoint ID: ${checkpoint.id}`,
    `- Workstream ID: ${checkpoint.identity.workstreamId}`,
    `- Wave ID: ${checkpoint.identity.waveId}`,
    `- Parent PR: #${checkpoint.identity.parentPrNumber}`,
    `- Parent head SHA: ${checkpoint.identity.parentHeadSha}`,
    `- Plan revision: ${checkpoint.identity.planRevision}`,
    `- Original planning session ID: ${checkpoint.identity.originalPlanningSessionId}`,
    `- Current wave: ${checkpoint.identity.currentWaveIndex}`,
    `- Next wave: ${checkpoint.identity.nextWaveIndex}`,
    `- Parent integration branch: ${checkpoint.identity.parentIntegrationBranch}`,
    `- Default branch: ${checkpoint.identity.defaultBranch}`,
    `- Completed packet IDs: ${checkpoint.identity.completedPacketIds.join(", ")}`,
    `- Pending future packet IDs: ${checkpoint.identity.pendingFuturePacketIds.join(", ")}`,
    `- Plan node IDs: ${checkpoint.identity.planNodeIds.join(", ")}`
  ];
}

function renderFinalizedWaveAssessment(assessment: NonNullable<PromptPacket["finalizedWaveAssessment"]>): string[] {
  return [
    "Finalized wave assessment:",
    `- Assessment ID: ${assessment.id}`,
    `- Decision: ${assessment.decision}`,
    `- Summary: ${assessment.summary}`,
    ...(assessment.postedCommentId ? [`- Posted comment ID: ${assessment.postedCommentId}`] : [])
  ];
}

function renderReviewCommentLocation(location: PullRequestReviewCommentLocationContext): string[] {
  const lines: string[] = ["PR review comment location:"];
  if (location.path) lines.push(`- Path: ${location.path}`);
  if (location.line !== undefined && location.line !== null) lines.push(`- Line: ${location.line}`);
  if (location.side) lines.push(`- Side: ${location.side}`);

  const hasStartLine = location.startLine !== undefined && location.startLine !== null;
  const hasLine = location.line !== undefined && location.line !== null;

  if (hasStartLine || hasLine) {
    const start = hasStartLine ? location.startLine : location.line;
    const end = hasLine ? location.line : start;
    const range = `${start}${start !== end ? `-${end}` : ""}`;
    lines.push(`- Range: ${location.startSide ? `${range}, ${location.startSide}` : range}`);
  }

  if (location.commitId) lines.push(`- Commit: ${location.commitId}`);
  if (location.originalCommitId) lines.push(`- Original commit: ${location.originalCommitId}`);
  if (location.inReplyToId) lines.push(`- In reply to: ${location.inReplyToId}`);
  if (location.diffHunk) lines.push(`\nDiff hunk:\n\`\`\`diff\n${location.diffHunk}\n\`\`\``);

  return lines;
}

function renderCapabilities(capabilities: NonNullable<PromptPacket["capabilities"]>): string[] {
  const lines: string[] = [
    "",
    "Capability projection:",
    "- Sensors describe what the agent may observe.",
    "- Controllers describe what the agent may do.",
    "- Do not use blocked capabilities, and do not replace a missing controller with raw CLI work unless the task explicitly permits local repository work.",
    "",
    "Available sensors:"
  ];

  if (capabilities.sensors.length === 0) {
    lines.push("- none configured");
  } else {
    for (const sensor of capabilities.sensors) {
      const metadata: string[] = [`uses ${sensor.uses}`, `observes ${sensor.observes}`];
      if (sensor.scope) metadata.push(`scope ${sensor.scope}`);
      if (sensor.cadence) metadata.push(`cadence ${sensor.cadence}`);
      if (sensor.tools.length > 0) metadata.push(`tools ${sensor.tools.join(", ")}`);
      lines.push(`- ${sensor.name}: ${metadata.join("; ")}`);
    }
  }

  lines.push("", "Available controllers:");
  if (capabilities.controllers.length === 0) {
    lines.push("- none configured");
  } else {
    for (const controller of capabilities.controllers) {
      const metadata: string[] = [
        `uses ${controller.uses}`,
        `grants ${controller.grants.join(", ")}`,
        `approval ${controller.approval}`
      ];
      if (controller.tools.length > 0) metadata.push(`tools ${controller.tools.join(", ")}`);
      lines.push(`- ${controller.name}: ${metadata.join("; ")}`);
    }
  }

  lines.push("", "Blocked capabilities:");
  if (capabilities.blocked.length === 0) {
    lines.push("- none configured");
  } else {
    for (const blocked of capabilities.blocked) {
      const metadata: string[] = [`uses ${blocked.uses}`, `reason ${blocked.reason}`];
      if (blocked.message) metadata.push(blocked.message);
      lines.push(`- ${blocked.kind} ${blocked.name}: ${metadata.join("; ")}`);
    }
  }

  return lines;
}

function buildMcpSkipConstraints(task: TaskRecord): string[] {
  const skipContexts = task.context.mcpSkipContexts ?? [];
  if (skipContexts.length === 0) {
    return [];
  }

  return [
    "",
    "MCP skip constraints:",
    ...skipContexts.flatMap((context) => {
      const names = context.affectedCapabilityNames.join(", ");
      return [
        `- The following MCP capabilities were explicitly skipped for this task by the user: ${names} (MCP: ${context.mcpHandle}).`,
        "- Do not attempt to use these capabilities or retry authorization.",
        "- These tools will not appear in your available toolset.",
        "- If completing this task correctly requires these capabilities, find a valid workaround using only what is available, or report that the task cannot be completed correctly without them."
      ];
    })
  ];
}

function buildTaskSpecificConstraints(task: TaskRecord): string[] {
  const planDocumentPath = describeTaskDocumentPath(task.context.localRepoPath, task.context.planDocumentPath);
  const productSpecDocumentPath = task.context.productSpecDocumentPath
    ? describeTaskDocumentPath(task.context.localRepoPath, task.context.productSpecDocumentPath)
    : undefined;
  const logDocumentPath = describeTaskDocumentPath(task.context.localRepoPath, task.context.logDocumentPath);
  const productSpecPlanningConstraint = productSpecDocumentPath
    ? `The Product Spec is the product source of truth for this workstream when present: ${productSpecDocumentPath}. Do not rely only on the original issue once a Product Spec exists.`
    : undefined;
  const productSpecTaskConstraint = productSpecDocumentPath
    ? `- The Product Spec is the product source of truth for this workstream when present: ${productSpecDocumentPath}. Do not rely only on the original issue once a Product Spec exists.`
    : undefined;
  const productSpecReviewConstraint = productSpecDocumentPath
    ? `- The Product Spec is the product source of truth for this workstream when present: ${productSpecDocumentPath}. Review against its acceptance criteria when available.`
    : undefined;
  const executionConstraints =
    task.executionPermission === "read-only"
      ? [
        "- You are in read-only mode. Inspect, analyze, and report, but do not modify files or attempt local git writes."
      ]
      : [
        "- You are in workspace-write mode. You may edit files and use local git commands needed to keep the assigned branch/worktree healthy.",
        "- Keep the workspace on the intended branch and in a pushable state for orchestrator handoff.",
        "- Do not leave detached HEAD state, half-completed rebases or merges, or a broken index behind.",
        "- Do not push remotely or publish PRs. The orchestrator owns remote push and PR publication.",
        "- If local commits exist when you finish, leave them reviewable and pushable; the orchestrator will handle the push."
      ];

  switch (task.kind) {
    case "product_discovery":
      return [
        ...executionConstraints,
        "- Act as Product Manager presenting to the CTO.",
        "- Post the Product Discovery analysis on the GitHub issue through the configured broker MCP.",
        "- Stay product-focused; do not include implementation planning, architecture, file suggestions, code details, branch details, or worktree details.",
        "- A future UI/UX step may be recommended only as an informational product/design consideration."
      ];
    case "respond_issue_comment":
      if (task.workflowPhase === "product_discovery" || task.workflowPhase === "product_specification") {
        return [
          ...executionConstraints,
          "- You are in the Product Discovery/Product Specification phase. This is a mutual discovery dialogue, not a routing decision.",
          "- Post the response on the GitHub issue through the configured broker MCP.",
          "- Respond as Product Manager to refine shared understanding with the user.",
          "- Do not return a JSON routing decision; do not use answer_only or start_implementation.",
          "- If you need more information, surface it in an 'Open Questions' section; the user will try to answer.",
          "- Do not discuss implementation, files, code, architecture, branches, or worktrees.",
          "- Implementation authorization is the user's act of applying the product approval label, not your conclusion."
        ];
      }
      return [
        ...executionConstraints,
        "- Post the response on the GitHub issue through the configured broker MCP.",
        "- Answer in the context of the active workstream phase.",
        "- Do not return a JSON routing decision; do not use answer_only or start_implementation.",
        "- Implementation authorization comes from explicit workflow labels, not from issue-comment follow-up decisions."
      ];
    case "write_plan":
      return [
        "The plan must consider every thing in the issue and the context. Do not assume what to implement but follow the instructions in the context.",
        ...(productSpecPlanningConstraint ? [productSpecPlanningConstraint] : []),
        "If you are unable to fetch the issue or pr data from gh stop and report it. Do not plan some arbitrary change.",
        ...executionConstraints,
        `- Write the plan to ${planDocumentPath} and keep ${logDocumentPath} updated.`,
        "- The plan must be comprehensive enough for a later cheap-model implementation pass.",
        "- Local commits are allowed if they help keep the worktree in a clean, reviewable state, but do not push them.",
        "- Do not begin implementation in this task."
      ];
    case "implement_plan":
      return [
        ...executionConstraints,
        "- Only implement after confirming the work is already in the approved-plan phase.",
        ...(productSpecTaskConstraint ? [productSpecTaskConstraint] : []),
        `- Use ${planDocumentPath} as the source of truth for the implementation task.`,
        "- Local commits are allowed if they help keep the worktree in a clean, reviewable state, but do not push them."
      ];
    case "review_pr":
      return [
        ...executionConstraints,
        ...(productSpecReviewConstraint ? [productSpecReviewConstraint] : []),
        'Output contract: finish with a JSON object like {"action":"APPROVE","summary":"..."} or {"action":"REQUEST_CHANGES","summary":"...","inlineComments":[{"path":"src/file.ts","line":12,"body":"..."}]}.',
        "- Use APPROVE only when there are no actionable findings.",
        "- Use REQUEST_CHANGES when findings should block merge.",
        "- Use COMMENT for non-blocking review feedback.",
        "- summary is required and should provide a high-level overview of your review.",
        "- Each inline comment must be suitable for an inline GitHub review comment with a repo-relative path and a line number on the PR head version.",
        "- Inline comments are optional and should be concrete, location-specific, and limited.",
        "- Do not post the review directly to GitHub; the orchestrator owns publication."
      ];
    case "plan_breakdown":
      return [
        ...executionConstraints,
        "- Do not implement code.",
        "- You must use the Plan Breakdown Generator tool to decompose this plan.",
        "- Start a new session, build candidate packet plans using patches, and validate them.",
        ...PLAN_BREAKDOWN_EXTRA_INSTRUCTIONS.map((s) => `- ${s}`),
        '- Return exactly one JSON object: { "sessionId": "<selected generator session id>" }.',
        "- If no valid session can be produced, publish details to GitHub through the configured GitHub broker MCP when appropriate.",
        "- Failure details should include blocker, missing information, validation errors, and recommended human action when available.",
        "- After failure details are published, finish without returning a valid sessionId.",
        "- No valid sessionId means the orchestrator treats the plan_breakdown task as failed.",
        "- Do not return raw PlanBreakdownResult JSON directly.",
        "- Do not return Markdown as the primary result.",
        "- Do not wrap the JSON in a Markdown code fence.",
        "- Do not include prose before or after the JSON.",
        "- The orchestrator will export the selected session into the final PlanBreakdownResult artifact."
      ];
    case "wave_plan_assessment":
      return [
        ...executionConstraints,
        "- This is a plan-level checkpoint between packet waves.",
        "- Assess only the parent issue and parent PR plan; do not review packet PR implementation details as code review findings.",
        "- You must use the wave_assessment MCP tools for the checkpoint in the prompt packet.",
        "- Finalize the assessment through the MCP tool flow before returning.",
        "- Do not post the parent PR assessment comment yourself; the orchestrator publishes the canonical comment after it exports your finalized session.",
        "- Do not modify repository files, branches, or git state.",
        '- Output contract: finish with a JSON object like {"sessionId":"<finalized wave assessment session id>"}.'
      ];
    case "wave_plan_replanning":
      return [
        ...executionConstraints,
        "- This is parent-plan replanning after a finalized wave assessment.",
        "- The finalized assessment in the prompt packet is mandatory source context.",
        "- Do not proceed from memory, draft assessment state, or a stale checkpoint.",
        "- Keep changes scoped to parent packet plan replanning; do not edit packet implementation PRs.",
        "- Use the wave_assessment MCP context when you need assessment details or audit linkage.",
        "- You must use the plan_breakdown MCP tools to produce the revised parent packet plan.",
        "- Do not return raw PlanBreakdownResult JSON directly.",
        '- Output contract: finish with a JSON object like {"sessionId":"<selected plan breakdown generator session id>"}.',
        "- The orchestrator will export the selected session into the final PlanBreakdownResult artifact and install it as the new packet plan.",
        "- Do not run parent branch sync.",
        "- Leave the workspace clean and pushable for orchestrator handoff."
      ];
    case "prepare_pr_for_merge":
      return [
        "- You are resolving merge conflicts in a dedicated prepare-for-merge clone.",
        "- The orchestrator already fetched refs, checked out the PR branch, reset it to the expected PR head SHA, and started a normal merge from the base branch into the PR branch.",
        "- Do not run raw Git commands for index, commit, checkout, reset, fetch, merge, rebase, or push.",
        "- Do not push. The orchestrator owns final validation and normal push after this task.",
        "- The workstream ID is parent orchestration context only; do not use it as a Backburner Git tool argument.",
        "- Use the Backburner Git MCP tools with the Backburner Git session ID shown above as `backburnerGitSessionId` in every `backburner_git_*` call.",
        "- Use those tools to inspect conflict state, read base/ours/theirs versions, mark files resolved or deleted, unstage mistakes, and continue the merge.",
        "- Resolve conflicts semantically. Preserve both the PR's intended changes and the base branch's intended changes unless they are truly incompatible.",
        "- Avoid deleting work accidentally. Stop and report if a product decision is required.",
        "- Local verification:",
        "  - Run local build, test, typecheck, and lint commands.",
        "  - Do not poll or wait for remote GitHub CI.",
        "- Safe fixes:",
        "  - Fix only local merge/build/test/check failures needed to make the PR green after push.",
        "  - Do not introduce new product behavior or refactor unrelated code.",
        "- Bounded effort:",
        "  - Run at most a small number of focused verification/fix attempts.",
        "  - Stop with a clean repo and report failing checks if not resolved.",
        "- Handoff:",
        "  - Search for conflict markers before finishing.",
        "  - Before backburner_git_continue_merge, make sure there are no unstaged tracked changes or untracked files. Stage intended tracked changes, restore accidental worktree edits, or remove unintended untracked files first.",
        "  - Use backburner_git_continue_merge after all conflicted paths are resolved and the worktree is clean except for staged merge resolution changes.",
        "  - Leave no conflict markers or half-completed merge/rebase/cherry-pick state.",
        "  - Do not post a GitHub PR comment; the orchestrator posts the final audit comment.",
        "  - Write a summary of work done, checks run, and results as your final response output."
      ];
    case "respond_pr_comment":
      return [
        ...executionConstraints,
        "- Read the pull request and the comment before taking any action.",
        "- Classify the comment into one of three cases and follow the corresponding flow:",
        "",
        "  Case 1 — Retry request: the comment is asking you to retry a previously failed orchestrator task.",
        "  1. Do not attempt any implementation.",
        "  2. Locate the orchestrator failure comment in the PR thread (it says 'I tried to handle this orchestrator task' and includes the task kind and execution ID).",
        "  3. Copy its direct GitHub URL — it ends with `#issuecomment-<numeric-id>`.",
        "  4. Post a reply via the GitHub broker MCP containing exactly: `retry: <that-url>`",
        "     Example: `retry: https://github.com/owner/repo/pull/42#issuecomment-1234567890`",
        "",
        "  Case 2 — Code change or implementation request: the comment is asking for code changes, fixes, or implementation work",
        "  (e.g. review feedback requesting changes, 'fix this', 'let's implement this', 'add X', 'update Y').",
        "  1. Read the approved plan document if one exists (planDocumentPath in the packet) to understand intended scope.",
        "  2. Make the requested changes to the local repository.",
        "  3. Post a reply via the GitHub broker MCP summarizing what was changed.",
        "  4. Do not push — the orchestrator owns the push.",
        "",
        "  Case 3 — Discussion or question: the comment asks a question, requests clarification, or starts a conversation that does not require code changes.",
        "  1. Post a substantive reply via the GitHub broker MCP.",
        "  2. Do not make any code changes.",
        "",
        "- Always post a GitHub reply (via the broker MCP) regardless of which case applies — never finish silently."
      ];
    case "write_product_spec":
      return [
        ...executionConstraints,
        `- Write the Product Spec to ${productSpecDocumentPath} and keep ${logDocumentPath} updated.`,
        "- Stay product-focused. Do not write the implementation plan.",
        "- Include acceptance criteria and a UI/UX recommendation only if relevant.",
        "- Add a note that downstream planner, implementer, and reviewer must read the Product Spec."
      ];
    default:
      return executionConstraints;
  }
}

function normalizeForPrompt(value: string): string {
  return value.split(path.sep).join("/");
}

function describeTaskDocumentPath(localRepoPath: string | undefined, documentPath: string | undefined): string {
  if (!documentPath) {
    return "the assigned planning document";
  }

  if (!localRepoPath) {
    return normalizeForPrompt(documentPath);
  }

  return normalizeForPrompt(path.relative(localRepoPath, documentPath));
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}
