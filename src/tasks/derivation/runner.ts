import type {
  BlockingTaskDerivationHandler,
  ResolvedWorkstreamContext,
  TaskDerivationSink,
  TaskDerivationEnvironment,
  TaskDerivationHandler
} from "./types.js";

export function runBlockingHandler(
  handler: BlockingTaskDerivationHandler,
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment,
  sink: TaskDerivationSink
): boolean {
  const tasks = handler.derive(context, env, sink);
  let shouldBlock = false;

  for (const task of tasks) {
    const mergedTask = sink.add(task);
    if (handler.shouldBlockRemainingHandlers(mergedTask)) {
      shouldBlock = true;
    }
  }

  return shouldBlock;
}

export function runHandlers(
  handlers: TaskDerivationHandler[],
  context: ResolvedWorkstreamContext,
  env: TaskDerivationEnvironment,
  sink: TaskDerivationSink
): void {
  for (const handler of handlers) {
    for (const task of handler.derive(context, env, sink)) {
      sink.add(task);
    }
  }
}
