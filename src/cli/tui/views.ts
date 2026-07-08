import type { RuntimeStatusModel, TuiView, TuiHint } from "./types.js";
import type { RuntimeStatusTracker } from "./tracker.js";
import type { AgentConfig, McpDependency, NormalizedCapabilities } from "../../config/types.js";
import type { McpStatusRecord, WorkstreamRecord, ExecutionRecord } from "../../state/types.js";
import type { TaskRecord } from "../../tasks/types.js";
import { SENSOR_TOOL_MAP, CONTROLLER_TOOL_MAP } from "../../capabilities/projection.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";


// ANSI escape code helper functions
export const reset = "\x1b[0m";
export const bold = (t: string) => `\x1b[1m${t}\x1b[22m`;
export const dim = (t: string) => `\x1b[2m${t}\x1b[22m`;
export const green = (t: string) => `\x1b[32m${t}${reset}`;
export const yellow = (t: string) => `\x1b[33m${t}${reset}`;
export const red = (t: string) => `\x1b[31m${t}${reset}`;
export const cyan = (t: string) => `\x1b[36m${t}${reset}`;
export const blue = (t: string) => `\x1b[34m${t}${reset}`;
export const magenta = (t: string) => `\x1b[35m${t}${reset}`;
export const inverse = (t: string) => `\x1b[7m${t}${reset}`;

// Helper to strip ANSI codes safely for width calculations
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function formatAgent(agent: AgentConfig | undefined): string {
  if (!agent) {
    return dim("⚙️ ORCHESTRATOR");
  }
  const provider = agent.provider;
  switch (provider) {
    case "antigravity":
      return magenta("✦ ANTIGRAVITY");
    case "claude":
      return yellow("🦺 CLAUDE");
    case "codex":
      return green("🌀 CODEX");
    case "gemini":
      return blue("◆ GEMINI");
    case "opencode":
      return cyan("🔓 OPENCODE");
    default:
      return dim(`🤖 ${String(provider).toUpperCase()}`);
  }
}

// ANSI-safe truncation helper
export function truncateAnsi(str: string, limit: number): string {
  let plainLen = 0;
  let result = "";
  let inEscape = false;
  
  const chars = Array.from(str);
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] || "";
    if (char === "\x1b") {
      inEscape = true;
      result += char;
      continue;
    }
    if (inEscape) {
      result += char;
      if (/[a-zA-Z]/.test(char)) {
        inEscape = false;
      }
      continue;
    }
    
    if (plainLen < limit) {
      result += char;
      plainLen++;
    } else {
      break;
    }
  }
  
  result += reset;
  return result;
}

// ANSI-safe pad and truncate helper
export function padOrTruncateAnsi(str: string, limit: number, align: "left" | "right" = "left"): string {
  const plainLen = Array.from(stripAnsi(str)).length;
  if (plainLen > limit) {
    return truncateAnsi(str, limit);
  }
  const pad = " ".repeat(limit - plainLen);
  if (align === "left") {
    return str + pad;
  } else {
    return pad + str;
  }
}

// Formatting helpers
export function formatStatus(s: string): string {
  switch (s) {
    case "executing": return green(s.toUpperCase());
    case "idle": return dim(s.toUpperCase());
    case "syncing": return cyan(s.toUpperCase());
    case "waiting": return yellow("AWAITING APPROVAL");
    case "blocked": return red(s.toUpperCase());
    case "failed": return red(s.toUpperCase());
    default: return s.toUpperCase();
  }
}

export function getStatusColorSymbol(s: string): string {
  switch (s) {
    case "executing":
      return green("●");
    case "idle":
      return dim("●");
    case "syncing":
      return cyan("●");
    case "waiting":
      return yellow("●");
    case "blocked":
    case "failed":
      return red("●");
    default:
      return "●";
  }
}

export function formatReadiness(r: string): string {
  switch (r) {
    case "ok": return green(r);
    case "warnings": return yellow(r);
    case "blocking problems": return red(r);
    default: return r;
  }
}

export function formatUptime(s: number): string {
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return [hrs, mins, secs].map(n => String(n).padStart(2, "0")).join(":");
}

function sectionHeader(title: string, width: number): string {
  const prefix = `── ${title} `;
  const line = prefix + "─".repeat(Math.max(0, width - stripAnsi(prefix).length));
  return bold(cyan(line));
}

const LOGO = [
  "╔════════════════════╗",
  "║     BACKBURNER     ║",
  "║  local GitHub ops  ║",
  "║  agents on deck    ║",
  "╚════════════════════╝"
];

const SPIN_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getAnimatedLogoLine(lineIndex: number, status: string, spinnerChar?: string): string {
  const line = LOGO[lineIndex] || "";
  if (status === "syncing" || status === "executing") {
    const colors = [cyan, blue, magenta, green, yellow];
    const spinIndex = spinnerChar ? SPIN_CHARS.indexOf(spinnerChar) : 0;
    const colorFn = colors[(lineIndex + (spinIndex >= 0 ? spinIndex : 0)) % colors.length] || cyan;
    return bold(colorFn(line));
  } else if (status === "blocked" || status === "failed") {
    return bold(red(line));
  } else {
    return bold(cyan(line));
  }
}


export interface BaseNavEntry {
  type: string;
}

export interface ReposNavEntry extends BaseNavEntry {
  type: "repos";
  selectedIndex: number;
}

export interface WorkstreamsNavEntry extends BaseNavEntry {
  type: "workstreams";
  repoKey: string;
  selectedIndex: number;
  scrollOffset: number;
  filter: string;
}

export interface WorkstreamMenuNavEntry extends BaseNavEntry {
  type: "workstream_menu";
  repoKey: string;
  workstream: WorkstreamRecord;
  selectedIndex: number;
}

export interface StateViewNavEntry extends BaseNavEntry {
  type: "state_view";
  repoKey: string;
  workstream: WorkstreamRecord;
  scrollOffset: number;
  linesCount?: number;
}

export interface ExecutionsListNavEntry extends BaseNavEntry {
  type: "executions_list";
  repoKey: string;
  workstream: WorkstreamRecord;
  selectedIndex: number;
  scrollOffset: number;
}

export interface ExecutionFilesNavEntry extends BaseNavEntry {
  type: "execution_files";
  repoKey: string;
  workstream: WorkstreamRecord;
  execution: ExecutionRecord;
  selectedIndex: number;
  scrollOffset: number;
  files: string[];
  loading: boolean;
}

export interface FileViewNavEntry extends BaseNavEntry {
  type: "file_view";
  repoKey: string;
  workstream: WorkstreamRecord;
  execution: ExecutionRecord;
  fileName: string;
  content: string;
  scrollOffset: number;
  loading: boolean;
  linesCount?: number;
}

export type NavEntry =
  | ReposNavEntry
  | WorkstreamsNavEntry
  | WorkstreamMenuNavEntry
  | StateViewNavEntry
  | ExecutionsListNavEntry
  | ExecutionFilesNavEntry
  | FileViewNavEntry;

export class StatusView implements TuiView {
  private navStack: NavEntry[] = [];
  private reposSelectedIndex: number = 0;
  private reposScrollOffset: number = 0;
  private tracker: RuntimeStatusTracker;
  private explorerMaxHeight: number = 5;

  constructor(tracker: RuntimeStatusTracker) {
    this.tracker = tracker;
  }

  handleKey(key: any, str: string, triggerRender: () => void): boolean {
    if (!this.tracker) return false;
    const k = (key?.name || str || "").toLowerCase();

    // 1. If navStack is empty, we are at "repos" level
    if (this.navStack.length === 0) {
      if (k === "up" || k === "k") {
        this.moveSelection(-1, triggerRender);
        return true;
      }
      if (k === "down" || k === "j") {
        this.moveSelection(1, triggerRender);
        return true;
      }
      if (key?.name === "return") {
        this.drillDown(triggerRender);
        return true;
      }
      return false;
    }

    // 2. If stack is not empty, get the top entry
    const top = this.navStack[this.navStack.length - 1]!;

    if (k === "up" || k === "k") {
      if (top.type === "state_view") {
        top.scrollOffset = Math.max(0, top.scrollOffset - 1);
        triggerRender();
      } else if (top.type === "file_view") {
        if (!top.loading) {
          top.scrollOffset = Math.max(0, top.scrollOffset - 1);
          triggerRender();
        }
      } else {
        this.moveSelection(-1, triggerRender);
      }
      return true;
    }

    if (k === "down" || k === "j") {
      if (top.type === "state_view") {
        const linesCount = top.linesCount ?? 0;
        top.scrollOffset = Math.min(Math.max(0, linesCount - this.explorerMaxHeight), top.scrollOffset + 1);
        triggerRender();
      } else if (top.type === "file_view") {
        if (!top.loading) {
          const linesCount = top.linesCount ?? 0;
          top.scrollOffset = Math.min(Math.max(0, linesCount - this.explorerMaxHeight), top.scrollOffset + 1);
          triggerRender();
        }
      } else {
        this.moveSelection(1, triggerRender);
      }
      return true;
    }

    if (key?.name === "return") {
      this.drillDown(triggerRender);
      return true;
    }

    // Filter input for workstreams level
    if (top.type === "workstreams") {
      if (key?.name === "backspace" && top.filter.length > 0) {
        top.filter = top.filter.slice(0, -1);
        top.selectedIndex = 0;
        top.scrollOffset = 0;
        triggerRender();
        return true;
      }
      if (key?.name === "escape" && top.filter.length > 0) {
        top.filter = "";
        top.selectedIndex = 0;
        top.scrollOffset = 0;
        triggerRender();
        return true;
      }
      if (str && str.length === 1 && !key?.ctrl && !key?.meta && str >= " " && str !== "\x7f") {
        top.filter += str;
        top.selectedIndex = 0;
        top.scrollOffset = 0;
        triggerRender();
        return true;
      }
    }

    if (key?.name === "escape" || key?.name === "backspace") {
      this.navStack.pop();
      triggerRender();
      return true;
    }

    return false;
  }

  private getRepoKeys(tracker: RuntimeStatusTracker): string[] {
    return tracker.getUniqueRepoKeys();
  }

  private getFilteredWorkstreams(top: WorkstreamsNavEntry): WorkstreamRecord[] {
    const all = this.tracker.getWorkstreamsForRepo(top.repoKey);
    if (!top.filter) return all;
    const q = top.filter.toLowerCase();
    return all.filter(ws => {
      if (String(ws.origin.number).includes(q)) return true;
      return (this.tracker.getWorkstreamTitle(ws) || "").toLowerCase().includes(q);
    });
  }

  private getItemsCount(top: NavEntry): number {
    if (top.type === "workstreams") {
      return this.getFilteredWorkstreams(top).length;
    }
    if (top.type === "workstream_menu") {
      return 2; // "State", "Executions"
    }
    if (top.type === "executions_list") {
      return this.tracker.getExecutionsForWorkstream(top.workstream.id).length;
    }
    if (top.type === "execution_files") {
      return top.files.length;
    }
    return 0;
  }

  private moveSelection(delta: number, triggerRender: () => void) {
    if (this.navStack.length === 0) {
      const repos = this.getRepoKeys(this.tracker);
      if (repos.length === 0) return;
      this.reposSelectedIndex = Math.max(0, Math.min(repos.length - 1, this.reposSelectedIndex + delta));
      triggerRender();
      return;
    }

    const top = this.navStack[this.navStack.length - 1]!;
    if (
      top.type === "workstreams" ||
      top.type === "workstream_menu" ||
      top.type === "executions_list" ||
      top.type === "execution_files"
    ) {
      const itemsCount = this.getItemsCount(top);
      if (itemsCount === 0) return;
      top.selectedIndex = Math.max(0, Math.min(itemsCount - 1, top.selectedIndex + delta));
      triggerRender();
    }
  }

  private drillDown(triggerRender: () => void) {
    if (this.navStack.length === 0) {
      const repos = this.getRepoKeys(this.tracker);
      if (repos.length === 0) return;
      const repoKey = repos[this.reposSelectedIndex];
      if (!repoKey) return;
      this.navStack.push({
        type: "workstreams",
        repoKey,
        selectedIndex: 0,
        scrollOffset: 0,
        filter: ""
      });
      triggerRender();
      return;
    }

    const top = this.navStack[this.navStack.length - 1]!;

    if (top.type === "workstreams") {
      const workstreams = this.getFilteredWorkstreams(top);
      if (workstreams.length === 0) return;
      const workstream = workstreams[top.selectedIndex];
      if (!workstream) return;
      this.navStack.push({
        type: "workstream_menu",
        repoKey: top.repoKey,
        workstream,
        selectedIndex: 0
      });
      triggerRender();
      return;
    }

    if (top.type === "workstream_menu") {
      if (top.selectedIndex === 0) {
        const stateStr = JSON.stringify(top.workstream, null, 2);
        this.navStack.push({
          type: "state_view",
          repoKey: top.repoKey,
          workstream: top.workstream,
          scrollOffset: 0,
          linesCount: stateStr.split("\n").length
        });
      } else {
        this.navStack.push({
          type: "executions_list",
          repoKey: top.repoKey,
          workstream: top.workstream,
          selectedIndex: 0,
          scrollOffset: 0
        });
      }
      triggerRender();
      return;
    }

    if (top.type === "executions_list") {
      const executions = this.tracker.getExecutionsForWorkstream(top.workstream.id);
      if (executions.length === 0) return;
      const execution = executions[top.selectedIndex];
      if (!execution) return;

      const fileEntry: ExecutionFilesNavEntry = {
        type: "execution_files",
        repoKey: top.repoKey,
        workstream: top.workstream,
        execution,
        selectedIndex: 0,
        scrollOffset: 0,
        files: [],
        loading: true
      };
      this.navStack.push(fileEntry);
      triggerRender();

      const artifactDir = resolveExecutionArtifactDir(execution);
      if (!artifactDir) {
        fileEntry.files = ["No artifact directory recorded for this execution."];
        fileEntry.loading = false;
        triggerRender();
        return;
      }
      fs.readdir(artifactDir)
        .then(files => {
          if (!this.navStack.includes(fileEntry)) return;
          fileEntry.files = files.filter(f => !f.startsWith("."));
          fileEntry.loading = false;
          triggerRender();
        })
        .catch(err => {
          if (!this.navStack.includes(fileEntry)) return;
          fileEntry.files = [`Error listing directory: ${err.message}`];
          fileEntry.loading = false;
          triggerRender();
        });
      return;
    }

    if (top.type === "execution_files") {
      if (top.loading || top.files.length === 0) return;
      const fileName = top.files[top.selectedIndex];
      if (!fileName || fileName.startsWith("Error listing directory")) return;

      const fileViewEntry: FileViewNavEntry = {
        type: "file_view",
        repoKey: top.repoKey,
        workstream: top.workstream,
        execution: top.execution,
        fileName,
        content: "",
        scrollOffset: 0,
        loading: true
      };
      this.navStack.push(fileViewEntry);
      triggerRender();

      const artifactDir = resolveExecutionArtifactDir(top.execution);
      if (!artifactDir) {
        const errMsg = "No artifact directory recorded for this execution.";
        fileViewEntry.content = errMsg;
        fileViewEntry.linesCount = 1;
        fileViewEntry.loading = false;
        triggerRender();
        return;
      }
      const filePath = path.join(artifactDir, fileName);

      fs.readFile(filePath, "utf8")
        .then(content => {
          if (!this.navStack.includes(fileViewEntry)) return;
          fileViewEntry.content = content;
          fileViewEntry.linesCount = content.split("\n").length;
          fileViewEntry.loading = false;
          triggerRender();
        })
        .catch(err => {
          if (!this.navStack.includes(fileViewEntry)) return;
          const errMsg = `Error reading file: ${err.message}`;
          fileViewEntry.content = errMsg;
          fileViewEntry.linesCount = errMsg.split("\n").length;
          fileViewEntry.loading = false;
          triggerRender();
        });
      return;
    }
  }

  private getBreadcrumbs(): string {
    const parts: string[] = ["Repos"];
    for (const entry of this.navStack) {
      if (entry.type === "workstreams") {
        parts.push(entry.repoKey);
      } else if (entry.type === "workstream_menu") {
        const origin = entry.workstream.origin;
        parts.push(`${origin.type === "issue" ? "Issue" : "PR"} #${origin.number}`);
      } else if (entry.type === "state_view") {
        parts.push("State");
      } else if (entry.type === "executions_list") {
        parts.push("Executions");
      } else if (entry.type === "execution_files") {
        parts.push(entry.execution.id.slice(-8));
      } else if (entry.type === "file_view") {
        parts.push(entry.fileName);
      }
    }
    return parts.join(" › ");
  }

  render(model: RuntimeStatusModel, tracker: RuntimeStatusTracker, width: number, height: number, spinnerChar?: string): string[] {
    this.tracker = tracker;
    const lines: string[] = [];

    // Header layout
    const showLogo = width >= 85;
    const leftWidth = showLogo ? width - 26 : width;

    const formatRowStr = (k1: string, v1: string, k2: string, v2: string): string => {
      const col1W = Math.floor(leftWidth * 0.5);
      const col2W = leftWidth - col1W;

      const k1F = bold(dim(padOrTruncateAnsi(k1, 11)));
      const v1F = padOrTruncateAnsi(v1, Math.max(0, col1W - 11));

      const k2F = bold(dim(padOrTruncateAnsi(k2, 11)));
      const v2F = padOrTruncateAnsi(v2, Math.max(0, col2W - 11));

      return `${k1F}${v1F}${k2F}${v2F}`;
    };

    const statusStr = `${getStatusColorSymbol(model.status)} ${formatStatus(model.status)}`;
    const readinessStr = formatReadiness(model.readiness);
    const reposStr = model.repos === "—" ? "—" : `${model.repos} enabled`;
    const cycleStr = model.cycleNo === "—" ? "—" : `#${model.cycleNo}`;

    const narrow = width < 60;

    if (narrow) {
      const formatSingleRow = (k: string, v: string): string => {
        const kF = bold(dim(padOrTruncateAnsi(k, 11)));
        const vF = padOrTruncateAnsi(v, Math.max(0, leftWidth - 11));
        return `${kF}${vF}`;
      };

      const narrowRows = [
        formatSingleRow("STATUS", statusStr),
        formatSingleRow("UPTIME", formatUptime(model.uptime)),
        formatSingleRow("READINESS", readinessStr),
        formatSingleRow("CYCLE", cycleStr),
        formatSingleRow("REPOS", reposStr),
        formatSingleRow("LAST OK", model.lastOk),
        formatSingleRow("NEXT", model.nextText)
      ];
      lines.push(...narrowRows);
    } else {
      const rawRows = [
        formatRowStr("STATUS", statusStr, "UPTIME", formatUptime(model.uptime)),
        formatRowStr("READINESS", readinessStr, "CYCLE", cycleStr),
        formatRowStr("REPOS", reposStr, "LAST OK", model.lastOk),
        formatRowStr("NEXT", model.nextText, "", "")
      ];

      // Combine with Logo
      for (let i = 0; i < 5; i++) {
        let leftPart = rawRows[i] || " ".repeat(leftWidth);
        if (showLogo) {
          const logoPart = getAnimatedLogoLine(i, model.status, spinnerChar);
          lines.push(`${leftPart}  ${logoPart}`);
        } else {
          lines.push(leftPart);
        }
      }
    }

    lines.push("");

    // Section 1: CURRENT OPERATION
    lines.push(sectionHeader("CURRENT OPERATION", width));
    let opGlyph = model.status === "syncing" || model.status === "executing" ? (spinnerChar || "●") : "○";
    let opGlyphAnsi = model.status === "syncing" ? cyan(opGlyph) : model.status === "executing" ? green(opGlyph) : dim(opGlyph);

    lines.push(`${opGlyphAnsi} ${bold(model.opText)}`);
    if (model.opTarget) {
      lines.push(`  Target:   ${model.opTarget}`);
    }
    if (model.opSub) {
      lines.push(`  Detail:   ${dim(model.opSub)}`);
    }

    // List running tasks (separated by Orchestrator vs Agent)
    const running = tracker.getRunningTasks();
    if (running.size > 0) {
      const orchestratorTasks: Array<{ task: any; agent: any; startTime: number }> = [];
      const agentTasks: Array<{ task: any; agent: any; startTime: number }> = [];
      for (const { task, agent, startTime } of running.values()) {
        if (!agent) {
          orchestratorTasks.push({ task, agent, startTime });
        } else {
          agentTasks.push({ task, agent, startTime });
        }
      }

      if (orchestratorTasks.length > 0) {
        lines.push("");
        lines.push(bold("  Active Orchestrator Tasks:"));
        for (const { task, agent, startTime } of orchestratorTasks) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          const elapsedStr = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
          const agentDisplay = formatAgent(agent);
          const taskKind = tracker.getTaskKindText(task.kind);
          lines.push(`    - ${agentDisplay} runs ${dim(taskKind)} [elapsed ${cyan(elapsedStr)}]`);
        }
      }

      if (agentTasks.length > 0) {
        lines.push("");
        lines.push(bold("  Active Agent Tasks:"));
        for (const { task, agent, startTime } of agentTasks) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          const elapsedStr = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
          const agentDisplay = formatAgent(agent);
          const taskKind = tracker.getTaskKindText(task.kind);
          lines.push(`    - ${agentDisplay} runs ${green(taskKind)} [elapsed ${cyan(elapsedStr)}]`);
        }
      }
    }
    lines.push("");

    // Render Latest Cycle outcome and Hints if any
    let cycleGlyphColor = model.cycleGlyph === "✓" ? green : model.cycleGlyph === "✗" ? red : model.cycleGlyph === "⚠" ? yellow : dim;
    lines.push(`  Latest Cycle: ${cycleGlyphColor(model.cycleGlyph)} ${bold(model.cycleText)} ${dim(`(${model.cycleMeta})`)}`);

    if (model.hints && model.hints.length > 0) {
      for (const hint of model.hints) {
        let hintGlyphAnsi = dim(hint.glyph);
        if (hint.color === "yellow") hintGlyphAnsi = yellow(hint.glyph);
        else if (hint.color === "cyan") hintGlyphAnsi = cyan(hint.glyph);
        else if (hint.color === "red") hintGlyphAnsi = red(hint.glyph);

        let hintTextAnsi = hint.text;
        if (hint.color === "dim") hintTextAnsi = dim(hint.text);

        let prefix = "  Status:       ";
        if (hint.color === "yellow" || hint.color === "red") {
          prefix = "  Investigate:  ";
        } else if (hint.color === "cyan") {
          prefix = "  Info:         ";
        }
        lines.push(`${prefix}${hintGlyphAnsi} ${hintTextAnsi}`);
      }
    }
    lines.push("");

    // Section 2: EXECUTIONS & STATE EXPLORER
    lines.push(sectionHeader("EXECUTIONS & STATE EXPLORER", width));
    const crumbs = this.getBreadcrumbs();
    lines.push(bold(cyan("  " + crumbs)));
    lines.push("");

    const explorerStartLineCount = lines.length;
    this.explorerMaxHeight = Math.max(5, height - explorerStartLineCount - 2);
    const explorerMaxHeight = this.explorerMaxHeight;

    const explorerLines: string[] = [];

    if (this.navStack.length === 0) {
      const repos = this.getRepoKeys(tracker);
      this.reposSelectedIndex = Math.min(this.reposSelectedIndex, Math.max(0, repos.length - 1));
      if (repos.length === 0) {
        explorerLines.push(`  ${dim("No active repositories or workstreams in state.")}`);
      } else {
        // Keep cursor visible
        if (this.reposSelectedIndex < this.reposScrollOffset) this.reposScrollOffset = this.reposSelectedIndex;
        if (this.reposSelectedIndex >= this.reposScrollOffset + explorerMaxHeight) this.reposScrollOffset = this.reposSelectedIndex - explorerMaxHeight + 1;
        this.reposScrollOffset = Math.max(0, Math.min(this.reposScrollOffset, Math.max(0, repos.length - explorerMaxHeight)));
        const visibleEnd = Math.min(repos.length, this.reposScrollOffset + explorerMaxHeight);
        for (let i = this.reposScrollOffset; i < visibleEnd; i++) {
          const isSelected = i === this.reposSelectedIndex;
          const pointer = isSelected ? green("› ") : "  ";
          const repoText = isSelected ? bold(repos[i] || "") : (repos[i] || "");
          explorerLines.push(`  ${pointer}${repoText}`);
        }
        if (repos.length > explorerMaxHeight) {
          const pct = Math.round((visibleEnd / repos.length) * 100);
          explorerLines.push(`  ${dim(`-- ${visibleEnd}/${repos.length} (${pct}%) --`)}`);
        }
      }
    } else {
      const top = this.navStack[this.navStack.length - 1]!;

      if (top.type === "workstreams") {
        const allWorkstreams = tracker.getWorkstreamsForRepo(top.repoKey);
        const workstreams = this.getFilteredWorkstreams(top);
        top.selectedIndex = Math.min(top.selectedIndex, Math.max(0, workstreams.length - 1));

        if (top.filter) {
          const matchStr = `${workstreams.length}/${allWorkstreams.length}`;
          explorerLines.push(`  ${cyan("/")} ${bold(top.filter)}${dim("_")}  ${dim(matchStr + " matches")}`);
        }

        if (workstreams.length === 0) {
          explorerLines.push(`  ${dim(top.filter ? `No matches for "${top.filter}"` : "No active workstreams for this repository.")}`);
        } else {
          // Keep cursor visible
          if (top.selectedIndex < top.scrollOffset) top.scrollOffset = top.selectedIndex;
          if (top.selectedIndex >= top.scrollOffset + explorerMaxHeight) top.scrollOffset = top.selectedIndex - explorerMaxHeight + 1;
          top.scrollOffset = Math.max(0, Math.min(top.scrollOffset, Math.max(0, workstreams.length - explorerMaxHeight)));
          const visibleEnd = Math.min(workstreams.length, top.scrollOffset + explorerMaxHeight);
          for (let i = top.scrollOffset; i < visibleEnd; i++) {
            const isSelected = i === top.selectedIndex;
            const pointer = isSelected ? green("› ") : "  ";
            const ws = workstreams[i]!;
            const typeStr = ws.origin.type.toUpperCase();
            const title = tracker.getWorkstreamTitle(ws) || "No title";
            const label = `${typeStr} #${ws.origin.number} · ${title}`;
            const formatted = isSelected ? bold(label) : label;
            explorerLines.push(`  ${pointer}${formatted}`);
          }
          if (workstreams.length > explorerMaxHeight) {
            const pct = Math.round((visibleEnd / workstreams.length) * 100);
            explorerLines.push(`  ${dim(`-- ${visibleEnd}/${workstreams.length} (${pct}%) --`)}`);
          }
        }
      } else if (top.type === "workstream_menu") {
        const menuItems = ["State", "Executions"];
        for (let i = 0; i < menuItems.length; i++) {
          const isSelected = i === top.selectedIndex;
          const pointer = isSelected ? green("› ") : "  ";
          const formatted = isSelected ? bold(menuItems[i] || "") : (menuItems[i] || "");
          explorerLines.push(`  ${pointer}${formatted}`);
        }
      } else if (top.type === "state_view") {
        const liveWorkstream = tracker.getWorkstreamById(top.workstream.id) || top.workstream;
        const stateStr = JSON.stringify(liveWorkstream, null, 2);
        const allStateLines = stateStr.split("\n");
        top.linesCount = allStateLines.length;
        top.scrollOffset = Math.min(top.scrollOffset, Math.max(0, top.linesCount - explorerMaxHeight));
        const start = top.scrollOffset;
        const end = start + explorerMaxHeight;
        const visible = allStateLines.slice(start, end);

        for (const line of visible) {
          explorerLines.push(`  ${line}`);
        }

        if (allStateLines.length > explorerMaxHeight) {
          const pct = Math.round(((start + visible.length) / allStateLines.length) * 100);
          explorerLines.push(`  ${dim(`-- scroll: line ${start + 1}/${allStateLines.length} (${pct}%) --`)}`);
        }
      } else if (top.type === "executions_list") {
        const executions = tracker.getExecutionsForWorkstream(top.workstream.id);
        top.selectedIndex = Math.min(top.selectedIndex, Math.max(0, executions.length - 1));
        if (executions.length === 0) {
          explorerLines.push(`  ${dim("No executions recorded for this workstream.")}`);
        } else {
          // Keep cursor visible
          if (top.selectedIndex < top.scrollOffset) top.scrollOffset = top.selectedIndex;
          if (top.selectedIndex >= top.scrollOffset + explorerMaxHeight) top.scrollOffset = top.selectedIndex - explorerMaxHeight + 1;
          top.scrollOffset = Math.max(0, Math.min(top.scrollOffset, Math.max(0, executions.length - explorerMaxHeight)));
          const visibleEnd = Math.min(executions.length, top.scrollOffset + explorerMaxHeight);
          for (let i = top.scrollOffset; i < visibleEnd; i++) {
            const isSelected = i === top.selectedIndex;
            const pointer = isSelected ? green("› ") : "  ";
            const exec = executions[i]!;
            const dateStr = new Date(exec.startedAt).toLocaleString();
            const taskKind = tracker.getTaskKindText(exec.taskKind);
            const statusText = exec.taskStatus === "completed" ? green("SUCCESS") : red("FAILED");
            const details = `${dateStr}  ${bold(taskKind)} [${statusText} (exit: ${exec.exitCode})]`;
            const formatted = isSelected ? bold(details) : details;
            explorerLines.push(`  ${pointer}${formatted}`);
          }
          if (executions.length > explorerMaxHeight) {
            const pct = Math.round((visibleEnd / executions.length) * 100);
            explorerLines.push(`  ${dim(`-- ${visibleEnd}/${executions.length} (${pct}%) --`)}`);
          }
        }
      } else if (top.type === "execution_files") {
        top.selectedIndex = Math.min(top.selectedIndex, Math.max(0, top.files.length - 1));
        if (top.loading) {
          explorerLines.push(`  ${cyan("Loading files...")}`);
        } else if (top.files.length === 0) {
          explorerLines.push(`  ${dim("No files found in execution directory.")}`);
        } else {
          // Keep cursor visible
          if (top.selectedIndex < top.scrollOffset) top.scrollOffset = top.selectedIndex;
          if (top.selectedIndex >= top.scrollOffset + explorerMaxHeight) top.scrollOffset = top.selectedIndex - explorerMaxHeight + 1;
          top.scrollOffset = Math.max(0, Math.min(top.scrollOffset, Math.max(0, top.files.length - explorerMaxHeight)));
          const visibleEnd = Math.min(top.files.length, top.scrollOffset + explorerMaxHeight);
          for (let i = top.scrollOffset; i < visibleEnd; i++) {
            const isSelected = i === top.selectedIndex;
            const pointer = isSelected ? green("› ") : "  ";
            const fileName = top.files[i] || "";
            const formatted = isSelected ? bold(fileName) : fileName;
            explorerLines.push(`  ${pointer}${formatted}`);
          }
          if (top.files.length > explorerMaxHeight) {
            const pct = Math.round((visibleEnd / top.files.length) * 100);
            explorerLines.push(`  ${dim(`-- ${visibleEnd}/${top.files.length} (${pct}%) --`)}`);
          }
        }
      } else if (top.type === "file_view") {
        if (top.loading) {
          explorerLines.push(`  ${cyan("Loading file content...")}`);
        } else {
          const fileContentLines = top.content.split("\n");
          top.scrollOffset = Math.min(top.scrollOffset, Math.max(0, fileContentLines.length - explorerMaxHeight));
          const start = top.scrollOffset;
          const end = start + explorerMaxHeight;
          const visible = fileContentLines.slice(start, end);

          for (const line of visible) {
            explorerLines.push(`  ${line.replace(/\t/g, "    ")}`);
          }

          if (fileContentLines.length > explorerMaxHeight) {
            const pct = Math.round(((start + visible.length) / fileContentLines.length) * 100);
            explorerLines.push(`  ${dim(`-- scroll: line ${start + 1}/${fileContentLines.length} (${pct}%) --`)}`);
          }
        }
      }
    }

    lines.push(...explorerLines);
    return lines;
  }
}

function resolveExecutionArtifactDir(execution: ExecutionRecord): string | undefined {
  const artifactPath = firstNonEmptyString(
    execution.promptArtifactPath,
    execution.stdoutArtifactPath,
    execution.stderrArtifactPath,
    execution.streamArtifactPath,
    execution.providerTranscriptArtifactPath,
    execution.promptPacketPath,
    execution.settingsArtifactPath
  );
  return artifactPath ? path.dirname(artifactPath) : undefined;
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

export class McpsView implements TuiView {
  render(model: RuntimeStatusModel, tracker: RuntimeStatusTracker, width: number, height: number, spinnerChar?: string): string[] {
    const lines: string[] = [];

    lines.push("");
    lines.push(bold("SMITHERY MCP CONNECTIONS & CAPABILITIES"));

    const reloadErr = tracker.getConfigReloadError();
    if (reloadErr) {
      lines.push(
        `${red("⚠️ CONFIG RELOAD FAILED:")} ${yellow(reloadErr.message || String(reloadErr))}`
      );
      lines.push("");
    }

    const mcps = tracker.getMcps();
    const statuses = tracker.getMcpStatuses();
    const maxConcurrent = tracker.getMaxConcurrent();

    lines.push(
      `${dim("Active MCPs:")} ${mcps.length} declared · ${dim("Concurrency limit:")} max ${maxConcurrent}`
    );
    lines.push("");

    if (mcps.length === 0) {
      lines.push(dim("No Smithery MCPs declared in mcps.json."));
      return lines;
    }

    for (const mcp of mcps) {
      const statusRecord = statuses.find(s => s.handle === mcp.handle);
      
      let statusSymbol = dim("●");
      let statusText = "NOT CHECKED";
      let lastChecked = "—";

      if (statusRecord) {
        lastChecked = statusRecord.lastCheckedAt ? new Date(statusRecord.lastCheckedAt).toLocaleTimeString() : "—";
        switch (statusRecord.status) {
          case "ready":
            statusSymbol = green("●");
            statusText = green("READY");
            break;
          case "resolved":
            statusSymbol = cyan("●");
            statusText = cyan("RESOLVED");
            break;
          case "action_required":
            statusSymbol = yellow("●");
            statusText = yellow("ACTION REQUIRED");
            break;
          case "resolution_failed":
            statusSymbol = red("●");
            statusText = red("RESOLUTION FAILED");
            break;
          case "error":
            statusSymbol = red("●");
            statusText = red("ERROR");
            break;
        }
      }

      lines.push(sectionHeader(mcp.handle.toUpperCase(), width));
      lines.push(`  ${dim("Smithery ID:")} ${mcp.smitheryId}`);
      lines.push(`  ${dim("Status:")}      ${statusSymbol} ${statusText} ${dim(`(checked ${lastChecked})`)}`);

      if (statusRecord?.message) {
        lines.push(`  ${dim("Message:")}     ${yellow(statusRecord.message)}`);
      }
      if (statusRecord?.actionRequired?.message) {
        lines.push(`  ${dim("Message:")}     ${yellow(statusRecord.actionRequired.message)}`);
      }
      if (statusRecord?.connection) {
        const conn = statusRecord.connection;
        lines.push(`  ${dim("Connection:")}  ${dim("Transport:")} ${conn.transport ?? "stdio"} · ${dim("Proof:")} ${conn.readinessProof ?? "connected"}`);
      }

      // Map capabilities using this MCP
      const caps = tracker.getCapabilities();
      const sensors = caps.sensors.filter(s => s.uses === mcp.handle);
      const controllers = caps.controllers.filter(c => c.uses === mcp.handle);

      if (sensors.length > 0 || controllers.length > 0) {
        lines.push("  " + bold("Capabilities Using This MCP:"));
        
        for (const sensor of sensors) {
          const isProjected = statusRecord?.status === "ready";
          const projStatusText = isProjected ? green("PROJECTED") : red("BLOCKED");
          lines.push(`    ${dim("-")} ${bold("sensor:")} ${sensor.name} ${dim(`(observes: ${sensor.observes})`)} [${projStatusText}]`);
          if (isProjected) {
            const mappedTools = SENSOR_TOOL_MAP[sensor.observes] ?? [];
            lines.push("      " + dim("Projected Tools:"));
            for (const tool of mappedTools) {
              lines.push(`        ${green("→")} ${cyan(`${mcp.handle}.${tool}`)}`);
            }
          }
        }

        for (const controller of controllers) {
          const isProjected = statusRecord?.status === "ready";
          const projStatusText = isProjected ? green("PROJECTED") : red("BLOCKED");
          lines.push(`    ${dim("-")} ${bold("controller:")} ${controller.name} ${dim(`(grants: ${controller.grants.join(", ")})`)} [${projStatusText}]`);
          if (isProjected) {
            const mappedTools = controller.grants.flatMap(g => CONTROLLER_TOOL_MAP[g] ?? []);
            const uniqueTools = Array.from(new Set(mappedTools));
            if (uniqueTools.length > 0) {
              lines.push("      " + dim("Projected Tools:"));
              for (const tool of uniqueTools) {
                lines.push(`        ${green("→")} ${cyan(`${mcp.handle}.${tool}`)}`);
              }
            }
          }
        }
      } else {
        lines.push(dim("  No capabilities currently configured to use this MCP."));
      }

      lines.push("");
    }

    return lines;
  }
}

export class TasksView implements TuiView {
  render(model: RuntimeStatusModel, tracker: RuntimeStatusTracker, width: number, height: number, spinnerChar?: string): string[] {
    const lines: string[] = [];

    lines.push("");
    lines.push(bold("CURRENTLY RUNNING TASKS"));

    const running = tracker.getRunningTasks();
    const maxConcurrent = tracker.getMaxConcurrent();

    lines.push(
      `${dim("Total:")} ${running.size} active · ${dim("Concurrency limit:")} max ${maxConcurrent}`
    );
    lines.push("");

    if (running.size === 0) {
      lines.push(dim("No tasks are currently running."));
      return lines;
    }

    // Dynamic Columns config
    let colWidths: number[];
    let headers: string[];

    if (width >= 100) {
      const agentW = 16;
      const jobW = 20;
      const timeW = 7;
      const targetW = Math.max(20, Math.floor((width - 10) * 0.22));
      const worktreeW = Math.max(20, Math.floor((width - 10) * 0.22));
      const idW = Math.max(8, width - 10 - agentW - jobW - timeW - targetW - worktreeW);
      colWidths = [agentW, jobW, timeW, targetW, worktreeW, idW];
      headers = ["AGENT", "JOB/KIND", "TIME", "TARGET", "WORKTREE", "TASK ID"];
    } else if (width >= 70) {
      const agentW = 14;
      const jobW = 18;
      const timeW = 7;
      const targetW = Math.max(15, Math.floor((width - 8) * 0.3));
      const worktreeW = width - 8 - agentW - jobW - timeW - targetW;
      colWidths = [agentW, jobW, timeW, targetW, worktreeW];
      headers = ["AGENT", "JOB/KIND", "TIME", "TARGET", "WORKTREE"];
    } else {
      const agentW = 12;
      const jobW = 16;
      const timeW = 6;
      const targetW = width - 6 - agentW - jobW - timeW;
      colWidths = [agentW, jobW, timeW, targetW];
      headers = ["AGENT", "JOB/KIND", "TIME", "TARGET"];
    }

    const headerRow = colWidths.map((w, idx) => padOrTruncateAnsi(bold(headers[idx] || ""), w)).join("  ");
    const underline = colWidths.map(w => "─".repeat(w)).join("  ");

    lines.push(bold(cyan(headerRow)));
    lines.push(dim(underline));

    for (const [taskId, { task, agent, startTime }] of running.entries()) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const elapsedStr = `${min}:${String(sec).padStart(2, "0")}`;

      // 1. Agent column styling
      const agentText = formatAgent(agent);

      // 2. Job column styling
      const taskKind = tracker.getTaskKindText(task.kind);
      let jobText = taskKind;
      if (!agent) {
        jobText = dim(taskKind);
      } else if (task.kind === "implement_plan") {
        jobText = green(taskKind);
      } else if (task.kind === "write_plan") {
        jobText = blue(taskKind);
      } else if (task.kind === "review_pr") {
        jobText = yellow(taskKind);
      } else if (task.kind === "prepare_pr_for_merge") {
        jobText = magenta(taskKind);
      } else if (task.kind === "sync_parent_branch") {
        jobText = dim(taskKind);
      }

      // 3. Time column styling
      const timeText = agent ? cyan(elapsedStr) : dim(elapsedStr);

      // 4. Target column
      const rawTarget = tracker.getTaskTargetText(task);
      const targetText = agent ? rawTarget : dim(rawTarget);

      // 5. Worktree column
      const rawWorktree = task.context.localRepoPath ? (task.context.localRepoPath.split("/").pop() ?? "—") : "—";
      const worktreeText = agent ? rawWorktree : dim(rawWorktree);

      // 6. ID column
      const idText = agent ? task.id : dim(task.id);

      // Build cols array based on configuration
      let rowCols: string[] = [];
      if (width >= 100) {
        rowCols = [agentText, jobText, timeText, targetText, worktreeText, idText];
      } else if (width >= 70) {
        rowCols = [agentText, jobText, timeText, targetText, worktreeText];
      } else {
        rowCols = [agentText, jobText, timeText, targetText];
      }

      const rowStr = rowCols.map((c, idx) => padOrTruncateAnsi(c, colWidths[idx] || 0)).join("  ");
      lines.push(rowStr);
    }

    return lines;
  }
}
