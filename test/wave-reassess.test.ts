import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseWaveReassessCommand } from "../src/tasks/wave-reassess.js";

test("parseWaveReassessCommand accepts the strict two-non-empty-line command", () => {
  assert.deepEqual(
    parseWaveReassessCommand("wave-reassess\nreason: New evidence is available."),
    { reason: "New evidence is available." }
  );
  assert.deepEqual(
    parseWaveReassessCommand("\nwave-reassess\r\n\r\nreason: Accepted risk.\n"),
    { reason: "Accepted risk." }
  );
});

test("parseWaveReassessCommand rejects malformed commands for discussion routing", () => {
  const malformed = [
    "wave-reassess",
    "Wave-reassess\nreason: New evidence.",
    " wave-reassess\nreason: New evidence.",
    "wave-reassess\nReason: New evidence.",
    "wave-reassess\nreason:",
    "wave-reassess\nreason:   ",
    "wave-reassess\nreason: New evidence.\nplease proceed",
    "prefix\nwave-reassess\nreason: New evidence."
  ];

  for (const body of malformed) {
    assert.equal(parseWaveReassessCommand(body), undefined, body);
  }
});
