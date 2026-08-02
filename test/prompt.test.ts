import * as assert from "node:assert/strict";
import { test } from "node:test";
import { buildPromptPacket, renderPrompt } from "../src/agents/prompt.js";
import type { TaskRecord } from "../src/tasks/types.js";
import type { BuiltContext } from "../src/context/types.js";

function buildMinimalTask(kind: TaskRecord["kind"]): TaskRecord {
  return {
    id: "task-1",
    kind,
    status: "pending",
    executionPermission: "workspace-write",
    handoffPolicy: {
      expectsPushableHandoff: true,
      orchestratorOwnsPush: true,
      remotePublishOwner: "orchestrator"
    },
    repoId: "repo-1",
    repoName: "repo",
    repoSlug: "owner/repo",
    sourceKind: "issue",
    sourceId: "issue-1",
    sourceUrl: "https://github.com/owner/repo/issues/1",
    relevant: true,
    reason: "reason",
    summary: "summary",
    context: {
      repoIdentifier: "owner/repo",
      labels: [],
      instruction: "Do something"
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function buildMinimalContext(): BuiltContext {
  return {
    repoIdentifier: "owner/repo",
    labels: [],
    instruction: "Do something"
  };
}

test("renderPrompt uses customConstraints when provided", () => {
  const task = buildMinimalTask("write_plan");
  const packet = buildPromptPacket(task, buildMinimalContext());
  const output = renderPrompt(task, packet, { customConstraints: "- Custom rule A\n- Custom rule B" });
  assert.ok(output.includes("- Custom rule A"));
  assert.ok(output.includes("- Custom rule B"));
  assert.ok(!output.includes("The plan must consider every thing"));  // built-in gone
});

test("renderPrompt uses built-in constraints when customConstraints is undefined", () => {
  const task = buildMinimalTask("write_plan");
  const packet = buildPromptPacket(task, buildMinimalContext());
  const output = renderPrompt(task, packet);
  assert.ok(output.includes("The plan must consider every thing"));  // built-in present
});

test("renderPrompt warns a natively resumed retry to re-read the current workspace", () => {
  const task = buildMinimalTask("implement_plan");
  const context: BuiltContext = {
    ...buildMinimalContext(),
    nativeResumeRetry: {
      previousExecutionFailed: true
    }
  };
  const output = renderPrompt(task, buildPromptPacket(task, context));

  assert.match(output, /prior execution failed/);
  assert.match(output, /may have preserved, recovered, or reset the workspace/);
  assert.match(output, /prior edits or checkout state may therefore be stale/);
  assert.match(output, /re-read `git status`, the current files, and the current diff/);
});

test("renderPrompt omits native resume retry guidance for an ordinary dispatch", () => {
  const task = buildMinimalTask("implement_plan");
  const output = renderPrompt(task, buildPromptPacket(task, buildMinimalContext()));

  assert.doesNotMatch(output, /Native resume retry context/);
});

test("renderPrompt renders MCP skip contexts as explicit constraints", () => {
  const task = {
    ...buildMinimalTask("implement_plan"),
    context: {
      ...buildMinimalTask("implement_plan").context,
      mcpSkipContexts: [
        {
          mcpHandle: "context7",
          affectedCapabilityNames: ["context7-docs"],
          skipReason: "User explicitly skipped MCP authorization for this task."
        }
      ]
    }
  };
  const packet = buildPromptPacket(task, buildMinimalContext());
  const output = renderPrompt(task, packet);

  assert.match(output, /MCP skip constraints:/);
  assert.match(output, /context7-docs/);
  assert.match(output, /Do not attempt to use these capabilities or retry authorization/);
  assert.match(output, /These tools will not appear in your available toolset/);
  assert.match(output, /find a valid workaround/);
});

test("renderPrompt renders prepare_pr_for_merge details", () => {
  const task = {
    ...buildMinimalTask("prepare_pr_for_merge"),
    id: "task:prepare_pr_for_merge:owner/repo#225",
    workstreamId: "owner/repo:issue:11"
  };
  const prepareForMerge = {
    prNumber: 225,
    prTitle: "Add prepare-for-merge PR workflow",
    headBranch: "feature/merge-ready",
    headSha: "abcdef123456",
    baseBranch: "main"
  };
  const context = {
    ...buildMinimalContext(),
    prepareForMerge
  };
  const packet = buildPromptPacket(task, context);
  const output = renderPrompt(task, packet);

  assert.ok(output.includes("Prepare for merge details:"));
  assert.ok(output.includes("- workstream id: owner/repo:issue:11"));
  assert.ok(output.includes("- Backburner Git session ID: task:prepare_pr_for_merge:owner/repo#225"));
  assert.ok(output.includes("- PR: #225"));
  assert.ok(output.includes("- Title: Add prepare-for-merge PR workflow"));
  assert.ok(output.includes("- Head branch: feature/merge-ready"));
  assert.ok(output.includes("- Head SHA: abcdef123456"));
  assert.ok(output.includes("- Base branch: main"));

  // Verify it's also in the JSON packet
  assert.ok(output.includes('"prNumber": 225'));
  assert.ok(output.includes('"backburnerGitSessionId": "task:prepare_pr_for_merge:owner/repo#225"'));
});

test("renderPrompt renders task-specific constraints for prepare_pr_for_merge", () => {
  const task = buildMinimalTask("prepare_pr_for_merge");
  const packet = buildPromptPacket(task, buildMinimalContext());
  const output = renderPrompt(task, packet);

  // Assertions for new requirements
  assert.match(output, /Do not push/);
  assert.match(output, /wait for remote GitHub CI/);
  assert.match(output, /orchestrator already fetched refs/);
  assert.match(output, /started a normal merge from the base branch/);
  assert.match(output, /Do not run raw Git commands for index, commit, checkout, reset, fetch, merge, rebase, or push/);
  assert.match(output, /Use the Backburner Git MCP tools/);
  assert.match(output, /workstream ID is parent orchestration context only/);
  assert.match(output, /backburnerGitSessionId/);
  assert.match(output, /Resolve conflicts semantically/);
  assert.match(output, /Preserve both the PR's intended changes and the base branch's intended changes/);
  assert.match(output, /Local verification/);
  assert.match(output, /Run local build/);
  assert.match(output, /Fix only local merge\/build\/test\/check failures/);
  assert.match(output, /Use backburner_git_continue_merge/);
  assert.match(output, /no unstaged tracked changes/);
  assert.match(output, /untracked files/);
  assert.match(output, /worktree is clean except for staged merge resolution changes/);
  assert.match(output, /Leave no conflict markers/);
  assert.match(output, /half-completed merge\/rebase\/cherry-pick/);
  assert.match(output, /The orchestrator owns final validation and normal push after this task./);
  assert.match(output, /Do not post a GitHub PR comment; the orchestrator posts the final audit comment./);
  assert.match(output, /Write a summary of work done, checks run, and results as your final response output./);
  assert.match(output, /Run at most a small number of focused verification\/fix attempts/);

  // Assertions for removed or forbidden requirements
  assert.ok(!output.includes("Push the updated head branch"));
  assert.ok(!output.includes("auto-merge"));
});

test("renderPrompt renders wave assessment checkpoint instructions", () => {
  const task = {
    ...buildMinimalTask("wave_plan_assessment"),
    executionPermission: "read-only" as const,
    sourceKind: "pull_request" as const,
    sourceUrl: "https://github.com/owner/repo/pull/31"
  };
  const context: BuiltContext = {
    ...buildMinimalContext(),
    pullRequestUrl: "https://github.com/owner/repo/pull/31",
    waveAssessmentCheckpoint: {
      id: "checkpoint-1",
      sessionId: "checkpoint-1",
      identity: {
        repoKey: "owner/repo",
        workstreamId: "owner/repo:issue:11",
        waveId: "wave-0",
        parentPrNumber: 31,
        parentHeadSha: "abc123",
        parentIntegrationBranch: "agent/owner-repo/issue-11",
        defaultBranch: "main",
        planRevision: "rev-1",
        originalPlanningSessionId: "planner-session-1",
        currentWaveIndex: 0,
        nextWaveIndex: 1,
        completedPacketIds: ["T1"],
        pendingFuturePacketIds: ["T2"],
        planNodeIds: ["T1", "T2"]
      }
    },
    instruction: "Assess the completed packet wave."
  };

  const packet = buildPromptPacket(task, context);
  const output = renderPrompt(task, packet);

  assert.equal(packet.waveAssessmentCheckpoint?.id, "checkpoint-1");
  assert.match(output, /Wave assessment checkpoint:/);
  assert.match(output, /Completed packet IDs: T1/);
  assert.match(output, /Pending future packet IDs: T2/);
  assert.match(output, /plan-level checkpoint/);
  assert.match(output, /must use the wave_assessment MCP tools/);
  assert.match(output, /orchestrator publishes the canonical comment/);
  assert.match(output, /\{"sessionId":"<finalized wave assessment session id>"\}/);
  assert.ok(!output.includes("assessmentId"));
  assert.ok(!output.includes("post only the parent PR assessment"));
});

test("renderPrompt includes the full wave reassessment command, reason, and prior blocked result", () => {
  const task = {
    ...buildMinimalTask("wave_plan_assessment"),
    executionPermission: "read-only" as const,
    sourceKind: "pull_request" as const,
    sourceUrl: "https://github.com/owner/repo/pull/31"
  };
  const checkpoint = {
    id: "checkpoint-1",
    sessionId: "checkpoint-1:reassess:7001",
    identity: {
      repoKey: "owner/repo",
      workstreamId: "owner/repo:issue:11",
      waveId: "wave-0",
      parentPrNumber: 31,
      parentHeadSha: "abc123",
      parentIntegrationBranch: "agent/owner-repo/issue-11",
      defaultBranch: "main",
      planRevision: "rev-1",
      originalPlanningSessionId: "planner-session-1",
      currentWaveIndex: 0,
      nextWaveIndex: 1,
      completedPacketIds: ["T1"],
      pendingFuturePacketIds: ["T2"],
      planNodeIds: ["T1", "T2"]
    }
  };
  const commentText = "wave-reassess\nreason: Integration risk is explicitly deferred.";
  const priorAssessment = {
    id: "assessment:checkpoint-1",
    sessionId: "checkpoint-1",
    checkpoint: { ...checkpoint, sessionId: "checkpoint-1" },
    decision: "blocked" as const,
    summary: "Verification is incomplete.",
    findings: [],
    status: "finalized" as const,
    postedCommentId: "6999"
  };
  const context: BuiltContext = {
    ...buildMinimalContext(),
    pullRequestUrl: task.sourceUrl,
    waveAssessmentCheckpoint: checkpoint,
    finalizedWaveAssessment: priorAssessment,
    waveReassessment: {
      sourceCommentId: "7001",
      sourceCommentUrl: `${task.sourceUrl}#issuecomment-7001`,
      sourceCommentAuthor: "owner",
      commentText,
      reason: "Integration risk is explicitly deferred."
    },
    instruction: "Perform a fresh wave assessment."
  };
  task.context = context;

  const packet = buildPromptPacket(task, context);
  const output = renderPrompt(task, packet);

  assert.equal(packet.waveReassessment?.commentText, commentText);
  assert.equal(packet.finalizedWaveAssessment?.id, priorAssessment.id);
  assert.match(output, /Human-requested wave reassessment:/);
  assert.match(output, /Parsed reason: Integration risk is explicitly deferred\./);
  assert.match(output, /wave-reassess\nreason: Integration risk is explicitly deferred\./);
  assert.match(output, /Decision: blocked/);
  assert.match(output, /repeated attempt for the same checkpoint/);
  assert.match(output, /not a human override/);
});

test("renderPrompt renders finalized wave assessment for replanning", () => {
  const task = buildMinimalTask("wave_plan_replanning");
  const checkpoint = {
    id: "checkpoint-1",
    sessionId: "checkpoint-1",
    identity: {
      repoKey: "owner/repo",
      workstreamId: "owner/repo:issue:11",
      waveId: "wave-0",
      parentPrNumber: 31,
      parentHeadSha: "abc123",
      parentIntegrationBranch: "agent/owner-repo/issue-11",
      defaultBranch: "main",
      planRevision: "rev-1",
      originalPlanningSessionId: "planner-session-1",
      currentWaveIndex: 0,
      nextWaveIndex: 1,
      completedPacketIds: ["T1"],
      pendingFuturePacketIds: ["T2"],
      planNodeIds: ["T1", "T2"]
    }
  };
  const context: BuiltContext = {
    ...buildMinimalContext(),
    pullRequestUrl: "https://github.com/owner/repo/pull/31",
    waveAssessmentCheckpoint: checkpoint,
    finalizedWaveAssessment: {
      id: "assessment-1",
      sessionId: "checkpoint-1",
      checkpoint,
      decision: "replan",
      summary: "Next wave needs plan changes.",
      findings: [],
      status: "finalized",
      postedCommentId: "123",
      finalizedAt: "2026-06-26T00:00:00.000Z"
    },
    instruction: "Revise the parent packet plan."
  };

  const packet = buildPromptPacket(task, context);
  const output = renderPrompt(task, packet);

  assert.equal(packet.finalizedWaveAssessment?.decision, "replan");
  assert.match(output, /Finalized wave assessment:/);
  assert.match(output, /Decision: replan/);
  assert.match(output, /finalized assessment in the prompt packet is mandatory/);
  assert.match(output, /must use the plan_breakdown MCP tools/);
  assert.match(output, /\{"sessionId":"<selected plan breakdown generator session id>"\}/);
  assert.match(output, /Do not run parent branch sync/);
});

test("renderPrompt output is unchanged when learningOverlays is undefined", () => {
  const task = buildMinimalTask("write_plan");
  const packet = buildPromptPacket(task, buildMinimalContext());
  const withoutOverlays = renderPrompt(task, packet);
  const withUndefined = renderPrompt(task, packet, { learningOverlays: undefined });
  assert.equal(withoutOverlays, withUndefined);
});

test("renderPrompt output is unchanged when learningOverlays is empty array", () => {
  const task = buildMinimalTask("write_plan");
  const packet = buildPromptPacket(task, buildMinimalContext());
  const withoutOverlays = renderPrompt(task, packet);
  const withEmpty = renderPrompt(task, packet, { learningOverlays: [] });
  assert.equal(withoutOverlays, withEmpty);
});

test("renderPrompt appends overlay section when overlays are provided", () => {
  const task = buildMinimalTask("write_plan");
  const packet = buildPromptPacket(task, buildMinimalContext());
  const output = renderPrompt(task, packet, {
    learningOverlays: ["First overlay content", "Second overlay content"]
  });
  assert.ok(output.includes("Approved learning overlays"));
  assert.ok(output.includes("First overlay content"));
  assert.ok(output.includes("Second overlay content"));
});

test("renderPrompt appends overlays after the prompt packet JSON block", () => {
  const task = buildMinimalTask("write_plan");
  const packet = buildPromptPacket(task, buildMinimalContext());
  const output = renderPrompt(task, packet, {
    learningOverlays: ["OVERLAY_SENTINEL"]
  });
  const packetJsonIdx = output.lastIndexOf("```json");
  const packetJsonClose = output.indexOf("```", packetJsonIdx + 7);
  const overlayIdx = output.indexOf("OVERLAY_SENTINEL");
  assert.ok(overlayIdx > packetJsonClose, "Overlay must come after the prompt packet JSON block");
});

test("renderPrompt preserves overlay order", () => {
  const task = buildMinimalTask("write_plan");
  const packet = buildPromptPacket(task, buildMinimalContext());
  const output = renderPrompt(task, packet, {
    learningOverlays: ["FIRST", "SECOND", "THIRD"]
  });
  const firstIdx = output.indexOf("FIRST");
  const secondIdx = output.indexOf("SECOND");
  const thirdIdx = output.indexOf("THIRD");
  assert.ok(firstIdx < secondIdx && secondIdx < thirdIdx, "Overlays must appear in order");
});

test("renderPrompt renders retrospective record details and propagates them to JSON", () => {
  const task = buildMinimalTask("extract_retrospective_problems");
  const retrospectiveCandidate = { id: "c-123", sourceWorkstreamId: "ws-1" };
  const retrospectiveProblem = { id: "p-456", candidateId: "c-123" };
  const learningOpportunity = { id: "o-789", problemId: "p-456" };

  const context: BuiltContext = {
    ...buildMinimalContext(),
    retrospectiveCandidate,
    retrospectiveProblem,
    learningOpportunity
  };

  const packet = buildPromptPacket(task, context);
  const output = renderPrompt(task, packet);

  assert.ok(output.includes("- retrospective candidate: c-123"));
  assert.ok(output.includes("- retrospective problem: p-456"));
  assert.ok(output.includes("- learning opportunity: o-789"));

  // Verify it's also in the JSON packet
  assert.ok(output.includes('"retrospectiveCandidate": {'));
  assert.ok(output.includes('"id": "c-123"'));
  assert.ok(output.includes('"retrospectiveProblem": {'));
  assert.ok(output.includes('"id": "p-456"'));
  assert.ok(output.includes('"learningOpportunity": {'));
  assert.ok(output.includes('"id": "o-789"'));
});
