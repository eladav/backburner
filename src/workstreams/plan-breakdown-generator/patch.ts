import { PatchOperation, PlanBreakdownSession, ValidationIssue, PatchError } from "./types.js";

export function applyPatches(
  session: PlanBreakdownSession,
  patches: PatchOperation[]
): PlanBreakdownSession {
  let current = { ...session, validationIssues: [...(session.validationIssues || [])] };
  const now = new Date().toISOString();

  for (const patch of patches) {
    switch (patch.op) {
      case "set-title":
        current.title = patch.value;
        break;
      case "set-summary":
        current.summary = patch.value;
        break;
      case "add-task":
        if (current.tasks[patch.task.id]) {
          throw new PatchError(`Task ID ${patch.task.id} already exists`);
        }
        current.tasks = { ...current.tasks, [patch.task.id]: patch.task };
        break;
      case "update-task":
        if (!current.tasks[patch.id]) {
          throw new PatchError(`Task ${patch.id} not found`);
        }
        current.tasks = {
          ...current.tasks,
          [patch.id]: { ...current.tasks[patch.id], ...patch.patch } as any
        };
        break;
      case "remove-task": {
        if (!current.tasks[patch.id]) {
          throw new PatchError(`Task ${patch.id} not found`);
        }
        const { [patch.id]: _, ...remainingTasks } = current.tasks;
        current.tasks = remainingTasks;
        // Also remove from waves
        const updatedWaves: typeof current.waves = {};
        for (const [waveId, wave] of Object.entries(current.waves)) {
          if (wave.taskIds.includes(patch.id)) {
            updatedWaves[waveId] = {
              ...wave,
              taskIds: wave.taskIds.filter((id) => id !== patch.id)
            };
          } else {
            updatedWaves[waveId] = wave;
          }
        }
        current.waves = updatedWaves;
        // Clear validation issues for this task
        current.validationIssues = current.validationIssues.filter(i =>
          !(i.path?.[0] === "tasks" && i.path?.[1] === patch.id)
        );
        break;
      }
      case "add-wave":
        if (current.waves[patch.wave.id]) {
          throw new PatchError(`Wave ID ${patch.wave.id} already exists`);
        }
        current.waves = { ...current.waves, [patch.wave.id]: patch.wave };
        if (patch.index !== undefined) {
          const newOrder = current.waveOrder.filter(id => id !== patch.wave.id);
          newOrder.splice(patch.index, 0, patch.wave.id);
          current.waveOrder = newOrder;
        } else if (!current.waveOrder.includes(patch.wave.id)) {
          current.waveOrder = [...current.waveOrder, patch.wave.id];
        }
        break;
      case "update-wave":
        if (!current.waves[patch.id]) {
          throw new PatchError(`Wave ${patch.id} not found`);
        }
        current.waves = {
          ...current.waves,
          [patch.id]: { ...current.waves[patch.id], ...patch.patch } as any
        };
        break;
      case "remove-wave": {
        if (!current.waves[patch.id]) {
          throw new PatchError(`Wave ${patch.id} not found`);
        }
        const { [patch.id]: __, ...remainingWaves } = current.waves;
        current.waves = remainingWaves;
        current.waveOrder = current.waveOrder.filter((id) => id !== patch.id);
        if (current.recommendedFirstWaveId === patch.id) {
          current.recommendedFirstWaveId = "";
        }
        // Clear validation issues for this wave
        current.validationIssues = current.validationIssues.filter(i =>
          !(i.path?.[0] === "waves" && i.path?.[1] === patch.id)
        );
        break;
      }
      case "reorder-waves": {
        const existingWaveIds = Object.keys(current.waves);
        if (patch.waveIds.length !== existingWaveIds.length) {
          throw new PatchError(
            `reorder-waves must include all existing waves. Expected ${existingWaveIds.length} waves, got ${patch.waveIds.length}.`
          );
        }
        // Validate all wave IDs exist and there are no duplicates
        const seen = new Set<string>();
        for (const waveId of patch.waveIds) {
          if (!current.waves[waveId]) {
            throw new PatchError(`Wave ${waveId} not found for reorder`);
          }
          if (seen.has(waveId)) {
            throw new PatchError(`Duplicate wave ID ${waveId} in reorder`);
          }
          seen.add(waveId);
        }
        current.waveOrder = patch.waveIds;
        break;
      }
      case "set-recommended-first-wave":
        if (!current.waves[patch.id]) {
          throw new PatchError(`Wave ${patch.id} not found for recommended first wave`);
        }
        current.recommendedFirstWaveId = patch.id;
        break;
      case "add-graph-concern":
        current.graphConcerns = [...current.graphConcerns, patch.value];
        break;
      case "remove-graph-concern":
        if (patch.index < 0 || patch.index >= current.graphConcerns.length) {
          throw new PatchError(`Graph concern index ${patch.index} out of bounds`);
        }
        current.graphConcerns = current.graphConcerns.filter((_, i) => i !== patch.index);
        break;
      case "add-human-decision":
        current.humanDecisionsNeeded = [...current.humanDecisionsNeeded, patch.value];
        break;
      case "remove-human-decision":
        if (patch.index < 0 || patch.index >= current.humanDecisionsNeeded.length) {
          throw new PatchError(`Human decision index ${patch.index} out of bounds`);
        }
        current.humanDecisionsNeeded = current.humanDecisionsNeeded.filter((_, i) => i !== patch.index);
        break;
      case "set-suggested-next-action":
        current.suggestedNextAction = patch.value;
        break;
    }
  }

  current.updatedAt = now;
  return current;
}
