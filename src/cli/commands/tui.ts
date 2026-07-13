import { loadConfig } from "../../config/loader.js";
import { StateStore } from "../../state/loader.js";
import {
  defaultBackburnerManagementRoot,
  defaultBackburnerOutputsRoot,
  resolveOutputsLogsRoot,
  resolveOutputsStateRoot,
  resolveUserPath
} from "../../utils/paths.js";
import { RuntimeStatusTracker, TuiScreen } from "../tui/index.js";
import { readIntervalMs, readOptionalStringFlag, readStringFlag } from "../options.js";
import { runCli } from "./run.js";

export function shouldUseRuntimeStatusScreen(rest: string[]): boolean {
  return Boolean(
    process.stdout.isTTY &&
    process.stdin.isTTY &&
    !rest.includes("--headless") &&
    !rest.includes("--once")
  );
}

export class SerializedCycleRunner {
  private running = false;
  private refreshRequested = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private runCycleFn: () => Promise<void>,
    private scheduleNextCycleFn: () => void,
    private onRunningChange?: (running: boolean, reason: "initial" | "scheduled" | "manual") => void
  ) {}

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async run(reason: "initial" | "scheduled" | "manual"): Promise<void> {
    if (this.running) {
      if (reason === "manual") {
        this.refreshRequested = true;
      }
      return;
    }

    // A real cycle is starting, so any pending scheduled wakeup is stale.
    this.clearTimer();

    this.running = true;
    if (this.onRunningChange) this.onRunningChange(true, reason);

    try {
      await this.runCycleFn();
    } finally {
      this.running = false;
      if (this.onRunningChange) this.onRunningChange(false, reason);

      if (this.stopped) return;

      if (this.refreshRequested) {
        this.refreshRequested = false;
        void this.run("manual");
        return;
      }

      this.scheduleNextCycleFn();
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  setTimer(timer: NodeJS.Timeout): void {
    this.clearTimer();
    this.timer = timer;
  }

  isStopped(): boolean {
    return this.stopped;
  }
}

export async function runInteractiveTui(argv: string[]): Promise<void> {
  const rest = argv.filter((arg) => arg !== "run");
  const managementDir = resolveUserPath(readStringFlag(rest, "--management-dir", defaultBackburnerManagementRoot()));
  let repoCount = 0;
  let initialConfig: any = null;
  try {
    initialConfig = await loadConfig(managementDir);
    repoCount = initialConfig.repos.filter((r: any) => r.enabled).length;
  } catch {
    // Config load error will be captured in runCycle
  }

  const tracker = new RuntimeStatusTracker(repoCount);
  if (initialConfig) {
    tracker.setConfigs(initialConfig.mcps, initialConfig.capabilities, initialConfig.maxConcurrentAgents);
  }
  const intervalMs = readIntervalMs(rest);
  tracker.setIntervalMs(intervalMs);

  // Load initial state for the explorer immediately on start
  try {
    const outputsDir = resolveUserPath(readOptionalStringFlag(rest, "--outputs-dir") ?? defaultBackburnerOutputsRoot());
    const stateDir = resolveUserPath(resolveOutputsStateRoot(outputsDir));
    const logDir = resolveUserPath(resolveOutputsLogsRoot(outputsDir));
    const stateStore = new StateStore({ stateDir, executionDir: logDir });
    const state = await stateStore.load();
    tracker.setState(state);
  } catch {
    // Ignore initial state load errors
  }

  const runCycle = async () => {
    const silentLogger = {
      info: () => {},
      warn: () => {},
      error: () => {}
    };

    try {
      const currentCycleNo = tracker.getModel().cycleNo === "—" ? 1 : Number(tracker.getModel().cycleNo) + 1;
      const summary = await runCli(["run", ...rest], {
        statusTracker: tracker,
        logger: silentLogger,
        cycleNo: currentCycleNo
      });

      const outputsDir = resolveUserPath(readOptionalStringFlag(rest, "--outputs-dir") ?? defaultBackburnerOutputsRoot());
      const stateDir = resolveUserPath(resolveOutputsStateRoot(outputsDir));
      const logDir = resolveUserPath(resolveOutputsLogsRoot(outputsDir));
      const stateStore = new StateStore({ stateDir, executionDir: logDir });
      const state = await stateStore.load();

      try {
        const config = await loadConfig(managementDir);
        tracker.setConfigs(config.mcps, config.capabilities, config.maxConcurrentAgents);
        tracker.setConfigReloadError(null);
      } catch (err: any) {
        tracker.setConfigReloadError(err);
      }
      tracker.onCycleSuccess(summary, state);
    } catch (error: any) {
      tracker.onCycleFailure(error);
    }
  };



  let screen: TuiScreen;
  let runner: SerializedCycleRunner;

  const scheduleNextCycle = () => {
    if (runner.isStopped()) return;
    tracker.setNextCycleAt(Date.now() + intervalMs);
    const timer = setTimeout(() => {
      void runner.run("scheduled");
    }, intervalMs);
    runner.setTimer(timer);
  };

  const shutdown = () => {
    runner.stop();
    screen.exit();
  };

  const onQuit = () => {
    shutdown();
    process.exit(0);
  };

  screen = new TuiScreen(tracker, async () => {
    await runner.run("manual");
  }, onQuit);

  runner = new SerializedCycleRunner(
    runCycle,
    scheduleNextCycle,
    (running, reason) => {
      if (running) {
        tracker.setNextCycleAt(0);
      }
      if (reason === "manual") {
        screen.setRefreshing(running);
      }
    }
  );

  const sigintHandler = () => {
    shutdown();
    process.exit(130);
  };

  const sigtermHandler = () => {
    shutdown();
    process.exit(143);
  };

  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  try {
    screen.start();
    void runner.run("initial");

    // Keep process alive
    await new Promise<void>(() => {});
  } finally {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
    shutdown();
  }
}
