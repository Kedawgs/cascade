import { type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery } from "../../src/rules/context.ts";
import { priceDrop, stakeHotkeyChanged, stakeUnexplainedDrop } from "../../src/rules/price.ts";
import type { BitState, ChainReading, HourAgg } from "../../src/snapshot.ts";
import type { HoldRow } from "../../src/store.ts";
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
function ctx(s: ChainReading<BitState> | undefined, history: ChainReading<BitState>[], o: { logs?: StoredLog[]; hours?: HourAgg[]; holds?: HoldRow[]; settledBlock?: bigint } = {}) {
  const base = ruleCtx();
  return ruleCtx({
    snap: { ...base.snap, at: NOW, bittensor: s },
    history: { base: [], bittensor: history },
    previous: { bittensor: history[0] },
    logs: logQuery(o.logs ?? []),
    hours: o.hours ?? [],
    holds: o.holds ?? [],
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

  it("is explained by a vault Unstaked, StakeMoved or HotkeyRemoved in its blocks", () => {
    for (const event of ["Unstaked", "StakeMoved", "HotkeyRemoved"]) {
      const l = vault(event, 103n, {});
      expect(stakeUnexplainedDrop.run(ctx(bit(110n, E18), [after, before], { logs: [l], settledBlock: 106n })), event).toEqual([]);
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
