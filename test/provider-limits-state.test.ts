import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { StateStore } from "../src/state/loader.js";
import { ProviderLimitRecord } from "../src/state/types.js";
import { AgentProvider } from "../src/config/types.js";

test("StateStore loads empty provider limits default when file does not exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aog-provider-limits-empty-"));
  try {
    const store = new StateStore(tempDir);
    const state = await store.load();
    assert.deepEqual(state.providerLimits, []);

    const limits = await store.loadProviderLimitsState();
    assert.deepEqual(limits, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore round-trips provider limits and sorts keys alphabetically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aog-provider-limits-roundtrip-"));
  try {
    const store = new StateStore(tempDir);
    const limits: ProviderLimitRecord[] = [
      {
        provider: "claude",
        status: "limited",
        limitType: "weekly",
        detectedAt: "2026-06-30T12:00:00.000Z",
        resetTime: "2026-07-07T12:00:00.000Z",
        updatedAt: "2026-06-30T12:00:00.000Z"
      },
      {
        provider: "codex",
        status: "available",
        updatedAt: "2026-06-30T12:00:00.000Z"
      },
      {
        provider: "antigravity",
        status: "limited",
        limitType: "session",
        detectedAt: "2026-06-30T15:00:00.000Z",
        updatedAt: "2026-06-30T12:00:00.000Z"
      },
      {
        provider: "opencode",
        status: "available",
        updatedAt: "2026-06-30T12:00:00.000Z"
      }
    ];

    await store.writeProviderLimitState(limits);

    const filePath = path.join(tempDir, "provider-limits.json");
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);

    // Verify key sorting in written JSON file
    const keys = parsed.providerLimits.map((l: any) => l.provider);
    assert.deepEqual(keys, ["antigravity", "claude", "codex", "opencode"]);

    // Verify roundtrip loading
    const loadedLimits = await store.loadProviderLimitsState();
    assert.deepEqual(loadedLimits, [
      {
        provider: "antigravity",
        status: "limited",
        limitType: "session",
        detectedAt: "2026-06-30T15:00:00.000Z",
        updatedAt: "2026-06-30T12:00:00.000Z"
      },
      {
        provider: "claude",
        status: "limited",
        limitType: "weekly",
        detectedAt: "2026-06-30T12:00:00.000Z",
        resetTime: "2026-07-07T12:00:00.000Z",
        updatedAt: "2026-06-30T12:00:00.000Z"
      },
      {
        provider: "codex",
        status: "available",
        updatedAt: "2026-06-30T12:00:00.000Z"
      },
      {
        provider: "opencode",
        status: "available",
        updatedAt: "2026-06-30T12:00:00.000Z"
      }
    ]);

    const state = await store.load();
    assert.deepEqual(state.providerLimits, loadedLimits);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore loadProviderLimitsState validation diagnostics on corrupted content", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aog-provider-limits-corrupted-"));
  try {
    const store = new StateStore(tempDir);
    const invalidJson = {
      providerLimits: [
        {
          provider: "claude",
          status: "blocked", // invalid status
          limitType: "weekly",
          detectedAt: "2026-06-30T12:00:00.000Z",
          updatedAt: "2026-06-30T12:00:00.000Z"
        }
      ]
    };

    await writeFile(path.join(tempDir, "provider-limits.json"), JSON.stringify(invalidJson), "utf8");

    const errors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      errors.push(args.join(" "));
    };

    try {
      await assert.rejects(
        () => store.load(),
        (err: any) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("status") || err.message.includes("Invalid enum value"));
          return true;
        }
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.ok(errors.some(msg => msg.includes("blocked") && (msg.includes("status") || msg.includes("Invalid enum value"))));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore loadProviderLimitsState validation diagnostics on unrecognized fields (strict)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aog-provider-limits-unrecognized-"));
  try {
    const store = new StateStore(tempDir);
    const invalidJson = {
      providerLimits: [
        {
          provider: "claude",
          status: "limited",
          limitType: "weekly",
          detectedAt: "2026-06-30T12:00:00.000Z",
          updatedAt: "2026-06-30T12:00:00.000Z",
          extraField: "some-value"
        }
      ]
    };

    await writeFile(path.join(tempDir, "provider-limits.json"), JSON.stringify(invalidJson), "utf8");

    const errors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      errors.push(args.join(" "));
    };

    try {
      await assert.rejects(
        () => store.load(),
        (err: any) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("Unrecognized key"));
          return true;
        }
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.ok(errors.some(msg => msg.includes("extraField") && msg.includes("Unrecognized key")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
