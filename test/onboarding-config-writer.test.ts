import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ConfigWriter } from "../src/onboarding/config-writer.js";
import { DEFAULT_BACKBURNER_LABELS } from "../src/onboarding/config-writer.js";
import type { ConfigDraft } from "../src/onboarding/types.js";
import { ReposConfigFileSchema, AgentsConfigFileSchema } from "../src/config/schemas.js";

function makeDraft(managementDir: string): ConfigDraft {
  return {
    codeRoot: "/code",
    managementDir,
    outputsDir: "/outputs",
    logDir: "/outputs/logs",
    workspacesDir: "/workspaces",
    allowedUsers: ["octocat"],
    repos: [
      {
        owner: "myorg",
        name: "my-repo",
        localPath: "myorg/my-repo",
        defaultBranch: "main",
        enabled: true,
        labels: { ...DEFAULT_BACKBURNER_LABELS }
      }
    ],
    agents: [
      {
        id: "claude-strong",
        provider: "claude",
        command: "claude",
        timeoutMs: 1_200_000,
        model: "claude-sonnet-4-6",
        modelClass: "strong",
        roles: ["planning", "review", "discussion", "implementation_manager", "retrospective"],
        enabled: true
      },
      {
        id: "antigravity-cheap",
        provider: "antigravity",
        command: "agy",
        timeoutMs: 1_200_000,
        model: "Gemini 3.5 Flash (Low)",
        modelClass: "cheap",
        roles: ["implementation", "discussion"],
        enabled: true
      }
    ]
  };
}

test("ConfigWriter: fresh config generation writes both files", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-config-writer-"));

  try {
    const managementDir = path.join(tmpDir, "management");
    const draft = makeDraft(managementDir);
    const writer = new ConfigWriter();

    const result = await writer.write(draft);

    assert.equal(result.skippedExisting.length, 0);

    const reposRaw = await fs.readFile(result.reposFile, "utf8");
    const agentsRaw = await fs.readFile(result.agentsFile, "utf8");

    const repos = JSON.parse(reposRaw);
    const agents = JSON.parse(agentsRaw);

    assert.equal(repos.allowedUsers[0], "octocat");
    assert.equal(repos.repos[0].owner, "myorg");
    assert.equal(repos.repos[0].name, "my-repo");
    assert.equal(repos.repos[0].enabled, true);
    assert.equal(repos.repos[0].labels.agentInProgress, "backburner:in-progress");
    assert.equal(repos.repos[0].labels.agentProductApproved, "backburner:product-approved");
    assert.equal(repos.repos[0].reviewAutomation.maxTurns, 5);

    assert.equal(agents.agents[0].id, "claude-strong");
    assert.equal(agents.agents[0].provider, "claude");
    assert.equal(agents.agents[0].modelClass, "strong");
    assert.equal(agents.agents[0].timeoutMs, 1_200_000);
    assert.equal(agents.agents[1].provider, "antigravity");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Fix #7: validate generated config against existing Backburner schemas ────────────

test("ConfigWriter: generated repos.json is valid per ReposConfigFileSchema", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-schema-repos-"));

  try {
    const managementDir = path.join(tmpDir, "management");
    const draft = makeDraft(managementDir);
    const writer = new ConfigWriter();
    const result = await writer.write(draft);

    const raw = await fs.readFile(result.reposFile, "utf8");
    const parsed = ReposConfigFileSchema.safeParse(JSON.parse(raw));

    assert.ok(
      parsed.success,
      `repos.json failed schema validation: ${JSON.stringify(parsed.error?.issues)}`
    );
    assert.equal(parsed.data.allowedUsers[0], "octocat");
    assert.equal(parsed.data.repos[0]?.owner, "myorg");
    assert.equal(parsed.data.repos[0]?.enabled, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ConfigWriter: generated agents.json is valid per AgentsConfigFileSchema", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-schema-agents-"));

  try {
    const managementDir = path.join(tmpDir, "management");
    const draft = makeDraft(managementDir);
    const writer = new ConfigWriter();
    const result = await writer.write(draft);

    const raw = await fs.readFile(result.agentsFile, "utf8");
    const parsed = AgentsConfigFileSchema.safeParse(JSON.parse(raw));

    assert.ok(
      parsed.success,
      `agents.json failed schema validation: ${JSON.stringify(parsed.error?.issues)}`
    );
    assert.equal(parsed.data.agents[0]?.id, "claude-strong");
    assert.equal(parsed.data.agents[0]?.provider, "claude");
    assert.equal(parsed.data.agents[0]?.modelClass, "strong");
    assert.equal(parsed.data.agents[1]?.provider, "antigravity");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ConfigWriter: schema validates codex agent without model field", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-schema-codex-"));

  try {
    const managementDir = path.join(tmpDir, "management");
    const draft = makeDraft(managementDir);
    // Codex does not require a model field
    draft.agents = [
      {
        id: "codex-strong",
        provider: "codex",
        command: "codex",
        modelClass: "strong",
        roles: ["planning"],
        enabled: true
      }
    ];

    const writer = new ConfigWriter();
    const result = await writer.write(draft);

    const raw = await fs.readFile(result.agentsFile, "utf8");
    const parsed = AgentsConfigFileSchema.safeParse(JSON.parse(raw));
    assert.ok(parsed.success, "Codex agent without model must pass schema validation");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Existing-file preservation ────────────────────────────────────────────────

test("ConfigWriter: existing config is preserved when overwrite not requested", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-config-writer-existing-"));

  try {
    const managementDir = path.join(tmpDir, "management");
    await fs.mkdir(managementDir, { recursive: true });

    const reposFile = path.join(managementDir, "repos.json");
    const existingRepos = { allowedUsers: ["preserved"], repos: [] };
    await fs.writeFile(reposFile, JSON.stringify(existingRepos), "utf8");

    const draft = makeDraft(managementDir);
    const writer = new ConfigWriter();

    const result = await writer.write(draft, { overwriteRepos: false });

    assert.ok(result.skippedExisting.includes(reposFile));

    const raw = await fs.readFile(reposFile, "utf8");
    const content = JSON.parse(raw);
    assert.equal(content.allowedUsers[0], "preserved");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ConfigWriter: detectExisting correctly identifies present files", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-config-detect-"));

  try {
    const managementDir = path.join(tmpDir, "management");
    await fs.mkdir(managementDir, { recursive: true });
    await fs.writeFile(path.join(managementDir, "repos.json"), "{}", "utf8");

    const writer = new ConfigWriter();
    const result = await writer.detectExisting(managementDir);

    assert.equal(result.reposExists, true);
    assert.equal(result.agentsExists, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ConfigWriter: agents without model field omit the key", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-config-no-model-"));

  try {
    const managementDir = path.join(tmpDir, "management");
    const draft = makeDraft(managementDir);
    draft.agents = [
      {
        id: "codex-strong",
        provider: "codex",
        command: "codex",
        modelClass: "strong",
        roles: ["planning"],
        enabled: true
      }
    ];

    const writer = new ConfigWriter();
    const result = await writer.write(draft);

    const raw = await fs.readFile(result.agentsFile, "utf8");
    const agents = JSON.parse(raw);
    assert.ok(!("model" in agents.agents[0]));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("ConfigWriter: write below a file path throws", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backburner-config-blocked-path-"));

  try {
    const blockingFile = path.join(tmpDir, "not-a-directory");
    await fs.writeFile(blockingFile, "", "utf8");

    const writer = new ConfigWriter();
    const draft = makeDraft(path.join(blockingFile, "management"));

    await assert.rejects(() => writer.write(draft), (err) => {
      assert.ok(err instanceof Error);
      return true;
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
