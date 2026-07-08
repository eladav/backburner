import type { JournalEntry, JournalScope, JournalQuery } from "./types.js";
import { JournalWriter } from "./writer.js";
import { JournalReader } from "./reader.js";

export class JournalService {
  readonly writer: JournalWriter;
  readonly reader: JournalReader;

  constructor(journalDir: string) {
    this.writer = new JournalWriter(journalDir);
    this.reader = new JournalReader(journalDir);
  }

  async write(entry: Omit<JournalEntry, "id" | "timestamp">): Promise<JournalEntry> {
    return this.writer.write(entry);
  }

  async query(q: JournalQuery = {}): Promise<JournalEntry[]> {
    return this.reader.query(q);
  }

  async recordNoAction(opts: {
    cycleId?: string;
    scope: JournalScope;
    scopeId: string;
    repoId?: string;
    workstreamId?: string;
    issueNumber?: number;
    prNumber?: number;
    reason: string;
    observedState?: Record<string, unknown>;
    derivedState?: Record<string, unknown>;
  }): Promise<JournalEntry> {
    return this.write({
      ...(opts.cycleId !== undefined ? { cycleId: opts.cycleId } : {}),
      scope: opts.scope,
      scopeId: opts.scopeId,
      ...(opts.repoId !== undefined ? { repoId: opts.repoId } : {}),
      ...(opts.workstreamId !== undefined ? { workstreamId: opts.workstreamId } : {}),
      ...(opts.issueNumber !== undefined ? { issueNumber: opts.issueNumber } : {}),
      ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
      category: "no_action",
      severity: "info",
      summary: opts.reason,
      noActionReason: opts.reason,
      ...(opts.observedState !== undefined ? { observedState: opts.observedState } : {}),
      ...(opts.derivedState !== undefined ? { derivedState: opts.derivedState } : {})
    });
  }

  async recordStateTransition(opts: {
    cycleId?: string;
    scope: JournalScope;
    scopeId: string;
    repoId?: string;
    workstreamId?: string;
    issueNumber?: number;
    prNumber?: number;
    from: string;
    to: string;
    trigger?: string;
    summary: string;
    observedState?: Record<string, unknown>;
    derivedState?: Record<string, unknown>;
    expectedNextAction?: string;
  }): Promise<JournalEntry> {
    return this.write({
      ...(opts.cycleId !== undefined ? { cycleId: opts.cycleId } : {}),
      scope: opts.scope,
      scopeId: opts.scopeId,
      ...(opts.repoId !== undefined ? { repoId: opts.repoId } : {}),
      ...(opts.workstreamId !== undefined ? { workstreamId: opts.workstreamId } : {}),
      ...(opts.issueNumber !== undefined ? { issueNumber: opts.issueNumber } : {}),
      ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
      category: "state_transition",
      severity: "info",
      summary: opts.summary,
      stateTransition: {
        from: opts.from,
        to: opts.to,
        ...(opts.trigger !== undefined ? { trigger: opts.trigger } : {})
      },
      ...(opts.observedState !== undefined ? { observedState: opts.observedState } : {}),
      ...(opts.derivedState !== undefined ? { derivedState: opts.derivedState } : {}),
      ...(opts.expectedNextAction !== undefined ? { expectedNextAction: opts.expectedNextAction } : {})
    });
  }

  async recordBlocked(opts: {
    cycleId?: string;
    scope: JournalScope;
    scopeId: string;
    repoId?: string;
    workstreamId?: string;
    issueNumber?: number;
    prNumber?: number;
    reason: string;
    observedState?: Record<string, unknown>;
    derivedState?: Record<string, unknown>;
  }): Promise<JournalEntry> {
    return this.write({
      ...(opts.cycleId !== undefined ? { cycleId: opts.cycleId } : {}),
      scope: opts.scope,
      scopeId: opts.scopeId,
      ...(opts.repoId !== undefined ? { repoId: opts.repoId } : {}),
      ...(opts.workstreamId !== undefined ? { workstreamId: opts.workstreamId } : {}),
      ...(opts.issueNumber !== undefined ? { issueNumber: opts.issueNumber } : {}),
      ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
      category: "blocked",
      severity: "warning",
      summary: opts.reason,
      noActionReason: opts.reason,
      ...(opts.observedState !== undefined ? { observedState: opts.observedState } : {}),
      ...(opts.derivedState !== undefined ? { derivedState: opts.derivedState } : {})
    });
  }
}
