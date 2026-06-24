import { AttendanceStore } from './types';
import { parseMessage, parseBreak, parseBack } from './parser';
import { dateKeyInTz, timeInTz } from './time';
import { evaluateBreaks, breakActualMin, breakOverStatedMin } from './breaks';
import { log } from './logger';
import { Config } from './config';

/** A normalized message, decoupled from grammy's types. */
export interface IncomingMessage {
  messageId: number;
  text: string;
  dateUnix: number;
  chatId: string;
  from:
    | {
        id: number | string;
        username?: string;
        firstName?: string;
        lastName?: string;
      }
    | undefined;
}

interface Sender {
  userId: string;
  username: string | null;
  displayName: string;
}

function senderOf(msg: IncomingMessage): Sender | null {
  if (!msg.from) return null;
  const userId = String(msg.from.id);
  const username = msg.from.username ?? null;
  const displayName =
    [msg.from.firstName, msg.from.lastName].filter(Boolean).join(' ') ||
    (username ? '@' + username : userId);
  return { userId, username, displayName };
}

/**
 * Main-group message: record a login or logout.
 * Returns true if an attendance record was created or updated.
 */
export async function handleAttendanceMessage(
  msg: IncomingMessage,
  store: AttendanceStore,
  config: Config,
): Promise<boolean> {
  const text = msg.text?.trim();
  if (!text) return false;

  const parsed = parseMessage(text, config.loginKeywords, config.logoutKeywords);
  if (!parsed.type) return false;

  const user = senderOf(msg);
  if (!user) return false;

  const when = new Date(msg.dateUnix * 1000);
  const date = dateKeyInTz(when, config.timezone);
  if (date < config.recordFromDate) return false;

  const at = when.toISOString();
  const shownTime = parsed.statedTime ?? timeInTz(when, config.timezone);
  const who = user.username ? `${user.displayName} (@${user.username})` : user.displayName;

  if (parsed.type === 'login') {
    await store.upsertLogin({ ...user, date, at, stated: parsed.statedTime, messageId: msg.messageId });
    log.info(`LOGIN   ${who} | ${date} | ${shownTime}`);
  } else {
    await store.upsertLogout({ ...user, date, at, stated: parsed.statedTime, messageId: msg.messageId });
    log.info(`LOGOUT  ${who} | ${date} | ${shownTime}`);
  }
  return true;
}

/**
 * Break-group message: record a break and tally it against the allowance.
 * Returns true if a break was recorded.
 */
export async function handleBreakMessage(
  msg: IncomingMessage,
  store: AttendanceStore,
  config: Config,
): Promise<boolean> {
  const text = msg.text?.trim();
  if (!text) return false;

  const user = senderOf(msg);
  if (!user) return false;

  const when = new Date(msg.dateUnix * 1000);
  const date = dateKeyInTz(when, config.timezone);
  if (date < config.recordFromDate) return false;

  // "I'm back" / "back" closes the user's currently open break. Check this
  // before the break keyword so a return message is never read as a new break.
  if (parseBack(text, config.backKeywords)) {
    return handleBackMessage(msg, store, config, user, when, date);
  }

  const parsed = parseBreak(text, config.breakKeywords, config.breakUrgentKeywords);
  if (!parsed) return false;

  const rec = await store.addBreak({
    ...user,
    date,
    at: when.toISOString(),
    durationMin: parsed.durationMin,
    urgent: parsed.urgent,
    raw: parsed.raw,
    messageId: msg.messageId,
    groupId: msg.chatId,
  });

  const evaluation = evaluateBreaks(
    rec.breaks,
    config.breakAllowanceMin,
    config.urgentCountsTowardAllowance,
    config.breakGraceMin,
  );
  const who = user.username ? `${user.displayName} (@${user.username})` : user.displayName;
  log.info(
    `BREAK   ${who} | ${date} | ${parsed.urgent ? 'urgent ' : ''}${parsed.durationMin}m | ` +
      `day total ${evaluation.countedMin}/${evaluation.allowanceMin}m` +
      (evaluation.exceeded ? `  ⚠ ${evaluation.status}` : ''),
  );
  return true;
}

/**
 * Break-group "I'm back" message: close the user's open break, compute how long
 * it actually ran, and flag it if it overran the stated duration.
 * Returns true if an open break was closed.
 */
async function handleBackMessage(
  msg: IncomingMessage,
  store: AttendanceStore,
  config: Config,
  user: Sender,
  when: Date,
  date: string,
): Promise<boolean> {
  const who = user.username ? `${user.displayName} (@${user.username})` : user.displayName;

  const { closed } = await store.endBreak({
    ...user,
    date,
    at: when.toISOString(),
  });

  if (!closed) {
    // A "back" with no break to close (already returned, or never said "taking").
    log.debug(`BACK    ${who} | ${date} | no open break to close — ignored`);
    return false;
  }

  const actualMin = breakActualMin(closed) ?? 0;
  const overMin = breakOverStatedMin(closed, config.breakGraceMin);
  const flag =
    overMin > 0
      ? `  ⚠ LATE by ${overMin}m past the ${config.breakGraceMin}m grace ` +
        `(stated ${closed.durationMin}m, actual ${actualMin}m)`
      : '';
  log.info(
    `BACK    ${who} | ${date} | stated ${closed.durationMin}m, actual ${actualMin}m${flag}`,
  );
  return true;
}
