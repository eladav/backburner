import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PlanBreakdownSession } from "./types.js";

export class PlanBreakdownSessionStore {
  private readonly sessions = new Map<string, PlanBreakdownSession>();

  constructor(private readonly logDir?: string) {}

  async saveSession(session: PlanBreakdownSession): Promise<void> {
    this.sessions.set(session.id, session);

    if (this.logDir) {
      const sessionsDir = path.join(this.logDir, "plan-breakdown-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const filePath = path.join(sessionsDir, `${session.id}.json`);
      await fs.writeFile(filePath, JSON.stringify(session, null, 2), "utf8");
    }
  }

  async getSession(id: string): Promise<PlanBreakdownSession | undefined> {
    return this.sessions.get(id);
  }

  getSessionSync(id: string): PlanBreakdownSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): PlanBreakdownSession[] {
    return Array.from(this.sessions.values());
  }
}
