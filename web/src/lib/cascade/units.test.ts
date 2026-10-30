import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIN_UNSTAKE_WEI } from "./config";
import { batchFree, capFree, ceilRao, checkUnstake, floorRao, lessSlippage, sharesFor, taoFor, toDisplay } from "./units";

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
