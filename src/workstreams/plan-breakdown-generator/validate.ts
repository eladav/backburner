import { PlanBreakdownSession, ValidationIssue } from "./types.js";

export function validateSession(session: PlanBreakdownSession): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const checkStringArray = (arr: any[], path: string[], fieldName: string) => {
    if (!Array.isArray(arr)) {
      issues.push({ severity: "error", code: `missing-${fieldName}`, message: `${fieldName} must be an array`, path });
      return false;
    }
    let allStrings = true;
    arr.forEach((item, index) => {
      if (typeof item !== "string") {
        issues.push({
          severity: "error",
          code: `invalid-${fieldName}-element`,
          message: `${fieldName} element at index ${index} must be a string`,
          path: [...path, index.toString()]
        });
        allStrings = false;
      }
    });
    return allStrings;
  };

  const checkString = (val: any, path: string[], fieldName: string, required = true) => {
    if (typeof val !== "string") {
      issues.push({ severity: "error", code: `invalid-${fieldName}`, message: `${fieldName} must be a string`, path });
      return false;
    }
    if (required && !val) {
      issues.push({ severity: "error", code: `missing-${fieldName}`, message: `${fieldName} is required`, path });
      return false;
    }
    return true;
  };

  // Required fields
  checkString(session.title, ["title"], "title");
  checkString(session.summary, ["summary"], "summary");
  checkString(session.recommendedFirstWaveId, ["recommendedFirstWaveId"], "recommended-first-wave");
  checkString(session.suggestedNextAction, ["suggestedNextAction"], "suggested-next-action");
  checkString(session.createdAt, ["createdAt"], "createdAt");
  checkString(session.updatedAt, ["updatedAt"], "updatedAt");

  checkStringArray(session.graphConcerns, ["graphConcerns"], "graphConcerns");

  checkStringArray(session.humanDecisionsNeeded, ["humanDecisionsNeeded"], "humanDecisionsNeeded");

  if (typeof session.tasks !== "object" || session.tasks === null || Array.isArray(session.tasks)) {
    issues.push({ severity: "error", code: "invalid-tasks", message: "tasks must be an object", path: ["tasks"] });
  }
  if (typeof session.waves !== "object" || session.waves === null || Array.isArray(session.waves)) {
    issues.push({ severity: "error", code: "invalid-waves", message: "waves must be an object", path: ["waves"] });
  }

  const taskIds = new Set(Object.keys(session.tasks || {}));

  if (taskIds.size === 0) {
    issues.push({ severity: "error", code: "no-tasks", message: "At least one task is required" });
  }

  const waveIdsInOrder = new Set<string>();
  if (checkStringArray(session.waveOrder, ["waveOrder"], "waveOrder")) {
    for (const waveId of session.waveOrder) {
      if (waveIdsInOrder.has(waveId)) {
        issues.push({ severity: "error", code: "duplicate-wave-order", message: `Wave ID ${waveId} appears multiple times in waveOrder`, path: ["waveOrder"] });
      }
      waveIdsInOrder.add(waveId);
    }

    if (waveIdsInOrder.size === 0) {
      issues.push({ severity: "error", code: "no-waves", message: "At least one wave is required" });
    }
  }

  const waves = session.waves || {};
  for (const waveId of Object.keys(waves)) {
    if (!waveIdsInOrder.has(waveId)) {
      issues.push({ severity: "error", code: "orphaned-wave", message: `Wave ${waveId} exists but is not in waveOrder`, path: ["waves", waveId] });
    }
  }

  // Task validation
  for (const [taskId, task] of Object.entries(session.tasks || {})) {
    if (checkString(task.id, ["tasks", taskId, "id"], "task-id")) {
      if (task.id !== taskId) {
        issues.push({ severity: "error", code: "task-id-mismatch", message: `Task entry ${taskId} has mismatched internal ID: ${task.id}`, path: ["tasks", taskId] });
      }
    }

    checkString(task.title, ["tasks", taskId, "title"], "task-title");
    checkString(task.description, ["tasks", taskId, "description"], "task-description");

    if (typeof task.risk !== "string") {
      issues.push({ severity: "error", code: "invalid-risk-type", message: `Task ${taskId} risk must be a string`, path: ["tasks", taskId, "risk"] });
    } else if (!["low", "medium", "high"].includes(task.risk)) {
      issues.push({ severity: "error", code: "invalid-risk-value", message: `Task ${taskId} has invalid risk: ${task.risk}`, path: ["tasks", taskId, "risk"] });
    }


    const checkRefs = (refs: string[], name: string) => {
      if (!checkStringArray(refs, ["tasks", taskId, name], name)) {
        return;
      }
      const seen = new Set<string>();
      for (const ref of refs) {
        if (seen.has(ref)) {
          issues.push({ severity: "error", code: "duplicate-ref", message: `Task ${taskId} has duplicate reference in ${name}: ${ref}`, path: ["tasks", taskId, name] });
        }
        seen.add(ref);
        if (ref === taskId) {
          issues.push({ severity: "error", code: "self-ref", message: `Task ${taskId} has a self-reference in ${name}`, path: ["tasks", taskId, name] });
        }
        if (!taskIds.has(ref)) {
          issues.push({ severity: "error", code: "unknown-ref", message: `Task ${taskId} references unknown task ID in ${name}: ${ref}`, path: ["tasks", taskId, name] });
        }
      }
    };

    checkRefs(task.dependsOn, "dependsOn");
    checkRefs(task.blocks, "blocks");
    checkRefs(task.canRunInParallelWith, "canRunInParallelWith");

    // Warnings & More validation
    if (checkStringArray(task.verification, ["tasks", taskId, "verification"], "verification")) {
      if (task.verification.length === 0) {
        issues.push({ severity: "warning", code: "missing-verification", message: `Task ${taskId} has no verification commands`, path: ["tasks", taskId] });
      }
    }

    checkStringArray(task.acceptanceCriteria, ["tasks", taskId, "acceptanceCriteria"], "acceptanceCriteria");

    checkStringArray(task.filesLikelyInvolved, ["tasks", taskId, "filesLikelyInvolved"], "filesLikelyInvolved");
  }

  // Wave validation
  const tasksInWaves = new Set<string>();
  if (Array.isArray(session.waveOrder)) {
    for (const waveId of session.waveOrder) {
      const wave = waves[waveId];
      if (!wave) {
        issues.push({ severity: "error", code: "unknown-wave-order", message: `Wave ID ${waveId} in waveOrder does not exist in waves`, path: ["waveOrder"] });
        continue;
      }

      if (checkString(wave.id, ["waves", waveId, "id"], "wave-id")) {
        if (wave.id !== waveId) {
          issues.push({ severity: "error", code: "wave-id-mismatch", message: `Wave entry ${waveId} has mismatched internal ID: ${wave.id}`, path: ["waves", waveId] });
        }
      }

      checkString(wave.rationale, ["waves", waveId, "rationale"], "wave-rationale");


      if (checkStringArray(wave.taskIds, ["waves", waveId, "taskIds"], "wave-taskIds")) {
        if (wave.taskIds.length === 0) {
          issues.push({ severity: "error", code: "empty-wave", message: `Wave ${waveId} has no tasks`, path: ["waves", waveId] });
        }

        for (const taskId of wave.taskIds) {
          if (!taskIds.has(taskId)) {
            issues.push({ severity: "error", code: "unknown-wave-task", message: `Wave ${waveId} references unknown task ID: ${taskId}`, path: ["waves", waveId] });
          }
          if (tasksInWaves.has(taskId)) {
            issues.push({ severity: "error", code: "duplicate-task-wave", message: `Task ${taskId} appears in multiple waves`, path: ["waves", waveId] });
          }
          tasksInWaves.add(taskId);
        }

      }
    }
  }


  for (const taskId of taskIds) {
    if (!tasksInWaves.has(taskId)) {
      issues.push({ severity: "error", code: "unassigned-task", message: `Task ${taskId} is not assigned to any wave`, path: ["tasks", taskId] });
    }
  }

  if (session.recommendedFirstWaveId && !waveIdsInOrder.has(session.recommendedFirstWaveId)) {
    issues.push({ severity: "error", code: "invalid-first-wave", message: `recommendedFirstWaveId ${session.recommendedFirstWaveId} does not exist`, path: ["recommendedFirstWaveId"] });
  }

  // Wave dependency check. A wave is a dispatch batch, so dependencies must
  // be satisfied by earlier waves, never by later or same-wave packets.
  const taskToWaveIndex = new Map<string, number>();
  if (Array.isArray(session.waveOrder)) {
    session.waveOrder.forEach((waveId, index) => {
      const wave = waves[waveId];
      if (wave && Array.isArray(wave.taskIds)) {
        wave.taskIds.forEach((taskId) => taskToWaveIndex.set(taskId, index));
      }
    });
  }

  for (const [taskId, task] of Object.entries(session.tasks || {})) {
    const currentWaveIndex = taskToWaveIndex.get(taskId);
    if (currentWaveIndex === undefined) continue;

    if (Array.isArray(task.dependsOn)) {
      for (const depId of task.dependsOn) {
        const depWaveIndex = taskToWaveIndex.get(depId);
        if (depWaveIndex !== undefined && depWaveIndex === currentWaveIndex) {
          issues.push({
            severity: "error",
            code: "same-wave-dependency",
            message: `Task ${taskId} (Wave ${currentWaveIndex + 1}) depends on ${depId} in the same wave; dependent packets must be split into later waves`,
            path: ["tasks", taskId, "dependsOn"]
          });
        } else if (depWaveIndex !== undefined && depWaveIndex > currentWaveIndex) {
          issues.push({
            severity: "error",
            code: "forward-dependency",
            message: `Task ${taskId} (Wave ${currentWaveIndex + 1}) depends on ${depId} in a later wave (Wave ${depWaveIndex + 1})`,
            path: ["tasks", taskId, "dependsOn"]
          });
        }
      }
    }
  }

  // File overlap warning
  const fileToTasks = new Map<string, string[]>();
  for (const [taskId, task] of Object.entries(session.tasks || {})) {
    if (Array.isArray(task.filesLikelyInvolved)) {
      for (const file of task.filesLikelyInvolved) {
        if (!fileToTasks.has(file)) fileToTasks.set(file, []);
        fileToTasks.get(file)!.push(taskId);
      }
    }
  }

  for (const [file, overlappingTaskIds] of fileToTasks.entries()) {
    if (overlappingTaskIds.length > 3) {
      issues.push({
        severity: "warning",
        code: "heavy-file-overlap",
        message: `File ${file} is involved in many tasks: ${overlappingTaskIds.join(", ")}`
      });
    }
  }

  return issues;
}
