import type { RuntimeStatusModel, RuntimeStatusListener, TuiStatus, TuiReadiness, TuiHint } from "./types.js";
import type { RunSummary } from "../run-types.js";
import type { TaskRecord } from "../../tasks/types.js";
import type { WorkstreamRecord, PersistedState, ExecutionRecord } from "../../state/types.js";
import type { AgentConfig, McpDependency, NormalizedCapabilities } from "../../config/types.js";
import type { McpStatusRecord } from "../../state/types.js";

export class RuntimeStatusTracker implements RuntimeStatusListener {
  private model: RuntimeStatusModel;
  private listeners: Set<(model: RuntimeStatusModel) => void> = new Set();
  private startTime: number = Date.now();
  private lastOkTime: number | null = null;
  private currentCycleNo: number = 0;
  private intervalMs: number = 5 * 60 * 1000;
  private nextCycleAt: number = 0;
  private lastCycleDurationMs: number = 0;

  private mcps: McpDependency[] = [];
  private capabilities: NormalizedCapabilities = { sensors: [], controllers: [] };
  private maxConcurrentAgents: number = 1;
  private mcpStatuses: McpStatusRecord[] = [];
  private runningTasks: Map<string, { task: TaskRecord; agent: AgentConfig | undefined; startTime: number }> = new Map();
  private configReloadError: Error | null = null;
  private state: PersistedState | null = null;



  constructor(repoCount: number) {
    this.model = {
      status: "idle",
      uptime: 0,
      cycleNo: "—",
      repos: repoCount,
      readiness: "ok",
      lastOk: "—",
      nextText: "—",
      opText: "no active operation",
      opTarget: "",
      opSub: "initializing...",
      cycleGlyph: "○",
      cycleText: "waiting for first cycle",
      cycleMeta: "—",
      hints: [
        { glyph: "·", text: "nothing needs you right now", color: "dim" }
      ]
    };
    this.updateUptime();
  }

  register(listener: (model: RuntimeStatusModel) => void): () => void {
    this.listeners.add(listener);
    listener(this.model);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setConfigs(mcps: McpDependency[], capabilities: NormalizedCapabilities, maxConcurrent?: number): void {
    this.mcps = mcps;
    this.capabilities = capabilities;
    if (maxConcurrent !== undefined) {
      this.maxConcurrentAgents = maxConcurrent;
    }
    this.notify();
  }

  setMcpStatuses(statuses: McpStatusRecord[]): void {
    this.mcpStatuses = statuses ?? [];
    this.notify();
  }

  getMcps(): McpDependency[] {
    return this.mcps;
  }

  getCapabilities(): NormalizedCapabilities {
    return this.capabilities;
  }

  getMaxConcurrent(): number {
    return this.maxConcurrentAgents;
  }

  getMcpStatuses(): McpStatusRecord[] {
    return this.mcpStatuses;
  }

  getRunningTasks(): Map<string, { task: TaskRecord; agent: AgentConfig | undefined; startTime: number }> {
    return this.runningTasks;
  }

  setConfigReloadError(error: Error | null): void {
    this.configReloadError = error;
    this.notify();
  }

  getConfigReloadError(): Error | null {
    return this.configReloadError;
  }

  setState(state: PersistedState): void {
    this.state = state;
    this.mcpStatuses = state.mcpStatuses ?? [];
    this.notify();
  }

  getUniqueRepoKeys(): string[] {
    if (!this.state) return [];
    const keys = new Set<string>();
    const workstreams = this.state.workstreams ?? [];
    for (const w of workstreams) {
      if (w.repoKey) {
        keys.add(w.repoKey);
      }
    }
    return Array.from(keys).sort();
  }

  getWorkstreamsForRepo(repoKey: string): WorkstreamRecord[] {
    if (!this.state) return [];
    const workstreams = this.state.workstreams ?? [];

    // Index most recent task activity per workstream for sort key
    const latestActivity = new Map<string, number>();
    for (const task of this.state.tasks ?? []) {
      if (!task.workstreamId) continue;
      const t = new Date(task.updatedAt).getTime();
      const prev = latestActivity.get(task.workstreamId) ?? 0;
      if (t > prev) latestActivity.set(task.workstreamId, t);
    }

    return workstreams
      .filter(w => w.repoKey === repoKey)
      .sort((a, b) => (latestActivity.get(b.id) ?? 0) - (latestActivity.get(a.id) ?? 0));
  }

  getWorkstreamById(id: string): WorkstreamRecord | undefined {
    if (!this.state) return undefined;
    const workstreams = this.state.workstreams ?? [];
    return workstreams.find(w => w.id === id);
  }

  getWorkstreamTitle(workstream: WorkstreamRecord): string {
    if (!this.state) return "";
    const num = workstream.origin.number;
    if (workstream.origin.type === "issue") {
      const issues = this.state.issues ?? [];
      const issue = issues.find(i => i.repoSlug === workstream.repoKey && i.number === num);
      return issue ? issue.title : "";
    } else {
      const prs = this.state.prs ?? [];
      const pr = prs.find(p => p.repoSlug === workstream.repoKey && p.number === num);
      return pr ? pr.title : "";
    }
  }

  getExecutionsForWorkstream(workstreamId: string): ExecutionRecord[] {
    if (!this.state) return [];

    // Scoped matching logic:
    // 1. Find all tasks with task.workstreamId === workstreamId
    const tasks = this.state.tasks ?? [];
    const taskIds = new Set(
      tasks
        .filter(t => t.workstreamId === workstreamId)
        .map(t => t.id)
    );

    // 2. Parse number from workstreamId for fallback matching
    const match = workstreamId.match(/:issue:(\d+)$|:pr:(\d+)$/);
    const numStr = match ? (match[1] || match[2]) : null;

    const executions = this.state.executions ?? [];
    return executions
      .filter(e => {
        if (taskIds.has(e.taskId)) return true;
        if (numStr) {
          // Fallback: split taskId by delimiters to ensure exact match of the issue/PR number component
          const parts = e.taskId.split(/[:_]/);
          if (parts.includes(numStr)) return true;
        }
        return false;
      })
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  getTasks(): TaskRecord[] {
    if (!this.state) return [];
    return this.state.tasks ?? [];
  }

  getExecutions(): ExecutionRecord[] {
    if (!this.state) return [];
    return this.state.executions ?? [];
  }



  private notify(): void {
    for (const listener of this.listeners) {
      listener({ ...this.model });
    }
  }

  getModel(): RuntimeStatusModel {
    return this.model;
  }

  setIntervalMs(intervalMs: number): void {
    this.intervalMs = intervalMs;
  }

  setNextCycleAt(timestamp: number): void {
    this.nextCycleAt = timestamp;
    this.updateCountdown();
  }

  updateUptime(): void {
    this.model.uptime = Math.floor((Date.now() - this.startTime) / 1000);
    this.updateLastOk();
    this.updateCountdown();
    this.notify();
  }

  private updateLastOk(): void {
    if (this.lastOkTime === null) {
      this.model.lastOk = "—";
    } else {
      const diffSec = Math.floor((Date.now() - this.lastOkTime) / 1000);
      if (diffSec < 60) {
        this.model.lastOk = `${diffSec}s ago`;
      } else {
        const diffMin = Math.floor(diffSec / 60);
        const remSec = diffSec % 60;
        this.model.lastOk = `${diffMin}m ${String(remSec).padStart(2, "0")}s ago`;
      }
    }
  }

  private updateCountdown(): void {
    if (["executing", "syncing"].includes(this.model.status)) {
      this.model.nextText = "— · running";
      return;
    }

    if (this.model.status === "blocked") {
      this.model.nextText = "paused";
      return;
    }

    if (this.model.status === "waiting") {
      this.model.nextText = "paused · awaiting approval";
      return;
    }

    if (this.nextCycleAt === 0) {
      this.model.nextText = "—";
      return;
    }

    const diffMs = this.nextCycleAt - Date.now();
    if (diffMs <= 0) {
      this.model.nextText = "in 0:00";
      return;
    }

    const totalSec = Math.ceil(diffMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const timeStr = `${min}:${String(sec).padStart(2, "0")}`;

    if (this.model.status === "failed") {
      this.model.nextText = `retry in ${timeStr}`;
    } else {
      this.model.nextText = `in ${timeStr}`;
    }
  }

  onStatusChange(status: Partial<RuntimeStatusModel>): void {
    this.model = {
      ...this.model,
      ...status
    };
    this.updateCountdown();
    this.notify();
  }

  onLog(level: "info" | "warn" | "error", message: string): void {
    // Currently, we silence direct logs to screen.
    // If needed, we can log them or print to debug area.
  }

  onCycleStart(cycleNo: number): void {
    this.runningTasks.clear();
    this.runningTasks.set("orchestrator:sync", {
      task: {
        id: "orchestrator:sync",
        kind: "sync_parent_branch",
        repoId: "orchestrator",
        repoSlug: "orchestrator",
        status: "pending",
        updatedAt: new Date().toISOString(),
        context: { localRepoPath: "" }
      } as any as TaskRecord,
      agent: undefined,
      startTime: Date.now()
    });

    this.currentCycleNo = cycleNo;
    this.model.status = "syncing";
    this.model.cycleNo = cycleNo;
    this.model.opText = "reading GitHub state";
    this.model.opTarget = "";
    this.model.opSub = "starting cycle...";
    this.updateCountdown();
    this.notify();
  }

  onRepoSyncStart(repoSlug: string): void {
    this.model.status = "syncing";
    this.model.opText = "syncing repository";
    this.model.opTarget = repoSlug;
    this.model.opSub = "fetching git updates...";

    for (const key of [...this.runningTasks.keys()]) {
      if (key.startsWith("orchestrator:sync:")) {
        this.runningTasks.delete(key);
      }
    }

    this.runningTasks.delete("orchestrator:sync");
    this.runningTasks.set(`orchestrator:sync:${repoSlug}`, {
      task: {
        id: `orchestrator:sync:${repoSlug}`,
        kind: "sync_repository" as any,
        repoId: "orchestrator",
        repoSlug: repoSlug,
        status: "pending",
        updatedAt: new Date().toISOString(),
        context: { localRepoPath: "" }
      } as any as TaskRecord,
      agent: undefined,
      startTime: Date.now()
    });
    this.notify();
  }

  onGitHubScanStart(): void {
    this.model.status = "syncing";
    this.model.opText = "reading GitHub state";
    this.model.opTarget = "";
    this.model.opSub = "deriving attention...";

    for (const key of this.runningTasks.keys()) {
      if (key.startsWith("orchestrator:sync")) {
        this.runningTasks.delete(key);
      }
    }
    this.runningTasks.set("orchestrator:scan", {
      task: {
        id: "orchestrator:scan",
        kind: "github_scan" as any,
        repoId: "orchestrator",
        repoSlug: "GitHub",
        status: "pending",
        updatedAt: new Date().toISOString(),
        context: { localRepoPath: "" }
      } as any as TaskRecord,
      agent: undefined,
      startTime: Date.now()
    });
    this.notify();
  }

  onTaskStart(task: TaskRecord, agent?: AgentConfig): void {
    this.runningTasks.delete("orchestrator:scan");
    this.runningTasks.delete("orchestrator:sync");
    for (const key of this.runningTasks.keys()) {
      if (key.startsWith("orchestrator:sync")) {
        this.runningTasks.delete(key);
      }
    }

    this.model.status = "executing";
    this.model.opText = this.getTaskKindText(task.kind);
    this.model.opTarget = this.getTaskTargetText(task);
    this.model.opSub = `agent running · worktree ${task.context.localRepoPath ? task.context.localRepoPath.split("/").pop() : "unknown"}`;

    this.runningTasks.set(task.id, {
      task,
      agent: agent ?? undefined,
      startTime: Date.now()
    });
    this.notify();
  }

  onTaskEnd(taskId: string): void {
    this.runningTasks.delete(taskId);
    this.notify();
  }


  onCycleSuccess(summary: RunSummary, stateOrWorkstreams: Partial<PersistedState> | WorkstreamRecord[]): void {
    let state: Partial<PersistedState>;
    if (Array.isArray(stateOrWorkstreams)) {
      state = {
        workstreams: stateOrWorkstreams,
        tasks: [],
        executions: [],
        issues: [],
        prs: [],
        mcpStatuses: []
      };
    } else {
      state = stateOrWorkstreams;
    }
    this.state = state as PersistedState;
    this.mcpStatuses = state.mcpStatuses ?? [];
    const workstreams = state.workstreams ?? [];
    this.runningTasks.clear();
    this.lastOkTime = Date.now();
    this.lastCycleDurationMs = new Date(summary.completedAt).getTime() - new Date(summary.startedAt).getTime();

    // Determine readiness and status
    const failedRepos = summary.failedRepoCount + summary.failedScanRepoCount;
    const failedTasks = summary.failedTaskCount;
    
    let readiness: TuiReadiness = "ok";
    let status: TuiStatus = "idle";
    let opText = "no active operation";
    let opTarget = "";
    let opSub = "sleeping until next cycle";

    if (failedRepos > 0 || failedTasks > 0) {
      readiness = "warnings";
    }

    // Check if waiting for plan feedback/approval
    const waitingWorkstream = workstreams.find(
      (w) => w.phase === "plan_feedback" || w.phase === "planning" && w.packetPlan?.status === "proposed"
    );

    if (waitingWorkstream) {
      status = "waiting";
      opText = "awaiting plan approval/review";
      const issueNum = waitingWorkstream.linkedIssueNumber ?? this.parseNumberFromUrl(waitingWorkstream.id);
      opTarget = issueNum ? `issue #${issueNum} · ${waitingWorkstream.repoKey}` : waitingWorkstream.repoKey;
      opSub = "paused — check GitHub to approve plan or review PR";
    }

    // Set cycle outcome details
    let cycleGlyph = "○";
    let cycleText = "no actionable work";
    
    if (failedRepos > 0) {
      cycleGlyph = "✗";
      cycleText = `failed sync on ${failedRepos} repository/ies`;
    } else if (failedTasks > 0) {
      cycleGlyph = "✗";
      cycleText = `failed tasks: ${failedTasks}`;
    } else {
      const disp = summary.dispatchedTaskCount;
      const comp = summary.completedTaskCount;
      if (disp > 0 && comp > 0) {
        cycleGlyph = "✓";
        const dispText = disp === 1 ? "1 task" : `${disp} tasks`;
        const compText = comp === 1 ? "1 task" : `${comp} tasks`;
        cycleText = `dispatched ${dispText} · completed ${compText}`;
      } else if (comp > 0) {
        cycleGlyph = "✓";
        cycleText = comp === 1 ? "completed 1 task" : `completed ${comp} tasks`;
      } else if (disp > 0) {
        cycleGlyph = "✓";
        cycleText = disp === 1 ? "dispatched 1 task" : `dispatched ${disp} tasks`;
      } else if (waitingWorkstream) {
        cycleGlyph = "⚠";
        cycleText = "one known waiting workstream";
      }
    }

    const durationSec = Math.ceil(this.lastCycleDurationMs / 1000);
    const cycleMeta = `cycle #${this.currentCycleNo} · ${durationSec}s`;

    // Hints
    const hints: TuiHint[] = [];
    if (status === "waiting" && waitingWorkstream) {
      const issueNum = waitingWorkstream.linkedIssueNumber ?? this.parseNumberFromUrl(waitingWorkstream.id);
      hints.push({
        glyph: "→",
        text: `approve plan on issue #${issueNum} (GitHub)`,
        color: "yellow"
      });
      hints.push({
        glyph: "→",
        text: "check the latest cycle details below",
        color: "cyan"
      });
    } else if (readiness === "warnings") {
      hints.push({
        glyph: "→",
        text: "check credentials and setup configuration",
        color: "red"
      });
      hints.push({
        glyph: "→",
        text: "inspect the logs/state repo for the trace",
        color: "cyan"
      });
    } else {
      hints.push({
        glyph: "·",
        text: "nothing needs you right now",
        color: "dim"
      });
      hints.push({
        glyph: "→",
        text: "open the journal or logs when you need history",
        color: "cyan"
      });
    }

    this.model = {
      ...this.model,
      status,
      readiness,
      opText,
      opTarget,
      opSub,
      cycleGlyph,
      cycleText,
      cycleMeta,
      hints
    };

    this.updateCountdown();
    this.notify();
  }

  onCycleFailure(error: any): void {
    this.runningTasks.clear();
    const isConfigError = error?.message?.includes("config") || error?.message?.includes("backburner.json");
    const status: TuiStatus = isConfigError ? "blocked" : "failed";
    const readiness: TuiReadiness = isConfigError ? "blocking problems" : "warnings";

    this.model.status = status;
    this.model.readiness = readiness;
    this.model.opText = "no active operation";
    this.model.opTarget = "";
    this.model.opSub = isConfigError ? "Backburner paused — configuration invalid" : "cycle aborted — will retry next cycle";
    
    this.model.cycleGlyph = "✗";
    this.model.cycleText = error?.message || String(error);
    this.model.cycleMeta = `cycle #${this.currentCycleNo || 1} · failed`;

    const hints: TuiHint[] = [];
    if (isConfigError) {
      hints.push({
        glyph: "→",
        text: "review setup configuration",
        color: "cyan"
      });
      hints.push({
        glyph: "·",
        text: "configuration failed to load · check backburner.json",
        color: "dim"
      });
    } else {
      hints.push({
        glyph: "→",
        text: "check credentials and setup configuration",
        color: "red"
      });
      hints.push({
        glyph: "→",
        text: "inspect the logs/state repo for the trace",
        color: "cyan"
      });
    }
    this.model.hints = hints;

    this.updateCountdown();
    this.notify();
  }

  public getTaskKindText(kind: string): string {
    switch (kind) {
      case "product_discovery":
        return "Product discovery analysis";
      case "write_product_spec":
        return "writing Product Spec";
      case "implement_plan":
        return "running implementation agent";
      case "write_plan":
        return "writing plan";
      case "review_pr":
        return "reviewing PR";
      case "prepare_pr_for_merge":
        return "preparing PR for merge";
      case "sync_parent_branch":
        return "syncing parent branch";
      default:
        return kind.replace(/_/g, " ");
    }
  }

  public getTaskTargetText(task: TaskRecord): string {
    const issueNum = task.context.prepareForMerge?.prNumber ??
      task.context.preflight?.parentPrNumber ??
      this.parseNumberFromUrl(task.context.issueUrl || task.sourceUrl || "");
    const prefix = task.kind === "review_pr" || task.kind === "prepare_pr_for_merge" ? "PR" : "issue";
    
    if (issueNum) {
      return `${prefix} #${issueNum} · ${task.repoSlug}`;
    }
    return task.repoSlug;
  }

  public parseNumberFromUrl(url: string): number | undefined {
    const match = url.match(/\/(?:issues|pull)\/(\d+)/);
    return match ? Number(match[1]) : undefined;
  }
}
