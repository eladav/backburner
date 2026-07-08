import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/loader.js";

async function setupManagementDir(prefix: string) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const managementDir = path.join(tempDir, "management");
  await mkdir(managementDir, { recursive: true });
  // Required files for loadConfig
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
  await writeFile(
    path.join(managementDir, "mcps.json"),
    JSON.stringify({ mcps: [] }),
    "utf8"
  );
  return { tempDir, managementDir };
}

test("loadConfig returns empty sensors/controllers when capabilities.json is missing", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-missing-");
  try {
    const config = await loadConfig(managementDir);
    assert.deepEqual(config.capabilities.sensors, []);
    assert.deepEqual(config.capabilities.controllers, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig parses valid sensor capability", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-sensor-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "github-issues": {
            uses: "github",
            observes: "issues-and-prs",
            cadence: "every-orchestrator-run",
            scope: "repository"
          }
        }
      }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.deepEqual(config.capabilities.sensors, [
      {
        name: "github-issues",
        uses: "github",
        observes: "issues-and-prs",
        cadence: "every-orchestrator-run",
        scope: "repository"
      }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig parses valid controller capability", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-controller-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "pr-commenter": {
            uses: "github",
            grants: ["comment-on-prs"],
            approval: "required"
          }
        }
      }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.deepEqual(config.capabilities.controllers, [
      {
        name: "pr-commenter",
        uses: "github",
        grants: ["comment-on-prs"],
        approval: "required"
      }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig parses mixed sensors and controllers", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-mixed-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "s1": { uses: "m1", observes: "package-docs" }
        },
        controllers: {
          "c1": { uses: "m1", grants: ["open-issues"] }
        }
      }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.equal(config.capabilities.sensors.length, 1);
    assert.equal(config.capabilities.sensors[0]?.name, "s1");
    assert.equal(config.capabilities.controllers.length, 1);
    assert.equal(config.capabilities.controllers[0]?.name, "c1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects duplicate capability names across sensors and controllers", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-dup-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "common": { uses: "m1", observes: "package-docs" }
        },
        controllers: {
          "common": { uses: "m1", grants: ["open-issues"] }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /duplicate capability name "common" across sensors and controllers/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown top-level fields in capabilities.json", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-top-unknown-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {},
        extra: true
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: Unrecognized key: "extra"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown fields inside a sensor object", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-sensor-unknown-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "s1": { uses: "m1", observes: "package-docs", extra: true }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: sensors\.s1 Unrecognized key: "extra"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown fields inside a controller object", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-controller-unknown-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "c1": { uses: "m1", grants: ["open-issues"], extra: true }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: controllers\.c1 Unrecognized key: "extra"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects sensor with 'grants' field", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-sensor-grants-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "s1": { uses: "m1", observes: "package-docs", grants: ["open-issues"] }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: sensors\.s1\.grants sensor capability must not include "grants"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects controller with 'observes' field", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-controller-obs-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "c1": { uses: "m1", grants: ["open-issues"], observes: "package-docs" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: controllers\.c1\.observes controller capability must not include "observes"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects sensor missing 'observes'", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-sensor-missing-obs-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "s1": { uses: "m1" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: sensors\.s1\.observes (Required|Invalid option)/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects controller missing 'grants'", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-controller-missing-grants-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "c1": { uses: "m1" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: controllers\.c1\.grants controller "grants" must be an array of valid grant values/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown 'observes' value", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-obs-invalid-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "s1": { uses: "m1", observes: "invalid" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: sensors\.s1\.observes (Invalid enum value|Invalid option)/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown 'grants' value", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-grants-invalid-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "c1": { uses: "m1", grants: ["invalid"] }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: controllers\.c1\.grants\[0\] (Invalid enum value|Invalid option)/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown 'scope' value", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-scope-invalid-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "s1": { uses: "m1", observes: "package-docs", scope: "invalid" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: sensors\.s1\.scope (Invalid enum value|Invalid option)/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown 'cadence' value", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-cadence-invalid-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "s1": { uses: "m1", observes: "package-docs", cadence: "invalid" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: sensors\.s1\.cadence (Invalid enum value|Invalid option)/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown 'approval' value", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-approval-invalid-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "c1": { uses: "m1", grants: ["open-issues"], approval: "invalid" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: controllers\.c1\.approval (Invalid enum value|Invalid option)/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects credential-like fields in capability objects", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-creds-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "s1": { uses: "m1", observes: "package-docs", apiKey: "secret" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: sensors\.s1\.apiKey banned field "apiKey"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects provider/url fields in capability objects", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-loc-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "c1": { uses: "m1", grants: ["open-issues"], url: "http://bad" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: controllers\.c1\.url banned field "url"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts empty sensors/controllers maps", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-empty-maps-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {},
        controllers: {}
      }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.deepEqual(config.capabilities.sensors, []);
    assert.deepEqual(config.capabilities.controllers, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects empty capability names", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-empty-name-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        sensors: {
          "": { uses: "m1", observes: "package-docs" }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: sensors\. capability name must be a non-empty string/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects whitespace capability names", async () => {
  const { tempDir, managementDir } = await setupManagementDir("aog-caps-ws-name-");
  try {
    await writeFile(
      path.join(managementDir, "capabilities.json"),
      JSON.stringify({
        controllers: {
          "   ": { uses: "m1", grants: ["open-issues"] }
        }
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /capabilities\.json: controllers\.(\s+)?capability name must be a non-empty string/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
