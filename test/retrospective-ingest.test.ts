import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ingestRetrospectiveExecutions } from "../src/retrospectives/ingest.js";
import type { ExecutionRecord, TaskRecord } from "../src/state/types.js";
import type {
  RetrospectiveCandidateRecord,
  RetrospectiveProblemRecord,
  LearningOpportunityRecord,
  LearningProposalRecord,
} from "../src/retrospectives/types.js";

const now = "2026-06-04T12:00:00Z";

test("ingestRetrospectiveExecutions ingests valid extraction JSON", async () => {
  const task: TaskRecord = { id: "t1", kind: "extract_retrospective_problems", sourceId: "c1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const extractionJson = {
    problems: [
      {
        candidateId: "c1",
        problemSummary: "Problem 1",
        evidenceReferences: [],
        affectedRepos: ["repo1"],
        affectedRoles: ["discussion"],
        affectedTaskKinds: ["triage_issue"],
        affectedProviders: ["gemini"],
        confidence: "high",
        impact: "high",
        transferability: "high",
        improvementLikelihood: "high",
        overfittingRisk: "low",
        suggestedScopes: [],
        reasonItMightRecur: "structural issue",
      },
    ],
  };

  const readArtifact = async () => JSON.stringify(extractionJson);

  const candidates = [baseCandidate("c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates,
    problems: [],
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0]!.candidateId, "c1");
  assert.equal(result.candidates[0]!.status, "extracted");
  assert.equal(result.consumedExecutionIds.includes("e1"), true);
});

test("ingestRetrospectiveExecutions handles malformed extraction JSON", async () => {
  const task: TaskRecord = { id: "t1", kind: "extract_retrospective_problems", sourceId: "c1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const readArtifact = async () => "not json";

  const candidates = [baseCandidate("c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates,
    problems: [],
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.problems.length, 0);
  assert.equal(result.candidates[0]!.status, "failed");
  assert.equal(result.candidates[0]!.sourceExecutionId, "e1");
  assert.equal(result.candidates[0]!.sourceTaskId, "t1");
  assert.equal(result.declined.length, 1);
});

test("ingestRetrospectiveExecutions marks failed investigation as consumed", async () => {
  const task: TaskRecord = { id: "t1", kind: "investigate_learning_opportunity", sourceId: "p1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const readArtifact = async () => "not json";

  const problems = [baseProblem("p1", "c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates: [],
    problems,
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.opportunities.length, 0);
  assert.equal(result.problems[0]!.status, "failed");
  assert.equal(result.problems[0]!.sourceExecutionId, "e1");
  assert.equal(result.problems[0]!.sourceTaskId, "t1");
});

test("ingestRetrospectiveExecutions marks failed proposal as consumed", async () => {
  const task: TaskRecord = { id: "t1", kind: "draft_management_learning_proposal", sourceId: "o1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const readArtifact = async () => "not json";

  const opportunities = [baseOpportunity("o1", "p1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates: [],
    problems: [],
    opportunities,
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]!.status, "declined");
  assert.equal(result.proposals[0]!.opportunityId, "o1");
  assert.equal(result.opportunities[0]!.status, "declined");
  assert.equal(result.opportunities[0]!.sourceTaskId, "t1");
});

test("ingestRetrospectiveExecutions handles explicit empty extraction", async () => {
  const task: TaskRecord = { id: "t1", kind: "extract_retrospective_problems", sourceId: "c1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const extractionJson = {
    problems: [],
  };

  const readArtifact = async () => JSON.stringify(extractionJson);

  const candidates = [baseCandidate("c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates,
    problems: [],
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.problems.length, 0);
  assert.equal(result.candidates[0]!.status, "skipped");
  assert.equal(result.candidates[0]!.skipReason, "Agent reported no problems found");
});

test("ingestRetrospectiveExecutions fails when problems array contains malformed entry", async () => {
  const task: TaskRecord = { id: "t1", kind: "extract_retrospective_problems", sourceId: "c1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const extractionJson = {
    problems: [
      { bad: "entry" }
    ],
  };

  const readArtifact = async () => JSON.stringify(extractionJson);

  const candidates = [baseCandidate("c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates,
    problems: [],
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.problems.length, 0);
  assert.equal(result.candidates[0]!.status, "failed");
  assert.match(result.candidates[0]!.skipReason!, /Invalid problem record at index 0/);
});

test("ingestRetrospectiveExecutions fails when investigation is missing selectedScope", async () => {
  const task: TaskRecord = { id: "t1", kind: "investigate_learning_opportunity", sourceId: "p1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const investigationJson = {
    problemId: "p1",
    investigationSummary: "summary",
    investigationResult: "result",
    evidenceReferences: [],
    // selectedScope missing
  };

  const readArtifact = async () => JSON.stringify(investigationJson);

  const problems = [baseProblem("p1", "c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates: [],
    problems,
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.problems[0]!.status, "failed");
  assert.match(result.problems[0]!.decisionReason!, /Invalid investigation JSON/);
});

test("ingestRetrospectiveExecutions fails when investigation has malformed scope structure", async () => {
  const task: TaskRecord = { id: "t1", kind: "investigate_learning_opportunity", sourceId: "p1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const investigationJson = {
    problemId: "p1",
    investigationSummary: "summary",
    investigationResult: "result",
    evidenceReferences: [],
    selectedScope: { kind: "repo_task_kind" }, // missing repoId and taskKind
  };

  const readArtifact = async () => JSON.stringify(investigationJson);

  const problems = [baseProblem("p1", "c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates: [],
    problems,
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.opportunities.length, 0);
  assert.equal(result.problems[0]!.status, "failed");
  assert.match(result.problems[0]!.decisionReason!, /Invalid investigation JSON/);
});

test("ingestRetrospectiveExecutions ingests valid investigation JSON", async () => {
  const task: TaskRecord = { id: "t1", kind: "investigate_learning_opportunity", sourceId: "p1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const investigationJson = {
    problemId: "p1",
    investigationSummary: "summary",
    investigationResult: "result",
    evidenceReferences: [],
    selectedScope: { kind: "global" },
    rationale: "rationale",
  };

  const readArtifact = async () => JSON.stringify(investigationJson);

  const problems = [baseProblem("p1", "c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates: [],
    problems,
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0]!.problemId, "p1");
  assert.equal(result.problems[0]!.status, "completed");
});

test("ingestRetrospectiveExecutions ingests valid proposal JSON", async () => {
  const task: TaskRecord = { id: "t1", kind: "draft_management_learning_proposal", sourceId: "o1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const proposalJson = {
    opportunityId: "o1",
    problemId: "p1",
    selectedScope: { kind: "global" },
    proposedEditMode: "append",
    proposedGuidanceText: "guidance",
    rationale: "rationale",
    expectedBehaviorChange: "change",
  };

  const readArtifact = async () => JSON.stringify(proposalJson);

  const opportunities = [baseOpportunity("o1", "p1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates: [],
    problems: [],
    opportunities,
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]!.opportunityId, "o1");
  assert.equal(result.proposals[0]!.status, "pending");
});

test("ingestRetrospectiveExecutions is idempotent", async () => {
    const task: TaskRecord = { id: "t1", kind: "extract_retrospective_problems", sourceId: "c1" } as any;
    const execution: ExecutionRecord = {
      id: "e1",
      taskId: "t1",
      taskStatus: "completed",
      stdoutArtifactPath: "stdout.txt",
      } as any;

      const extractionJson = {
      problems: [
        {
          candidateId: "c1",
          problemSummary: "Problem 1",
          evidenceReferences: [],
          affectedRepos: ["repo1"],
          affectedRoles: ["discussion"],
          affectedTaskKinds: ["triage_issue"],
          affectedProviders: ["gemini"],
          confidence: "high",
          impact: "high",
          transferability: "high",
          improvementLikelihood: "high",
          overfittingRisk: "low",
          suggestedScopes: [],
          reasonItMightRecur: "structural issue",
        },
      ],
      };

      const readArtifact = async () => JSON.stringify(extractionJson);

      const candidates = [baseCandidate("c1")];
      candidates[0]!.sourceExecutionId = "e1"; // Already consumed

      const result = await ingestRetrospectiveExecutions({
      tasks: [task],
      executions: [execution],
      candidates,
      problems: [],
      opportunities: [],
      proposals: [],
      readArtifact,
      now,
      });

      assert.equal(result.consumedExecutionIds.length, 0);
      assert.equal(result.problems.length, 0);
      });

      test("ingestRetrospectiveExecutions ingests execution when task is provided in the tasks array even if it is from a previous run", async () => {
      const task: TaskRecord = { id: "t1", kind: "extract_retrospective_problems", sourceId: "c1" } as any;
      const execution: ExecutionRecord = {
      id: "e1",
      taskId: "t1",
      taskStatus: "completed",
      stdoutArtifactPath: "stdout.txt",
      } as any;

      const extractionJson = {
      problems: [
        {
          candidateId: "c1",
          problemSummary: "Problem 1",
          evidenceReferences: [],
          affectedRepos: ["repo1"],
          affectedRoles: ["discussion"],
          affectedTaskKinds: ["triage_issue"],
          affectedProviders: ["gemini"],
          confidence: "high",
          impact: "high",
          transferability: "high",
          improvementLikelihood: "high",
          overfittingRisk: "low",
          suggestedScopes: [],
          reasonItMightRecur: "structural issue",
        },
      ],
      };

      const readArtifact = async () => JSON.stringify(extractionJson);

      const candidates = [baseCandidate("c1")];

      // Simulation: task is NOT in current run's tasks, but passed as part of the tasks array (which runCli now merges)
      const result = await ingestRetrospectiveExecutions({
      tasks: [task],
      executions: [execution],
      candidates,
      problems: [],
      opportunities: [],
      proposals: [],
      readArtifact,
      now,
      });

      assert.equal(result.problems.length, 1);
      assert.equal(result.problems[0]!.candidateId, "c1");
      assert.equal(result.candidates[0]!.status, "extracted");
      });

test("ingestRetrospectiveExecutions ingests extraction with ambiguous band values", async () => {
  const task: TaskRecord = { id: "t1", kind: "extract_retrospective_problems", sourceId: "c1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const extractionJson = {
    problems: [
      {
        candidateId: "c1",
        problemSummary: "Problem 1",
        evidenceReferences: [],
        affectedRepos: ["repo1"],
        affectedRoles: ["discussion"],
        affectedTaskKinds: ["triage_issue"],
        affectedProviders: ["gemini"],
        confidence: "unknown",
        impact: "ambiguous",
        transferability: null,
        improvementLikelihood: "high",
        overfittingRisk: "low",
        suggestedScopes: [],
        reasonItMightRecur: "structural issue",
      },
    ],
  };

  const readArtifact = async () => JSON.stringify(extractionJson);

  const candidates = [baseCandidate("c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates,
    problems: [],
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0]!.confidence, "unknown");
  assert.equal(result.problems[0]!.impact, "ambiguous");
  assert.equal(result.problems[0]!.transferability, null);
  assert.equal(result.candidates[0]!.status, "extracted");
});

test("ingestRetrospectiveExecutions ingests extraction with malformed scope values", async () => {
  const task: TaskRecord = { id: "t1", kind: "extract_retrospective_problems", sourceId: "c1" } as any;
  const execution: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const extractionJson = {
    problems: [
      {
        candidateId: "c1",
        problemSummary: "Problem 1",
        evidenceReferences: [],
        affectedRepos: ["repo1"],
        affectedRoles: ["discussion"],
        affectedTaskKinds: ["triage_issue"],
        affectedProviders: ["gemini"],
        confidence: "high",
        impact: "high",
        transferability: "high",
        improvementLikelihood: "high",
        overfittingRisk: "low",
        suggestedScopes: [
          { kind: "repo", repoId: 123 }, // repoId should be string
          { kind: "unknown" },          // unknown kind
          "not an object"               // not an object
        ],
        reasonItMightRecur: "structural issue",
      },
    ],
  };

  const readArtifact = async () => JSON.stringify(extractionJson);

  const candidates = [baseCandidate("c1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task],
    executions: [execution],
    candidates,
    problems: [],
    opportunities: [],
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.problems.length, 1);
  assert.deepEqual(result.problems[0]!.suggestedScopes, [
    { kind: "repo", repoId: 123 },
    { kind: "unknown" },
    "not an object"
  ]);
  assert.equal(result.candidates[0]!.status, "extracted");
});

test("ingestRetrospectiveExecutions avoids duplicate proposal for same opportunity", async () => {
  const task1: TaskRecord = { id: "t1", kind: "draft_management_learning_proposal", sourceId: "o1" } as any;
  const execution1: ExecutionRecord = {
    id: "e1",
    taskId: "t1",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const task2: TaskRecord = { id: "t2", kind: "draft_management_learning_proposal", sourceId: "o1" } as any;
  const execution2: ExecutionRecord = {
    id: "e2",
    taskId: "t2",
    taskStatus: "completed",
    stdoutArtifactPath: "stdout.txt",
  } as any;

  const proposalJson = {
    opportunityId: "o1",
    problemId: "p1",
    selectedScope: { kind: "global" },
    proposedEditMode: "append",
    proposedGuidanceText: "guidance",
    rationale: "rationale",
    expectedBehaviorChange: "change",
  };

  const readArtifact = async () => JSON.stringify(proposalJson);

  const opportunities = [baseOpportunity("o1", "p1")];
  const result = await ingestRetrospectiveExecutions({
    tasks: [task1, task2],
    executions: [execution1, execution2],
    candidates: [],
    problems: [],
    opportunities,
    proposals: [],
    readArtifact,
    now,
  });

  assert.equal(result.proposals.length, 1);
  assert.equal(result.consumedExecutionIds.length, 2);
});

function baseCandidate(id: string): RetrospectiveCandidateRecord {
  return {
    id,
    sourceWorkstreamId: "ws1",
    repoId: "repo1",
    repoSlug: "owner/repo1",
    origin: { type: "issue", number: 1 },
    terminalResolution: "merged",
    detectedAt: now,
    resolvedAt: now,
    status: "new",
    labels: [],
    sourceSummary: "summary",
    taskSummary: { total: 1, completed: 1, failed: 0, kinds: [], taskIds: [] },
    executionSummary: { total: 1, providers: [], models: [], roles: [], executionIds: [] },
    artifactReferences: [],
    evidenceReferences: [],
  };
}

function baseProblem(id: string, candidateId: string): RetrospectiveProblemRecord {
  return {
    id,
    candidateId,
    status: "pending",
    evidenceReferences: [],
    affectedRepoIds: ["repo1"],
    roles: ["discussion"],
    taskKinds: ["triage_issue"],
    providers: ["codex"],
    confidence: "high",
    impact: "high",
    transferability: "high",
    improvementLikelihood: "high",
    overfittingRisk: "low",
    suggestedScopes: [],
    detectedAt: now,
    updatedAt: now,
  };
}

function baseOpportunity(id: string, problemId: string): LearningOpportunityRecord {
    return {
      id,
      problemId,
      status: "investigated",
      evidenceReferences: [],
      detectedAt: now,
      updatedAt: now,
    };
  }
