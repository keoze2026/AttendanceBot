export interface ParsedMessage {
  type: 'login' | 'logout' | null;
  /** The time the staff member typed, normalized (e.g. "8:48 AM EST"), if any. */
  statedTime: string | null;
}

// Matches "8:48", "08:48 AM", "8:48 pm EST", "8:48AM", etc.
const TIME_RE = /\b(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?(?:\s*([a-z]{2,4}))?/i;

export function extractTime(text: string): string | null {
  const m = text.match(TIME_RE);
  if (!m) return null;
  const hour = m[1];
  const minute = m[2];
  const ampm = m[3] ? m[3].replace(/\./g, '').toUpperCase() : '';
  const tz = m[4] ? m[4].toUpperCase() : '';
  return `${hour}:${minute}${ampm ? ' ' + ampm : ''}${tz ? ' ' + tz : ''}`.trim();
}

/**
 * Classify a message. Case-insensitive; works whether the keyword sits on its
 * own line or inline (newlines are flattened to spaces before matching).
 */
export function parseMessage(
  text: string,
  loginKeywords: string[],
  logoutKeywords: string[],
): ParsedMessage {
  const normalized = text.replace(/\s+/g, ' ').toLowerCase().trim();

  const isLogin = loginKeywords.some((k) => normalized.includes(k));
  const isLogout = logoutKeywords.some((k) => normalized.includes(k));

  if (isLogout && !isLogin) return { type: 'logout', statedTime: extractTime(text) };
  if (isLogin) return { type: 'login', statedTime: extractTime(text) };
  return { type: null, statedTime: null };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if the message is a "back from break" signal (e.g. "I'm back", "back").
 * Matches each keyword as a whole word so "background" / "comeback" don't count.
 */
export function parseBack(text: string, backKeywords: string[]): boolean {
  const normalized = text.replace(/\s+/g, ' ').toLowerCase().trim();
  return backKeywords.some((k) => {
    const kw = k.trim();
    if (!kw) return false;
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(kw)}(?:[^a-z0-9]|$)`).test(normalized);
  });
}

export interface ParsedBreak {
  durationMin: number;
  urgent: boolean;
  raw: string;
}

/**
 * Parse a break message like "Taking 30", "taking urgent 15", "taking a 30 min break".
 * The duration is the first number that appears after the break keyword.
 */
export function parseBreak(
  text: string,
  breakKeywords: string[],
  urgentKeywords: string[],
): ParsedBreak | null {
  const normalized = text.replace(/\s+/g, ' ').toLowerCase().trim();

  // Locate the earliest break keyword.
  let idx = -1;
  for (const k of breakKeywords) {
    const i = normalized.indexOf(k);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return null;

  // The duration is the first integer after the keyword.
  const after = normalized.slice(idx);
  const m = after.match(/(\d{1,3})/);
  if (!m) return null;
  const durationMin = parseInt(m[1], 10);
  if (!Number.isFinite(durationMin) || durationMin <= 0) return null;

  const urgent = urgentKeywords.some((k) => after.includes(k));
  return { durationMin, urgent, raw: text.trim() };
}
