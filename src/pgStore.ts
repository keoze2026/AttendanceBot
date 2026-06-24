import { Pool } from 'pg';
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
import { createPool } from './db';
import { Config } from './config';

// Selects one fully-assembled attendance record (day row + its breaks as JSON).
// work_date is cast to text to avoid node-postgres shifting the DATE by timezone.
const SELECT_RECORD = `
  SELECT d.user_id,
         d.username,
         d.staff_name AS display_name,
         d.work_date::text AS work_date,
         d.login_at,
         d.login_stated,
         d.login_message_id,
         d.logout_at,
         d.logout_stated,
         d.logout_message_id,
         d.updated_at,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'at', to_char(b.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                    'durationMin', b.duration_min,
                    'urgent', b.urgent,
                    'raw', b.raw,
                    'messageId', b.message_id,
                    'groupId', b.group_id,
                    'returnedAt', to_char(b.returned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                  ) ORDER BY b.taken_at)
           FROM attendance_breaks b
           WHERE b.user_id = d.user_id AND b.work_date = d.work_date
         ), '[]'::json) AS breaks
  FROM attendance_days d
`;

function toIso(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null;
}

function toNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapRow(row: any): AttendanceRecord {
  const breaks: BreakEntry[] = (row.breaks ?? []).map((b: any) => ({
    at: b.at,
    durationMin: Number(b.durationMin),
    urgent: !!b.urgent,
    raw: b.raw ?? '',
    messageId: Number(b.messageId),
    groupId: String(b.groupId ?? ''),
    returnedAt: b.returnedAt ?? null,
  }));
  return {
    userId: String(row.user_id),
    username: row.username ?? null,
    displayName: row.display_name ?? '',
    date: row.work_date,
    loginAt: toIso(row.login_at),
    loginStated: row.login_stated ?? null,
    loginMessageId: toNum(row.login_message_id),
    logoutAt: toIso(row.logout_at),
    logoutStated: row.logout_stated ?? null,
    logoutMessageId: toNum(row.logout_message_id),
    breaks,
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

/**
 * PostgreSQL attendance store — the production backend. Tables are created by
 * migrations/003_add_attendance_tables.sql and are NOT touched by the CRM's
 * 40-day cleanup job, so attendance history is retained long-term.
 */
export class PgStore implements AttendanceStore {
  private pool: Pool;
  private state: BotState = { lastProcessedAt: null };

  constructor(config: Config) {
    this.pool = createPool(config);
  }

  async load(): Promise<void> {
    // Fail fast with a clear message if the migration hasn't been applied.
    const check = await this.pool.query(`SELECT to_regclass('public.attendance_days') AS t`);
    if (!check.rows[0] || check.rows[0].t === null) {
      throw new Error(
        'Attendance tables not found. Apply migrations/003_add_attendance_tables.sql to the database first.',
      );
    }
    const r = await this.pool.query(`SELECT last_processed_at FROM attendance_state WHERE id = 1`);
    this.state.lastProcessedAt = r.rows[0]?.last_processed_at
      ? new Date(r.rows[0].last_processed_at).toISOString()
      : null;
  }

  getState(): BotState {
    return this.state;
  }

  async setLastProcessed(at: string): Promise<void> {
    this.state.lastProcessedAt = at;
  }

  private async upsertStaff(userId: string, username: string | null, displayName: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO attendance_staff (user_id, username, staff_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, attendance_staff.username),
         staff_name = COALESCE(NULLIF(EXCLUDED.staff_name, ''), attendance_staff.staff_name),
         last_seen = now()`,
      [userId, username, displayName],
    );
  }

  async upsertLogin(p: UpsertInput): Promise<void> {
    await this.upsertStaff(p.userId, p.username, p.displayName);
    await this.pool.query(
      `INSERT INTO attendance_days
         (user_id, work_date, username, staff_name, login_at, login_stated, login_message_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id, work_date) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, attendance_days.username),
         staff_name = COALESCE(NULLIF(EXCLUDED.staff_name, ''), attendance_days.staff_name),
         login_at = CASE WHEN attendance_days.login_at IS NULL OR EXCLUDED.login_at < attendance_days.login_at
                         THEN EXCLUDED.login_at ELSE attendance_days.login_at END,
         login_stated = CASE WHEN attendance_days.login_at IS NULL OR EXCLUDED.login_at < attendance_days.login_at
                             THEN EXCLUDED.login_stated ELSE attendance_days.login_stated END,
         login_message_id = CASE WHEN attendance_days.login_at IS NULL OR EXCLUDED.login_at < attendance_days.login_at
                                 THEN EXCLUDED.login_message_id ELSE attendance_days.login_message_id END,
         updated_at = now()`,
      [p.userId, p.date, p.username, p.displayName, p.at, p.stated, p.messageId],
    );
  }

  async upsertLogout(p: UpsertInput): Promise<void> {
    await this.upsertStaff(p.userId, p.username, p.displayName);
    await this.pool.query(
      `INSERT INTO attendance_days
         (user_id, work_date, username, staff_name, logout_at, logout_stated, logout_message_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id, work_date) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, attendance_days.username),
         staff_name = COALESCE(NULLIF(EXCLUDED.staff_name, ''), attendance_days.staff_name),
         logout_at = CASE WHEN attendance_days.logout_at IS NULL OR EXCLUDED.logout_at > attendance_days.logout_at
                          THEN EXCLUDED.logout_at ELSE attendance_days.logout_at END,
         logout_stated = CASE WHEN attendance_days.logout_at IS NULL OR EXCLUDED.logout_at > attendance_days.logout_at
                              THEN EXCLUDED.logout_stated ELSE attendance_days.logout_stated END,
         logout_message_id = CASE WHEN attendance_days.logout_at IS NULL OR EXCLUDED.logout_at > attendance_days.logout_at
                                  THEN EXCLUDED.logout_message_id ELSE attendance_days.logout_message_id END,
         updated_at = now()`,
      [p.userId, p.date, p.username, p.displayName, p.at, p.stated, p.messageId],
    );
  }

  async addBreak(p: BreakInput): Promise<AttendanceRecord> {
    await this.upsertStaff(p.userId, p.username, p.displayName);
    // Ensure a day row exists (a break may arrive before any login).
    await this.pool.query(
      `INSERT INTO attendance_days (user_id, work_date, username, staff_name, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, work_date) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, attendance_days.username),
         staff_name = COALESCE(NULLIF(EXCLUDED.staff_name, ''), attendance_days.staff_name),
         updated_at = now()`,
      [p.userId, p.date, p.username, p.displayName],
    );
    await this.pool.query(
      `INSERT INTO attendance_breaks
         (user_id, work_date, staff_name, taken_at, duration_min, urgent, raw, group_id, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (group_id, message_id) DO UPDATE SET
         staff_name = COALESCE(NULLIF(EXCLUDED.staff_name, ''), attendance_breaks.staff_name),
         duration_min = EXCLUDED.duration_min,
         urgent = EXCLUDED.urgent,
         raw = EXCLUDED.raw,
         taken_at = EXCLUDED.taken_at,
         work_date = EXCLUDED.work_date`,
      [p.userId, p.date, p.displayName, p.at, p.durationMin, p.urgent, p.raw, p.groupId, p.messageId],
    );
    const { rows } = await this.pool.query(
      `${SELECT_RECORD} WHERE d.user_id = $1 AND d.work_date = $2`,
      [p.userId, p.date],
    );
    return mapRow(rows[0]);
  }

  async endBreak(p: BackInput): Promise<EndBreakResult> {
    await this.upsertStaff(p.userId, p.username, p.displayName);
    // Close the most recently started break that is still open.
    const { rowCount } = await this.pool.query(
      `UPDATE attendance_breaks
          SET returned_at = $3
        WHERE id = (
          SELECT id FROM attendance_breaks
           WHERE user_id = $1 AND work_date = $2 AND returned_at IS NULL
           ORDER BY taken_at DESC
           LIMIT 1
        )`,
      [p.userId, p.date, p.at],
    );

    const { rows } = await this.pool.query(
      `${SELECT_RECORD} WHERE d.user_id = $1 AND d.work_date = $2`,
      [p.userId, p.date],
    );
    const record = rows[0] ? mapRow(rows[0]) : null;
    if (!rowCount || !record) return { record, closed: null };

    // The break we just closed is the open one with the latest taken_at.
    const closed = record.breaks
      .filter((b) => b.returnedAt === p.at)
      .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
    return { record, closed };
  }

  async all(): Promise<AttendanceRecord[]> {
    const { rows } = await this.pool.query(`${SELECT_RECORD} ORDER BY d.work_date, d.staff_name`);
    return rows.map(mapRow);
  }

  async saveStore(): Promise<void> {
    /* writes happen per-operation; nothing to flush */
  }

  async saveState(): Promise<void> {
    await this.pool.query(
      `INSERT INTO attendance_state (id, last_processed_at) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET last_processed_at = EXCLUDED.last_processed_at`,
      [this.state.lastProcessedAt],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
