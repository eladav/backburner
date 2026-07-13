import type { RepoConfig } from "../config/types.js";
import type {
  NormalizedComment,
  NormalizedIssue,
  NormalizedPullRequest
} from "../domain/entities.js";
import type { PersistedState, RepoScanFailure, RepoSyncRecord } from "../state/types.js";
import {
  normalizeIssue,
  normalizeIssueComments,
  normalizePullRequest,
  normalizePullRequestReviewComments,
  normalizePullRequestReviews
} from "./normalize.js";
import type { GitHubGateway, GitHubRepositoryMetadata, GhPullRequestSummary } from "./types.js";

export interface GitHubScanResult {
  issues: NormalizedIssue[];
  prs: NormalizedPullRequest[];
  comments: NormalizedComment[];
  repoResults: RepoSyncRecord[];
  failures: RepoScanFailure[];
}

export interface GitHubScanningService {
  scanRepositories(
    repos: RepoConfig[],
    repoResults: RepoSyncRecord[],
    previousState: PersistedState
  ): Promise<GitHubScanResult>;
}

export class GitHubScanService implements GitHubScanningService {
  constructor(
    private readonly gitHubGateway: GitHubGateway,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async scanRepositories(
    repos: RepoConfig[],
    repoResults: RepoSyncRecord[],
    previousState: PersistedState
  ): Promise<GitHubScanResult> {
    const seenAt = this.now();
    const previousIssues = new Map(previousState.issues.map((issue) => [issue.id, issue]));
    const previousPullRequests = new Map(previousState.prs.map((pr) => [pr.id, pr]));
    const previousComments = new Map(previousState.comments.map((comment) => [comment.id, comment]));
    const resultsByRepoId = new Map(repoResults.map((record) => [record.repoId, record]));
    const issues: NormalizedIssue[] = [];
    const prs: NormalizedPullRequest[] = [];
    const comments: NormalizedComment[] = [];
    const failures: RepoScanFailure[] = [];

    for (const repo of repos) {
      const repoResult = resultsByRepoId.get(repo.id);
      if (!repoResult) {
        continue;
      }

      const repoFailures: RepoScanFailure[] = [];
      let repoIssueCount = 0;
      let repoPrCount = 0;
      let repoCommentCount = 0;

      const repoMetadata = await this.fetchRepositoryMetadata(repo, repoResult, repoFailures);
      if (!repoMetadata) {
        const carriedIssues = entitiesForRepo(previousState.issues, repo.id);
        const carriedPrs = entitiesForRepo(previousState.prs, repo.id);
        const carriedComments = entitiesForRepo(previousState.comments, repo.id);
        issues.push(...carriedIssues);
        prs.push(...carriedPrs);
        comments.push(...carriedComments);
        failures.push(...repoFailures);
        repoResult.githubScan = {
          status: "failed",
          scannedAt: seenAt,
          issueCount: carriedIssues.length,
          pullRequestCount: carriedPrs.length,
          commentCount: carriedComments.length,
          failures: repoFailures
        };
        continue;
      }

      const [issueListFetch, pullRequestListFetch] = await Promise.all([
        this.fetchWithFailure(
          () => this.gitHubGateway.listOpenIssues(repo.owner, repo.name),
          repo.id,
          repoMetadata.nameWithOwner,
          "list_issues",
          "repo",
          repoFailures
        ),
        this.fetchWithFailure(
          () => this.gitHubGateway.listOpenPullRequests(repo.owner, repo.name),
          repo.id,
          repoMetadata.nameWithOwner,
          "list_pull_requests",
          "repo",
          repoFailures
        )
      ]);

      const rawIssues = issueListFetch.value ?? [];
      const rawPullRequests = pullRequestListFetch.value ?? [];
      const rawPullRequestsByNumber = new Map(rawPullRequests.map((pr) => [pr.number, pr]));

      if (issueListFetch.failed) {
        const carriedIssues = entitiesForRepo(previousState.issues, repo.id);
        const carriedIssueComments = commentsForParentType(previousState.comments, repo.id, "issue");
        issues.push(...carriedIssues);
        comments.push(...carriedIssueComments);
        repoIssueCount += carriedIssues.length;
        repoCommentCount += carriedIssueComments.length;
      }

      if (!issueListFetch.failed) {
        for (const rawIssue of rawIssues) {
          const issueCommentFetch = await this.fetchWithFailure(
            () => this.gitHubGateway.listIssueComments(repo.owner, repo.name, rawIssue.number),
            repo.id,
            repoMetadata.nameWithOwner,
            "issue_comments",
            `issue#${rawIssue.number}`,
            repoFailures
          );
          const issueComments = issueCommentFetch.value ?? [];

          const normalizedComments = normalizeIssueComments(issueComments, rawIssue.number, "issue", "issue_comment", {
            repo,
            repoMetadata,
            seenAt,
            previousIssues,
            previousPullRequests,
            previousComments
          });
          const carriedComments = issueCommentFetch.failed
            ? commentsForParent(previousState.comments, repo.id, "issue", rawIssue.number)
            : [];
          const mergedComments = mergeById(normalizedComments, carriedComments).sort(compareComments);
          const normalizedIssue = normalizeIssue(rawIssue, mergedComments, {
            repo,
            repoMetadata,
            seenAt,
            previousIssues,
            previousPullRequests,
            previousComments
          });

          issues.push(normalizedIssue);
          comments.push(...mergedComments);
          repoIssueCount += 1;
          repoCommentCount += mergedComments.length;
        }
      }

      if (pullRequestListFetch.failed) {
        const carriedPrs = entitiesForRepo(previousState.prs, repo.id);
        const carriedPrComments = commentsForParentType(previousState.comments, repo.id, "pull_request");
        prs.push(...carriedPrs);
        comments.push(...carriedPrComments);
        repoPrCount += carriedPrs.length;
        repoCommentCount += carriedPrComments.length;
      }

      if (!pullRequestListFetch.failed) {
        for (const rawPr of rawPullRequests) {
          const [prCommentsFetch, prReviewsFetch, prReviewCommentsFetch] = await Promise.all([
            this.fetchWithFailure(
              () => this.gitHubGateway.listPullRequestComments(repo.owner, repo.name, rawPr.number),
              repo.id,
              repoMetadata.nameWithOwner,
              "pull_request_comments",
              `pull_request#${rawPr.number}`,
              repoFailures
            ),
            this.fetchWithFailure(
              () => this.gitHubGateway.listPullRequestReviews(repo.owner, repo.name, rawPr.number),
              repo.id,
              repoMetadata.nameWithOwner,
              "pull_request_reviews",
              `pull_request#${rawPr.number}`,
              repoFailures
            ),
            this.fetchWithFailure(
              () => this.gitHubGateway.listPullRequestReviewComments(repo.owner, repo.name, rawPr.number),
              repo.id,
              repoMetadata.nameWithOwner,
              "pull_request_review_comments",
              `pull_request#${rawPr.number}`,
              repoFailures
            )
          ]);

          const normalizedComments = [
            ...normalizeIssueComments(
              prCommentsFetch.value ?? [],
              rawPr.number,
              "pull_request",
              "pull_request_comment",
              {
                repo,
                repoMetadata,
                seenAt,
                previousIssues,
                previousPullRequests,
                previousComments
              }
            ),
            ...normalizePullRequestReviews(prReviewsFetch.value ?? [], rawPr.number, {
              repo,
              repoMetadata,
              seenAt,
              previousIssues,
              previousPullRequests,
              previousComments
            }),
            ...normalizePullRequestReviewComments(prReviewCommentsFetch.value ?? [], rawPr.number, {
              repo,
              repoMetadata,
              seenAt,
              previousIssues,
              previousPullRequests,
              previousComments
            })
          ].sort((left, right) => left.id.localeCompare(right.id));
          const carriedComments =
            prCommentsFetch.failed || prReviewsFetch.failed || prReviewCommentsFetch.failed
              ? commentsForParent(previousState.comments, repo.id, "pull_request", rawPr.number)
              : [];
          const mergedComments = mergeById(normalizedComments, carriedComments).sort(compareComments);

          const normalizedPr = normalizePullRequest(rawPr, mergedComments, {
            repo,
            repoMetadata,
            seenAt,
            previousIssues,
            previousPullRequests,
            previousComments
          });

          prs.push(normalizedPr);
          comments.push(...mergedComments);
          repoPrCount += 1;
          repoCommentCount += mergedComments.length;
        }

        const trackedMissingPullRequests = await this.fetchTrackedMissingPullRequests({
          repo,
          repoMetadata,
          seenAt,
          previousState,
          previousIssues,
          previousPullRequests,
          previousComments,
          rawPullRequestsByNumber,
          failures: repoFailures
        });

        for (const normalizedPr of trackedMissingPullRequests) {
          prs.push(normalizedPr);
          repoPrCount += 1;
        }
      }

      failures.push(...repoFailures);
      repoResult.githubScan = {
        status:
          repoFailures.length === 0
            ? "scanned"
            : repoIssueCount === 0 && repoPrCount === 0
              ? "failed"
              : "partial",
        scannedAt: seenAt,
        issueCount: repoIssueCount,
        pullRequestCount: repoPrCount,
        commentCount: repoCommentCount,
        failures: repoFailures
      };
    }

    return {
      issues: issues.sort(compareEntities),
      prs: prs.sort(compareEntities),
      comments: comments.sort(compareComments),
      repoResults,
      failures
    };
  }

  private async fetchRepositoryMetadata(
    repo: RepoConfig,
    repoResult: RepoSyncRecord,
    failures: RepoScanFailure[]
  ) {
    try {
      return await this.gitHubGateway.getRepositoryMetadata(repo.owner, repo.name);
    } catch (error: unknown) {
      failures.push({
        repoId: repo.id,
        repoSlug: repoResult.repoSlug,
        step: "repo_metadata",
        scope: "repo",
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  private async fetchWithFailure<T>(
    fetcher: () => Promise<T>,
    repoId: string,
    repoSlug: string,
    step: RepoScanFailure["step"],
    scope: string,
    failures: RepoScanFailure[]
  ): Promise<{ value?: T; failed: boolean }> {
    try {
      return { value: await fetcher(), failed: false };
    } catch (error: unknown) {
      failures.push({
        repoId,
        repoSlug,
        step,
        scope,
        message: error instanceof Error ? error.message : String(error)
      });

      return { failed: true };
    }
  }

  private async fetchTrackedMissingPullRequests(input: {
    repo: RepoConfig;
    repoMetadata: GitHubRepositoryMetadata;
    seenAt: string;
    previousState: PersistedState;
    previousIssues: Map<string, NormalizedIssue>;
    previousPullRequests: Map<string, NormalizedPullRequest>;
    previousComments: Map<string, NormalizedComment>;
    rawPullRequestsByNumber: Map<number, GhPullRequestSummary>;
    failures: RepoScanFailure[];
  }): Promise<NormalizedPullRequest[]> {
    const trackedNumbers = collectTrackedPullRequestNumbers(
      input.repo.id,
      input.repoMetadata.nameWithOwner,
      input.previousState
    );
    const missingNumbers = [...trackedNumbers]
      .filter((number) => !input.rawPullRequestsByNumber.has(number))
      .sort((left, right) => left - right);

    const fetched: NormalizedPullRequest[] = [];

    for (const prNumber of missingNumbers) {
      const fetch = await this.fetchWithFailure(
        () => this.gitHubGateway.getPullRequest(input.repo.owner, input.repo.name, prNumber),
        input.repo.id,
        input.repoMetadata.nameWithOwner,
        "get_pull_request",
        `pull_request#${prNumber}`,
        input.failures
      );

      if (fetch.value) {
        fetched.push(
          normalizePullRequest(
            fetch.value,
            commentsForParent(input.previousState.comments, input.repo.id, "pull_request", prNumber),
            {
              repo: input.repo,
              repoMetadata: input.repoMetadata,
              seenAt: input.seenAt,
              previousIssues: input.previousIssues,
              previousPullRequests: input.previousPullRequests,
              previousComments: input.previousComments
            }
          )
        );
        continue;
      }

      const previousTrackedPr = input.previousPullRequests.get(
        `pull_request:${input.repoMetadata.nameWithOwner}:${prNumber}`
      );
      if (previousTrackedPr) {
        fetched.push(previousTrackedPr);
      }
    }

    return fetched;
  }
}

function collectTrackedPullRequestNumbers(
  repoId: string,
  repoSlug: string,
  previousState: PersistedState
): Set<number> {
  const numbers = new Set<number>();
  const mergedPacketPrNumbers = new Set<number>();

  for (const workstream of previousState.workstreams) {
    if (workstream.repoKey !== repoSlug) {
      continue;
    }

    for (const packet of Object.values(workstream.packetPlan?.packets ?? {})) {
      if (packet.prNumber === undefined) {
        continue;
      }

      if (packet.status === "merged_to_parent") {
        mergedPacketPrNumbers.add(packet.prNumber);
      } else {
        numbers.add(packet.prNumber);
      }
    }
  }

  // Collect PR numbers already belonging to terminal workstreams so we don't
  // re-fetch them — once a workstream is closed/merged its PR state is final.
  const terminalPrNumbers = new Set<number>();
  for (const workstream of previousState.workstreams) {
    if (workstream.repoKey !== repoSlug) {
      continue;
    }
    if (workstream.status === "closed" || workstream.status === "merged" || workstream.resolution === "merged") {
      for (const linkedPr of workstream.linkedPrs) {
        terminalPrNumbers.add(linkedPr.number);
      }
      if (workstream.activePrNumber !== undefined) {
        terminalPrNumbers.add(workstream.activePrNumber);
      }
    }
  }

  for (const worktree of previousState.worktrees) {
    if (worktree.repoId !== repoId || worktree.prNumber === undefined) {
      continue;
    }

    if (worktree.packet) {
      if (!mergedPacketPrNumbers.has(worktree.prNumber)) {
        numbers.add(worktree.prNumber);
      }
    } else if (!terminalPrNumbers.has(worktree.prNumber)) {
      // Non-packet (integration) worktree PRs are not covered by the packet plan
      // loop above, so track them until their merged state is observed.
      numbers.add(worktree.prNumber);
    }
  }

  return numbers;
}

function entitiesForRepo<T extends { repoId: string }>(items: T[], repoId: string): T[] {
  return items.filter((item) => item.repoId === repoId);
}

function commentsForParentType(
  comments: NormalizedComment[],
  repoId: string,
  parentType: NormalizedComment["parentType"]
): NormalizedComment[] {
  return comments.filter((comment) => comment.repoId === repoId && comment.parentType === parentType);
}

function commentsForParent(
  comments: NormalizedComment[],
  repoId: string,
  parentType: NormalizedComment["parentType"],
  parentNumber: number
): NormalizedComment[] {
  return comments.filter(
    (comment) =>
      comment.repoId === repoId &&
      comment.parentType === parentType &&
      comment.parentNumber === parentNumber
  );
}

function mergeById<T extends { id: string }>(fresh: T[], carried: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of carried) {
    byId.set(item.id, item);
  }
  for (const item of fresh) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function compareEntities(
  left: Pick<NormalizedIssue | NormalizedPullRequest, "repoSlug" | "number">,
  right: Pick<NormalizedIssue | NormalizedPullRequest, "repoSlug" | "number">
): number {
  if (left.repoSlug !== right.repoSlug) {
    return left.repoSlug.localeCompare(right.repoSlug);
  }

  return left.number - right.number;
}

function compareComments(
  left: Pick<NormalizedComment, "repoSlug" | "parentNumber" | "id">,
  right: Pick<NormalizedComment, "repoSlug" | "parentNumber" | "id">
): number {
  if (left.repoSlug !== right.repoSlug) {
    return left.repoSlug.localeCompare(right.repoSlug);
  }

  if (left.parentNumber !== right.parentNumber) {
    return left.parentNumber - right.parentNumber;
  }

  return left.id.localeCompare(right.id);
}
