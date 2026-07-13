#!/usr/bin/env node
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const binPath = path.join(repoRoot, "dist", "src", "cli", "run.js");

const contents = await readFile(binPath, "utf8");

if (!contents.startsWith("#!/usr/bin/env node\n")) {
  throw new Error(`Expected npm bin entrypoint to start with a Node shebang: ${binPath}`);
}

await chmod(binPath, 0o755);
