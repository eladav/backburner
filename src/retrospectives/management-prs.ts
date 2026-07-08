import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
  LearningProposalRecord,
  ManagementPrRecord,
  RetrospectiveCandidateRecord,
  RetrospectiveProblemRecord,
  LearningOpportunityRecord,
} from "./types.js";
import { resolveScopePath } from "./scopes.js";
import { parseGitHubRemoteUrl } from "../github/utils.js";
import type { GitGateway } from "../git/types.js";
import type { GitHubGateway } from "../github/types.js";
import type { CommandRunner } from "../utils/command-runner.js";

export interface MaterializeManagementLearningProposalsInput {
  proposals: LearningProposalRecord[];
  managementPrs: ManagementPrRecord[];
  candidates: RetrospectiveCandidateRecord[];
  problems: RetrospectiveProblemRecord[];
  opportunities: LearningOpportunityRecord[];
  managementRoot: string;
  gitGateway: GitGateway;
  githubGateway: GitHubGateway;
  commandRunner: CommandRunner;
  now: string;
}

export interface MaterializeManagementLearningProposalsResult {
  proposals: LearningProposalRecord[];
  managementPrs: ManagementPrRecord[];
}

export async function materializeManagementLearningProposals(
  input: MaterializeManagementLearningProposalsInput
): Promise<MaterializeManagementLearningProposalsResult> {
  const {
    proposals,
    managementPrs: existingManagementPrs,
    candidates,
    problems,
    opportunities,
    managementRoot,
    gitGateway,
    githubGateway,
    commandRunner,
    now,
  } = input;

  const updatedProposals: LearningProposalRecord[] = [...proposals];
  const updatedManagementPrs: ManagementPrRecord[] = [...existingManagementPrs];

  for (let i = 0; i < updatedProposals.length; i++) {
    const proposal = updatedProposals[i]!;

    if (proposal.status !== "validated" || proposal.validationStatus !== "passed") {
      continue;
    }

    // Idempotence check
    const existingPrRecord = updatedManagementPrs.find((pr) => pr.proposalId === proposal.id);
    if (existingPrRecord) {
      if (proposal.status === "validated") {
        updatedProposals[i] = {
          ...proposal,
          status: existingPrRecord.mode === "audit_only" ? "audit_only" : "materialized",
          materializationStatus: "completed",
          updatedAt: now,
        };
      }
      continue;
    }

    const materializationResult = await materializeSingleProposal({
      proposal,
      candidates,
      problems,
      opportunities,
      managementRoot,
      gitGateway,
      githubGateway,
      commandRunner,
      now,
    });

    updatedProposals[i] = materializationResult.proposal;
    if (materializationResult.managementPr) {
      updatedManagementPrs.push(materializationResult.managementPr);
    }
  }

  return {
    proposals: updatedProposals,
    managementPrs: updatedManagementPrs,
  };
}

async function materializeSingleProposal(input: {
  proposal: LearningProposalRecord;
  candidates: RetrospectiveCandidateRecord[];
  problems: RetrospectiveProblemRecord[];
  opportunities: LearningOpportunityRecord[];
  managementRoot: string;
  gitGateway: GitGateway;
  githubGateway: GitHubGateway;
  commandRunner: CommandRunner;
  now: string;
}): Promise<{ proposal: LearningProposalRecord; managementPr?: ManagementPrRecord }> {
  const {
    proposal,
    candidates,
    problems,
    opportunities,
    managementRoot,
    gitGateway,
    githubGateway,
    commandRunner,
    now,
  } = input;

  const auditOnly = (reason: string): { proposal: LearningProposalRecord; managementPr: ManagementPrRecord } => {
    const record: ManagementPrRecord = {
      id: `mgmt-pr-audit-${proposal.id}`,
      proposalId: proposal.id,
      mode: "audit_only",
      status: "audit_only",
      reason,
      changedArtifactPaths: proposal.resolvedArtifactPath ? [proposal.resolvedArtifactPath] : [],
      detectedAt: now,
      updatedAt: now,
    };
    return {
      proposal: {
        ...proposal,
        status: "audit_only",
        materializationStatus: "completed",
        updatedAt: now,
      },
      managementPr: record,
    };
  };

  // 1. Safety Checks
  let originalBranch: string | null = null;
  try {
    if (!(await gitGateway.isInsideWorkingTree(managementRoot))) {
      return auditOnly("Management root is not inside a git working tree");
    }
    if ((await gitGateway.getActiveMergeState(managementRoot)) !== "none") {
      return auditOnly("Management repository has active merge/rebase/revert state");
    }
    if (!(await gitGateway.isWorkingTreeClean(managementRoot))) {
      return auditOnly("Management repository working tree is dirty");
    }
    originalBranch = await gitGateway.getCurrentBranch(managementRoot);
  } catch (err) {
    return auditOnly(`Failed to check management repo git state: ${(err as Error).message}`);
  }

  // 2. Resolve Remote and Repository Identity
  let remoteUrl: string;
  try {
    const result = await commandRunner.run("git", ["remote", "get-url", "origin"], { cwd: managementRoot });
    remoteUrl = result.stdout.trim();
  } catch (err) {
    return auditOnly(`Failed to resolve management repository remote URL: ${(err as Error).message}`);
  }

  const repoIdentity = parseGitHubRemoteUrl(remoteUrl);
  if (!repoIdentity) {
    return auditOnly(`Unsupported or unparsable management repository remote URL: ${remoteUrl}`);
  }

  // 3. Resolve Base Branch
  let baseBranch: string;
  try {
    baseBranch = await gitGateway.getRemoteDefaultBranch(managementRoot);
  } catch (err) {
    try {
      const result = await commandRunner.run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: managementRoot });
      baseBranch = result.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
    } catch {
      return auditOnly("Could not safely resolve management repository default branch");
    }
  }

  // 4. Deterministic Branch Name
  const branchName = buildManagementLearningBranchName(proposal);

  // 5. Apply Edits
  if (!proposal.resolvedArtifactPath || !proposal.selectedScope) {
    return auditOnly("Proposal is missing resolved artifact path or selected scope");
  }

  const learningsRoot = path.resolve(managementRoot, "learnings");
  const normalizedPath = path.resolve(proposal.resolvedArtifactPath);
  if (!normalizedPath.startsWith(learningsRoot + path.sep) && normalizedPath !== learningsRoot) {
    return auditOnly(`Resolved artifact path "${normalizedPath}" is outside learnings root "${learningsRoot}"`);
  }

  const expectedPath = resolveScopePath(proposal.selectedScope, managementRoot);
  if (normalizedPath !== expectedPath) {
    return auditOnly(`Resolved artifact path "${normalizedPath}" does not match scope-to-path resolution "${expectedPath}"`);
  }

  // Checkout branch (reuse existing or create new)
  try {
    await commandRunner.run("git", ["checkout", branchName], { cwd: managementRoot });
  } catch {
    try {
      await commandRunner.run("git", ["checkout", "-b", branchName, `origin/${baseBranch}`], { cwd: managementRoot });
    } catch (err) {
      return auditOnly(`Failed to checkout management learning branch: ${(err as Error).message}`);
    }
  }

  try {
    const fs = await import("node:fs/promises");
    let existingContent = "";
    if (proposal.targetArtifactExists) {
      existingContent = await fs.readFile(normalizedPath, "utf8");
    } else {
      await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
    }

    const newContent = applyLearningArtifactEdit(existingContent, proposal, now);
    if (newContent === existingContent) {
      // Check if the branch already has the content (idempotence)
      if (!existingContent.includes(`_Proposal ID: ${proposal.id}_`)) {
        // Restore state if it was a genuine "no change"
        if (originalBranch) {
          await commandRunner.run("git", ["checkout", originalBranch], { cwd: managementRoot });
        }
        await commandRunner.run("git", ["branch", "-D", branchName], { cwd: managementRoot });
        return auditOnly("Proposed edit resulted in no changes to the artifact");
      }
      // If it has the ID, it was already applied. Continue to PR check.
    } else {
      await fs.writeFile(normalizedPath, newContent, "utf8");

      // 6. Commit Only Allowed Changes
      await commandRunner.run("git", ["add", normalizedPath], { cwd: managementRoot });
      const diffCheck = await commandRunner.run("git", ["diff", "--cached", "--name-only"], { cwd: managementRoot });
      const changedFiles = diffCheck.stdout.trim().split(/\r?\n/).filter(Boolean);

      for (const file of changedFiles) {
        const fullPath = path.resolve(managementRoot, file);
        if (!fullPath.startsWith(learningsRoot + path.sep)) {
          // Safety violation: something staged outside learnings/
          await commandRunner.run("git", ["reset", "HEAD", "--", "."], { cwd: managementRoot });
          await commandRunner.run("git", ["checkout", "--", "."], { cwd: managementRoot });
          if (originalBranch) {
            await commandRunner.run("git", ["checkout", originalBranch], { cwd: managementRoot });
          }
          await commandRunner.run("git", ["branch", "-D", branchName], { cwd: managementRoot });
          return auditOnly(`Detected attempt to commit file outside learnings root: ${file}`);
        }
      }

      const commitMessage = buildManagementLearningCommitMessage(proposal);
      await commandRunner.run("git", ["commit", "-m", commitMessage], { cwd: managementRoot });
    }

    // 7. Push and Open PR
    await gitGateway.pushBranch(managementRoot, branchName);

    const prBody = buildManagementLearningPullRequestBody(
      proposal,
      candidates,
      problems,
      opportunities
    );
    const prTitle = `Add management learning for ${proposal.selectedScope.kind}`;

    let prUrl: string;
    let prNumber: number;

    const existingPr = await githubGateway.findOpenPullRequestByHeadBranch(
      repoIdentity.owner,
      repoIdentity.name,
      branchName
    );

    if (existingPr) {
      prUrl = existingPr.url;
      prNumber = existingPr.number;
    } else {
      const createdPr = await githubGateway.createPullRequest({
        owner: repoIdentity.owner,
        name: repoIdentity.name,
        title: prTitle,
        body: prBody,
        headBranch: branchName,
        baseBranch: baseBranch,
      });
      prUrl = createdPr.url;
      prNumber = createdPr.number;
    }

    // Cleanup: return to original branch locally
    if (originalBranch) {
      await commandRunner.run("git", ["checkout", originalBranch], { cwd: managementRoot });
    }

    const record: ManagementPrRecord = {
      id: `mgmt-pr-${proposal.id}`,
      proposalId: proposal.id,
      mode: "pull_request",
      status: "opened",
      branchName,
      prUrl,
      prNumber,
      repoSlug: `${repoIdentity.owner}/${repoIdentity.name}`,
      changedArtifactPaths: [normalizedPath],
      detectedAt: now,
      updatedAt: now,
    };

    return {
      proposal: {
        ...proposal,
        status: "materialized",
        materializationStatus: "completed",
        updatedAt: now,
      },
      managementPr: record,
    };

  } catch (err) {
    // Cleanup on error
    try {
      await commandRunner.run("git", ["reset", "HEAD", "--", "."], { cwd: managementRoot });
      await commandRunner.run("git", ["checkout", "--", "."], { cwd: managementRoot });
      if (originalBranch) {
        await commandRunner.run("git", ["checkout", originalBranch], { cwd: managementRoot });
      }
    } catch { /* ignore cleanup errors */ }
    return auditOnly(`Failed during materialization: ${(err as Error).message}`);
  }
}

export function buildManagementLearningBranchName(proposal: LearningProposalRecord): string {
  const idHash = createHash("sha256").update(proposal.id).digest("hex").slice(0, 7);
  const scopeSlug = proposal.selectedScope
    ? proposal.selectedScope.kind.toLowerCase().replace(/[^a-z0-9]/g, "-")
    : "unknown-scope";

  return `agent/management-learning/${scopeSlug}-${idHash}`;
}

export function buildManagementLearningCommitMessage(proposal: LearningProposalRecord): string {
  const scopeDesc = proposal.selectedScope ? proposal.selectedScope.kind : "unknown scope";
  return `Add management learning for ${scopeDesc}\n\nProposal: ${proposal.id}`;
}

export function applyLearningArtifactEdit(
  existingContent: string,
  proposal: LearningProposalRecord,
  now: string
): string {
  if (existingContent.includes(getProposalMarker(proposal.id))) {
    return existingContent;
  }

  const section = renderManagementLearningSection(proposal, now);
  if (!existingContent.trim()) {
    return section;
  }

  const editMode = proposal.proposedEditMode ?? "append";
  if (editMode === "append" || editMode === "create") {
    return existingContent.trimEnd() + "\n\n" + section;
  }

  const sections = findManagementLearningSections(existingContent);
  const mostRecentSection = sections.at(-1);
  if (!mostRecentSection) {
    return existingContent.trimEnd() + "\n\n" + section;
  }

  const prefix = existingContent.slice(0, mostRecentSection.start);
  const suffix = existingContent.slice(mostRecentSection.end);

  if (editMode === "refine") {
    return composeManagementLearningContent(prefix, section, suffix);
  }

  if (editMode === "supersede") {
    return composeManagementLearningContent(prefix, suffix, section);
  }

  return existingContent.trimEnd() + "\n\n" + section;
}

function renderManagementLearningSection(proposal: LearningProposalRecord, now: string): string {
  const guidance = proposal.proposedGuidanceText || "";
  const rationale = proposal.rationale || "";
  const behaviorChange = proposal.expectedBehaviorChange || "";

  return [
    `### Management Learning: ${now.split("T")[0]}`,
    "",
    "#### Guidance",
    guidance.trim(),
    "",
    "#### Rationale",
    rationale.trim(),
    "",
    "#### Expected Behavior Change",
    behaviorChange.trim(),
    "",
    getProposalMarker(proposal.id),
    "",
  ].join("\n");
}

function getProposalMarker(proposalId: string): string {
  return `_Proposal ID: ${proposalId}_`;
}

function findManagementLearningSections(content: string): Array<{ start: number; end: number }> {
  const headerMatches = [...content.matchAll(/^### Management Learning:.*$/gm)];
  return headerMatches.map((match, index) => ({
    start: match.index ?? 0,
    end: findProposalFooterEnd(content, (match.index ?? 0) + match[0].length) ?? headerMatches[index + 1]?.index ?? content.length,
  }));
}

function findProposalFooterEnd(content: string, searchStart: number): number | undefined {
  const footerRegex = /^_Proposal ID: .+_$/gm;
  footerRegex.lastIndex = searchStart;
  const footerMatch = footerRegex.exec(content);
  if (!footerMatch) {
    return undefined;
  }

  return (footerMatch.index ?? searchStart) + footerMatch[0].length;
}

function composeManagementLearningContent(prefix: string, middle: string, suffix: string): string {
  const parts = [prefix.trimEnd(), middle, suffix.trimStart()].filter((part) => part.length > 0);
  return parts.join("\n\n");
}

export function buildManagementLearningPullRequestBody(
  proposal: LearningProposalRecord,
  candidates: RetrospectiveCandidateRecord[],
  problems: RetrospectiveProblemRecord[],
  opportunities: LearningOpportunityRecord[]
): string {
  const opportunity = opportunities.find((o) => o.id === proposal.opportunityId);
  const problem = problems.find((p) => p.id === proposal.problemId || p.id === opportunity?.problemId);
  const candidate = candidates.find((c) => c.id === problem?.candidateId);

  const evidence = [
    ...(problem?.evidenceReferences || []),
    ...(opportunity?.evidenceReferences || []),
  ];

  const uniqueEvidence = Array.from(new Map(evidence.map((e) => [e.id, e])).values());

  const affectedWorkstreams = new Set<string>();
  if (candidate?.sourceWorkstreamId) affectedWorkstreams.add(candidate.sourceWorkstreamId);

  const affectedExecutions = new Set<string>();
  if (proposal.sourceExecutionId) affectedExecutions.add(proposal.sourceExecutionId);
  if (opportunity?.sourceExecutionId) affectedExecutions.add(opportunity.sourceExecutionId);
  if (problem?.sourceExecutionId) affectedExecutions.add(problem.sourceExecutionId);
  if (candidate?.sourceExecutionId) affectedExecutions.add(candidate.sourceExecutionId);

  const artifactPath = proposal.resolvedArtifactPath || "Unknown";

  return [
    "🤖 This management learning proposal was automatically materialized by the orchestrator after a retrospective run.",
    "",
    "### Retrospective Summary",
    proposal.rationale || "No rationale provided.",
    "",
    "### Proposed Behavioral Change",
    proposal.expectedBehaviorChange || "No behavior change described.",
    "",
    "### Selected Scope",
    `\`${JSON.stringify(proposal.selectedScope, null, 2)}\``,
    "",
    "### Evidence Audit Trail",
    uniqueEvidence.length > 0
      ? uniqueEvidence.map((e) => `- [${e.kind}] ${e.summary || e.id}${e.url ? ` (${e.url})` : ""}`).join("\n")
      : "No direct evidence references provided.",
    "",
    "### Affected Context",
    `- **Workstreams**: ${affectedWorkstreams.size > 0 ? Array.from(affectedWorkstreams).join(", ") : "None identified"}`,
    `- **Executions**: ${affectedExecutions.size > 0 ? Array.from(affectedExecutions).join(", ") : "None identified"}`,
    "",
    "### Implementation Details",
    `- **Edit Mode**: ${proposal.proposedEditMode}`,
    `- **Modified Artifact**: \`${artifactPath}\``,
    "",
    "---",
    "**Human Review Boundary**: This PR is for human review and merge only. The orchestrator will not approve, review, prepare, or merge this PR automatically.",
  ].join("\n");
}
