import * as path from "node:path";
import { z } from "zod";

export const DEFAULT_GITHUB_BROKER_SERVER_NAME = "githubBroker";
export const DEFAULT_GITHUB_BROKER_TOOLS = [
  "get_issue",
  "get_issue_comments",
  "get_pr",
  "get_pr_comments",
  "get_pr_checks",
  "search_code",
  "post_issue_comment",
  "post_pr_review_comment_reply",
  "create_pr"
] as const;

// Helper for non-empty strings that matches existing manual validation (trim + length check)
const nonEmptyString = (message: string) =>
  z.string({ message })
    .trim()
    .min(1, { message });

const optionalNonEmptyString = (message: string) =>
  z.string({ message })
    .trim()
    .min(1, { message })
    .optional();

const relativePath = (message: string, traversalMessage: string) =>
  z.string({ message })
    .trim()
    .min(1, { message })
    .refine((val) => !isAbsolutePathOnAnySupportedPlatform(val), { message })
    .transform((val) => normalizeRelativePathForCurrentPlatform(val))
    .refine((val) => val !== ".." && !val.startsWith(`..${path.sep}`), {
      message: traversalMessage
    });

function isAbsolutePathOnAnySupportedPlatform(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("\\");
}

function normalizeRelativePathForCurrentPlatform(value: string): string {
  return path.normalize(value.replaceAll("\\", path.sep));
}

export const GitHubBrokerSchema = z.object({
  serverName: nonEmptyString("must be a non-empty string").default(
    DEFAULT_GITHUB_BROKER_SERVER_NAME
  ),
  toolAllowList: z
    .array(z.string().trim().min(1), {
      message: "must be an array of strings"
    })
    .default([...DEFAULT_GITHUB_BROKER_TOOLS])
});

const ProviderBlockSchema = z.object({
  githubBroker: GitHubBrokerSchema.optional()
});

export const RepoLabelsSchema = z.object({
  agentInProgress: nonEmptyString("must be a non-empty string"),
  agentPlanApproved: nonEmptyString("must be a non-empty string"),
  agentProductApproved: optionalNonEmptyString(
    "must be a non-empty string when provided"
  ).default("agent-product-approved"),
  agentReview: nonEmptyString("must be a non-empty string"),
  planBreakdownNeeded: optionalNonEmptyString(
    "must be a non-empty string when provided"
  ).default("plan-breakdown-needed"),
  agentSyncParentBranch: optionalNonEmptyString(
    "must be a non-empty string when provided"
  ).default("agent-sync-parent-branch"),
  prepareForMerge: optionalNonEmptyString(
    "must be a non-empty string when provided"
  ).default("prepare-for-merge")
});

export const RepoConfigSchema = z.object({
  id: nonEmptyString("must be a non-empty string"),
  owner: nonEmptyString("must be a non-empty string"),
  name: nonEmptyString("must be a non-empty string"),
  defaultBranch: optionalNonEmptyString("must be a non-empty string when provided"),
  localPath: relativePath(
    "must be relative",
    "must stay within the provided code root"
  ),
  enabled: z.boolean({ message: "must be a boolean" }),
  labels: RepoLabelsSchema
});

export const ReposConfigFileSchema = z.object({
  allowedUsers: z.array(z.string().trim().min(1), {
    message: '"allowedUsers" must be an array of strings'
  }),
  repos: z.array(RepoConfigSchema, { message: '"repos" must be an array' })
});

export const AgentProviderSchema = z.enum(["codex", "gemini", "claude", "opencode", "antigravity"], {
  message: 'must be "codex", "gemini", "claude", "opencode" or "antigravity"'
});

export const ProviderLimitRecordSchema = z.object({
  provider: AgentProviderSchema,
  status: z.enum(["available", "limited"]),
  limitType: z.enum(["session", "weekly"]).optional(),
  rawError: z.string().optional(),
  detectedAt: z.string().datetime().optional(),
  resetTime: z.string().datetime().optional(),
  updatedAt: z.string().datetime()
}).strict();

export const ProviderLimitStateFileSchema = z.object({
  providerLimits: z.array(ProviderLimitRecordSchema)
}).strict();
const ModelClassSchema = z.enum(["strong", "cheap"], {
  message: 'must be "strong" or "cheap"'
});
const TrimmedModelClassSchema = z
  .string()
  .trim()
  .pipe(ModelClassSchema);

const BaseAgentConfigSchema = z.object({
  id: nonEmptyString("must be a non-empty string"),
  modelClass: TrimmedModelClassSchema,
  roles: z.array(z.string().trim().min(1), {
    message: "must be an array of strings"
  }),
  command: nonEmptyString("must be a non-empty string"),
  enabled: z.boolean({ message: "must be a boolean" })
});

const CodexConfigSchema = BaseAgentConfigSchema.extend({
  provider: z.literal("codex"),
  model: optionalNonEmptyString("must be a non-empty string when provided")
});

const GeminiConfigSchema = BaseAgentConfigSchema.extend({
  provider: z.literal("gemini"),
  model: optionalNonEmptyString("must be a non-empty string when provided")
});

const ClaudeConfigSchema = BaseAgentConfigSchema.extend({
  provider: z.literal("claude"),
  model: optionalNonEmptyString("must be a non-empty string when provided")
});

const OpenCodeConfigSchema = BaseAgentConfigSchema.extend({
  provider: z.literal("opencode"),
  model: nonEmptyString("must be a non-empty string")
});

const AntigravityConfigSchema = BaseAgentConfigSchema.extend({
  provider: z.literal("antigravity"),
  model: optionalNonEmptyString("must be a non-empty string when provided")
});

const AgentConfigDiscriminatedSchema = z.discriminatedUnion("provider", [
  CodexConfigSchema,
  GeminiConfigSchema,
  ClaudeConfigSchema,
  OpenCodeConfigSchema,
  AntigravityConfigSchema
]);

export const AgentConfigSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string") {
    return value;
  }
  return { ...record, provider: record.provider.trim() };
}, AgentConfigDiscriminatedSchema);

export const AgentsConfigFileSchema = z.object({
  agents: z.array(AgentConfigSchema, { message: '"agents" must be an array' }),
  codex: ProviderBlockSchema.optional(),
  gemini: ProviderBlockSchema.optional(),
  claude: ProviderBlockSchema.optional(),
  opencode: ProviderBlockSchema.optional(),
  antigravity: ProviderBlockSchema.optional(),
  maxConcurrentAgents: z.number({ message: '"maxConcurrentAgents" must be a number' })
    .int({ message: '"maxConcurrentAgents" must be an integer' })
    .min(1, { message: '"maxConcurrentAgents" must be at least 1' })
    .optional()
});

export const PromptProfileSchema = z.object({
  plan: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  implement: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  review: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  discuss: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  product: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  breakdown: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  waveAssessment: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  waveReplanning: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  retrospectiveExtract: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  retrospectiveInvestigate: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional(),
  retrospectiveProposal: relativePath(
    "must be relative",
    "must stay within the management directory"
  ).optional()
});

export const PromptsConfigFileSchema = z.object({
  promptProfiles: z.object({
    default: PromptProfileSchema
  }, { message: '"promptProfiles" must be an object' })
});

const BANNED_MCP_FIELDS = [
  "auth",
  "token",
  "key",
  "secret",
  "credential",
  "credentials",
  "password",
  "apiKey",
  "accessToken",
  "provider",
  "url"
];

const BANNED_CAPABILITY_FIELDS = [
  "auth",
  "token",
  "key",
  "secret",
  "credential",
  "credentials",
  "password",
  "apiKey",
  "accessToken",
  "provider",
  "url"
];

const MCP_HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;

function validateMcpHandle(handle: string, ctx: z.RefinementCtx, path?: (string | number)[]): void {
  if (!MCP_HANDLE_PATTERN.test(handle.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must contain only letters, numbers, underscores, or hyphens",
      ...(path ? { path } : {})
    });
  }
}

export const SensorObservesSchema = z.enum([
  "issues-and-prs",
  "package-docs",
  "repository-context"
]);

export const ControllerGrantsSchema = z.enum([
  "comment-on-prs",
  "comment-on-issues",
  "open-issues",
  "edit-issue-labels"
]);

export const CapabilityApprovalSchema = z.enum([
  "required",
  "not-required",
  "forbidden"
]);

export const CapabilityScopeSchema = z.enum([
  "repository",
  "task-context",
  "workstream"
]);

export const CapabilityCadenceSchema = z.enum([
  "every-orchestrator-run",
  "on-demand"
]);

const AogSensorCapabilitySchema = z.object({
  uses: nonEmptyString('sensor "uses" must be a non-empty string'),
  observes: SensorObservesSchema,
  cadence: CapabilityCadenceSchema.optional(),
  scope: CapabilityScopeSchema.optional(),

  // banned credential-like / provider / URL fields
  auth:           z.never({ message: 'banned field "auth"' }).optional(),
  token:          z.never({ message: 'banned field "token"' }).optional(),
  key:            z.never({ message: 'banned field "key"' }).optional(),
  secret:         z.never({ message: 'banned field "secret"' }).optional(),
  credential:     z.never({ message: 'banned field "credential"' }).optional(),
  credentials:    z.never({ message: 'banned field "credentials"' }).optional(),
  password:       z.never({ message: 'banned field "password"' }).optional(),
  apiKey:         z.never({ message: 'banned field "apiKey"' }).optional(),
  accessToken:    z.never({ message: 'banned field "accessToken"' }).optional(),
  provider:       z.never({ message: 'banned field "provider"' }).optional(),
  url:            z.never({ message: 'banned field "url"' }).optional(),

  // cross-type field: sensors must not have grants
  grants:         z.never({ message: 'sensor capability must not include "grants"' }).optional(),
}).strict();

const AogControllerCapabilitySchema = z.object({
  uses: nonEmptyString('controller "uses" must be a non-empty string'),
  grants: z.array(ControllerGrantsSchema, {
    message: 'controller "grants" must be an array of valid grant values',
  }).min(1, { message: 'controller "grants" must have at least one value' }),
  approval: CapabilityApprovalSchema.default("required"),

  // banned credential-like / provider / URL fields
  auth:           z.never({ message: 'banned field "auth"' }).optional(),
  token:          z.never({ message: 'banned field "token"' }).optional(),
  key:            z.never({ message: 'banned field "key"' }).optional(),
  secret:         z.never({ message: 'banned field "secret"' }).optional(),
  credential:     z.never({ message: 'banned field "credential"' }).optional(),
  credentials:    z.never({ message: 'banned field "credentials"' }).optional(),
  password:       z.never({ message: 'banned field "password"' }).optional(),
  apiKey:         z.never({ message: 'banned field "apiKey"' }).optional(),
  accessToken:    z.never({ message: 'banned field "accessToken"' }).optional(),
  provider:       z.never({ message: 'banned field "provider"' }).optional(),
  url:            z.never({ message: 'banned field "url"' }).optional(),

  // cross-type field: controllers must not have observes
  observes:       z.never({ message: 'controller capability must not include "observes"' }).optional(),
}).strict();

export const CapabilitiesConfigFileSchema = z
  .object({
    sensors: z
      .record(z.string(), AogSensorCapabilitySchema)
      .optional()
      .default({}),
    controllers: z
      .record(z.string(), AogControllerCapabilitySchema)
      .optional()
      .default({}),
  })
  .strict()
  .superRefine((data, ctx) => {
    for (const name of Object.keys(data.sensors)) {
      if (name.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "capability name must be a non-empty string",
          path: ["sensors", name],
        });
      }
    }
    for (const name of Object.keys(data.controllers)) {
      if (name.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "capability name must be a non-empty string",
          path: ["controllers", name],
        });
      }
    }

    const sensorNames = new Set(Object.keys(data.sensors));
    for (const name of Object.keys(data.controllers)) {
      if (sensorNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate capability name "${name}" across sensors and controllers`,
          path: ["controllers", name],
        });
      }
    }
  });

export const McpsConfigFileSchema = z
  .object({
    mcps: z.array(
      z.any().superRefine((val, ctx) => {
        if (typeof val === "string") {
          if (val.trim().length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'must be a non-empty string or an object with "as" and "id"'
            });
          } else {
            validateMcpHandle(val, ctx);
          }
          return;
        }

        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          const data = val as Record<string, unknown>;
          let hasCriticalError = false;

          if (typeof data.as !== "string" || data.as.trim().length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "must be a non-empty string",
              path: ["as"]
            });
            hasCriticalError = true;
          } else {
            validateMcpHandle(data.as, ctx, ["as"]);
          }
          if (typeof data.id !== "string" || data.id.trim().length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "must be a non-empty string",
              path: ["id"]
            });
            hasCriticalError = true;
          }

          if (hasCriticalError) return;

          for (const key of Object.keys(data)) {
            if (key !== "as" && key !== "id") {
              if (BANNED_MCP_FIELDS.includes(key)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `has unsupported field "${key}"`,
                  path: [key]
                });
              } else {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `has unknown field "${key}"`,
                  path: [key]
                });
              }
            }
          }
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'must be a non-empty string or an object with "as" and "id"'
        });
      }),
      { message: '"mcps" must be an array' }
    )
  })
  .strict()
  .superRefine((data, ctx) => {
    const handles = new Set<string>();
    data.mcps.forEach((entry, index) => {
      let handle: string | undefined;
      if (typeof entry === "string") {
        handle = entry;
      } else if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry)
      ) {
        handle = (entry as any).as;
      }

      if (typeof handle === "string" && handle.trim().length > 0) {
        if (handles.has(handle)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate MCP handle "${handle}"`,
            path: ["mcps", index]
          });
        }
        handles.add(handle);
      }
    });
  });

export type GitHubBrokerConfig = z.infer<typeof GitHubBrokerSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type ReposConfigFile = z.infer<typeof ReposConfigFileSchema>;
export type AgentsConfigFile = z.infer<typeof AgentsConfigFileSchema>;
export type PromptProfile = z.infer<typeof PromptProfileSchema>;
export type PromptsConfigFile = z.infer<typeof PromptsConfigFileSchema>;
export type McpsConfigFile = z.infer<typeof McpsConfigFileSchema>;

export type SensorObserves = z.infer<typeof SensorObservesSchema>;
export type ControllerGrants = z.infer<typeof ControllerGrantsSchema>;
export type CapabilityApproval = z.infer<typeof CapabilityApprovalSchema>;
export type CapabilityScope = z.infer<typeof CapabilityScopeSchema>;
export type CapabilityCadence = z.infer<typeof CapabilityCadenceSchema>;
export type AogSensorCapability = z.infer<typeof AogSensorCapabilitySchema> & { name: string };
export type AogControllerCapability = z.infer<typeof AogControllerCapabilitySchema> & { name: string };
export type CapabilityConfig = z.infer<typeof CapabilitiesConfigFileSchema>;
