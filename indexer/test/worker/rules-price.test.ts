import { type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery } from "../../src/rules/context.ts";
import { RULES } from "../../src/rules/ids.ts";
import { priceDrop, stakeDivergence, stakeHotkeyChanged, stakeUnexplainedDrop } from "../../src/rules/price.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import type { BitState, ChainReading, HourAgg } from "../../src/snapshot.ts";
import type { HoldRow } from "../../src/store.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";

const h = (s: string) => keccak256(toBytes(s)) as Hex;
const E18 = 10n ** 18n;
/** the v3-test vault: 77,877,093 rao of supply, so 1 rao of loss moves the price about 1.28e-8 */
const SUPPLY = 77_877_093n * 10n ** 9n;
const NOW = 1_800_000_000;
const HOTKEY = h("hotkey");

const bit = (block: bigint, price: bigint, over: Partial<BitState> = {}): ChainReading<BitState> =>
  reading(block, NOW - Number(200n - block) * 12, bitState({ price, totalSupply: SUPPLY, ...over }));

/** A context whose newest reading is `s` and whose stored ones are `history` (newest first). */
function ctx(
  s: ChainReading<BitState> | undefined,
  history: ChainReading<BitState>[],
  o: { logs?: StoredLog[]; hours?: HourAgg[]; holds?: HoldRow[]; settledBlock?: bigint; meta?: Record<string, string>; t?: typeof DEFAULTS } = {},
) {
  const base = ruleCtx();
  return ruleCtx({
    snap: { ...base.snap, at: NOW, bittensor: s },
    history: { base: [], bittensor: history },
    previous: { bittensor: history[0] },
    logs: logQuery(o.logs ?? []),
    hours: o.hours ?? [],
    holds: o.holds ?? [],
    meta: o.meta ?? {},
    t: o.t ?? DEFAULTS,
    settled: { base: base.settled.base, bittensor: { block: o.settledBlock ?? 10n ** 9n, time: NOW } },
  });
}
const vault = (event: string, block: bigint, args: StoredLog["args"]) => slog({ contract: "vault", event, block, args });

describe("price.drop", () => {
  const DROP = 12_840_000_000n; // just under what 1 rao lost explains at this supply
  const E = bit(100n, E18);
  const P = bit(105n, E18 - DROP);
  const S = bit(110n, E18 - DROP);
  const staked = vault("Staked", 103n, { hotkey: HOTKEY, rao: "77877093", measured: "77877092" });

  it("needs the next reading to confirm a drop, from increasing blocks", () => {
    expect(priceDrop.run(ctx(P, [E]))).toEqual([]);
    expect(priceDrop.run(ctx(S, [P, E])).map((f) => f.key)).toEqual(["price.drop:105"]);
    // a reading not newer than the last is never compared
    expect(priceDrop.run(ctx(bit(105n, E18 - DROP), [P, E]))).toEqual([]);
  });

  it("never counts a reading from an older block as a drop", () => {
    expect(priceDrop.run(ctx(bit(104n, E18 - DROP), [P, E]))).toEqual([]);
    expect(priceDrop.run(ctx(S, [bit(99n, E18 - DROP), E]))).toEqual([]);
  });

  it("subtracts honest rounding: a stake measured 1 rao short explains the v3-test drop", () => {
    expect(priceDrop.run(ctx(S, [P, E], { logs: [staked] }))).toEqual([]);
  });

  it("finds the same drop when no vault event explains it", () => {
    const [f] = priceDrop.run(ctx(S, [P, E]));
    expect(f).toMatchObject({ rule: "price.drop", key: "price.drop:105" });
    expect(f.facts.from).toBe("100");
    expect(f.hold).toBeUndefined();
  });

  it("lets an Unstaked short of its want, a StakeMoved short of its rao and a chunk's rounding explain their own wei", () => {
    // each explains 1e9 wei (1 rao), the drop needs about 1
    for (const l of [
      vault("Unstaked", 104n, { hotkey: HOTKEY, wantRao: "10", receivedWei: String(9n * 10n ** 9n) }),
      vault("StakeMoved", 104n, { from: HOTKEY, to: h("other"), rao: "10", moved: "9" }),
      vault("PayoutChunkSent", 104n, { key: h("k"), chunk: 0, taken: 1, gross: String(10n ** 15n), net: String(10n ** 15n - 3n * 10n ** 9n), fee: String(2n * 10n ** 9n) }),
    ]) {
      expect(priceDrop.run(ctx(S, [P, E], { logs: [l] })), l.event).toEqual([]);
    }
    // an event outside the drop's blocks explains nothing
    expect(priceDrop.run(ctx(S, [P, E], { logs: [{ ...staked, block: 100n }] }))).toHaveLength(1);
  });

  it("waits until the confirming reading is settled, so a rounding log not stored yet can't read as unexplained", () => {
    // the Staked of block 103 is stored only once Bittensor is settled past it
    expect(priceDrop.run(ctx(S, [P, E], { settledBlock: 107n }))).toEqual([]);
    expect(priceDrop.run(ctx(S, [P, E], { settledBlock: 110n, logs: [staked] }))).toEqual([]);
    expect(priceDrop.run(ctx(S, [P, E], { settledBlock: 110n })).map((f) => f.key)).toEqual(["price.drop:105"]);
  });

  it("judges the newest triple of readings that is settled", () => {
    // readings 100, 105, 110 settled; 115 not yet
    const X = bit(115n, E18 - DROP);
    expect(priceDrop.run(ctx(X, [S, P, E], { settledBlock: 112n })).map((f) => f.key)).toEqual(["price.drop:105"]);
    // the drop is between 110 and 115, and 115 isn't settled: nothing yet
    const flat = [bit(110n, E18), bit(105n, E18), bit(100n, E18)];
    expect(priceDrop.run(ctx(X, flat, { settledBlock: 112n }))).toEqual([]);
  });

  it("judges every settled triple, so settlement jumping two readings in one tick skips none", () => {
    // 100, 105 flat; the drop at 110, still down at 115 and 120
    const rs = [bit(120n, E18 - DROP), bit(115n, E18 - DROP), bit(110n, E18 - DROP), bit(105n, E18), bit(100n, E18)];
    const X = bit(125n, E18 - DROP);
    // last tick Bittensor was settled to 112 (the triple 100, 105, 110: dropped, not confirmed yet); this
    // tick it jumps to 122: the newest settled triple (110, 115, 120) has no drop, but 105, 110, 115 does
    expect(priceDrop.run(ctx(X, rs.slice(1), { settledBlock: 112n }))).toEqual([]);
    const found = priceDrop.run(ctx(X, rs, { settledBlock: 122n }));
    expect(found.map((f) => f.key)).toEqual(["price.drop:110"]);
    expect(found[0].facts).toMatchObject({ from: "105", to: "110", confirmed: "115" });
  });

  it("holds on a drop 10 bps or more below the 24-hour high, and not again once that hold is cleared", () => {
    const low = E18 - (E18 * 11n) / 10_000n;
    const hours: HourAgg[] = [{ hour: NOW - 3 * 3600, ticks: 60, priceHigh: E18, spotSum: 0, spotCount: 0 }];
    const e = bit(100n, E18 - (E18 * 8n) / 10_000n);
    const [f] = priceDrop.run(ctx(bit(110n, low), [bit(105n, low), e], { hours }));
    expect(f.hold?.id).toBe("price.drop:105");
    // the owner looked and cleared it: the 24-hour high starts again from the readings after that
    const cleared: HoldRow = { id: "price.drop:105", publicId: "h_00000001", rule: "price.drop", summary: "s", raisedAt: NOW - 600, clearedAt: NOW - 300, clearedNote: "checked" };
    const lower = low - (low * 1n) / 10_000n;
    const later = ctx(bit(130n, lower), [bit(125n, lower), bit(120n, low)], { hours, holds: [cleared] });
    const [g] = priceDrop.run(later);
    expect(g.key).toBe("price.drop:125");
    expect(g.hold).toBeUndefined();
  });
});

describe("stake.unexplained_drop", () => {
  const before = bit(100n, E18, { hotkeys: [HOTKEY], stakes: { [HOTKEY]: 10_000_000n } });
  const after = bit(105n, E18, { hotkeys: [HOTKEY], stakes: { [HOTKEY]: 9_998_000n } });

  it("finds 2,000 rao gone from a set hotkey with no vault event, and holds", () => {
    const [f] = stakeUnexplainedDrop.run(ctx(bit(110n, E18), [after, before], { settledBlock: 106n }));
    expect(f).toMatchObject({ rule: "stake.unexplained_drop", key: `stake.unexplained_drop:${HOTKEY}:105` });
    expect(f.hold?.id).toBe(`stake.unexplained_drop:${HOTKEY}:105`);
  });

  it("is explained by a vault Unstaked, StakeMoved or HotkeyRemoved of that hotkey in its blocks", () => {
    for (const [event, arg] of [
      ["Unstaked", "hotkey"],
      ["StakeMoved", "from"],
      ["HotkeyRemoved", "hotkey"],
    ]) {
      const l = vault(event, 103n, { [arg]: HOTKEY });
      expect(stakeUnexplainedDrop.run(ctx(bit(110n, E18), [after, before], { logs: [l], settledBlock: 106n })), event).toEqual([]);
    }
  });

  it("isn't explained by the same events for another hotkey", () => {
    for (const [event, arg] of [
      ["Unstaked", "hotkey"],
      ["StakeMoved", "from"],
      ["HotkeyRemoved", "hotkey"],
    ]) {
      const l = vault(event, 103n, { [arg]: h("another hotkey") });
      expect(stakeUnexplainedDrop.run(ctx(bit(110n, E18), [after, before], { logs: [l], settledBlock: 106n })), event).toHaveLength(1);
    }
  });

  it("waits until Bittensor is settled past the later reading", () => {
    expect(stakeUnexplainedDrop.run(ctx(bit(110n, E18), [after, before], { settledBlock: 104n }))).toEqual([]);
  });

  it("ignores dust, 1,000 rao or less", () => {
    const dust = bit(105n, E18, { hotkeys: [HOTKEY], stakes: { [HOTKEY]: 9_999_000n } });
    expect(stakeUnexplainedDrop.run(ctx(bit(110n, E18), [dust, before], { settledBlock: 106n }))).toEqual([]);
  });
});

describe("stake.hotkey_changed", () => {
  const OWNER = h("validator owner");

  it("finds a changed stake hotkey or hotkey set", () => {
    const p = bit(100n, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: OWNER });
    const s = bit(105n, E18, { stakeHotkey: h("new"), hotkeys: [HOTKEY, h("new")], hotkeyOwner: OWNER });
    const found = stakeHotkeyChanged.run(ctx(s, [p]));
    expect(found.map((f) => f.key).sort()).toEqual([`stake.hotkey_changed:set:105`, `stake.hotkey_changed:stake:${h("new")}`].sort());
    expect(found.every((f) => f.hold === undefined)).toBe(true);
  });

  it("holds when the hotkey's owner vanished on two readings, not on one", () => {
    const has = bit(95n, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: OWNER });
    const gone1 = bit(100n, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: null });
    const gone2 = bit(105n, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: null });
    expect(stakeHotkeyChanged.run(ctx(gone1, [has]))).toEqual([]);
    const [f] = stakeHotkeyChanged.run(ctx(gone2, [gone1, has]));
    expect(f.key).toBe(`stake.hotkey_changed:owner_gone:${HOTKEY}`);
    expect(f.hold?.id).toBe(`stake.hotkey_changed:owner_gone:${HOTKEY}:100`);
    // still gone on the next tick: the same alert, and the hold isn't raised again
    const gone3 = bit(110n, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: null });
    const [g] = stakeHotkeyChanged.run(ctx(gone3, [gone2, gone1, has]));
    expect(g.key).toBe(f.key);
    expect(g.hold).toBeUndefined();
  });

  it("never counts an owner gone before an owner was ever seen (an answer it can't read)", () => {
    const blank = (block: bigint) => bit(block, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: null });
    expect(stakeHotkeyChanged.run(ctx(blank(105n), [blank(100n), blank(95n)]))).toEqual([]);
    expect(stakeHotkeyChanged.run(ctx(blank(100n), [blank(95n)]))).toEqual([]);
  });

  it("remembers an owner it has read, in meta, so an owner gone after the readings that showed it is still found", () => {
    const has = bit(105n, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: OWNER });
    const seen = ctx(has, [bit(100n, E18, { stakeHotkey: HOTKEY, hotkeyOwner: OWNER })]);
    stakeHotkeyChanged.run(seen);
    expect(seen.writes.meta).toEqual([{ k: `hotkey_owner_seen:${HOTKEY}`, v: OWNER }]);
    // already remembered: nothing to write
    const again = ctx(has, [bit(100n, E18, { stakeHotkey: HOTKEY, hotkeyOwner: OWNER })], { meta: { [`hotkey_owner_seen:${HOTKEY}`]: OWNER } });
    stakeHotkeyChanged.run(again);
    expect(again.writes.meta).toEqual([]);
    // the monitor starts again with readings that never showed the owner (it vanished meanwhile)
    const blank = (block: bigint) => bit(block, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: null });
    const [f] = stakeHotkeyChanged.run(ctx(blank(205n), [blank(200n)], { meta: { [`hotkey_owner_seen:${HOTKEY}`]: OWNER } }));
    expect(f.key).toBe(`stake.hotkey_changed:owner_gone:${HOTKEY}`);
    expect(f.hold?.id).toBe(`stake.hotkey_changed:owner_gone:${HOTKEY}:200`);
  });

  it("finds an owner changed and confirmed by the next reading, without a hold", () => {
    const a = bit(95n, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: OWNER });
    const b = bit(100n, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: h("someone else") });
    const c = bit(105n, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], hotkeyOwner: h("someone else") });
    expect(stakeHotkeyChanged.run(ctx(b, [a]))).toEqual([]);
    const [f] = stakeHotkeyChanged.run(ctx(c, [b, a]));
    expect(f.key).toBe(`stake.hotkey_changed:owner:${HOTKEY}:${h("someone else")}`);
    expect(f.hold).toBeUndefined();
  });
});

describe("stake.divergence and stake.unlisted", () => {
  const NEW = h("the validator's new hotkey");
  const GIFT = h("a stranger's validator hotkey");
  const X = 49n * 10n ** 9n;
  const RAO = 10n ** 9n;
  /** the vault lists HOTKEY; the chain's stake sits where `stakes` says, its list naming those hotkeys */
  const at = (block: bigint, stakes: Record<Hex, bigint>, over: Partial<BitState> = {}) =>
    bit(block, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], stakedHotkeys: Object.keys(stakes) as Hex[], rootStakeRao: stakes[HOTKEY] ?? 0n, stakes, ...over });
  const healthy = (block: bigint) => at(block, { [HOTKEY]: X });
  const markerKey = `unlisted_since:${NEW}`;

  /** Ticks in a row: each run sees the meta the one before wrote (the markers), the newest six readings as the
   * store keeps them, and the logs given (the store's window moves on: a log left out has scrolled out). */
  function ticker() {
    const meta: Record<string, string> = {};
    const readings: ChainReading<BitState>[] = [];
    const run = (s: ChainReading<BitState>, o: { logs?: StoredLog[]; holds?: HoldRow[]; settledBlock?: bigint; t?: typeof DEFAULTS } = {}) => {
      const history = [...readings].reverse().slice(0, 6);
      const c = ctx(s, history, { ...o, meta: { ...meta } });
      const found = stakeDivergence.run(c);
      for (const w of c.writes.meta) meta[w.k] = w.v;
      readings.push(s);
      return { found, writes: c.writes.meta };
    };
    return { run, meta };
  }
  const marker = (meta: Record<string, string>, hk = NEW) => JSON.parse(meta[`unlisted_since:${hk}`]) as { block: string; from: string; drop: string; upTo: string };

  it("a simulated hotkey swap: the counted stake's unexplained fall, accumulated pair by pair, matches the stake on the unlisted hotkey: critical, and holds once", () => {
    const t = ticker();
    expect(t.run(healthy(100n)).found).toEqual([]);
    // the swap: 105 learns the chain's list (the stake is gone from HOTKEY): first sight, and the pair (100, 105)
    // that holds the fall is accumulated at once (the test's readings are all settled)
    const learned = t.run(at(105n, { [HOTKEY]: 0n }, { stakedHotkeys: [NEW] }));
    expect(learned.found).toEqual([]);
    expect(learned.writes).toEqual([{ k: markerKey, v: JSON.stringify({ block: "105", from: "100", drop: String(X), upTo: "105" }) }]);
    // 110 reads the stake on NEW: not yet confirmed; the marker moves on, nothing else written
    const seen = t.run(at(110n, { [HOTKEY]: 0n, [NEW]: X }));
    expect(seen.found).toEqual([]);
    expect(marker(t.meta)).toEqual({ block: "105", from: "100", drop: String(X), upTo: "110" });
    // 115 confirms it
    const { found } = t.run(at(115n, { [HOTKEY]: 0n, [NEW]: X }));
    const [f] = found;
    expect(f).toMatchObject({ rule: "stake.divergence", key: `stake.divergence:${NEW}` });
    expect(f.subject).toBe("49 TAO of the vault's stake sits on a hotkey the vault doesn't list, and its counted stake fell by as much");
    expect(f.facts).toMatchObject({
      hotkey: NEW,
      stake: `${X} rao (49 TAO)`,
      "listed by the vault": HOTKEY,
      "the vault counts": "0 rao (0 TAO)",
      "unexplained fall since the hotkey appeared": `${X} rao (49 TAO), over blocks 100-115`,
      "share of the vault": "10000 bps",
      block: "115",
      taostats: `https://taostats.io/hotkey/${NEW}`,
    });
    expect(f.hold).toEqual({ id: `stake.divergence:${NEW}:105`, summary: `49 TAO of the vault's stake sits on hotkey ${NEW}, which the vault doesn't list, and its counted stake fell by as much` });
    expect(RUNBOOK["stake.divergence"](f.facts)).toContain(`addHotkey(${NEW})`);
    expect(RUNBOOK["stake.divergence"](f.facts)).toContain("pause()");
    // still there on the next tick: the same alert and the same hold id (raised once: hold ids are never raised twice)
    const again = t.run(at(120n, { [HOTKEY]: 0n, [NEW]: X }));
    expect([again.found[0].key, again.found[0].hold?.id]).toEqual([f.key, f.hold?.id]);
    // the owner re-adds the hotkey: nothing more is found, and the marker is cleared
    const fixed = t.run(at(125n, { [HOTKEY]: 0n, [NEW]: X }, { hotkeys: [HOTKEY, NEW], rootStakeRao: X }));
    expect(fixed.found).toEqual([]);
    expect(fixed.writes).toEqual([{ k: markerKey, v: "" }]);
  });

  it("the attack: a stranger's gift, then hours later an honest payout at least its size whose Unstaked log has scrolled out of the window: never a hold", () => {
    const gift = 10n * RAO;
    const t = ticker();
    t.run(healthy(100n));
    // the gift appears in the chain's list, then its stake is read: a warning, no hold
    expect(t.run(at(105n, { [HOTKEY]: X }, { stakedHotkeys: [HOTKEY, GIFT] })).found).toEqual([]);
    expect(t.run(at(110n, { [HOTKEY]: X, [GIFT]: gift })).found).toEqual([]);
    const [w] = t.run(at(115n, { [HOTKEY]: X, [GIFT]: gift })).found;
    expect([w.rule, w.hold]).toEqual(["stake.unlisted", undefined]);
    expect(w.subject).toBe("10 TAO sits on a hotkey the vault doesn't list (the vault's counted stake didn't fall)");
    expect(w.facts["unexplained fall since the hotkey appeared"]).toBe("0 rao (0 TAO), over blocks 100-115");
    // hours on: an honest unstake of 20 TAO for a payout, its Unstaked log in the window when its pair is judged
    const paid = X - 20n * RAO;
    for (const b of [120n, 125n, 130n]) t.run(at(b, { [HOTKEY]: X, [GIFT]: gift }));
    const unstaked = vault("Unstaked", 133n, { hotkey: HOTKEY, wantRao: String(20n * RAO), receivedWei: String(20n * RAO * RAO) });
    expect(t.run(at(135n, { [HOTKEY]: paid, [GIFT]: gift }), { logs: [unstaked] }).found[0].rule).toBe("stake.unlisted");
    expect(marker(t.meta, GIFT)).toMatchObject({ drop: "0", upTo: "135" });
    // the window moves on: the log is no longer loaded, the readings that showed the fall are gone from history
    for (const b of [140n, 145n, 150n, 155n, 160n, 165n, 170n, 175n, 180n]) {
      const { found } = t.run(at(b, { [HOTKEY]: paid, [GIFT]: gift }));
      expect(found.map((f) => [f.rule, f.hold]), String(b)).toEqual([["stake.unlisted", undefined]]);
    }
    expect(marker(t.meta, GIFT)).toMatchObject({ drop: "0", upTo: "180" });
    // and with a gift of a material size the answer is the same
    const t2 = ticker();
    t2.run(healthy(200n));
    t2.run(at(205n, { [HOTKEY]: X }, { stakedHotkeys: [HOTKEY, GIFT] }));
    t2.run(at(210n, { [HOTKEY]: X, [GIFT]: 30n * RAO }));
    const big = vault("Unstaked", 213n, { hotkey: HOTKEY, wantRao: String(30n * RAO), receivedWei: String(30n * RAO * RAO) });
    t2.run(at(215n, { [HOTKEY]: X - 30n * RAO, [GIFT]: 30n * RAO }), { logs: [big] });
    for (const b of [220n, 225n, 230n, 235n, 240n, 245n, 250n]) {
      expect(t2.run(at(b, { [HOTKEY]: X - 30n * RAO, [GIFT]: 30n * RAO })).found.map((f) => [f.rule, f.hold]), String(b)).toEqual([["stake.unlisted", undefined]]);
    }
  });

  it("a swap whose first-sight reading couldn't read the chain's list: the pair with the fall is still accumulated, critical, and holds", () => {
    const t = ticker();
    t.run(healthy(100n));
    // the swap lands in (100, 105), but 105's StakingHotkeys read failed; 110 is the first sight
    expect(t.run(at(105n, { [HOTKEY]: 0n }, { stakedHotkeys: undefined })).found).toEqual([]);
    const first = t.run(at(110n, { [HOTKEY]: 0n }, { stakedHotkeys: [NEW] }));
    expect(first.found).toEqual([]);
    // the accumulation starts at the last reading whose list was known, 100: the fall in (100, 105) counts
    expect(marker(t.meta)).toEqual({ block: "110", from: "100", drop: String(X), upTo: "110" });
    t.run(at(115n, { [HOTKEY]: 0n, [NEW]: X }));
    const [f] = t.run(at(120n, { [HOTKEY]: 0n, [NEW]: X })).found;
    expect([f.rule, f.hold?.id]).toEqual(["stake.divergence", `stake.divergence:${NEW}:110`]);
  });

  it("growth in another pair (a stakeIdle, a claim credited as stake) never masks a swap's fall; a stake that didn't land counts as a fall", () => {
    const t = ticker();
    t.run(healthy(100n));
    // a stakeIdle of 10 TAO, its Staked log in the window, lands: no unexplained fall
    const staked = vault("Staked", 103n, { hotkey: HOTKEY, rao: String(10n * RAO), measured: String(10n * RAO) });
    t.run(at(105n, { [HOTKEY]: X + 10n * RAO }, { stakedHotkeys: [HOTKEY, NEW] }), { logs: [staked] });
    expect(marker(t.meta)).toMatchObject({ drop: "0", upTo: "105" });
    // a claim credited as stake: counted rises by 5 TAO with no log to expect it: no fall either
    t.run(at(110n, { [HOTKEY]: X + 15n * RAO, [NEW]: 0n }));
    expect(marker(t.meta)).toMatchObject({ drop: "0", upTo: "110" });
    // the swap: all of it goes to NEW; the earlier growth doesn't offset the fall
    t.run(at(115n, { [HOTKEY]: 0n, [NEW]: X + 15n * RAO }));
    expect(marker(t.meta)).toMatchObject({ drop: String(X + 15n * RAO), upTo: "115" });
    const [f] = t.run(at(120n, { [HOTKEY]: 0n, [NEW]: X + 15n * RAO })).found;
    expect([f.rule, f.hold?.id]).toEqual(["stake.divergence", `stake.divergence:${NEW}:105`]);
    // a stakeIdle whose Staked stake isn't on the listed hotkey afterwards is a fall of that much
    const t2 = ticker();
    t2.run(healthy(200n));
    t2.run(at(205n, { [HOTKEY]: X }, { stakedHotkeys: [HOTKEY, NEW] }));
    const lost = vault("Staked", 208n, { hotkey: HOTKEY, rao: String(10n * RAO), measured: String(10n * RAO) });
    t2.run(at(210n, { [HOTKEY]: X, [NEW]: 10n * RAO }), { logs: [lost] });
    expect(marker(t2.meta)).toMatchObject({ drop: String(10n * RAO), upTo: "210" });
    const [g] = t2.run(at(215n, { [HOTKEY]: X, [NEW]: 10n * RAO })).found;
    expect(g.rule).toBe("stake.divergence");
  });

  it("a partial move: part of the counted stake left for an unlisted hotkey: critical, and holds; below stakeDivergenceMinBps only a warning", () => {
    const part = 20n * RAO;
    const t = ticker();
    t.run(healthy(100n));
    t.run(at(105n, { [HOTKEY]: X - part }, { stakedHotkeys: [HOTKEY, NEW] }));
    t.run(at(110n, { [HOTKEY]: X - part, [NEW]: part }));
    const [f] = t.run(at(115n, { [HOTKEY]: X - part, [NEW]: part })).found;
    expect([f.rule, f.hold?.id]).toEqual(["stake.divergence", `stake.divergence:${NEW}:105`]);
    expect(f.facts["share of the vault"]).toBe("4081 bps");
    // less than 100 bps of the vault, though the counted stake fell by it: a warning, not a hold
    const tiny = 10n ** 8n;
    const t2 = ticker();
    t2.run(healthy(200n));
    t2.run(at(205n, { [HOTKEY]: X - tiny }, { stakedHotkeys: [HOTKEY, NEW] }));
    t2.run(at(210n, { [HOTKEY]: X - tiny, [NEW]: tiny }));
    const [g] = t2.run(at(215n, { [HOTKEY]: X - tiny, [NEW]: tiny })).found;
    expect([g.rule, g.hold]).toEqual(["stake.unlisted", undefined]);
    expect(g.subject).toContain("below the hold threshold: 20 bps of the vault");
    // the threshold follows THRESHOLDS
    const [k] = t2.run(at(220n, { [HOTKEY]: X - tiny, [NEW]: tiny }), { t: { ...DEFAULTS, stakeDivergenceMinBps: 1 } }).found;
    expect(k.rule).toBe("stake.divergence");
  });

  it("accumulates a pair only once Bittensor is settled past it (its logs are stored by then), and writes the marker only when it moves on", () => {
    const t = ticker();
    t.run(healthy(100n));
    // settled only to 102: the pair (100, 105) waits, the marker is created with nothing accumulated
    const first = t.run(at(105n, { [HOTKEY]: 0n }, { stakedHotkeys: [NEW] }), { settledBlock: 102n });
    expect(first.writes).toEqual([{ k: markerKey, v: JSON.stringify({ block: "105", from: "100", drop: "0", upTo: "100" }) }]);
    // still not settled: nothing written
    expect(t.run(at(110n, { [HOTKEY]: 0n, [NEW]: X }), { settledBlock: 104n }).writes).toEqual([]);
    // settled past 110: both pairs accumulated in one go
    const caught = t.run(at(115n, { [HOTKEY]: 0n, [NEW]: X }), { settledBlock: 112n });
    expect(caught.writes).toEqual([{ k: markerKey, v: JSON.stringify({ block: "105", from: "100", drop: String(X), upTo: "110" }) }]);
    // judged on the newest settled pair, (105, 110): 105 didn't show the stake yet, so nothing until 115 is settled
    expect(caught.found).toEqual([]);
    const [f] = t.run(at(120n, { [HOTKEY]: 0n, [NEW]: X }), { settledBlock: 116n }).found;
    expect([f.rule, f.facts.block]).toEqual(["stake.divergence", "115"]);
  });

  it("raises no hold of its own while a stake.unexplained_drop hold is on (the same incident: that rule saw the stake leave; this one says where it went), and offers it once that hold is cleared", () => {
    const active: HoldRow = { id: `stake.unexplained_drop:${HOTKEY}:105`, publicId: "h_00000002", rule: "stake.unexplained_drop", summary: "s", raisedAt: NOW - 300, clearedAt: null, clearedNote: null };
    const t = ticker();
    t.run(healthy(100n));
    t.run(at(105n, { [HOTKEY]: 0n }, { stakedHotkeys: [NEW] }));
    t.run(at(110n, { [HOTKEY]: 0n, [NEW]: X }));
    const [f] = t.run(at(115n, { [HOTKEY]: 0n, [NEW]: X }), { holds: [active] }).found;
    expect([f.rule, f.hold]).toEqual(["stake.divergence", undefined]);
    expect(f.facts["the hold"]).toBe("on, from stake.unexplained_drop");
    const [g] = t.run(at(120n, { [HOTKEY]: 0n, [NEW]: X }), { holds: [{ ...active, clearedAt: NOW - 100, clearedNote: "looked" }] }).found;
    expect(g.hold?.id).toBe(`stake.divergence:${NEW}:105`);
  });

  it("clears the marker when the hotkey is listed, or gone from the chain's list with no stake left", () => {
    const t = ticker();
    t.run(healthy(100n));
    t.run(at(105n, { [HOTKEY]: X }, { stakedHotkeys: [HOTKEY, GIFT] }));
    t.run(at(110n, { [HOTKEY]: X, [GIFT]: 5n * RAO }));
    expect(t.meta[`unlisted_since:${GIFT}`]).not.toBe("");
    // swept (addHotkey, then removeHotkey moved it onto the stake hotkey): gone from the list, no stake left
    const gone = t.run(at(115n, { [HOTKEY]: X + 5n * RAO, [GIFT]: 0n }, { stakedHotkeys: [HOTKEY] }));
    expect(gone.found).toEqual([]);
    expect(gone.writes).toEqual([{ k: `unlisted_since:${GIFT}`, v: "" }]);
    // listed by the vault: cleared too (the swap test covers it); a hotkey still in the list with dust keeps none
    const t2 = ticker();
    t2.run(healthy(200n));
    t2.run(at(205n, { [HOTKEY]: X, [h("old")]: 1000n }, { stakedHotkeys: [HOTKEY, h("old")] }));
    expect(t2.run(at(210n, { [HOTKEY]: X, [h("old")]: 1000n }, { stakedHotkeys: [HOTKEY, h("old")] })).found).toEqual([]);
  });

  it("never fires on honest operations: a stake, an unstake, a payout, a reward claim, vesting, and a hotkey added", () => {
    const t = ticker();
    const steps: [ChainReading<BitState>, StoredLog[]][] = [
      [healthy(100n), []],
      // stakeIdle: more stake on the listed hotkey
      [at(105n, { [HOTKEY]: X + RAO }), [vault("Staked", 103n, { hotkey: HOTKEY, rao: "1000000000", measured: "1000000000" })]],
      // an unstake for a payout: less stake, more balance
      [at(110n, { [HOTKEY]: X - 5n * RAO }, { balance: 6n * 10n ** 18n }), [vault("Unstaked", 108n, { hotkey: HOTKEY, wantRao: "5000000000", receivedWei: "5000000000000000000" })]],
      // a reward claim credited as stake, and the price vesting up
      [at(115n, { [HOTKEY]: X }, { price: E18 + 10n ** 15n }), [vault("RewardsClaimed", 113n, { hotkey: HOTKEY, deltaRao: "4000000000" })]],
      // the owner adds a second hotkey, empty so far
      [at(120n, { [HOTKEY]: X, [h("second")]: 0n }, { hotkeys: [HOTKEY, h("second")] }), []],
    ];
    for (const [s, logs] of steps) expect(t.run(s, { logs }).found, String(s.block)).toEqual([]);
    expect(Object.keys(t.meta)).toEqual([]);
  });

  it("judges nothing while the vault's set is unknown, from one reading, or from readings out of order", () => {
    const m = { [markerKey]: JSON.stringify({ block: "105", drop: String(X), upTo: "110" }) };
    const blind = at(115n, { [HOTKEY]: 0n, [NEW]: X }, { hotkeys: undefined });
    expect(stakeDivergence.run(ctx(blind, [at(110n, { [HOTKEY]: 0n, [NEW]: X })], { meta: m }))).toEqual([]);
    expect(stakeDivergence.run(ctx(at(115n, { [HOTKEY]: 0n, [NEW]: X }), [blind], { meta: m }))).toEqual([]);
    expect(stakeDivergence.run(ctx(at(115n, { [HOTKEY]: 0n, [NEW]: X }), [], { meta: m }))).toEqual([]);
    expect(stakeDivergence.run(ctx(at(105n, { [HOTKEY]: 0n, [NEW]: X }), [at(110n, { [HOTKEY]: 0n, [NEW]: X })], { meta: m }))).toEqual([]);
  });
});

