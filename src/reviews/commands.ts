export type ReviewCycleCommandKind = "continue" | "retry";

export interface ReviewCycleCommand {
  kind: ReviewCycleCommandKind;
  target: {
    owner: string;
    name: string;
    threadKind: "issues" | "pull";
    pullRequestNumber: number;
    commentId: string;
    url: string;
  };
}

const REVIEW_CYCLE_COMMAND_PATTERN =
  /^\s*(continue|retry):\s+(https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)#issuecomment-(\d+))\s*$/iu;

export function parseReviewCycleCommand(body: string): ReviewCycleCommand | undefined {
  const match = REVIEW_CYCLE_COMMAND_PATTERN.exec(body);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6] || !match[7]) {
    return undefined;
  }
  return {
    kind: match[1].toLowerCase() as ReviewCycleCommandKind,
    target: {
      owner: match[3],
      name: match[4],
      threadKind: match[5] as "issues" | "pull",
      pullRequestNumber: Number(match[6]),
      commentId: match[7],
      url: match[2]
    }
  };
}

export function isReviewCycleCommand(body: string): boolean {
  return parseReviewCycleCommand(body) !== undefined;
}
