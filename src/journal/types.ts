export type JournalScope =
  | "system"
  | "repo"
  | "workstream"
  | "worktree"
  | "issue"
  | "pull_request"
  | "execution";

export type JournalCategory =
  | "sync"
  | "observation"
  | "derivation"
  | "routing"
  | "task_created"
  | "task_skipped"
  | "execution_started"
  | "execution_completed"
  | "execution_failed"
  | "publication"
  | "state_transition"
  | "no_action"
  | "blocked"
  | "remediation";

export type JournalSeverity = "info" | "warning" | "error";

export interface JournalStateTransition {
  from: string;
  to: string;
  trigger?: string;
}

export interface JournalEntry {
  id: string;
  timestamp: string;
  cycleId?: string;
  scope: JournalScope;
  scopeId: string;
  repoId?: string;
  issueNumber?: number;
  prNumber?: number;
  workstreamId?: string;
  executionId?: string;
  category: JournalCategory;
  severity: JournalSeverity;
  summary: string;
  observedState?: Record<string, unknown>;
  derivedState?: Record<string, unknown>;
  expectedNextAction?: string;
  noActionReason?: string;
  stateTransition?: JournalStateTransition;
}

export interface JournalQuery {
  repoId?: string;
  workstreamId?: string;
  issueNumber?: number;
  prNumber?: number;
  cycleId?: string;
  executionId?: string;
  scope?: JournalScope;
  category?: JournalCategory;
  severity?: JournalSeverity;
  since?: string;
  limit?: number;
}
