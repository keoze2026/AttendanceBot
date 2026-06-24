import 'dotenv/config';
import { setLevel } from './logger';

export interface Config {
  botToken: string;
  /** Main login/logout group id (required). */
  mainGroup: string;
  /** Break group ids (0, 1, or more). */
  breakGroups: string[];
  recordFromDate: string;
  timezone: string;
  loginKeywords: string[];
  logoutKeywords: string[];
  breakKeywords: string[];
  breakUrgentKeywords: string[];
  /** Phrases that mean a user has returned from a break ("I'm back", "back"). */
  backKeywords: string[];
  /** Total break minutes allowed per day. */
  breakAllowanceMin: number;
  /**
   * Grace minutes for returning late from a break. A break is only flagged as
   * over its stated duration once the actual time away exceeds stated + grace.
   */
  breakGraceMin: number;
  /** Whether urgent breaks count toward the allowance. */
  urgentCountsTowardAllowance: boolean;
  dataDir: string;
  excelPath: string;
  storeFile: string;
  stateFile: string;
  excelDebounceMs: number;
  logLevel: string;
  /** Where attendance is persisted: 'postgres' (production) or 'json' (local testing). */
  storageDriver: 'postgres' | 'json';
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    ssl: boolean;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function keywords(name: string, fallback: string): string[] {
  return optional(name, fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function idList(name: string): string[] {
  return optional(name, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name: string, fallback: boolean): boolean {
  const v = optional(name, fallback ? 'true' : 'false').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export function loadConfig(): Config {
  const logLevel = optional('LOG_LEVEL', 'info');
  setLevel(logLevel);

  const dataDir = optional('DATA_DIR', './data');

  const config: Config = {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    mainGroup: required('TELEGRAM_GROUP'),
    breakGroups: idList('TELEGRAM_BREAK_GROUPS'),
    recordFromDate: optional('RECORD_FROM_DATE', '2026-06-01'),
    timezone: optional('TIMEZONE', 'America/New_York'),
    loginKeywords: keywords('LOGIN_KEYWORDS', 'logged in'),
    logoutKeywords: keywords('LOGOUT_KEYWORDS', 'goodnight,good night'),
    breakKeywords: keywords('BREAK_KEYWORDS', 'taking'),
    breakUrgentKeywords: keywords('BREAK_URGENT_KEYWORDS', 'urgent'),
    backKeywords: keywords('BACK_KEYWORDS', "i'm back,im back,i am back,back,im online,back online"),
    breakAllowanceMin: Number(optional('DAILY_BREAK_ALLOWANCE_MIN', '60')),
    breakGraceMin: Number(optional('BREAK_GRACE_MIN', '10')),
    urgentCountsTowardAllowance: bool('URGENT_COUNTS_TOWARD_ALLOWANCE', true),
    dataDir,
    excelPath: optional('EXCEL_PATH', `${dataDir}/attendance.xlsx`),
    storeFile: optional('STORE_FILE', `${dataDir}/attendance.json`),
    stateFile: optional('STATE_FILE', `${dataDir}/state.json`),
    excelDebounceMs: Number(optional('EXCEL_DEBOUNCE_MS', '4000')),
    logLevel,
    storageDriver: optional('STORAGE_DRIVER', 'postgres').toLowerCase() === 'json' ? 'json' : 'postgres',
    db: {
      host: optional('DB_HOST', 'localhost'),
      port: Number(optional('DB_PORT', '5432')),
      name: optional('DB_NAME', 'crm'),
      user: optional('DB_USER', 'crm_user'),
      password: optional('DB_PASSWORD', ''),
      ssl: bool('DB_SSL', false),
    },
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.recordFromDate)) {
    throw new Error('RECORD_FROM_DATE must be in YYYY-MM-DD format.');
  }
  if (config.loginKeywords.length === 0) {
    throw new Error('LOGIN_KEYWORDS must contain at least one phrase.');
  }
  if (config.logoutKeywords.length === 0) {
    throw new Error('LOGOUT_KEYWORDS must contain at least one phrase.');
  }
  if (config.breakKeywords.length === 0) {
    throw new Error('BREAK_KEYWORDS must contain at least one phrase.');
  }
  if (config.backKeywords.length === 0) {
    throw new Error('BACK_KEYWORDS must contain at least one phrase.');
  }
  if (!Number.isFinite(config.breakAllowanceMin) || config.breakAllowanceMin <= 0) {
    throw new Error('DAILY_BREAK_ALLOWANCE_MIN must be a positive number.');
  }
  if (!Number.isFinite(config.breakGraceMin) || config.breakGraceMin < 0) {
    throw new Error('BREAK_GRACE_MIN must be zero or a positive number.');
  }

  return config;
}
