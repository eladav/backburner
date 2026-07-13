import type { PlanBreakdownResult } from "../state/types.js";

export const PLAN_BREAKDOWN_JSON_CONTRACT = `Return exactly one JSON object matching this structure:
{
  "title": "Short descriptive title of the overall plan",
  "summary": "High-level summary of the implementation strategy",
  "tasks": [
    {
      "id": "T1",
      "title": "Task title",
      "description": "Detailed description of what to implement",
      "dependsOn": [],
      "blocks": [],
      "canRunInParallelWith": [],
      "risk": "low | medium | high",
      "filesLikelyInvolved": ["src/file.ts"],
      "acceptanceCriteria": ["Criterion 1"],
      "verification": ["npm test"]
    }
  ],
  "waves": [
    {
      "id": "W1",
      "taskIds": ["T1"],
      "rationale": "Why these tasks are grouped together"
    }
  ],
  "recommendedFirstWaveId": "W1",
  "graphConcerns": ["Any potential risks or complexities in the dependency graph"],
  "humanDecisionsNeeded": ["Questions or choices that require human input"],
  "suggestedNextAction": "The next concrete step for the orchestrator (e.g., move to implementation)"
}`;

export const PLAN_BREAKDOWN_GRAPH_RULES = [
  "Every task must appear in exactly one wave.",
  "Every task ID referenced in 'dependsOn', 'blocks', or 'canRunInParallelWith' must exist in the 'tasks' array.",
  "Every wave must reference existing task IDs.",
  "The 'recommendedFirstWaveId' must match an existing wave ID.",
  "Dependencies ('dependsOn') must point only to tasks in earlier waves. A wave is a dispatch batch, so dependent tasks must never be grouped in the same wave.",
  "All array fields are required; use empty arrays [] if no items exist.",
  "Do not use null for optional fields; use empty strings or arrays as appropriate."
];

export const PLAN_BREAKDOWN_JSON_EXAMPLE_OBJECT = {
  title: "Add XState Support",
  summary: "Introduce XState for workstream phase management to improve reliability and observability.",
  tasks: [
    {
      id: "T1",
      title: "Add xstate dependency",
      description: "Install xstate and @xstate/test in package.json.",
      dependsOn: [],
      blocks: ["T2"],
      canRunInParallelWith: [],
      risk: "low",
      filesLikelyInvolved: ["package.json"],
      acceptanceCriteria: ["xstate is listed in dependencies", "package-lock.json is updated"],
      verification: ["npm list xstate"]
    },
    {
      id: "T2",
      title: "Define workstream machine",
      description: "Create the state machine definition for workstream phases.",
      dependsOn: ["T1"],
      blocks: [],
      canRunInParallelWith: [],
      risk: "medium",
      filesLikelyInvolved: ["src/workflows/workstream-machine.ts"],
      acceptanceCriteria: ["Machine covers all WORKSTREAM_PHASES", "Transitions are correctly mapped"],
      verification: ["npm test test/workstream-machine.test.ts"]
    }
  ],
  waves: [
    {
      id: "W1",
      taskIds: ["T1"],
      rationale: "Initial environment setup."
    },
    {
      id: "W2",
      taskIds: ["T2"],
      rationale: "Core logic implementation."
    }
  ],
  recommendedFirstWaveId: "W1",
  graphConcerns: ["Ensure transition logic matches existing manual phase advancement."],
  humanDecisionsNeeded: ["Should we migrate existing workstreams immediately?"],
  suggestedNextAction: "Apply implementation-start label to begin T1."
} satisfies PlanBreakdownResult;

export const PLAN_BREAKDOWN_JSON_EXAMPLE = JSON.stringify(
  PLAN_BREAKDOWN_JSON_EXAMPLE_OBJECT,
  null,
  2
);

export function validatePlanBreakdownResultForPrompt(result: PlanBreakdownResult): string[] {
  const errors: string[] = [];

  const taskIds = new Set<string>();
  for (const task of result.tasks) {
    if (task.id && taskIds.has(task.id)) {
      errors.push(`Duplicate task ID: ${task.id}`);
    }
    taskIds.add(task.id);
  }

  const waveIds = new Set<string>();
  for (const wave of result.waves) {
    if (wave.id && waveIds.has(wave.id)) {
      errors.push(`Duplicate wave ID: ${wave.id}`);
    }
    waveIds.add(wave.id);
  }

  const tasksInWaves = new Set<string>();

  if (result.tasks.length === 0) {
    errors.push("At least one task is required.");
  }

  if (result.waves.length === 0) {
    errors.push("At least one wave is required.");
  }

  for (const task of result.tasks) {
    if (!task.id) {
      errors.push(`Task has missing ID: ${task.title}`);
      continue;
    }

    const checkArray = (refs: string[], name: string) => {
      const seen = new Set<string>();
      for (const ref of refs) {
        if (seen.has(ref)) {
          errors.push(`Task ${task.id} has duplicate reference in ${name}: ${ref}`);
        }
        seen.add(ref);
        if (ref === task.id) {
          errors.push(`Task ${task.id} has a self-reference in ${name}.`);
        }
        if (!taskIds.has(ref)) {
          errors.push(`Task ${task.id} references unknown task ID in ${name}: ${ref}`);
        }
      }
    };

    checkArray(task.dependsOn, "dependsOn");
    checkArray(task.blocks, "blocks");
    checkArray(task.canRunInParallelWith, "canRunInParallelWith");
  }

  for (const wave of result.waves) {
    if (!wave.id) errors.push(`Wave has missing ID: ${wave.rationale}`);
    for (const taskId of wave.taskIds) {
      if (!taskIds.has(taskId)) {
        errors.push(`Wave ${wave.id} references unknown task ID: ${taskId}`);
      }
      if (tasksInWaves.has(taskId)) {
        errors.push(`Task ${taskId} appears in multiple waves.`);
      }
      tasksInWaves.add(taskId);
    }
  }

  for (const taskId of taskIds) {
    if (taskId && !tasksInWaves.has(taskId)) {
      errors.push(`Task ${taskId} is not assigned to any wave.`);
    }
  }

  if (result.recommendedFirstWaveId && !waveIds.has(result.recommendedFirstWaveId)) {
    errors.push(`recommendedFirstWaveId ${result.recommendedFirstWaveId} does not exist.`);
  }

  // Wave-based dependency check: dependsOn must be in previous waves.
  const taskToWaveIndex = new Map<string, number>();
  result.waves.forEach((wave, index) => {
    wave.taskIds.forEach((taskId) => taskToWaveIndex.set(taskId, index));
  });

  for (const task of result.tasks) {
    const currentWaveIndex = taskToWaveIndex.get(task.id);
    if (currentWaveIndex === undefined) continue;

    for (const depId of task.dependsOn) {
      const depWaveIndex = taskToWaveIndex.get(depId);
      if (depWaveIndex !== undefined && depWaveIndex === currentWaveIndex) {
        errors.push(`Task ${task.id} (Wave ${currentWaveIndex + 1}) depends on ${depId} in the same wave; dependent tasks must be split into later waves.`);
      } else if (depWaveIndex !== undefined && depWaveIndex > currentWaveIndex) {
        errors.push(`Task ${task.id} (Wave ${currentWaveIndex + 1}) depends on ${depId} in a later wave (Wave ${depWaveIndex + 1}).`);
      }
    }
  }

  return errors;
}
