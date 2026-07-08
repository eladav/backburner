import type { BrokerToolCallSuccess } from "./types.js";

const MODEL_VISIBLE_BODY_LENGTH = 1_500;
const MODEL_VISIBLE_LIST_LENGTH = 10;
const MODEL_VISIBLE_READ_TOOLS = new Set([
  "get_issue",
  "get_issue_comments",
  "get_pr",
  "get_pr_comments",
  "get_pr_checks",
  "search_code"
]);

export function createModelVisibleSuccessText(result: BrokerToolCallSuccess): string {
  if (!MODEL_VISIBLE_READ_TOOLS.has(result.tool)) {
    return result.summary;
  }

  return [
    `${result.summary}. Model-visible result projection follows; full untruncated result is available in structuredContent.`,
    JSON.stringify(createReadToolProjection(result.tool, result.result), null, 2)
  ].join("\n");
}

function createReadToolProjection(tool: string, result: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case "get_issue":
      return { repo: result.repo, issue: projectIssue(result.issue) };
    case "get_issue_comments":
      return {
        repo: result.repo,
        issueNumber: result.issueNumber,
        comments: projectList(result.comments, projectComment)
      };
    case "get_pr":
      return {
        repo: result.repo,
        pullRequestNumber: getRecordProperty(result.pullRequest, "number"),
        pullRequest: projectPullRequest(result.pullRequest)
      };
    case "get_pr_comments":
      return {
        repo: result.repo,
        pullRequestNumber: result.pullRequestNumber,
        comments: projectList(result.comments, projectComment),
        reviews: projectList(result.reviews, projectReview),
        reviewComments: projectList(result.reviewComments, projectReviewComment)
      };
    case "get_pr_checks":
      return {
        repo: result.repo,
        pullRequestNumber: result.pullRequestNumber,
        headSha: result.headSha,
        checkRuns: projectList(result.checkRuns, projectCheckRun)
      };
    case "search_code":
      return {
        repo: result.repo,
        query: result.query,
        pathPrefix: result.pathPrefix,
        totalCount: result.totalCount,
        incompleteResults: result.incompleteResults,
        items: projectList(result.items, projectSearchCodeItem)
      };
    default:
      return { summary: "No model-visible projection is configured for this read tool." };
  }
}

function projectIssue(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    id: value.id,
    number: value.number,
    title: value.title,
    state: value.state,
    author: projectActor(value.author),
    url: value.url,
    labels: projectLabels(value.labels),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...projectBody(value.body)
  };
}

function projectPullRequest(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    id: value.id,
    number: value.number,
    title: value.title,
    state: value.state,
    author: projectActor(value.author),
    url: value.url,
    labels: projectLabels(value.labels),
    headRefName: value.headRefName,
    headSha: value.headSha,
    baseRefName: value.baseRefName,
    isDraft: value.isDraft,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...projectBody(value.body)
  };
}

function projectComment(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    id: value.id,
    author: projectActor(value.author),
    url: value.url,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...projectBody(value.body)
  };
}

function projectReview(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    id: value.id,
    author: projectActor(value.author),
    state: value.state,
    url: value.url,
    submittedAt: value.submittedAt,
    updatedAt: value.updatedAt,
    ...projectBody(value.body)
  };
}

function projectReviewComment(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    id: value.id,
    author: projectActor(value.user),
    url: value.html_url,
    path: value.path,
    line: value.line,
    originalLine: value.original_line,
    side: value.side,
    startLine: value.start_line,
    startSide: value.start_side,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    ...projectBody(value.body)
  };
}

function projectCheckRun(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    id: value.id,
    name: value.name,
    status: value.status,
    conclusion: value.conclusion,
    url: value.url,
    startedAt: value.startedAt,
    completedAt: value.completedAt
  };
}

function projectSearchCodeItem(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    name: value.name,
    path: value.path,
    sha: value.sha,
    htmlUrl: value.htmlUrl
  };
}

function projectList(
  value: unknown,
  projectItem: (item: unknown) => Record<string, unknown> | undefined
): Record<string, unknown> {
  const items = Array.isArray(value) ? value : [];
  const visibleItems = items.slice(-MODEL_VISIBLE_LIST_LENGTH);

  return {
    totalCount: items.length,
    returnedCount: visibleItems.length,
    truncated: visibleItems.length < items.length,
    ...(visibleItems.length < items.length
      ? { truncationNote: `Showing the latest ${visibleItems.length} of ${items.length} items.` }
      : {}),
    items: visibleItems.map(projectItem).filter((item): item is Record<string, unknown> => item !== undefined)
  };
}

function projectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return { body: null };
  }

  if (value.length <= MODEL_VISIBLE_BODY_LENGTH) {
    return { body: value };
  }

  return {
    body: `${value.slice(0, MODEL_VISIBLE_BODY_LENGTH)}\n...[truncated]`,
    bodyTruncated: true,
    bodyOriginalLength: value.length
  };
}

function projectActor(value: unknown): string | null {
  return isRecord(value) && typeof value.login === "string" ? value.login : null;
}

function projectLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((label) => (isRecord(label) && typeof label.name === "string" ? label.name : undefined))
    .filter((label): label is string => label !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecordProperty(value: unknown, property: string): unknown {
  return isRecord(value) ? value[property] : undefined;
}
