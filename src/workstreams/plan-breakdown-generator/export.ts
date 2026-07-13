import { PlanBreakdownResult, PlanBreakdownSession, ValidationIssue } from "./types.js";
import { validateSession } from "./validate.js";

export function exportSession(session: PlanBreakdownSession): PlanBreakdownResult {
  const issues: ValidationIssue[] = [...session.validationIssues, ...validateSession(session)];
  const errors = issues.filter((i) => i.severity === "error");

  if (errors.length > 0) {
    throw new Error(`Cannot export invalid session: ${errors.map((e) => e.message).join("; ")}`);
  }

  return {
    title: session.title,
    summary: session.summary,
    tasks: Object.values(session.tasks),
    waves: session.waveOrder.map((id) => session.waves[id]!),
    recommendedFirstWaveId: session.recommendedFirstWaveId,
    graphConcerns: session.graphConcerns,
    humanDecisionsNeeded: session.humanDecisionsNeeded,
    suggestedNextAction: session.suggestedNextAction,
    validationIssues: issues.length > 0 ? issues : undefined
  };
}
