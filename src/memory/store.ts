import type {
  JobMemoryAddInput,
  JobMemoryEntry,
  JobMemoryScope,
  JobMemorySearchInput
} from "./types.js";

export interface JobMemoryStore {
  /**
   * Adds a new memory entry to the specified bank.
   */
  add(
    scope: JobMemoryScope,
    bankId: string,
    taskId: string,
    input: JobMemoryAddInput
  ): Promise<JobMemoryEntry>;

  /**
   * Searches for memory entries in the specified bank.
   */
  search(bankId: string, input: JobMemorySearchInput): Promise<JobMemoryEntry[]>;
}
