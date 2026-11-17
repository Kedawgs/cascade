import { formatUnits, type Hex } from "viem";
import type { ChainName } from "./config.ts";
import type { ChainReading, HourAgg } from "./snapshot.ts";

// The keeper's spend on each chain, for the daily digest's Gas section: what its balance fell by between consecutive
// readings, summed (its gas, and the fees its sends carry). A difference of two balances can't span a top-up; a sum of
// falls can: every fall counts, a rise is a top-up and counts as no spend.
//
// Where it is kept, with no table or column of its own:
// - meta keeper_spend:<chain>, the running total since its first reading (the readings table keeps two hours, the hours
//   table 35 days, so neither can be summed back to the start). Each tick steps it with its own reading, in the commit it
//   already makes, and writes it only when the balance moved;
// - each hour row's keeperEthSpent / keeperTaoSpent (and keeperEthAdded / keeperTaoAdded), the hour's falls and rises,
//   for the digest's 24-hour and 7-day windows.
// The readings are the latest block's, not settled ones: a keeper transaction a reorg removes and re-mines reads as a
// fall, a rise and a fall again. Base's reorgs are rare and shallow, and Bittensor's blocks final in seconds.

/** The meta key of a chain's running total. */
export const spendKey = (chain: ChainName): string => `keeper_spend:${chain}`;

/** A chain's running total. */
export interface SpendTotal {
  /** the time (its block's) of the first balance reading it counts from */
  since: number;
  /** every fall between consecutive readings since then, in wei */
  spent: bigint;
  /** the last balance read, which the next reading is compared with, and the keeper it was read for */
  last: bigint;
  keeper: Hex;
}

export interface BalanceReading {
  time: number;
  balance: bigint;
}

export const formatSpend = (t: SpendTotal): string => JSON.stringify({ since: t.since, spent: String(t.spent), last: String(t.last), keeper: t.keeper });

/** The total as stored; undefined for none, or one that doesn't read (the count then starts again, from the next
 * reading, and the digest's "since" says so). */
export function parseSpend(v: string | undefined): SpendTotal | undefined {
  if (!v) return undefined;
  try {
    const o = JSON.parse(v) as Record<string, unknown> | null;
    const amount = (x: unknown) => (typeof x === "string" && /^\d{1,78}$/.test(x) ? BigInt(x) : undefined);
    const [spent, last] = [amount(o?.spent), amount(o?.last)];
    if (!o || typeof o.since !== "number" || !Number.isFinite(o.since) || spent === undefined || last === undefined || typeof o.keeper !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.keeper)) return undefined;
    return { since: o.since, spent, last, keeper: o.keeper.toLowerCase() as Hex };
  } catch {
    return undefined;
  }
}

/** The total stepped through `readings` (oldest first: this tick's, after the stored ones in hand on its first run), all
 * of `keeper`'s balance, and what they added: `tick`, the falls and rises counted, absent when there was none to count.
 * With no total the first reading is where it starts, nothing to sum yet. A reading of another keeper than the total's
 * last (a setKeeper) is never compared with it: neither a spend nor a top-up, the count going on from the new one's. */
export function spendStep(total: SpendTotal | undefined, keeper: Hex, readings: readonly BalanceReading[]): { total: SpendTotal | undefined; tick?: { spent: bigint; added: bigint } } {
  if (readings.length === 0) return { total };
  const [first, ...rest] = readings;
  const fresh = total === undefined || total.keeper !== keeper;
  const out: SpendTotal = total === undefined ? { since: first.time, spent: 0n, last: first.balance, keeper } : fresh ? { ...total, last: first.balance, keeper } : { ...total };
  const tick = { spent: 0n, added: 0n };
  for (const r of fresh ? rest : readings) {
    if (r.balance < out.last) tick.spent += out.last - r.balance;
    else tick.added += r.balance - out.last;
    out.last = r.balance;
  }
  out.spent += tick.spent;
  return { total: out, tick };
}

/** The stored readings in hand (newest first, as the tick holds them) whose keeper balance is `keeper`'s for sure,
 * oldest first: what a total is seeded from on its first run. A reading's balance was read for the keeper the reading
 * before it named, so the oldest in hand (whose asker isn't in hand) is left out, and the list stops at the first whose
 * balance is another keeper's, or unread. */
export function storedBalances(history: readonly ChainReading<{ keeper?: Hex; keeperBalance?: bigint }>[], keeper: Hex): BalanceReading[] {
  const out: BalanceReading[] = [];
  for (let k = 0; k + 1 < history.length; k++) {
    const balance = history[k].state.keeperBalance;
    if (balance === undefined || history[k + 1].state.keeper?.toLowerCase() !== keeper) break;
    out.push({ time: history[k].time, balance });
  }
  return out.reverse();
}

/** What the tick counted on each chain (spendStep's `tick`), for the hour row. */
export type TickSpend = Partial<Record<ChainName, { spent: bigint; added: bigint }>>;

const FIELDS = { base: ["keeperEthSpent", "keeperEthAdded"], bittensor: ["keeperTaoSpent", "keeperTaoAdded"] } as const;

/** The hour row's keeper fields with this tick's count: the hour's falls (0 once a balance was counted in it), and its
 * rises (absent while there was none). A chain the tick didn't count is left as it was. */
export function hourSpend(prev: Pick<HourAgg, "keeperEthSpent" | "keeperEthAdded" | "keeperTaoSpent" | "keeperTaoAdded">, tick: TickSpend | undefined): Pick<HourAgg, "keeperEthSpent" | "keeperEthAdded" | "keeperTaoSpent" | "keeperTaoAdded"> {
  const out: Pick<HourAgg, "keeperEthSpent" | "keeperEthAdded" | "keeperTaoSpent" | "keeperTaoAdded"> = {};
  for (const chain of ["base", "bittensor"] as const) {
    const [spent, added] = FIELDS[chain];
    const t = tick?.[chain];
    const s = t ? (prev[spent] ?? 0n) + t.spent : prev[spent];
    const a = t && t.added > 0n ? (prev[added] ?? 0n) + t.added : prev[added];
    if (s !== undefined) out[spent] = s;
    if (a !== undefined) out[added] = a;
  }
  return out;
}

/** What the keeper spent on `chain` in the last `windowS`, from the hour rows: the falls of every hour from the window's
 * first on (to the hour: the row the window starts in counts whole), and whether a rise was seen in them (a top-up).
 * Undefined when the history doesn't reach back that far: no total, a count that started inside the window, or no hour
 * row carrying the chain's count from the window's first hour or before it. Never guessed from less. */
export function spentIn(hours: readonly HourAgg[], chain: ChainName, total: SpendTotal | undefined, nowS: number, windowS: number): { spent: bigint; toppedUp: boolean } | undefined {
  const [spent, added] = FIELDS[chain];
  const start = nowS - windowS;
  const startHour = Math.floor(start / 3600) * 3600;
  const counted = hours.filter((h) => h[spent] !== undefined);
  if (!total || total.since > start || !counted.some((h) => h.hour <= startHour)) return undefined;
  const inWindow = counted.filter((h) => h.hour >= startHour);
  return { spent: inWindow.reduce((s, h) => s + (h[spent] ?? 0n), 0n), toppedUp: inWindow.some((h) => (h[added] ?? 0n) > 0n) };
}

/** An amount of 18 decimals to at most `places` of them, rounded half up, the zeros after dropped: "0.001567". One above
 * nothing that rounds to nothing is "under 0.000001", never "0". */
export function amountTo(wei: bigint, places: number): string {
  const unit = 10n ** BigInt(18 - places);
  const rounded = ((wei + unit / 2n) / unit) * unit;
  if (rounded === 0n && wei > 0n) return `under ${formatUnits(unit, 18)}`;
  return formatUnits(rounded, 18);
}
