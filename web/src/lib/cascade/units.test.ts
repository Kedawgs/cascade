import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Deployment, MIN_UNSTAKE_WEI, MIN_UNSTAKE_WEI_V3, minUnstakeWei } from "./config";
import {
  batchFree,
  capFree,
  ceilRao,
  checkUnstake,
  closeFirstFloor,
  floorRao,
  lessSlippage,
  PRICE_DROP_NOTE,
  priceDropNote,
  sharesFor,
  taoFor,
  toDisplay,
  unstakeMostWei,
} from "./units";

const TAO = 10n ** 18n;
const milli = (n: bigint) => (n * TAO) / 1000n;

describe("units", () => {
  it("floors to whole rao and takes 0.5% slippage off", () => {
    expect(floorRao(1_234_567_891_234n)).toBe(1_234_000_000_000n);
    expect(lessSlippage(10_000n)).toBe(9_950n);
  });

  it("rounds up to whole rao", () => {
    expect(ceilRao(1n)).toBe(10n ** 9n);
    expect(ceilRao(10n ** 9n)).toBe(10n ** 9n);
    expect(ceilRao(0n)).toBe(0n);
    expect(ceilRao(1_234_567_891_234n)).toBe(1_235_000_000_000n);
  });

  it("converts TAO and shares exactly, one to one into an empty vault", () => {
    expect(sharesFor(10n ** 16n, 0n, 0n)).toBe(10n ** 16n * 10n ** 6n);
    const assets = 2n * 10n ** 16n;
    const supply = 2n * 10n ** 22n;
    expect(sharesFor(10n ** 16n, assets, supply)).toBe(10n ** 22n);
    expect(taoFor(10n ** 22n, assets, supply)).toBe(10n ** 16n);
    expect(taoFor(5n, 0n, 0n)).toBe(0n);
  });

  it("says how much room the deposit cap has left, never below zero", () => {
    expect(capFree({ depositCap: 15n * 10n ** 16n, netForwarded: 0n, openTotal: 0n })).toBe(15n * 10n ** 16n);
    expect(capFree({ depositCap: 10n, netForwarded: 8n, openTotal: 5n })).toBe(0n);
  });

  it("says how much room the open batch has left: none once its value or its list is full", () => {
    const open = { maxBatchValue: 10n * TAO, openTotal: 3n * TAO, openDeposits: 4, maxDeposits: 50 };
    expect(batchFree(open)).toBe(7n * TAO);
    // the owner may lower the limit below what the batch already holds
    expect(batchFree({ ...open, maxBatchValue: 2n * TAO })).toBe(0n);
    expect(batchFree({ ...open, openDeposits: 50 })).toBe(0n);
  });

  it("refuses unstakes that would strand a payout or a remainder", () => {
    const available = 788n * 10n ** 14n; // 0.0788 TAO
    expect(checkUnstake(milli(4n), available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false });
    expect(checkUnstake(available, available, undefined, MIN_UNSTAKE_WEI_V3)).toEqual({ ok: true, all: true });
    expect(checkUnstake(milli(77n), available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, offerAll: true });
    // 0.0088 TAO left behind: below the minimum, so it couldn't be unstaked later
    expect(checkUnstake(milli(70n), available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "leavesDust", offerAll: true });
    expect(checkUnstake(milli(67n), available, undefined, MIN_UNSTAKE_WEI_V3)).toEqual({ ok: true, all: false });
    expect(checkUnstake(milli(80n), available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false });
    expect(checkUnstake(milli(3n), milli(3n), undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, offerAll: false });
  });

  it("asks for 0.011 TAO: the vault defers a front-door redeem worth less than 0.01 TAO, so a little more", () => {
    expect(MIN_UNSTAKE_WEI_V3).toBe(milli(11n));
    // v3-launch's source, frozen in ops/builds/preaudit (contracts/ now holds v3.2)
    const vault = readFileSync(new URL("../../../../ops/builds/preaudit/src/CascadeVault.sol", import.meta.url), "utf8");
    expect(vault).toMatch(/uint256 internal constant MIN_REDEEM_VALUE = 0\.01e18;/);
    // at least 10% above it, for rounding and a price that dips before delivery
    expect(MIN_UNSTAKE_WEI_V3 * 10n >= milli(10n) * 11n).toBe(true);
    const available = TAO;
    expect(checkUnstake(milli(11n), available, undefined, MIN_UNSTAKE_WEI_V3)).toEqual({ ok: true, all: false });
    expect(checkUnstake(milli(11n) - 1n, available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "belowMin", reason: "Unstake at least 0.011 TAO" });
    // the vault's own minimum is not enough
    expect(checkUnstake(milli(10n), available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "belowMin" });
    // a remainder of exactly the minimum is fine; a wei less is dust
    expect(checkUnstake(available - milli(11n), available, undefined, MIN_UNSTAKE_WEI_V3)).toEqual({ ok: true, all: false });
    expect(checkUnstake(available - milli(11n) + 1n, available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "leavesDust", reason: "That would leave less than 0.011 TAO, too little to unstake later" });
    // a stake of 0.01 TAO can't leave through the front door
    expect(checkUnstake(milli(10n), milli(10n), undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "stakeBelowMin", reason: "Unstakes start at 0.011 TAO; your stake is below that" });
    expect(checkUnstake(milli(11n), milli(11n), undefined, MIN_UNSTAKE_WEI_V3)).toEqual({ ok: true, all: true });
  });

  it("caps one unstake at the vault's maxEntryValue, less 1% and what this batch already asks of it", () => {
    // the 1% margin: the share price may rise before delivery, and the vault clips past the limit
    expect(unstakeMostWei(10n * TAO, 0n)).toBe((99n * TAO) / 10n);
    expect(unstakeMostWei(10n * TAO, 4n * TAO)).toBe((59n * TAO) / 10n);
    expect(unstakeMostWei(10n * TAO, 10n * TAO)).toBe(0n);
    // floored to the 0.000001 TAO the form shows
    expect(unstakeMostWei(10n * TAO, 1n)).toBe((99n * TAO) / 10n - 10n ** 12n);
  });

  it("refuses an unstake larger than one can carry, and never offers all of a stake above it", () => {
    const most = (99n * TAO) / 10n;
    const available = 25n * TAO;
    expect(checkUnstake(most, available, most, MIN_UNSTAKE_WEI_V3)).toEqual({ ok: true, all: false });
    expect(checkUnstake(most + 1n, available, most, MIN_UNSTAKE_WEI_V3)).toEqual({
      ok: false,
      code: "overEntry",
      reason: "One unstake can carry up to 9.9 TAO; unstake the rest a day later (unstakes are limited per day)",
      offerAll: false,
    });
    // all of a stake above the most: refused, and more than the stake never offers all
    expect(checkUnstake(available, available, most, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "overEntry", offerAll: false });
    expect(checkUnstake(26n * TAO, available, most, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "tooMuch", offerAll: false });
    // the most would leave dust behind: not offered all either, since all is too much for one
    expect(checkUnstake(most, most + milli(5n), most, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "leavesDust", offerAll: false });
    // a stake within the most: as before
    expect(checkUnstake(5n * TAO, 5n * TAO, most, MIN_UNSTAKE_WEI_V3)).toEqual({ ok: true, all: true });
    expect(checkUnstake(6n * TAO, 5n * TAO, most, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "tooMuch", offerAll: true });
    // this batch's request already as large as one can be
    expect(checkUnstake(milli(11n), available, milli(10n), MIN_UNSTAKE_WEI_V3)).toEqual({
      ok: false,
      code: "entryFull",
      reason: "Your unstake in the current batch is already as large as one can be; unstake more after it leaves",
      offerAll: false,
    });
    // said first, whatever is typed: not "Enter an amount" for a 0, nor "more than you can unstake"
    for (const typed of [0n, 30n * TAO]) expect(checkUnstake(typed, available, 0n, MIN_UNSTAKE_WEI_V3)).toMatchObject({ ok: false, code: "entryFull" });
  });

  it("names why an unstake can't go, so the form can say it in the unit shown", () => {
    const available = milli(80n);
    expect(checkUnstake(0n, available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ code: "empty" });
    expect(checkUnstake(milli(90n), available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ code: "tooMuch" });
    expect(checkUnstake(milli(4n), available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ code: "belowMin" });
    expect(checkUnstake(milli(77n), available, undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ code: "leavesDust" });
    expect(checkUnstake(milli(3n), milli(3n), undefined, MIN_UNSTAKE_WEI_V3)).toMatchObject({ code: "stakeBelowMin" });
  });

  it("turns exact amounts into display numbers", () => {
    expect(toDisplay(788n * 10n ** 14n, 18)).toBeCloseTo(0.0788, 10);
    expect(toDisplay(20_157_095n, 6)).toBeCloseTo(20.157095, 10);
  });
});

// ---- v3.2: the 0.033 TAO minimum, and "all" forced below it ----

const ADDR = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
/** A v3 deployment (v3-launch's shape), and a v3.2 one: the same, with its two lenses. */
const V3: Deployment = {
  frontDoor: ADDR(1),
  baseAdapter: ADDR(2),
  vault: ADDR(3),
  bitAdapter: ADDR(4),
  bitBlock: 1n,
  vaultSs58: "x",
  hotkeySs58: "y",
  staker: ADDR(5),
  oracle: ADDR(6),
};
const V32: Deployment = { ...V3, vaultLens: ADDR(7), doorLens: ADDR(8) };

describe("v3.2's unstake minimum", () => {
  it("minUnstakeIs0033Tao", () => {
    expect(MIN_UNSTAKE_WEI).toBe(33n * 10n ** 15n);
    // v3.2's vault defers, without burning, a front-door redeem worth less than 0.03 TAO; 10% more covers
    // the rounding between the form's price and the vault's
    const constants = readFileSync(new URL("../../../../contracts/src/CascadeConstants.sol", import.meta.url), "utf8");
    expect(constants).toMatch(/uint256 constant MIN_REDEEM_VALUE = 0\.03e18;/);
    expect(MIN_UNSTAKE_WEI * 10n).toBe(milli(30n) * 11n);
    // a v3.2 deployment asks for it; v3-launch (and any deployment before v3.2) keeps its 0.011 TAO
    expect(minUnstakeWei(V32)).toBe(MIN_UNSTAKE_WEI);
    expect(minUnstakeWei(V3)).toBe(MIN_UNSTAKE_WEI_V3);
    expect(minUnstakeWei(null)).toBe(MIN_UNSTAKE_WEI_V3);
    const min = MIN_UNSTAKE_WEI;
    expect(checkUnstake(milli(33n), TAO, undefined, min)).toEqual({ ok: true, all: false });
    expect(checkUnstake(milli(33n) - 1n, TAO, undefined, min)).toMatchObject({ ok: false, code: "belowMin", reason: "Unstake at least 0.033 TAO" });
    // v3-launch's 0.011 TAO is not enough here
    expect(checkUnstake(milli(11n), TAO, undefined, min)).toMatchObject({ ok: false, code: "belowMin" });
    expect(checkUnstake(milli(32n), milli(32n), undefined, min)).toMatchObject({
      ok: false,
      code: "stakeBelowMin",
      reason: "Unstakes start at 0.033 TAO; your stake is below that",
    });
    expect(checkUnstake(milli(33n), milli(33n), undefined, min)).toEqual({ ok: true, all: true });
  });

  it("forcesAllBelowTheRedeemMinimum", () => {
    const min = MIN_UNSTAKE_WEI;
    // the vault defers on the redeem's value in TAO, which TAO's dollar price doesn't move (CascadeBatchLib.sol:157-162;
    // Task 58 review, Minor 5, the controller's wording)
    expect(PRICE_DROP_NOTE).toBe("A remainder near the minimum can fall just below it before delivery; that part then waits and you request it again.");
    // a request that would leave less than the minimum behind: refused, and all of it offered instead
    const small = milli(50n);
    expect(checkUnstake(milli(40n), small, undefined, min)).toEqual({
      ok: false,
      code: "leavesDust",
      reason: "That would leave less than 0.033 TAO, too little to unstake later",
      offerAll: true,
    });
    // under twice the minimum no split leaves two unstakes of it: all is the only one that goes
    for (const typed of [milli(17n), milli(33n), milli(40n), small - 1n]) expect(checkUnstake(typed, small, undefined, min).ok).toBe(false);
    const all = checkUnstake(small, small, undefined, min);
    expect(all).toEqual({ ok: true, all: true });
    // forced, it carries the note: by delivery a price drop can take it under the vault's minimum
    expect(priceDropNote(all, small, min)).toBe(PRICE_DROP_NOTE);
    expect(priceDropNote(checkUnstake(milli(40n), small, undefined, min), small, min)).toBe(PRICE_DROP_NOTE);
    expect(priceDropNote(checkUnstake(milli(80n), small, undefined, min), small, min)).toBe(PRICE_DROP_NOTE);
    // a stake of twice the minimum or more splits, so nothing is forced and no note shows
    expect(priceDropNote(checkUnstake(milli(66n), milli(66n), undefined, min), milli(66n), min)).toBeNull();
    expect(priceDropNote(checkUnstake(milli(33n), milli(66n), undefined, min), milli(66n), min)).toBeNull();
    // all of a large stake, offered for a remainder too small to keep, is nowhere near the minimum
    expect(priceDropNote(checkUnstake(TAO - milli(1n), TAO, undefined, min), TAO, min)).toBeNull();
    // nothing goes below the minimum, so there is nothing to note
    expect(priceDropNote(checkUnstake(milli(32n), milli(32n), undefined, min), milli(32n), min)).toBeNull();
    expect(priceDropNote(null, small, min)).toBeNull();
  });
});

describe("R12c: the minValue of the site's close before a stake (closeFirstFloor): the keeper's fullCloseFloor's lines, the highest of them when more than one held (R12e)", () => {
  const l = { maxDeposits: 50, maxRedeems: 50, maxBatchValue: 10n * TAO, minDeposit: 4n * 10n ** 16n, depositCap: 40n * TAO, netForwarded: 0n };
  const b = (totalDeposits: bigint, deposits = 1, redeems = 0) => ({ deposits, redeems, totalDeposits });

  it("the least total at which a value limit that held at the read still holds (the highest such line when more held, R12e), at least 1 wei and never above the total", () => {
    // half the value limit: 5 TAO (an odd limit rounds up: 2 × t >= 9 needs 4.5)
    expect(closeFirstFloor(b(6n * TAO), l)).toBe(5n * TAO);
    // R12e: at the limit itself no minimum fits under it too: that line, the higher (within a minimum of the limit)
    expect(closeFirstFloor(b(10n * TAO), l)).toBe(10n * TAO - 4n * 10n ** 16n + 1n);
    expect(closeFirstFloor(b(6n * TAO), { ...l, maxBatchValue: 9n * TAO })).toBe((9n * TAO + 1n) / 2n);
    // no room for a minimum deposit, under half (a minimum above half the limit): maxBatchValue - minDeposit + 1 wei
    expect(closeFirstFloor(b(45n * 10n ** 17n), { ...l, minDeposit: 6n * TAO })).toBe(4n * TAO + 1n);
    // half the cap's room: netForwarded 30 of 40, so 5 TAO of deposits
    expect(closeFirstFloor(b(6n * TAO), { ...l, maxBatchValue: 100n * TAO, netForwarded: 30n * TAO })).toBe(5n * TAO);
    // no room under the cap for a minimum, under half its room: depositCap - netForwarded - minDeposit + 1 wei
    expect(closeFirstFloor(b(45n * 10n ** 17n), { ...l, maxBatchValue: 100n * TAO, netForwarded: 30n * TAO, minDeposit: 6n * TAO })).toBe(4n * TAO + 1n);
    // R12e: the highest of the limits that held (the user's paid close; the keeper's names the least): 9.8 TAO at half a
    // 16 TAO limit (8) and at half the cap's room left by 30 of 40 (5)
    expect(closeFirstFloor(b(98n * 10n ** 17n), { ...l, maxBatchValue: 16n * TAO, netForwarded: 30n * TAO })).toBe(8n * TAO);
    expect(closeFirstFloor(b(98n * 10n ** 17n), { ...l, maxBatchValue: 16n * TAO, netForwarded: 20n * TAO })).toBe(8n * TAO);
    // a cap already filled, and no value limit held: 1 wei, never 0 (a batch with no deposits is never full by value)
    expect(closeFirstFloor(b(6n * TAO), { ...l, maxBatchValue: 100n * TAO, netForwarded: 40n * TAO })).toBe(1n);
    // a cap already filled under a value limit that held too: that limit's line, never the cap's 1 wei
    expect(closeFirstFloor(b(6n * TAO), { ...l, netForwarded: 40n * TAO })).toBe(5n * TAO);
    // exactly at the line: the total itself (a cancel of a rao takes it under every line that held)
    expect(closeFirstFloor(b(5n * TAO), l)).toBe(5n * TAO);
  });

  it("R12e: when two clauses or more held, the user's close names the HIGHEST of their floors, so the batch it pays for never shrank below any line that held at the read (it reverts BatchTooSmall instead, Base's network fee spent, and the stake reads its room again: one retry); the keeper's close keeps the least", () => {
    // 25+ depositors and half the value limit: 5 TAO, never the list's 1 TAO (before R12e the user paid for a batch shrunk to 1 TAO)
    expect(closeFirstFloor(b(6n * TAO, 25), l)).toBe(5n * TAO);
    // a full list and a full value (no room for a minimum under the limit): the batch within a minimum deposit of full
    expect(closeFirstFloor(b(10n * TAO, 50), l)).toBe(10n * TAO - 4n * 10n ** 16n + 1n);
    // a full redeem list and a value line: the value line (a shrunk batch may have made room for the stake, which then
    // needs no close)
    expect(closeFirstFloor(b(6n * TAO, 1, 50), l)).toBe(5n * TAO);
    // never above the total, whichever line is highest
    expect(closeFirstFloor(b(5n * 10n ** 17n, 25), { ...l, netForwarded: 3999n * 10n ** 16n })).toBe(5n * 10n ** 17n);
  });

  it("R12d: full by its deposit list (at half maxDeposits, build B): the least the entries the list needs can hold, min(total, ceil(maxDeposits / 2) x minDeposit), the keeper's list floor, so a mass cancel of whole entries can't send the user's paid close as a tiny batch", () => {
    // 25 of 50 needed, 0.04 TAO each at least: 1 TAO
    expect(closeFirstFloor(b(2n * TAO, 25), l)).toBe(TAO);
    // an odd limit's half rounds up: 25 of 49
    expect(closeFirstFloor(b(2n * TAO, 25), { ...l, maxDeposits: 49 })).toBe(TAO);
    // never above the total (entries made under a lower minimum)
    expect(closeFirstFloor(b(5n * 10n ** 17n, 25), l)).toBe(5n * 10n ** 17n);
    // R12e: a value line under the list's held too: the list's, the higher (half the cap's room left by 39.6 of 40 TAO is 0.2)
    expect(closeFirstFloor(b(2n * TAO, 25), { ...l, netForwarded: 396n * 10n ** 17n })).toBe(TAO);
  });

  it("full by the redeem list (at its limit) alone: 0, its count makes it full whatever the deposits; the redeem list at half is not full", () => {
    expect(closeFirstFloor(b(2n * TAO, 1, 50), l)).toBe(0n);
    expect(closeFirstFloor(b(0n, 0, 50), l)).toBe(0n);
    // R12e: a list and a value line held with it: the highest line
    expect(closeFirstFloor(b(10n * TAO, 25, 50), l)).toBe(10n * TAO - 4n * 10n ** 16n + 1n);
    expect(closeFirstFloor(b(2n * TAO, 1, 25), l)).toBeUndefined();
  });

  it("no limit reached (due by time alone): undefined, so the close names the exact total", () => {
    expect(closeFirstFloor(b(2n * TAO), l)).toBeUndefined();
    expect(closeFirstFloor(b(2n * TAO, 24), l)).toBeUndefined();
    expect(closeFirstFloor(b(0n, 0, 1), l)).toBeUndefined();
    // just under half the limit, room for a minimum: not full
    expect(closeFirstFloor(b(5n * TAO - 1n), l)).toBeUndefined();
  });
});
