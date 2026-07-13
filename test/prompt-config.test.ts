import * as assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadPromptsConfig } from "../src/config/loader.js";

test("loadPromptsConfig returns undefined when prompts.json is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompts-config-test-"));
  try {
    const result = await loadPromptsConfig(tempDir);
    assert.equal(result, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPromptsConfig returns valid config when prompts.json is present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompts-config-test-"));
  try {
    const content = JSON.stringify({
      promptProfiles: {
        default: {
          plan: "prompts/plan.md",
          review: "prompts/review.md",
          waveAssessment: "prompts/wave-assessment.md",
          waveReplanning: "prompts/wave-replanning.md"
        }
      }
    });
    await writeFile(path.join(tempDir, "prompts.json"), content, "utf8");
    const result = await loadPromptsConfig(tempDir);
    assert.ok(result !== undefined);
    assert.equal(result.promptProfiles.default.plan, path.join("prompts", "plan.md"));
    assert.equal(result.promptProfiles.default.review, path.join("prompts", "review.md"));
    assert.equal(
      result.promptProfiles.default.waveAssessment,
      path.join("prompts", "wave-assessment.md")
    );
    assert.equal(
      result.promptProfiles.default.waveReplanning,
      path.join("prompts", "wave-replanning.md")
    );
    assert.equal(result.promptProfiles.default.implement, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPromptsConfig throws on invalid JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompts-config-test-"));
  try {
    await writeFile(path.join(tempDir, "prompts.json"), "{ invalid json", "utf8");
    await assert.rejects(() => loadPromptsConfig(tempDir), /invalid JSON/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPromptsConfig throws when promptProfiles is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompts-config-test-"));
  try {
    await writeFile(path.join(tempDir, "prompts.json"), JSON.stringify({ foo: "bar" }), "utf8");
    await assert.rejects(() => loadPromptsConfig(tempDir), /promptProfiles/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPromptsConfig throws when promptProfiles.default is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompts-config-test-"));
  try {
    await writeFile(
      path.join(tempDir, "prompts.json"),
      JSON.stringify({ promptProfiles: {} }),
      "utf8"
    );
    await assert.rejects(() => loadPromptsConfig(tempDir), /promptProfiles\.default/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPromptsConfig throws when a profile entry is not a non-empty string", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompts-config-test-"));
  try {
    const content = JSON.stringify({
      promptProfiles: {
        default: { plan: 42 }
      }
    });
    await writeFile(path.join(tempDir, "prompts.json"), content, "utf8");
    await assert.rejects(() => loadPromptsConfig(tempDir), /promptProfiles\.default\.plan/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadPromptsConfig throws when a profile entry is absolute or traverses outside", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "prompts-config-test-"));
  try {
    // Test absolute path
    const absoluteContent = JSON.stringify({
      promptProfiles: {
        default: { plan: "/etc/passwd" }
      }
    });
    await writeFile(path.join(tempDir, "prompts.json"), absoluteContent, "utf8");
    await assert.rejects(() => loadPromptsConfig(tempDir), /must be relative/);

    // Test traversal
    const traversalContent = JSON.stringify({
      promptProfiles: {
        default: { plan: "../outside.md" }
      }
    });
    await writeFile(path.join(tempDir, "prompts.json"), traversalContent, "utf8");
    await assert.rejects(() => loadPromptsConfig(tempDir), /must stay within the management directory/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
