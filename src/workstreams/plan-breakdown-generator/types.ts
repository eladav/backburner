import type {
  PlanBreakdownResult,
  PlanBreakdownTaskResult,
  PlanBreakdownWaveResult,
  ValidationIssue
} from "../../state/types.js";

export type GeneratorTask = PlanBreakdownTaskResult;
export type GeneratorWave = PlanBreakdownWaveResult;

export interface PlanBreakdownSession {
  id: string;
  title: string;
  summary: string;
  tasks: Record<string, GeneratorTask>;
  waves: Record<string, GeneratorWave>;
  waveOrder: string[]; // Ordered list of wave IDs
  recommendedFirstWaveId: string;
  graphConcerns: string[];
  humanDecisionsNeeded: string[];
  suggestedNextAction: string;
  createdAt: string;
  updatedAt: string;
  validationIssues: ValidationIssue[];
}

export type PatchOperation =
  | { op: "set-title"; value: string }
  | { op: "set-summary"; value: string }
  | { op: "add-task"; task: GeneratorTask }
  | { op: "update-task"; id: string; patch: Partial<Omit<GeneratorTask, "id">> }
  | { op: "remove-task"; id: string }
  | { op: "add-wave"; wave: GeneratorWave; index?: number }
  | { op: "update-wave"; id: string; patch: Partial<Omit<GeneratorWave, "id">> }
  | { op: "remove-wave"; id: string }
  | { op: "reorder-waves"; waveIds: string[] }
  | { op: "set-recommended-first-wave"; id: string }
  | { op: "add-graph-concern"; value: string }
  | { op: "remove-graph-concern"; index: number }
  | { op: "add-human-decision"; value: string }
  | { op: "remove-human-decision"; index: number }
  | { op: "set-suggested-next-action"; value: string };

export interface InspectionOutput {
  sessionId: string;
  title: string;
  summary: string;
  taskCount: number;
  waveCount: number;
  tasks: {
    id: string;
    title: string;
    waveId?: string | undefined;
    dependencies: string[];
    validationIssues: ValidationIssue[];
  }[];
  waves: {
    id: string;
    taskIds: string[];
    validationIssues: ValidationIssue[];
  }[];
  validationIssues: ValidationIssue[];
  isValid: boolean;
}

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export { PlanBreakdownResult, ValidationIssue };
