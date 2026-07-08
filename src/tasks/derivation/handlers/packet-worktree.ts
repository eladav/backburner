import type { TaskRecord } from "../../types.js";
import { derivePacketImplementTask } from "./implement-plan.js";
import { resolvePacketPullRequest } from "./shared.js";
import { deriveWritePlanTask } from "./write-plan.js";
import type {
  ResolvedWorkstreamContext,
  TaskDerivationEnvironment,
  TaskDerivationHandler
} from "../types.js";

export const packetWorktreeHandler: TaskDerivationHandler = {
  name: "packet_worktree_tasks",
  derive(context, env) {
    return derivePacketWorktreeTasks(context, env);
  }
};

function derivePacketWorktreeTasks(
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment
): TaskRecord[] {
  const tasks: TaskRecord[] = [];

  for (const packetWorktree of env.packetWorktreesByWorkstreamId.get(context.workstream.id) ?? []) {
    const packetPullRequest = resolvePacketPullRequest(packetWorktree, env.currentPrsByRepoAndNumber);
    const packetContext: ResolvedWorkstreamContext = {
      ...context,
      activeWorktree: packetWorktree,
      packetPullRequest
    };

    const writePlanTask = deriveWritePlanTask(packetContext, env);
    if (writePlanTask) {
      tasks.push(writePlanTask);
    }

    const implementTask = derivePacketImplementTask(packetContext, env);
    if (implementTask) {
      tasks.push(implementTask);
    }
  }

  return tasks;
}
