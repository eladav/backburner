import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/config/types.js";
import { DefaultContextBuilder } from "../src/context/types.js";
import type { NormalizedIssue } from "../src/domain/entities.js";
import type { GitGateway } from "../src/git/types.js";
import type { GitHubGateway } from "../src/github/types.js";
import { loadLearningOverlays } from "../src/prompts/resolver.js";
import { registerRetrospectiveCandidates } from "../src/retrospectives/candidates.js";
import { deriveRetrospectiveTasks } from "../src/retrospectives/derive.js";
import { ingestRetrospectiveExecutions } from "../src/retrospectives/ingest.js";
import {
  materializeManagementLearningProposals,
  buildManagementLearningBranchName,
} from "../src/retrospectives/management-prs.js";
import { validateLearningProposals } from "../src/retrospectives/proposals.js";
import { scoreRetrospectiveProblems } from "../src/retrospectives/scoring.js";
import type { ScopeValidationConfig } from "../src/retrospectives/scopes.js";
import type {
  LearningOpportunityRecord,
  LearningProposalRecord,
  ManagementPrRecord,
  RetrospectiveCandidateRecord,
  RetrospectiveProblemRecord,
} from "../src/retrospectives/types.js";
import { StateStore } from "../src/state/loader.js";
import type { ExecutionRecord, TaskRecord, WorkstreamRecord } from "../src/state/types.js";
import type { CommandRunner } from "../src/utils/command-runner.js";

const now = "2026-06-08T12:00:00Z";
const contextBuilder = new DefaultContextBuilder();

const strongRetroAgent: AgentConfig = {
  id: "strong-retro",
  provider: "codex",
  modelClass: "strong",
  roles: ["retrospective"],
  command: "codex",
  enabled: true,
};

const scopeConfig: ScopeValidationConfig = {
  repoIds: ["repo-1"],
  providers: ["codex"],
  roles: ["discussion", "retrospective"],
  taskKinds: ["write_plan"],
};

test("retrospective e2e audit-only vertical slice", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-retro-e2e-"));

  try {
    const managementRoot = path.join(tempDir, "management");
    await mkdir(managementRoot, { recursive: true });

    const workstream: WorkstreamRecord = {
      id: "workstream-1",
      repoKey: "example-org/example-repo",
      origin: { type: "issue", number: 232 },
      linkedPrs: [],
      phase: "resolved",
      attention: "idle",
      status: "merged",
      resolution: "merged",
      createdAt: now,
      updatedAt: now,
    } as unknown as WorkstreamRecord;

    const issue: NormalizedIssue = {
      id: "issue-232",
      kind: "issue",
      repoId: "repo-1",
      repoKey: "example-org/example-repo",
      repoSlug: "example-org/example-repo",
      repoOwner: "example-org",
      repoName: "example-repo",
      number: 232,
      title: "Retrospective MVP",
      body: "Self improvement retrospective MVP",
      url: "https://github.com/example-org/example-repo/issues/232",
      labels: [],
      state: "closed",
      author: "example-org",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    } as unknown as NormalizedIssue;

    const registration = registerRetrospectiveCandidates({
      previousCandidates: [],
      workstreams: [workstream],
      issues: [issue],
      pullRequests: [],
      tasks: [],
      executions: [],
      worktrees: [],
      managementPrs: [],
      now,
    });

    assert.equal(registration.candidates.length, 1);
    assert.equal(registration.registered.length, 1);

    const secondRegistration = registerRetrospectiveCandidates({
      previousCandidates: registration.candidates,
      workstreams: [workstream],
      issues: [issue],
      pullRequests: [],
      tasks: [],
      executions: [],
      worktrees: [],
      managementPrs: [],
      now,
    });
    assert.equal(secondRegistration.candidates.length, 1);
    assert.equal(secondRegistration.registered.length, 0);

    let candidates = registration.candidates;
    let problems: RetrospectiveProblemRecord[] = [];
    let opportunities: LearningOpportunityRecord[] = [];
    let proposals: LearningProposalRecord[] = [];
    let tasks: TaskRecord[] = [];

    const extractionDerivation = deriveRetrospectiveTasks({
      existingTasks: tasks,
      candidates,
      problems,
      opportunities,
      proposals,
      agents: [strongRetroAgent],
      contextBuilder,
      now,
    });
    assert.equal(extractionDerivation.tasks.length, 1);
    assert.equal(extractionDerivation.tasks[0]?.kind, "extract_retrospective_problems");
    assert.equal(extractionDerivation.tasks[0]?.context.retrospectiveCandidate?.id, candidates[0]?.id);
    candidates = extractionDerivation.candidates;
    tasks = [...tasks, { ...extractionDerivation.tasks[0]!, status: "completed" }];

    const extractionExecution = completedExecution("execution-extraction", tasks[0]!.id, "extraction.json");
    let ingestion = await ingestRetrospectiveExecutions({
      tasks,
      executions: [extractionExecution],
      candidates,
      problems,
      opportunities,
      proposals,
      readArtifact: async (artifactPath) => {
        assert.equal(artifactPath, "extraction.json");
        return JSON.stringify({
          problems: [
            {
              candidateId: candidates[0]!.id,
              problemSummary: "Planning agents over-investigate instead of producing bounded handoffs",
              evidenceReferences: [{ kind: "execution", id: "execution-extraction" }],
              affectedRepos: ["repo-1"],
              affectedRoles: ["discussion"],
              affectedTaskKinds: ["write_plan"],
              affectedProviders: ["gemini"],
              confidence: "high",
              impact: "high",
              transferability: "high",
              improvementLikelihood: "high",
              overfittingRisk: "low",
              suggestedScopes: [{ kind: "repo_task_kind", repoId: "repo-1", taskKind: "write_plan" }],
              reasonItMightRecur: "The planning prompt lacks a hard bounded-discovery stop.",
            },
          ],
        });
      },
      now,
    });
    assert.equal(ingestion.problems.length, 1);
    assert.equal(ingestion.candidates[0]?.status, "extracted");

    candidates = ingestion.candidates;
    problems = scoreRetrospectiveProblems(ingestion.problems, scopeConfig, now);
    assert.equal(problems[0]?.thresholdDecision, "pass");
    assert.deepEqual(problems[0]?.selectedScope, {
      kind: "repo_task_kind",
      repoId: "repo-1",
      taskKind: "write_plan",
    });

    const investigationDerivation = deriveRetrospectiveTasks({
      existingTasks: tasks,
      candidates,
      problems,
      opportunities,
      proposals,
      agents: [strongRetroAgent],
      contextBuilder,
      now,
    });
    assert.equal(investigationDerivation.tasks.length, 1);
    assert.equal(investigationDerivation.tasks[0]?.kind, "investigate_learning_opportunity");
    problems = investigationDerivation.problems;
    tasks = [...tasks, { ...investigationDerivation.tasks[0]!, status: "completed" }];

    const investigationExecution = completedExecution("execution-investigation", tasks[1]!.id, "investigation.json");
    ingestion = await ingestRetrospectiveExecutions({
      tasks,
      executions: [extractionExecution, investigationExecution],
      candidates,
      problems,
      opportunities,
      proposals,
      readArtifact: async (artifactPath) => {
        if (artifactPath === "investigation.json") {
          return JSON.stringify({
            problemId: problems[0]!.id,
            investigationSummary: "Planning prompts need a concise handoff-first shape.",
            investigationResult: "A scoped repo+task-kind learning is appropriate.",
            evidenceReferences: [{ kind: "task", id: tasks[1]!.id }],
            selectedScope: { kind: "repo_task_kind", repoId: "repo-1", taskKind: "write_plan" },
          });
        }
        throw new Error(`Unexpected artifact read: ${artifactPath}`);
      },
      now,
    });
    assert.equal(ingestion.opportunities.length, 1);
    assert.equal(ingestion.problems[0]?.status, "completed");

    problems = ingestion.problems;
    opportunities = ingestion.opportunities;

    const proposalDerivation = deriveRetrospectiveTasks({
      existingTasks: tasks,
      candidates,
      problems,
      opportunities,
      proposals,
      agents: [strongRetroAgent],
      contextBuilder,
      now,
    });
    assert.equal(proposalDerivation.tasks.length, 1);
    assert.equal(proposalDerivation.tasks[0]?.kind, "draft_management_learning_proposal");
    tasks = [...tasks, { ...proposalDerivation.tasks[0]!, status: "completed" }];

    const proposalExecution = completedExecution("execution-proposal", tasks[2]!.id, "proposal.json");
    ingestion = await ingestRetrospectiveExecutions({
      tasks,
      executions: [extractionExecution, investigationExecution, proposalExecution],
      candidates,
      problems,
      opportunities,
      proposals,
      readArtifact: async (artifactPath) => {
        if (artifactPath === "proposal.json") {
          return JSON.stringify({
            opportunityId: opportunities[0]!.id,
            problemId: problems[0]!.id,
            selectedScope: { kind: "repo_task_kind", repoId: "repo-1", taskKind: "write_plan" },
            proposedEditMode: "create",
            proposedGuidanceText: "For planning tasks, perform bounded discovery and write the plan before exploring optional code paths.",
            rationale: "The retrospective found repeated planning timeouts caused by open-ended repository archaeology.",
            expectedBehaviorChange: "Planning agents produce durable plans faster and avoid implementation-like probing.",
          });
        }
        throw new Error(`Unexpected artifact read: ${artifactPath}`);
      },
      now,
    });
    assert.equal(ingestion.proposals.length, 1);
    proposals = ingestion.proposals;

    const validation = await validateLearningProposals({
      proposals,
      opportunities,
      problems,
      scopeValidationConfig: scopeConfig,
      managementRoot,
      readArtifact: async () => undefined,
      now,
    });
    proposals = validation.proposals;
    assert.equal(proposals[0]?.status, "validated");
    assert.equal(proposals[0]?.validationStatus, "passed");
    assert.equal(
      proposals[0]?.resolvedArtifactPath,
      path.join(managementRoot, "learnings", "repo-task-kinds", "repo-1", "write_plan.md")
    );

    const materialization = await materializeManagementLearningProposals({
      proposals,
      managementPrs: [],
      candidates,
      problems,
      opportunities,
      managementRoot,
      gitGateway: { isInsideWorkingTree: async () => false } as unknown as GitGateway,
      githubGateway: { createPullRequest: async () => { throw new Error("audit-only must not create PRs"); } } as unknown as GitHubGateway,
      commandRunner: throwingCommandRunner(),
      now,
    });

    assert.equal(materialization.proposals[0]?.status, "audit_only");
    assert.equal(materialization.managementPrs.length, 1);
    assert.equal(materialization.managementPrs[0]?.mode, "audit_only");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrospective threshold failure blocks investigation derivation", () => {
  const problem = baseProblem({ transferability: "medium" });
  const scored = scoreRetrospectiveProblems([problem], scopeConfig, now);

  assert.equal(scored[0]?.thresholdDecision, "fail");
  assert.match(scored[0]?.decisionReason ?? "", /transferability/);

  const derivation = deriveRetrospectiveTasks({
    existingTasks: [],
    candidates: [],
    problems: scored,
    opportunities: [],
    proposals: [],
    agents: [strongRetroAgent],
    contextBuilder,
    now,
  });

  assert.equal(derivation.tasks.length, 0);
  assert.equal(derivation.problems[0]?.id, problem.id);
});

test("retrospective e2e mocked git-backed materialization opens management PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-retro-mgmt-pr-"));

  try {
    const managementRoot = tempDir;
    const proposal = validatedProposal(managementRoot);
    const branchName = buildManagementLearningBranchName(proposal);
    const pushedBranches: string[] = [];
    const gitCommands: string[][] = [];
    const pullRequestInputs: any[] = [];

    const gitGateway: Partial<GitGateway> = {
      isInsideWorkingTree: async () => true,
      getActiveMergeState: async () => "none",
      isWorkingTreeClean: async () => true,
      getCurrentBranch: async () => "main",
      getRemoteDefaultBranch: async () => "main",
      pushBranch: async (_repoPath, branch) => {
        pushedBranches.push(branch);
      },
    };

    const commandRunner: CommandRunner = {
      run: async (command, args, options) => {
        assert.equal(command, "git");
        assert.equal(options?.cwd, managementRoot);
        gitCommands.push(args);

        if (args[0] === "remote" && args[1] === "get-url") {
          return { exitCode: 0, stdout: "https://github.com/example-org/backburner-management.git\n", stderr: "" };
        }
        if (args[0] === "checkout") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "add") {
          assert.equal(args[1], proposal.resolvedArtifactPath);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "diff" && args.includes("--cached")) {
          return { exitCode: 0, stdout: "learnings/repo-task-kinds/repo-1/write_plan.md\n", stderr: "" };
        }
        if (args[0] === "commit") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
    };

    const githubGateway: Partial<GitHubGateway> = {
      findOpenPullRequestByHeadBranch: async (_owner, _name, branch) => {
        assert.equal(branch, branchName);
        return null;
      },
      createPullRequest: async (input) => {
        pullRequestInputs.push(input);
        return {
          id: "pr-1",
          number: 42,
          url: "https://github.com/example-org/backburner-management/pull/42",
        } as any;
      },
    };

    const candidate = baseCandidate();
    const problem = baseProblem();
    const opportunity = baseOpportunity(problem.id);
    const result = await materializeManagementLearningProposals({
      proposals: [proposal],
      managementPrs: [],
      candidates: [candidate],
      problems: [problem],
      opportunities: [opportunity],
      managementRoot,
      gitGateway: gitGateway as GitGateway,
      githubGateway: githubGateway as GitHubGateway,
      commandRunner,
      now,
    });

    assert.equal(result.proposals[0]?.status, "materialized");
    assert.equal(result.managementPrs[0]?.mode, "pull_request");
    assert.equal(result.managementPrs[0]?.status, "opened");
    assert.equal(result.managementPrs[0]?.branchName, branchName);
    assert.deepEqual(pushedBranches, [branchName]);
    assert.equal(pullRequestInputs.length, 1);
    assert.equal(pullRequestInputs[0].owner, "example-org");
    assert.equal(pullRequestInputs[0].name, "backburner-management");
    assert.equal(pullRequestInputs[0].baseBranch, "main");
    assert.match(pullRequestInputs[0].body, /Retrospective Summary/);
    assert.match(pullRequestInputs[0].body, /Selected Scope/);
    assert.match(pullRequestInputs[0].body, /Modified Artifact/);
    assert.ok(branchName.startsWith("agent/management-learning/repo-task-kind-"));
    assert.ok(gitCommands.some((args) => args[0] === "commit"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrospective learning overlays load broad-to-narrow approved guidance", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-retro-overlays-"));

  try {
    await mkdir(path.join(tempDir, "learnings", "repo-task-kinds", "repo-1"), { recursive: true });
    await writeFile(path.join(tempDir, "learnings", "global.md"), "global guidance\n", "utf8");
    await writeFile(
      path.join(tempDir, "learnings", "repo-task-kinds", "repo-1", "write_plan.md"),
      "repo write_plan guidance\n",
      "utf8"
    );

    const overlays = await loadLearningOverlays(
      {
        repoId: "repo-1",
        provider: "codex",
        role: "discussion",
        taskKind: "write_plan",
      },
      tempDir
    );

    assert.deepEqual(overlays, ["global guidance", "repo write_plan guidance"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retrospective state initializes old state and writes readable JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-retro-state-"));

  try {
    const store = new StateStore(tempDir);
    const loaded = await store.load();
    assert.deepEqual(loaded.retrospectiveCandidates, []);
    assert.deepEqual(loaded.retrospectiveProblems, []);
    assert.deepEqual(loaded.retrospectiveOpportunities, []);
    assert.deepEqual(loaded.learningProposals, []);
    assert.deepEqual(loaded.managementPrs, []);

    await store.writeRetrospectiveCandidateState([baseCandidate()]);
    await store.writeRetrospectiveProblemState([baseProblem()]);
    await store.writeRetrospectiveOpportunityState([baseOpportunity("retrospective-problem-1")]);
    await store.writeLearningProposalState([validatedProposal(tempDir)]);
    await store.writeManagementPrState([baseManagementPr()]);

    const candidatesJson = await readFile(path.join(tempDir, "retrospective-candidates.json"), "utf8");
    const proposalsJson = await readFile(path.join(tempDir, "learning-proposals.json"), "utf8");

    assert.ok(candidatesJson.includes('\n  "retrospectiveCandidates"'));
    assert.ok(proposalsJson.includes('\n  "learningProposals"'));
    assert.ok(candidatesJson.endsWith("\n"));
    assert.ok(proposalsJson.endsWith("\n"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function completedExecution(id: string, taskId: string, stdoutArtifactPath: string): ExecutionRecord {
  return {
    id,
    taskId,
    taskKind: "extract_retrospective_problems",
    taskStatus: "completed",
    agentId: "strong-retro",
    agentProvider: "codex",
    command: { executable: "codex", args: [], cwd: ".", timeoutMs: 0 },
    promptArtifactPath: "prompt.md",
    stdoutArtifactPath,
    stderrArtifactPath: "stderr.txt",
    promptPacketPath: "prompt-packet.json",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
  } as unknown as ExecutionRecord;
}

function baseCandidate(): RetrospectiveCandidateRecord {
  return {
    id: "retrospective-candidate-1",
    sourceWorkstreamId: "workstream-1",
    repoId: "repo-1",
    repoSlug: "example-org/example-repo",
    repoKey: "example-org/example-repo",
    origin: { type: "issue", number: 232 },
    terminalResolution: "merged",
    detectedAt: now,
    resolvedAt: now,
    status: "extracted",
    title: "Retrospective MVP",
    url: "https://github.com/example-org/example-repo/issues/232",
    labels: [],
    sourceSummary: "Completed retrospective MVP workstream",
    taskSummary: { total: 1, completed: 1, failed: 0, kinds: ["write_plan"], taskIds: ["task-1"] },
    executionSummary: { total: 1, providers: ["codex"], models: ["codex-pro"], roles: ["discussion"], executionIds: ["execution-1"] },
    artifactReferences: [],
    evidenceReferences: [{ kind: "workstream", id: "workstream-1" }],
  };
}

function baseProblem(overrides: Partial<RetrospectiveProblemRecord> = {}): RetrospectiveProblemRecord {
  return {
    id: "retrospective-problem-1",
    candidateId: "retrospective-candidate-1",
    status: "pending",
    structuredObservations: "Planning agents over-investigate.",
    evidenceReferences: [{ kind: "execution", id: "execution-1" }],
    affectedRepoIds: ["repo-1"],
    roles: ["discussion"],
    taskKinds: ["write_plan"],
    providers: ["codex"],
    confidence: "high",
    impact: "high",
    transferability: "high",
    improvementLikelihood: "high",
    overfittingRisk: "low",
    suggestedScopes: [{ kind: "repo_task_kind", repoId: "repo-1", taskKind: "write_plan" }],
    detectedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseOpportunity(problemId: string): LearningOpportunityRecord {
  return {
    id: "learning-opportunity-1",
    problemId,
    status: "investigated",
    investigationSummary: "Bound planning discovery.",
    investigationResult: "A repo task-kind learning should reduce repeated failures.",
    selectedScope: { kind: "repo_task_kind", repoId: "repo-1", taskKind: "write_plan" },
    evidenceReferences: [{ kind: "task", id: "task-investigation" }],
    detectedAt: now,
    updatedAt: now,
  };
}

function validatedProposal(managementRoot: string): LearningProposalRecord {
  return {
    id: "learning-proposal-1",
    opportunityId: "learning-opportunity-1",
    problemId: "retrospective-problem-1",
    status: "validated",
    selectedScope: { kind: "repo_task_kind", repoId: "repo-1", taskKind: "write_plan" },
    resolvedArtifactPath: path.join(managementRoot, "learnings", "repo-task-kinds", "repo-1", "write_plan.md"),
    proposedEditMode: "create",
    proposedGuidanceText: "Perform bounded discovery before writing planning handoffs.",
    rationale: "Planning timeouts recur when agents keep exploring optional code paths.",
    expectedBehaviorChange: "Planning agents produce implementation-ready plans with fewer retries.",
    validationStatus: "passed",
    targetArtifactExists: false,
    detectedAt: now,
    updatedAt: now,
  };
}

function baseManagementPr(): ManagementPrRecord {
  return {
    id: "mgmt-pr-1",
    proposalId: "learning-proposal-1",
    mode: "audit_only",
    changedArtifactPaths: ["learnings/repo-task-kinds/repo-1/write_plan.md"],
    status: "audit_only",
    detectedAt: now,
    updatedAt: now,
  };
}

function throwingCommandRunner(): CommandRunner {
  return {
    run: async (command, args) => {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };
}

test("retrospective e2e semantic normalization", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "backburner-retro-semantic-e2e-"));

  try {
    const candidate = baseCandidate();
    const tasks: TaskRecord[] = [
      {
        id: "task-extraction",
        kind: "extract_retrospective_problems",
        sourceId: candidate.id,
        status: "completed",
        context: { retrospectiveCandidate: candidate },
      } as unknown as TaskRecord,
    ];

    const extractionExecution = completedExecution("execution-extraction", "task-extraction", "extraction.json");

    const ingestion = await ingestRetrospectiveExecutions({
      tasks,
      executions: [extractionExecution],
      candidates: [candidate],
      problems: [],
      opportunities: [],
      proposals: [],
      readArtifact: async (artifactPath) => {
        assert.equal(artifactPath, "extraction.json");
        return JSON.stringify({
          problems: [
            {
              candidateId: candidate.id,
              problemSummary: "Planning agents over-investigate",
              evidenceReferences: [],
              affectedRepos: ["repo-1"],
              affectedRoles: ["discussion"],
              affectedTaskKinds: ["write_plan"],
              affectedProviders: ["gemini"],
              confidence: "high",
              impact: "high",
              transferability: "high",
              improvementLikelihood: "high",
              overfittingRisk: "low",
              suggestedScopes: [{ kind: "workflow" }], // Semantic scope
              reasonItMightRecur: "Reason",
            },
          ],
        });
      },
      now,
    });

    assert.equal(ingestion.problems.length, 1);
    const problem = ingestion.problems[0]!;

    // Check that ingestion already normalized it
    assert.ok(problem.suggestedScopes.some((s) => s.kind === "repo_task_kind"));
    assert.equal(problem.semanticSuggestedScopes?.[0]?.kind, "workflow");

    // Scoring should also handle it defensively and preserve audit fields
    const scored = scoreRetrospectiveProblems(ingestion.problems, scopeConfig, now);
    assert.equal(scored[0]?.thresholdDecision, "pass");
    assert.equal(scored[0]?.selectedScope?.kind, "repo_task_kind");
    assert.match(scored[0]?.scopeValidationReason!, /after normalizing semantic scopes/);

    // Derivation should now proceed to investigation, proving the normalization unblocks the pipeline
    const derivation = deriveRetrospectiveTasks({
      existingTasks: [],
      candidates: ingestion.candidates,
      problems: scored,
      opportunities: [],
      proposals: [],
      agents: [strongRetroAgent],
      contextBuilder,
      now,
    });

    assert.equal(derivation.tasks.length, 1);
    assert.equal(derivation.tasks[0]!.kind, "investigate_learning_opportunity");
    assert.equal(derivation.tasks[0]!.sourceId, problem.id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
