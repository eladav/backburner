import type { JobMemoryStore } from "./store.js";
import type { JobMemoryToolService } from "./tool-service.js";

export type JobName =
  | "product"
  | "discussion"
  | "planning"
  | "implementation"
  | "review"
  | "implementation_manager"
  | "retrospective";

export type ModelClass = "strong" | "cheap";

export interface JobMemoryScope {
  repoKey: string; // task.repoSlug
  workstreamId: string; // task.workstreamId, required for memory access
  job: JobName; // workflowRegistry definition role/job mapping
  modelClass: ModelClass; // selected AgentConfig.modelClass; validate against workflow definition
}

export const JOB_MEMORY_ENTRY_TYPES = [
  "decision",
  "assumption",
  "fact",
  "risk",
  "open_question",
  "file_note",
  "review_note",
  "implementation_note",
  "human_preference",
  "other"
] as const;

export type JobMemoryEntryType = (typeof JOB_MEMORY_ENTRY_TYPES)[number];

export interface JobMemoryEntry {
  id: string;
  bankId: string;
  scope: JobMemoryScope;
  type: JobMemoryEntryType;
  text: string;
  source: {
    taskId: string;
    executionId?: string;
    issueNumber?: number;
    prNumber?: number;
    commitSha?: string;
    filePath?: string;
  };
  confidence?: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
}

export interface JobMemoryAddInput {
  type: JobMemoryEntryType;
  text: string;
  confidence?: "low" | "medium" | "high";
  source?: {
    commitSha?: string;
    filePath?: string;
  };
}

export interface JobMemorySearchInput {
  query?: string;
  limit?: number;
  type?: JobMemoryEntryType;
}

export interface JobMemorySearchResult {
  entries: JobMemoryEntry[];
}

export interface JobMemoryRuntime {
  store: JobMemoryStore;
  toolService: JobMemoryToolService;
}
