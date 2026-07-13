import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const crossSpawn = require("cross-spawn") as SpawnProcess;

export interface CommandRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  onOutputChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface CommandRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandRunnerOptions): Promise<CommandRunnerResult>;
}

export class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly args: string[],
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message);
  }
}

const COMMAND_TIMEOUT_EXIT_CODE = 124;
const PROCESS_GROUP_TERMINATION_GRACE_MS = 250;
const TIMEOUT_SETTLE_FALLBACK_MS = 1000;

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type KillProcess = (pid: number, signal: NodeJS.Signals) => void;

export interface ExecFileCommandRunnerDependencies {
  spawnProcess?: SpawnProcess;
  killProcess?: KillProcess;
  platform?: NodeJS.Platform;
}

export class ExecFileCommandRunner implements CommandRunner {
  private readonly spawnProcess: SpawnProcess;
  private readonly killProcess: KillProcess;
  private readonly platform: NodeJS.Platform;

  constructor(dependencies: ExecFileCommandRunnerDependencies = {}) {
    this.spawnProcess = dependencies.spawnProcess ?? crossSpawn;
    this.killProcess = dependencies.killProcess ?? process.kill.bind(process);
    this.platform = dependencies.platform ?? process.platform;
  }

  run(command: string, args: string[], options: CommandRunnerOptions = {}): Promise<CommandRunnerResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        command,
        args,
        {
          cwd: options.cwd,
          env: options.env === undefined ? process.env : { ...process.env, ...options.env },
          detached: this.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: this.platform === "win32"
        }
      );

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killGraceHandle: NodeJS.Timeout | undefined;
      let timeoutFallbackHandle: NodeJS.Timeout | undefined;

      const settleResolve = (result: CommandRunnerResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        resolve(result);
      };

      const settleReject = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        reject(error);
      };

      const clearTimers = (): void => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }

        if (killGraceHandle !== undefined) {
          clearTimeout(killGraceHandle);
          killGraceHandle = undefined;
        }

        if (timeoutFallbackHandle !== undefined) {
          clearTimeout(timeoutFallbackHandle);
          timeoutFallbackHandle = undefined;
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (!settled) {
          options.onOutputChunk?.("stdout", chunk);
        }
      });

      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (!settled) {
          options.onOutputChunk?.("stderr", chunk);
        }
      });

      child.once("error", (error) => {
        settleReject(
          new CommandExecutionError(
            formatCommandError(command, args, error.message, stderr),
            command,
            args,
            1,
            stdout,
            stderr
          )
        );
      });

      child.once("close", (code, signal) => {
        if (timedOut) {
          settleReject(
            new CommandExecutionError(
              formatTimeoutError(command, args, options.timeoutMs ?? 0, stderr),
              command,
              args,
              COMMAND_TIMEOUT_EXIT_CODE,
              stdout,
              stderr
            )
          );
          return;
        }

        const exitCode = extractExitCodeFromClose(code, signal);
        if (exitCode === 0) {
          settleResolve({
            stdout,
            stderr,
            exitCode: 0
          });
          return;
        }

        settleReject(
          new CommandExecutionError(
            formatCommandError(command, args, `command exited with code ${exitCode}`, stderr),
            command,
            args,
            exitCode,
            stdout,
            stderr
          )
        );
      });

      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }

      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (settled || child.pid === undefined) {
            return;
          }

          timedOut = true;
          terminateProcessTree(child, "SIGTERM", {
            spawnProcess: this.spawnProcess,
            killProcess: this.killProcess,
            platform: this.platform
          });

          killGraceHandle = setTimeout(() => {
            if (settled || child.pid === undefined) {
              return;
            }

            terminateProcessTree(child, "SIGKILL", {
              spawnProcess: this.spawnProcess,
              killProcess: this.killProcess,
              platform: this.platform
            });
          }, PROCESS_GROUP_TERMINATION_GRACE_MS);

          timeoutFallbackHandle = setTimeout(() => {
            if (settled) {
              return;
            }

            settleReject(
              new CommandExecutionError(
                formatTimeoutError(command, args, options.timeoutMs ?? 0, stderr),
                command,
                args,
                COMMAND_TIMEOUT_EXIT_CODE,
                stdout,
                stderr
              )
            );
          }, TIMEOUT_SETTLE_FALLBACK_MS);
        }, options.timeoutMs);
      }
    });
  }
}

export interface ProcessTreeTerminationDependencies {
  spawnProcess?: SpawnProcess;
  killProcess?: KillProcess;
  platform?: NodeJS.Platform;
}

function extractExitCodeFromClose(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === "number") {
    return code;
  }

  if (signal !== null) {
    return 1;
  }

  return 1;
}

export function terminateProcessTree(
  child: Pick<ChildProcess, "pid">,
  signal: NodeJS.Signals,
  dependencies: ProcessTreeTerminationDependencies = {}
): void {
  if (child.pid === undefined) {
    return;
  }

  const platform = dependencies.platform ?? process.platform;
  const spawnProcess = dependencies.spawnProcess ?? crossSpawn;
  const killProcess = dependencies.killProcess ?? process.kill.bind(process);

  if (platform === "win32") {
    const taskkill = spawnProcess("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });

    taskkill.once("error", () => undefined);
    taskkill.unref();
    return;
  }

  try {
    killProcess(-child.pid, signal);
  } catch {
    try {
      killProcess(child.pid, signal);
    } catch {
      // Ignore termination failures. The fallback timeout will surface the timeout error.
    }
  }
}

function formatCommandError(
  command: string,
  args: string[],
  message: string,
  stderr: string
): string {
  const renderedCommand = [command, ...args].join(" ");
  const suffix = stderr.trim() === "" ? message : stderr.trim();
  return `${renderedCommand}: ${suffix}`;
}

function formatTimeoutError(command: string, args: string[], timeoutMs: number, stderr: string): string {
  const renderedCommand = [command, ...args].join(" ");
  const timeoutMessage = `timed out after ${timeoutMs}ms`;
  const suffix = stderr.trim() === "" ? timeoutMessage : `${timeoutMessage}: ${stderr.trim()}`;
  return `${renderedCommand}: ${suffix}`;
}
