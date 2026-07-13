import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { validateLearningProposals, selectHighestPrecedenceSupportedScope } from "../src/retrospectives/proposals.js";
import { type LearningProposalRecord, type LearningOpportunityRecord, type RetrospectiveProblemRecord } from "../src/retrospectives/types.js";
import { type ScopeValidationConfig } from "../src/retrospectives/scopes.js";

const now = "2026-06-04T12:00:00Z";
const managementRoot = "/mgmt";

const config: ScopeValidationConfig = {
  repoIds: ["repo1", "repo2"],
  providers: ["codex", "claude"],
  roles: ["discussion", "implementation"],
  taskKinds: ["triage_issue", "implement_plan"]
};

test("validateLearningProposals validates a valid proposal and resolves path", async () => {
  const proposal: LearningProposalRecord = baseProposal("o1", "p1");
  proposal.selectedScope = { kind: "repo", repoId: "repo1" };

  const result = await validateLearningProposals({
    proposals: [proposal],
    opportunities: [baseOpportunity("o1", "p1")],
    problems: [baseProblem("p1")],
    scopeValidationConfig: config,
    managementRoot,
    now
  });

  assert.equal(result.proposals.length, 1);
  const validated = result.proposals[0]!;
  assert.equal(validated.status, "validated");
  assert.equal(validated.validationStatus, "passed");
  assert.ok(
    validated.resolvedArtifactPath?.endsWith(path.join("learnings", "repos", "repo1.md"))
  );
});

test("validateLearningProposals narrows scope based on evidence", async () => {
  const proposal: LearningProposalRecord = baseProposal("o1", "p1");
  // Agent suggested global, but problem evidence supports repo
  proposal.selectedScope = { kind: "global" };

  const problem = baseProblem("p1");
  problem.affectedRepoIds = ["repo1"];
  problem.suggestedScopes = [{ kind: "repo", repoId: "repo1" }];

  const result = await validateLearningProposals({
    proposals: [proposal],
    opportunities: [baseOpportunity("o1", "p1")],
    problems: [problem],
    scopeValidationConfig: config,
    managementRoot,
    now
  });

  assert.equal(result.proposals[0]!.status, "validated");
  assert.equal(result.proposals[0]!.selectedScope!.kind, "repo");
  assert.match(result.proposals[0]!.validationReason!, /Narrowed scope/);
});

test("validateLearningProposals declines if no evidence-supported scope found", async () => {
  const proposal: LearningProposalRecord = baseProposal("o1", "p1");
  proposal.selectedScope = { kind: "repo", repoId: "repo2" }; // repo2 not in evidence

  const problem = baseProblem("p1");
  problem.affectedRepoIds = ["repo1"];
  problem.suggestedScopes = []; // Remove global so it's not a fallback

  const result = await validateLearningProposals({
    proposals: [proposal],
    opportunities: [baseOpportunity("o1", "p1")],
    problems: [problem],
    scopeValidationConfig: config,
    managementRoot,
    now
  });

  assert.equal(result.proposals[0]!.status, "declined");
  assert.match(result.proposals[0]!.declineReason!, /No valid scopes supported by problem evidence/);
});

test("validateLearningProposals declines oversize guidance", async () => {
  const proposal: LearningProposalRecord = baseProposal("o1", "p1");
  proposal.proposedGuidanceText = "a".repeat(4001);

  const result = await validateLearningProposals({
    proposals: [proposal],
    opportunities: [baseOpportunity("o1", "p1")],
    problems: [baseProblem("p1")],
    scopeValidationConfig: config,
    managementRoot,
    now
  });

  assert.equal(result.proposals[0]!.status, "declined");
  assert.match(result.proposals[0]!.declineReason!, /exceeds limit/);
});

test("validateLearningProposals declines duplicate guidance", async () => {
  const proposal: LearningProposalRecord = baseProposal("o1", "p1");
  proposal.proposedGuidanceText = "Existing guidance";

  const readArtifact = async (p: string) => "This is some content. Existing guidance is here.";

  const result = await validateLearningProposals({
    proposals: [proposal],
    opportunities: [baseOpportunity("o1", "p1")],
    problems: [baseProblem("p1")],
    scopeValidationConfig: config,
    managementRoot,
    readArtifact,
    now
  });

  assert.equal(result.proposals[0]!.status, "declined");
  assert.match(result.proposals[0]!.declineReason!, /already present/);
});

test("validateLearningProposals normalizes append to create if artifact missing", async () => {
  const proposal: LearningProposalRecord = baseProposal("o1", "p1");
  proposal.proposedEditMode = "append";

  const readArtifact = async (p: string) => undefined; // missing

  const result = await validateLearningProposals({
    proposals: [proposal],
    opportunities: [baseOpportunity("o1", "p1")],
    problems: [baseProblem("p1")],
    scopeValidationConfig: config,
    managementRoot,
    readArtifact,
    now
  });

  assert.equal(result.proposals[0]!.status, "validated");
  assert.equal(result.proposals[0]!.proposedEditMode, "create");
  assert.match(result.proposals[0]!.validationReason!, /Normalized edit mode/);
});

test("validateLearningProposals declines create if artifact already exists", async () => {
  const proposal: LearningProposalRecord = baseProposal("o1", "p1");
  proposal.proposedEditMode = "create";

  const readArtifact = async (p: string) => "some content";

  const result = await validateLearningProposals({
    proposals: [proposal],
    opportunities: [baseOpportunity("o1", "p1")],
    problems: [baseProblem("p1")],
    scopeValidationConfig: config,
    managementRoot,
    readArtifact,
    now
  });

  assert.equal(result.proposals[0]!.status, "declined");
  assert.match(result.proposals[0]!.declineReason!, /Cannot use edit mode "create"/);
});

function baseProposal(oId: string, pId: string): LearningProposalRecord {
  return {
    id: `proposal-${oId}`,
    opportunityId: oId,
    problemId: pId,
    status: "pending",
    selectedScope: { kind: "global" },
    proposedEditMode: "append",
    proposedGuidanceText: "Some guidance",
    rationale: "Some rationale",
    expectedBehaviorChange: "Better behavior",
    detectedAt: now,
    updatedAt: now,
  };
}

function baseOpportunity(id: string, pId: string): LearningOpportunityRecord {
  return {
    id,
    problemId: pId,
    status: "investigated",
    evidenceReferences: [],
    detectedAt: now,
    updatedAt: now,
  };
}

function baseProblem(id: string): RetrospectiveProblemRecord {
  return {
    id,
    candidateId: "c1",
    status: "completed",
    evidenceReferences: [],
    affectedRepoIds: ["repo1"],
    roles: ["discussion"],
    taskKinds: ["triage_issue"],
    providers: ["codex"],
    suggestedScopes: [{ kind: "global" }],
    detectedAt: now,
    updatedAt: now,
  };
}
