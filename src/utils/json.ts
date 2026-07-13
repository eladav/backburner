import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

export async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath}: invalid JSON (${error.message})`);
    }

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${filePath}: file not found`);
    }

    throw error;
  }
}

export async function readJsonFileIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === `${filePath}: file not found`) {
      return undefined;
    }

    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });

  const temporaryFile = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  await writeFile(temporaryFile, toPrettyJson(value), "utf8");
  await rename(temporaryFile, filePath);
}

export function toPrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
