import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadCapabilitiesConfig, loadConfig } from "../src/config/loader.js";

async function setupManagementDir(prefix: string) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const managementDir = path.join(tempDir, "management");
  await mkdir(managementDir, { recursive: true });
  return { tempDir, managementDir };
}

async function setupFullManagementDir(prefix: string) {
  const { tempDir, managementDir } = await setupManagementDir(prefix);
  await writeFile(
    path.join(managementDir, "repos.json"),
    JSON.stringify({ allowedUsers: [], repos: [] }),
    "utf8"
  );
  await writeFile(
    path.join(managementDir, "agents.json"),
    JSON.stringify({ agents: [] }),
    "utf8"
  );
  return { tempDir, managementDir };
}

test("loadCapabilitiesConfig returns empty when capabilities.json is missing", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-cap-missing-");
  try {
    const result = await loadCapabilitiesConfig(managementDir);
    assert.deepEqual(result, { sensors: [], controllers: [] });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadCapabilitiesConfig parses sensor and adds name from key", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-cap-sensor-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "issue-inbox": {
            uses: "github",
            observes: "issues-and-prs",
            cadence: "every-orchestrator-run",
            scope: "repository"
          }
        }
      }),
      "utf8"
    );
    const result = await loadCapabilitiesConfig(managementDir);
    assert.equal(result.sensors.length, 1);
    assert.equal(result.sensors[0]!.name, "issue-inbox");
    assert.equal(result.sensors[0]!.uses, "github");
    assert.equal(result.sensors[0]!.observes, "issues-and-prs");
    assert.equal(result.sensors[0]!.cadence, "every-orchestrator-run");
    assert.equal(result.sensors[0]!.scope, "repository");
    assert.deepEqual(result.controllers, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadCapabilitiesConfig parses sensor without optional fields", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-cap-sensor-minimal-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "docs-ctx": { uses: "context7", observes: "package-docs" }
        }
      }),
      "utf8"
    );
    const result = await loadCapabilitiesConfig(managementDir);
    assert.equal(result.sensors[0]!.name, "docs-ctx");
    assert.equal(result.sensors[0]!.cadence, undefined);
    assert.equal(result.sensors[0]!.scope, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadCapabilitiesConfig parses controller and adds name from key", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-cap-controller-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "pr-commenter": {
            uses: "github",
            grants: ["comment-on-prs", "comment-on-issues"],
            approval: "not-required"
          }
        }
      }),
      "utf8"
    );
    const result = await loadCapabilitiesConfig(managementDir);
    assert.equal(result.controllers.length, 1);
    assert.equal(result.controllers[0]!.name, "pr-commenter");
    assert.equal(result.controllers[0]!.uses, "github");
    assert.deepEqual(result.controllers[0]!.grants, ["comment-on-prs", "comment-on-issues"]);
    assert.equal(result.controllers[0]!.approval, "not-required");
    assert.deepEqual(result.sensors, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadCapabilitiesConfig defaults controller approval to required", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-cap-approval-default-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "issue-manager": { uses: "github", grants: ["open-issues"] }
        }
      }),
      "utf8"
    );
    const result = await loadCapabilitiesConfig(managementDir);
    assert.equal(result.controllers[0]!.approval, "required");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadCapabilitiesConfig parses mixed sensors and controllers", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-cap-mixed-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "s1": { uses: "u1", observes: "package-docs" }
        },
        controllers: {
          "c1": { uses: "u2", grants: ["open-issues"] }
        }
      }),
      "utf8"
    );
    const result = await loadCapabilitiesConfig(managementDir);
    assert.equal(result.sensors.length, 1);
    assert.equal(result.controllers.length, 1);
    assert.equal(result.sensors[0]!.name, "s1");
    assert.equal(result.controllers[0]!.name, "c1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadCapabilitiesConfig throws with file path prefix on invalid file", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-cap-invalid-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "bad": { uses: "u1" }  // missing observes
        }
      }),
      "utf8"
    );
    await assert.rejects(
      () => loadCapabilitiesConfig(managementDir),
      /capabilities\.json:/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig includes capabilities in returned object", async () => {
  const { tempDir, managementDir } = await setupFullManagementDir("aog-cap-loadconfig-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "gh-reader": { uses: "github", observes: "issues-and-prs" }
        }
      }),
      "utf8"
    );
    const config = await loadConfig(managementDir);
    assert.ok(config.capabilities);
    assert.equal(config.capabilities.sensors.length, 1);
    assert.equal(config.capabilities.sensors[0]!.name, "gh-reader");
    assert.deepEqual(config.capabilities.controllers, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig returns empty capabilities when capabilities.json is missing", async () => {
  const { tempDir, managementDir } = await setupFullManagementDir("aog-cap-loadconfig-missing-");
  try {
    const config = await loadConfig(managementDir);
    assert.deepEqual(config.capabilities, { sensors: [], controllers: [] });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadCapabilitiesConfig returns empty for empty capabilities.json object", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-cap-empty-file-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({}),
      "utf8"
    );
    const result = await loadCapabilitiesConfig(managementDir);
    assert.deepEqual(result, { sensors: [], controllers: [] });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
