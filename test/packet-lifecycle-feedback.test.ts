import * as assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubPacketLifecyclePublisher } from "../src/workstreams/packet-lifecycle-feedback.js";
import type { GitHubGateway, GhPullRequestReviewCommentReplyResult, GhIssueCommentMutationResult } from "../src/github/types.js";
import type { WorkstreamRecord } from "../src/state/types.js";

class FakeGateway {
  public postCalls: Array<{owner: string, name: string, issueNumber: number, body: string}> = [];
  public updateCalls: Array<{owner: string, name: string, commentId: string | number, body: string}> = [];
  public listCommentsReturns: Array<any> = [];

  async listPullRequestComments() {
    return this.listCommentsReturns;
  }

  async postIssueComment(input: any): Promise<GhIssueCommentMutationResult> {
    this.postCalls.push(input);
    return {
      id: 1,
      url: "",
      body: input.body,
      createdAt: "",
      updatedAt: "",
      author: null
    };
  }

  async updateIssueComment(input: any): Promise<GhIssueCommentMutationResult> {
    this.updateCalls.push(input);
    return {
      id: 1,
      url: "",
      body: input.body,
      createdAt: "",
      updatedAt: "",
      author: null
    };
  }
}

test("publisher: posts new comment when marker does not exist", async () => {
  const gateway = new FakeGateway();
  const publisher = new GitHubPacketLifecyclePublisher(gateway as unknown as GitHubGateway);

  const workstream = {
    id: "owner/repo:issue:1",
    repoKey: "owner/repo",
    integration: { prNumber: 100 },
    packetPlan: {
      status: "in_progress",
      waves: [["T1"]],
      packets: { T1: { id: "T1", status: "planned", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [] } }
    }
  } as unknown as WorkstreamRecord;

  await publisher.publishLifecycleFeedback({
    workstreams: [workstream],
    repos: [{ id: "owner/repo", owner: "owner", name: "repo", labels: { agentSyncParentBranch: "agent-sync-parent-branch", prepareForMerge: "prepare-for-merge" } } as any],
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: []
  });

  assert.equal(gateway.postCalls.length, 1);
  assert.equal(gateway.updateCalls.length, 0);
  assert.ok(gateway.postCalls[0]?.body.includes("<!-- backburner:packet-wave-status -->"));
});

test("publisher: updates comment when marker exists", async () => {
  const gateway = new FakeGateway();
  const publisher = new GitHubPacketLifecyclePublisher(gateway as unknown as GitHubGateway);

  gateway.listCommentsReturns = [
    { id: 99, body: "🤖 <!-- backburner:packet-wave-status -->\nold" }
  ];

  const workstream = {
    id: "owner/repo:issue:1",
    repoKey: "owner/repo",
    integration: { prNumber: 100 },
    packetPlan: {
      status: "in_progress",
      waves: [["T1"]],
      packets: { T1: { id: "T1", status: "planned", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [] } }
    }
  } as unknown as WorkstreamRecord;

  await publisher.publishLifecycleFeedback({
    workstreams: [workstream],
    repos: [{ id: "owner/repo", owner: "owner", name: "repo", labels: { agentSyncParentBranch: "agent-sync-parent-branch", prepareForMerge: "prepare-for-merge" } } as any],
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: []
  });

  assert.equal(gateway.postCalls.length, 0);
  assert.equal(gateway.updateCalls.length, 1);
  assert.equal(gateway.updateCalls[0]?.commentId, 99);
  assert.ok(gateway.updateCalls[0]?.body.includes("<!-- backburner:packet-wave-status -->"));
});

test("publisher: does not post when no parent PR exists", async () => {
  const gateway = new FakeGateway();
  const publisher = new GitHubPacketLifecyclePublisher(gateway as unknown as GitHubGateway);

  const workstream = {
    id: "owner/repo:issue:1",
    repoKey: "owner/repo",
    packetPlan: {
      status: "in_progress",
      waves: [["T1"]],
      packets: { T1: { id: "T1", status: "planned", title: "", summary: "", acceptanceCriteria: [], filesLikelyTouched: [], dependsOn: [], canRunInParallelWith: [], blocks: [] } }
    }
  } as unknown as WorkstreamRecord;

  await publisher.publishLifecycleFeedback({
    workstreams: [workstream],
    repos: [{ id: "owner/repo", owner: "owner", name: "repo", labels: { agentSyncParentBranch: "agent-sync-parent-branch", prepareForMerge: "prepare-for-merge" } } as any],
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: []
  });

  assert.equal(gateway.postCalls.length, 0);
  assert.equal(gateway.updateCalls.length, 0);
});

test("publisher: does not post when packetPlan is missing", async () => {
  const gateway = new FakeGateway();
  const publisher = new GitHubPacketLifecyclePublisher(gateway as unknown as GitHubGateway);

  const workstream = {
    id: "owner/repo:issue:1",
    repoKey: "owner/repo",
    integration: { prNumber: 100 }
    // packetPlan is missing
  } as unknown as WorkstreamRecord;

  await publisher.publishLifecycleFeedback({
    workstreams: [workstream],
    repos: [{ id: "owner/repo", owner: "owner", name: "repo" } as any],
    packetPrsCreatedThisRun: [],
    waveAdvancementsThisRun: [],
    blockedThisRun: []
  });

  assert.equal(gateway.postCalls.length, 0);
  assert.equal(gateway.updateCalls.length, 0);
});
