import type {
  WaveAssessmentCurrentIdentity,
  WaveAssessmentDecision,
  WaveAssessmentSession,
  WaveAssessmentValidationIssue
} from "./session.js";

export function validateWaveAssessmentSession(
  session: WaveAssessmentSession,
  options?: {
    decision?: WaveAssessmentDecision;
    summary?: string;
    currentIdentity?: WaveAssessmentCurrentIdentity | undefined;
  }
): WaveAssessmentValidationIssue[] {
  const issues: WaveAssessmentValidationIssue[] = [];
  const decision = options?.decision ?? session.decision;
  const summary = options?.summary ?? session.summary;

  if (summary.trim() === "") {
    issues.push({
      severity: "error",
      code: "missing-summary",
      message: "A non-empty assessment summary is required.",
      path: ["summary"]
    });
  }

  if (decision === "replan" && session.findings.length === 0) {
    issues.push({
      severity: "error",
      code: "missing-findings-for-replan",
      message: "A replan decision requires at least one finding.",
      path: ["findings"]
    });
  }

  const knownPlanNodeIds = new Set(session.planNodeIds);
  session.findings.forEach((finding, findingIndex) => {
    finding.affectedPlanNodeIds.forEach((nodeId, nodeIndex) => {
      if (!knownPlanNodeIds.has(nodeId)) {
        issues.push({
          severity: "error",
          code: "unknown-node-reference",
          message: `Finding ${finding.id} references unknown plan node "${nodeId}".`,
          path: ["findings", String(findingIndex), "affectedPlanNodeIds", String(nodeIndex)]
        });
      }
    });
  });

  const currentIdentity = options?.currentIdentity;
  if (currentIdentity) {
    if (currentIdentity.workstreamId !== undefined && currentIdentity.workstreamId !== session.workstreamId) {
      issues.push({
        severity: "error",
        code: "stale-workstream",
        message: `Current workstream ${currentIdentity.workstreamId} does not match session workstream ${session.workstreamId}.`,
        path: ["currentIdentity", "workstreamId"]
      });
    }

    if (currentIdentity.waveId !== undefined && currentIdentity.waveId !== session.waveId) {
      issues.push({
        severity: "error",
        code: "stale-wave",
        message: `Current wave ${currentIdentity.waveId} does not match session wave ${session.waveId}.`,
        path: ["currentIdentity", "waveId"]
      });
    }

    if (currentIdentity.parentPrNumber !== undefined && currentIdentity.parentPrNumber !== session.parentPrNumber) {
      issues.push({
        severity: "error",
        code: "stale-parent-pr",
        message: `Current parent PR ${currentIdentity.parentPrNumber} does not match session parent PR ${session.parentPrNumber}.`,
        path: ["currentIdentity", "parentPrNumber"]
      });
    }

    if (currentIdentity.parentHeadSha !== undefined && currentIdentity.parentHeadSha !== session.assessedParentHeadSha) {
      issues.push({
        severity: "error",
        code: "stale-parent-head",
        message: `Current parent head ${currentIdentity.parentHeadSha} does not match assessed head ${session.assessedParentHeadSha}.`,
        path: ["currentIdentity", "parentHeadSha"]
      });
    }

    if (currentIdentity.planRevision !== undefined && currentIdentity.planRevision !== session.currentPlanRevision) {
      issues.push({
        severity: "error",
        code: "stale-plan-revision",
        message: `Current plan revision ${currentIdentity.planRevision} does not match session plan revision ${session.currentPlanRevision}.`,
        path: ["currentIdentity", "planRevision"]
      });
    }
  }

  return issues;
}
