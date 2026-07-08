import { PlanBreakdownSession } from "./types.js";
import { randomUUID } from "node:crypto";

export function createSession(options?: {
  id?: string;
  title?: string;
  summary?: string;
}): PlanBreakdownSession {
  const now = new Date().toISOString();
  return {
    id: options?.id ?? randomUUID(),
    title: options?.title ?? "",
    summary: options?.summary ?? "",
    tasks: {},
    waves: {},
    waveOrder: [],
    recommendedFirstWaveId: "",
    graphConcerns: [],
    humanDecisionsNeeded: [],
    suggestedNextAction: "",
    createdAt: now,
    updatedAt: now,
    validationIssues: []
  };
}
