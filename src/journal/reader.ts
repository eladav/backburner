import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { JournalEntry, JournalQuery } from "./types.js";

export class JournalReader {
  private readonly journalPath: string;

  constructor(journalDir: string) {
    this.journalPath = path.join(journalDir, "journal.jsonl");
  }

  async read(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEntry);
  }

  async query(q: JournalQuery = {}): Promise<JournalEntry[]> {
    let entries = await this.read();

    if (q.repoId !== undefined) {
      entries = entries.filter((e) => e.repoId === q.repoId);
    }
    if (q.workstreamId !== undefined) {
      entries = entries.filter((e) => e.workstreamId === q.workstreamId);
    }
    if (q.issueNumber !== undefined) {
      entries = entries.filter((e) => e.issueNumber === q.issueNumber);
    }
    if (q.prNumber !== undefined) {
      entries = entries.filter((e) => e.prNumber === q.prNumber);
    }
    if (q.cycleId !== undefined) {
      entries = entries.filter((e) => e.cycleId === q.cycleId);
    }
    if (q.executionId !== undefined) {
      entries = entries.filter((e) => e.executionId === q.executionId);
    }
    if (q.scope !== undefined) {
      entries = entries.filter((e) => e.scope === q.scope);
    }
    if (q.category !== undefined) {
      entries = entries.filter((e) => e.category === q.category);
    }
    if (q.severity !== undefined) {
      entries = entries.filter((e) => e.severity === q.severity);
    }
    if (q.since !== undefined) {
      const sinceMs = new Date(q.since).getTime();
      entries = entries.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
    }
    if (q.limit !== undefined) {
      entries = entries.slice(-q.limit);
    }

    return entries;
  }
}
