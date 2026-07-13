// Matches exactly: "retry: <github issuecomment URL>"
// Captures the numeric comment ID from the URL fragment.
export const RETRY_LINK_PATTERN =
  /^\s*retry:\s+https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+#issuecomment-(\d+)\s*$/i;

export function extractRetryCommentId(body: string): string | undefined {
  const match = RETRY_LINK_PATTERN.exec(body);
  return match ? match[1] : undefined;
}

export function isRetryLinkCommand(body: string): boolean {
  return RETRY_LINK_PATTERN.test(body);
}
