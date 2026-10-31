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
  /** the vault lists HOTKEY; the chain's stake sits where `stakes` says, its list naming those hotkeys */
  const at = (block: bigint, stakes: Record<Hex, bigint>, over: Partial<BitState> = {}) =>
    bit(block, E18, { stakeHotkey: HOTKEY, hotkeys: [HOTKEY], stakedHotkeys: Object.keys(stakes) as Hex[], rootStakeRao: stakes[HOTKEY] ?? 0n, stakes, ...over });
  const healthy = (block: bigint) => at(block, { [HOTKEY]: X });
  const marker = (hk: Hex, block: bigint, counted: bigint) => ({ [`unlisted_since:${hk}`]: JSON.stringify({ block: String(block), counted: String(counted) }) });

  it("a simulated hotkey swap: the counted stake fell by what sits on the unlisted hotkey, confirmed by two readings: critical, and holds", () => {
    // reading 100: all is well; the validator swaps HOTKEY → NEW; 105 learns the chain's list (the stake is gone from
    // HOTKEY), 110 reads the stake on NEW, 115 confirms it
    const learned = at(105n, { [HOTKEY]: 0n }, { stakedHotkeys: [NEW] });
    const seen = at(110n, { [HOTKEY]: 0n, [NEW]: X });
    const confirmed = at(115n, { [HOTKEY]: 0n, [NEW]: X });
    // first sight of NEW in the chain's list: the counted stake before it appeared is remembered, nothing judged yet
    const first = ctx(learned, [healthy(100n)]);
    expect(stakeDivergence.run(first)).toEqual([]);
    expect(first.writes.meta).toEqual([{ k: `unlisted_since:${NEW}`, v: JSON.stringify({ block: "105", counted: String(X) }) }]);
    const m = marker(NEW, 105n, X);
    expect(stakeDivergence.run(ctx(seen, [learned, healthy(100n)], { meta: m }))).toEqual([]);
    const [f] = stakeDivergence.run(ctx(confirmed, [seen, learned, healthy(100n)], { meta: m }));
    expect(f).toMatchObject({ rule: "stake.divergence", key: `stake.divergence:${NEW}` });
    expect(f.subject).toBe("49 TAO of the vault's stake sits on a hotkey the vault doesn't list, and its counted stake fell by as much");
    expect(f.facts).toMatchObject({
      hotkey: NEW,
      stake: `${X} rao (49 TAO)`,
      "listed by the vault": HOTKEY,
      "the vault counts": "0 rao (0 TAO)",
      "counted before the hotkey appeared": `${X} rao (49 TAO), at block 105`,
      "share of the vault": "10000 bps",
      block: "115",
      taostats: `https://taostats.io/hotkey/${NEW}`,
    });
    expect(f.hold).toEqual({ id: `stake.divergence:${NEW}:105`, summary: `49 TAO of the vault's stake sits on hotkey ${NEW}, which the vault doesn't list, and its counted stake fell by as much` });
    expect(RUNBOOK["stake.divergence"](f.facts)).toContain(`addHotkey(${NEW})`);
    expect(RUNBOOK["stake.divergence"](f.facts)).toContain("pause()");
    // still there on the next tick: the same alert and the same hold id (raised once: hold ids are never raised twice)
    const [g] = stakeDivergence.run(ctx(at(120n, { [HOTKEY]: 0n, [NEW]: X }), [confirmed, seen, learned], { meta: m }));
    expect([g.key, g.hold?.id]).toEqual([f.key, f.hold?.id]);
    // the owner re-adds the hotkey: nothing more is found, and the marker is cleared
    const fixed = ctx(at(125n, { [HOTKEY]: 0n, [NEW]: X }, { hotkeys: [HOTKEY, NEW], rootStakeRao: X }), [at(120n, { [HOTKEY]: 0n, [NEW]: X }), confirmed], { meta: m });
    expect(stakeDivergence.run(fixed)).toEqual([]);
    expect(fixed.writes.meta).toEqual([{ k: `unlisted_since:${NEW}`, v: "" }]);
  });

  it("a stranger's transfer_stake gift: stake appears on an unlisted hotkey but the counted stake didn't fall: a warning naming it, no hold", () => {
    const gift = 500_000n;
    const appeared = at(105n, { [HOTKEY]: X }, { stakedHotkeys: [HOTKEY, GIFT] });
    const read = at(110n, { [HOTKEY]: X, [GIFT]: gift });
    const again = at(115n, { [HOTKEY]: X, [GIFT]: gift });
    const first = ctx(appeared, [healthy(100n)]);
    expect(stakeDivergence.run(first)).toEqual([]);
    expect(first.writes.meta).toEqual([{ k: `unlisted_since:${GIFT}`, v: JSON.stringify({ block: "105", counted: String(X) }) }]);
    const m = marker(GIFT, 105n, X);
    expect(stakeDivergence.run(ctx(read, [appeared, healthy(100n)], { meta: m }))).toEqual([]);
    const [f] = stakeDivergence.run(ctx(again, [read, appeared], { meta: m }));
    expect(f).toMatchObject({ rule: "stake.unlisted", key: `stake.unlisted:${GIFT}` });
    expect(f.subject).toBe("0.0005 TAO sits on a hotkey the vault doesn't list (the vault's counted stake didn't fall)");
    expect(f.facts).toMatchObject({ hotkey: GIFT, stake: `${gift} rao (0.0005 TAO)`, "the vault counts": `${X} rao (49 TAO)`, "share of the vault": "0 bps" });
    expect(f.hold).toBeUndefined();
    expect(RULES["stake.unlisted"]).toMatchObject({ tier: "warning", kind: "event", canHold: false });
    expect(RUNBOOK["stake.unlisted"](f.facts)).toContain(`addHotkey(${GIFT})`);
    expect(RUNBOOK["stake.unlisted"](f.facts)).toContain("removeHotkey");
    // a large gift (a material share) without a matching fall in the counted stake is still only the warning
    const big = 10n * 10n ** 9n;
    const [g] = stakeDivergence.run(ctx(at(115n, { [HOTKEY]: X, [GIFT]: big }), [at(110n, { [HOTKEY]: X, [GIFT]: big }), appeared], { meta: m }));
    expect(g.rule).toBe("stake.unlisted");
    expect(g.facts["share of the vault"]).toBe("1694 bps");
  });

  it("a partial move: part of the counted stake left for an unlisted hotkey: critical, and holds", () => {
    const part = 20n * 10n ** 9n;
    const m = marker(NEW, 105n, X);
    const moved = (block: bigint) => at(block, { [HOTKEY]: X - part, [NEW]: part });
    const [f] = stakeDivergence.run(ctx(moved(115n), [moved(110n), at(105n, { [HOTKEY]: X - part }, { stakedHotkeys: [HOTKEY, NEW] })], { meta: m }));
    expect([f.rule, f.hold?.id]).toEqual(["stake.divergence", `stake.divergence:${NEW}:105`]);
    expect(f.facts["share of the vault"]).toBe("4081 bps");
    // less than stakeDivergenceMinBps (100 bps) of the vault, though the counted stake fell by it: a warning, not a hold
    const tiny = 10n ** 8n;
    const dust = (block: bigint) => at(block, { [HOTKEY]: X - tiny, [NEW]: tiny });
    const [g] = stakeDivergence.run(ctx(dust(115n), [dust(110n)], { meta: m }));
    expect([g.rule, g.hold]).toEqual(["stake.unlisted", undefined]);
    // the threshold follows THRESHOLDS
    const [k] = stakeDivergence.run(ctx(dust(115n), [dust(110n)], { meta: m, t: { ...DEFAULTS, stakeDivergenceMinBps: 1 } }));
    expect(k.rule).toBe("stake.divergence");
  });

  it("subtracts the vault's own unstakes between the hotkey's appearance and now from the counted fall (judged once settled)", () => {
    // the vault unstaked 20 TAO for payouts (an Unstaked log) after a stranger's gift appeared: the fall is explained
    const gift = 10n ** 9n;
    const m = marker(GIFT, 105n, X);
    const after = (block: bigint) => at(block, { [HOTKEY]: X - 20n * 10n ** 9n, [GIFT]: gift });
    const unstaked = vault("Unstaked", 108n, { hotkey: HOTKEY, wantRao: String(20n * 10n ** 9n), receivedWei: String(20n * 10n ** 18n) });
    expect(stakeDivergence.run(ctx(after(115n), [after(110n)], { meta: m, logs: [unstaked] }))[0].rule).toBe("stake.unlisted");
    // without the log the fall reads as the stake's move: critical
    expect(stakeDivergence.run(ctx(after(115n), [after(110n)], { meta: m }))[0].rule).toBe("stake.divergence");
    // not judged before Bittensor is settled past the reading (the log may not be stored yet)
    expect(stakeDivergence.run(ctx(after(115n), [after(110n)], { meta: m, settledBlock: 114n }))).toEqual([]);
  });

  it("raises no hold of its own while a stake.unexplained_drop hold is on (the same incident: that rule saw the stake leave; this one says where it went), and offers it once that hold is cleared", () => {
    const m = marker(NEW, 105n, X);
    const now = at(115n, { [HOTKEY]: 0n, [NEW]: X });
    const prev = at(110n, { [HOTKEY]: 0n, [NEW]: X });
    const active: HoldRow = { id: `stake.unexplained_drop:${HOTKEY}:105`, publicId: "h_00000002", rule: "stake.unexplained_drop", summary: "s", raisedAt: NOW - 300, clearedAt: null, clearedNote: null };
    const [f] = stakeDivergence.run(ctx(now, [prev], { meta: m, holds: [active] }));
    expect([f.rule, f.hold]).toEqual(["stake.divergence", undefined]);
    expect(f.facts["the hold"]).toBe("on, from stake.unexplained_drop");
    const [g] = stakeDivergence.run(ctx(now, [prev], { meta: m, holds: [{ ...active, clearedAt: NOW - 100, clearedNote: "looked" }] }));
    expect(g.hold?.id).toBe(`stake.divergence:${NEW}:105`);
  });

  it("never fires on honest operations: a stake, an unstake, a payout, a reward claim, vesting, and a hotkey added", () => {
    const readings = [
      healthy(100n),
      // stakeIdle: more stake on the listed hotkey
      at(105n, { [HOTKEY]: X + 10n ** 9n }),
      // an unstake for a payout: less stake, more balance
      at(110n, { [HOTKEY]: X - 5n * 10n ** 9n }, { balance: 6n * 10n ** 18n }),
      // a reward claim credited as stake, and the price vesting up
      at(115n, { [HOTKEY]: X }, { price: E18 + 10n ** 15n }),
      // the owner adds a second hotkey, empty so far
      at(120n, { [HOTKEY]: X, [h("second")]: 0n }, { hotkeys: [HOTKEY, h("second")] }),
      // the chain's list still names a hotkey the vault once used, with dust left on it
      at(125n, { [HOTKEY]: X, [h("old")]: 1000n }, { hotkeys: [HOTKEY], stakedHotkeys: [HOTKEY, h("old")] }),
      at(130n, { [HOTKEY]: X, [h("old")]: 1000n }, { hotkeys: [HOTKEY], stakedHotkeys: [HOTKEY, h("old")] }),
    ];
    for (let i = 1; i < readings.length; i++) {
      const c = ctx(readings[i], readings.slice(0, i).reverse());
      expect(stakeDivergence.run(c), String(readings[i].block)).toEqual([]);
    }
  });

  it("judges nothing while the vault's set is unknown, from one reading, or from readings out of order", () => {
    const m = marker(NEW, 105n, X);
    const blind = at(110n, { [HOTKEY]: 0n, [NEW]: X }, { hotkeys: undefined });
    expect(stakeDivergence.run(ctx(blind, [at(105n, { [HOTKEY]: 0n, [NEW]: X })], { meta: m }))).toEqual([]);
    expect(stakeDivergence.run(ctx(at(110n, { [HOTKEY]: 0n, [NEW]: X }), [blind], { meta: m }))).toEqual([]);
    expect(stakeDivergence.run(ctx(at(110n, { [HOTKEY]: 0n, [NEW]: X }), [], { meta: m }))).toEqual([]);
    expect(stakeDivergence.run(ctx(at(105n, { [HOTKEY]: 0n, [NEW]: X }), [at(110n, { [HOTKEY]: 0n, [NEW]: X })], { meta: m }))).toEqual([]);
  });
});

