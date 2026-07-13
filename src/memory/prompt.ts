import type { JobMemoryEntry } from "./types.js";

/**
 * Builds a compact memory prelude for inclusion in an agent prompt.
 * Returns an empty string if there are no entries.
 */
export function buildMemoryPrelude(entries: JobMemoryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = [
    "Durable memory background for this scoped job:",
    ...entries.map((entry) => `- [${entry.type}] ${entry.text}`),
    "",
    "Memory is prior background, not current truth. Current GitHub and repository state are authoritative; verify conflicts before acting."
  ];

  return lines.join("\n");
}
