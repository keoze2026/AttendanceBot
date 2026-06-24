import { BreakEntry } from './types';

/**
 * Actual minutes a break lasted ("I'm back" time − break-start time), or null
 * if the user hasn't returned yet (break still open).
 */
export function breakActualMin(b: BreakEntry): number | null {
  if (!b.returnedAt) return null;
  const ms = new Date(b.returnedAt).getTime() - new Date(b.at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60_000);
}

/**
 * Minutes a break ran over its stated duration, beyond the grace period. The
 * user is allowed `stated + graceMin` before counting as late, so returning
 * within `graceMin` of the expected time is never flagged. Returns 0 if the
 * user is still on break, returned on time, or is within grace.
 *
 * e.g. stated 30, grace 10: back at 38m → 0; back at 60m → 20.
 */
export function breakOverStatedMin(b: BreakEntry, graceMin: number): number {
  const actual = breakActualMin(b);
  if (actual == null) return 0;
  return Math.max(0, actual - b.durationMin - graceMin);
}

export interface BreakEvaluation {
  /** Sum of all break minutes (including urgent). */
  totalMin: number;
  /** Minutes that count toward the allowance. */
  countedMin: number;
  allowanceMin: number;
  /** Minutes over the allowance (0 if within). */
  overMin: number;
  /** True if over the allowance. */
  exceeded: boolean;
  /** Total minutes late returning from breaks, past the stated duration + grace. */
  overStatedMin: number;
  /** How many breaks ran past their stated duration + grace. */
  overStatedCount: number;
  /** True if any break ran late past the grace period. */
  anyOverStated: boolean;
  /** Human-readable status, e.g. "OK" or "OVER by 15m". */
  status: string;
  /** Compact list, e.g. "30, urgent 15, 15". */
  detail: string;
}

/**
 * Evaluate a day's breaks against the total allowance.
 *
 * @param allowanceMin total minutes allowed per day.
 * @param urgentCounts whether urgent breaks count toward the allowance.
 */
export function evaluateBreaks(
  breaks: BreakEntry[],
  allowanceMin: number,
  urgentCounts: boolean,
  graceMin: number,
): BreakEvaluation {
  const counted = urgentCounts ? breaks : breaks.filter((b) => !b.urgent);

  const totalMin = breaks.reduce((s, b) => s + b.durationMin, 0);
  const countedMin = counted.reduce((s, b) => s + b.durationMin, 0);
  const overMin = Math.max(0, countedMin - allowanceMin);
  const exceeded = overMin > 0;

  const overStatedMin = breaks.reduce((s, b) => s + breakOverStatedMin(b, graceMin), 0);
  const overStatedCount = breaks.filter((b) => breakOverStatedMin(b, graceMin) > 0).length;
  const anyOverStated = overStatedCount > 0;

  const allowanceStatus = exceeded ? `OVER by ${overMin}m` : 'OK';
  const status = anyOverStated
    ? `${allowanceStatus}; +${overStatedMin}m late (past ${graceMin}m grace)`
    : allowanceStatus;
  // e.g. "30 (→60, +20)" — stated, then actual and late-past-grace when the user is back.
  const detail = breaks
    .map((b) => {
      const actual = breakActualMin(b);
      const over = breakOverStatedMin(b, graceMin);
      const tag = `${b.urgent ? 'urgent ' : ''}${b.durationMin}`;
      return actual == null ? tag : `${tag} (→${actual}${over > 0 ? `, +${over}` : ''})`;
    })
    .join(', ');

  return {
    totalMin,
    countedMin,
    allowanceMin,
    overMin,
    exceeded,
    overStatedMin,
    overStatedCount,
    anyOverStated,
    status,
    detail,
  };
}
