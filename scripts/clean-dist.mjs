#!/usr/bin/env node
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

await rm(path.join(repoRoot, "dist"), { recursive: true, force: true });
