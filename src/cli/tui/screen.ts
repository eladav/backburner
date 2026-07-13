import * as readline from "node:readline";
import { RuntimeStatusTracker } from "./tracker.js";
import type { RuntimeStatusModel, TuiView } from "./types.js";
import {
  StatusView,
  McpsView,
  TasksView,
  stripAnsi,
  padOrTruncateAnsi,
  reset,
  bold,
  dim,
  cyan,
  blue,
  green,
  yellow,
  red,
  magenta
} from "./views.js";

const SPIN_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TuiScreen {
  private tracker: RuntimeStatusTracker;
  private onTriggerRefresh: () => Promise<void>;
  private onQuit: () => void;
  
  private views: Record<string, TuiView>;

  private viewScrollOffsets: Record<string, number> = {
    status: 0,
    mcps: 0,
    tasks: 0
  };

  private viewMode: string = "status";
  private inputMode: boolean = false;
  private inputBuffer: string = "";
  private isRefreshing: boolean = false;
  private helpOpen: boolean = false;
  private spinIndex: number = 0;
  private lastRenderOutput: string = "";
  private tickInterval: NodeJS.Timeout | null = null;
  private spinInterval: NodeJS.Timeout | null = null;
  private keypressHandler: ((str: string, key: any) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;
  private exited: boolean = false;
  private lastTimeLength: number = 0;

  constructor(tracker: RuntimeStatusTracker, onTriggerRefresh: () => Promise<void>, onQuit: () => void) {
    this.tracker = tracker;
    this.onTriggerRefresh = onTriggerRefresh;
    this.onQuit = onQuit;
    this.views = {
      status: new StatusView(tracker),
      mcps: new McpsView(),
      tasks: new TasksView()
    };
  }

  setRefreshing(refreshing: boolean): void {
    if (this.isRefreshing === refreshing) return;
    this.isRefreshing = refreshing;
    this.render();
  }

  start(): void {
    // Switch to alternate screen buffer and hide cursor
    process.stdout.write("\x1b[?1049h\x1b[?25l");

    // Clear screen initially
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);

    // Track uptime and countdown ticks
    this.tickInterval = setInterval(() => {
      this.tracker.updateUptime();
      this.render();
    }, 1000);

    // Spinner animation tick (110ms)
    this.spinInterval = setInterval(() => {
      this.spinIndex = (this.spinIndex + 1) % SPIN_CHARS.length;
      if (this.tracker.getModel().status === "syncing" || this.tracker.getModel().status === "executing") {
        this.render();
      }
    }, 110);

    // Keyboard events
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }

    this.keypressHandler = (str: string, key: any) => {
      if (key && key.ctrl && key.name === "c") {
        this.onQuit();
        return;
      }

      if (this.inputMode) {
        if (key && key.name === "return") {
          const cmd = this.inputBuffer;
          this.inputMode = false;
          this.inputBuffer = "";
          this.executeCommand(cmd);
          this.render();
          return;
        }

        if (key && key.name === "escape") {
          this.inputMode = false;
          this.inputBuffer = "";
          this.render();
          return;
        }

        if (key && key.name === "backspace") {
          if (this.inputBuffer.length > 0) {
            this.inputBuffer = this.inputBuffer.slice(0, -1);
          }
          this.render();
          return;
        }

        // Printable chars
        if (str && str.length === 1 && !key?.ctrl && !key?.meta) {
          this.inputBuffer += str;
          this.render();
        }
        return;
      }

      // Delegate keypresses to active view first if help is not open
      if (!this.helpOpen) {
        const currentView = (this.views[this.viewMode] || this.views.status) as TuiView;
        if (currentView && typeof currentView.handleKey === "function") {
          const handled = currentView.handleKey(key, str, () => this.render());
          if (handled) {
            return;
          }
        }
      }

      const k = (key?.name || str || "").toLowerCase();


      // Scrolling handlers
      if (k === "up" || k === "k") {
        this.scroll(-1);
        return;
      } else if (k === "down" || k === "j") {
        this.scroll(1);
        return;
      } else if (k === "pageup") {
        this.scroll(-10);
        return;
      } else if (k === "pagedown") {
        this.scroll(10);
        return;
      }

      if (str === ":" || str === "/") {
        this.inputMode = true;
        this.inputBuffer = str;
        this.render();
        return;
      }

      if (k === "q") {
        this.onQuit();
        return;
      } else if (k === "r") {
        this.triggerManualRefresh();
      } else if (k === "?" || str === "?") {
        this.helpOpen = !this.helpOpen;
        this.render();
      } else if (k === "escape") {
        if (this.helpOpen) {
          this.helpOpen = false;
        } else if (this.viewMode !== "status") {
          this.viewMode = "status";
        }
        this.render();
      } else if (k === "s") {
        this.viewMode = "status";
        this.helpOpen = false;
        this.render();
      } else if (k === "m") {
        this.viewMode = "mcps";
        this.helpOpen = false;
        this.render();
      } else if (k === "t") {
        this.viewMode = "tasks";
        this.helpOpen = false;
        this.render();
      }
    };

    process.stdin.on("keypress", this.keypressHandler);

    // Handle terminal resizing
    this.resizeHandler = () => {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      this.lastRenderOutput = ""; // force full redraw on resize
      this.render();
    };
    process.stdout.on("resize", this.resizeHandler);

    // Register process termination handlers to restore terminal state
    this.sigintHandler = () => {
      this.exit();
      process.exit(130);
    };
    this.sigtermHandler = () => {
      this.exit();
      process.exit(143);
    };
    process.once("SIGINT", this.sigintHandler);
    process.once("SIGTERM", this.sigtermHandler);

    this.tracker.register(() => this.render());
    this.render();
  }

  private scroll(delta: number): void {
    const currentOffset = this.viewScrollOffsets[this.viewMode] || 0;
    this.viewScrollOffsets[this.viewMode] = Math.max(0, currentOffset + delta);
    this.render();
  }

  private executeCommand(cmd: string): void {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    const normalized = trimmed.startsWith(":") ? "/" + trimmed.slice(1) : trimmed;

    if (normalized === "/status" || normalized === "/s") {
      this.viewMode = "status";
      this.helpOpen = false;
    } else if (normalized === "/mcps" || normalized === "/mcp" || normalized === "/m") {
      this.viewMode = "mcps";
      this.helpOpen = false;
    } else if (normalized === "/tasks" || normalized === "/task" || normalized === "/t") {
      this.viewMode = "tasks";
      this.helpOpen = false;
    } else if (normalized === "/refresh" || normalized === "/r") {
      this.triggerManualRefresh();
    } else if (normalized === "/help" || normalized === "/h" || normalized === "/?") {
      this.helpOpen = !this.helpOpen;
    } else if (normalized === "/quit" || normalized === "/q") {
      this.onQuit();
    }
  }

  private triggerManualRefresh(): void {
    void this.onTriggerRefresh();
  }

  exit(): void {
    if (this.exited) return;
    this.exited = true;

    // Restore main screen buffer and show cursor
    process.stdout.write("\x1b[?1049l\x1b[?25h");

    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.spinInterval) clearInterval(this.spinInterval);

    if (this.keypressHandler) {
      process.stdin.off("keypress", this.keypressHandler);
    }
    if (this.resizeHandler) {
      process.stdout.off("resize", this.resizeHandler);
    }

    if (this.sigintHandler) {
      process.off("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
    if (this.sigtermHandler) {
      process.off("SIGTERM", this.sigtermHandler);
      this.sigtermHandler = null;
    }

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  }

  render(): void {
    const model = this.tracker.getModel();
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    const width = Math.max(40, cols);
    const contentWidth = width - 4;
    const bodyHeight = Math.max(1, rows - 7);

    const spinner = SPIN_CHARS[this.spinIndex] ?? "⠋";

    // Compute view lines and scrollbar state first, so we can render corner connectors on dividers
    let viewLines: string[] = [];

    if (this.helpOpen) {
      // HELP OVERLAY MODE
      viewLines = [
        "",
        bold("Backburner runtime status — help"),
        "",
        `${bold("q")}         ${dim("quit — return to your shell")}`,
        `${bold("r")}         ${dim("refresh now")}`,
        `${bold("s")}         ${dim("switch to main status view")}`,
        `${bold("m")}         ${dim("switch to Smithery MCP health view")}`,
        `${bold("t")}         ${dim("switch to running tasks view")}`,
        `${bold(":")} /       ${dim("open command prompt")}`,
        `${bold("?")}         ${dim("toggle this help")}`,
        `${bold("esc")}       ${dim("close help / return to status view")}`,
        "",
        bold("Explorer Navigation:"),
        `${bold("up/down (j/k)")}  ${dim("move selection cursor / scroll explorer content")}`,
        `${bold("pageup/down")}    ${dim("scroll the main page viewport")}`,
        `${bold("enter")}          ${dim("drill down / open selected item")}`,
        `${bold("esc / backspace")} ${dim("go back one level in the hierarchy")}`,
        `${bold("type chars")}     ${dim("filter workstreams by number or title (esc to clear)")}`,
        "",
        `${dim("This screen is ")}${bold("read-only")}${dim(". It shows status and does not mutate state.")}`,
        "",
        dim("Go to the source of truth for detail:"),
        `${cyan("GitHub")}       ${dim("issues · plans · PRs · reviews")}`,
        `${blue("logs/state")}   ${dim("full history")}`,
        "",
        dim("press ? or esc to close"),
        ""
      ];
    } else {
      const currentView = (this.views[this.viewMode] || this.views.status) as TuiView;
      viewLines = currentView.render(model, this.tracker, contentWidth, bodyHeight, spinner);
    }

    const totalLines = viewLines.length;
    const showScrollbar = totalLines > bodyHeight;

    let scrollOffset = this.viewScrollOffsets[this.viewMode] || 0;
    scrollOffset = Math.max(0, Math.min(scrollOffset, totalLines - bodyHeight));
    this.viewScrollOffsets[this.viewMode] = scrollOffset;

    const visibleLines = viewLines.slice(scrollOffset, scrollOffset + bodyHeight);

    while (visibleLines.length < bodyHeight) {
      visibleLines.push("");
    }

    // Build the rendered buffer
    let lines: string[] = [];

    // 1. Top border
    lines.push(`┌${"─".repeat(width - 2)}┐`);

    const padNum = (n: number) => String(n).padStart(2, "0");
    const d = new Date();
    const nowTime = `${padNum(d.getHours())}:${padNum(d.getMinutes())}:${padNum(d.getSeconds())}`;
    const viewTitle = this.helpOpen ? "HELP" : this.viewMode.toUpperCase();
    const titleLeftPlain = `› Backburner [${viewTitle}]`;
    const titleLeftAnsi = `${dim("›")} Backburner [${bold(cyan(viewTitle))}]`;
    const titleRightPlain = `tty · ${cols}x${rows}  ${nowTime}`;
    const titleRightAnsi = `tty · ${cols}x${rows}  ${nowTime}`;

    const spaceBetween = Math.max(0, contentWidth - titleLeftPlain.length - titleRightPlain.length);
    lines.push(`│ ${titleLeftAnsi}${" ".repeat(spaceBetween)}${titleRightAnsi} │`);

    // 3. Divider (with T-connector for scrollbar track)
    const topDivider = showScrollbar
      ? `├${"─".repeat(width - 3)}┬┤`
      : `├${"─".repeat(width - 2)}┤`;
    lines.push(topDivider);

    // 4. Viewport body lines
    for (let i = 0; i < bodyHeight; i++) {
      const line = visibleLines[i] || "";
      const formatted = padOrTruncateAnsi(line, contentWidth);
      
      let rightBorder = " │";
      if (showScrollbar) {
        const thumbHeight = Math.max(1, Math.floor((bodyHeight / totalLines) * bodyHeight));
        const maxScroll = totalLines - bodyHeight;
        const thumbStart = maxScroll > 0 ? Math.round((scrollOffset / maxScroll) * (bodyHeight - thumbHeight)) : 0;
        const isThumb = i >= thumbStart && i < thumbStart + thumbHeight;
        
        rightBorder = isThumb ? ` ${bold(cyan("┃"))}` : ` ${dim("░")}`;
      }
      
      lines.push(`│ ${formatted}${rightBorder}`);
    }

    // 5. Divider before footer (with T-connector for scrollbar track)
    const bottomDivider = showScrollbar
      ? `├${"─".repeat(width - 3)}┴┤`
      : `├${"─".repeat(width - 2)}┤`;
    lines.push(bottomDivider);

    // 6. Footer
    if (this.inputMode) {
      const footerLeftPlain = `Command: ${this.inputBuffer}`;
      const footerLeftAnsi = `${bold("Command:")} ${this.inputBuffer}`;
      lines.push(`│ ${padOrTruncateAnsi(footerLeftAnsi, contentWidth)} │`);
    } else {
      const footerLeftPlain = "q quit  r refresh  s status  m mcps  t tasks  ? help";
      const footerLeftAnsi = `${bold("q")} ${dim("quit")}  ${bold("r")} ${dim("refresh")}  ${bold("s")} ${dim("status")}  ${bold("m")} ${dim("mcps")}  ${bold("t")} ${dim("tasks")}  ${bold("?")} ${dim("help")}`;
      
      let footerRightPlain = "read-only · headless off";
      let footerRightAnsi = `${dim("read-only · headless off")}`;
      
      if (this.isRefreshing) {
        footerRightPlain = "⟳ refreshing...";
        footerRightAnsi = cyan("⟳ refreshing...");
      }

      const space = Math.max(0, contentWidth - stripAnsi(footerLeftAnsi).length - stripAnsi(footerRightAnsi).length);
      const footerLine = `${footerLeftAnsi}${" ".repeat(space)}${footerRightAnsi}`;
      lines.push(`│ ${padOrTruncateAnsi(footerLine, contentWidth)} │`);
    }

    // 7. Bottom border
    lines.push(`└${"─".repeat(width - 2)}┘`);

    // Draw the whole content cleanly to screen with clock-dedup optimization
    const newOutput = lines.join("\n");
    const dedupOutput = newOutput.replace(nowTime, "HH:MM:SS");
    
    if (dedupOutput === this.lastRenderOutput && nowTime.length === this.lastTimeLength) {
      // Optimization: Only the clock ticked, so we only update the clock string
      readline.cursorTo(process.stdout, cols - 2 - nowTime.length, 1);
      process.stdout.write(nowTime);
    } else {
      // Full screen redraw
      readline.cursorTo(process.stdout, 0, 0);
      process.stdout.write(newOutput);
      this.lastRenderOutput = dedupOutput;
      this.lastTimeLength = nowTime.length;
    }
  }
}
