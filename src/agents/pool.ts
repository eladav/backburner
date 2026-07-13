import type { TaskRecord } from "../tasks/types.js";

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = max;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available += 1;
    }
  }
}

export class Mutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.locked = false;
    } else {
      next();
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Per-key mutual exclusion. Tasks that share a key (workstream, branch, workspace)
 * are serialized through that key's queue. Tasks with no shared keys run freely.
 *
 * Callers must acquire keys in sorted order (acquireAll enforces this) to avoid
 * deadlock when a task needs multiple locks simultaneously.
 */
export class KeyedLock {
  private readonly held = new Set<string>();
  private readonly queues = new Map<string, Array<() => void>>();

  acquire(key: string): Promise<() => void> {
    if (!this.held.has(key)) {
      this.held.add(key);
      return Promise.resolve(() => this.release(key));
    }
    return new Promise<() => void>((resolve) => {
      const queue = this.queues.get(key) ?? [];
      queue.push(() => resolve(() => this.release(key)));
      this.queues.set(key, queue);
    });
  }

  private release(key: string): void {
    const queue = this.queues.get(key);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.queues.delete(key);
      }
      next();
    } else {
      this.held.delete(key);
    }
  }

  async acquireAll(keys: readonly string[]): Promise<() => void> {
    // Deduplicate and sort for consistent acquisition order (deadlock prevention).
    const sorted = [...new Set(keys)].sort();
    const releases: Array<() => void> = [];
    for (const key of sorted) {
      releases.push(await this.acquire(key));
    }
    return () => {
      for (const r of releases) {
        r();
      }
    };
  }
}

/**
 * Derive the set of scope lock keys a task must hold for its full execution.
 *
 * - workstream:<id>        serializes all tasks in the same workstream (also
 *                          implicitly covers provider-session since session IDs
 *                          include workstreamId)
 * - branch:<slug>:<name>   serializes tasks operating on the same branch
 * - workspace:<path>       serializes tasks operating on the same local path
 *
 * Read-only tasks that have no workstreamId, branchName, or localRepoPath
 * produce no lock keys and are always fully parallel.
 */
export function deriveExecutionLockKeys(
  task: TaskRecord,
  executionCwdByTaskId?: ReadonlyMap<string, string> | undefined
): string[] {
  const keys: string[] = [];
  if (task.workstreamId) {
    keys.push(`workstream:${task.workstreamId}`);
  }
  if (task.context.branchName) {
    keys.push(`branch:${task.repoSlug}:${task.context.branchName}`);
  }
  const resolvedPath = executionCwdByTaskId?.get(task.id) ?? task.context.localRepoPath;
  if (resolvedPath) {
    keys.push(`workspace:${resolvedPath}`);
  }
  return keys;
}

/**
 * Controls concurrency of agent task dispatch.
 *
 * - semaphore:   limits how many agents run simultaneously (maxConcurrent).
 * - scopeLocks:  per-key mutual exclusion so tasks sharing a workstream, branch,
 *                or workspace cannot run at the same time.
 * - stateMutex:  serializes all state reads and writes so concurrent agent
 *                executions don't corrupt shared arrays (tasks, executions, sessions).
 *
 * Global mutable bindings that are not concurrent-safe
 * (ScopedBrokerToolService.bindAllowedTools, JobMemoryToolService.bind/unbind)
 * are handled specially in service.ts: memory tools are filtered from the broker
 * scope at batch start; per-task bind/unbind is skipped in concurrent mode.
 */
export class AgentPool {
  readonly maxConcurrent: number;
  readonly stateMutex: Mutex;
  readonly scopeLocks: KeyedLock;
  private readonly semaphore: Semaphore;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.semaphore = new Semaphore(this.maxConcurrent);
    this.stateMutex = new Mutex();
    this.scopeLocks = new KeyedLock();
  }

  get isConcurrent(): boolean {
    return this.maxConcurrent > 1;
  }

  async runWithSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.semaphore.acquire();
    try {
      return await fn();
    } finally {
      this.semaphore.release();
    }
  }
}
