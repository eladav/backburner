import type { JournalEntry } from "./types.js";

const SEVERITY_PREFIX: Record<string, string> = {
  info: "  ",
  warning: "! ",
  error: "✗ "
};

export interface RenderOptions {
  json?: boolean;
  verbose?: boolean;
}

export function renderJournalEntries(entries: JournalEntry[], opts: RenderOptions = {}): string {
  if (opts.json) {
    return JSON.stringify(entries, null, 2) + "\n";
  }

  if (entries.length === 0) {
    return "No journal entries found.\n";
  }

  return (
    entries
      .map((e) => {
        const prefix = SEVERITY_PREFIX[e.severity] ?? "  ";
        const ts = e.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z");
        const scope = e.repoId ? `[${e.repoId}]` : `[${e.scope}:${e.scopeId.slice(0, 8)}]`;
        const base = `${ts} ${prefix}${scope} ${e.summary}`;

        if (!opts.verbose) {
          return base;
        }

        const lines: string[] = [base];
        lines.push(`    category: ${e.category}`);
        if (e.cycleId) lines.push(`    cycle:    ${e.cycleId}`);
        if (e.workstreamId) lines.push(`    ws:       ${e.workstreamId}`);
        if (e.executionId) lines.push(`    exec:     ${e.executionId}`);
        if (e.noActionReason) lines.push(`    reason:   ${e.noActionReason}`);
        if (e.expectedNextAction) lines.push(`    next:     ${e.expectedNextAction}`);
        if (e.stateTransition) {
          lines.push(`    from:     ${e.stateTransition.from}`);
          lines.push(`    to:       ${e.stateTransition.to}`);
          if (e.stateTransition.trigger) {
            lines.push(`    trigger:  ${e.stateTransition.trigger}`);
          }
        }
        if (e.observedState) {
          lines.push(`    observed: ${JSON.stringify(e.observedState)}`);
        }
        if (e.derivedState) {
          lines.push(`    derived:  ${JSON.stringify(e.derivedState)}`);
        }
        return lines.join("\n");
      })
      .join("\n") + "\n"
  );
}
