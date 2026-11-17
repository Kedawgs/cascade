import { describe, expect, it } from "vitest";
import {
  IMPACT_CAP_BPS,
  IMPACT_REFUSED,
  IMPACT_UNKNOWN,
  IMPACT_WARN_BPS,
  impactBps,
  impactNote,
  impactRefusal,
  impactRefused,
  impactRowText,
  impactWarningText,
  impactWarns,
  type PriceImpact,
} from "./impact";
import { SALE_PROBE_TAO, STAKE_PROBE_USDC } from "./price-veto";

// v3.2's price impact on every quote (Task 59a; the founder's carry of 2026-11-04, "swaps must never hurt a
// customer"): a quote's own size against the pools' price for a small trade (the veto's probe), shown, warned at
// 1% or more, refused above 3% (the controller's cap, inside the staker's 5% on-chain floor).

/** A trade whose rate (out per in) is `rate` (in 1e6ths) of a probe's rate of exactly 1. */
const at = (rateMillionths: bigint): PriceImpact => ({ tradeIn: 1_000_000n, tradeOut: rateMillionths, probeIn: 1_000_000n, probeOut: 1_000_000n });

describe("the price impact of a quote", () => {
  it("is the share of the output its size costs against a small trade's rate, in whole basis points, rounded down", () => {
    expect(impactBps(at(1_000_000n))).toBe(0n);
    expect(impactBps(at(990_000n))).toBe(100n);
    expect(impactBps(at(990_100n))).toBe(99n);
    // 3.004% is 300 whole bps: rounded down, never up
    expect(impactBps(at(969_960n))).toBe(300n);
    expect(impactBps(at(969_900n))).toBe(301n);
    // a trade nothing comes out of costs all of it
    expect(impactBps(at(0n))).toBe(10_000n);
  });

  it("is none for a trade smaller than the probe, whose rate is better (never negative)", () => {
    expect(impactBps(at(1_002_000n))).toBe(0n);
    expect(impactWarns(at(1_002_000n))).toBe(false);
    expect(impactRefused(at(1_002_000n))).toBe(false);
  });

  it("compares the rates, not the sizes: a trade 40 times the probe at the probe's rate has none", () => {
    const i: PriceImpact = { tradeIn: 4_000_000_000n, tradeOut: 16n * 10n ** 18n, probeIn: STAKE_PROBE_USDC, probeOut: 4n * 10n ** 17n };
    expect(impactBps(i)).toBe(0n);
    // a sale of 2 TAO paying 1.5% less per TAO than the 0.5 TAO probe
    const sale: PriceImpact = { tradeIn: 2n * 10n ** 18n, tradeOut: 985_000_000n, probeIn: SALE_PROBE_TAO, probeOut: 250_000_000n };
    expect(impactBps(sale)).toBe(150n);
  });

  it("warns at 1% or more: 0.99% no warning, 1% a warning", () => {
    expect(IMPACT_WARN_BPS).toBe(100n);
    expect(impactWarns(at(990_100n))).toBe(false);
    expect(impactWarns(at(990_000n))).toBe(true);
    // decided exactly, not on the rounded figure: a hair under 1% doesn't warn
    expect(impactWarns({ tradeIn: 10n ** 8n, tradeOut: 99_000_001n, probeIn: 10n ** 8n, probeOut: 10n ** 8n })).toBe(false);
  });

  it("refuses above 3%: 3% exactly is allowed, 3.01% refused", () => {
    expect(IMPACT_CAP_BPS).toBe(300n);
    expect(impactRefused(at(970_000n))).toBe(false);
    expect(impactRefused(at(969_900n))).toBe(true);
    // decided exactly: a hair over 3% is refused although its whole bps read 300
    const hair: PriceImpact = { tradeIn: 10n ** 8n, tradeOut: 96_999_999n, probeIn: 10n ** 8n, probeOut: 10n ** 8n };
    expect(impactBps(hair)).toBe(300n);
    expect(impactRefused(hair)).toBe(true);
    // the cap is inside the staker's 5% floor on chain (CascadeStaker.MAX_BUY_SLIPPAGE_BPS)
    expect(IMPACT_CAP_BPS < 500n).toBe(true);
  });

  it("is said in the controller's words, the figure to the hundredth of a percent, rounded down", () => {
    expect(impactWarningText(at(990_000n))).toBe("This trade moves the price by 1%.");
    expect(impactWarningText(at(984_500n))).toBe("This trade moves the price by 1.55%.");
    expect(impactWarningText(at(970_000n))).toBe("This trade moves the price by 3%.");
    expect(IMPACT_REFUSED).toBe("This trade would move the price by more than 3%. Try a smaller amount.");
    expect(impactRowText(at(998_800n))).toBe("0.12%");
    expect(impactRowText(at(1_000_000n))).toBe("under 0.01%");
    expect(impactRowText(at(1_002_000n))).toBe("under 0.01%");
  });

  it("gives the form its line: none under 1%, the warning from 1% to 3%, the refusal above", () => {
    expect(impactNote({ impact: at(990_100n) })).toBeNull();
    expect(impactNote({ impact: at(990_000n) })).toEqual({ text: "This trade moves the price by 1%.", refused: false });
    expect(impactNote({ impact: at(970_000n) })).toEqual({ text: "This trade moves the price by 3%.", refused: false });
    expect(impactNote({ impact: at(969_900n) })).toEqual({ text: IMPACT_REFUSED, refused: true });
    // a quote with no impact (v3-launch's, or one still loading) says nothing
    expect(impactNote({})).toBeNull();
    expect(impactNote(undefined)).toBeNull();
  });

  it("refuses a quote whose small trade read nothing: its impact can't be measured, so it isn't let through (Task 59a review, M11)", () => {
    const unmeasured: PriceImpact = { tradeIn: 1_000_000n, tradeOut: 990_000n, probeIn: 1_000_000n, probeOut: 0n };
    expect(IMPACT_UNKNOWN).toBe("Can't check this trade's price impact right now. Try again shortly.");
    expect(impactRefused(unmeasured)).toBe(true);
    expect(impactNote({ impact: unmeasured })).toEqual({ text: IMPACT_UNKNOWN, refused: true });
    expect(impactRefusal({ impact: unmeasured })).toBe(IMPACT_UNKNOWN);
    expect(impactRowText(unmeasured)).toBe("–");
    // a probe of nothing in is no measure either
    expect(impactRefusal({ impact: { ...unmeasured, probeIn: 0n, probeOut: 1n } })).toBe(IMPACT_UNKNOWN);
  });

  it("refuses a quote only above the cap, and never changes it", () => {
    const allowed = Object.freeze({ impact: Object.freeze(at(970_000n)), usdcIn: 1n });
    expect(impactRefusal(allowed)).toBeNull();
    expect(impactRefusal(Object.freeze({ impact: Object.freeze(at(969_900n)) }))).toBe(IMPACT_REFUSED);
    // v3-launch's quotes carry none: nothing new is asked of them
    expect(impactRefusal({})).toBeNull();
    expect(allowed).toEqual({ impact: at(970_000n), usdcIn: 1n });
  });
});
