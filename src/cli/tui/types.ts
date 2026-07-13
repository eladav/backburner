export interface TuiHint {
  glyph: string;
  text: string;
  color?: string; // terminal color prefix (e.g. green, yellow, red, cyan, dim)
}

export type TuiStatus = "executing" | "idle" | "syncing" | "waiting" | "blocked" | "failed";
export type TuiReadiness = "ok" | "warnings" | "blocking problems";

export interface RuntimeStatusModel {
  status: TuiStatus;
  uptime: number; // in seconds
  cycleNo: number | string;
  repos: number | string;
  readiness: TuiReadiness;
  lastOk: string;
  nextText: string;
  opText: string;
  opTarget: string;
  opSub: string;
  cycleGlyph: string;
  cycleText: string;
  cycleMeta: string;
  hints: TuiHint[];
}

export interface RuntimeStatusListener {
  onStatusChange(status: Partial<RuntimeStatusModel>): void;
  onLog(level: "info" | "warn" | "error", message: string): void;
}

import type { RuntimeStatusTracker } from "./tracker.js";

export interface TuiView {
  render(model: RuntimeStatusModel, tracker: RuntimeStatusTracker, width: number, height: number, spinnerChar?: string): string[];
  handleKey?(key: any, str: string, triggerRender: () => void): boolean;
}
