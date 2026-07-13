import * as assert from "node:assert/strict";
import { test } from "node:test";
import { projectCapabilities } from "../src/capabilities/index.js";
import type { CapabilityProjectionInput } from "../src/capabilities/index.js";
import type { McpDependency, NormalizedCapabilities } from "../src/config/types.js";
import type { McpStatusRecord } from "../src/state/types.js";

function makeDependency(handle: string): McpDependency {
  return { handle, smitheryId: `${handle}-smithery` };
}

function makeStatus(
  handle: string,
  status: McpStatusRecord["status"],
  message?: string
): McpStatusRecord {
  return {
    handle,
    providerId: "smithery",
    providerMcpId: `${handle}-provider`,
    status,
    lastCheckedAt: "2026-06-19T00:00:00Z",
    ...(message ? { message } : {}),
  };
}

function makeCapabilities(): NormalizedCapabilities {
  return {
    sensors: [
      {
        name: "repo-context",
        uses: "gh",
        observes: "issues-and-prs",
        cadence: "every-orchestrator-run",
        scope: "repository",
      },
      {
        name: "package-docs",
        uses: "pkg",
        observes: "package-docs",
      },
    ],
    controllers: [
      {
        name: "pr-comments",
        uses: "gh",
        grants: ["comment-on-prs"],
        approval: "required",
      },
      {
        name: "issue-labels",
        uses: "gh",
        grants: ["edit-issue-labels"],
        approval: "not-required",
      },
    ],
  };
}

function makeInput(overrides: Partial<CapabilityProjectionInput> = {}): CapabilityProjectionInput {
  return {
    capabilities: makeCapabilities(),
    declaredMcps: [makeDependency("gh"), makeDependency("pkg")],
    mcpStatuses: [makeStatus("gh", "ready"), makeStatus("pkg", "ready")],
    registeredPublicBrokerToolNames: [
      "githubBroker.get_issue",
      "githubBroker.get_issue_comments",
      "githubBroker.get_pr",
      "githubBroker.get_pr_comments",
      "githubBroker.search_code",
      "githubBroker.post_issue_comment",
      "githubBroker.post_pr_review_comment_reply",
      "pkg.resolve-library-id",
      "pkg.query-docs",
    ],
    providerRunAllowList: [
      "githubBroker.get_issue",
      "githubBroker.get_issue_comments",
      "githubBroker.get_pr",
      "githubBroker.get_pr_comments",
      "githubBroker.search_code",
      "githubBroker.post_issue_comment",
      "githubBroker.post_pr_review_comment_reply",
      "pkg.resolve-library-id",
      "pkg.query-docs",
    ],
    ...overrides,
  };
}

test("projects ready sensors and controllers to concrete broker tools", () => {
  const result = projectCapabilities(makeInput());

  assert.deepEqual(result.sensors, [
    {
      name: "repo-context",
      uses: "gh",
      observes: "issues-and-prs",
      cadence: "every-orchestrator-run",
      scope: "repository",
      tools: [
        "githubBroker.get_issue",
        "githubBroker.get_issue_comments",
        "githubBroker.get_pr",
        "githubBroker.get_pr_comments",
      ],
    },
    {
      name: "package-docs",
      uses: "pkg",
      observes: "package-docs",
      tools: ["pkg.resolve-library-id", "pkg.query-docs"],
    },
  ]);

  assert.deepEqual(result.controllers, [
    {
      name: "pr-comments",
      uses: "gh",
      grants: ["comment-on-prs"],
      approval: "required",
      tools: ["githubBroker.post_issue_comment"],
    },
  ]);

  assert.ok(
    result.blocked.some(
      (blocked) => blocked.name === "issue-labels" && blocked.reason === "capability_tools_unavailable"
    )
  );
});

test("ready capability with blocked MCP status stays blocked", () => {
  const result = projectCapabilities(
    makeInput({
      mcpStatuses: [makeStatus("gh", "action_required", "Needs auth"), makeStatus("pkg", "ready")],
    })
  );

  assert.ok(
    result.blocked.some(
      (blocked) =>
        blocked.name === "repo-context" &&
        blocked.reason === "mcp_action_required" &&
        blocked.mcpStatus === "action_required"
    )
  );
  assert.equal(result.sensors.some((sensor) => sensor.name === "repo-context"), false);
});

test("ready capability with no mapped tools is blocked as capability_tools_unavailable", () => {
  const result = projectCapabilities(
    makeInput({
      capabilities: {
        sensors: [],
        controllers: [
          {
            name: "issue-labels",
            uses: "gh",
            grants: ["edit-issue-labels"],
            approval: "required",
          },
        ],
      },
      declaredMcps: [makeDependency("gh")],
      mcpStatuses: [makeStatus("gh", "ready")],
    })
  );

  assert.equal(result.controllers.length, 0);
  assert.ok(
    result.blocked.some(
      (blocked) =>
        blocked.name === "issue-labels" &&
        blocked.reason === "capability_tools_unavailable" &&
        blocked.message?.includes("No registered broker tool")
    )
  );
});

test("ready capability loses all tools when run allow-list excludes them", () => {
  const result = projectCapabilities(
    makeInput({
      providerRunAllowList: ["githubBroker.search_code"],
    })
  );

  assert.equal(result.controllers.some((controller) => controller.name === "pr-comments"), false);
  assert.ok(
    result.blocked.some(
      (blocked) =>
        blocked.name === "pr-comments" &&
        blocked.reason === "capability_tools_not_allowed" &&
        blocked.message?.includes("allow-list")
    )
  );
});

test("package docs sensor projects only explicit docs tools for the same MCP handle", () => {
  const result = projectCapabilities(
    makeInput({
      capabilities: {
        sensors: [
          {
            name: "cloud-docs",
            uses: "cloud7",
            observes: "package-docs",
          },
        ],
        controllers: [],
      },
      declaredMcps: [makeDependency("cloud7")],
      mcpStatuses: [makeStatus("cloud7", "ready")],
      registeredPublicBrokerToolNames: [
        "cloud7.resolve-library-id",
        "cloud7.get-library-docs",
        "cloud7.query-docs",
        "cloud7.write-docs",
        "cloud7.unmapped",
      ],
      providerRunAllowList: [
        "cloud7.resolve-library-id",
        "cloud7.get-library-docs",
        "cloud7.query-docs",
        "cloud7.write-docs",
        "cloud7.unmapped",
      ],
    })
  );

  assert.deepEqual(result.sensors, [
    {
      name: "cloud-docs",
      uses: "cloud7",
      observes: "package-docs",
      tools: ["cloud7.resolve-library-id", "cloud7.get-library-docs", "cloud7.query-docs"],
    },
  ]);
  assert.deepEqual(result.blocked, []);
});

test("package-docs sensor is scoped to its declared uses handle", () => {
  const result = projectCapabilities(
    makeInput({
      capabilities: {
        sensors: [
          {
            name: "pkg-docs",
            uses: "pkg",
            observes: "package-docs",
          },
        ],
        controllers: [],
      },
      declaredMcps: [makeDependency("pkg"), makeDependency("cloud7")],
      mcpStatuses: [makeStatus("pkg", "ready"), makeStatus("cloud7", "ready")],
      registeredPublicBrokerToolNames: [
        "pkg.query-docs",
        "cloud7.query-docs",
        "cloud7.get-library-docs",
      ],
      providerRunAllowList: [
        "pkg.query-docs",
        "cloud7.query-docs",
        "cloud7.get-library-docs",
      ],
    })
  );

  assert.deepEqual(result.sensors, [
    {
      name: "pkg-docs",
      uses: "pkg",
      observes: "package-docs",
      tools: ["pkg.query-docs"],
    },
  ]);
});

test("wrong-handle docs tools do not make a package-docs capability valid", () => {
  const result = projectCapabilities(
    makeInput({
      capabilities: {
        sensors: [
          {
            name: "pkg-docs",
            uses: "pkg",
            observes: "package-docs",
          },
        ],
        controllers: [],
      },
      declaredMcps: [makeDependency("pkg"), makeDependency("cloud7")],
      mcpStatuses: [makeStatus("pkg", "ready"), makeStatus("cloud7", "ready")],
      registeredPublicBrokerToolNames: [
        "cloud7.query-docs",
        "cloud7.get-library-docs",
      ],
      providerRunAllowList: [
        "cloud7.query-docs",
        "cloud7.get-library-docs",
      ],
    })
  );

  assert.deepEqual(result.sensors, []);
  assert.ok(
    result.blocked.some(
      (blocked) => blocked.name === "pkg-docs" && blocked.reason === "capability_tools_unavailable"
    )
  );
});

test("package docs sensor does not project same-handle MCP tools from wildcard allow-list", () => {
  const result = projectCapabilities(
    makeInput({
      capabilities: {
        sensors: [
          {
            name: "cloud-docs",
            uses: "cloud7",
            observes: "package-docs",
          },
        ],
        controllers: [],
      },
      declaredMcps: [makeDependency("cloud7")],
      mcpStatuses: [makeStatus("cloud7", "ready")],
      registeredPublicBrokerToolNames: [
        "cloud7.resolve-library-id",
        "cloud7.get-library-docs",
      ],
      providerRunAllowList: ["cloud7.*"],
    })
  );

  assert.deepEqual(result.sensors, []);
  assert.ok(
    result.blocked.some(
      (blocked) => blocked.name === "cloud-docs" && blocked.reason === "capability_tools_not_allowed"
    )
  );
});

test("package-docs is blocked when only repository search is registered", () => {
  const result = projectCapabilities(
    makeInput({
      capabilities: {
        sensors: [
          {
            name: "cloud-docs",
            uses: "cloud7",
            observes: "package-docs",
          },
        ],
        controllers: [],
      },
      declaredMcps: [makeDependency("cloud7")],
      mcpStatuses: [makeStatus("cloud7", "ready")],
      registeredPublicBrokerToolNames: ["githubBroker.search_code"],
      providerRunAllowList: ["githubBroker.search_code"],
    })
  );

  assert.deepEqual(result.sensors, []);
  assert.ok(
    result.blocked.some(
      (blocked) => blocked.name === "cloud-docs" && blocked.reason === "capability_tools_unavailable"
    )
  );
});

test("repository-context continues to project repository code search", () => {
  const result = projectCapabilities(
    makeInput({
      capabilities: {
        sensors: [
          {
            name: "repo-search",
            uses: "gh",
            observes: "repository-context",
          },
        ],
        controllers: [],
      },
      declaredMcps: [makeDependency("gh")],
      mcpStatuses: [makeStatus("gh", "ready")],
      registeredPublicBrokerToolNames: ["githubBroker.search_code"],
      providerRunAllowList: ["githubBroker.search_code"],
    })
  );

  assert.deepEqual(result.sensors, [
    {
      name: "repo-search",
      uses: "gh",
      observes: "repository-context",
      tools: ["githubBroker.search_code"],
    },
  ]);
});

test("comment-on-prs projects only top-level PR comment surface", () => {
  const result = projectCapabilities(
    makeInput({
      capabilities: {
        sensors: [],
        controllers: [
          {
            name: "pr-comments",
            uses: "gh",
            grants: ["comment-on-prs"],
            approval: "required",
          },
        ],
      },
      declaredMcps: [makeDependency("gh")],
      mcpStatuses: [makeStatus("gh", "ready")],
      registeredPublicBrokerToolNames: [
        "githubBroker.post_issue_comment",
        "githubBroker.post_pr_review_comment_reply",
      ],
      providerRunAllowList: [
        "githubBroker.post_issue_comment",
        "githubBroker.post_pr_review_comment_reply",
      ],
    })
  );

  assert.deepEqual(result.controllers, [
    {
      name: "pr-comments",
      uses: "gh",
      grants: ["comment-on-prs"],
      approval: "required",
      tools: ["githubBroker.post_issue_comment"],
    },
  ]);
});

test("projection does not leak mcpUrl, credentials, or connection metadata", () => {
  const input = makeInput({
    declaredMcps: [
      {
        handle: "gh",
        smitheryId: "gh-smithery",
        mcpUrl: "https://example.invalid/mcp",
        credentials: { token: "secret-token" },
      } as unknown as McpDependency,
      {
        handle: "pkg",
        smitheryId: "pkg-smithery",
        connection: { providerConnectionId: "provider-123", localConnectionIdentity: "local-456" },
      } as unknown as McpDependency,
    ],
    mcpStatuses: [
      {
        ...makeStatus("gh", "ready"),
        connection: {
          providerConnectionId: "provider-123",
          localConnectionIdentity: "local-456",
          namespace: "gh",
          transport: "stdio",
        },
      } as McpStatusRecord,
    ],
  });

  const result = projectCapabilities(input);
  const json = JSON.stringify(result);

  assert.ok(!json.includes("mcpUrl"));
  assert.ok(!json.includes("credentials"));
  assert.ok(!json.includes("providerConnectionId"));
  assert.ok(!json.includes("localConnectionIdentity"));
  assert.ok(!json.includes("namespace"));
  assert.ok(!json.includes("transport"));
});

test("projection ignores arbitrary task kinds and does not filter by task type", () => {
  const baseInput = makeInput();
  const withTaskKind = projectCapabilities({ ...baseInput, taskKind: "totally-unexpected-task-kind" });
  const withoutTaskKind = projectCapabilities(baseInput);

  assert.deepEqual(withTaskKind, withoutTaskKind);
  assert.equal(withTaskKind.sensors.length > 0, true);
  assert.equal(withTaskKind.controllers.length > 0, true);
});

test("projection removes skipped capability names and records user-skip blocker reason", () => {
  const result = projectCapabilities({
    ...makeInput(),
    skippedCapabilityNames: new Set(["package-docs"])
  });

  assert.equal(result.sensors.some((sensor) => sensor.name === "package-docs"), false);
  assert.ok(result.sensors.some((sensor) => sensor.name === "repo-context"));
  assert.ok(
    result.blocked.some(
      (capability) =>
        capability.name === "package-docs" &&
        capability.uses === "pkg" &&
        capability.reason === "capability_skipped_by_user"
    )
  );
});
