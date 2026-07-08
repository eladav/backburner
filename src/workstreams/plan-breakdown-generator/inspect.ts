import { InspectionOutput, PlanBreakdownSession } from "./types.js";
import { validateSession } from "./validate.js";

export function inspectSession(session: PlanBreakdownSession): InspectionOutput {
  const structuralIssues = validateSession(session);
  const validationIssues = [...(session.validationIssues ?? []), ...structuralIssues];
  const isValid = !validationIssues.some((i) => i.severity === "error");

  const waveOrder = Array.isArray(session.waveOrder) ? session.waveOrder : [];
  const sessionTasks = (session.tasks && typeof session.tasks === "object") ? session.tasks : {};

  const taskToWave = new Map<string, string>();
  for (const waveId of waveOrder) {
    const wave = session.waves?.[waveId];
    if (wave) {
      const taskIds = Array.isArray(wave.taskIds) ? wave.taskIds : [];
      for (const taskId of taskIds) {
        taskToWave.set(taskId, waveId);
      }
    }
  }

  return {
    sessionId: session.id ?? "",
    title: session.title ?? "",
    summary: session.summary ?? "",
    taskCount: Object.keys(sessionTasks).length,
    waveCount: waveOrder.length,
    tasks: Object.entries(sessionTasks).map(([id, task]) => ({
      id,
      title: task?.title,
      waveId: taskToWave.get(id),
      dependencies: Array.isArray(task?.dependsOn) ? task.dependsOn : [],
      validationIssues: validationIssues.filter((i) => i.path?.[0] === "tasks" && i.path?.[1] === id)
    })),
    waves: waveOrder.map((id) => {
      const wave = session.waves?.[id];
      return {
        id,
        taskIds: Array.isArray(wave?.taskIds) ? wave.taskIds : [],
        validationIssues: validationIssues.filter((i) => i.path?.[0] === "waves" && i.path?.[1] === id)
      };
    }),
    validationIssues: validationIssues.filter((i) => {
      if (!i.path) return true;
      if (i.path[0] === "tasks" && i.path[1]) return false;
      if (i.path[0] === "waves" && i.path[1]) return false;
      return true;
    }),
    isValid
  };
}
