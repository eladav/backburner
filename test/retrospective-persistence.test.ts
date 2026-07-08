import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli/run.js";

test("runCli persists retrospective blocked state even when no tasks are derived", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-retro-persistence-"));
  const managementDir = path.join(tempDir, "management");
  const stateDir = path.join(managementDir, "state");
  const codeRoot = path.join(tempDir, "code-root");

  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(codeRoot, { recursive: true });

    // 1. Config with NO retrospective agent
    await writeFile(
      path.join(managementDir, "repos.json"),
      JSON.stringify({ allowedUsers: ["owner"], repos: [] }),
      "utf8"
    );
    await writeFile(
      path.join(managementDir, "agents.json"),
      JSON.stringify({
        agents: [
          {
            id: "strong-agent",
            provider: "codex",
            modelClass: "strong",
            roles: ["discussion"], // No "retrospective" role
            command: "mock",
            enabled: true
          }
        ]
      }),
      "utf8"
    );

    // 2. Initial state with a 'new' candidate
    const candidatesPath = path.join(stateDir, "retrospective-candidates.json");
    const candidate = {
      id: "c1",
      sourceWorkstreamId: "ws1",
      repoId: "repo1",
      repoSlug: "owner/repo1",
      origin: { type: "issue", number: 1 },
      terminalResolution: "merged",
      detectedAt: "2026-06-04T12:00:00Z",
      resolvedAt: "2026-06-04T12:00:00Z",
      status: "new",
      labels: [],
      sourceSummary: "summary",
      taskSummary: { total: 1, completed: 1, failed: 0, kinds: [], taskIds: [] },
      executionSummary: { total: 1, providers: [], models: [], roles: [], executionIds: [] },
      artifactReferences: [],
      evidenceReferences: []
    };
    await writeFile(candidatesPath, JSON.stringify({ retrospectiveCandidates: [candidate] }, null, 2), "utf8");

    // 3. Run CLI
    await runCli(["run", "--code-root", codeRoot], {
      managementDir,
      stateDir,
      syncService: {
        async syncRepository() { return {} as any; }
      },
      scanService: {
        async scanRepositories() {
          return {
            issues: [],
            prs: [],
            comments: [],
            repoResults: [],
            failures: []
          };
        }
      },
      agentRunner: {
        async dispatch() { return { taskStatus: "completed", execution: {} as any }; }
      },
      logger: {
        info: () => undefined,
        warn: () => undefined
      }
    });

    // 4. Verify that candidate status is now 'blocked' in PERSISTED state
    const updatedData = JSON.parse(await readFile(candidatesPath, "utf8"));
    const updatedCandidates = updatedData.retrospectiveCandidates;
    assert.equal(updatedCandidates.length, 1);
    assert.equal(updatedCandidates[0].id, "c1");
    assert.equal(updatedCandidates[0].status, "blocked", "Candidate should be persisted as 'blocked' even if no tasks were derived");

  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
