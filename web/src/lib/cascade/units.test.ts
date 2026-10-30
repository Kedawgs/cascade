import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIN_UNSTAKE_WEI } from "./config";
import { batchFree, capFree, ceilRao, checkUnstake, floorRao, lessSlippage, sharesFor, taoFor, toDisplay, unstakeMostWei } from "./units";

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
    expect(checkUnstake(milli(4n), available)).toMatchObject({ ok: false });
    expect(checkUnstake(available, available)).toEqual({ ok: true, all: true });
    expect(checkUnstake(milli(77n), available)).toMatchObject({ ok: false, offerAll: true });
    // 0.0088 TAO left behind: below the minimum, so it couldn't be unstaked later
    expect(checkUnstake(milli(70n), available)).toMatchObject({ ok: false, code: "leavesDust", offerAll: true });
    expect(checkUnstake(milli(67n), available)).toEqual({ ok: true, all: false });
    expect(checkUnstake(milli(80n), available)).toMatchObject({ ok: false });
    expect(checkUnstake(milli(3n), milli(3n))).toMatchObject({ ok: false, offerAll: false });
  });

  it("asks for 0.011 TAO: the vault defers a front-door redeem worth less than 0.01 TAO, so a little more", () => {
    expect(MIN_UNSTAKE_WEI).toBe(milli(11n));
    const vault = readFileSync(new URL("../../../../contracts/src/CascadeVault.sol", import.meta.url), "utf8");
    expect(vault).toMatch(/uint256 internal constant MIN_REDEEM_VALUE = 0\.01e18;/);
    // at least 10% above it, for rounding and a price that dips before delivery
    expect(MIN_UNSTAKE_WEI * 10n >= milli(10n) * 11n).toBe(true);
    const available = TAO;
    expect(checkUnstake(milli(11n), available)).toEqual({ ok: true, all: false });
    expect(checkUnstake(milli(11n) - 1n, available)).toMatchObject({ ok: false, code: "belowMin", reason: "Unstake at least 0.011 TAO" });
    // the vault's own minimum is not enough
    expect(checkUnstake(milli(10n), available)).toMatchObject({ ok: false, code: "belowMin" });
    // a remainder of exactly the minimum is fine; a wei less is dust
    expect(checkUnstake(available - milli(11n), available)).toEqual({ ok: true, all: false });
    expect(checkUnstake(available - milli(11n) + 1n, available)).toMatchObject({ ok: false, code: "leavesDust", reason: "That would leave less than 0.011 TAO, too little to unstake later" });
    // a stake of 0.01 TAO can't leave through the front door
    expect(checkUnstake(milli(10n), milli(10n))).toMatchObject({ ok: false, code: "stakeBelowMin", reason: "Unstakes start at 0.011 TAO; your stake is below that" });
    expect(checkUnstake(milli(11n), milli(11n))).toEqual({ ok: true, all: true });
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
    expect(checkUnstake(most, available, most)).toEqual({ ok: true, all: false });
    expect(checkUnstake(most + 1n, available, most)).toEqual({
      ok: false,
      code: "overEntry",
      reason: "One unstake can carry up to 9.9 TAO; unstake the rest after this one",
      offerAll: false,
    });
    // all of a stake above the most: refused, and more than the stake never offers all
    expect(checkUnstake(available, available, most)).toMatchObject({ ok: false, code: "overEntry", offerAll: false });
    expect(checkUnstake(26n * TAO, available, most)).toMatchObject({ ok: false, code: "tooMuch", offerAll: false });
    // the most would leave dust behind: not offered all either, since all is too much for one
    expect(checkUnstake(most, most + milli(5n), most)).toMatchObject({ ok: false, code: "leavesDust", offerAll: false });
    // a stake within the most: as before
    expect(checkUnstake(5n * TAO, 5n * TAO, most)).toEqual({ ok: true, all: true });
    expect(checkUnstake(6n * TAO, 5n * TAO, most)).toMatchObject({ ok: false, code: "tooMuch", offerAll: true });
    // this batch's request already as large as one can be
    expect(checkUnstake(milli(11n), available, milli(10n))).toEqual({
      ok: false,
      code: "entryFull",
      reason: "Your unstake in the current batch is already as large as one can be; unstake more after it leaves",
      offerAll: false,
    });
  });

  it("names why an unstake can't go, so the form can say it in the unit shown", () => {
    const available = milli(80n);
    expect(checkUnstake(0n, available)).toMatchObject({ code: "empty" });
    expect(checkUnstake(milli(90n), available)).toMatchObject({ code: "tooMuch" });
    expect(checkUnstake(milli(4n), available)).toMatchObject({ code: "belowMin" });
    expect(checkUnstake(milli(77n), available)).toMatchObject({ code: "leavesDust" });
    expect(checkUnstake(milli(3n), milli(3n))).toMatchObject({ code: "stakeBelowMin" });
  });

  it("turns exact amounts into display numbers", () => {
    expect(toDisplay(788n * 10n ** 14n, 18)).toBeCloseTo(0.0788, 10);
    expect(toDisplay(20_157_095n, 6)).toBeCloseTo(20.157095, 10);
  });
});
