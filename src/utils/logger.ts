import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error?(message: string): void;
}

export interface ManagedLogger extends Logger {
  close(): Promise<void>;
}

export const defaultStderrLogger: Logger = {
  info: (message) => process.stderr.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`)
};

export function createTeeFileLogger(baseLogger: Logger, filePath: string): ManagedLogger {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, {
    flags: "a",
    encoding: "utf8"
  });

  const writeLine = (message: string) => {
    stream.write(`${message}\n`);
  };

  return {
    info(message: string) {
      baseLogger.info(message);
      writeLine(message);
    },
    warn(message: string) {
      baseLogger.warn(message);
      writeLine(message);
    },
    error(message: string) {
      baseLogger.error?.(message);
      writeLine(message);
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}
