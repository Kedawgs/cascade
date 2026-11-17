import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { checkDelivery, type DeliveryRead } from "../src/keeper/core/delivery.ts";
import {
  OUTSIDE_PRICE_BPS,
  parseReference,
  REFERENCE_MAX_AGE_S,
  referenceUsdc,
  SALE_PROBE_TAO,
  saleOffMarket,
  saleUsdcPerTao,
  vetoReason,
} from "../src/keeper/core/veto.ts";

// The keeper's outside-price veto before a delivery (rulings-index T58 (+T50), founder-approved 2026-11-06 "if done
// properly"): a 0.5 TAO quote along the delivery route against the monitor's /v1/price; more than 3% under it, a
// reference older than 12 minutes, none, or unavailable: the delivery waits and is tried again next round, never a
// strike. A veto only: it never changes keeperMinOut. The same rule and constants as the web's (Task 58b).

const WEB_VETO = new URL("../../web/src/lib/cascade/price-veto.ts", import.meta.url);
const NOW = 1_800_000_000;
const NOW_MS = NOW * 1000;
const TAO = 10n ** 18n;
/** What the probe (0.5 TAO) sells for at `usdPerTao`, in USDC units */
const probeAt = (usdPerTao: number) => BigInt(Math.round(usdPerTao * 1e6)) / 2n;
const ref = (usd: number, ageS = 60, sources = 2) => ({ usd, sources, at: NOW - ageS });

describe("the constants are the web's (web/src/lib/cascade/price-veto.ts, Task 58b)", () => {
  it("3% of the reference, a reference at most 12 minutes old, a 0.5 TAO probe", () => {
    expect(OUTSIDE_PRICE_BPS).toBe(300n);
    expect(REFERENCE_MAX_AGE_S).toBe(720);
    expect(SALE_PROBE_TAO).toBe(5n * 10n ** 17n);
  });

  // the web's file is on v3.2 (Task 58b): this runs wherever the branch carries it, and fails on any drift
  it.runIf(existsSync(WEB_VETO))("held equal to the web's file, never retyped by hand", () => {
    const web = readFileSync(WEB_VETO, "utf8");
    expect(web).toContain(`export const OUTSIDE_PRICE_BPS = ${OUTSIDE_PRICE_BPS}n;`);
    expect(web).toContain(`export const REFERENCE_MAX_AGE_S = ${REFERENCE_MAX_AGE_S / 60} * 60;`);
    expect(web).toContain("export const SALE_PROBE_TAO = 5n * 10n ** 17n;");
    // the same direction rule (an unstake is refused when the pools are under the reference) and the same age rule
    expect(web).toContain("const gap = side === \"stake\" ? pool - reference : reference - pool;");
    expect(web).toContain("return gap * 10_000n > reference * bps;");
    expect(web).toContain("if (!(Math.abs(ageMs) <= REFERENCE_MAX_AGE_S * 1000)) return undefined;");
    expect(web).toContain("return usdc > 0n ? (usdc * 10n ** 18n) / SALE_PROBE_TAO : undefined;");
  });
});

describe("the reference (/v1/price, as the indexer serves it)", () => {
  it("parses exactly the two v1 shapes, a price or a reason", () => {
    expect(parseReference({ v: 1, usd: 400.5, sources: 1, at: NOW })).toEqual({ usd: 400.5, sources: 1, at: NOW });
    expect(parseReference({ v: 1, unavailable: "the sources disagree by more than 2%", at: NOW })).toEqual({ unavailable: "the sources disagree by more than 2%", at: NOW });
    expect(parseReference({ v: 1, unavailable: "no reference price has been read yet", at: null })).toEqual({ unavailable: "no reference price has been read yet", at: null });
    for (const bad of [null, [], { v: 2, usd: 1, sources: 1, at: NOW }, { v: 1, usd: -1, sources: 1, at: NOW }, { v: 1, usd: 1, sources: 0, at: NOW }, { v: 1, usd: 1, sources: 1, at: NOW, unavailable: "x" }, { v: 1, unavailable: "", at: NOW }, { v: 1, usd: Number.POSITIVE_INFINITY, sources: 1, at: NOW }]) {
      expect(parseReference(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("goes by a price within 12 minutes of now either way; one source counts; older, ahead, a reason or none: no reference", () => {
    expect(referenceUsdc(ref(400, 12 * 60), NOW_MS)).toBe(400_000_000n);
    expect(referenceUsdc(ref(400, 12 * 60 + 1), NOW_MS)).toBeUndefined();
    expect(referenceUsdc(ref(400, -12 * 60 - 1), NOW_MS)).toBeUndefined();
    expect(referenceUsdc(ref(400, 60, 1), NOW_MS)).toBe(400_000_000n);
    expect(referenceUsdc({ unavailable: "the sources disagree", at: NOW }, NOW_MS)).toBeUndefined();
    expect(referenceUsdc(null, NOW_MS)).toBeUndefined();
  });

  it("the pools' price is what 0.5 TAO sells for, a TAO's worth, rounded down", () => {
    expect(saleUsdcPerTao(probeAt(400))).toBe(400_000_000n);
    expect(saleUsdcPerTao(199_999_999n)).toBe(399_999_998n);
    expect(saleUsdcPerTao(0n)).toBeUndefined();
  });
});

describe("the veto, both directions", () => {
  const veto = (pool: number | undefined, reference: ReturnType<typeof ref> | { unavailable: string; at: number | null } | null) =>
    vetoReason({ reference, probeUsdc: pool === undefined ? undefined : probeAt(pool), nowMs: NOW_MS });

  it("agree (within 3%): no veto", () => {
    expect(veto(400, ref(400))).toBeUndefined();
    expect(veto(388.01, ref(400))).toBeUndefined();
    // exactly 3% under is not more than 3%
    expect(saleOffMarket(388_000_000n, 400_000_000n)).toBe(false);
  });

  it("disagree: the pools more than 3% under the reference (TAO cheap on Base: the sale would underpay): it waits", () => {
    expect(saleOffMarket(387_999_999n, 400_000_000n)).toBe(true);
    expect(veto(380, ref(400))).toBe(
      "the pools pay $380.00 a TAO (0.5 TAO along the delivery route), more than 3% under the outside price of $400.00 (2 sources): it waits, tried again each round (the outside-price veto; never a strike)",
    );
  });

  it("the other direction, the pools more than 3% above the reference, is the user's gain: never refused", () => {
    expect(saleOffMarket(450_000_000n, 400_000_000n)).toBe(false);
    expect(veto(450, ref(400))).toBeUndefined();
  });

  it("stale or unavailable, or the probe unread: it fails closed, a wait tried again each round", () => {
    const closed = /^the outside price can't be checked right now \(.+\): it waits, tried again each round \(the outside-price veto fails closed; never a strike\)$/;
    expect(veto(400, ref(400, 13 * 60))).toMatch(closed);
    expect(veto(400, ref(400, 13 * 60))).toContain("the reference is 13 minutes old, older than 12");
    expect(veto(400, { unavailable: "the sources disagree by more than 2%", at: NOW })).toContain("the reference is unavailable: the sources disagree by more than 2%");
    expect(veto(400, null)).toContain("the monitor gave no reference price");
    expect(veto(undefined, ref(400))).toContain("the pools' price for 0.5 TAO could not be read");
    // stale in both directions of the market alike
    expect(veto(450, ref(400, 13 * 60))).toMatch(closed);
    expect(veto(380, ref(400, 13 * 60))).toMatch(closed);
  });
});

describe("in the delivery check: after the floors decide, before the simulation; a veto only", () => {
  const USER = "0x00000000000000000000000000000000000000a1" as Address;
  const read: DeliveryRead = {
    user: USER,
    claimable: TAO,
    pref: { minUsdcPerTao: 300_000_000n, deadline: NOW + 86_400, destination: 6 },
    quoteUsdc: 399_000_000n,
    twapUsdc: 400_000_000n,
    slippageBps: 150,
    now: NOW,
  };
  const deps = (veto: string | undefined) => {
    const sims: bigint[] = [];
    return {
      sims,
      deps: {
        readDelivery: async () => read,
        simulateDeliver: async (_u: Address, minOut: bigint) => {
          sims.push(minOut);
          return { ok: true as const, usdcOut: minOut };
        },
        veto: async () => veto,
      },
    };
  };

  it("never changes keeperMinOut: with or without a passing veto it is the quote less 0.5%", async () => {
    const a = deps(undefined);
    const withVeto = await checkDelivery(a.deps, USER);
    const { veto: _, ...noVeto } = deps(undefined).deps;
    const without = await checkDelivery(noVeto, USER);
    expect(withVeto).toEqual(without);
    expect(withVeto.keeperMinOut).toBe((399_000_000n * 9_950n) / 10_000n);
    expect(a.sims).toEqual([withVeto.keeperMinOut]);
  });

  it("a veto: not delivered, its reason, nothing simulated, and no facts (it says nothing about the user's)", async () => {
    const v = deps("the pools pay …");
    const c = await checkDelivery(v.deps, USER);
    expect(c).toEqual({ user: USER, claimable: TAO, deliver: false, reason: "the pools pay …" });
    expect(v.sims).toEqual([]);
  });

  it("asked only when the floors would deliver: a quote under the user's floor says so, and the monitor isn't asked", async () => {
    let asked = 0;
    const c = await checkDelivery(
      {
        readDelivery: async () => ({ ...read, quoteUsdc: 200_000_000n }),
        simulateDeliver: async () => ({ ok: true, usdcOut: 0n }),
        veto: async () => {
          asked++;
          return "vetoed";
        },
      },
      USER,
    );
    expect(c.deliver).toBe(false);
    expect(c.reason).toMatch(/below the user's floor/);
    expect(asked).toBe(0);
  });
});
