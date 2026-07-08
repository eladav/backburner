import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { StateStore } from "../src/state/loader.js";

test("StateStore initializes missing retrospective state files with defaults", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-retrospective-state-"));

  try {
    const store = new StateStore(tempDir);
    const state = await store.load();

    assert.deepEqual(state.retrospectiveCandidates, []);
    assert.deepEqual(state.retrospectiveProblems, []);
    assert.deepEqual(state.retrospectiveOpportunities, []);
    assert.deepEqual(state.learningProposals, []);
    assert.deepEqual(state.managementPrs, []);

    const candidatesState = await readFile(path.join(tempDir, "retrospective-candidates.json"), "utf8");
    const problemsState = await readFile(path.join(tempDir, "retrospective-problems.json"), "utf8");
    const opportunitiesState = await readFile(path.join(tempDir, "retrospective-opportunities.json"), "utf8");
    const proposalsState = await readFile(path.join(tempDir, "learning-proposals.json"), "utf8");
    const managementPrsState = await readFile(path.join(tempDir, "management-prs.json"), "utf8");

    assert.equal(candidatesState, '{\n  "retrospectiveCandidates": []\n}\n');
    assert.equal(problemsState, '{\n  "retrospectiveProblems": []\n}\n');
    assert.equal(opportunitiesState, '{\n  "retrospectiveOpportunities": []\n}\n');
    assert.equal(proposalsState, '{\n  "learningProposals": []\n}\n');
    assert.equal(managementPrsState, '{\n  "managementPrs": []\n}\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore rejects invalid retrospective file shape", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-retrospective-invalid-"));

  try {
    await writeFile(
      path.join(tempDir, "retrospective-candidates.json"),
      JSON.stringify({ retrospectiveCandidates: {} }),
      "utf8"
    );

    const store = new StateStore(tempDir);
    await assert.rejects(
      () => store.load(),
      /retrospective-candidates\.json: "retrospectiveCandidates" must be an array/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("StateStore round-trips retrospective candidates as readable JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-retrospective-candidates-"));

  try {
    const store = new StateStore(tempDir);
    const candidates: any[] = [
      {
        id: "candidate-1",
        sourceWorkstreamId: "ws-1",
        repoId: "repo-1",
        repoSlug: "owner/repo-1",
        origin: { type: "issue", number: 1 },
        terminalResolution: "merged",
        detectedAt: "2026-06-03T10:00:00Z",
        resolvedAt: "2026-06-03T10:30:00Z",
        status: "new",
        labels: ["bug"],
        sourceSummary: "A bug fix",
        taskSummary: { total: 1, completed: 1, failed: 0, kinds: ["implementation"], taskIds: ["task-1"] },
        executionSummary: { total: 1, providers: ["gemini"], models: ["gemini-pro"], roles: ["implementation"], executionIds: ["exec-1"] },
        artifactReferences: [],
        evidenceReferences: []
      }
    ];

    await store.writeRetrospectiveCandidateState(candidates);

    const persisted = await readFile(path.join(tempDir, "retrospective-candidates.json"), "utf8");
    assert.ok(persisted.includes('"candidate-1"'));
    assert.ok(persisted.includes('"owner/repo-1"'));

    const state = await store.load();
    assert.deepEqual(state.retrospectiveCandidates, candidates);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
