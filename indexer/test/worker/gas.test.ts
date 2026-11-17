import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { amountTo, formatSpend, parseSpend, type SpendTotal, spendKey, spendStep, spentIn, storedBalances } from "../../src/gas.ts";
import { compactHour, expandHour, type HourAgg, hourRollup, type Snapshot } from "../../src/snapshot.ts";
import { baseState, reading } from "./rule-ctx.ts";

// The keeper's spend (the daily digest's Gas section): the falls between consecutive readings of its balance, summed.
// A difference of two balances can't span a top-up; a sum of falls can.

const KEEPER = "0x00000000000000000000000000000000000000a3" as Hex;
const OTHER = "0x00000000000000000000000000000000000000b3" as Hex;
const T = 1_800_000_000;
const E18 = 10n ** 18n;
/** readings a minute apart, oldest first */
const at = (...balances: bigint[]) => balances.map((balance, i) => ({ time: T + 60 * i, balance }));
const run = (total: SpendTotal | undefined, ...balances: bigint[]) => spendStep(total, KEEPER, at(...balances));

describe("the keeper's spend: the falls between consecutive balance readings", () => {
  it("falls only: every fall counts, from the first reading's time", () => {
    const r = run(undefined, 500n, 480n, 480n, 450n);
    expect(r.total).toEqual({ since: T, spent: 50n, last: 450n, keeper: KEEPER });
    expect(r.tick).toEqual({ spent: 50n, added: 0n });
  });

  it("a top-up between falls: the rise is no spend and hides none (a difference of the two ends would say +50 or nothing)", () => {
    const r = run(undefined, 500n, 480n, 600n, 570n);
    expect(r.total).toEqual({ since: T, spent: 50n, last: 570n, keeper: KEEPER });
    expect(r.tick).toEqual({ spent: 50n, added: 120n });
  });

  it("a single reading: nothing to sum yet; it is where the count starts", () => {
    const r = run(undefined, 500n);
    expect(r.total).toEqual({ since: T, spent: 0n, last: 500n, keeper: KEEPER });
    expect(r.tick).toEqual({ spent: 0n, added: 0n });
  });

  it("no reading: the total is left as it was, and the tick counted nothing", () => {
    const total: SpendTotal = { since: T, spent: 7n, last: 100n, keeper: KEEPER };
    expect(spendStep(total, KEEPER, [])).toEqual({ total });
    expect(spendStep(undefined, KEEPER, [])).toEqual({ total: undefined });
  });

  it("goes on from the stored total, reading by reading: its start is kept, and a balance that didn't move changes nothing", () => {
    const first = run(undefined, 500n, 480n).total as SpendTotal;
    const same = spendStep(first, KEEPER, [{ time: T + 600, balance: 480n }]);
    expect(same.total).toEqual(first);
    expect(same.tick).toEqual({ spent: 0n, added: 0n });
    const fell = spendStep(first, KEEPER, [{ time: T + 660, balance: 470n }]);
    expect(fell.total).toEqual({ since: T, spent: 30n, last: 470n, keeper: KEEPER });
    expect(fell.tick).toEqual({ spent: 10n, added: 0n });
    const topped = spendStep(fell.total, KEEPER, [{ time: T + 720, balance: 1000n }]);
    expect(topped.total).toEqual({ since: T, spent: 30n, last: 1000n, keeper: KEEPER });
    expect(topped.tick).toEqual({ spent: 0n, added: 530n });
  });

  it("another keeper's balance is never compared with the last one's: a setKeeper is neither a spend nor a top-up", () => {
    const total: SpendTotal = { since: T, spent: 30n, last: 470n, keeper: KEEPER };
    const r = spendStep(total, OTHER, [{ time: T + 60, balance: 100n }]);
    expect(r.total).toEqual({ since: T, spent: 30n, last: 100n, keeper: OTHER });
    expect(r.tick).toEqual({ spent: 0n, added: 0n });
    // and the new keeper's falls count on
    expect(spendStep(r.total, OTHER, [{ time: T + 120, balance: 90n }]).total?.spent).toBe(40n);
  });

  it("the launch keeper, by its own history: 0.4999995 TAO, two stakes later 0.49843222, is 0.00156728 TAO spent; 0.03 ETH down to 0.02999955 is 0.00000045 ETH", () => {
    const tao = run(undefined, 499_999_500_000_000_000n, 499_216_000_000_000_000n, 498_432_220_000_000_000n);
    expect(tao.total?.spent).toBe(1_567_280_000_000_000n);
    expect(amountTo(tao.total?.spent as bigint, 6)).toBe("0.001567");
    const eth = run(undefined, 30_000_000_000_000_000n, 29_999_800_000_000_000n, 29_999_550_000_000_000n);
    expect(eth.total?.spent).toBe(450_000_000_000n);
    expect(amountTo(eth.total?.spent as bigint, 8)).toBe("0.00000045");
  });
});

describe("the running total in meta (keeper_spend:<chain>)", () => {
  it("is kept as JSON, amounts as decimal strings, and reads back the same", () => {
    const total: SpendTotal = { since: T, spent: 1_567_280_000_000_000n, last: 498_432_220_000_000_000n, keeper: KEEPER };
    expect(spendKey("base")).toBe("keeper_spend:base");
    expect(spendKey("bittensor")).toBe("keeper_spend:bittensor");
    expect(formatSpend(total)).toBe(`{"since":${T},"spent":"1567280000000000","last":"498432220000000000","keeper":"${KEEPER}"}`);
    expect(parseSpend(formatSpend(total))).toEqual(total);
  });

  it("a missing or damaged value is no total (the count then starts again, from that reading, and says so by its date)", () => {
    for (const v of [undefined, "", "{", "null", "[]", '{"since":"x","spent":"1","last":"1","keeper":"0x01"}', `{"since":${T},"spent":"-1","last":"1","keeper":"${KEEPER}"}`, `{"since":${T},"spent":"1","keeper":"${KEEPER}"}`, `{"since":${T},"spent":"1","last":"1"}`]) {
      expect(parseSpend(v), String(v)).toBeUndefined();
    }
  });
});

describe("the stored readings the count is seeded from", () => {
  const r = (n: number, keeper: Hex | undefined, keeperBalance?: bigint) => reading(BigInt(100 - n), T - 60 * n, baseState({ keeper, keeperBalance }));

  it("the readings in hand, oldest first: a reading's balance was read for the keeper the reading before it named, so the oldest in hand is left out", () => {
    // newest first, as the tick holds them
    const history = [r(1, KEEPER, 480n), r(2, KEEPER, 490n), r(3, KEEPER, 500n), r(4, KEEPER, 777n)];
    expect(storedBalances(history, KEEPER)).toEqual([
      { time: T - 180, balance: 500n },
      { time: T - 120, balance: 490n },
      { time: T - 60, balance: 480n },
    ]);
  });

  it("stops at a reading whose balance is another keeper's, or unread; none in hand is none", () => {
    expect(storedBalances([r(1, KEEPER, 480n), r(2, KEEPER, 490n), r(3, OTHER, 500n), r(4, OTHER, 510n)], KEEPER)).toEqual([{ time: T - 60, balance: 480n }]);
    expect(storedBalances([r(1, KEEPER, 480n), r(2, KEEPER), r(3, KEEPER, 500n), r(4, KEEPER, 510n)], KEEPER)).toEqual([{ time: T - 60, balance: 480n }]);
    expect(storedBalances([r(1, KEEPER, 480n)], KEEPER)).toEqual([]);
    expect(storedBalances([], KEEPER)).toEqual([]);
  });
});

describe("the hour row's share (hourRollup)", () => {
  const snap = (at: number): Snapshot => ({ at, nonces: { base: {}, bittensor: {} }, safeNonces: { base: {}, bittensor: {} }, messageStates: {}, deliveredReads: [] });

  it("adds each tick's falls and rises to the hour's, a chain at a time, and starts the next hour afresh", () => {
    let h = hourRollup(undefined, snap(T), undefined, { base: { spent: 3n, added: 0n } });
    // counted on Base with no rise: its falls, and nothing of Bittensor's (not counted this tick)
    expect(h).toMatchObject({ hour: T, keeperEthSpent: 3n });
    for (const k of ["keeperEthAdded", "keeperTaoSpent", "keeperTaoAdded"]) expect(h, k).not.toHaveProperty(k);
    h = hourRollup(h, snap(T + 60), undefined, { base: { spent: 0n, added: 50n }, bittensor: { spent: 0n, added: 0n } });
    expect(h).toMatchObject({ keeperEthSpent: 3n, keeperEthAdded: 50n, keeperTaoSpent: 0n });
    expect(h).not.toHaveProperty("keeperTaoAdded");
    h = hourRollup(h, snap(T + 120), undefined, { base: { spent: 4n, added: 1n }, bittensor: { spent: 9n, added: 0n } });
    expect(h).toMatchObject({ ticks: 3, keeperEthSpent: 7n, keeperEthAdded: 51n, keeperTaoSpent: 9n });
    // a tick that counted nothing (no reading of the keeper's balance) leaves the hour's as they were
    expect(hourRollup(h, snap(T + 180))).toMatchObject({ ticks: 4, keeperEthSpent: 7n, keeperEthAdded: 51n, keeperTaoSpent: 9n });
    expect(hourRollup(h, snap(T + 180), undefined, {})).toMatchObject({ keeperEthSpent: 7n, keeperTaoSpent: 9n });
    const next = hourRollup(h, snap(T + 3600), undefined, { bittensor: { spent: 1n, added: 0n } });
    expect(next).toMatchObject({ hour: T + 3600, ticks: 1, keeperTaoSpent: 1n });
    expect(next).not.toHaveProperty("keeperEthSpent");
    // and they are stored and read back with the row
    expect(expandHour(compactHour(h))).toEqual(JSON.parse(JSON.stringify(h, (_k, v) => (typeof v === "bigint" ? `big:${v}` : v)), (_k, v) => (typeof v === "string" && v.startsWith("big:") ? BigInt(v.slice(4)) : v)));
  });
});

describe("the spend in a window, from the hour rows (each hour's falls and rises, summed by the tick)", () => {
  const NOW = T + 13 * 3600 + 20;
  const hourOf = (s: number) => Math.floor(s / 3600) * 3600;
  /** an hour row `back` hours before the digest's hour */
  const row = (back: number, o: Partial<HourAgg> = {}): HourAgg => ({ hour: hourOf(NOW) - back * 3600, ticks: 60, spotSum: 0, spotCount: 0, ...o });
  const total = (since: number): SpendTotal => ({ since, spent: 0n, last: 0n, keeper: KEEPER });
  const DAY = 86_400;

  it("sums the hours of the window, each chain's own", () => {
    const hours = [row(0, { keeperEthSpent: 3n, keeperTaoSpent: 100n }), row(5, { keeperEthSpent: 4n, keeperTaoSpent: 0n }), row(24, { keeperEthSpent: 5n, keeperTaoSpent: 200n }), row(25, { keeperEthSpent: 1000n, keeperTaoSpent: 1000n })];
    expect(spentIn(hours, "base", total(NOW - 3 * DAY), NOW, DAY)).toEqual({ spent: 12n, toppedUp: false });
    expect(spentIn(hours, "bittensor", total(NOW - 3 * DAY), NOW, DAY)).toEqual({ spent: 300n, toppedUp: false });
  });

  it("a top-up in the window no longer hides the spend: the spend, and that a rise was seen", () => {
    const hours = [row(1, { keeperEthSpent: 3n }), row(2, { keeperEthSpent: 0n, keeperEthAdded: 10n ** 16n }), row(3, { keeperEthSpent: 4n }), row(30, { keeperEthSpent: 1n, keeperTaoSpent: 1n, keeperTaoAdded: 5n })];
    expect(spentIn(hours, "base", total(NOW - 3 * DAY), NOW, DAY)).toEqual({ spent: 7n, toppedUp: true });
    // a rise before the window, or on the other chain, is not this window's
    expect(spentIn([...hours, row(4, { keeperTaoSpent: 2n })], "bittensor", total(NOW - 3 * DAY), NOW, DAY)).toEqual({ spent: 2n, toppedUp: false });
    expect(spentIn([...hours, row(4, { keeperTaoSpent: 2n }), row(200, { keeperTaoSpent: 0n })], "bittensor", total(NOW - 30 * DAY), NOW, 7 * DAY)).toEqual({ spent: 3n, toppedUp: true });
  });

  it("not enough history: no total, a count that started inside the window, or no hour row from before it", () => {
    const hours = [row(1, { keeperEthSpent: 3n }), row(24, { keeperEthSpent: 4n })];
    expect(spentIn(hours, "base", undefined, NOW, DAY)).toBeUndefined();
    // counted from 23 hours and 59 minutes ago: a minute short of the day
    expect(spentIn(hours, "base", total(NOW - DAY + 60), NOW, DAY)).toBeUndefined();
    expect(spentIn(hours, "base", total(NOW - DAY), NOW, DAY)).toEqual({ spent: 7n, toppedUp: false });
    // the hour rows are what is summed: none from the window's first hour or before it (a total written by hand, rows
    // kept only since), and the window isn't covered, whatever the total's date says
    expect(spentIn([row(1, { keeperEthSpent: 3n })], "base", total(NOW - 30 * DAY), NOW, DAY)).toBeUndefined();
    expect(spentIn(hours, "base", total(NOW - 30 * DAY), NOW, 7 * DAY)).toBeUndefined();
    // an hour the monitor missed is no gap in the count: the next reading is compared with the last one
    expect(spentIn([row(1, { keeperEthSpent: 3n }), row(40, { keeperEthSpent: 9n })], "base", total(NOW - 3 * DAY), NOW, DAY)).toEqual({ spent: 3n, toppedUp: false });
    // rows from before the keeper's balance was kept (no field) count for nothing and prove nothing
    expect(spentIn([row(1, { keeperEthSpent: 3n }), row(30)], "base", total(NOW - 3 * DAY), NOW, DAY)).toBeUndefined();
    // the other chain's rows are not this chain's history
    expect(spentIn([row(1, { keeperEthSpent: 3n }), row(30, { keeperTaoSpent: 0n })], "base", total(NOW - 3 * DAY), NOW, DAY)).toBeUndefined();
  });
});

describe("amounts in the digest: TAO to 6 places, ETH to 8", () => {
  it("rounds to the places, drops the zeros after, and never shows a spend as nothing", () => {
    expect(amountTo(0n, 8)).toBe("0");
    expect(amountTo(E18, 6)).toBe("1");
    expect(amountTo(10n ** 15n, 8)).toBe("0.001");
    expect(amountTo(29_999_550_000_000_000n, 8)).toBe("0.02999955");
    expect(amountTo(498_432_220_000_000_000n, 6)).toBe("0.498432");
    // half up
    expect(amountTo(1_567_500_000_000_000n, 6)).toBe("0.001568");
    expect(amountTo(999_999_999_999_999_999n, 6)).toBe("1");
    // above nothing, under the last place shown
    expect(amountTo(4_000_000_000n, 8)).toBe("under 0.00000001");
    expect(amountTo(1n, 6)).toBe("under 0.000001");
    expect(amountTo(5_000_000_000n, 8)).toBe("0.00000001");
  });
});
