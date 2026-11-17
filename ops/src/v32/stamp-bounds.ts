// The stack's bounds (plan Task 48; the controller's ruling on its review, I1), in a module of their own with no imports,
// so `parseArgs` checks `--stack` and `--every` before anything is read, and every command but `stamp` still loads no
// v3.2 module. v32/stamp.ts holds the same bounds for its own callers.

/** The stamps' spacing by default, in hours (R1-A I-1: 12 hours or less). With stamps a day apart, an item a thief
 * schedules just after one stamp is killed in time only by the next: if that one is missed, the stamp after it becomes
 * valid only about when the item is ready, a race. */
export const STAMP_SPACING_HOURS = 12;
/** The longest stack, in days: each signed stamp kills the founder's own items scheduled up to its time too. */
export const MAX_STACK_DAYS = 30;
/** The spacings `--every` takes without an override: the divisors of 24 up to STAMP_SPACING_HOURS. */
export const EVERY_HOURS: readonly number[] = [1, 2, 3, 4, 6, 8, 12];
/** The one wider spacing, taken only with `--accept-gap-risk "<why>"`. */
export const WIDE_EVERY_HOURS = 24;
/** What a spacing above STAMP_SPACING_HOURS risks, in the founder's words. */
export const GAP_RISK = `stamps more than ${STAMP_SPACING_HOURS} hours apart can leave a thief's item a race against its last stamp`;

/** Why a stack of `days` days, a stamp every `everyHours` hours, is refused, or null. A spacing above
 * STAMP_SPACING_HOURS needs `acceptGapRisk`, a reason, which the run then prints with the risk. */
export function stackBoundsProblem(days: number, everyHours: number, acceptGapRisk?: string): string | null {
  if (!Number.isInteger(days) || days < 1 || days > MAX_STACK_DAYS) return `--stack takes 1 to ${MAX_STACK_DAYS} days, not ${days}`;
  if (EVERY_HOURS.includes(everyHours)) {
    return acceptGapRisk === undefined ? null : `--accept-gap-risk is only for --every above ${STAMP_SPACING_HOURS} hours: --every ${everyHours} has no gap to accept`;
  }
  if (everyHours === WIDE_EVERY_HOURS) {
    return acceptGapRisk?.trim() ? null : `--every ${everyHours} is more than ${STAMP_SPACING_HOURS} hours: ${GAP_RISK}. To accept that, add --accept-gap-risk "<why>"`;
  }
  return `--every takes ${EVERY_HOURS.slice(0, -1).join(", ")} or ${EVERY_HOURS.at(-1)} hours (${WIDE_EVERY_HOURS} only with --accept-gap-risk), not ${everyHours}`;
}

/** The line a run prints when a spacing above STAMP_SPACING_HOURS was accepted. */
export const gapRiskLine = (everyHours: number, reason: string) => `  WARNING — a stamp every ${everyHours} hours: ${GAP_RISK}. Accepted: ${reason.trim()}.`;
