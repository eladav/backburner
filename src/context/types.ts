import * as path from "node:path";
import type {
  ParentBranchSyncPreflight,
  PrepareForMergePreflight,
  PullRequestReviewCommentLocationContext,
  TaskContextPacket,
  TaskKind,
  TaskRecord,
  TaskSourceKind
} from "../tasks/types.js";
import type {
  WaveAssessmentCheckpoint,
  WaveAssessmentResult
} from "../workstreams/wave-assessment/types.js";
import type { WorkstreamPhase } from "../state/types.js";

import type {
  RetrospectiveCandidateRecord,
  RetrospectiveProblemRecord,
  LearningOpportunityRecord,
} from "../retrospectives/types.js";
import type { AgentVisibleCapabilities } from "../capabilities/types.js";

export interface ContextBuildInput {
  taskKind: TaskKind;
  workflowPhase?: WorkstreamPhase;
  repoIdentifier: string;
  localRepoPath?: string;
  branchName?: string;
  packetId?: string;
  planDocumentPath?: string;
  productSpecDocumentPath?: string;
  logDocumentPath?: string;
  sourceKind: TaskSourceKind;
  sourceUrl: string;
  labels: string[];
  parentUrl?: string;
  issueTitle?: string;
  issueBody?: string;
  headSha?: string;
  commentUrl?: string;
  commentText?: string;
  pullRequestReviewLocation?: PullRequestReviewCommentLocationContext;
  preflight?: ParentBranchSyncPreflight;
  prepareForMerge?: PrepareForMergePreflight;
  waveAssessmentCheckpoint?: WaveAssessmentCheckpoint;
  finalizedWaveAssessment?: WaveAssessmentResult;
  retrospectiveCandidate?: RetrospectiveCandidateRecord;
  retrospectiveProblem?: RetrospectiveProblemRecord;
  learningOpportunity?: LearningOpportunityRecord;
}

export interface BuiltContext extends TaskContextPacket {
  taskId?: string;
  capabilities?: AgentVisibleCapabilities;
  /**
   * Execution-local context for a native provider-session resume after a
   * failed prior execution.
   */
  nativeResumeRetry?: {
    previousExecutionFailed: true;
  };
}

export interface ContextBuilder {
  build(input: ContextBuildInput): TaskContextPacket;
}

export class DefaultContextBuilder implements ContextBuilder {
  build(input: ContextBuildInput): TaskContextPacket {
    const productSpecSourceSentence = input.productSpecDocumentPath
      ? ` The Product Spec is the product source of truth for this workstream when present: ${displayDocumentPath(input.productSpecDocumentPath, input.localRepoPath)}. Do not rely only on the original issue once a Product Spec exists.`
      : "";
    const base = {
      repoIdentifier: input.repoIdentifier,
      ...(input.localRepoPath ? { localRepoPath: input.localRepoPath } : {}),
      ...(input.branchName ? { branchName: input.branchName } : {}),
      ...(input.packetId ? { packetId: input.packetId } : {}),
      ...(input.planDocumentPath ? { planDocumentPath: input.planDocumentPath } : {}),
      ...(input.productSpecDocumentPath ? { productSpecDocumentPath: input.productSpecDocumentPath } : {}),
      ...(input.logDocumentPath ? { logDocumentPath: input.logDocumentPath } : {}),
      ...(input.labels ? { labels: [...input.labels].sort((left, right) => left.localeCompare(right)) } : { labels: [] }),
      ...(input.preflight ? { preflight: input.preflight } : {}),
      ...(input.prepareForMerge ? { prepareForMerge: input.prepareForMerge } : {}),
      ...(input.waveAssessmentCheckpoint ? { waveAssessmentCheckpoint: input.waveAssessmentCheckpoint } : {}),
      ...(input.finalizedWaveAssessment ? { finalizedWaveAssessment: input.finalizedWaveAssessment } : {}),
      ...(input.retrospectiveCandidate ? { retrospectiveCandidate: input.retrospectiveCandidate } : {}),
      ...(input.retrospectiveProblem ? { retrospectiveProblem: input.retrospectiveProblem } : {}),
      ...(input.learningOpportunity ? { learningOpportunity: input.learningOpportunity } : {})
    };

    switch (input.taskKind) {
      case "product_discovery":
        return {
          ...base,
          issueUrl: input.sourceUrl,
          ...(input.issueTitle ? { issueTitle: compactText(input.issueTitle, 300) } : {}),
          ...(input.issueBody ? { issueBody: compactText(input.issueBody, 2000) } : {}),
          instruction:
            "Act as a Product Manager presenting product analysis to the CTO on the issue thread. Post a GitHub issue comment through the configured broker. Include concise understanding, product problem, target user or persona if inferable, goals, non-goals, assumptions, suggested product direction, alternatives/tradeoffs, proposed acceptance criteria, open questions, and whether a future UI/UX step may be useful. Explicitly state this is product analysis, not implementation planning. Do not include implementation plan, architecture, files, code, branch, or worktree details."
        };
      case "triage_issue":
        throw new Error("triage_issue is no longer an active task kind; use product_discovery instead.");
      case "respond_issue_comment":
        if (isProductWorkflowPhase(input.workflowPhase)) {
          return {
            ...base,
            issueUrl: input.parentUrl ?? input.sourceUrl,
            ...(input.issueTitle ? { issueTitle: compactText(input.issueTitle, 300) } : {}),
            ...(input.issueBody ? { issueBody: compactText(input.issueBody, 2000) } : {}),
            ...(input.commentUrl ? { commentUrl: input.commentUrl } : {}),
            ...(input.commentText ? { relevantCommentText: input.commentText } : {}),
            instruction:
              'You are in the Product Discovery/Product Specification phase. This is a mutual discovery dialogue, not a routing decision. Read the parent issue and the new comment, then post a GitHub issue comment through the configured broker as Product Manager refining product understanding with the user. Do not return a JSON routing decision. Do not mention "start_implementation", "answer_only", files, code, architecture, branches, or worktrees. If anything is unclear or ambiguous, surface it in an "Open Questions" section and invite the user to answer. The user signals readiness to proceed by applying the product approval label; your job is to ensure they are confident in doing so.'
          };
        }
        return {
          ...base,
          issueUrl: input.parentUrl ?? input.sourceUrl,
          ...(input.issueTitle ? { issueTitle: compactText(input.issueTitle, 300) } : {}),
          ...(input.issueBody ? { issueBody: compactText(input.issueBody, 2000) } : {}),
          ...(input.commentUrl ? { commentUrl: input.commentUrl } : {}),
          ...(input.commentText ? { relevantCommentText: input.commentText } : {}),
          instruction:
            "Read the parent issue and the new comment, then post a GitHub issue comment through the configured broker MCP. Answer in the context of the active workstream phase. Do not return a JSON routing decision, and do not use answer_only or start_implementation. Implementation authorization comes from explicit workflow labels, not from issue-comment follow-up decisions."
        };
      case "write_product_spec":
        return {
          ...base,
          ...(input.sourceKind === "issue"
            ? { issueUrl: input.sourceUrl }
            : { pullRequestUrl: input.sourceUrl }),
          ...(input.parentUrl ? { issueUrl: input.parentUrl } : {}),
          ...(input.issueTitle ? { issueTitle: compactText(input.issueTitle, 300) } : {}),
          ...(input.issueBody ? { issueBody: compactText(input.issueBody, 2000) } : {}),
          instruction:
            `Write or update ${displayDocumentPath(input.productSpecDocumentPath, input.localRepoPath)} as the Product Spec for this workstream, and document the product-specification work in ${displayDocumentPath(input.logDocumentPath, input.localRepoPath)}. Use the issue and Product Discovery discussion. Stay product-focused: include issue link, problem statement, product decision summary, goals, non-goals, user stories, personas where appropriate, success criteria, acceptance criteria, assumptions, constraints, dependencies, open questions, UI/UX recommendation if needed, and a note that downstream planner, implementer, and reviewer must read this spec. Do not write an implementation plan.`
        };
      case "review_pr":
        return {
          ...base,
          pullRequestUrl: input.sourceUrl,
          instruction:
            `Review the pull request at HEAD ${input.headSha ?? "unknown"} — re-read the current state of changed files from the local checkout; do not rely on prior session findings. Finish with JSON. Use {"action":"APPROVE","summary":"..."} when there are no actionable findings. Use {"action":"REQUEST_CHANGES","summary":"...","inlineComments":[{"path":"relative/file.ts","line":12,"body":"..."}]} when changes are required. Use {"action":"COMMENT","summary":"..."} for non-blocking feedback. Findings must be actionable, use repo-relative paths, and use line numbers on the PR head version that are suitable for inline code review comments.`
        };
      case "respond_pr_comment":
        return {
          ...base,
          pullRequestUrl: input.parentUrl ?? input.sourceUrl,
          ...(input.commentUrl ? { commentUrl: input.commentUrl } : {}),
          ...(input.commentText ? { relevantCommentText: input.commentText } : {}),
          ...(input.pullRequestReviewLocation ? { pullRequestReviewLocation: input.pullRequestReviewLocation } : {}),
          instruction:
            `Read the pull request at HEAD ${input.headSha ?? "unknown"} and the comment, then resolve the request or respond with the required follow-up.`
        };
      case "write_plan":
        return {
          ...base,
          ...(input.sourceKind === "issue"
            ? { issueUrl: input.sourceUrl }
            : { pullRequestUrl: input.sourceUrl }),
          ...(input.parentUrl ? { issueUrl: input.parentUrl } : {}),
          ...(input.issueTitle ? { issueTitle: input.issueTitle } : {}),
          ...(input.issueBody ? { issueBody: input.issueBody } : {}),
          ...(input.commentUrl ? { commentUrl: input.commentUrl } : {}),
          ...(input.commentText ? { relevantCommentText: input.commentText } : {}),
          instruction:
            `Write or update ${displayDocumentPath(input.planDocumentPath, input.localRepoPath)} with a comprehensive implementation plan for a later cheap-model implementation pass, and document the planning work in ${displayDocumentPath(input.logDocumentPath, input.localRepoPath)}.${productSpecSourceSentence} Do not begin implementation.`
        };
      case "implement_plan":
        return {
          ...base,
          ...(input.sourceKind === "issue"
            ? { issueUrl: input.sourceUrl }
            : { pullRequestUrl: input.sourceUrl }),
          ...(input.parentUrl ? { issueUrl: input.parentUrl } : {}),
          ...(input.issueTitle ? { issueTitle: compactText(input.issueTitle, 300) } : {}),
          ...(input.issueBody ? { issueBody: compactText(input.issueBody, 2000) } : {}),
          instruction:
            `Implement the approved plan from ${displayDocumentPath(input.planDocumentPath, input.localRepoPath)} and continue documenting work in ${displayDocumentPath(input.logDocumentPath, input.localRepoPath)}.${productSpecSourceSentence}`
        };
      case "plan_breakdown":
        return {
          ...base,
          ...(input.sourceKind === "issue"
            ? {
              issueUrl: input.sourceUrl,
              ...(input.issueTitle ? { issueTitle: compactText(input.issueTitle, 300) } : {}),
              ...(input.issueBody ? { issueBody: compactText(input.issueBody, 2000) } : {})
            }
            : { pullRequestUrl: input.sourceUrl }),
          instruction: buildPlanBreakdownInstruction()
        };
      case "wave_plan_assessment":
        return {
          ...base,
          pullRequestUrl: input.sourceUrl,
          ...(input.parentUrl ? { issueUrl: input.parentUrl } : {}),
          ...(input.issueTitle ? { issueTitle: compactText(input.issueTitle, 300) } : {}),
          ...(input.issueBody ? { issueBody: compactText(input.issueBody, 2000) } : {}),
          instruction: [
            "Assess the completed packet wave at the plan level before the next wave starts.",
            "This task is only about the parent issue/parent PR plan, not packet PR implementation review.",
            "Use the wave_assessment MCP tools to create and finalize the assessment for the provided checkpoint.",
            "Call wave_assessment.start_session with sessionId, workstreamId, waveId, parentPrNumber, assessedParentHeadSha, originalPlanningSessionId, currentPlanRevision, and planNodeIds from the task packet.",
            "When completing or exporting the session, pass currentIdentity with workstreamId, waveId, parentPrNumber, parentHeadSha, and planRevision from the task packet.",
            "Decide whether the next wave should continue, replan, or be blocked.",
            "Do not post the parent PR assessment comment yourself; finalize with the wave_assessment tools and return the session id so the orchestrator can publish the canonical comment.",
            "Do not modify repository files, packet PRs, branches, or git state.",
            'Return exactly one JSON object at the end: { "sessionId": "<finalized wave assessment session id>" }. Do not return raw assessment JSON.'
          ].join(" ")
        };
      case "wave_plan_replanning":
        return {
          ...base,
          pullRequestUrl: input.sourceUrl,
          ...(input.parentUrl ? { issueUrl: input.parentUrl } : {}),
          ...(input.issueTitle ? { issueTitle: compactText(input.issueTitle, 300) } : {}),
          ...(input.issueBody ? { issueBody: compactText(input.issueBody, 2000) } : {}),
          instruction: [
            "Revise the parent packet plan using the finalized wave assessment provided in the task packet.",
            "The finalized assessment is required input; do not proceed from memory or an unfinalized draft.",
            "This task is plan-level replanning for the parent issue/parent PR only, not packet PR implementation work.",
            "Use the wave_assessment MCP context as needed and preserve a clear audit trail for the parent PR.",
            "Do not edit packet implementation PRs or run branch sync."
          ].join(" ")
        };
      case "sync_parent_branch_preflight":
        return {
          ...base,
          issueUrl: input.sourceUrl,
          ...(input.issueTitle ? { issueTitle: compactText(input.issueTitle, 300) } : {}),
          ...(input.issueBody ? { issueBody: compactText(input.issueBody, 2000) } : {}),
          instruction:
            "Do not modify files or run git sync commands. Inspect/report the parent branch sync preflight before the next packet wave. Confirm that the current packet wave is complete, identify the parent integration branch and default branch, list completed packet IDs and pending future packet IDs, and explain that actual branch sync is out of scope for this task."
        };
      case "sync_parent_branch":
        return {
          ...base,
          pullRequestUrl: input.sourceUrl,
          instruction:
            "Resolve the requested parent branch sync for the packet workstream using the provided preflight context. Preserve the safety distinction between behind_default, diverged, and unknown/missing refs; leave the workspace clean after success or failure; do not advance the packet wave manually. The orchestrator remains responsible for remote publication handoff."
        };
      case "prepare_pr_for_merge":
        return {
          ...base,
          pullRequestUrl: input.sourceUrl,
          instruction: buildPrepareForMergeInstruction()
        };
      case "extract_retrospective_problems":
        return {
          ...base,
          instruction: buildRetrospectiveExtractInstruction()
        };
      case "investigate_learning_opportunity":
        return {
          ...base,
          instruction: buildRetrospectiveInvestigateInstruction()
        };
      case "draft_management_learning_proposal":
        return {
          ...base,
          instruction: buildRetrospectiveProposalInstruction()
        };
    }
  }
}

function buildRetrospectiveExtractInstruction(): string {
  return [
    "Your goal is to extract structured observations about recurring problems from a completed workstream.",
    "Read the provided candidate record and its evidence references.",
    "Treat product_discovery and write_product_spec as first-class product workflow tasks: evaluate whether product understanding, approval gating, Product Spec quality, or Product-to-planning handoff contributed to the problem.",
    "Identify one or more distinct problems that occurred during this workstream and could be improved in the future.",
    "Return exactly one JSON object with the following contract:",
    "{",
    '  "problems": [',
    "    {",
    '      "candidateId": "string (matches the source candidate id)",',
    '      "problemSummary": "string (concise summary of the problem)",',
    '      "evidenceReferences": [{ "kind": "...", "id": "...", "url": "...", "summary": "..." }],',
    '      "affectedRepos": ["string (repo ids)"],',
    '      "affectedRoles": ["string (agent roles)"],',
    '      "affectedTaskKinds": ["string (task kinds)"],',
    '      "affectedProviders": ["string (agent providers)"],',
    '      "confidence": "low | medium | high",',
    '      "impact": "low | medium | high",',
    '      "transferability": "low | medium | high",',
    '      "improvementLikelihood": "low | medium | high",',
    '      "overfittingRisk": "low | medium | high",',
    '      "suggestedScopes": [{ "kind": "...", "...": "..." }],',
    '      "reasonItMightRecur": "string (why this is a structural problem, not a one-off error)"',
    "    }",
    "  ]",
    "}",
    "Do not rank, score, or validate the suggested scopes.",
    "Do not write files, create commits, or open pull requests.",
    "Return only the raw JSON object."
  ].join("\n");
}

function buildRetrospectiveInvestigateInstruction(): string {
  return [
    "Your goal is to investigate a specific retrospective problem and identify learning opportunities.",
    "Analyze the provided problem record and its evidence.",
    "Determine the root cause and how the orchestrator's behavior or instructions could be improved.",
    "Return exactly one JSON object with the following contract:",
    "{",
    '  "problemId": "string (matches the source problem id)",',
    '  "investigationSummary": "string (summary of your findings)",',
    '  "investigationResult": "string (detailed analysis)",',
    '  "evidenceReferences": [{ "kind": "...", "id": "...", "url": "...", "summary": "..." }],',
    '  "selectedScope": { "kind": "...", "...": "..." },',
    '  "rationale": "string (why this scope and investigation result are correct)"',
    "}",
    "Do not validate the scope against the filesystem.",
    "Do not materialize management artifacts or proposed edits.",
    "Do not write files, create commits, or open pull requests.",
    "Return only the raw JSON object."
  ].join("\n");
}

function buildRetrospectiveProposalInstruction(): string {
  return [
    "Your goal is to draft a structured management learning proposal based on an investigated opportunity.",
    "Review the opportunity and problem context.",
    "Draft a specific, actionable improvement to the orchestrator's guidance (e.g. GEMINI.md or instruction files).",
    "Return exactly one JSON object with the following contract:",
    "{",
    '  "opportunityId": "string (matches the source opportunity id)",',
    '  "problemId": "string (optional source problem id)",',
    '  "selectedScope": { "kind": "...", "...": "..." },',
    '  "proposedEditMode": "append | refine | supersede | create",',
    '  "proposedGuidanceText": "string (the actual markdown or text for the instruction)",',
    '  "rationale": "string (why this change is needed)",',
    '  "expectedBehaviorChange": "string (what the orchestrator should do differently after this change)"',
    "}",
    "Guidance should be concise and suitable for an existing scoped learning artifact.",
    "Do not provide filesystem paths; the orchestrator will resolve the typed scope to a path.",
    "Do not write files, create branch, create commits, push, or open pull requests.",
    "Return only the raw JSON object."
  ].join("\n");
}

function buildPrepareForMergeInstruction(): string {
  return [
    "Your goal is merge preparation only — not feature implementation.",
    "Read the prepareForMerge context from the task packet to get the head branch, base branch, and PR details.",
    "Steps:",
    "1. Verify the working tree is clean before starting. If it is not clean, report the state and stop without making changes.",
    "2. Fetch the latest remote state: git fetch origin.",
    "3. Check out the PR head branch and ensure it tracks origin.",
    "4. Merge the PR base branch into the head branch: git merge origin/<baseBranch>.",
    "5. If conflicts exist, resolve them by understanding both sides' intent. Preserve the work from both branches. Do not delete either side's feature to simplify the merge.",
    "6. Allowed changes only: conflict marker removal with semantic reconciliation, import/export fixes, type fixes caused by merged code shape, formatting fixes, stale test expectation updates when implementation behavior is unchanged, small build/lint/test fixes required by the merged code, package lock updates when required by existing dependency changes.",
    "7. Disallowed: new product features, changed business logic beyond reconciling both branches, feature deletion to simplify the merge, force-push history rewrites, broad refactors, base branch changes, auto-merging the PR.",
    "8. Run the configured verification commands (tests, typecheck, build, lint, or the configured verification command set).",
    "9. If verification passes and all conflicts are resolved: ensure all resolved changes are committed locally. Write a summary of what was resolved and the verification results as the final output of your response. Do not push; the orchestrator owns the remote push. Do not post a GitHub PR comment; the orchestrator posts the final audit comment after confirming the push.",
    "10. If you encounter a conflict you cannot safely resolve without a product decision, or if verification fails in a way that requires product changes: abort the merge (git merge --abort), restore the working tree to a clean state, and post a GitHub comment describing which files conflict, what decisions are needed, what verification was attempted, and why you cannot proceed safely. Do not push partial or conflicted state.",
    "Stop and report when a human product decision is needed.",
    "The orchestrator owns remote publication handoff."
  ].join("\n");
}

export const PLAN_BREAKDOWN_EXTRA_INSTRUCTIONS: readonly string[] = [
  "Plan breakdown is a one-time decomposition step for this workstream; make the generated packet plan good enough to survive later cycles without re-running breakdown.",
  "Do not artificially cap packet count or wave count. Create as many packets as the work needs, including more than 10 packets when that makes implementation safer.",
  "Assume later implementation will be done by a cheap or weaker implementation agent. Each packet needs a clear title, detailed description, concrete acceptance criteria, likely files, dependencies, risk, and verification commands.",
  "Packet PRs are planning shells created from this breakdown. Detailed per-packet plan documents are written later by write_plan tasks, so this breakdown must provide enough raw material for those sub-plans."
];

function buildPlanBreakdownInstruction(): string {
  return [
    "Do not implement code.",
    "You must use the Plan Breakdown Generator tool to decompose this plan.",
    "Start a new session, build candidate packet plans using patches, and validate them.",
    ...PLAN_BREAKDOWN_EXTRA_INSTRUCTIONS,
    'Return exactly one JSON object: { "sessionId": "<selected generator session id>" }.',
    "If no valid session can be produced, publish details to GitHub through the configured GitHub broker MCP when appropriate.",
    "Failure details should include blocker, missing information, validation errors, and recommended human action when available.",
    "After failure details are published, finish without returning a valid sessionId.",
    "No valid sessionId means the orchestrator treats the plan_breakdown task as failed.",
    "Do not return raw PlanBreakdownResult JSON directly.",
    "Do not return Markdown as the primary result.",
    "Do not wrap the JSON in a Markdown code fence.",
    "Do not include prose before or after the JSON.",
    "The orchestrator will export the selected session into the final PlanBreakdownResult artifact."
  ].join("\n");
}


export function buildAgentContext(
  task: TaskRecord,
  memoryBackground?: string,
  capabilities?: AgentVisibleCapabilities
): BuiltContext {
  return {
    taskId: task.id,
    ...task.context,
    ...(memoryBackground ? { memoryBackground } : {}),
    ...(capabilities !== undefined ? { capabilities } : {})
  };
}

function compactText(value: string, maxLength = 500): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isProductWorkflowPhase(phase: WorkstreamPhase | undefined): boolean {
  return phase === "product_discovery" || phase === "product_specification";
}

function displayDocumentPath(documentPath: string | undefined, localRepoPath: string | undefined): string {
  if (!documentPath) {
    return "the assigned planning document";
  }

  if (!localRepoPath) {
    return documentPath;
  }

  return relativeToRepo(localRepoPath, documentPath);
}

function relativeToRepo(localRepoPath: string, documentPath: string): string {
  return path.relative(localRepoPath, documentPath).split(path.sep).join("/");
}
