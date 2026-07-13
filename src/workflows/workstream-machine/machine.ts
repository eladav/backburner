import { setup } from "xstate";
import { WORKSTREAM_PHASES, type WorkstreamPhase } from "../../state/types.js";
import type { WorkstreamMachineEvent } from "./events.js";
import type { WorkstreamMachineContext } from "./types.js";

type WorkstreamMachineGuard =
  | "noReviewRequestObserved"
  | "noReviewRequestAndObservedImplementationDoneWorktree"
  | "noReviewRequestAndObservedImplementingWorktree"
  | "noReviewRequestAndObservedImplementationReadyWorktree"
  | "noReviewRequestAndObservedPlanningWorktree"
  | "noReviewRequestAndObservedPlanningFallbackWorktree"
  | "noReviewRequestAndObservedPriorPullRequestImplementationFallbackWorktree"
  | "observedImplementationDoneWorktree"
  | "observedImplementingWorktree"
  | "observedImplementationReadyWorktree"
  | "observedPlanningWorktree"
  | "observedPlanningFallbackWorktree"
  | "observedProductSpecificationWorktree"
  | "observedPriorPullRequestImplementationFallbackWorktree"
  | "observedCurrentImplementationFeedback"
  | "observedPullRequestPriorImplementationFeedback"
  | "shouldInitializeIssueTriage"
  | "shouldInitializeProductDiscovery"
  | "shouldInitializeProductSpecification"
  | "shouldFallbackToIssueWaiting"
  | "shouldInitializePullRequestReview";

type WorkstreamMachineTransition = {
  target?: WorkstreamPhase;
  guard?: { type: WorkstreamMachineGuard };
};

type WorkstreamMachineStateConfig = Record<
  WorkstreamPhase,
  {
    on?: Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition | WorkstreamMachineTransition[]>>;
  }
>;

const terminalTransitions = {
  WORKSTREAM_MERGED: { target: "resolved" },
  WORKSTREAM_CLOSED: { target: "abandoned" },
  CANCEL: { target: "abandoned" }
} satisfies Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition>>;

const retryTransitions = {
  RETRY: [
    { target: "product_specification", guard: guard("shouldInitializeProductSpecification") },
    { target: "product_discovery", guard: guard("shouldInitializeProductDiscovery") },
    { target: "issue_triage", guard: guard("shouldInitializeIssueTriage") },
    { target: "issue_waiting", guard: guard("shouldFallbackToIssueWaiting") }
  ]
} satisfies Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition | WorkstreamMachineTransition[]>>;

const activePrTransitions = {
  ACTIVE_PR_REVIEW_REQUEST_OBSERVED: { target: "pr_review" },
  ACTIVE_PR_PLAN_APPROVAL_OBSERVED: { target: "implementation_ready" },
  ACTIVE_PR_PLANNING_LABEL_OBSERVED: { target: "planning" }
} satisfies Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition>>;

const planningPrTransitions = {
  ACTIVE_PR_REVIEW_REQUEST_OBSERVED: { target: "pr_review" },
  ACTIVE_PR_PLAN_APPROVAL_OBSERVED: { target: "implementation_ready" },
  ACTIVE_PR_PLANNING_LABEL_OBSERVED: { target: "planning" }
} satisfies Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition>>;

const implementationPrTransitions = {
  ACTIVE_PR_REVIEW_REQUEST_OBSERVED: { target: "pr_review" },
  ACTIVE_PR_PLAN_APPROVAL_OBSERVED: { target: "implementation_ready" }
} satisfies Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition>>;

const activeWorktreeStatusTransitions = [
  { target: "implementation_done", guard: guard("observedImplementationDoneWorktree") },
  { target: "implementing", guard: guard("observedImplementingWorktree") },
  { target: "implementation_ready", guard: guard("observedImplementationReadyWorktree") },
  { target: "product_specification", guard: guard("observedProductSpecificationWorktree") },
  { target: "planning", guard: guard("observedPlanningWorktree") }
] satisfies WorkstreamMachineTransition[];

const planningStatusTransitions = [
  ...activeWorktreeStatusTransitions,
  { target: "implementing", guard: guard("observedPriorPullRequestImplementationFallbackWorktree") },
  { target: "planning", guard: guard("observedPlanningFallbackWorktree") }
] satisfies WorkstreamMachineTransition[];

const implementationStatusTransitions = [
  ...activeWorktreeStatusTransitions,
  { target: "implementing", guard: guard("observedPriorPullRequestImplementationFallbackWorktree") },
  { target: "planning", guard: guard("observedPlanningFallbackWorktree") }
] satisfies WorkstreamMachineTransition[];

const baseWorkstreamTransitions = {
  ...terminalTransitions,
  ...retryTransitions,
  ...activePrTransitions,
  ACTIVE_WORKTREE_STATUS_OBSERVED: planningStatusTransitions,
  PLANNING_FEEDBACK_OBSERVED: { target: "plan_feedback" },
  IMPLEMENTATION_FEEDBACK_OBSERVED: { target: "implementation_feedback" },
  contextualFeedbackReceived: [
    { target: "plan_feedback", guard: guard("observedPlanningWorktree") },
    { target: "implementation_feedback", guard: guard("observedImplementingWorktree") },
    { target: "implementation_feedback", guard: guard("observedPullRequestPriorImplementationFeedback") }
  ],
  NO_PHASE_SIGNAL_OBSERVED: [
    { target: "product_specification", guard: guard("shouldInitializeProductSpecification") },
    { target: "product_discovery", guard: guard("shouldInitializeProductDiscovery") },
    { target: "issue_triage", guard: guard("shouldInitializeIssueTriage") },
    { target: "issue_waiting", guard: guard("shouldFallbackToIssueWaiting") },
    { target: "pr_review", guard: guard("shouldInitializePullRequestReview") }
  ]
} satisfies Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition | WorkstreamMachineTransition[]>>;

const implementationWorkstreamTransitions = {
  ...terminalTransitions,
  ...retryTransitions,
  ...implementationPrTransitions,
  ACTIVE_WORKTREE_STATUS_OBSERVED: implementationStatusTransitions,
  PLANNING_FEEDBACK_OBSERVED: { target: "plan_feedback" },
  IMPLEMENTATION_FEEDBACK_OBSERVED: [
    { target: "implementation_feedback", guard: guard("observedCurrentImplementationFeedback") },
    { target: "implementation_feedback", guard: guard("observedPullRequestPriorImplementationFeedback") }
  ],
  contextualFeedbackReceived: [
    { target: "implementation_feedback", guard: guard("observedImplementingWorktree") },
    { target: "implementation_feedback", guard: guard("observedPullRequestPriorImplementationFeedback") },
    { target: "plan_feedback", guard: guard("observedPlanningWorktree") }
  ],
  NO_PHASE_SIGNAL_OBSERVED: baseWorkstreamTransitions.NO_PHASE_SIGNAL_OBSERVED
} satisfies Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition | WorkstreamMachineTransition[]>>;

const implementationReadyTransitions = {
  ...terminalTransitions,
  ...retryTransitions,
  ACTIVE_PR_REVIEW_REQUEST_OBSERVED: { target: "pr_review" },
  ACTIVE_PR_PLANNING_LABEL_OBSERVED: { target: "planning" },
  ACTIVE_WORKTREE_STATUS_OBSERVED: [
    { target: "implementation_done", guard: guard("observedImplementationDoneWorktree") },
    { target: "implementing", guard: guard("observedImplementingWorktree") },
    { target: "implementation_ready", guard: guard("observedImplementationReadyWorktree") },
    { target: "planning", guard: guard("observedPlanningWorktree") }
  ],
  contextualFeedbackReceived: [
    { target: "implementation_feedback", guard: guard("observedImplementingWorktree") },
    { target: "implementation_feedback", guard: guard("observedPullRequestPriorImplementationFeedback") },
    { target: "plan_feedback", guard: guard("observedPlanningWorktree") }
  ],
  NO_PHASE_SIGNAL_OBSERVED: baseWorkstreamTransitions.NO_PHASE_SIGNAL_OBSERVED
} satisfies Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition | WorkstreamMachineTransition[]>>;

const implementationDoneTransitions = {
  ...terminalTransitions,
  ACTIVE_PR_REVIEW_REQUEST_OBSERVED: { target: "pr_review" },
  ACTIVE_PR_PLANNING_LABEL_OBSERVED: { target: "planning" },
  ACTIVE_WORKTREE_STATUS_OBSERVED: [
    { target: "implementation_done", guard: guard("observedImplementationDoneWorktree") },
    { target: "implementing", guard: guard("observedImplementingWorktree") },
    { target: "implementation_ready", guard: guard("observedImplementationReadyWorktree") },
    { target: "planning", guard: guard("observedPlanningWorktree") }
  ],
  IMPLEMENTATION_FEEDBACK_OBSERVED: [
    { target: "implementation_feedback", guard: guard("observedCurrentImplementationFeedback") },
    { target: "implementation_feedback", guard: guard("observedPullRequestPriorImplementationFeedback") }
  ],
  contextualFeedbackReceived: [
    { target: "implementation_feedback", guard: guard("observedImplementingWorktree") },
    { target: "implementation_feedback", guard: guard("observedPullRequestPriorImplementationFeedback") },
    { target: "plan_feedback", guard: guard("observedPlanningWorktree") }
  ],
  NO_PHASE_SIGNAL_OBSERVED: baseWorkstreamTransitions.NO_PHASE_SIGNAL_OBSERVED
} satisfies Partial<Record<WorkstreamMachineEvent["type"], WorkstreamMachineTransition | WorkstreamMachineTransition[]>>;

const states = {
  product_discovery: {
    on: {
      ...terminalTransitions,
      ...retryTransitions,
      PRODUCT_APPROVAL_OBSERVED: { target: "product_specification" },
      ACTIVE_WORKTREE_STATUS_OBSERVED: [
        { target: "product_specification", guard: guard("observedProductSpecificationWorktree") },
        { target: "planning", guard: guard("observedPlanningWorktree") }
      ],
      WORKSTREAM_INITIALIZED: [
        { target: "product_specification", guard: guard("shouldInitializeProductSpecification") },
        { target: "product_discovery", guard: guard("shouldInitializeProductDiscovery") },
        { target: "pr_review", guard: guard("shouldInitializePullRequestReview") }
      ],
      NO_PHASE_SIGNAL_OBSERVED: [
        { target: "product_specification", guard: guard("shouldInitializeProductSpecification") },
        { target: "product_discovery", guard: guard("shouldInitializeProductDiscovery") },
        { target: "issue_waiting", guard: guard("shouldFallbackToIssueWaiting") }
      ]
    }
  },
  product_specification: {
    on: {
      ...terminalTransitions,
      ...retryTransitions,
      ACTIVE_WORKTREE_STATUS_OBSERVED: [
        { target: "product_specification", guard: guard("observedProductSpecificationWorktree") },
        { target: "planning", guard: guard("observedPlanningWorktree") }
      ],
      ACTIVE_PR_PLANNING_LABEL_OBSERVED: { target: "planning" },
      NO_PHASE_SIGNAL_OBSERVED: baseWorkstreamTransitions.NO_PHASE_SIGNAL_OBSERVED
    }
  },
  issue_triage: {
    on: {
      ...baseWorkstreamTransitions,
      WORKSTREAM_INITIALIZED: [
        { target: "product_specification", guard: guard("shouldInitializeProductSpecification") },
        { target: "product_discovery", guard: guard("shouldInitializeProductDiscovery") },
        { target: "issue_triage", guard: guard("shouldInitializeIssueTriage") },
        { target: "pr_review", guard: guard("shouldInitializePullRequestReview") }
      ]
    }
  },
  issue_waiting: {
    on: baseWorkstreamTransitions
  },
  planning: {
    on: {
      ...terminalTransitions,
      ...retryTransitions,
      ...planningPrTransitions,
      ACTIVE_WORKTREE_STATUS_OBSERVED: planningStatusTransitions,
      PLANNING_FEEDBACK_OBSERVED: { target: "plan_feedback" },
      IMPLEMENTATION_FEEDBACK_OBSERVED: { target: "implementation_feedback" },
      contextualFeedbackReceived: baseWorkstreamTransitions.contextualFeedbackReceived,
      NO_PHASE_SIGNAL_OBSERVED: baseWorkstreamTransitions.NO_PHASE_SIGNAL_OBSERVED
    }
  },
  plan_feedback: {
    on: {
      ...terminalTransitions,
      ...retryTransitions,
      ...planningPrTransitions,
      ACTIVE_WORKTREE_STATUS_OBSERVED: planningStatusTransitions,
      PLANNING_FEEDBACK_OBSERVED: { target: "plan_feedback" },
      IMPLEMENTATION_FEEDBACK_OBSERVED: { target: "implementation_feedback" },
      contextualFeedbackReceived: baseWorkstreamTransitions.contextualFeedbackReceived,
      NO_PHASE_SIGNAL_OBSERVED: baseWorkstreamTransitions.NO_PHASE_SIGNAL_OBSERVED
    }
  },
  implementation_ready: {
    on: implementationReadyTransitions
  },
  implementing: {
    on: implementationWorkstreamTransitions
  },
  implementation_done: {
    on: implementationDoneTransitions
  },
  implementation_feedback: {
    on: implementationWorkstreamTransitions
  },
  pr_review: {
    on: {
      ...terminalTransitions,
      ...retryTransitions,
      ACTIVE_PR_REVIEW_REQUEST_OBSERVED: { target: "pr_review" },
      ACTIVE_PR_PLAN_APPROVAL_OBSERVED: guarded("implementation_ready", "noReviewRequestObserved"),
      ACTIVE_PR_PLANNING_LABEL_OBSERVED: guarded("planning", "noReviewRequestObserved"),
      ACTIVE_WORKTREE_STATUS_OBSERVED: [
        { target: "implementation_done", guard: guard("noReviewRequestAndObservedImplementationDoneWorktree") },
        { target: "implementing", guard: guard("noReviewRequestAndObservedImplementingWorktree") },
        { target: "implementation_ready", guard: guard("noReviewRequestAndObservedImplementationReadyWorktree") },
        { target: "planning", guard: guard("noReviewRequestAndObservedPlanningWorktree") },
        {
          target: "implementing",
          guard: guard("noReviewRequestAndObservedPriorPullRequestImplementationFallbackWorktree")
        },
        { target: "planning", guard: guard("noReviewRequestAndObservedPlanningFallbackWorktree") }
      ],
      PLANNING_FEEDBACK_OBSERVED: guarded("plan_feedback", "noReviewRequestObserved"),
      IMPLEMENTATION_FEEDBACK_OBSERVED: guarded("implementation_feedback", "noReviewRequestObserved"),
      contextualFeedbackReceived: [
        {
          target: "plan_feedback",
          guard: guard("noReviewRequestAndObservedPlanningWorktree")
        },
        {
          target: "implementation_feedback",
          guard: guard("noReviewRequestAndObservedImplementingWorktree")
        },
        {
          target: "implementation_feedback",
          guard: guard("noReviewRequestAndObservedPriorPullRequestImplementationFallbackWorktree")
        }
      ],
      NO_PHASE_SIGNAL_OBSERVED: baseWorkstreamTransitions.NO_PHASE_SIGNAL_OBSERVED
    }
  },
  resolved: {
    on: {
      WORKSTREAM_MERGED: { target: "resolved" },
      NO_PHASE_SIGNAL_OBSERVED: baseWorkstreamTransitions.NO_PHASE_SIGNAL_OBSERVED
    }
  },
  abandoned: {
    on: {
      ...retryTransitions,
      WORKSTREAM_MERGED: { target: "resolved" },
      WORKSTREAM_CLOSED: { target: "abandoned" },
      NO_PHASE_SIGNAL_OBSERVED: baseWorkstreamTransitions.NO_PHASE_SIGNAL_OBSERVED
    }
  }
} satisfies WorkstreamMachineStateConfig;

assertWorkstreamPhaseStateAlignment(states);

// XState owns phase transitions. Task derivation remains a separate downstream
// concern and must not be hidden in transition actions. Future team/process
// state should be modeled separately from this current single-phase model.
export const workstreamMachine = setup({
  types: {
    context: {} as WorkstreamMachineContext,
    events: {} as WorkstreamMachineEvent,
    input: {} as WorkstreamMachineContext
  },
  guards: {
    noReviewRequestObserved: ({ context }) =>
      !isReviewRequested(context),
    noReviewRequestAndObservedImplementationDoneWorktree: ({ context, event }) =>
      !isReviewRequested(context) &&
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" &&
      event.status === "implementation_done",
    noReviewRequestAndObservedImplementingWorktree: ({ context, event }) =>
      !isReviewRequested(context) &&
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" &&
      event.status === "implementing",
    noReviewRequestAndObservedImplementationReadyWorktree: ({ context, event }) =>
      !isReviewRequested(context) &&
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" &&
      event.status === "implementation_ready",
    noReviewRequestAndObservedPlanningWorktree: ({ context, event }) =>
      !isReviewRequested(context) &&
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" &&
      (event.status === "planning" || event.status === "awaiting_plan_approval"),
    noReviewRequestAndObservedPlanningFallbackWorktree: ({ context, event }) =>
      !isReviewRequested(context) &&
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" &&
      !isPriorPullRequestImplementationFallback(context),
    noReviewRequestAndObservedPriorPullRequestImplementationFallbackWorktree: ({ context, event }) =>
      !isReviewRequested(context) &&
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" &&
      isPriorPullRequestImplementationFallback(context),
    observedImplementationDoneWorktree: ({ event }) =>
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" && event.status === "implementation_done",
    observedImplementingWorktree: ({ event }) =>
      (event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" && event.status === "implementing") ||
      event.type === "contextualFeedbackReceived",
    observedImplementationReadyWorktree: ({ event }) =>
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" && event.status === "implementation_ready",
    observedProductSpecificationWorktree: ({ event }) =>
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" && event.status === "product_specification",
    observedPlanningWorktree: ({ event }) =>
      (event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" &&
        (event.status === "planning" || event.status === "awaiting_plan_approval")) ||
      event.type === "contextualFeedbackReceived",
    observedPlanningFallbackWorktree: ({ context, event }) =>
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" &&
      !isPriorPullRequestImplementationFallback(context),
    observedPriorPullRequestImplementationFallbackWorktree: ({ context, event }) =>
      event.type === "ACTIVE_WORKTREE_STATUS_OBSERVED" &&
      isPriorPullRequestImplementationFallback(context),
    observedCurrentImplementationFeedback: ({ context, event }) =>
      event.type === "IMPLEMENTATION_FEEDBACK_OBSERVED" &&
      (context.activeWorktreeStatus === "implementing" ||
        context.activeWorktreeStatus === "implementation_done"),
    observedPullRequestPriorImplementationFeedback: ({ context, event }) =>
      event.type === "IMPLEMENTATION_FEEDBACK_OBSERVED" &&
      isPriorPullRequestImplementationFallback(context),
    shouldInitializeIssueTriage: ({ context }) =>
      context.originType === "issue" &&
      context.issuePresent &&
      (
        context.previousPhase === undefined ||
        context.attentionReasons.includes("new_issue")
      ),
    shouldInitializeProductDiscovery: ({ context }) =>
      context.originType === "issue" &&
      context.issuePresent &&
      !context.attentionReasons.includes("product_approval_observed") &&
      (
        context.previousPhase === undefined ||
        context.attentionReasons.includes("retry_requested") ||
        context.previousPhase === "product_discovery" ||
        context.previousPhase === "issue_triage" ||
        context.previousPhase === "issue_waiting"
      ),
    shouldInitializeProductSpecification: ({ context }) =>
      context.originType === "issue" &&
      context.issuePresent &&
      context.attentionReasons.includes("product_approval_observed"),
    shouldFallbackToIssueWaiting: ({ context }) =>
      context.originType === "issue" &&
      (context.issuePresent || context.previousPhase === undefined),
    shouldInitializePullRequestReview: ({ context }) =>
      context.originType === "pr" && context.previousPhase === undefined
  }
}).createMachine({
  id: "workstream",
  initial: "issue_triage",
  context: ({ input }: { input: WorkstreamMachineContext }) => input,
  states
});

function assertWorkstreamPhaseStateAlignment(machineStates: WorkstreamMachineStateConfig): void {
  const machineStateNames = Object.keys(machineStates).sort();
  const phaseNames = [...WORKSTREAM_PHASES].sort();

  if (
    machineStateNames.length !== phaseNames.length ||
    machineStateNames.some((stateName, index) => stateName !== phaseNames[index])
  ) {
    throw new Error("workstreamMachine states must exactly match WorkstreamPhase values");
  }
}

function guard(type: WorkstreamMachineGuard): { type: WorkstreamMachineGuard } {
  return { type };
}

function guarded(target: WorkstreamPhase, guardType: WorkstreamMachineGuard): WorkstreamMachineTransition {
  return { target, guard: guard(guardType) };
}

function isPriorPullRequestImplementationFallback(context: WorkstreamMachineContext): boolean {
  return (
    context.originType === "pr" &&
    context.activeWorktreeStatus !== undefined &&
    (
      context.previousPhase === "implementation_ready" ||
      context.previousPhase === "implementing" ||
      context.previousPhase === "implementation_done" ||
      context.previousPhase === "implementation_feedback"
    )
  );
}

function isReviewRequested(context: WorkstreamMachineContext): boolean {
  return context.reviewLabel !== undefined && context.activePullRequestLabels.includes(context.reviewLabel);
}
