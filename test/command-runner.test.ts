import * as assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  CommandExecutionError,
  ExecFileCommandRunner,
  terminateProcessTree
} from "../src/utils/command-runner.js";

test("ExecFileCommandRunner streams stdout and stderr chunks to observer callbacks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-command-runner-stream-"));
  const scriptPath = path.join(tempDir, "streaming.mjs");
  const runner = new ExecFileCommandRunner();
  const observed: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

  try {
    await writeFile(
      scriptPath,
      [
        'process.stdout.write("stdout-1\\n");',
        'process.stderr.write("stderr-1\\n");',
        "setTimeout(() => {",
        '  process.stdout.write("stdout-2\\n");',
        '  process.stderr.write("stderr-2\\n");',
        "}, 20);",
        "setTimeout(() => process.exit(0), 80);",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runner.run(process.execPath, [scriptPath], {
      onOutputChunk: (stream, chunk) => {
        observed.push({ stream, chunk });
      }
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /stdout-1/);
    assert.match(result.stdout, /stdout-2/);
    assert.match(result.stderr, /stderr-1/);
    assert.match(result.stderr, /stderr-2/);
    assert.ok(observed.some((entry) => entry.stream === "stdout" && entry.chunk.includes("stdout-1")));
    assert.ok(observed.some((entry) => entry.stream === "stderr" && entry.chunk.includes("stderr-1")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ExecFileCommandRunner writes configured stdin input to the child process", async () => {
  const runner = new ExecFileCommandRunner();

  const result = await runner.run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => { process.stdout.write(`received:${input}`); });"
      ].join("\n")
    ],
    {
      input: "hello from stdin"
    }
  );

  assert.equal(result.stdout, "received:hello from stdin");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
});

test("ExecFileCommandRunner rejects nonzero exits with captured output and command details", async () => {
  const runner = new ExecFileCommandRunner();

  await assert.rejects(
    runner.run(process.execPath, [
      "--input-type=module",
      "-e",
      [
        'process.stdout.write("before-failure\\n");',
        'process.stderr.write("failure-detail\\n");',
        "process.exit(7);"
      ].join("\n")
    ]),
    (error: unknown) => {
      assert.ok(error instanceof CommandExecutionError);
      assert.equal(error.command, process.execPath);
      assert.deepEqual(error.args.slice(0, 2), ["--input-type=module", "-e"]);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdout, "before-failure\n");
      assert.equal(error.stderr, "failure-detail\n");
      assert.match(error.message, /failure-detail/);
      return true;
    }
  );
});

test("ExecFileCommandRunner times out a descendant tree and retains captured output", { timeout: 3000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-command-runner-"));
  const scriptPath = path.join(tempDir, "descendant-tree.mjs");
  const runner = new ExecFileCommandRunner();
  const observed: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

  try {
    await writeFile(
      scriptPath,
      [
        'import { spawn } from "node:child_process";',
        "",
        'console.log("parent-start");',
        'console.error("parent-stderr");',
        "",
        "const child = spawn(process.execPath, [",
        '  "--input-type=module",',
        '  "-e",',
        '  "console.log(\'grandchild-start\'); console.error(\'grandchild-stderr\'); setInterval(() => {}, 1000);"',
        '], {',
        '  stdio: "inherit"',
        "});",
        "",
        "child.unref();",
        "setInterval(() => {}, 1000);",
        ""
      ].join("\n"),
      "utf8"
    );

    const start = performance.now();
    await assert.rejects(
      runner.run(process.execPath, [scriptPath], {
        timeoutMs: 500,
        onOutputChunk: (stream, chunk) => {
          observed.push({ stream, chunk });
        }
      }),
      (error: unknown) => {
        assert.ok(error instanceof CommandExecutionError);
        assert.equal(error.exitCode, 124);
        assert.match(error.message, /timed out after 500ms/);
        assert.match(error.stdout, /parent-start/);
        assert.match(error.stderr, /parent-stderr/);
        return true;
      }
    );

    const elapsedMs = performance.now() - start;
    assert.ok(
      elapsedMs < 2000,
      `timeout promise should settle promptly, but took ${elapsedMs.toFixed(1)}ms`
    );
    assert.ok(observed.some((entry) => entry.stream === "stdout" && entry.chunk.includes("parent-start")));
    assert.ok(observed.some((entry) => entry.stream === "stderr" && entry.chunk.includes("parent-stderr")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ExecFileCommandRunner preserves spawn options for normal launches without shell mode", async () => {
  const child = new FakeChildProcess(345);
  let call: SpawnCall | undefined;
  const runner = new ExecFileCommandRunner({
    platform: "linux",
    spawnProcess: (command, args, options) => {
      call = { command, args, options };
      process.nextTick(() => {
        child.stdout.write("ok");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child.asChildProcess();
    }
  });

  const result = await runner.run("tool", ["--flag"], {
    cwd: "/repo",
    env: {
      CUSTOM_ENV_VALUE: "custom"
    }
  });

  assert.equal(result.stdout, "ok");
  assert.ok(call);
  assert.equal(call.command, "tool");
  assert.deepEqual(call.args, ["--flag"]);
  assert.equal(call.options.cwd, "/repo");
  assert.equal(call.options.detached, true);
  assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(call.options.windowsHide, false);
  assert.equal(call.options.shell, undefined);
  assert.equal((call.options.env as NodeJS.ProcessEnv).CUSTOM_ENV_VALUE, "custom");
  assert.equal(
    findEnvironmentValue(call.options.env as NodeJS.ProcessEnv, "PATH"),
    findEnvironmentValue(process.env, "PATH")
  );
});

test("ExecFileCommandRunner maps signal-only close events to exit code 1", async () => {
  const child = new FakeChildProcess(456);
  const runner = new ExecFileCommandRunner({
    spawnProcess: () => {
      process.nextTick(() => {
        child.emit("close", null, "SIGTERM");
      });
      return child.asChildProcess();
    }
  });

  await assert.rejects(
    runner.run("tool", []),
    (error: unknown) => {
      assert.ok(error instanceof CommandExecutionError);
      assert.equal(error.exitCode, 1);
      assert.match(error.message, /command exited with code 1/);
      return true;
    }
  );
});

test("terminateProcessTree invokes Windows taskkill with expected arguments and options", () => {
  const taskkillChild = new FakeChildProcess(999);
  const calls: SpawnCall[] = [];

  terminateProcessTree({ pid: 1234 }, "SIGTERM", {
    platform: "win32",
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return taskkillChild.asChildProcess();
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "taskkill");
  assert.deepEqual(calls[0]?.args, ["/pid", "1234", "/T", "/F"]);
  assert.equal(calls[0]?.options.stdio, "ignore");
  assert.equal(calls[0]?.options.windowsHide, true);
  assert.equal(taskkillChild.unrefCalled, true);
});

test("terminateProcessTree ignores Windows taskkill spawn errors", () => {
  const taskkillChild = new FakeChildProcess(999);

  assert.doesNotThrow(() => {
    terminateProcessTree({ pid: 1234 }, "SIGTERM", {
      platform: "win32",
      spawnProcess: () => {
        process.nextTick(() => {
          taskkillChild.emit("error", new Error("taskkill unavailable"));
        });
        return taskkillChild.asChildProcess();
      }
    });
  });
});

test("terminateProcessTree tries POSIX process group first and falls back to child pid", () => {
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  terminateProcessTree({ pid: 1234 }, "SIGTERM", {
    platform: "linux",
    killProcess: (pid, signal) => {
      killCalls.push({ pid, signal });
      if (pid < 0) {
        throw new Error("no group");
      }
    }
  });

  assert.deepEqual(killCalls, [
    { pid: -1234, signal: "SIGTERM" },
    { pid: 1234, signal: "SIGTERM" }
  ]);
});

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function findEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  unrefCalled = false;

  constructor(readonly pid: number) {
    super();
  }

  unref(): void {
    this.unrefCalled = true;
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}
