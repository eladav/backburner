import type { RepoConfig } from "../config/types.js";
import { DEFAULT_REVIEW_AUTOMATION_MAX_TURNS } from "../config/schemas.js";
import type {
  NormalizedComment,
  NormalizedPullRequest
} from "../domain/entities.js";
import type { GitHubGateway } from "../github/types.js";
import type {
  ExecutionRecord,
  WorkstreamRecord,
  WorktreeRecord
} from "../state/types.js";
import type { StateStore } from "../state/loader.js";
import type { TaskRecord } from "../tasks/types.js";
import type { Logger } from "../utils/logger.js";
import {
  ImplementationWorkflowService,
  type ReviewFixPushIntent
} from "../worktrees/service.js";
import {
  transitionReviewCycle
} from "../workflows/review-cycle-machine/machine.js";
import {
  selectNextReviewFinding
} from "../workflows/review-cycle-machine/selectors.js";
import type {
  ReviewCyclePublisher,
  ReviewCyclePublicationReceipt
} from "../agents/review-feedback.js";
import { roleForTask } from "../agents/selection.js";
import { looksLikeReviewCycleCommand, parseReviewCycleCommand } from "./commands.js";
import { MAX_REVIEW_FINDINGS } from "./contracts.js";
import {
  createReviewSession,
  isTerminalReviewSessionStatus,
  type GitHubCommentReceipt,
  type ReviewPublicationReceipt,
  type ReviewSessionFailure,
  type ReviewSessionRecord
} from "./session.js";
import {
  buildReviewCycleFixTask,
  buildReviewCycleReviewTask
} from "./task-builders.js";

export interface ReviewCycleDispatchResult {
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
}

export interface ReviewCycleRunInput {
  repos: RepoConfig[];
  pullRequests: NormalizedPullRequest[];
  previousPullRequests: NormalizedPullRequest[];
  comments: NormalizedComment[];
  previousComments: NormalizedComment[];
  workstreams: WorkstreamRecord[];
  worktrees: WorktreeRecord[];
  sessions: ReviewSessionRecord[];
  tasks: TaskRecord[];
  executions: ExecutionRecord[];
  allowedUsers: readonly string[];
  dispatchChild(taskId: string, tasks: TaskRecord[], executions: ExecutionRecord[]): Promise<ReviewCycleDispatchResult>;
}

export interface ReviewCycleRunResult extends ReviewCycleDispatchResult {
  sessions: ReviewSessionRecord[];
  observedPullRequestHeads: Record<string, string>;
}

interface ReviewTarget {
  pullRequest: NormalizedPullRequest;
  repo: RepoConfig;
  workstream: WorkstreamRecord;
  worktree?: WorktreeRecord;
  packetId?: string;
}

export class ReviewCycleOrchestrator {
  constructor(
    private readonly stateStore: StateStore,
    private readonly gitHubGateway: GitHubGateway,
    private readonly reviewPublisher: ReviewCyclePublisher,
    private readonly implementationWorkflowService: ImplementationWorkflowService,
    private readonly logger?: Logger,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async run(input: ReviewCycleRunInput): Promise<ReviewCycleRunResult> {
    let sessions = [...input.sessions];
    let tasks = [...input.tasks];
    let executions = [...input.executions];
    const observedPullRequestHeads = new Map<string, string>();
    const handledCommandCommentIds = new Set<string>();
    const targets = resolveReviewTargets(input);

    sessions = await this.reconcileSessions(
      input,
      targets,
      sessions,
      tasks,
      observedPullRequestHeads,
      handledCommandCommentIds
    );
    await this.stateStore.writeReviewSessionState(sessions);

    // One run may execute several sequential children, but the bound prevents a
    // malformed state/provider fixture from turning into an unbounded process.
    const maxAdvances = reviewControllerAdvanceLimit(input, sessions);

    for (let pass = 0; pass < maxAdvances; pass += 1) {
      let progressed = false;

      for (const sessionSnapshot of [...sessions]) {
        const sessionIndex = sessions.findIndex((session) => session.id === sessionSnapshot.id);
        if (sessionIndex === -1) continue;
        let session = sessions[sessionIndex]!;
        const target = targets.get(targetKey(session.repoId, session.pullRequestId));

        if (isTerminalReviewSessionStatus(session.status)) {
          if (!session.terminalComment && !session.terminalPublicationSuppressedAt && target) {
            const terminalLive = await this.gitHubGateway.getPullRequest(
              target.repo.owner,
              target.repo.name,
              target.pullRequest.number
            );
            if (terminalLive.headSha) {
              observedPullRequestHeads.set(target.pullRequest.id, terminalLive.headSha);
            }
            if (terminalLive.headSha !== session.terminalHeadSha) {
              session = {
                ...session,
                terminalPublicationSuppressedAt: this.now(),
                updatedAt: this.now()
              };
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
              continue;
            }
            const published = await this.publishTerminalComment(session, target, executions);
            if (published) {
              sessions[sessionIndex] = published;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
            }
          }
          continue;
        }

        if (!target) {
          session = applyTransition(session, {
            type: "SESSION_FAILED",
            at: this.now(),
            failure: failure("orchestration", "The review target could not be resolved from the current workstream/packet state.", this.now())
          });
          sessions[sessionIndex] = session;
          await this.stateStore.writeReviewSessionState(sessions);
          progressed = true;
          continue;
        }

        const live = await this.gitHubGateway.getPullRequest(
          target.repo.owner,
          target.repo.name,
          target.pullRequest.number
        );
        if (live.headSha) observedPullRequestHeads.set(target.pullRequest.id, live.headSha);
        const liveHead = live.headSha ?? target.pullRequest.headSha;
        if (live.state !== "OPEN") {
          session = applyTransition(session, { type: "PR_CLOSED", at: this.now(), liveHeadSha: liveHead });
          sessions[sessionIndex] = session;
          await this.stateStore.writeReviewSessionState(sessions);
          progressed = true;
          continue;
        }
        if (!live.labels.some((label) => label.name === target.repo.labels.agentReview)) {
          session = applyTransition(session, { type: "REVIEW_LABEL_REMOVED", at: this.now(), liveHeadSha: liveHead });
          sessions[sessionIndex] = session;
          await this.stateStore.writeReviewSessionState(sessions);
          progressed = true;
          continue;
        }
        if (
          liveHead !== session.expectedHeadSha &&
          session.status !== "fix_handoff_pending"
        ) {
          session = applyTransition(session, {
            type: "UNEXPECTED_HEAD_OBSERVED",
            at: this.now(),
            actualHeadSha: liveHead
          });
          sessions[sessionIndex] = session;
          await this.stateStore.writeReviewSessionState(sessions);
          progressed = true;
          continue;
        }

        switch (session.status) {
          case "review_pending": {
            if (hasHumanPrTaskInFlight(tasks, session.pullRequestId)) break;
            if (!target.worktree) {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure("orchestration", "Automatic reviews require the PR's durable worktree, but none was resolved.", this.now())
              });
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
              break;
            }
            try {
              await this.implementationWorkflowService.prepareReviewCycleWorkspace({
                worktree: target.worktree,
                expectedHeadSha: session.expectedHeadSha
              });
            } catch (error) {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure("orchestration", error instanceof Error ? error.message : String(error), this.now())
              });
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
              break;
            }
            const task = buildReviewCycleReviewTask({
              identity: identity(session),
              pullRequest: target.pullRequest,
              ...(target.worktree ? { worktree: target.worktree } : {}),
              now: this.now()
            });
            tasks = upsertTask(tasks, task);
            session = applyTransition(session, {
              type: "REVIEW_TASK_DISPATCHED",
              at: this.now(),
              taskId: task.id,
              targetHeadSha: session.expectedHeadSha
            });
            sessions[sessionIndex] = session;
            await this.persistTasksAndSessions(tasks, sessions);
            ({ tasks, executions } = await input.dispatchChild(task.id, tasks, executions));
            progressed = true;
            break;
          }

          case "reviewing": {
            const task = tasks.find((candidate) => candidate.id === session.activeReviewTaskId);
            if (!task) {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure("orchestration", "The active review task is missing from durable task state.", this.now())
              });
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
              break;
            }
            if (task.status === "pending") {
              ({ tasks, executions } = await input.dispatchChild(task.id, tasks, executions));
              progressed = true;
              break;
            }
            if (task.status === "queued" || task.status === "dispatched") break;
            const execution = task.lastExecutionId
              ? executions.find((candidate) => candidate.id === task.lastExecutionId)
              : undefined;
            if (task.status === "failed" || !execution || execution.taskStatus === "failed") {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure(
                  "review",
                  execution?.errorMessage ?? "Review agent failed without a usable execution result.",
                  this.now(),
                  task,
                  execution
                )
              });
            } else if (!execution.result?.reviewCycleReview) {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure("contract", "Review agent did not return the strict review-cycle contract.", this.now(), task, execution)
              });
            } else {
              session = applyTransition(session, {
                type: "REVIEW_TASK_SUCCEEDED",
                at: this.now(),
                taskId: task.id,
                executionId: execution.id,
                result: execution.result.reviewCycleReview
              });
            }
            if (session.status === "failed" && task.status !== "failed") {
              ({ tasks, executions } = await this.invalidateCycleChild(
                task,
                execution,
                session.failure?.reason ?? "Review-cycle review child failed after execution.",
                tasks,
                executions
              ));
            }
            sessions[sessionIndex] = session;
            await this.stateStore.writeReviewSessionState(sessions);
            progressed = true;
            break;
          }

          case "review_publication_pending": {
            const task = tasks.find((candidate) =>
              candidate.id === reviewTaskId(session)
            );
            const execution = task?.lastExecutionId
              ? executions.find((candidate) => candidate.id === task.lastExecutionId)
              : undefined;
            if (!task || !execution) {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure("orchestration", "The completed review task or execution is missing.", this.now(), task, execution)
              });
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
              break;
            }
            try {
              const publicationLive = await this.gitHubGateway.getPullRequest(
                target.repo.owner,
                target.repo.name,
                target.pullRequest.number
              );
              if (publicationLive.headSha) {
                observedPullRequestHeads.set(target.pullRequest.id, publicationLive.headSha);
              }
              if (publicationLive.headSha !== session.expectedHeadSha) {
                session = applyTransition(session, {
                  type: "UNEXPECTED_HEAD_OBSERVED",
                  at: this.now(),
                  actualHeadSha: publicationLive.headSha ?? "unknown"
                });
                sessions[sessionIndex] = session;
                await this.stateStore.writeReviewSessionState(sessions);
                progressed = true;
                break;
              }
              const publication = await this.reviewPublisher.publishCycleReview(task, execution);
              const receipt = reviewReceipt(session, publication, this.now());
              session = applyTransition(session, {
                type: "REVIEW_PUBLISHED",
                at: this.now(),
                receipt,
                liveHeadSha: session.expectedHeadSha
              });
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
            } catch (error) {
              this.logger?.warn(
                `[review-cycle] Review publication remains pending for ${session.id}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            break;
          }

          case "fix_pending": {
            if (!target.worktree) {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure("orchestration", "Automatic fixes require the PR's durable worktree, but none was resolved.", this.now())
              });
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
              break;
            }
            if (hasHumanPrTaskInFlight(tasks, session.pullRequestId)) break;
            try {
              await this.implementationWorkflowService.prepareReviewCycleWorkspace({
                worktree: target.worktree,
                expectedHeadSha: session.expectedHeadSha
              });
            } catch (error) {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure("orchestration", error instanceof Error ? error.message : String(error), this.now())
              });
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
              break;
            }
            const finding = selectNextReviewFinding(session);
            if (!finding || !session.currentReview) break;
            const task = buildReviewCycleFixTask({
              identity: identity(session),
              pullRequest: target.pullRequest,
              worktree: target.worktree,
              review: session.currentReview,
              finding: finding.finding,
              precedingDispositions: completedFindingDispositions(session, finding.finding.id)
                .map((candidate) => ({
                  findingId: candidate.findingId,
                  disposition: candidate.disposition,
                  summary: candidate.summary
                })),
              ...(session.publicationReceipts.find((receipt) =>
                receipt.kind === "review" && receipt.reviewOrdinal === session.reviewOrdinal
              )?.url
                ? { reviewUrl: session.publicationReceipts.find((receipt) =>
                    receipt.kind === "review" && receipt.reviewOrdinal === session.reviewOrdinal
                  )!.url }
                : {}),
              now: this.now()
            });
            tasks = upsertTask(tasks, task);
            session = applyTransition(session, {
              type: "FIX_TASK_DISPATCHED",
              at: this.now(),
              findingId: finding.finding.id,
              taskId: task.id,
              headBefore: session.expectedHeadSha
            });
            sessions[sessionIndex] = session;
            await this.persistTasksAndSessions(tasks, sessions);
            ({ tasks, executions } = await input.dispatchChild(task.id, tasks, executions));
            progressed = true;
            break;
          }

          case "fixing": {
            const task = tasks.find((candidate) => candidate.id === session.activeFixTaskId);
            if (!task) {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure("orchestration", "The active fix task is missing from durable task state.", this.now())
              });
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
              break;
            }
            if (task.status === "pending") {
              ({ tasks, executions } = await input.dispatchChild(task.id, tasks, executions));
              progressed = true;
              break;
            }
            if (task.status === "queued" || task.status === "dispatched") break;
            const execution = task.lastExecutionId
              ? executions.find((candidate) => candidate.id === task.lastExecutionId)
              : undefined;
            if (task.status === "failed" || !execution || execution.taskStatus === "failed") {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure(
                  "fix",
                  execution?.errorMessage ?? "Fix agent failed without a usable execution result.",
                  this.now(),
                  task,
                  execution,
                  task?.context.reviewCycle?.findingId
                )
              });
            } else if (!execution.result?.reviewCycleFix) {
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: liveHead,
                failure: failure("contract", "Fix agent did not return the strict per-finding contract.", this.now(), task, execution, task.context.reviewCycle?.findingId)
              });
            } else {
              session = applyTransition(session, {
                type: "FIX_TASK_SUCCEEDED",
                at: this.now(),
                taskId: task.id,
                executionId: execution.id,
                result: execution.result.reviewCycleFix
              });
            }
            if (session.status === "failed" && task.status !== "failed") {
              ({ tasks, executions } = await this.invalidateCycleChild(
                task,
                execution,
                session.failure?.reason ?? "Review-cycle fix child failed after execution.",
                tasks,
                executions
              ));
            }
            sessions[sessionIndex] = session;
            await this.stateStore.writeReviewSessionState(sessions);
            progressed = true;
            break;
          }

          case "fix_handoff_pending": {
            if (!target.worktree || session.currentFindingIndex === undefined) break;
            const finding = session.findings[session.currentFindingIndex];
            const task = finding?.taskId ? tasks.find((candidate) => candidate.id === finding.taskId) : undefined;
            if (!finding?.result || !task) break;
            const execution = finding.executionId
              ? executions.find((candidate) => candidate.id === finding.executionId)
              : undefined;
            const pushIntent = reviewFixPushIntent(finding);
            if (finding.pushCompletedAt) {
              if (!pushIntent) {
                const reason = "Durable review-fix push observation state is incomplete.";
                ({ tasks, executions } = await this.invalidateCycleChild(
                  task,
                  execution,
                  reason,
                  tasks,
                  executions
                ));
                session = applyTransition(session, {
                  type: "SESSION_FAILED",
                  at: this.now(),
                  liveHeadSha: liveHead,
                  failure: failure("orchestration", reason, this.now(), task, execution, finding.finding.id)
                });
              } else if (live.headSha === pushIntent.headAfter) {
                session = applyTransition(session, {
                  type: "FIX_HANDOFF_PUSHED",
                  at: this.now(),
                  findingId: finding.finding.id,
                  ...pushIntent
                });
                observedPullRequestHeads.set(target.pullRequest.id, pushIntent.headAfter);
              } else if (live.headSha && live.headSha !== pushIntent.headBefore) {
                session = applyTransition(session, {
                  type: "UNEXPECTED_HEAD_OBSERVED",
                  at: this.now(),
                  actualHeadSha: live.headSha
                });
              } else {
                // The push succeeded locally and its durable receipt was stored,
                // but GitHub still reports the old/unknown head. A later outer
                // run will reconcile it without repushing or resetting budget.
                break;
              }
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
              break;
            }
            try {
              const handoff = await this.implementationWorkflowService.finalizeReviewFixHandoff({
                repo: target.repo,
                pullRequestNumber: session.pullRequestNumber,
                task,
                worktree: target.worktree,
                expectedRemoteHeadSha: session.expectedHeadSha,
                result: finding.result,
                ...(pushIntent ? { pushIntent } : {}),
                recordPushIntent: async (intent) => {
                  session = applyTransition(session, {
                    type: "FIX_HANDOFF_PUSH_INTENT_RECORDED",
                    at: this.now(),
                    findingId: finding.finding.id,
                    ...intent
                  });
                  sessions[sessionIndex] = session;
                  await this.stateStore.writeReviewSessionState(sessions);
                }
              });
              if (handoff.outcome === "head_changed") {
                ({ tasks, executions } = await this.invalidateCycleChild(
                  task,
                  execution,
                  `Review-fix handoff observed unexpected PR head ${handoff.actual}.`,
                  tasks,
                  executions
                ));
                session = applyTransition(session, {
                  type: "UNEXPECTED_HEAD_OBSERVED",
                  at: this.now(),
                  actualHeadSha: handoff.actual
                });
              } else if (handoff.outcome === "no_change") {
                session = applyTransition(session, {
                  type: "FIX_HANDOFF_NO_CHANGE",
                  at: this.now(),
                  findingId: finding.finding.id,
                  headSha: handoff.headAfter
                });
              } else if (handoff.outcome === "push_observation_pending") {
                session = applyTransition(session, {
                  type: "FIX_HANDOFF_PUSH_AWAITING_OBSERVATION",
                  at: this.now(),
                  findingId: finding.finding.id,
                  headBefore: handoff.headBefore,
                  headAfter: handoff.headAfter,
                  commitSha: handoff.commitSha,
                  filesChanged: handoff.filesChanged
                });
              } else {
                session = applyTransition(session, {
                  type: "FIX_HANDOFF_PUSHED",
                  at: this.now(),
                  findingId: finding.finding.id,
                  headBefore: handoff.headBefore,
                  headAfter: handoff.headAfter,
                  commitSha: handoff.commitSha,
                  filesChanged: handoff.filesChanged
                });
                observedPullRequestHeads.set(target.pullRequest.id, handoff.headAfter);
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              ({ tasks, executions } = await this.invalidateCycleChild(
                task,
                execution,
                reason,
                tasks,
                executions
              ));
              session = applyTransition(session, {
                type: "SESSION_FAILED",
                at: this.now(),
                liveHeadSha: session.expectedHeadSha,
                failure: failure(
                  "handoff",
                  reason,
                  this.now(),
                  task,
                  finding.executionId ? executions.find((candidate) => candidate.id === finding.executionId) : undefined,
                  finding.finding.id
                )
              });
            }
            sessions[sessionIndex] = session;
            await this.stateStore.writeReviewSessionState(sessions);
            progressed = true;
            break;
          }

          case "fix_publication_pending": {
            if (session.currentFindingIndex === undefined) break;
            const finding = session.findings[session.currentFindingIndex];
            if (!finding?.result) break;
            try {
              const receipt = await this.publishFixComment(session, target, finding, executions);
              session = applyTransition(session, {
                type: "FIX_PUBLISHED",
                at: this.now(),
                findingId: finding.finding.id,
                receipt
              });
              sessions[sessionIndex] = session;
              await this.stateStore.writeReviewSessionState(sessions);
              progressed = true;
            } catch (error) {
              this.logger?.warn(
                `[review-cycle] Fix publication remains pending for ${session.id}/${finding.finding.id}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            break;
          }
        }
      }

      const beforeCount = sessions.length;
      sessions = await this.reconcileSessions(
        input,
        targets,
        sessions,
        tasks,
        observedPullRequestHeads,
        handledCommandCommentIds
      );
      if (sessions.length !== beforeCount) {
        await this.stateStore.writeReviewSessionState(sessions);
        progressed = true;
      }

      if (!progressed) {
        return {
          sessions,
          tasks,
          executions,
          observedPullRequestHeads: Object.fromEntries(observedPullRequestHeads)
        };
      }
    }

    throw new Error("Automatic review-cycle controller exceeded its bounded fixed-point advance limit.");
  }

  private async reconcileSessions(
    input: ReviewCycleRunInput,
    targets: Map<string, ReviewTarget>,
    initial: ReviewSessionRecord[],
    tasks: readonly TaskRecord[],
    observedPullRequestHeads: Map<string, string>,
    handledCommandCommentIds: Set<string>
  ): Promise<ReviewSessionRecord[]> {
    let sessions = [...initial];
    const previousCommentsById = new Map(input.previousComments.map((comment) => [comment.id, comment]));
    const allowedUsers = new Set(input.allowedUsers.map((user) => user.toLowerCase()));

    for (const comment of input.comments) {
      if (
        !looksLikeReviewCycleCommand(comment.body) ||
        previousCommentsById.has(comment.id) ||
        !allowedUsers.has(comment.author.toLowerCase()) ||
        sessions.some((session) => session.commandCommentId === comment.id) ||
        handledCommandCommentIds.has(comment.id)
      ) {
        continue;
      }
      handledCommandCommentIds.add(comment.id);
      const command = parseReviewCycleCommand(comment.body);
      const target = [...targets.values()].find((candidate) =>
        candidate.pullRequest.repoId === comment.repoId &&
        candidate.pullRequest.number === comment.parentNumber
      );
      if (!target) continue;

      let rejectionReason: string | undefined;
      if (!command) {
        rejectionReason = "The command could not be parsed. Use `continue: <PR terminal comment URL>` or `retry: <PR terminal comment URL>`.";
      } else if (
        comment.parentType !== "pull_request" ||
        comment.commentKind !== "pull_request_comment"
      ) {
        rejectionReason = "Review-cycle commands must be posted as a top-level comment on the pull request.";
      } else if (command.target.threadKind !== "pull") {
        rejectionReason = "The target URL must be a terminal comment URL under `/pull/<number>`.";
      } else if (
        command.target.owner.toLowerCase() !== target.repo.owner.toLowerCase() ||
        command.target.name.toLowerCase() !== target.repo.name.toLowerCase() ||
        command.target.pullRequestNumber !== target.pullRequest.number
      ) {
        rejectionReason = "The target comment URL must belong to this pull request.";
      }

      const live = await this.gitHubGateway.getPullRequest(
        target.repo.owner,
        target.repo.name,
        target.pullRequest.number
      );
      if (live.headSha) observedPullRequestHeads.set(target.pullRequest.id, live.headSha);
      if (!rejectionReason && (
        live.state !== "OPEN" ||
        !live.labels.some((label) => label.name === target.repo.labels.agentReview)
      )) {
        rejectionReason = "The pull request must be open with the automatic-review label before restarting a cycle.";
      }

      const terminal = command && !rejectionReason
        ? sessions.find((session) =>
            session.terminalComment?.url === command.target.url &&
            session.terminalComment.commentId === command.target.commentId &&
            session.pullRequestId === target.pullRequest.id &&
            ((command.kind === "continue" && session.status === "max_turns") ||
              (command.kind === "retry" && session.status === "failed"))
          )
        : undefined;
      if (!rejectionReason && !terminal) {
        rejectionReason = command?.kind === "continue"
          ? "`continue` must target this pull request's max-turn terminal comment."
          : "`retry` must target this pull request's failed-run terminal comment.";
      }
      if (!rejectionReason && hasPendingReviewCycleRecovery(tasks, target.pullRequest.id)) {
        rejectionReason = "Workspace recovery is still pending; run Backburner again after recovery completes.";
      }
      if (!rejectionReason && sessions.some((session) =>
        session.pullRequestId === target.pullRequest.id && !isTerminalReviewSessionStatus(session.status)
      )) {
        rejectionReason = "A review cycle is already active for this pull request.";
      }
      if (rejectionReason) {
        sessions = await this.publishCommandRejection(sessions, target, comment, rejectionReason);
        continue;
      }
      const head = live.headSha ?? target.pullRequest.headSha;
      sessions.push(createReviewSession({
        repoId: target.repo.id,
        repoSlug: target.pullRequest.repoSlug,
        pullRequestId: target.pullRequest.id,
        pullRequestNumber: target.pullRequest.number,
        pullRequestUrl: target.pullRequest.url,
        workstreamId: target.workstream.id,
        ...(target.packetId ? { packetId: target.packetId } : {}),
        trigger: command!.kind,
        maxTurns: reviewMaxTurns(target.repo),
        headSha: head,
        ordinal: nextSessionOrdinal(sessions, target.repo.id, target.pullRequest.id),
        ...(command!.kind === "continue" ? { continuedFromSessionId: terminal!.id } : { retriedFromSessionId: terminal!.id }),
        commandCommentId: comment.id,
        commandCommentUrl: comment.url,
        now: this.now()
      }));
    }

    for (const target of targets.values()) {
      // The scan is the trigger boundary. A live lookup below validates that a
      // scanned label is still present; it must not turn every unrelated PR
      // into an extra network call (or discover labels outside the scan epoch).
      if (!target.pullRequest.labels.includes(target.repo.labels.agentReview)) {
        continue;
      }
      const live = await this.gitHubGateway.getPullRequest(
        target.repo.owner,
        target.repo.name,
        target.pullRequest.number
      );
      if (live.headSha) observedPullRequestHeads.set(target.pullRequest.id, live.headSha);
      if (
        live.state !== "OPEN" ||
        !live.labels.some((label) => label.name === target.repo.labels.agentReview)
      ) {
        continue;
      }
      if (hasPendingReviewCycleRecovery(tasks, target.pullRequest.id)) {
        continue;
      }
      const liveHead = live.headSha ?? target.pullRequest.headSha;
      if (sessions.some((session) =>
        session.repoId === target.repo.id &&
        session.pullRequestId === target.pullRequest.id &&
        !isTerminalReviewSessionStatus(session.status)
      )) {
        continue;
      }
      const latest = latestSession(sessions, target.repo.id, target.pullRequest.id);
      const previousPr = input.previousPullRequests.find((pr) => pr.id === target.pullRequest.id);
      const labelWasReappliedInScan = previousPr !== undefined &&
        !previousPr.labels.includes(target.repo.labels.agentReview) &&
        target.pullRequest.labels.includes(target.repo.labels.agentReview);
      const sessionAlreadyCreatedThisRun = sessions.some((session) =>
        session.repoId === target.repo.id &&
        session.pullRequestId === target.pullRequest.id &&
        !input.sessions.some((initialSession) => initialSession.id === session.id)
      );
      const labelReapplied = labelWasReappliedInScan && !sessionAlreadyCreatedThisRun;
      if (latest?.terminalHeadSha === liveHead && !labelReapplied) {
        continue;
      }
      sessions.push(createReviewSession({
        repoId: target.repo.id,
        repoSlug: target.pullRequest.repoSlug,
        pullRequestId: target.pullRequest.id,
        pullRequestNumber: target.pullRequest.number,
        pullRequestUrl: target.pullRequest.url,
        workstreamId: target.workstream.id,
        ...(target.packetId ? { packetId: target.packetId } : {}),
        trigger: latest ? "head_changed" : "label",
        maxTurns: reviewMaxTurns(target.repo),
        headSha: liveHead,
        ordinal: nextSessionOrdinal(sessions, target.repo.id, target.pullRequest.id),
        now: this.now()
      }));
    }
    return sessions;
  }

  private async publishCommandRejection(
    sessions: ReviewSessionRecord[],
    target: ReviewTarget,
    sourceComment: NormalizedComment,
    reason: string
  ): Promise<ReviewSessionRecord[]> {
    const ownerSession = latestSession(
      sessions,
      target.repo.id,
      target.pullRequest.id
    );
    const marker = `<!-- backburner-review-cycle-command:v1 source=${sourceComment.id} -->`;
    const [authenticatedUser, comments] = await Promise.all([
      this.gitHubGateway.getAuthenticatedUser(),
      this.gitHubGateway.listIssueComments(
        target.repo.owner,
        target.repo.name,
        sourceComment.parentNumber
      )
    ]);
    const existing = comments.find((comment) =>
      sameLogin(comment.author?.login, authenticatedUser) && comment.body.includes(marker)
    );
    const mutation = existing ?? await this.gitHubGateway.postIssueComment({
      owner: target.repo.owner,
      name: target.repo.name,
      issueNumber: sourceComment.parentNumber,
      body: [
        "🤖 Review-cycle command was not accepted.",
        "",
        safeText(reason, 800),
        "",
        marker
      ].join("\n")
    });
    if (!ownerSession || sourceComment.parentType !== "pull_request") return sessions;

    const receipt: GitHubCommentReceipt = {
      commentId: String(mutation.id),
      url: mutation.url,
      marker,
      publishedAt: this.now(),
      githubObjectKind: "pull_request_comment",
      ...(mutation.author?.login ? { authorLogin: mutation.author.login } : {})
    };
    const updated = sessions.map((session) => session.id === ownerSession.id
      ? {
          ...session,
          ownedComments: session.ownedComments.some((comment) => comment.commentId === receipt.commentId)
            ? session.ownedComments
            : [...session.ownedComments, receipt],
          updatedAt: this.now()
        }
      : session);
    await this.stateStore.writeReviewSessionState(updated);
    return updated;
  }

  private async publishFixComment(
    session: ReviewSessionRecord,
    target: ReviewTarget,
    finding: ReviewSessionRecord["findings"][number],
    executions: ExecutionRecord[]
  ): Promise<ReviewPublicationReceipt> {
    const marker = markerFor(session, "fix", finding.finding.id);
    const execution = finding.executionId
      ? executions.find((candidate) => candidate.id === finding.executionId)
      : undefined;
    const checks = finding.result?.checks ?? [];
    const [authenticatedUser, comments] = await Promise.all([
      this.gitHubGateway.getAuthenticatedUser(),
      this.gitHubGateway.listIssueComments(
        target.repo.owner,
        target.repo.name,
        session.pullRequestNumber
      )
    ]);
    const existing = comments.find((comment) =>
      sameLogin(comment.author?.login, authenticatedUser) && comment.body.includes(marker)
    );
    const mutation = existing ?? await this.gitHubGateway.postIssueComment({
        owner: target.repo.owner,
        name: target.repo.name,
        issueNumber: session.pullRequestNumber,
        body: [
          `🤖 Review cycle · Turn ${session.turnsCompleted + 1} · ${finding.finding.id} ${finding.result?.disposition === "already_covered" ? "already covered" : "fixed"}`,
          "",
          `Agent: implementation / ${execution?.agentId ?? "unknown"}`,
          `Finding: ${safeText(finding.finding.title)}`,
          `Result: ${safeText(finding.result?.summary ?? "Completed.")}`,
          ...(finding.commitSha ? [`Commit: \`${finding.commitSha.slice(0, 12)}\``] : []),
          `Checks: ${checks.filter((check) => check.outcome === "passed").length} passed, ${checks.filter((check) => check.outcome !== "passed").length} other`,
          ...(finding.result?.relatedFindingIds.length ? [`Also related: ${finding.result.relatedFindingIds.join(", ")}`] : []),
          "",
          marker
        ].join("\n")
      });
    return {
      id: `${session.id}:fix:${session.reviewOrdinal}:${finding.finding.id}`,
      kind: "fix",
      reviewOrdinal: session.reviewOrdinal,
      turnNumber: session.turnsCompleted + 1,
      findingId: finding.finding.id,
      headSha: session.expectedHeadSha,
      githubId: String(mutation.id),
      url: mutation.url,
      marker,
      publishedAt: this.now(),
      githubObjectKind: "pull_request_comment",
      ...(mutation.author?.login ? { authorLogin: mutation.author.login } : {}),
      ownedCommentIds: []
    };
  }

  private async publishTerminalComment(
    session: ReviewSessionRecord,
    target: ReviewTarget,
    executions: ExecutionRecord[]
  ): Promise<ReviewSessionRecord | undefined> {
    const marker = markerFor(session, "terminal");
    try {
      const [authenticatedUser, comments] = await Promise.all([
        this.gitHubGateway.getAuthenticatedUser(),
        this.gitHubGateway.listIssueComments(
          target.repo.owner,
          target.repo.name,
          session.pullRequestNumber
        )
      ]);
      const existing = comments.find((comment) =>
        sameLogin(comment.author?.login, authenticatedUser) && comment.body.includes(marker)
      );
      const mutation = existing ?? await this.gitHubGateway.postIssueComment({
          owner: target.repo.owner,
          name: target.repo.name,
          issueNumber: session.pullRequestNumber,
          body: renderTerminalTimeline(session, executions, marker)
        });
      return {
        ...session,
        terminalComment: {
          commentId: String(mutation.id),
          url: mutation.url,
          marker,
          publishedAt: this.now(),
          githubObjectKind: "pull_request_comment",
          ...(mutation.author?.login ? { authorLogin: mutation.author.login } : {})
        },
        updatedAt: this.now()
      };
    } catch (error) {
      this.logger?.warn(
        `[review-cycle] Terminal timeline remains unpublished for ${session.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  private async invalidateCycleChild(
    task: TaskRecord,
    execution: ExecutionRecord | undefined,
    reason: string,
    tasks: TaskRecord[],
    executions: ExecutionRecord[]
  ): Promise<ReviewCycleDispatchResult> {
    const failedAt = this.now();
    const requiresRecovery = task.executionPermission === "workspace-write" &&
      task.context.localRepoPath !== undefined;
    const updatedTask: TaskRecord = {
      ...task,
      status: "failed",
      updatedAt: failedAt,
      context: {
        ...task.context,
        ...(requiresRecovery ? { recoveryNeeded: true } : {})
      }
    };
    const updatedTasks = tasks.map((candidate) =>
      candidate.id === task.id ? updatedTask : candidate
    );
    const updatedExecutions = execution
      ? executions.map((candidate): ExecutionRecord => candidate.id === execution.id
        ? {
            ...candidate,
            taskStatus: "failed",
            errorMessage: safeText(reason, 1200)
          }
        : candidate)
      : executions;

    await this.stateStore.writeTaskState(updatedTasks);
    if (execution) await this.stateStore.writeExecutionState(updatedExecutions);

    if (execution && execution.agentProvider !== "unassigned" && task.workstreamId) {
      try {
        const state = await this.stateStore.load();
        const providerSessions = (state.providerSessions ?? []).map((record) => {
          const scope = record.scope;
          if (
            scope.repoKey !== task.repoSlug ||
            scope.workstreamId !== task.workstreamId ||
            scope.job !== roleForTask(task) ||
            scope.configuredAgentId !== execution.agentId ||
            scope.provider !== execution.agentProvider ||
            scope.localRepoPath !== task.context.localRepoPath ||
            scope.branchName !== task.context.branchName
          ) {
            return record;
          }
          return {
            ...record,
            status: "stale" as const,
            lastFailedAt: failedAt,
            updatedAt: failedAt,
            notes: `Marked stale after review-cycle post-execution failure: ${safeText(reason, 400)}`
          };
        });
        await this.stateStore.writeProviderSessionState(providerSessions);
      } catch (error) {
        this.logger?.warn(
          `[review-cycle] Failed to stale provider conversation for ${task.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return { tasks: updatedTasks, executions: updatedExecutions };
  }

  private async persistTasksAndSessions(tasks: TaskRecord[], sessions: ReviewSessionRecord[]): Promise<void> {
    await this.stateStore.writeTaskState(tasks);
    await this.stateStore.writeReviewSessionState(sessions);
  }
}

function resolveReviewTargets(input: ReviewCycleRunInput): Map<string, ReviewTarget> {
  const result = new Map<string, ReviewTarget>();
  for (const pullRequest of input.pullRequests) {
    const repo = input.repos.find((candidate) => candidate.id === pullRequest.repoId);
    if (!repo) continue;
    const worktree = input.worktrees.find((candidate) =>
      candidate.repoId === pullRequest.repoId &&
      (candidate.prId === pullRequest.id || candidate.prNumber === pullRequest.number || candidate.branchName === pullRequest.headBranch)
    );
    const workstream = input.workstreams.find((candidate) =>
      candidate.repoKey === pullRequest.repoKey &&
      (
        (candidate.origin.type === "pr" && candidate.origin.number === pullRequest.number) ||
        candidate.linkedPrs.some((linked) => linked.number === pullRequest.number) ||
        (worktree?.packet?.parentWorkstreamId === candidate.id)
      )
    );
    // Review sessions may dispatch workspace-writing fixes, so a target is not
    // admitted until the CLI has materialized an isolated durable worktree.
    if (!workstream || !worktree) continue;
    result.set(targetKey(repo.id, pullRequest.id), {
      pullRequest,
      repo,
      workstream,
      worktree,
      ...(worktree?.packet?.packetId ? { packetId: worktree.packet.packetId } : {})
    });
  }
  return result;
}

function identity(session: ReviewSessionRecord) {
  return {
    sessionId: session.id,
    workstreamId: session.workstreamId,
    ...(session.packetId ? { packetId: session.packetId } : {}),
    reviewOrdinal: session.reviewOrdinal,
    expectedHeadSha: session.expectedHeadSha
  };
}

function applyTransition(
  session: ReviewSessionRecord,
  event: Parameters<typeof transitionReviewCycle>[1]
): ReviewSessionRecord {
  const transition = transitionReviewCycle(session, event);
  if (!transition.accepted) {
    throw new Error(
      `Illegal review-cycle transition ${event.type} for ${session.id}/${session.status}: ${transition.rejectionReason}`
    );
  }
  return transition.session;
}

function failure(
  step: ReviewSessionFailure["step"],
  reason: string,
  failedAt: string,
  task?: TaskRecord,
  execution?: ExecutionRecord,
  findingId?: string
): ReviewSessionFailure {
  return {
    step,
    reason: safeText(reason, 1200),
    ...(task ? { taskId: task.id } : {}),
    ...(execution ? { executionId: execution.id } : {}),
    ...(findingId ? { findingId } : {}),
    failedAt
  };
}

function reviewReceipt(
  session: ReviewSessionRecord,
  publication: ReviewCyclePublicationReceipt,
  publishedAt: string
): ReviewPublicationReceipt {
  return {
    id: `${session.id}:review:${session.reviewOrdinal}`,
    kind: "review",
    reviewOrdinal: session.reviewOrdinal,
    headSha: session.expectedHeadSha,
    githubId: publication.id,
    url: publication.url,
    marker: markerFor(session, "review"),
    publishedAt,
    githubObjectKind: publication.commentKind,
    ...(publication.author ? { authorLogin: publication.author } : {}),
    ownedCommentIds: publication.ownedReviewCommentIds
  };
}

function renderTerminalTimeline(
  session: ReviewSessionRecord,
  executions: ExecutionRecord[],
  marker: string
): string {
  const title = terminalTitle(session);
  const lines = [
    `🤖 ${title}`,
    "",
    `Session: \`${session.id}\``,
    `Current head: \`${(session.terminalHeadSha ?? session.expectedHeadSha).slice(0, 12)}\``,
    `Fix turns completed: ${session.turnsCompleted}/${session.maxTurns}`,
    "",
    "| Step | Agent | Handled | Result |",
    "|---|---|---|---|"
  ];
  for (const event of session.events) {
    if (event.type === "review_completed") {
      const execution = event.executionId ? executions.find((candidate) => candidate.id === event.executionId) : undefined;
      const review = session.publicationReceipts.find((receipt) =>
        receipt.kind === "review" && receipt.reviewOrdinal === event.reviewOrdinal
      );
      lines.push(`| Review ${event.reviewOrdinal} | review / ${execution?.agentId ?? "unknown"} | head ${(event.headSha ?? "unknown").slice(0, 12)} | ${review ? `[published](${review.url})` : "completed"} |`);
    }
    if (event.type === "fix_published" && event.findingId) {
      const fixExecutionEvent = session.events.find((candidate) =>
        candidate.type === "fix_completed" &&
        candidate.findingId === event.findingId &&
        candidate.reviewOrdinal === event.reviewOrdinal
      );
      const execution = fixExecutionEvent?.executionId
        ? executions.find((candidate) => candidate.id === fixExecutionEvent.executionId)
        : undefined;
      const finding = session.publicationReceipts.find((receipt) =>
        receipt.kind === "fix" && receipt.findingId === event.findingId && receipt.reviewOrdinal === event.reviewOrdinal
      );
      lines.push(
        `| Fix ${event.findingId} | implementation / ${execution?.agentId ?? "unknown"} | finding ${safeText(event.findingId, 40)} | ${finding ? `[published](${finding.url})` : "completed"} |`
      );
    }
  }
  if (session.status === "max_turns") {
    lines.push("", "The configured maximum was reached; no additional fixes were dispatched.", "", "To start a fresh review budget, post:", `\`continue: <this comment URL>\``);
  }
  if (session.status === "failed") {
    lines.push("", `Stopped at: ${safeText(session.failure?.step ?? "unknown")}`, `Reason: ${safeText(session.failure?.reason ?? "unknown")}`, "", "To restart the entire review process, post:", `\`retry: <this comment URL>\``);
  }
  lines.push("", marker);
  return lines.join("\n");
}

function terminalTitle(session: ReviewSessionRecord): string {
  switch (session.status) {
    case "approved": return "Automatic review cycle approved the current head";
    case "no_actionable": return "Automatic review cycle completed with no actionable findings";
    case "max_turns": return `Automatic review cycle reached its ${session.maxTurns}-turn limit`;
    case "failed": return "Automatic review cycle stopped after a failed run";
    case "superseded": return "Automatic review cycle was superseded by a new head";
    case "canceled": return "Automatic review cycle was canceled";
    default: return "Automatic review cycle completed";
  }
}

function markerFor(session: ReviewSessionRecord, kind: string, findingId?: string): string {
  return `<!-- backburner-review-cycle:v1 session=${session.id} kind=${kind} ordinal=${session.reviewOrdinal}${findingId ? ` finding=${findingId}` : ""} -->`;
}

function sameLogin(candidate: string | undefined, expected: string): boolean {
  return candidate?.toLowerCase() === expected.toLowerCase();
}

function targetKey(repoId: string, pullRequestId: string): string {
  return `${repoId}\u0000${pullRequestId}`;
}

function nextSessionOrdinal(sessions: ReviewSessionRecord[], repoId: string, pullRequestId: string): number {
  return sessions.filter((session) => session.repoId === repoId && session.pullRequestId === pullRequestId).length + 1;
}

function latestSession(
  sessions: ReviewSessionRecord[],
  repoId: string,
  pullRequestId: string
): ReviewSessionRecord | undefined {
  return sessions
    .filter((session) => session.repoId === repoId && session.pullRequestId === pullRequestId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function reviewTaskId(session: ReviewSessionRecord): string {
  return `task:review_pr:${session.id}:review:${session.reviewOrdinal}`;
}

function upsertTask(tasks: TaskRecord[], task: TaskRecord): TaskRecord[] {
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) return [...tasks, task];
  return [...tasks.slice(0, index), tasks[index]!, ...tasks.slice(index + 1)];
}

function hasHumanPrTaskInFlight(tasks: TaskRecord[], pullRequestId: string): boolean {
  return tasks.some((task) =>
    task.kind === "respond_pr_comment" &&
    task.parentSourceId === pullRequestId &&
    (task.status === "pending" || task.status === "queued" || task.status === "dispatched")
  );
}

function hasPendingReviewCycleRecovery(tasks: readonly TaskRecord[], pullRequestId: string): boolean {
  return tasks.some((task) =>
    task.sourceId === pullRequestId &&
    task.context.reviewCycle !== undefined &&
    task.context.recoveryNeeded === true
  );
}

function reviewFixPushIntent(
  finding: ReviewSessionRecord["findings"][number]
): ReviewFixPushIntent | undefined {
  return finding.pushIntentRecordedAt &&
    finding.headBefore &&
    finding.headAfter &&
    finding.commitSha &&
    finding.filesChanged
    ? {
        headBefore: finding.headBefore,
        headAfter: finding.headAfter,
        commitSha: finding.commitSha,
        filesChanged: finding.filesChanged
      }
    : undefined;
}

function completedFindingDispositions(
  session: ReviewSessionRecord,
  currentFindingId: string
): Array<{
  findingId: string;
  disposition: NonNullable<ReviewSessionRecord["findings"][number]["result"]>["disposition"];
  summary: string;
}> {
  const completionSequence = new Map<string, number>();
  for (const event of session.events) {
    if (
      event.type === "fix_published" &&
      event.reviewOrdinal === session.reviewOrdinal &&
      event.findingId
    ) {
      completionSequence.set(event.findingId, event.sequence);
    }
  }
  return session.findings
    .filter((finding) =>
      finding.finding.id !== currentFindingId &&
      finding.result !== undefined &&
      (finding.status === "fixed" || finding.status === "already_covered")
    )
    .sort((left, right) =>
      (completionSequence.get(left.finding.id) ?? Number.MAX_SAFE_INTEGER) -
      (completionSequence.get(right.finding.id) ?? Number.MAX_SAFE_INTEGER)
    )
    .map((finding) => ({
      findingId: finding.finding.id,
      disposition: finding.result!.disposition,
      summary: finding.result!.summary
    }));
}

function reviewControllerAdvanceLimit(
  input: ReviewCycleRunInput,
  sessions: readonly ReviewSessionRecord[]
): number {
  const transitionsPerFinding = 6;
  const transitionsPerReview = 8;
  const configuredRemainingWork = input.pullRequests.reduce((total, pullRequest) => {
    const repo = input.repos.find((candidate) => candidate.id === pullRequest.repoId);
    if (!repo) return total;
    return total + (reviewMaxTurns(repo) + 1) *
      (MAX_REVIEW_FINDINGS * transitionsPerFinding + transitionsPerReview);
  }, 0);
  const persistedWork = sessions.reduce((total, session) =>
    total + Math.max(1, session.findings.length) * transitionsPerFinding + transitionsPerReview,
  0);
  return Math.max(50, configuredRemainingWork + persistedWork + 20);
}

function safeText(value: string, limit = 300): string {
  return value.replace(/[\r\n|]+/g, " ").replace(/[<>]/g, "").trim().slice(0, limit);
}

function reviewMaxTurns(repo: RepoConfig): number {
  return repo.reviewAutomation?.maxTurns ?? DEFAULT_REVIEW_AUTOMATION_MAX_TURNS;
}
