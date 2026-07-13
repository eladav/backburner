#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const args = process.argv.slice(2);
const npmInvocation = resolveNpmInvocation();

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`install-local-package failed: ${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const prefix = readStringFlag(args, "--prefix");
  const keepTarball = args.includes("--keep-tarball");
  const packDir = await mkdtemp(path.join(os.tmpdir(), "backburner-pack-"));

  try {
    const packResult = runNpm(["pack", "--pack-destination", packDir], repoRoot);
    const tarballName = packResult.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    if (!tarballName?.endsWith(".tgz")) {
      throw new Error(`Could not determine packed tarball from npm pack output: ${packResult.stdout}`);
    }

    const tarballPath = path.join(packDir, tarballName);
    const installArgs = ["install", "--global"];
    if (prefix !== undefined) {
      installArgs.push("--prefix", path.resolve(prefix));
    }
    installArgs.push(tarballPath);

    runNpm(installArgs, repoRoot);

    const installedCommand = resolveInstalledCommand(prefix);

    const verifyOutputsDir = path.join(packDir, "verify-outputs");
    const verifyResult = run(
      installedCommand.command,
      [...installedCommand.args, "journal", "--outputs-dir", verifyOutputsDir, "--last", "1", "--json"],
      repoRoot
    );
    assertJsonArrayOutput(verifyResult.stdout, installedCommand.displayName);

    process.stdout.write(`Installed local package from ${tarballPath}\n`);
    process.stdout.write(`Verified command: ${installedCommand.displayName}\n`);
    if (!keepTarball) {
      process.stdout.write("Use --keep-tarball to preserve the generated package archive.\n");
    }
  } finally {
    if (!keepTarball) {
      await rm(packDir, { recursive: true, force: true });
    }
  }
}

function readStringFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function run(command, commandArgs, cwd) {
  process.stdout.write(`> ${[command, ...commandArgs].join(" ")}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status}`);
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  return { stdout: result.stdout };
}

function runNpm(commandArgs, cwd) {
  return run(npmInvocation.command, [...npmInvocation.args, ...commandArgs], cwd);
}

function resolveNpmInvocation() {
  const bundledNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmCli = [process.env.npm_execpath, bundledNpmCli].find(
    (candidate) => candidate !== undefined && existsSync(candidate)
  );

  if (npmCli !== undefined) {
    return { command: process.execPath, args: [npmCli] };
  }

  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [] };
}

function resolveInstalledCommand(prefix) {
  const resolvedPrefix = prefix !== undefined ? path.resolve(prefix) : readGlobalNpmPrefix();
  const binCommand = path.join(resolvedPrefix, process.platform === "win32" ? "backburner.cmd" : "bin/backburner");

  if (process.platform !== "win32") {
    return { command: binCommand, args: [], displayName: binCommand };
  }

  if (!existsSync(binCommand)) {
    throw new Error(`Installed command was not created: ${binCommand}`);
  }

  const cliEntryPoint = path.join(
    resolvedPrefix,
    "node_modules",
    "@backburner",
    "cli",
    "dist",
    "src",
    "cli",
    "run.js"
  );
  if (!existsSync(cliEntryPoint)) {
    throw new Error(`Installed CLI entry point was not found: ${cliEntryPoint}`);
  }

  return { command: process.execPath, args: [cliEntryPoint], displayName: binCommand };
}

function readGlobalNpmPrefix() {
  const result = runNpm(["prefix", "--global"], repoRoot);
  const prefix = result.stdout.trim();
  if (!prefix) {
    throw new Error("Could not determine npm global prefix for installed command verification");
  }

  return prefix;
}

function assertJsonArrayOutput(stdout, command) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error(`Installed command produced no output during verification: ${command}`);
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("not an array");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Installed command did not produce journal JSON during verification: ${reason}`);
  }
}
