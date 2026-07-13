import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const testDirectory = path.resolve("dist", "test");
const testFiles = (await readdir(testDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join(testDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No compiled test files found in ${testDirectory}`);
}

const child = spawn(
  process.execPath,
  [
    "--import",
    pathToFileURL(path.join(testDirectory, "setup.js")).href,
    "--test",
    "--test-concurrency=1",
    ...testFiles
  ],
  { stdio: "inherit" }
);

child.once("error", (error) => {
  throw error;
});

child.once("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
