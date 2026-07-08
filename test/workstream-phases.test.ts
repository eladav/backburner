import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkstreamPhaseReducerInput } from "../src/workstreams/phases.js";
import { reduceWorkstreamPhase } from "../src/workstreams/phases.js";
import { deriveWorkstreamMachineEvents } from "../src/workflows/workstream-machine/derive-events.js";
import { evaluateWorkstreamMachine } from "../src/workflows/workstream-machine/evaluate.js";

function phaseInput(overrides: Partial<WorkstreamPhaseReducerInput> = {}): WorkstreamPhaseReducerInput {
  return {
    previousPhase: undefined,
    originType: "issue",
    issuePresent: true,
    activePullRequestState: undefined,
    activePullRequestLabels: [],
    attentionReasons: [],
    inProgressLabel: "agent-in-progress",
    reviewLabel: "agent-review",
    approvalLabel: "agent-plan-approved",
    activeWorktreeStatus: undefined,
    status: "open",
    resolution: "unresolved",
    ...overrides
  };
}

test("reduceWorkstreamPhase starts new issues in Product Discovery until implementation path begins", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      attentionReasons: ["new_issue"],
    })),
    "product_discovery"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "issue_triage",
      activeWorktreeStatus: "planning"
    })),
    "planning"
  );
});

test("reduceWorkstreamPhase moves to implementation_ready and then implementing", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "planning",
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-plan-approved"],
      attentionReasons: ["plan_approved"],
      activeWorktreeStatus: "implementation_ready"
    })),
    "implementation_ready"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementation_ready",
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-plan-approved"],
      activeWorktreeStatus: "implementing"
    })),
    "implementing"
  );
});

test("reduceWorkstreamPhase handles Product Discovery and Product Specification transitions", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "product_discovery",
      attentionReasons: ["product_approval_observed"]
    })),
    "product_specification"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "product_specification",
      activeWorktreeStatus: "product_specification"
    })),
    "product_specification"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "product_specification",
      activeWorktreeStatus: "planning"
    })),
    "planning"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "issue_waiting"
    })),
    "product_discovery"
  );
});

test("reduceWorkstreamPhase moves to implementation_done and does not rewind on lingering approval", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementing",
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-plan-approved"],
      activeWorktreeStatus: "implementation_done"
    })),
    "implementation_done"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementation_done",
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-plan-approved"],
      activeWorktreeStatus: "implementation_done"
    })),
    "implementation_done"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementation_done",
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-plan-approved", "agent-review"],
      attentionReasons: ["pr_review_requested"],
      activeWorktreeStatus: "implementation_done"
    })),
    "pr_review"
  );
});

test("reduceWorkstreamPhase maps comments after implementation_done to implementation_feedback", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementation_done",
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-plan-approved"],
      attentionReasons: ["pr_comment_added"],
      activeWorktreeStatus: "implementation_done"
    })),
    "implementation_feedback"
  );
});

test("reduceWorkstreamPhase maps comment attention to feedback phases", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "planning",
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-in-progress"],
      attentionReasons: ["pr_comment_added"],
      activeWorktreeStatus: "awaiting_plan_approval"
    })),
    "plan_feedback"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementing",
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-plan-approved"],
      attentionReasons: ["issue_comment_added"],
      activeWorktreeStatus: "implementing"
    })),
    "implementation_feedback"
  );
});

test("reduceWorkstreamPhase exposes resolved and abandoned terminal scaffolding", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementing",
      issuePresent: false,
      status: "merged",
      resolution: "merged"
    })),
    "resolved"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "planning",
      issuePresent: false,
      status: "closed",
      resolution: "closed"
    })),
    "abandoned"
  );
});

test("reduceWorkstreamPhase maps review label to pr_review", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      originType: "pr",
      issuePresent: false,
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-review"],
      attentionReasons: ["pr_review_requested"]
    })),
    "pr_review"
  );
});

test("reduceWorkstreamPhase keeps review ahead of approval", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "planning",
      originType: "pr",
      issuePresent: false,
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-review", "agent-plan-approved"],
      attentionReasons: ["pr_review_requested", "plan_approved"]
    })),
    "pr_review"
  );
});

test("reduceWorkstreamPhase keeps review ahead of implementing and feedback", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementing",
      originType: "pr",
      issuePresent: false,
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-review", "agent-plan-approved"],
      attentionReasons: ["pr_review_requested", "pr_comment_added"],
      activeWorktreeStatus: "implementing"
    })),
    "pr_review"
  );
});

test("reduceWorkstreamPhase keeps merged resolution ahead of closed status", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementing",
      issuePresent: false,
      status: "closed",
      resolution: "merged"
    })),
    "resolved"
  );
});

test("reduceWorkstreamPhase migrates existing open issue triage into Product Discovery", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "issue_triage",
      attentionReasons: []
    })),
    "product_discovery"
  );
});

test("reduceWorkstreamPhase moves prior terminal open issues without implementation path to waiting", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "abandoned",
      originType: "issue",
      issuePresent: true,
      activePullRequestState: "open",
      resolution: "unresolved",
      status: "open"
    })),
    "issue_waiting"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "resolved",
      originType: "issue",
      issuePresent: true,
      activePullRequestState: "open",
      resolution: "unresolved",
      status: "open"
    })),
    "issue_waiting"
  );
});

test("reduceWorkstreamPhase defaults standalone PRs without prior phase to review", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      originType: "pr",
      issuePresent: false,
      activePullRequestState: "open"
    })),
    "pr_review"
  );
});

test("reduceWorkstreamPhase keeps PR implementation workstreams in implementation phases", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementing",
      originType: "pr",
      issuePresent: false,
      activePullRequestState: "open",
      activeWorktreeStatus: "closed"
    })),
    "implementing"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementation_feedback",
      originType: "pr",
      issuePresent: false,
      activePullRequestState: "open",
      activeWorktreeStatus: "closed",
      attentionReasons: ["pr_comment_edited"]
    })),
    "implementation_feedback"
  );
});

test("reduceWorkstreamPhase maps contextual comment feedback by active path", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementing",
      attentionReasons: ["issue_comment_added"],
      activeWorktreeStatus: "implementing"
    })),
    "implementation_feedback"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "planning",
      attentionReasons: ["issue_comment_added"],
      activeWorktreeStatus: "planning"
    })),
    "plan_feedback"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "planning",
      activePullRequestState: "open",
      activePullRequestLabels: ["agent-in-progress"],
      attentionReasons: ["issue_comment_added"]
    })),
    "plan_feedback"
  );
});

test("reduceWorkstreamPhase keeps generic comment attention out of feedback phases", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "issue_triage",
      attentionReasons: ["issue_comment_added"]
    })),
    "product_discovery"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      attentionReasons: ["new_issue", "issue_comment_added"]
    })),
    "product_discovery"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      originType: "pr",
      issuePresent: false,
      attentionReasons: ["pr_comment_added"]
    })),
    "pr_review"
  );

  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "planning",
      originType: "pr",
      issuePresent: false,
      attentionReasons: ["pr_comment_added"]
    })),
    "planning"
  );
});

test("reduceWorkstreamPhase maps prior PR implementation fallback feedback", () => {
  assert.equal(
    reduceWorkstreamPhase(phaseInput({
      previousPhase: "implementing",
      originType: "pr",
      issuePresent: false,
      activeWorktreeStatus: "closed",
      attentionReasons: ["pr_comment_added"]
    })),
    "implementation_feedback"
  );
});

test("deriveWorkstreamMachineEvents emits representative phase signal events", () => {
  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "implementing",
      status: "merged",
      resolution: "merged"
    })),
    [{ type: "WORKSTREAM_MERGED" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "planning",
      status: "closed",
      resolution: "closed"
    })),
    [{ type: "WORKSTREAM_CLOSED" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "planning",
      activePullRequestLabels: ["agent-review"]
    })),
    [{ type: "ACTIVE_PR_REVIEW_REQUEST_OBSERVED" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "planning",
      activePullRequestLabels: ["agent-plan-approved"],
      activeWorktreeStatus: "awaiting_plan_approval"
    })),
    [{ type: "ACTIVE_PR_PLAN_APPROVAL_OBSERVED" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "planning",
      activePullRequestLabels: ["agent-plan-approved"],
      activeWorktreeStatus: "planning"
    })),
    [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: "planning" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "product_discovery",
      attentionReasons: ["product_approval_observed"]
    })),
    [{ type: "PRODUCT_APPROVAL_OBSERVED" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "product_specification",
      attentionReasons: ["product_approval_observed"],
      activeWorktreeStatus: "product_specification"
    })),
    [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: "product_specification" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "planning",
      attentionReasons: ["product_approval_observed"],
      activePullRequestLabels: ["agent-plan-approved"],
      activeWorktreeStatus: "implementation_ready"
    })),
    [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: "implementation_ready" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "issue_waiting",
      activePullRequestLabels: ["agent-in-progress"]
    })),
    [{ type: "ACTIVE_PR_PLANNING_LABEL_OBSERVED" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "issue_waiting",
      activeWorktreeStatus: "planning"
    })),
    [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: "planning" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "implementation_ready",
      activeWorktreeStatus: "implementing"
    })),
    [{ type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: "implementing" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "implementing",
      attentionReasons: ["cancel_requested"]
    })),
    [{ type: "CANCEL" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "planning",
      attentionReasons: ["retry_requested"]
    })),
    [{ type: "RETRY" }]
  );
});

test("evaluateWorkstreamMachine handles CANCEL and RETRY events", () => {
  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "implementing",
      attentionReasons: ["cancel_requested"]
    })),
    "abandoned"
  );

  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "planning",
      attentionReasons: ["retry_requested"]
    })),
    "product_discovery"
  );

  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "product_discovery",
      attentionReasons: ["retry_requested"]
    })),
    "product_discovery"
  );

  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "product_specification",
      attentionReasons: ["retry_requested", "product_approval_observed"]
    })),
    "product_specification"
  );

  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "planning",
      issuePresent: false,
      attentionReasons: ["retry_requested"]
    })),
    "planning"
  );

  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "abandoned",
      attentionReasons: ["retry_requested"]
    })),
    "product_discovery"
  );
});

test("deriveWorkstreamMachineEvents emits contextual feedback and non-phase comment attention", () => {
  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "planning",
      activeWorktreeStatus: "planning",
      attentionReasons: ["issue_comment_added"]
    })),
    [{ type: "PLANNING_FEEDBACK_OBSERVED", source: "issue_comment" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "implementing",
      activeWorktreeStatus: "implementing",
      attentionReasons: ["pr_comment_edited"]
    })),
    [{ type: "IMPLEMENTATION_FEEDBACK_OBSERVED", source: "pr_comment" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "issue_triage",
      attentionReasons: ["issue_comment_added"]
    })),
    [
      { type: "WORKSTREAM_COMMENT_ATTENTION_OBSERVED", source: "issue_comment" },
      { type: "NO_PHASE_SIGNAL_OBSERVED" }
    ]
  );
});

test("comment attention without active implementation signal stays out of implementation feedback", () => {
  const input = phaseInput({
    previousPhase: "implementing",
    originType: "pr",
    issuePresent: false,
    activePullRequestState: "open",
    activePullRequestLabels: [],
    attentionReasons: ["pr_comment_added"],
    activeWorktreeStatus: undefined
  });
  const events = deriveWorkstreamMachineEvents(input);

  assert.deepEqual(events, [
    { type: "WORKSTREAM_COMMENT_ATTENTION_OBSERVED", source: "pr_comment" },
    { type: "NO_PHASE_SIGNAL_OBSERVED" }
  ]);
  assert.equal(
    events.some((event) => event.type === "IMPLEMENTATION_FEEDBACK_OBSERVED"),
    false
  );
  assert.equal(reduceWorkstreamPhase(input), "implementing");
  assert.equal(evaluateWorkstreamMachine(input), "implementing");
});

test("deriveWorkstreamMachineEvents emits initialization and fallback events", () => {
  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput()),
    [
      { type: "WORKSTREAM_INITIALIZED" },
      { type: "NO_PHASE_SIGNAL_OBSERVED" }
    ]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "issue_triage"
    })),
    [{ type: "NO_PHASE_SIGNAL_OBSERVED" }]
  );
});

test("deriveWorkstreamMachineEvents only uses selected active PR and worktree projection", () => {
  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "planning",
      // Non-selected linked PR labels are intentionally absent from this selected projection.
      activePullRequestLabels: [],
      attentionReasons: ["plan_approved"]
    })),
    [{ type: "NO_PHASE_SIGNAL_OBSERVED" }]
  );

  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "issue_waiting",
      // Non-selected linked worktree statuses are intentionally absent from this selected projection.
      activeWorktreeStatus: undefined
    })),
    [{ type: "NO_PHASE_SIGNAL_OBSERVED" }]
  );
});

test("evaluateWorkstreamMachine applies derived events through XState transitions", () => {
  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "issue_waiting",
      activeWorktreeStatus: "planning"
    })),
    "planning"
  );

  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "planning",
      activePullRequestLabels: ["agent-plan-approved"],
      activeWorktreeStatus: "awaiting_plan_approval"
    })),
    "implementation_ready"
  );
});

test("contextualFeedbackReceived event transitions", () => {
  // Test derivation
  assert.deepEqual(
    deriveWorkstreamMachineEvents(phaseInput({
      previousPhase: "planning",
      activeWorktreeStatus: "planning",
      attentionReasons: ["contextual_feedback_received"]
    })),
    [
      { type: "ACTIVE_WORKTREE_STATUS_OBSERVED", status: "planning" },
      { type: "contextualFeedbackReceived" }
    ]
  );

  // Test transitions in machine
  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "planning",
      activeWorktreeStatus: "planning",
      attentionReasons: ["contextual_feedback_received"]
    })),
    "plan_feedback"
  );

  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "implementing",
      activeWorktreeStatus: "implementing",
      attentionReasons: ["contextual_feedback_received"]
    })),
    "implementation_feedback"
  );

  assert.equal(
    evaluateWorkstreamMachine(phaseInput({
      previousPhase: "implementation_ready",
      activeWorktreeStatus: "implementing",
      attentionReasons: ["contextual_feedback_received"]
    })),
    "implementation_feedback"
  );

  // Test no-phase signal behavior
  const inputWithContextual = phaseInput({
    previousPhase: "issue_triage",
    attentionReasons: ["contextual_feedback_received"]
  });
  const events = deriveWorkstreamMachineEvents(inputWithContextual);
  assert.ok(events.some(e => e.type === "contextualFeedbackReceived"));
  assert.ok(events.some(e => e.type === "NO_PHASE_SIGNAL_OBSERVED"));
});

test("reduceWorkstreamPhase transitions back from implementation phases on NO_PHASE_SIGNAL_OBSERVED", () => {
  // 1. From implementation_ready to issue_waiting
  assert.equal(
    reduceWorkstreamPhase(
      phaseInput({
        previousPhase: "implementation_ready",
        activePullRequestState: undefined,
        activePullRequestLabels: [],
        activeWorktreeStatus: undefined
      })
    ),
    "issue_waiting"
  );

  // 2. From implementing to issue_waiting
  assert.equal(
    reduceWorkstreamPhase(
      phaseInput({
        previousPhase: "implementing",
        activePullRequestState: undefined,
        activePullRequestLabels: [],
        activeWorktreeStatus: undefined
      })
    ),
    "issue_waiting"
  );

  // 3. From implementation_done to issue_waiting
  assert.equal(
    reduceWorkstreamPhase(
      phaseInput({
        previousPhase: "implementation_done",
        activePullRequestState: undefined,
        activePullRequestLabels: [],
        activeWorktreeStatus: undefined
      })
    ),
    "issue_waiting"
  );
});

test("reduceWorkstreamPhase transitions back to planning from implementation phases on planning signals", () => {
  // 1. From implementation_done to planning via active PR planning label
  assert.equal(
    reduceWorkstreamPhase(
      phaseInput({
        previousPhase: "implementation_done",
        activePullRequestState: "open",
        activePullRequestLabels: ["agent-in-progress"]
      })
    ),
    "planning"
  );

  // 2. From implementation_done to planning via planning worktree status
  assert.equal(
    reduceWorkstreamPhase(
      phaseInput({
        previousPhase: "implementation_done",
        activeWorktreeStatus: "planning"
      })
    ),
    "planning"
  );
});
