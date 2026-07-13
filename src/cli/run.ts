#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export { runCli, buildPacketWaveAdvancementEvaluationForRun } from "./commands/run.js";
export { buildEffectiveProviderBrokerToolAllowLists } from "./runtime/provider-tools.js";
export { runDispatchWithMergePrepLifecycle } from "./runtime/dispatch-lifecycle.js";
export type { RunCliOptions, RunSummary, ParentBranchSyncPreflightRunSummary } from "./run-types.js";
export { runLoopCli, SerializedCycleRunner, type RunLoopCliOptions } from "./commands/run-loop.js";
export { runJournalCli } from "./commands/journal.js";
export { shouldUseRuntimeStatusScreen } from "./commands/tui.js";
export { main } from "./dispatcher.js";
import { main } from "./dispatcher.js";
import { CliUsageError } from "./errors.js";

const entrypointPath = process.argv[1];
if (entrypointPath) {
  const executedAsScript = resolveEntrypointPath(entrypointPath) === resolveEntrypointPath(fileURLToPath(import.meta.url));
  if (executedAsScript) {
    main(process.argv.slice(2)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const prefix = error instanceof CliUsageError ? "Usage error" : "Run failed";
      process.stderr.write(`${prefix}: ${message}\n`);
      process.exitCode = 1;
    });
  }
}

function resolveEntrypointPath(entrypointPathValue: string): string {
  try {
    return realpathSync(entrypointPathValue);
  } catch {
    return entrypointPathValue;
  }
}
