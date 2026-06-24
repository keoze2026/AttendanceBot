export interface BreakEntry {
  /** ISO timestamp the break message was sent. */
  at: string;
  /** Stated duration in minutes (the number in "Taking 30"). */
  durationMin: number;
  /** True if flagged as an urgent break ("taking urgent 30"). */
  urgent: boolean;
  /** Original message text. */
  raw: string;
  messageId: number;
  /** Id of the break group the message came from. */
  groupId: string;
  /**
   * ISO timestamp of the "I'm back" message that closed this break, or null
   * while the break is still open (the user hasn't returned yet).
   */
  returnedAt: string | null;
}

export interface AttendanceRecord {
  /** Telegram user id (stable, never changes). */
  userId: string;
  /** @handle without the @, or null if the user has no username. */
  username: string | null;
  /** First + last name (fallback display label). */
  displayName: string;
  /** Working-day date as YYYY-MM-DD, computed in the configured timezone. */
  date: string;

  /** ISO timestamp the login message was sent. */
  loginAt: string | null;
  /** The time as typed by the staff member, e.g. "8:48 AM EST". */
  loginStated: string | null;
  loginMessageId: number | null;

  /** ISO timestamp the logout ("Goodnight") message was sent. */
  logoutAt: string | null;
  logoutStated: string | null;
  logoutMessageId: number | null;

  /** All breaks taken this day (from the break groups). */
  breaks: BreakEntry[];

  /** ISO timestamp this record was last touched. */
  updatedAt: string;
}

export interface BotState {
  /** Timestamp of the most recently processed message (diagnostics only). */
  lastProcessedAt: string | null;
}

export interface UpsertInput {
  userId: string;
  username: string | null;
  displayName: string;
  date: string;
  at: string; // ISO
  stated: string | null;
  messageId: number;
}

export interface BreakInput {
  userId: string;
  username: string | null;
  displayName: string;
  date: string;
  at: string; // ISO
  durationMin: number;
  urgent: boolean;
  raw: string;
  messageId: number;
  groupId: string;
}

/** A "back from break" message: closes the user's currently open break. */
export interface BackInput {
  userId: string;
  username: string | null;
  displayName: string;
  date: string;
  at: string; // ISO of the "I'm back" message
}

/** Result of trying to close an open break with an "I'm back" message. */
export interface EndBreakResult {
  /** The day record, or null if the user had no record for the day. */
  record: AttendanceRecord | null;
  /** The break that was closed, or null if there was no open break to close. */
  closed: BreakEntry | null;
}

/**
 * Storage seam. Every backend (JSON file for local testing, PostgreSQL for
 * production) implements this — nothing else in the bot touches storage.
 */
export interface AttendanceStore {
  load(): Promise<void>;
  getState(): BotState;
  setLastProcessed(at: string): Promise<void>;
  upsertLogin(p: UpsertInput): Promise<void>;
  upsertLogout(p: UpsertInput): Promise<void>;
  addBreak(p: BreakInput): Promise<AttendanceRecord>;
  /** Close the user's most recent open break ("I'm back"). */
  endBreak(p: BackInput): Promise<EndBreakResult>;
  all(): Promise<AttendanceRecord[]>;
  saveStore(): Promise<void>;
  saveState(): Promise<void>;
  close(): Promise<void>;
}
