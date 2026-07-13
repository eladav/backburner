import * as assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import {
  NodeReadlinePrompter,
  parseTextMultiSelectAnswer
} from "../src/onboarding/prompt.js";

class CaptureOutput extends Writable {
  isTTY = true;
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }
}

interface TtyInput extends PassThrough {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  rawModes: boolean[];
}

function makeTtyInput(): TtyInput {
  const input = new PassThrough() as TtyInput;
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.rawModes.push(mode);
  };
  return input;
}

test("parseTextMultiSelectAnswer parses comma-separated selections", () => {
  assert.deepEqual(parseTextMultiSelectAnswer("1, 3, 3", 4), {
    ok: true,
    indices: [0, 2]
  });
});

test("parseTextMultiSelectAnswer supports all and empty defaults", () => {
  assert.deepEqual(parseTextMultiSelectAnswer("all", 3), {
    ok: true,
    indices: [0, 1, 2]
  });
  assert.deepEqual(parseTextMultiSelectAnswer("", 3, [1]), {
    ok: true,
    indices: [1]
  });
});

test("parseTextMultiSelectAnswer rejects out-of-range numbers", () => {
  assert.deepEqual(parseTextMultiSelectAnswer("4", 3), {
    ok: false,
    invalidPart: "4"
  });
});

test("NodeReadlinePrompter.multiSelect uses checkbox keys on TTY", async () => {
  const input = makeTtyInput();
  const output = new CaptureOutput();
  const prompter = new NodeReadlinePrompter({ input, output });

  const selection = prompter.multiSelect("Select repos:", ["repo-a", "repo-b"], [0]);
  setImmediate(() => {
    input.write("\u001b[B");
    input.write(" ");
    input.write("\r");
  });

  assert.deepEqual(await selection, [0, 1]);
  assert.equal(input.rawModes.at(-1), false);
  assert.ok(
    output.chunks.join("").includes("Use ↑/↓ to move, space to toggle, enter to confirm.")
  );

  prompter.close();
  input.destroy();
});
