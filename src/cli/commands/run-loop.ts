import { formatRunSummary } from "../output.js";
import { defaultStderrLogger } from "../../utils/logger.js";
import { CliUsageError } from "../errors.js";
import { delayWithAbort, isAbortError, readIntervalMs } from "../options.js";
import { runCli } from "./run.js";
import type { RunCliOptions } from "../run-types.js";
import { runInteractiveTui, shouldUseRuntimeStatusScreen, SerializedCycleRunner } from "./tui.js";

export interface RunLoopCliOptions extends RunCliOptions {
  now?: () => string;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  signalRegistrar?: SignalRegistrar;
}

interface SignalRegistrar {
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

export { SerializedCycleRunner };

export async function runLoopCli(argv: string[], options: RunLoopCliOptions = {}): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== "run-loop") {
    throw new CliUsageError(
      'Expected command: backburner run-loop [--code-root <path>] [--management-dir <path>] [--outputs-dir <path>] [--log-dir <path>] [--broker-port <port>] [--interval-seconds <seconds> | --interval-minutes <minutes>] [--headless]'
    );
  }

  if (shouldUseRuntimeStatusScreen(rest)) {
    await runInteractiveTui(["run", ...rest]);
    return;
  }

  const intervalMs = readIntervalMs(rest);
  const logger = options.logger ?? defaultStderrLogger;
  const delay = options.delay ?? delayWithAbort;
  const signalRegistrar = options.signalRegistrar ?? process;
  const abortController = new AbortController();
  let stopRequested = false;

  const requestStop = () => {
    stopRequested = true;
    abortController.abort();
  };

  signalRegistrar.on("SIGINT", requestStop);
  signalRegistrar.on("SIGTERM", requestStop);

  try {
    logger.info(`Starting orchestrator run loop with interval ${Math.floor(intervalMs / 1000)}s`);

    while (!stopRequested) {
      const summary = await runCli(["run", ...rest], options);
      process.stdout.write(formatRunSummary(summary));

      if (stopRequested) {
        break;
      }

      logger.info(`Waiting ${Math.floor(intervalMs / 1000)}s before the next orchestration cycle`);
      try {
        await delay(intervalMs, abortController.signal);
      } catch (error: unknown) {
        if (!isAbortError(error)) {
          throw error;
        }
      }

      if (stopRequested) {
        break;
      }
    }

    logger.info("Run loop stopped after the current orchestration cycle completed.");
  } finally {
    signalRegistrar.off("SIGINT", requestStop);
    signalRegistrar.off("SIGTERM", requestStop);
  }
}
