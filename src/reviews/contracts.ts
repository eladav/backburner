import * as path from "node:path";
import { z } from "zod";

const SHA_40 = /^[0-9a-f]{40}$/i;

const nonEmptyString = z.string().trim().min(1);
const headSha = z.string().regex(SHA_40, "must be a 40-character Git commit SHA");
const nonEmptyStringList = z.preprocess(
  (value) => typeof value === "string" ? [value] : value,
  z.array(nonEmptyString)
);

const repoRelativePath = z.string().trim().min(1).superRefine((value, context) => {
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    context.addIssue({
      code: "custom",
      message: "must be a normalized repository-relative POSIX path"
    });
    return;
  }

  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    context.addIssue({
      code: "custom",
      message: "must be a normalized repository-relative POSIX path"
    });
  }
});

export const ReviewActionSchema = z.enum([
  "APPROVE",
  "COMMENT",
  "REQUEST_CHANGES"
]);

export const ReviewFindingCategorySchema = z.enum([
  "correctness",
  "security",
  "reliability",
  "performance",
  "maintainability",
  "testing",
  "documentation",
  "accessibility",
  "other"
]);

export const ReviewFindingSeveritySchema = z.enum([
  "blocking",
  "major",
  "minor",
  "advisory"
]);

export const ReviewFindingV2Schema = z.object({
  id: nonEmptyString,
  title: nonEmptyString,
  category: ReviewFindingCategorySchema,
  severity: ReviewFindingSeveritySchema,
  actionable: z.boolean(),
  path: repoRelativePath.optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  evidence: nonEmptyString.optional(),
  impact: nonEmptyString.optional(),
  instruction: nonEmptyString.optional(),
  acceptanceCriteria: z.array(nonEmptyString).default([]),
  verification: nonEmptyStringList.default([]),
  dependsOn: z.array(nonEmptyString).default([]),
  overlapsWith: z.array(nonEmptyString).default([])
}).strict().superRefine((finding, context) => {
  const locationParts = [finding.path, finding.line, finding.side];
  const locationPartCount = locationParts.filter((value) => value !== undefined).length;
  if (locationPartCount !== 0 && locationPartCount !== locationParts.length) {
    context.addIssue({
      code: "custom",
      path: ["path"],
      message: "path, line, and side must be supplied together"
    });
  }

  if (finding.actionable) {
    for (const field of ["evidence", "impact", "instruction"] as const) {
      if (finding[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `is required for actionable finding ${finding.id}`
        });
      }
    }
    if (finding.acceptanceCriteria.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["acceptanceCriteria"],
        message: `must contain at least one item for actionable finding ${finding.id}`
      });
    }
  }

  requireUniqueIds(finding.dependsOn, "dependsOn", context);
  requireUniqueIds(finding.overlapsWith, "overlapsWith", context);
});

export const ReviewResultV2Schema = z.object({
  schemaVersion: z.literal(2),
  action: ReviewActionSchema,
  reviewedHeadSha: headSha,
  summary: nonEmptyString,
  findings: z.array(ReviewFindingV2Schema)
}).strict().superRefine((result, context) => {
  const findingIds = new Set<string>();
  result.findings.forEach((finding, index) => {
    if (findingIds.has(finding.id)) {
      context.addIssue({
        code: "custom",
        path: ["findings", index, "id"],
        message: `duplicate finding ID ${finding.id}`
      });
    }
    findingIds.add(finding.id);
  });

  result.findings.forEach((finding, index) => {
    for (const [field, references] of [
      ["dependsOn", finding.dependsOn],
      ["overlapsWith", finding.overlapsWith]
    ] as const) {
      references.forEach((referencedId, referenceIndex) => {
        if (referencedId === finding.id) {
          context.addIssue({
            code: "custom",
            path: ["findings", index, field, referenceIndex],
            message: "must not reference the finding itself"
          });
        } else if (!findingIds.has(referencedId)) {
          context.addIssue({
            code: "custom",
            path: ["findings", index, field, referenceIndex],
            message: `references unknown finding ID ${referencedId}`
          });
        }
      });
    }
  });

  addDependencyCycleIssues(result.findings, context);

  const actionableFindings = result.findings.filter((finding) => finding.actionable);
  if (result.action === "APPROVE" && actionableFindings.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "APPROVE must not contain actionable findings"
    });
  }
  if (result.action === "COMMENT" && actionableFindings.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "COMMENT must not contain actionable findings"
    });
  }
  if (
    result.action === "REQUEST_CHANGES" &&
    !actionableFindings.some((finding) => finding.severity === "blocking")
  ) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "REQUEST_CHANGES must contain at least one actionable blocking finding"
    });
  }
});

export const FixCheckResultSchema = z.object({
  command: nonEmptyString,
  outcome: z.enum(["passed", "failed", "timed_out", "skipped"]),
  durationMs: z.number().int().nonnegative()
}).strict();

export const FixResultV1Schema = z.object({
  schemaVersion: z.literal(1),
  findingId: nonEmptyString,
  disposition: z.enum(["fixed", "already_covered", "blocked"]),
  summary: nonEmptyString,
  filesChanged: z.array(repoRelativePath),
  checks: z.array(FixCheckResultSchema),
  relatedFindingIds: z.array(nonEmptyString).default([]),
  notes: z.array(nonEmptyString).default([])
}).strict().superRefine((result, context) => {
  requireUniqueIds(result.filesChanged, "filesChanged", context);
  requireUniqueIds(result.relatedFindingIds, "relatedFindingIds", context);

  if (result.relatedFindingIds.includes(result.findingId)) {
    context.addIssue({
      code: "custom",
      path: ["relatedFindingIds"],
      message: "must not contain findingId"
    });
  }
  if (result.disposition === "fixed" && result.filesChanged.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["filesChanged"],
      message: "fixed results must identify at least one changed file"
    });
  }
  if (result.disposition === "already_covered" && result.filesChanged.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["filesChanged"],
      message: "already_covered results must not report changed files"
    });
  }
});

export type ReviewAction = z.infer<typeof ReviewActionSchema>;
export type ReviewFindingCategory = z.infer<typeof ReviewFindingCategorySchema>;
export type ReviewFindingSeverity = z.infer<typeof ReviewFindingSeveritySchema>;
export type ReviewFindingV2 = z.infer<typeof ReviewFindingV2Schema>;
export type ReviewResultV2 = z.infer<typeof ReviewResultV2Schema>;
export type FixCheckResult = z.infer<typeof FixCheckResultSchema>;
export type FixResultV1 = z.infer<typeof FixResultV1Schema>;

export interface ReviewResultValidationOptions {
  targetHeadSha: string;
}

export interface FixResultValidationOptions {
  findingId: string;
  knownFindingIds?: readonly string[];
  actualChangedPaths?: readonly string[];
}

export function parseReviewResultV2(
  value: unknown,
  options: ReviewResultValidationOptions
): ReviewResultV2 {
  const parsed = ReviewResultV2Schema.parse(parseJsonValue(value));
  if (parsed.reviewedHeadSha !== options.targetHeadSha) {
    throw new Error(
      `reviewedHeadSha ${parsed.reviewedHeadSha} does not match target ${options.targetHeadSha}`
    );
  }
  return parsed;
}

export function parseFixResultV1(
  value: unknown,
  options: FixResultValidationOptions
): FixResultV1 {
  const parsed = FixResultV1Schema.parse(parseJsonValue(value));
  if (parsed.findingId !== options.findingId) {
    throw new Error(
      `findingId ${parsed.findingId} does not match expected ${options.findingId}`
    );
  }

  if (options.knownFindingIds !== undefined) {
    const known = new Set(options.knownFindingIds);
    const unknown = parsed.relatedFindingIds.find((findingId) => !known.has(findingId));
    if (unknown !== undefined) {
      throw new Error(`relatedFindingIds references unknown finding ID ${unknown}`);
    }
  }

  if (options.actualChangedPaths !== undefined) {
    const reported = [...parsed.filesChanged].sort();
    const actual = [...options.actualChangedPaths].sort();
    if (
      reported.length !== actual.length ||
      reported.some((reportedPath, index) => reportedPath !== actual[index])
    ) {
      throw new Error("filesChanged does not match the task-attributable diff");
    }
  }

  return parsed;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`invalid structured result JSON: ${detail}`);
  }
}

function requireUniqueIds(
  values: readonly string[],
  field: string,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [field, index],
        message: `duplicate value ${value}`
      });
    }
    seen.add(value);
  });
}

function addDependencyCycleIssues(
  findings: readonly ReviewFindingV2[],
  context: z.RefinementCtx
): void {
  const dependencies = new Map(
    findings.map((finding) => [finding.id, finding.dependsOn] as const)
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (findingId: string): boolean => {
    if (visiting.has(findingId)) return true;
    if (visited.has(findingId)) return false;

    visiting.add(findingId);
    for (const dependencyId of dependencies.get(findingId) ?? []) {
      if (dependencies.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(findingId);
    visited.add(findingId);
    return false;
  };

  for (const [index, finding] of findings.entries()) {
    visiting.clear();
    if (visit(finding.id)) {
      context.addIssue({
        code: "custom",
        path: ["findings", index, "dependsOn"],
        message: `dependency cycle includes finding ${finding.id}`
      });
      return;
    }
  }
}
