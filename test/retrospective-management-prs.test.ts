import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  materializeManagementLearningProposals,
  buildManagementLearningBranchName,
  buildManagementLearningCommitMessage,
  applyLearningArtifactEdit,
} from "../src/retrospectives/management-prs.js";
import type {
  LearningProposalRecord,
  ManagementPrRecord,
} from "../src/retrospectives/types.js";
import type { GitGateway } from "../src/git/types.js";
import type { GitHubGateway } from "../src/github/types.js";
import type { CommandRunner } from "../src/utils/command-runner.js";

test("materializeManagementLearningProposals skips non-validated proposals", async () => {
  const proposals: LearningProposalRecord[] = [
    {
      id: "prop-1",
      opportunityId: "opp-1",
      problemId: "prob-1",
      status: "pending",
      proposedEditMode: "append",
      selectedScope: { kind: "global" },
      detectedAt: "2026-01-01T00:00:00Z",
    },
  ];

  const result = await materializeManagementLearningProposals({
    proposals,
    managementPrs: [],
    candidates: [],
    problems: [],
    opportunities: [],
    managementRoot: "/tmp/mgmt",
    gitGateway: {} as any,
    githubGateway: {} as any,
    commandRunner: {} as any,
    now: "2026-01-01T00:01:00Z",
  });

  assert.equal(result.proposals[0]?.status, "pending");
  assert.equal(result.managementPrs.length, 0);
});

test("materializeManagementLearningProposals handles audit-only fallback on dirty tree", async () => {
  const proposals: LearningProposalRecord[] = [
    {
      id: "prop-1",
      opportunityId: "opp-1",
      problemId: "prob-1",
      status: "validated",
      validationStatus: "passed",
      proposedEditMode: "append",
      selectedScope: { kind: "global" },
      resolvedArtifactPath: "/tmp/mgmt/learnings/global.md",
      detectedAt: "2026-01-01T00:00:00Z",
    },
  ];

  const gitGateway: Partial<GitGateway> = {
    isInsideWorkingTree: async () => true,
    getActiveMergeState: async () => "none",
    isWorkingTreeClean: async () => false,
  };

  const result = await materializeManagementLearningProposals({
    proposals,
    managementPrs: [],
    candidates: [],
    problems: [],
    opportunities: [],
    managementRoot: "/tmp/mgmt",
    gitGateway: gitGateway as GitGateway,
    githubGateway: {} as any,
    commandRunner: {} as any,
    now: "2026-01-01T00:01:00Z",
  });

  assert.equal(result.proposals[0]?.status, "audit_only");
  assert.equal(result.managementPrs.length, 1);
  assert.equal(result.managementPrs[0]?.mode, "audit_only");
  assert.equal(result.managementPrs[0]?.reason, "Management repository working tree is dirty");
});

test("buildManagementLearningBranchName is deterministic", () => {
  const proposal: LearningProposalRecord = {
    id: "PROP-123-abc",
    opportunityId: "opp-1",
    problemId: "prob-1",
    status: "validated",
    selectedScope: { kind: "repo_role", repoId: "r1", role: "strong" },
    detectedAt: "...",
  } as any;

  const name = buildManagementLearningBranchName(proposal);
  // sha256("PROP-123-abc") starts with 7f21cbd
  assert.equal(name, "agent/management-learning/repo-role-7f21cbd");
});

test("buildManagementLearningCommitMessage includes scope", () => {
  const proposal: LearningProposalRecord = {
    id: "prop-1",
    selectedScope: { kind: "global" },
  } as any;

  const msg = buildManagementLearningCommitMessage(proposal);
  assert.match(msg, /management learning for global/);
  assert.match(msg, /Proposal: prop-1/);
});

test("materializeManagementLearningProposals restores the original branch", async () => {
  const tmpDir = await import("node:fs/promises").then(fs => fs.mkdtemp(path.join(os.tmpdir(), "mgmt-test-")));
  try {
    const proposals: LearningProposalRecord[] = [
      {
        id: "prop-1",
        opportunityId: "opp-1",
        problemId: "prob-1",
        status: "validated",
        validationStatus: "passed",
        proposedEditMode: "append",
        selectedScope: { kind: "global" },
        resolvedArtifactPath: path.join(tmpDir, "learnings", "global.md"),
        detectedAt: "2026-01-01T00:00:00Z",
      },
    ];

    const checkoutCalls: string[] = [];
    const gitGateway: Partial<GitGateway> = {
      isInsideWorkingTree: async () => true,
      getActiveMergeState: async () => "none",
      isWorkingTreeClean: async () => true,
      getCurrentBranch: async () => "feature-branch",
      getRemoteDefaultBranch: async () => "main",
      pushBranch: async () => {},
    };

    const commandRunner: Partial<CommandRunner> = {
      run: async (cmd, args) => {
        if (cmd === "git" && args?.[0] === "checkout") {
          checkoutCalls.push(args[args.length - 1]!);
        }
        if (cmd === "git" && args?.[0] === "remote" && args?.[1] === "get-url") {
          return { stdout: "https://github.com/eladav/mgmt.git", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const githubGateway: Partial<GitHubGateway> = {
      findOpenPullRequestByHeadBranch: async () => null,
      createPullRequest: async () => ({
        id: "pr-1",
        number: 123,
        url: "https://github.com/eladav/mgmt/pull/123",
        title: "Title",
        body: "Body",
        state: "OPEN",
        createdAt: "",
        updatedAt: "",
        author: null,
        labels: [],
        headRefName: "",
        headSha: "",
        baseRefName: "",
        isDraft: false,
      }),
    };

    await materializeManagementLearningProposals({
      proposals,
      managementPrs: [],
      candidates: [],
      problems: [],
      opportunities: [],
      managementRoot: tmpDir,
      gitGateway: gitGateway as GitGateway,
      githubGateway: githubGateway as GitHubGateway,
      commandRunner: commandRunner as CommandRunner,
      now: "2026-01-01T00:01:00Z",
    });

    // Should have checked out the new branch, then restored feature-branch
    assert.ok(checkoutCalls.includes("feature-branch"), `Should have restored the original branch. Calls: ${checkoutCalls.join(", ")}`);
    assert.equal(checkoutCalls[checkoutCalls.length - 1], "feature-branch");
  } finally {
    await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true }));
  }
});

test("materializeManagementLearningProposals reuses existing branch if checkout -b fails", async () => {
  const tmpDir = await import("node:fs/promises").then(fs => fs.mkdtemp(path.join(os.tmpdir(), "mgmt-test-reused-")));
  try {
    const proposals: LearningProposalRecord[] = [
      {
        id: "prop-1",
        opportunityId: "opp-1",
        problemId: "prob-1",
        status: "validated",
        validationStatus: "passed",
        proposedEditMode: "append",
        selectedScope: { kind: "global" },
        resolvedArtifactPath: path.join(tmpDir, "learnings", "global.md"),
        detectedAt: "2026-01-01T00:00:00Z",
        targetArtifactExists: false,
      },
    ];

    const branchName = buildManagementLearningBranchName(proposals[0]!);
    const checkoutCalls: string[] = [];
    const gitGateway: Partial<GitGateway> = {
      isInsideWorkingTree: async () => true,
      getActiveMergeState: async () => "none",
      isWorkingTreeClean: async () => true,
      getCurrentBranch: async () => "main",
      getRemoteDefaultBranch: async () => "main",
      pushBranch: async () => {},
    };

    const commandRunner: Partial<CommandRunner> = {
      run: async (cmd, args) => {
        if (cmd === "git" && args?.[0] === "checkout") {
          const target = args[args.length - 1]!;
          checkoutCalls.push(target);
          if (args.includes("-b") && target === branchName) {
             throw new Error("fatal: A branch named '" + branchName + "' already exists.");
          }
        }
        if (cmd === "git" && args?.[0] === "remote" && args?.[1] === "get-url") {
          return { stdout: "https://github.com/eladav/mgmt.git", stderr: "", exitCode: 0 };
        }
        if (cmd === "git" && args?.[0] === "diff" && args.includes("--cached")) {
          return { stdout: "learnings/global.md", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const githubGateway: Partial<GitHubGateway> = {
      findOpenPullRequestByHeadBranch: async () => null,
      createPullRequest: async () => ({
        id: "pr-1",
        number: 123,
        url: "https://github.com/eladav/mgmt/pull/123",
      } as any),
    };

    const result = await materializeManagementLearningProposals({
      proposals,
      managementPrs: [],
      candidates: [],
      problems: [],
      opportunities: [],
      managementRoot: tmpDir,
      gitGateway: gitGateway as GitGateway,
      githubGateway: githubGateway as GitHubGateway,
      commandRunner: commandRunner as CommandRunner,
      now: "2026-01-01T00:01:00Z",
    });

    assert.equal(result.proposals[0]?.status, "materialized");
    assert.equal(result.managementPrs.length, 1);
    // It should have tried 'git checkout branchName' first
    assert.ok(checkoutCalls.includes(branchName));
  } finally {
    await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true }));
  }
});

test("materializeManagementLearningProposals is idempotent when content already exists", async () => {
  const tmpDir = await import("node:fs/promises").then(fs => fs.mkdtemp(path.join(os.tmpdir(), "mgmt-test-idemp-")));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(tmpDir, "learnings"), { recursive: true });
    const artifactPath = path.join(tmpDir, "learnings", "global.md");

    const proposals: LearningProposalRecord[] = [
      {
        id: "prop-idemp",
        opportunityId: "opp-1",
        problemId: "prob-1",
        status: "validated",
        validationStatus: "passed",
        proposedEditMode: "append",
        selectedScope: { kind: "global" },
        resolvedArtifactPath: artifactPath,
        detectedAt: "2026-01-01T00:00:00Z",
        targetArtifactExists: true,
      },
    ];

    // Pre-fill content with the ID
    await fs.writeFile(artifactPath, "Existing content\n\n_Proposal ID: prop-idemp_\n", "utf8");

    const commitCalls: string[] = [];
    const gitGateway: Partial<GitGateway> = {
      isInsideWorkingTree: async () => true,
      getActiveMergeState: async () => "none",
      isWorkingTreeClean: async () => true,
      getCurrentBranch: async () => "main",
      getRemoteDefaultBranch: async () => "main",
      pushBranch: async () => {},
    };

    const commandRunner: Partial<CommandRunner> = {
      run: async (cmd, args) => {
        if (cmd === "git" && args?.[0] === "commit") {
          commitCalls.push(args.join(" "));
        }
        if (cmd === "git" && args?.[0] === "remote" && args?.[1] === "get-url") {
          return { stdout: "https://github.com/eladav/mgmt.git", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const githubGateway: Partial<GitHubGateway> = {
      findOpenPullRequestByHeadBranch: async () => ({
        id: "pr-1",
        number: 123,
        url: "https://github.com/eladav/mgmt/pull/123",
      } as any),
      createPullRequest: async () => { throw new Error("Should not create PR"); },
    };

    const result = await materializeManagementLearningProposals({
      proposals,
      managementPrs: [],
      candidates: [],
      problems: [],
      opportunities: [],
      managementRoot: tmpDir,
      gitGateway: gitGateway as GitGateway,
      githubGateway: githubGateway as GitHubGateway,
      commandRunner: commandRunner as CommandRunner,
      now: "2026-01-01T00:01:00Z",
    });

    assert.equal(result.proposals[0]?.status, "materialized");
    assert.equal(commitCalls.length, 0, "Should not have committed anything");
  } finally {
    await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true }));
  }
});

test("applyLearningArtifactEdit appends for append and create, including empty artifacts", () => {
  const proposal: LearningProposalRecord = {
    id: "prop-append",
    proposedEditMode: "append",
    proposedGuidanceText: "Some guidance",
    rationale: "Some rationale",
    expectedBehaviorChange: "Some change",
  } as any;
  const now = "2026-06-08T12:34:56Z";
  const existingContent = "Existing content";

  const appendResult = applyLearningArtifactEdit(existingContent, proposal, now);
  const createResult = applyLearningArtifactEdit(
    existingContent,
    { ...proposal, proposedEditMode: "create" } as LearningProposalRecord,
    now
  );
  const emptyResult = applyLearningArtifactEdit("", proposal, now);

  assert.equal(appendResult, createResult);
  assert.match(appendResult, /^Existing content\n\n### Management Learning: 2026-06-08/);
  assert.match(emptyResult, /^### Management Learning: 2026-06-08/);
  assert.match(appendResult, /_Proposal ID: prop-append_/);
});

test("applyLearningArtifactEdit refines the most recent section and supersedes it at the end", () => {
  const existingContent = [
    "Intro",
    "",
    "### Management Learning: 2026-06-01",
    "",
    "#### Guidance",
    "Old guidance one",
    "",
    "#### Rationale",
    "Old rationale one",
    "",
    "#### Expected Behavior Change",
    "Old change one",
    "",
    "_Proposal ID: prop-old-1_",
    "",
    "Middle note",
    "",
    "### Management Learning: 2026-06-05",
    "",
    "#### Guidance",
    "Old guidance two",
    "",
    "#### Rationale",
    "Old rationale two",
    "",
    "#### Expected Behavior Change",
    "Old change two",
    "",
    "_Proposal ID: prop-old-2_",
    "",
    "Tail note",
  ].join("\n");

  const refineProposal: LearningProposalRecord = {
    id: "prop-refine",
    proposedEditMode: "refine",
    proposedGuidanceText: "Refined guidance",
    rationale: "Refined rationale",
    expectedBehaviorChange: "Refined change",
  } as any;
  const supersedeProposal: LearningProposalRecord = {
    id: "prop-supersede",
    proposedEditMode: "supersede",
    proposedGuidanceText: "Superseding guidance",
    rationale: "Superseding rationale",
    expectedBehaviorChange: "Superseding change",
  } as any;
  const now = "2026-06-08T12:34:56Z";

  const refined = applyLearningArtifactEdit(existingContent, refineProposal, now);
  const superseded = applyLearningArtifactEdit(existingContent, supersedeProposal, now);

  assert.match(refined, /Intro/);
  assert.match(refined, /Middle note/);
  assert.match(refined, /Tail note/);
  assert.match(refined, /### Management Learning: 2026-06-08/);
  assert.match(refined, /Refined guidance/);
  assert.doesNotMatch(refined, /Old guidance two/);
  assert.ok(refined.indexOf("Tail note") > refined.indexOf("Refined guidance"));

  assert.match(superseded, /Intro/);
  assert.match(superseded, /Middle note/);
  assert.match(superseded, /Tail note/);
  assert.match(superseded, /### Management Learning: 2026-06-08/);
  assert.match(superseded, /Superseding guidance/);
  assert.doesNotMatch(superseded, /Old guidance two/);
  assert.ok(superseded.indexOf("Tail note") < superseded.indexOf("Superseding guidance"));
});

test("applyLearningArtifactEdit uses the provided 'now' timestamp for the header", () => {
  const proposal: LearningProposalRecord = {
    id: "prop-1",
    proposedGuidanceText: "Some guidance",
    rationale: "Some rationale",
    expectedBehaviorChange: "Some change",
  } as any;
  const now = "2026-06-08T12:34:56Z";
  const result = applyLearningArtifactEdit("", proposal, now);

  assert.match(result, /### Management Learning: 2026-06-08/);
  assert.match(result, /_Proposal ID: prop-1_/);
});
