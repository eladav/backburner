import { randomUUID } from "node:crypto";

export const WAVE_ASSESSMENT_DECISIONS = ["continue", "replan", "blocked"] as const;
export type WaveAssessmentDecision = (typeof WAVE_ASSESSMENT_DECISIONS)[number];

export const WAVE_ASSESSMENT_FINDING_CATEGORIES = [
  "correctness",
  "completeness",
  "drift",
  "invalid_assumption"
] as const;
export type WaveAssessmentFindingCategory =
  (typeof WAVE_ASSESSMENT_FINDING_CATEGORIES)[number];

export interface WaveAssessmentFinding {
  id: string;
  category: WaveAssessmentFindingCategory;
  summary: string;
  details: string;
  affectedPlanNodeIds: string[];
  createdAt: string;
}

export interface WaveAssessmentSessionIdentity {
  workstreamId: string;
  waveId: string;
  parentPrNumber: number;
  assessedParentHeadSha: string;
  originalPlanningSessionId: string;
  currentPlanRevision: string;
  planNodeIds: string[];
}

export interface WaveAssessmentCurrentIdentity {
  workstreamId?: string;
  waveId?: string;
  parentPrNumber?: number;
  parentHeadSha?: string;
  planRevision?: string;
}

export interface WaveAssessmentValidationIssue {
  severity: "error";
  code:
    | "missing-summary"
    | "missing-findings-for-replan"
    | "unknown-node-reference"
    | "stale-workstream"
    | "stale-wave"
    | "stale-parent-pr"
    | "stale-parent-head"
    | "stale-plan-revision";
  message: string;
  path?: string[];
}

export interface WaveAssessmentSession extends WaveAssessmentSessionIdentity {
  sessionId: string;
  status: "open" | "completed";
  decision?: WaveAssessmentDecision;
  summary: string;
  findings: WaveAssessmentFinding[];
  validationIssues: WaveAssessmentValidationIssue[];
  timestamps: {
    createdAt: string;
    updatedAt: string;
    finalizedAt?: string;
  };
}

export interface WaveAssessmentResult {
  sessionId: string;
  workstreamId: string;
  waveId: string;
  parentPrNumber: number;
  assessedParentHeadSha: string;
  originalPlanningSessionId: string;
  currentPlanRevision: string;
  planNodeIds: string[];
  decision: WaveAssessmentDecision;
  summary: string;
  findings: WaveAssessmentFinding[];
  timestamps: {
    createdAt: string;
    finalizedAt: string;
  };
}

export interface CreateWaveAssessmentSessionInput extends WaveAssessmentSessionIdentity {
  sessionId: string;
}

export function createWaveAssessmentSession(
  input: CreateWaveAssessmentSessionInput
): WaveAssessmentSession {
  const now = new Date().toISOString();
  return {
    ...input,
    planNodeIds: [...input.planNodeIds],
    sessionId: input.sessionId,
    status: "open",
    summary: "",
    findings: [],
    validationIssues: [],
    timestamps: {
      createdAt: now,
      updatedAt: now
    }
  };
}

export function addWaveAssessmentFinding(
  session: WaveAssessmentSession,
  input: {
    category: WaveAssessmentFindingCategory;
    summary: string;
    details: string;
    affectedPlanNodeIds: string[];
  }
): WaveAssessmentSession {
  const now = new Date().toISOString();
  return {
    ...session,
    status: "open",
    findings: [
      ...session.findings,
      {
        id: randomUUID(),
        category: input.category,
        summary: input.summary,
        details: input.details,
        affectedPlanNodeIds: [...input.affectedPlanNodeIds],
        createdAt: now
      }
    ],
    validationIssues: [],
    timestamps: {
      ...session.timestamps,
      updatedAt: now
    }
  };
}

export function completeWaveAssessmentSession(
  session: WaveAssessmentSession,
  input: {
    decision: WaveAssessmentDecision;
    summary: string;
  }
): WaveAssessmentSession {
  const now = new Date().toISOString();
  return {
    ...session,
    status: "completed",
    decision: input.decision,
    summary: input.summary,
    validationIssues: [],
    timestamps: {
      ...session.timestamps,
      updatedAt: now,
      finalizedAt: now
    }
  };
}

export function exportWaveAssessmentSession(
  session: WaveAssessmentSession
): WaveAssessmentResult {
  if (session.status !== "completed" || !session.decision || !session.timestamps.finalizedAt) {
    throw new Error(`Wave assessment session ${session.sessionId} is not completed`);
  }

  return {
    sessionId: session.sessionId,
    workstreamId: session.workstreamId,
    waveId: session.waveId,
    parentPrNumber: session.parentPrNumber,
    assessedParentHeadSha: session.assessedParentHeadSha,
    originalPlanningSessionId: session.originalPlanningSessionId,
    currentPlanRevision: session.currentPlanRevision,
    planNodeIds: [...session.planNodeIds],
    decision: session.decision,
    summary: session.summary,
    findings: session.findings,
    timestamps: {
      createdAt: session.timestamps.createdAt,
      finalizedAt: session.timestamps.finalizedAt
    }
  };
}
