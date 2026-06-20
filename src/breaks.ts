import { BreakEntry } from './types';

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
): BreakEvaluation {
  const counted = urgentCounts ? breaks : breaks.filter((b) => !b.urgent);

  const totalMin = breaks.reduce((s, b) => s + b.durationMin, 0);
  const countedMin = counted.reduce((s, b) => s + b.durationMin, 0);
  const overMin = Math.max(0, countedMin - allowanceMin);
  const exceeded = overMin > 0;

  const status = exceeded ? `OVER by ${overMin}m` : 'OK';
  const detail = breaks.map((b) => `${b.urgent ? 'urgent ' : ''}${b.durationMin}`).join(', ');

  return { totalMin, countedMin, allowanceMin, overMin, exceeded, status, detail };
}
