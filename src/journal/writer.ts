import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { JournalEntry } from "./types.js";

export class JournalWriter {
  private readonly journalPath: string;

  constructor(journalDir: string) {
    this.journalPath = path.join(journalDir, "journal.jsonl");
  }

  async write(entry: Omit<JournalEntry, "id" | "timestamp">): Promise<JournalEntry> {
    const full: JournalEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry
    };
    await mkdir(path.dirname(this.journalPath), { recursive: true });
    await appendFile(this.journalPath, JSON.stringify(full) + "\n", "utf8");
    return full;
  }
}
