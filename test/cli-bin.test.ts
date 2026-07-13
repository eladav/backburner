import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("compiled npm bin runs through the platform entrypoint", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-bin-"));

  try {
    const entrypoint = path.join(process.cwd(), "dist", "src", "cli", "run.js");
    const bin = await createPlatformBin(tempDir, entrypoint);

    const { stdout } = await execFileAsync(
      bin.command,
      bin.args,
      { cwd: process.cwd() }
    );

    assert.equal(stdout.trim(), "[]");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("compiled entrypoint prints usage for --help", async () => {
  const entrypoint = path.join(process.cwd(), "dist", "src", "cli", "run.js");

  const { stdout } = await execFileAsync(process.execPath, [entrypoint, "--help"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /Expected command: backburner run/);
});

test("compiled entrypoint prints usage for command --help without running the command", async () => {
  const entrypoint = path.join(process.cwd(), "dist", "src", "cli", "run.js");

  for (const command of ["init", "run"]) {
    const { stdout } = await execFileAsync(process.execPath, [entrypoint, command, "--help"], {
      cwd: process.cwd()
    });

    assert.match(stdout, /Expected command: backburner run/);
  }
});

async function createPlatformBin(
  tempDir: string,
  entrypoint: string
): Promise<{ command: string; args: string[] }> {
  const cliArgs = ["journal", "--outputs-dir", path.join(tempDir, "outputs"), "--last", "1", "--json"];

  if (process.platform === "win32") {
    return {
      command: process.execPath,
      args: [entrypoint, ...cliArgs]
    };
  }

  const binPath = path.join(tempDir, "backburner");
  await symlink(entrypoint, binPath);
  return { command: binPath, args: cliArgs };
}
