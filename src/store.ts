import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AttendanceRecord,
  AttendanceStore,
  BackInput,
  BotState,
  BreakEntry,
  BreakInput,
  EndBreakResult,
  UpsertInput,
} from './types';

function key(userId: string, date: string): string {
  return `${userId}|${date}`;
}

/**
 * JSON-file attendance store. Handy for local testing without a database.
 * The production backend is PgStore (PostgreSQL) — see storage.ts.
 */
export class JsonStore implements AttendanceStore {
  private records = new Map<string, AttendanceRecord>();
  private state: BotState = { lastProcessedAt: null };

  constructor(private readonly storeFile: string, private readonly stateFile: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storeFile, 'utf8');
      const arr = JSON.parse(raw) as AttendanceRecord[];
      this.records = new Map(
        arr.map((r) => [
          key(r.userId, r.date),
          { ...r, breaks: (r.breaks ?? []).map((b) => ({ ...b, returnedAt: b.returnedAt ?? null })) },
        ]),
      );
    } catch {
      this.records = new Map();
    }
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      this.state = { ...this.state, ...(JSON.parse(raw) as Partial<BotState>) };
    } catch {
      /* keep defaults */
    }
  }

  getState(): BotState {
    return this.state;
  }

  async setLastProcessed(at: string): Promise<void> {
    this.state.lastProcessedAt = at;
  }

  async upsertLogin(p: UpsertInput): Promise<void> {
    const k = key(p.userId, p.date);
    const now = new Date().toISOString();
    const existing = this.records.get(k);
    if (existing) {
      // Keep the earliest login of the day.
      if (!existing.loginAt || p.at < existing.loginAt) {
        existing.loginAt = p.at;
        existing.loginStated = p.stated;
        existing.loginMessageId = p.messageId;
      }
      if (p.username) existing.username = p.username;
      if (p.displayName) existing.displayName = p.displayName;
      existing.updatedAt = now;
    } else {
      this.records.set(k, {
        userId: p.userId,
        username: p.username,
        displayName: p.displayName,
        date: p.date,
        loginAt: p.at,
        loginStated: p.stated,
        loginMessageId: p.messageId,
        logoutAt: null,
        logoutStated: null,
        logoutMessageId: null,
        breaks: [],
        updatedAt: now,
      });
    }
  }

  async upsertLogout(p: UpsertInput): Promise<void> {
    const k = key(p.userId, p.date);
    const now = new Date().toISOString();
    const existing = this.records.get(k);
    if (existing) {
      // Keep the latest logout of the day.
      if (!existing.logoutAt || p.at > existing.logoutAt) {
        existing.logoutAt = p.at;
        existing.logoutStated = p.stated;
        existing.logoutMessageId = p.messageId;
      }
      if (p.username) existing.username = p.username;
      if (p.displayName) existing.displayName = p.displayName;
      existing.updatedAt = now;
    } else {
      this.records.set(k, {
        userId: p.userId,
        username: p.username,
        displayName: p.displayName,
        date: p.date,
        loginAt: null,
        loginStated: null,
        loginMessageId: null,
        logoutAt: p.at,
        logoutStated: p.stated,
        logoutMessageId: p.messageId,
        breaks: [],
        updatedAt: now,
      });
    }
  }

  async addBreak(p: BreakInput): Promise<AttendanceRecord> {
    const k = key(p.userId, p.date);
    const now = new Date().toISOString();
    let rec = this.records.get(k);
    if (!rec) {
      rec = {
        userId: p.userId,
        username: p.username,
        displayName: p.displayName,
        date: p.date,
        loginAt: null,
        loginStated: null,
        loginMessageId: null,
        logoutAt: null,
        logoutStated: null,
        logoutMessageId: null,
        breaks: [],
        updatedAt: now,
      };
      this.records.set(k, rec);
    }

    // De-dupe by (groupId, messageId) so replays/edits don't double-count.
    const dup = rec.breaks.find((b) => b.messageId === p.messageId && b.groupId === p.groupId);
    if (dup) {
      dup.durationMin = p.durationMin;
      dup.urgent = p.urgent;
      dup.raw = p.raw;
      dup.at = p.at;
    } else {
      rec.breaks.push({
        at: p.at,
        durationMin: p.durationMin,
        urgent: p.urgent,
        raw: p.raw,
        messageId: p.messageId,
        groupId: p.groupId,
        returnedAt: null,
      });
    }
    rec.breaks.sort((a, b) => a.at.localeCompare(b.at));
    if (p.username) rec.username = p.username;
    if (p.displayName) rec.displayName = p.displayName;
    rec.updatedAt = now;
    return rec;
  }

  async endBreak(p: BackInput): Promise<EndBreakResult> {
    const rec = this.records.get(key(p.userId, p.date));
    if (!rec) return { record: null, closed: null };

    // Close the most recently started break that is still open (the one the
    // user is currently on).
    let open: BreakEntry | null = null;
    for (const b of rec.breaks) {
      if (!b.returnedAt && (open === null || b.at > open.at)) open = b;
    }
    if (!open) return { record: rec, closed: null };

    open.returnedAt = p.at;
    if (p.username) rec.username = p.username;
    if (p.displayName) rec.displayName = p.displayName;
    rec.updatedAt = new Date().toISOString();
    return { record: rec, closed: open };
  }

  async all(): Promise<AttendanceRecord[]> {
    return [...this.records.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.displayName.localeCompare(b.displayName),
    );
  }

  async saveStore(): Promise<void> {
    await fs.mkdir(path.dirname(this.storeFile), { recursive: true });
    const records = await this.all();
    await fs.writeFile(this.storeFile, JSON.stringify(records, null, 2), 'utf8');
  }

  async saveState(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}
