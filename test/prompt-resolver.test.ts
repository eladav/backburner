import * as assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  loadLearningOverlays,
  mapTaskKindToPromptKey,
  mapTaskToPromptKey,
  resolveTaskPromptContent,
  type OverlayLoadContext
} from "../src/prompts/resolver.js";
import type { TaskRecord } from "../src/tasks/types.js";

const baseCtx: OverlayLoadContext = {
  repoId: "my-repo",
  provider: "claude",
  role: "planning",
  taskKind: "write_plan"
};

test("loadLearningOverlays returns empty array when learnings dir does not exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "overlay-test-"));
  try {
    const result = await loadLearningOverlays(baseCtx, tempDir);
    assert.deepEqual(result, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadLearningOverlays returns empty array when no overlay files exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "overlay-test-"));
  try {
    await mkdir(path.join(tempDir, "learnings"), { recursive: true });
    const result = await loadLearningOverlays(baseCtx, tempDir);
    assert.deepEqual(result, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadLearningOverlays loads global overlay when present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "overlay-test-"));
  try {
    const learnings = path.join(tempDir, "learnings");
    await mkdir(learnings, { recursive: true });
    await writeFile(path.join(learnings, "global.md"), "Global guidance.", "utf8");

    const result = await loadLearningOverlays(baseCtx, tempDir);
    assert.equal(result.length, 1);
    assert.ok(result[0]?.includes("Global guidance."));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadLearningOverlays returns overlays in broad-to-narrow order", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "overlay-test-"));
  try {
    const learnings = path.join(tempDir, "learnings");
    await mkdir(path.join(learnings, "roles"), { recursive: true });
    await mkdir(path.join(learnings, "repo-roles", "my-repo"), { recursive: true });
    await writeFile(path.join(learnings, "global.md"), "GLOBAL", "utf8");
    await writeFile(path.join(learnings, "roles", "planning.md"), "ROLE", "utf8");
    await writeFile(path.join(learnings, "repo-roles", "my-repo", "planning.md"), "REPO_ROLE", "utf8");

    const result = await loadLearningOverlays(baseCtx, tempDir);
    // global comes before role, role before repo_role
    assert.equal(result.length, 3);
    assert.ok(result[0]?.includes("GLOBAL"));
    assert.ok(result[1]?.includes("ROLE"));
    assert.ok(result[2]?.includes("REPO_ROLE"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadLearningOverlays ignores missing files without error", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "overlay-test-"));
  try {
    const learnings = path.join(tempDir, "learnings");
    await mkdir(learnings, { recursive: true });
    // Only write task-kinds overlay; all others are missing
    await mkdir(path.join(learnings, "task-kinds"), { recursive: true });
    await writeFile(path.join(learnings, "task-kinds", "write_plan.md"), "TASK_KIND", "utf8");

    const result = await loadLearningOverlays(baseCtx, tempDir);
    assert.equal(result.length, 1);
    assert.ok(result[0]?.includes("TASK_KIND"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadLearningOverlays skips empty files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "overlay-test-"));
  try {
    const learnings = path.join(tempDir, "learnings");
    await mkdir(learnings, { recursive: true });
    await writeFile(path.join(learnings, "global.md"), "   \n  ", "utf8");

    const result = await loadLearningOverlays(baseCtx, tempDir);
    assert.deepEqual(result, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadLearningOverlays with undefined repoId omits repo-scoped overlays", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "overlay-test-"));
  try {
    const learnings = path.join(tempDir, "learnings");
    await mkdir(path.join(learnings, "repos"), { recursive: true });
    await mkdir(learnings, { recursive: true });
    await writeFile(path.join(learnings, "repos", "my-repo.md"), "REPO", "utf8");
    await writeFile(path.join(learnings, "global.md"), "GLOBAL", "utf8");

    const ctx: OverlayLoadContext = { ...baseCtx, repoId: undefined };
    const result = await loadLearningOverlays(ctx, tempDir);
    // Only global should appear; repo file was written but repoId is undefined so it won't be checked
    assert.equal(result.length, 1);
    assert.ok(result[0]?.includes("GLOBAL"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("mapTaskKindToPromptKey returns correct public key for each task kind", () => {
  assert.equal(mapTaskKindToPromptKey("write_plan"), "plan");
  assert.equal(mapTaskKindToPromptKey("implement_plan"), "implement");
  assert.equal(mapTaskKindToPromptKey("review_pr"), "review");
  assert.equal(mapTaskKindToPromptKey("triage_issue"), undefined);
  assert.equal(mapTaskKindToPromptKey("respond_issue_comment"), "discuss");
  assert.equal(mapTaskKindToPromptKey("plan_breakdown"), "breakdown");
  assert.equal(mapTaskKindToPromptKey("wave_plan_assessment"), "waveAssessment");
  assert.equal(mapTaskKindToPromptKey("wave_plan_replanning"), "waveReplanning");
  assert.equal(mapTaskKindToPromptKey("extract_retrospective_problems"), "retrospectiveExtract");
  assert.equal(mapTaskKindToPromptKey("investigate_learning_opportunity"), "retrospectiveInvestigate");
  assert.equal(mapTaskKindToPromptKey("draft_management_learning_proposal"), "retrospectiveProposal");
  assert.equal(mapTaskKindToPromptKey("sync_parent_branch"), undefined);
  assert.equal(mapTaskKindToPromptKey("sync_parent_branch_preflight"), undefined);
});

test("mapTaskToPromptKey routes product-phase issue comments to product prompt", () => {
  assert.equal(
    mapTaskToPromptKey({
      kind: "respond_issue_comment",
      workflowPhase: "product_discovery"
    } as TaskRecord),
    "product"
  );
  assert.equal(
    mapTaskToPromptKey({
      kind: "respond_issue_comment",
      workflowPhase: "product_specification"
    } as TaskRecord),
    "product"
  );
  assert.equal(
    mapTaskToPromptKey({
      kind: "respond_issue_comment",
      workflowPhase: "planning"
    } as TaskRecord),
    "discuss"
  );
});

test("resolveTaskPromptContent returns built-in when promptsConfig is undefined", async () => {
  const result = await resolveTaskPromptContent("write_plan", undefined, "/any/path");
  assert.equal(result.source, "built-in");
  assert.equal(result.content, undefined);
});

test("resolveTaskPromptContent returns built-in when task kind has no mapping", async () => {
  const config = { promptProfiles: { default: { plan: "prompts/plan.md" } } };
  const result = await resolveTaskPromptContent("sync_parent_branch", config as any, "/any/path");
  assert.equal(result.source, "built-in");
});

test("resolveTaskPromptContent returns built-in when no config entry for that key", async () => {
  const config = { promptProfiles: { default: {} } };
  const result = await resolveTaskPromptContent("write_plan", config as any, "/any/path");
  assert.equal(result.source, "built-in");
});

test("resolveTaskPromptContent reads file when config entry exists and file is present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pr-resolver-test-"));
  try {
    const promptsDir = path.join(tempDir, "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(path.join(promptsDir, "plan.md"), "Custom plan instructions.", "utf8");

    const config = { promptProfiles: { default: { plan: "prompts/plan.md" } } };
    const result = await resolveTaskPromptContent("write_plan", config as any, tempDir);

    assert.equal(result.source, "config-file");
    assert.equal(result.content, "Custom plan instructions.");
    assert.ok(result.filePath?.includes("plan.md"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveTaskPromptContent uses product profile for product-phase issue comments", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pr-resolver-test-"));
  try {
    const promptsDir = path.join(tempDir, "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(path.join(promptsDir, "product.md"), "Product prompt.", "utf8");
    await writeFile(path.join(promptsDir, "discuss.md"), "Discussion prompt.", "utf8");

    const config = {
      promptProfiles: {
        default: {
          product: "prompts/product.md",
          discuss: "prompts/discuss.md"
        }
      }
    };
    const task = {
      kind: "respond_issue_comment",
      workflowPhase: "product_discovery"
    } as TaskRecord;

    const result = await resolveTaskPromptContent(task, config as any, tempDir);

    assert.equal(result.source, "config-file");
    assert.equal(result.content, "Product prompt.");
    assert.ok(result.filePath?.endsWith("product.md"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveTaskPromptContent supports wave task prompt overrides", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pr-resolver-test-"));
  try {
    const promptsDir = path.join(tempDir, "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(path.join(promptsDir, "wave-assessment.md"), "Assess wave.", "utf8");
    await writeFile(path.join(promptsDir, "wave-replanning.md"), "Replan wave.", "utf8");

    const config = {
      promptProfiles: {
        default: {
          waveAssessment: "prompts/wave-assessment.md",
          waveReplanning: "prompts/wave-replanning.md"
        }
      }
    };

    const assessment = await resolveTaskPromptContent("wave_plan_assessment", config as any, tempDir);
    const replanning = await resolveTaskPromptContent("wave_plan_replanning", config as any, tempDir);

    assert.equal(assessment.source, "config-file");
    assert.equal(assessment.content, "Assess wave.");
    assert.equal(replanning.source, "config-file");
    assert.equal(replanning.content, "Replan wave.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveTaskPromptContent falls back to built-in when prompt file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pr-resolver-test-"));
  try {
    const config = { promptProfiles: { default: { plan: "prompts/plan.md" } } };
    const result = await resolveTaskPromptContent("write_plan", config as any, tempDir);
    assert.equal(result.source, "built-in");
    assert.equal(result.content, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
