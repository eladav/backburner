import * as path from "node:path";
import { readJsonFileIfExists, writeJsonFileAtomic } from "../../utils/json.js";
import type { WaveAssessmentSession } from "./session.js";

export class WaveAssessmentSessionStore {
  private readonly sessions = new Map<string, WaveAssessmentSession>();

  constructor(private readonly logDir?: string) {}

  async saveSession(session: WaveAssessmentSession): Promise<void> {
    this.sessions.set(session.sessionId, session);

    if (this.logDir) {
      await writeJsonFileAtomic(this.sessionFilePath(session.sessionId), session);
    }
  }

  async getSession(sessionId: string): Promise<WaveAssessmentSession | undefined> {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      return cached;
    }

    if (!this.logDir) {
      return undefined;
    }

    const persisted = await readJsonFileIfExists<WaveAssessmentSession>(
      this.sessionFilePath(sessionId)
    );
    if (persisted) {
      this.sessions.set(sessionId, persisted);
    }
    return persisted;
  }

  getSessionSync(sessionId: string): WaveAssessmentSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): WaveAssessmentSession[] {
    return Array.from(this.sessions.values());
  }

  private sessionFilePath(sessionId: string): string {
    if (!this.logDir) {
      throw new Error("Cannot resolve session file path without a log directory.");
    }
    assertSafeSessionId(sessionId);
    return path.join(this.logDir, "wave-assessment-sessions", `${sessionId}.json`);
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (
    sessionId.trim() === "" ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId === "." ||
    sessionId === ".."
  ) {
    throw new Error(`Invalid wave assessment session ID: ${sessionId}`);
  }
}
