import { CliUsageError } from "./errors.js";

export const DEFAULT_GITHUB_BROKER_PORT = 4444;
export const DEFAULT_RUN_LOOP_INTERVAL_MS = 5 * 60 * 1000;

export function readStringFlag(argv: string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }

  const value = argv[index + 1];
  if (!value) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }

  return value;
}

export function readOptionalStringFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (!value) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }

  return value;
}

export function readNumberFlag(argv: string[], flag: string, fallback: number): number {
  const value = readOptionalStringFlag(argv, flag);
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliUsageError(`${flag} must be a non-negative integer`);
  }

  return parsed;
}

export function readIntervalMs(argv: string[]): number {
  const seconds = readOptionalNumberFlag(argv, "--interval-seconds");
  const minutes = readOptionalNumberFlag(argv, "--interval-minutes");

  if (seconds !== undefined && minutes !== undefined) {
    throw new CliUsageError("Use only one of --interval-seconds or --interval-minutes");
  }

  if (seconds !== undefined) {
    return seconds * 1000;
  }

  if (minutes !== undefined) {
    return minutes * 60 * 1000;
  }

  return DEFAULT_RUN_LOOP_INTERVAL_MS;
}

export function readOptionalNumberFlag(argv: string[], flag: string): number | undefined {
  const value = readOptionalStringFlag(argv, flag);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${flag} must be a positive integer`);
  }

  return parsed;
}

export async function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
