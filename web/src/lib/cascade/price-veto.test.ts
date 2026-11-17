import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUOTER } from "./abi";
import { type Deployment, PATH_TAO_TO_USDC, PATH_USDC_TO_TAO, UNISWAP } from "./config";
import { FlowError } from "./flows";
import {
  CHECK_DEADLINE_MS,
  checkOutsidePrice,
  CLOCK_READ_TIMEOUT_MS,
  fetchReference,
  liveVetoDeps,
  MAX_PRICE_BYTES,
  offMarket,
  OUTSIDE_PRICE_BPS,
  outsidePriceVeto,
  parseReference,
  poolUsdcPerTao,
  PRICE_OFF_MARKET,
  PRICE_UNCHECKABLE,
  type Reference,
  referenceUsdc,
  REFERENCE_MAX_AGE_S,
  SALE_PROBE_TAO,
  STAKE_PROBE_USDC,
  type VetoDeps,
} from "./price-veto";

// v3.2's outside-price veto (Task 58b; rulings-index T58, founder-approved 2026-11-06): the Base pools' TAO price against
// the indexer's GET /v1/price (indexer/src/api.ts handlePrice, Task 57b), refused more than 3% off in the trade's
// direction, failing closed when the reference can't be read. These are its own rules; flows.test.ts holds the stake
// flows that call it, deployments.test.ts the build that requires the indexer for it.

const D: Deployment = {
  frontDoor: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  baseAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  vault: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  bitAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  bitBlock: 1n,
  vaultSs58: "x",
  hotkeySs58: "y",
};
/** v3-launch's shape: a v3 deployment (staker and oracle), no lenses. */
const D3: Deployment = { ...D, staker: getAddress("0x00000000000000000000000000000000005a4e12"), oracle: getAddress("0x000000000000000000000000000000000000041e") };
/** A v3.2 deployment, built with the indexer it needs. */
const D32: Deployment = {
  ...D3,
  vaultLens: getAddress("0x000000000000000000000000000000000000Ae15"),
  doorLens: getAddress("0x000000000000000000000000000000000000De15"),
  indexerUrl: "https://api.cascadefi.xyz",
};

/** When the sources were asked (unix s), and now, the same instant (ms). */
const AT = 1_800_000_000;
const NOW_MS = AT * 1000;
/** The market: $250 a TAO, both sources agreeing. */
const MARKET = 250;
const fresh = (over: Partial<Extract<Reference, { usd: number }>> = {}): Reference => ({ usd: MARKET, sources: 2, at: AT, ...over });

/** Pools that buy and sell TAO at `usdcPerTao` (USDC units per TAO) at any size, as a fake quoter. */
const pools = (usdcPerTao: bigint) => ({
  quoteBuy: vi.fn(async (usdcUnits: bigint) => (usdcUnits * 10n ** 18n) / usdcPerTao),
  quoteSell: vi.fn(async (taoWei: bigint) => (taoWei * usdcPerTao) / 10n ** 18n),
});

const deps = (over: Partial<VetoDeps> = {}, poolPrice: bigint = 250_000_000n): VetoDeps => ({
  reference: async () => fresh(),
  ...pools(poolPrice),
  nowMs: async () => NOW_MS,
  ...over,
});

/** What the check did: undefined when it let the trade go, else the message it refused with. */
const outcome = async (p: Promise<void>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(FlowError);
    expect((e as FlowError).state).toBe("needs-you");
    return (e as FlowError).message;
  }
};

const json = (body: unknown, status = 200) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;

describe("the outside-price veto's settings and words", () => {
  it("names its band, its age limit and its probe sizes", () => {
    expect(OUTSIDE_PRICE_BPS).toBe(300n);
    expect(REFERENCE_MAX_AGE_S).toBe(12 * 60);
    // $100 of USDC, and 0.5 TAO
    expect(STAKE_PROBE_USDC).toBe(100_000_000n);
    expect(SALE_PROBE_TAO).toBe(5n * 10n ** 17n);
  });

  it("says, in the controller's words, why nothing was sent", () => {
    expect(PRICE_OFF_MARKET).toBe(
      "The price on Base is more than 3% away from the wider market right now, so this was not sent. Nothing was spent; try again in a few minutes.",
    );
    expect(PRICE_UNCHECKABLE).toBe("Can't check the price right now. Try again shortly.");
  });
});

describe("the pools against the market, each trade in its own direction", () => {
  it("agree: a stake and an unstake both go ahead while the pools sit within 3% of the market", async () => {
    for (const price of [250_000_000n, 252_000_000n, 248_000_000n, 257_000_000n, 243_000_000n]) {
      expect(await outcome(checkOutsidePrice("stake", deps({}, price))), String(price)).toBeUndefined();
      expect(await outcome(checkOutsidePrice("unstake", deps({}, price))), String(price)).toBeUndefined();
    }
  });

  it("TAO dear on Base: a stake is refused, and an unstake goes ahead (selling high is the user's gain)", async () => {
    // $258.25: 3.3% over the market
    const dear = deps({}, 258_250_000n);
    expect(await outcome(checkOutsidePrice("stake", dear))).toBe(PRICE_OFF_MARKET);
    expect(await outcome(checkOutsidePrice("unstake", dear))).toBeUndefined();
    // far over, as a pool pushed for half an hour would be
    expect(await outcome(checkOutsidePrice("stake", deps({}, 300_000_000n)))).toBe(PRICE_OFF_MARKET);
    expect(await outcome(checkOutsidePrice("unstake", deps({}, 300_000_000n)))).toBeUndefined();
  });

  it("TAO cheap on Base: an unstake asking for USDC is refused, and a stake goes ahead (buying low is the user's gain)", async () => {
    // $241.75: 3.3% under the market
    const cheap = deps({}, 241_750_000n);
    expect(await outcome(checkOutsidePrice("unstake", cheap))).toBe(PRICE_OFF_MARKET);
    expect(await outcome(checkOutsidePrice("stake", cheap))).toBeUndefined();
    expect(await outcome(checkOutsidePrice("unstake", deps({}, 200_000_000n)))).toBe(PRICE_OFF_MARKET);
    expect(await outcome(checkOutsidePrice("stake", deps({}, 200_000_000n)))).toBeUndefined();
  });

  it("refuses only more than 3% off: 3% exactly goes ahead", () => {
    const ref = 250_000_000n;
    expect(offMarket("stake", 257_500_000n, ref)).toBe(false);
    expect(offMarket("stake", 257_500_001n, ref)).toBe(true);
    expect(offMarket("unstake", 242_500_000n, ref)).toBe(false);
    expect(offMarket("unstake", 242_499_999n, ref)).toBe(true);
    // the other direction never, however far
    expect(offMarket("stake", 1n, ref)).toBe(false);
    expect(offMarket("unstake", 10n ** 12n, ref)).toBe(false);
  });

  it("holds the band end to end, through the quotes: 2.99% off goes ahead, 3.01% off is refused, on each side", async () => {
    // the market at $250: 2.99% is $7.475, 3.01% is $7.525
    expect(await outcome(checkOutsidePrice("stake", deps({}, 257_475_000n)))).toBeUndefined();
    expect(await outcome(checkOutsidePrice("stake", deps({}, 257_525_000n)))).toBe(PRICE_OFF_MARKET);
    expect(await outcome(checkOutsidePrice("unstake", deps({}, 242_525_000n)))).toBeUndefined();
    expect(await outcome(checkOutsidePrice("unstake", deps({}, 242_475_000n)))).toBe(PRICE_OFF_MARKET);
  });

  it("prices the pools from a small fixed-size quote along the trade's route, each rounded the way that refuses sooner", async () => {
    // $100 buys 0.4 TAO: $250.00; 0.3 TAO would be $333.33..., rounded up
    expect(await poolUsdcPerTao("stake", { quoteBuy: async () => 4n * 10n ** 17n, quoteSell: async () => 0n })).toBe(250_000_000n);
    expect(await poolUsdcPerTao("stake", { quoteBuy: async () => 3n * 10n ** 17n, quoteSell: async () => 0n })).toBe(333_333_334n);
    // 0.5 TAO sells for $124.999999: $249.999998 a TAO
    expect(await poolUsdcPerTao("unstake", { quoteBuy: async () => 0n, quoteSell: async () => 124_999_999n })).toBe(249_999_998n);
    // a quote of nothing is no price
    expect(await poolUsdcPerTao("stake", { quoteBuy: async () => 0n, quoteSell: async () => 1n })).toBeUndefined();
    expect(await poolUsdcPerTao("unstake", { quoteBuy: async () => 1n, quoteSell: async () => 0n })).toBeUndefined();
  });

  it("quotes $100 of USDC for a stake and 0.5 TAO for an unstake, never the user's own amount, each side's own quote only", async () => {
    const stake = deps();
    await checkOutsidePrice("stake", stake);
    expect(stake.quoteBuy).toHaveBeenCalledExactlyOnceWith(STAKE_PROBE_USDC);
    expect(stake.quoteSell).not.toHaveBeenCalled();
    const unstake = deps();
    await checkOutsidePrice("unstake", unstake);
    expect(unstake.quoteSell).toHaveBeenCalledExactlyOnceWith(SALE_PROBE_TAO);
    expect(unstake.quoteBuy).not.toHaveBeenCalled();
    // it takes no amount: the trade's own size can't reach it
    expect(checkOutsidePrice.length).toBe(2);
  });

  it("one answering source counts as a price (the founder's rule lists only none answering, or a disagreement), and vetoes as two would", async () => {
    expect(await outcome(checkOutsidePrice("stake", deps({ reference: async () => fresh({ sources: 1 }) })))).toBeUndefined();
    expect(await outcome(checkOutsidePrice("stake", deps({ reference: async () => fresh({ sources: 1 }) }, 300_000_000n)))).toBe(PRICE_OFF_MARKET);
  });
});

describe("a reference that can't be gone by: fail closed", () => {
  const both = async (over: Partial<VetoDeps>) => [await outcome(checkOutsidePrice("stake", deps(over))), await outcome(checkOutsidePrice("unstake", deps(over)))];
  const closed = [PRICE_UNCHECKABLE, PRICE_UNCHECKABLE];

  it("unavailable (the sources disagree, or none answered): nothing goes, whatever the pools say", async () => {
    expect(await both({ reference: async () => ({ unavailable: "the price sources disagree by more than 2%", at: AT }) })).toEqual(closed);
    expect(await both({ reference: async () => ({ unavailable: "no price source answered", at: AT }) })).toEqual(closed);
  });

  it("a cold store (no reading yet: at null)", async () => {
    expect(await both({ reference: async () => ({ unavailable: "no reference price has been read yet", at: null }) })).toEqual(closed);
    expect(await both({ reference: async () => ({ unavailable: "no price source is configured", at: null }) })).toEqual(closed);
  });

  it("stale at 12 min + 1 s; fresh at 11 min 59 s, and at 12 min exactly", async () => {
    const at = (ageS: number) => ({ nowMs: async () => (AT + ageS) * 1000 });
    expect(await both(at(12 * 60 + 1))).toEqual(closed);
    expect(await both(at(11 * 60 + 59))).toEqual([undefined, undefined]);
    expect(await both(at(12 * 60))).toEqual([undefined, undefined]);
    // an hour old: the indexer stopped reading, and its old reading is never taken for today's
    expect(await both(at(3600))).toEqual(closed);
    expect(referenceUsdc(fresh(), (AT + 12 * 60) * 1000 + 1)).toBeUndefined();
  });

  it("a reading dated more than 12 minutes ahead of now (a clock or a record gone wrong); a few seconds ahead is fine", async () => {
    expect(await both({ nowMs: async () => (AT - 12 * 60 - 1) * 1000 })).toEqual(closed);
    expect(await both({ nowMs: async () => (AT - 5) * 1000 })).toEqual([undefined, undefined]);
  });

  it("no reading at all (fetchReference's null), a reading that throws, a clock that can't be read or isn't a number", async () => {
    expect(await both({ reference: async () => null })).toEqual(closed);
    expect(await both({ reference: async () => Promise.reject(new Error("down")) })).toEqual(closed);
    expect(await both({ nowMs: async () => Promise.reject(new Error("no clock")) })).toEqual(closed);
    expect(await both({ nowMs: async () => Number.NaN })).toEqual(closed);
  });

  it("gives up at one deadline for the whole check (15 s), refusing: a reference, a quote or a clock that never answers", async () => {
    expect(CHECK_DEADLINE_MS).toBe(15_000);
    const never = () => new Promise<never>(() => undefined);
    for (const over of [{ reference: never }, { quoteBuy: never, quoteSell: never }, { nowMs: never }] as Partial<VetoDeps>[]) {
      const started = Date.now();
      expect(await outcome(checkOutsidePrice("stake", deps(over), 30))).toBe(PRICE_UNCHECKABLE);
      expect(await outcome(checkOutsidePrice("unstake", deps(over), 30))).toBe(PRICE_UNCHECKABLE);
      expect(Date.now() - started).toBeLessThan(2_000);
    }
    // an answer in time is unaffected by it
    expect(await outcome(checkOutsidePrice("stake", deps(), 1_000))).toBeUndefined();
  });

  it("the pools' quote can't be read, or quotes nothing", async () => {
    const down = async () => Promise.reject(new Error("HTTP request failed. URL: https://base-rpc.publicnode.com"));
    expect(await outcome(checkOutsidePrice("stake", deps({ quoteBuy: down })))).toBe(PRICE_UNCHECKABLE);
    expect(await outcome(checkOutsidePrice("unstake", deps({ quoteSell: down })))).toBe(PRICE_UNCHECKABLE);
    expect(await outcome(checkOutsidePrice("stake", deps({ quoteBuy: async () => 0n })))).toBe(PRICE_UNCHECKABLE);
    expect(await outcome(checkOutsidePrice("unstake", deps({ quoteSell: async () => 0n })))).toBe(PRICE_UNCHECKABLE);
  });

  it("a price that rounds to nothing in USDC units, or is too large to hold exactly, is no price", () => {
    expect(referenceUsdc(fresh({ usd: 1e-7 }), NOW_MS)).toBeUndefined();
    expect(referenceUsdc(fresh({ usd: 1e12 }), NOW_MS)).toBeUndefined();
    expect(referenceUsdc(fresh({ usd: 250.123456 }), NOW_MS)).toBe(250_123_456n);
  });
});

describe("the indexer's GET /v1/price, as Task 57b serves it", () => {
  it("reads the two v1 shapes exactly: a price with its count of sources, or a reason, each with its time (null only with a reason)", () => {
    expect(parseReference({ v: 1, usd: 250.5, sources: 2, at: AT })).toEqual({ usd: 250.5, sources: 2, at: AT });
    expect(parseReference({ v: 1, usd: 250.5, sources: 1, at: AT })).toEqual({ usd: 250.5, sources: 1, at: AT });
    expect(parseReference({ v: 1, unavailable: "no price source answered", at: AT })).toEqual({ unavailable: "no price source answered", at: AT });
    expect(parseReference({ v: 1, unavailable: "no reference price has been read yet", at: null })).toEqual({
      unavailable: "no reference price has been read yet",
      at: null,
    });
  });

  it("refuses anything else: another version, a price that isn't one, both a price and a reason, a time that isn't one", () => {
    const bad: Record<string, unknown> = {
      null: null,
      "an array": [{ v: 1, usd: 250, sources: 2, at: AT }],
      "a string": "250",
      "a number": 250,
      "no version": { usd: 250, sources: 2, at: AT },
      "version 2": { v: 2, usd: 250, sources: 2, at: AT },
      "version as text": { v: "1", usd: 250, sources: 2, at: AT },
      "a price of 0": { v: 1, usd: 0, sources: 2, at: AT },
      "a negative price": { v: 1, usd: -250, sources: 2, at: AT },
      "NaN": { v: 1, usd: Number.NaN, sources: 2, at: AT },
      "Infinity": { v: 1, usd: Number.POSITIVE_INFINITY, sources: 2, at: AT },
      "a price as text": { v: 1, usd: "250", sources: 2, at: AT },
      "no sources": { v: 1, usd: 250, at: AT },
      "0 sources": { v: 1, usd: 250, sources: 0, at: AT },
      "a fraction of a source": { v: 1, usd: 250, sources: 1.5, at: AT },
      "sources as text": { v: 1, usd: 250, sources: "2", at: AT },
      "a price with no time": { v: 1, usd: 250, sources: 2 },
      "a price at null": { v: 1, usd: 250, sources: 2, at: null },
      "a time of 0": { v: 1, usd: 250, sources: 2, at: 0 },
      "a fractional time": { v: 1, usd: 250, sources: 2, at: AT + 0.5 },
      "a time as text": { v: 1, usd: 250, sources: 2, at: String(AT) },
      "a price and a reason": { v: 1, usd: 250, sources: 2, unavailable: "x", at: AT },
      "an empty reason": { v: 1, unavailable: "", at: AT },
      "a reason that isn't text": { v: 1, unavailable: 5, at: AT },
      "a reason with no time": { v: 1, unavailable: "x" },
      "a reason at a time that isn't one": { v: 1, unavailable: "x", at: -1 },
      "neither": { v: 1, at: AT },
    };
    for (const [name, body] of Object.entries(bad)) expect(parseReference(body), name).toBeUndefined();
  });

  it("asks GET <indexer>/v1/price, CORS, without credentials, and reads what it answers", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ v: 1, usd: 250, sources: 2, at: AT }), { status: 200 });
    }) as typeof fetch;
    expect(await fetchReference(D32, { fetch: f })).toEqual({ usd: 250, sources: 2, at: AT });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.cascadefi.xyz/v1/price");
    expect(seen[0].init).toMatchObject({ method: "GET", mode: "cors", credentials: "omit" });
  });

  it("gives null, never throwing, for no indexer, a 503, any other status, a network failure, a timeout, an oversized or malformed body", async () => {
    let asked = 0;
    const counting = (async () => (asked++, new Response("{}"))) as typeof fetch;
    expect(await fetchReference(D3, { fetch: counting })).toBeNull();
    expect(asked).toBe(0);
    // a damaged row, or D1 down: 503
    expect(await fetchReference(D32, { fetch: json("not available", 503) })).toBeNull();
    expect(await fetchReference(D32, { fetch: json({ v: 1, usd: 250, sources: 2, at: AT }, 304) })).toBeNull();
    expect(await fetchReference(D32, { fetch: json("too many requests", 429) })).toBeNull();
    expect(await fetchReference(D32, { fetch: (async () => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch })).toBeNull();
    const hangs = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    expect(await fetchReference(D32, { fetch: hangs, timeoutMs: 10 })).toBeNull();
    expect(await fetchReference(D32, { fetch: json(JSON.stringify({ v: 1, usd: 250, sources: 2, at: AT, pad: "x".repeat(MAX_PRICE_BYTES) })) })).toBeNull();
    expect(await fetchReference(D32, { fetch: json("<html>") })).toBeNull();
    expect(await fetchReference(D32, { fetch: json({ v: 2, usd: 250, sources: 2, at: AT }) })).toBeNull();
    expect(await fetchReference(D32, { fetch: json({ v: 1, usd: 0, sources: 2, at: AT }) })).toBeNull();
  });

  it("each of those fails a v3.2 stake and unstake closed, as an unavailable reading does; a good answer lets them go", async () => {
    const via = (f: typeof fetch) => deps({ reference: () => fetchReference(D32, { fetch: f, timeoutMs: 10 }) });
    for (const f of [json("not available", 503), json("<html>"), json({ v: 2, usd: 250, sources: 2, at: AT }), json({ v: 1, unavailable: "no reference price has been read yet", at: null })]) {
      expect(await outcome(checkOutsidePrice("stake", via(f)))).toBe(PRICE_UNCHECKABLE);
      expect(await outcome(checkOutsidePrice("unstake", via(f)))).toBe(PRICE_UNCHECKABLE);
    }
    expect(await outcome(checkOutsidePrice("stake", via(json({ v: 1, usd: 250, sources: 2, at: AT }))))).toBeUndefined();
  });
});

describe("a veto only, on v3.2 only", () => {
  it("gives back nothing when it lets a trade go: no amount, minimum or floor can come out of it", async () => {
    const v = outsidePriceVeto(D32, deps());
    expect(await v?.stake()).toBeUndefined();
    expect(await v?.unstake()).toBeUndefined();
  });

  it("is none for v3-launch's shape (v3, no lenses) or a v2 deployment, so their flows are exactly as they were", () => {
    const d = deps();
    expect(outsidePriceVeto(D3, d)).toBeUndefined();
    expect(outsidePriceVeto(D, d)).toBeUndefined();
    expect(d.quoteBuy).not.toHaveBeenCalled();
    expect(outsidePriceVeto(D32, d)).toBeDefined();
  });

  it("on a v3.2 deployment with no indexer (no build makes one: config.ts), every stake and unstake fails closed", async () => {
    const noIndexer: Deployment = { ...D32 };
    delete noIndexer.indexerUrl;
    let asked = 0;
    const v = outsidePriceVeto(noIndexer, deps({ reference: () => fetchReference(noIndexer, { fetch: (async () => (asked++, new Response("{}"))) as typeof fetch }) }));
    expect(await outcome(v!.stake())).toBe(PRICE_UNCHECKABLE);
    expect(await outcome(v!.unstake())).toBe(PRICE_UNCHECKABLE);
    expect(asked).toBe(0);
  });

  it("reads the pools on the second Base RPC first (the one the pre-send checks use), on the first when that can't answer, along the trade's route", async () => {
    type Read = { address: string; abi: unknown; functionName: string; args: readonly unknown[] };
    // the quoter's outputs as viem's readContract gives them, the amount first: $100 buys 0.4 TAO, 0.5 TAO sells for
    // $125 ($250 a TAO either way)
    const quoted = (p: Read) => [p.args[0] === PATH_USDC_TO_TAO ? 4n * 10n ** 17n : 125_000_000n, [], [], 0n];
    const check = { readContract: vi.fn(async (p: Read) => quoted(p)) };
    const first = { readContract: vi.fn(async (p: Read) => quoted(p)), getBlock: vi.fn(async () => ({ timestamp: BigInt(AT + 30) })) };
    const live = liveVetoDeps(D32, { base: first, baseCheck: check } as never);
    expect(await live.quoteBuy(STAKE_PROBE_USDC)).toBe(4n * 10n ** 17n);
    expect(await live.quoteSell(SALE_PROBE_TAO)).toBe(125_000_000n);
    expect(check.readContract.mock.calls.map(([p]) => [p.address, p.abi, p.functionName, p.args])).toEqual([
      [UNISWAP.quoter, QUOTER, "quoteExactInput", [PATH_USDC_TO_TAO, STAKE_PROBE_USDC]],
      [UNISWAP.quoter, QUOTER, "quoteExactInput", [PATH_TAO_TO_USDC, SALE_PROBE_TAO]],
    ]);
    expect(first.readContract).not.toHaveBeenCalled();
    // the second RPC down: the first answers
    const down = { readContract: vi.fn(async () => Promise.reject(new Error("HTTP request failed"))) };
    const fallback = liveVetoDeps(D32, { base: first, baseCheck: down } as never);
    expect(await fallback.quoteBuy(STAKE_PROBE_USDC)).toBe(4n * 10n ** 17n);
    expect(first.readContract).toHaveBeenCalledOnce();
  });
});

describe("the clock the reading's age is judged by: the later of the two Base RPCs' latest blocks, never the device's", () => {
  type Read = { args: readonly unknown[] };
  // the pools at $250 on either RPC: $100 buys 0.4 TAO, 0.5 TAO sells for $125
  const quoted = (p: Read) => [p.args[0] === PATH_USDC_TO_TAO ? 4n * 10n ** 17n : 125_000_000n, [], [], 0n];
  /** An RPC whose latest block is at `blockS` (unix s), or whose block read is refused ("refused") or never answers. */
  const rpc = (blockS: number | "refused" | "hangs") => ({
    readContract: vi.fn(async (p: Read) => quoted(p)),
    getBlock: vi.fn(async () => {
      if (blockS === "refused") throw new Error("HTTP request failed. Status: 429");
      if (blockS === "hangs") return new Promise<never>(() => undefined);
      return { timestamp: BigInt(blockS), number: 1n };
    }),
  });
  /** The live check, with the indexer's reading given (`at` AT). */
  const live = (base: ReturnType<typeof rpc>, baseCheck: ReturnType<typeof rpc>, o?: { clockTimeoutMs?: number }) => ({
    ...liveVetoDeps(D32, { base, baseCheck } as never, o),
    reference: async () => fresh(),
  });
  const both = async (d: VetoDeps) => [await outcome(checkOutsidePrice("stake", d)), await outcome(checkOutsidePrice("unstake", d))];
  const closed = [PRICE_UNCHECKABLE, PRICE_UNCHECKABLE];
  /** The device clock, set to `s` (unix s); timers stay real. */
  const deviceAt = (s: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(s * 1000);
  };
  afterEach(() => vi.useRealTimers());

  it("the review's case: the main RPC's block read refused, the device clock 35 minutes behind, a 40-minute-old reading: refused both ways", async () => {
    // the device thinks the reading is 5 minutes old; it is 40
    deviceAt(AT + 5 * 60);
    // as the review's probe had it: the second RPC answers the quotes, and gives no block either
    const noBlock = { readContract: vi.fn(async (p: Read) => quoted(p)) };
    expect(await both({ ...liveVetoDeps(D32, { base: rpc("refused"), baseCheck: noBlock } as never), reference: async () => fresh() })).toEqual(closed);
    // the second RPC's block at the real time: the reading is 40 minutes old by it
    expect(await both(live(rpc("refused"), rpc(AT + 40 * 60)))).toEqual(closed);
  });

  it("a main RPC lagging behind a fresh second one: the later block decides, either way round", async () => {
    // the reading is 40 minutes old; one server is 35 minutes behind the chain
    expect(await both(live(rpc(AT + 5 * 60), rpc(AT + 40 * 60)))).toEqual(closed);
    expect(await both(live(rpc(AT + 40 * 60), rpc(AT + 5 * 60)))).toEqual(closed);
    expect(await live(rpc(AT + 5 * 60), rpc(AT + 40 * 60)).nowMs()).toBe((AT + 40 * 60) * 1000);
    expect(await live(rpc(AT + 40 * 60), rpc(AT + 5 * 60)).nowMs()).toBe((AT + 40 * 60) * 1000);
    // a fresh reading (1 minute old by the later block) goes ahead
    expect(await both(live(rpc(AT - 10 * 60), rpc(AT + 60)))).toEqual([undefined, undefined]);
  });

  it("both block reads failing: refused, whatever the device clock says (it is never asked)", async () => {
    // the device clock agrees the reading is fresh: it isn't asked
    deviceAt(AT + 30);
    expect(await both(live(rpc("refused"), rpc("refused")))).toEqual(closed);
    await expect(live(rpc("refused"), rpc("refused")).nowMs()).rejects.toThrow();
  });

  it("one RPC answering is enough; one that doesn't answer in time isn't waited for", async () => {
    expect(CLOCK_READ_TIMEOUT_MS).toBe(5_000);
    expect(await live(rpc("refused"), rpc(AT + 30)).nowMs()).toBe((AT + 30) * 1000);
    expect(await live(rpc(AT + 30), rpc("refused")).nowMs()).toBe((AT + 30) * 1000);
    const started = Date.now();
    expect(await live(rpc("hangs"), rpc(AT + 30), { clockTimeoutMs: 30 }).nowMs()).toBe((AT + 30) * 1000);
    await expect(live(rpc("hangs"), rpc("hangs"), { clockTimeoutMs: 30 }).nowMs()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("is read from both RPCs' latest block, after the reading is in", async () => {
    const base = rpc(AT + 30);
    const baseCheck = rpc(AT + 31);
    const order: string[] = [];
    const d = { ...live(base, baseCheck), reference: async () => (order.push("reference"), fresh()) };
    base.getBlock.mockImplementation(async () => (order.push("block"), { timestamp: BigInt(AT + 30), number: 1n }));
    expect(await outcome(checkOutsidePrice("stake", d))).toBeUndefined();
    expect(order).toEqual(["reference", "block"]);
    expect(base.getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
    expect(baseCheck.getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
  });
});

describe("where the site makes the check (use-flows.ts)", () => {
  /** use-flows.ts without its comments: what runs. */
  const code = readFileSync(fileURLToPath(new URL("./use-flows.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  /** One entry of the object useFlows returns, up to the next one. */
  const block = (name: string) => {
    const start = code.indexOf(`\n    ${name}: (`);
    expect(start, name).toBeGreaterThan(0);
    const next = /\n {4}[A-Za-z]+(: \(|\()/g;
    next.lastIndex = start + 1;
    const end = next.exec(code)?.index ?? code.length;
    return code.slice(start, end);
  };

  it("before a v3.2 unstake is recorded or anything sent, so a refused one leaves nothing in Activity", () => {
    // the unstake's checks (delivery-limit.ts usdcUnstakeChecks, whose behaviour delivery-limit.test.ts holds) end with it
    const unstake = block("unstake");
    expect(unstake.indexOf("veto: priceVeto()?.unstake")).toBeGreaterThan(0);
    expect(unstake.indexOf("veto: priceVeto()?.unstake")).toBeLessThan(unstake.indexOf("data.opLog.put(op)"));
  });

  it("in a fresh stake and in one carried on, as the plans' own veto (after the oracle's check, before any wallet prompt)", () => {
    // R8: a stake and a stake after sending the full batch first both go by stakeIn, whose plan carries the veto
    const stakeIn = code.slice(code.indexOf("async function stakeIn("), code.indexOf("\n  }\n", code.indexOf("async function stakeIn(")));
    expect(stakeIn).toContain("veto: priceVeto()?.stake");
    for (const name of ["stake", "closeThenStake"]) expect(block(name), name).toContain("stakeIn(q, onStart)");
    // R9 (M-1): a stake after sending the full batch first asks the oracle and the veto before the close is paid for, the
    // veto after the oracle's check as in the plans
    const close = block("closeThenStake");
    const oracle = close.indexOf("await assertPriceAgrees(q, oracle)");
    const veto = close.indexOf("await priceVeto()?.stake()");
    expect(oracle).toBeGreaterThan(0);
    expect(veto).toBeGreaterThan(oracle);
    expect(veto).toBeLessThan(close.indexOf("await closeFirst({"));
    expect(block("resumeStake")).toContain("veto: priceVeto()?.stake");
    // the veto comes from the deployment: none but v3.2's has one
    expect(code).toMatch(/const priceVeto = \(\) => outsidePriceVeto\(d\(\), liveVetoDeps\(d\(\), data\.clients\)\);/);
  });

  it("nowhere on the ways out: a claim, a cancel or a swap of wallet TAO never waits on it", () => {
    for (const name of ["claim", "resumeClaim", "sellWalletTao", "cancel", "depositWalletTao", "sendNow"]) expect(block(name), name).not.toContain("priceVeto");
  });
});
