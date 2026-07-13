import type { AgentProvider } from "../config/types.js";
import type { ProviderLimitSignal, ProviderLimitRecord } from "../state/types.js";

export function detectProviderLimit(
  provider: AgentProvider,
  exitCode: number,
  stdout: string,
  stderr: string
): ProviderLimitSignal | undefined {
  const combined = (stdout + "\n" + stderr).toLowerCase();

  let isLimited = false;
  let limitType: "session" | "weekly" | undefined = undefined;

  if (exitCode === 429) {
    isLimited = true;
    limitType = "session";
  }

  if (provider === "claude") {
    if (combined.includes("rate limit exceeded") || combined.includes("quota exceeded") || combined.includes("too many requests") || exitCode === 429) {
      isLimited = true;
    }
    if (combined.includes("5-hour limit") || combined.includes("five-hour limit") || combined.includes("session limit")) {
      isLimited = true;
      limitType = "session";
    }
    if (combined.includes("weekly limit")) {
      isLimited = true;
      limitType = "weekly";
    }
  }

  if (provider === "codex") {
    if (/rate limit|quota exceeded|billing limit/i.test(combined) || combined.includes("budget exceeded") || combined.includes("thread rate limit") || combined.includes("too many requests") || exitCode === 429) {
      isLimited = true;
    }
  }

  if (provider === "gemini") {
    if (
      combined.includes("quota_exhausted") ||
      combined.includes("resource_exhausted") ||
      combined.includes("model_capacity_exhausted") ||
      combined.includes("quota exhausted") ||
      combined.includes("rate limit") ||
      combined.includes("limit exceeded") ||
      combined.includes("too many requests") ||
      exitCode === 429
    ) {
      isLimited = true;
    }
  }

  if (provider === "opencode") {
    if (/rate limit|exhausted|quota/i.test(combined) || combined.includes("limit exceeded") || combined.includes("too many requests") || exitCode === 429) {
      isLimited = true;
    }
  }

  if (provider === "antigravity") {
    if (/rate limit|usage cap|quota|session limit/i.test(combined) || combined.includes("limit exceeded") || combined.includes("too many requests") || exitCode === 429) {
      isLimited = true;
    }
  }

  if (isLimited) {
    const now = new Date();
    let resetTime: Date;

    if (limitType === "weekly") {
      resetTime = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (limitType === "session" || combined.includes("5-hour limit")) {
      limitType = "session";
      resetTime = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    } else {
      resetTime = new Date(now.getTime() + 1 * 60 * 60 * 1000);
    }

    return {
      provider,
      isLimited: true,
      limitType,
      rawError: stderr.trim() || stdout.trim() || `Exit code ${exitCode}`,
      detectedAt: now.toISOString(),
      resetTime: resetTime.toISOString()
    };
  }

  return undefined;
}

export function mapSignalToRecord(signal: ProviderLimitSignal, nowIso: string): ProviderLimitRecord {
  return {
    provider: signal.provider,
    status: signal.isLimited ? "limited" : "available",
    limitType: signal.limitType,
    rawError: signal.rawError,
    detectedAt: signal.detectedAt,
    resetTime: signal.resetTime,
    updatedAt: nowIso
  };
}
