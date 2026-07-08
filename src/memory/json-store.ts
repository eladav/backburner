import { randomUUID } from "node:crypto";
import { readJsonFileIfExists, writeJsonFileAtomic } from "../utils/json.js";
import type {
  JobMemoryAddInput,
  JobMemoryEntry,
  JobMemoryScope,
  JobMemorySearchInput
} from "./types.js";
import type { JobMemoryStore } from "./store.js";

interface JobMemoryState {
  entries: JobMemoryEntry[];
}

export interface JsonJobMemoryStoreOptions {
  filePath: string;
  generateId?: () => string;
  now?: () => string;
}

export class JsonJobMemoryStore implements JobMemoryStore {
  private readonly filePath: string;
  private readonly generateId: () => string;
  private readonly now: () => string;

  constructor(options: JsonJobMemoryStoreOptions) {
    this.filePath = options.filePath;
    this.generateId = options.generateId ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async add(
    scope: JobMemoryScope,
    bankId: string,
    taskId: string,
    input: JobMemoryAddInput
  ): Promise<JobMemoryEntry> {
    const state = await this.load();
    const now = this.now();

    const entry: JobMemoryEntry = {
      id: this.generateId(),
      bankId,
      scope,
      type: input.type,
      text: input.text,
      source: {
        taskId,
        ...input.source
      },
      createdAt: now,
      updatedAt: now
    };

    if (input.confidence !== undefined) {
      entry.confidence = input.confidence;
    }

    state.entries.push(entry);

    // Sort entries deterministically by bankId and createdAt
    state.entries.sort((a, b) => {
      if (a.bankId !== b.bankId) {
        return a.bankId.localeCompare(b.bankId);
      }
      return a.createdAt.localeCompare(b.createdAt);
    });

    await this.save(state);
    return entry;
  }

  async search(bankId: string, input: JobMemorySearchInput): Promise<JobMemoryEntry[]> {
    const state = await this.load();
    const query = input.query?.toLowerCase();

    const results = state.entries.filter((entry) => {
      if (entry.bankId !== bankId) {
        return false;
      }

      if (input.type && entry.type !== input.type) {
        return false;
      }

      if (query && !entry.text.toLowerCase().includes(query)) {
        return false;
      }

      return true;
    });

    // Sort by recency (newest first) for search results
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (input.limit !== undefined) {
      return results.slice(0, input.limit);
    }

    return results;
  }

  private async load(): Promise<JobMemoryState> {
    const data = await readJsonFileIfExists<JobMemoryState>(this.filePath);
    return data ?? { entries: [] };
  }

  private async save(state: JobMemoryState): Promise<void> {
    await writeJsonFileAtomic(this.filePath, state);
  }
}
