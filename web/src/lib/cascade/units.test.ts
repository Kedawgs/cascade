import { describe, expect, it } from "vitest";
import { capFree, checkUnstake, floorRao, lessSlippage, sharesFor, taoFor, toDisplay } from "./units";

const TAO = 10n ** 18n;
const milli = (n: bigint) => (n * TAO) / 1000n;

describe("units", () => {
  it("floors to whole rao and takes 0.5% slippage off", () => {
    expect(floorRao(1_234_567_891_234n)).toBe(1_234_000_000_000n);
    expect(lessSlippage(10_000n)).toBe(9_950n);
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

  it("refuses unstakes that would strand a payout or a remainder", () => {
    const available = 788n * 10n ** 14n; // 0.0788 TAO
    expect(checkUnstake(milli(4n), available)).toMatchObject({ ok: false });
    expect(checkUnstake(available, available)).toEqual({ ok: true, all: true });
    expect(checkUnstake(milli(77n), available)).toMatchObject({ ok: false, offerAll: true });
    expect(checkUnstake(milli(70n), available)).toEqual({ ok: true, all: false });
    expect(checkUnstake(milli(80n), available)).toMatchObject({ ok: false });
    expect(checkUnstake(milli(3n), milli(3n))).toMatchObject({ ok: false, offerAll: false });
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
