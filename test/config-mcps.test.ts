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
  return { tempDir, managementDir };
}

test("loadConfig returns empty mcps array when mcps.json is missing", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-missing-");
  try {
    const config = await loadConfig(managementDir);
    assert.deepEqual(config.mcps, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig parses valid mcps.json with string entries", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-strings-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: ["github", "context7"]
      }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.deepEqual(config.mcps, [
      { handle: "github", smitheryId: "github" },
      { handle: "context7", smitheryId: "context7" }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig parses valid mcps.json with object entries", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-objects-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: [
          { as: "github-work", id: "github" },
          { as: "github-home", id: "github" }
        ]
      }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.deepEqual(config.mcps, [
      { handle: "github-work", smitheryId: "github" },
      { handle: "github-home", smitheryId: "github" }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig parses valid mcps.json with mixed entries", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-mixed-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: ["github", { as: "foo", id: "bar" }]
      }),
      "utf8"
    );

    const config = await loadConfig(managementDir);
    assert.deepEqual(config.mcps, [
      { handle: "github", smitheryId: "github" },
      { handle: "foo", smitheryId: "bar" }
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects duplicate MCP handles (string vs string)", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-dup-1-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: ["github", "github"]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[1\] duplicate MCP handle "github"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects duplicate MCP handles (string vs object)", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-dup-2-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: ["github", { as: "github", id: "other" }]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[1\] duplicate MCP handle "github"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown fields in MCP object", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-unknown-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: [{ as: "github", id: "github", extra: true }]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\]\.extra has unknown field "extra"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unsupported fields (credential-like)", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-unsupported-");
  try {
    // Test apiKey
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: [{ as: "github", id: "github", apiKey: "secret" }]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\]\.apiKey has unsupported field "apiKey"/
    );

    // Test auth
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: [{ as: "github", id: "github", auth: "secret" }]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\]\.auth has unsupported field "auth"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown fields at the root of mcps.json", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-root-unknown-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: [],
        extra: true
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: Unrecognized key: "extra"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unsupported fields (location-like)", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-location-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: [{ as: "github", id: "github", provider: "smithery" }]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\]\.provider has unsupported field "provider"/
    );

    // Test url
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: [{ as: "github", id: "github", url: "http://localhost" }]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\]\.url has unsupported field "url"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects empty strings in mcps", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-empty-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: ["", "   "]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\] must be a non-empty string or an object with "as" and "id"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects MCP handles that cannot be broker namespaces", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-invalid-handle-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: ["cloud7.docs"]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\] must contain only letters, numbers, underscores, or hyphens/
    );

    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: [{ as: "cloud7.docs", id: "cloud7" }]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\]\.as must contain only letters, numbers, underscores, or hyphens/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects empty as or id in MCP object", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-empty-obj-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({
        mcps: [{ as: "", id: "github" }]
      }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\]\.as must be a non-empty string/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects malformed top-level shape", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-malformed-top-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify(["github"]),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: Invalid input: expected object, received array/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects malformed mcps field", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-malformed-mcps-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({ mcps: "github" }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps "mcps" must be an array/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid entries (numbers/null)", async () => {
  const { tempDir, managementDir } = await setupManagementDir("backburner-mcps-invalid-entries-");
  try {
    await writeFile(
      path.join(managementDir, "mcps.json"),
      JSON.stringify({ mcps: [123, null] }),
      "utf8"
    );

    await assert.rejects(
      () => loadConfig(managementDir),
      /mcps\.json: mcps\[0\] must be a non-empty string or an object with "as" and "id"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
