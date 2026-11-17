import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, getAddress, type Hex, HttpRequestError, parseAbi } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FRONT_DOOR_V32, ORACLE_V32, QUOTER, STAKER_V32 } from "./abi";
import { DELIVERY_TOLERANCE_BPS, type Deployment, PATH_TAO_TO_USDC, UNISWAP } from "./config";
import {
  clickRefusal,
  type DeliveryLimit,
  type DeliveryMarket,
  deliverableRefusal,
  deliveryFloorPerTao,
  findDeliveryLimit,
  KEEPER_ROOM_BPS,
  LIMIT_STAGES,
  LIMIT_STEPS,
  LIMIT_UNREAD,
  limitText,
  NO_DELIVERY,
  pointToTao,
  RECEIVE_TAO_POINTER,
  saleClears,
  saleOf,
  type SaleQuoteAt,
  usdcUnstakeChecks,
  waitingText,
  WAITING_UNKNOWN,
} from "./delivery-limit";
import { FlowError } from "./flows";
import { IMPACT_REFUSED, IMPACT_UNKNOWN } from "./impact";
import { PRICE_OFF_MARKET, PRICE_UNCHECKABLE } from "./price-veto";
import { quoteDeliveries, readDeliveryMarket, readDeliveryPreference } from "./reads";
import type { WithdrawalQuote } from "./types";

// v3.2's live USDC delivery limit (Task 59a; the founder's decision on R3 C-L2, 2026-11-05: "Guide bigger [unstakes]
// back to TAO and be clear with how much we can do at that moment"). The front door's deliver sells everything credited
// to the user at once, and only when the sale clears every floor: the pools' depth (minPoolLiquidity, ThinPool), the
// TWAP's less maxDeliverySlippageBps, the user's own minimum; and the keeper sends only with its 0.5% of room over them
// (ops/src/keeper/delivery.ts), along the staker's live delivery route. The form shows the largest sale that clears right
// now and refuses USDC above it; the click checks the request at the minimum it sends (Task 59a fix round 1, I2).

const TAO = 10n ** 18n;
/** The staker's route 0 as the launch sets it: TAO -0.3%-> WETH -0.05%-> USDC. */
const ROUTE: Hex = PATH_TAO_TO_USDC;
/** The market as v3.2's launch sets it: 1.5% under the TWAP, Cascade's 0.15% on the sale, pools deep enough. */
const MARKET: DeliveryMarket = { thin: false, slippageBps: 150n, swapFeeBps: 15n, minUsdcPerTao: 243_000_000n, sellPath: ROUTE, blockNumber: 40_000_000n };

/** A pool at $250 a TAO (USDC units per TAO wei, scaled), the TWAP the same, whose sale of `s` pays its fees (0.35%)
 * and loses `impactPerTao` (in 1e6ths) of its value for each whole TAO sold. */
function pool(impactPerTao = 2_000n, twapPerTao = 250_000_000n) {
  return (s: bigint): SaleQuoteAt => {
    const mid = (s * 250_000_000n) / TAO;
    const kept = 1_000_000n - 3_500n - (impactPerTao * s) / TAO;
    return { taoWei: s, grossUsdc: kept > 0n ? (mid * kept) / 1_000_000n : 0n, twapUsdc: (s * twapPerTao) / TAO };
  };
}
const readerOf = (at: (s: bigint) => SaleQuoteAt) => vi.fn(async (sizes: readonly bigint[]) => sizes.map(at));

/** The largest sale that clears, to the wei, by bisection: what the search must come within 0.4% of. */
function exactLimit(at: (s: bigint) => SaleQuoteAt, cap: bigint, m: DeliveryMarket = MARKET): bigint {
  let lo = 0n;
  let hi = cap + 1n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (saleClears(m, at(mid))) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The gross a sale must pay for its net (after the staker's 0.15%) to be at least `net`. */
function grossFor(net: bigint): bigint {
  let g = (net * 10_000n) / 9_985n;
  while (g - (g * 15n) / 10_000n < net) g++;
  return g;
}

describe("whether one sale clears every floor deliver and the keeper apply", () => {
  /** A sale whose net (after the staker's 0.15%) is `net` USDC units, against a TWAP of `twap`. */
  const sale = (taoWei: bigint, net: bigint, twap: bigint): SaleQuoteAt => ({ taoWei, grossUsdc: grossFor(net), twapUsdc: twap });

  it("goes by the keeper's room: its minimum, the quote less 0.5%, must reach the TWAP's floor (1.5% under it)", () => {
    const twap = 250_000_000n;
    const twapFloor = (twap * 9_850n) / 10_000n; // 246,250,000
    // the quote less 0.5% exactly at the floor clears (deliver's own >=); one unit under it waits
    const atFloor = (twapFloor * 10_000n + 9_949n) / 9_950n;
    expect(saleClears({ ...MARKET, minUsdcPerTao: 0n }, { taoWei: TAO, grossUsdc: grossFor(atFloor), twapUsdc: twap })).toBe(true);
    expect(saleClears({ ...MARKET, minUsdcPerTao: 0n }, { taoWei: TAO, grossUsdc: grossFor(atFloor - 300n), twapUsdc: twap })).toBe(false);
    // a quote right at the floor itself has no room, so the keeper waits for a better one (as ops' deliveryDecision)
    expect(saleClears({ ...MARKET, minUsdcPerTao: 0n }, { taoWei: TAO, grossUsdc: grossFor(twapFloor), twapUsdc: twap })).toBe(false);
  });

  it("goes by the user's own floor, rounded up as the front door rounds it", () => {
    const m = { ...MARKET, slippageBps: 300n, minUsdcPerTao: 1_000_001n };
    // 1 TAO at 1,000,001 units: the user's floor is exactly that; 1.5 TAO: 1,500,001.5, rounded up to 1,500,002
    const room = (keeperMin: bigint) => (keeperMin * 10_000n + 9_949n) / 9_950n;
    expect(saleClears(m, sale(TAO, room(1_000_001n), 0n))).toBe(true);
    expect(saleClears(m, sale(TAO, room(1_000_001n) - 2n, 0n))).toBe(false);
    expect(saleClears(m, sale((3n * TAO) / 2n, room(1_500_002n), 0n))).toBe(true);
    expect(saleClears(m, sale((3n * TAO) / 2n, room(1_500_001n), 0n))).toBe(false);
  });

  it("never clears while a pool is thinner than its floor, the staker's route can't deliver, a sale couldn't be quoted, or nothing is sold", () => {
    const good = pool()(TAO);
    expect(saleClears(MARKET, good)).toBe(true);
    expect(saleClears({ ...MARKET, thin: true }, good)).toBe(false);
    expect(saleClears({ ...MARKET, sellPath: null }, good)).toBe(false);
    expect(saleClears(MARKET, { ...good, grossUsdc: undefined })).toBe(false);
    expect(saleClears(MARKET, { ...good, twapUsdc: undefined })).toBe(false);
    expect(saleClears(MARKET, { taoWei: 0n, grossUsdc: 0n, twapUsdc: 0n })).toBe(false);
  });

  it("keeps the keeper's room exactly as the keeper does (ops/src/keeper/core/delivery.ts), never retyped by hand", () => {
    const keeper = readFileSync(fileURLToPath(new URL("../../../../ops/src/keeper/core/delivery.ts", import.meta.url)), "utf8");
    expect(keeper).toMatch(new RegExp(`const KEEPER_ROOM_BPS = ${KEEPER_ROOM_BPS}n;`));
    // the floors it waits for: the user's (rounded up) and the TWAP's less the front door's maxDeliverySlippageBps
    expect(keeper).toContain("const userFloor = (i.claimable * pref.minUsdcPerTao + 10n ** 18n - 1n) / 10n ** 18n;");
    expect(keeper).toContain("const twapFloor = (i.twapUsdc * BigInt(10_000 - i.slippageBps)) / 10_000n;");
    expect(keeper).toContain("const keeperMinOut = (i.quoteUsdc * (10_000n - KEEPER_ROOM_BPS)) / 10_000n;");
    // the route it quotes: the staker's live delivery route, Uniswap v3's alone (v3.2's reads, ops/src/keeper/core/v32/reads.ts)
    const state = readFileSync(fileURLToPath(new URL("../../../../ops/src/keeper/core/v32/reads.ts", import.meta.url)), "utf8");
    expect(state).toContain('const routeId = Number(await r("base", staker, STAKER, "deliveryRouteId"));');
    expect(state).toContain("if (kind !== UNISWAP_V3) {");
    // and the front door's own: the larger of the user's (ceil), the keeper's and the TWAP's less the slippage
    const door = readFileSync(fileURLToPath(new URL("../../../../contracts/src/CascadeFrontDoor.sol", import.meta.url)), "utf8");
    expect(door).toContain("uint256 userFloor = Math.mulDiv(amount, d.minUsdcPerTao, 1e18, Math.Rounding.Ceil);");
    expect(door).toContain("uint256 marketFloor = o.usdcValue(amount) * (10_000 - maxDeliverySlippageBps) / 10_000;");
    expect(door).toContain("if (taoWeth < minPoolLiquidity[0]) revert ThinPool(0, taoWeth);");
    expect(door).toContain("if (wethUsdc < minPoolLiquidity[1]) revert ThinPool(1, wethUsdc);");
    // and the staker's sale: along routes[deliveryRouteId], refused while that route is off (CascadeStaker.sellFor)
    const staker = readFileSync(fileURLToPath(new URL("../../../../contracts/src/CascadeStaker.sol", import.meta.url)), "utf8");
    expect(staker).toContain("Route storage route = routes[deliveryRouteId];");
    expect(staker).toContain("if (!route.active) revert RouteInactive();");
  });
});

describe("the largest sale that clears right now", () => {
  it("is found within 0.4% of the exact limit, and never above it", async () => {
    for (const [impact, cap] of [
      [2_000n, 40n * TAO],
      [500n, 40n * TAO],
      [8_000n, 10n * TAO],
      [2_000n, 7_123_456_789_000_000_000n],
    ] as const) {
      const at = pool(impact);
      const found = await findDeliveryLimit(cap, MARKET, readerOf(at));
      const exact = exactLimit(at, cap);
      expect(exact > 0n && exact < cap, `${impact}`).toBe(true);
      expect(found.clearsAll).toBe(false);
      expect(found.saleTaoWei <= exact, `${impact}`).toBe(true);
      expect((exact - found.saleTaoWei) * 1_000n <= exact * 4n, `${impact}: ${found.saleTaoWei} vs ${exact}`).toBe(true);
      expect(saleClears(MARKET, at(found.saleTaoWei))).toBe(true);
      // what that sale pays, after the staker's fee
      const g = at(found.saleTaoWei).grossUsdc as bigint;
      expect(found.saleUsdc).toBe(g - (g * 15n) / 10_000n);
    }
  });

  it("asks the account's whole TAO first; when that clears, nothing else is read (most accounts)", async () => {
    const read = readerOf(pool(500n));
    const found = await findDeliveryLimit(2n * TAO, MARKET, read);
    expect(found).toEqual({ saleTaoWei: 2n * TAO, saleUsdc: expect.any(BigInt), clearsAll: true });
    expect(read.mock.calls).toEqual([[[2n * TAO]]]);
  });

  it("otherwise reads a few batches of sizes, smallest first: four of sixteen at most", async () => {
    const read = readerOf(pool());
    await findDeliveryLimit(40n * TAO, MARKET, read);
    expect(LIMIT_STAGES).toBe(4);
    expect(LIMIT_STEPS).toBe(16);
    expect(read.mock.calls.length).toBeLessThanOrEqual(LIMIT_STAGES);
    expect(read.mock.calls[0]).toEqual([[40n * TAO]]);
    for (const [sizes] of read.mock.calls) {
      expect(sizes.length).toBeLessThanOrEqual(LIMIT_STEPS);
      expect([...sizes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([...sizes]);
      for (const s of sizes) expect(s > 0n && s <= 40n * TAO).toBe(true);
    }
  });

  it("is nothing while the TWAP sits above the pools (a fall the 30-minute average hasn't caught up with)", async () => {
    const found = await findDeliveryLimit(40n * TAO, MARKET, readerOf(pool(2_000n, 260_000_000n)));
    expect(found).toEqual({ saleTaoWei: 0n, saleUsdc: 0n, clearsAll: false });
  });

  it("is nothing, without a quote, while a pool is thinner than its floor or the staker's delivery route can't deliver", async () => {
    const read = readerOf(pool());
    const none = { saleTaoWei: 0n, saleUsdc: 0n, clearsAll: false };
    expect(await findDeliveryLimit(40n * TAO, { ...MARKET, thin: true }, read)).toEqual(none);
    expect(await findDeliveryLimit(40n * TAO, { ...MARKET, sellPath: null }, read)).toEqual(none);
    expect(read).not.toHaveBeenCalled();
    expect(await findDeliveryLimit(0n, MARKET, read)).toEqual(none);
  });

  it("counts a size the market refused (a revert, read as unknown) as one that doesn't clear", async () => {
    const at = pool();
    const failingAbove = (s: bigint): SaleQuoteAt => (s > TAO ? { ...at(s), grossUsdc: undefined } : at(s));
    const found = await findDeliveryLimit(40n * TAO, MARKET, readerOf(failingAbove));
    expect(found.saleTaoWei <= TAO).toBe(true);
    expect(found.saleTaoWei > 0n).toBe(true);
  });

  it("rejects when the market can't be read (any failure but a revert): unreadable, never 'no delivery'", async () => {
    const down = vi.fn(async () => Promise.reject(new HttpRequestError({ url: "https://mainnet.base.org", status: 429 })));
    await expect(findDeliveryLimit(40n * TAO, MARKET, down)).rejects.toBeInstanceOf(HttpRequestError);
  });
});

describe("the user's floor a USDC request sets now (the delivery terms' rule)", () => {
  it("is the 1-TAO sale after the staker's fee, less the delivery tolerance (2%), as quoteWithdrawal sets it", () => {
    const gross = 250_000_000n;
    const net = gross - (gross * 15n) / 10_000n;
    expect(deliveryFloorPerTao(gross, 15n)).toBe((net * (10_000n - BigInt(DELIVERY_TOLERANCE_BPS))) / 10_000n);
  });
});

// ---- the reads: every floor and the route from the contracts, at one block ----

const D32: Deployment = {
  frontDoor: getAddress("0x00000000000000000000000000000000000fd032"),
  baseAdapter: getAddress("0x00000000000000000000000000000000000ba032"),
  vault: getAddress("0x00000000000000000000000000000000000fa032"),
  bitAdapter: getAddress("0x00000000000000000000000000000000000b1032"),
  bitBlock: 1n,
  vaultSs58: "x",
  hotkeySs58: "y",
  staker: getAddress("0x00000000000000000000000000000000005a4e12"),
  oracle: getAddress("0x000000000000000000000000000000000000041e"),
  vaultLens: getAddress("0x000000000000000000000000000000000000Ae15"),
  doorLens: getAddress("0x000000000000000000000000000000000000De15"),
  indexerUrl: "https://api.cascadefi.xyz",
};

type Contract = { address: string; abi: unknown; functionName: string; args?: readonly unknown[] };
type Asked = { contracts: Contract[]; blockNumber?: bigint };

/** A revert as viem's multicall reports it for one call (Multicall3 ran it and it reverted). */
const reverted = () =>
  new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: parseAbi(["function f()"]), functionName: "f" }), {
    abi: parseAbi(["function f()"]),
    functionName: "f",
    contractAddress: UNISWAP.quoter,
  });

describe("reading the market a delivery would meet", () => {
  const OTHER_ROUTE: Hex = "0x00000000000000000000000000000000000000aa0001f400000000000000000000000000000000000000bb";
  type Answers = { liquidity: [bigint, bigint]; floors: [bigint, bigint]; slippage: number; fee: number; routeId: number; route: [number, Hex, boolean]; oneTao: bigint };
  /** A Base client at block 40,000,000: its multicalls and reads answered by name, recording what was asked and at which block. */
  function client(a: Answers) {
    const asked: Asked[] = [];
    const answer = (x: Contract) => {
      if (x.functionName === "meanLiquidity") return a.liquidity;
      if (x.functionName === "minPoolLiquidity") return a.floors[Number(x.args?.[0])];
      if (x.functionName === "maxDeliverySlippageBps") return a.slippage;
      if (x.functionName === "swapFeeBps") return a.fee;
      if (x.functionName === "deliveryRouteId") return a.routeId;
      if (x.functionName === "routes") return [a.route[0], getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"), "0x", a.route[1], a.route[2]];
      if (x.functionName === "quoteExactInput") return [a.oneTao, [], [], 0n];
      throw new Error(`unexpected ${x.functionName}`);
    };
    const base = {
      getBlockNumber: vi.fn(async () => 40_000_000n),
      multicall: vi.fn(async ({ contracts, blockNumber }: Asked) => (asked.push({ contracts, blockNumber }), contracts.map(answer))),
      readContract: vi.fn(async (x: Contract & { blockNumber?: bigint }) => (asked.push({ contracts: [x], blockNumber: x.blockNumber }), answer(x))),
    };
    return { c: { base } as never, asked, base };
  }
  const deep: Answers = {
    liquidity: [7n * 10n ** 20n, 9n * 10n ** 17n],
    floors: [10n ** 20n, 10n ** 17n],
    slippage: 150,
    fee: 15,
    routeId: 0,
    route: [0, ROUTE, true],
    oneTao: 250_000_000n,
  };
  const calls = (x: Asked) => x.contracts.map((y) => [y.address, y.functionName, ...(y.args ?? [])]);

  it("reads the front door's slippage and depth floors, the oracle's depth, the staker's fee and live delivery route, all at one block", async () => {
    const { c, asked } = client(deep);
    const m = await readDeliveryMarket(c, D32);
    expect(m).toEqual({ thin: false, slippageBps: 150n, swapFeeBps: 15n, minUsdcPerTao: deliveryFloorPerTao(250_000_000n, 15n), sellPath: ROUTE, blockNumber: 40_000_000n });
    expect(calls(asked[0])).toEqual([
      [D32.oracle, "meanLiquidity"],
      [D32.frontDoor, "minPoolLiquidity", 0n],
      [D32.frontDoor, "minPoolLiquidity", 1n],
      [D32.frontDoor, "maxDeliverySlippageBps"],
      [D32.staker, "swapFeeBps"],
      [D32.staker, "deliveryRouteId"],
    ]);
    expect(asked[0].contracts.map((x) => x.abi)).toEqual([ORACLE_V32, FRONT_DOOR_V32, FRONT_DOOR_V32, FRONT_DOOR_V32, STAKER_V32, STAKER_V32]);
    // the route by its id, then the 1-TAO sale along its own path (as the keeper quotes it)
    expect(calls(asked[1])).toEqual([[D32.staker, "routes", 0]]);
    expect(calls(asked[2])).toEqual([[UNISWAP.quoter, "quoteExactInput", ROUTE, 10n ** 18n]]);
    expect(asked[2].contracts[0].abi).toBe(QUOTER);
    for (const a of asked) expect(a.blockNumber).toBe(40_000_000n);
  });

  it("follows whatever the contracts say now: another slippage, fee and route", async () => {
    const { c, asked } = client({ ...deep, slippage: 90, fee: 25, routeId: 3, route: [0, OTHER_ROUTE, true] });
    const moved = await readDeliveryMarket(c, D32);
    expect(moved).toEqual({ thin: false, slippageBps: 90n, swapFeeBps: 25n, minUsdcPerTao: deliveryFloorPerTao(250_000_000n, 25n), sellPath: OTHER_ROUTE, blockNumber: 40_000_000n });
    expect(calls(asked[1])).toEqual([[D32.staker, "routes", 3]]);
    expect(calls(asked[2])).toEqual([[UNISWAP.quoter, "quoteExactInput", OTHER_ROUTE, 10n ** 18n]]);
  });

  it("can't deliver along a route that is off, or one the quoter can't price (not Uniswap v3): no path, as the keeper waits", async () => {
    for (const route of [[0, ROUTE, false], [1, ROUTE, true]] as [number, Hex, boolean][]) {
      const { c, asked } = client({ ...deep, route });
      expect(await readDeliveryMarket(c, D32)).toMatchObject({ sellPath: null, minUsdcPerTao: 0n });
      expect(asked).toHaveLength(2);
    }
  });

  it("is thin when either pool's mean is under its floor; a pool exactly at its floor passes (deliver's own <)", async () => {
    expect((await readDeliveryMarket(client({ ...deep, liquidity: [10n ** 20n - 1n, 9n * 10n ** 17n] }).c, D32)).thin).toBe(true);
    expect((await readDeliveryMarket(client({ ...deep, liquidity: [7n * 10n ** 20n, 10n ** 17n - 1n] }).c, D32)).thin).toBe(true);
    expect((await readDeliveryMarket(client({ ...deep, liquidity: [10n ** 20n, 10n ** 17n] }).c, D32)).thin).toBe(false);
    // a floor of 0 checks nothing
    expect((await readDeliveryMarket(client({ ...deep, liquidity: [0n, 0n], floors: [0n, 0n] }).c, D32)).thin).toBe(false);
  });

  it("reads whether the account has a delivery preference set (deliveryOf), on chain", async () => {
    const answer = (min: bigint) => ({ base: { readContract: vi.fn(async () => [min, 1_800_000_000n, 6]) } }) as never;
    expect(await readDeliveryPreference(answer(243_000_000n), D32, getAddress("0x000000000000000000000000000000000000a11c"))).toBe(true);
    expect(await readDeliveryPreference(answer(0n), D32, getAddress("0x000000000000000000000000000000000000a11c"))).toBe(false);
  });

  describe("quoting each size", () => {
    /** A multicall answering `fail(i)` for call i (a revert, or a whole chunk the RPC refused), the rest by the pool. */
    function sizes(fail: (i: number) => unknown) {
      const asked: Asked[] = [];
      const multicall = vi.fn(async ({ contracts, blockNumber, allowFailure }: Asked & { allowFailure: boolean }) => {
        expect(allowFailure).toBe(true);
        asked.push({ contracts, blockNumber });
        return contracts.map((x, i) => {
          const f = fail(i);
          if (f) return { status: "failure", error: f };
          return { status: "success", result: x.functionName === "quoteExactInput" ? [((x.args?.[1] as bigint) * 249n) / 10n ** 12n, [], [], 0n] : ((x.args?.[0] as bigint) * 250n) / 10n ** 12n };
        });
      });
      return { c: { base: { multicall } } as never, asked };
    }

    it("quotes each along the route read and with the oracle's value of it, at the market's block; a revert reads as unknown", async () => {
      const { c, asked } = sizes((i) => (i === 2 ? reverted() : undefined));
      const sales = await quoteDeliveries(c, D32, [TAO, 2n * TAO], { sellPath: OTHER_ROUTE, blockNumber: 39_999_999n });
      expect(calls(asked[0])).toEqual([
        [UNISWAP.quoter, "quoteExactInput", OTHER_ROUTE, TAO],
        [D32.oracle, "usdcValue", TAO],
        [UNISWAP.quoter, "quoteExactInput", OTHER_ROUTE, 2n * TAO],
        [D32.oracle, "usdcValue", 2n * TAO],
      ]);
      expect(asked[0].blockNumber).toBe(39_999_999n);
      expect(sales).toEqual([
        { taoWei: TAO, grossUsdc: 249_000_000n, twapUsdc: 250_000_000n },
        { taoWei: 2n * TAO, grossUsdc: undefined, twapUsdc: 500_000_000n },
      ]);
    });

    it("rejects when a call failed for any other reason (the RPC's 429, a timeout): unreadable, never 'doesn't clear'", async () => {
      const { c } = sizes((i) => (i === 1 ? new HttpRequestError({ url: "https://mainnet.base.org", status: 429 }) : undefined));
      await expect(quoteDeliveries(c, D32, [TAO], { sellPath: ROUTE, blockNumber: 1n })).rejects.toBeInstanceOf(HttpRequestError);
    });

    it("asks nothing along no route: every sale unknown", async () => {
      const { c, asked } = sizes(() => undefined);
      expect(await quoteDeliveries(c, D32, [TAO], { sellPath: null, blockNumber: 1n })).toEqual([{ taoWei: TAO, grossUsdc: undefined, twapUsdc: undefined }]);
      expect(asked).toEqual([]);
    });
  });
});

// ---- the form and the click: refuse or allow, never change ----

/** A USDC unstake's quote: `tao` TAO of shares, a bridge fee of 0.001 TAO, its floor `floor` USDC units per TAO. */
const quoteOf = (tao: bigint, floor = 243_000_000n): WithdrawalQuote =>
  Object.freeze({ shares: tao * 10n ** 6n, taoWei: tao, bridgeFeeWei: 10n ** 15n, minUsdcPerTao: floor, deliveryDeadline: 1_800_000_000 }) as WithdrawalQuote;
/** Right now 5 TAO clears, paying 1,240 USDC. */
const LIMIT: DeliveryLimit = Object.freeze({ waitingTaoWei: 0n, waitingComplete: true, preferenceSet: false, saleTaoWei: 5n * TAO, saleUsdc: 1_240_000_000n, clearsAll: false });

describe("a USDC unstake against the live limit", () => {
  it("sells the payout (its TAO less the bridge fee) with everything of the account's waiting", () => {
    expect(saleOf(quoteOf(TAO), 0n)).toBe(TAO - 10n ** 15n);
    expect(saleOf(quoteOf(TAO), 2n * TAO)).toBe(3n * TAO - 10n ** 15n);
    expect(saleOf(quoteOf(10n ** 14n), 0n)).toBe(0n);
  });

  it("under the limit passes, at it passes, over it is refused in the plain words, with the live figure", () => {
    expect(deliverableRefusal(quoteOf(3n * TAO), LIMIT)).toBeNull();
    expect(deliverableRefusal(quoteOf(5n * TAO + 10n ** 15n), LIMIT)).toBeNull();
    expect(deliverableRefusal(quoteOf(5n * TAO + 10n ** 15n + 1n), LIMIT)).toBe(
      "Right now up to 1,240.00 USDC can be delivered. Above that, receive TAO and claim it on Base.",
    );
    expect(limitText(LIMIT)).toBe("Right now up to 1,240.00 USDC can be delivered. Above that, receive TAO and claim it on Base.");
  });

  it("counts what of the account's already waits, the room for this one being what is left", () => {
    const waiting = { ...LIMIT, waitingTaoWei: TAO };
    expect(deliverableRefusal(quoteOf(4n * TAO), waiting)).toBeNull();
    // the room for this one is the 4 TAO left, 992 of the 1,240 USDC
    expect(deliverableRefusal(quoteOf(4n * TAO + 2n * 10n ** 15n), waiting)).toBe("Right now up to 992.00 USDC can be delivered. Above that, receive TAO and claim it on Base.");
  });

  it("says, in its own sentence, what else of the account's a USDC unstake sells (the latest request decides for all)", () => {
    expect(waitingText(TAO)).toBe("This also sells the 1.0000 TAO of yours on its way back to Base or waiting there.");
    expect(waitingText(123_456_789_000_000_000n)).toBe("This also sells the 0.1234 TAO of yours on its way back to Base or waiting there.");
    // while not every payout of the account's on its way is read: no figure
    expect(WAITING_UNKNOWN).toBe("A USDC unstake also sells any of your TAO on its way back to Base or waiting there.");
  });

  it("says no USDC delivery can be made when none clears, or the account's own waiting TAO fills the limit", () => {
    const none: DeliveryLimit = { waitingTaoWei: 0n, waitingComplete: true, preferenceSet: false, saleTaoWei: 0n, saleUsdc: 0n, clearsAll: false };
    expect(NO_DELIVERY).toBe("Right now no USDC delivery can be made. Receive TAO and claim it on Base.");
    expect(deliverableRefusal(quoteOf(TAO / 10n), none)).toBe(NO_DELIVERY);
    expect(limitText(none)).toBe(NO_DELIVERY);
    expect(limitText({ ...LIMIT, waitingTaoWei: 6n * TAO })).toBe(NO_DELIVERY);
  });

  it("passes anything when the account's whole TAO clears", () => {
    expect(deliverableRefusal(quoteOf(5n * TAO), { ...LIMIT, saleTaoWei: 9n * TAO, clearsAll: true })).toBeNull();
  });
});

describe("the check at the click: the request's own sale, at the minimum it sends (Task 59a review, I2 and M8)", () => {
  /** The pool's TWAP floor binds at about 2.5 TAO (pool() with 0.2% per TAO); the market's user floor doesn't bind. */
  const at = pool();
  const market = { ...MARKET, minUsdcPerTao: 200_000_000n };

  it("passes on one quote of the sale alone when it clears", async () => {
    const read = readerOf(at);
    expect(await clickRefusal({ q: quoteOf(2n * TAO, 200_000_000n), waitingTaoWei: 0n, capTaoWei: 40n * TAO, market, read })).toBeNull();
    expect(read.mock.calls).toEqual([[[2n * TAO - 10n ** 15n]]]);
  });

  it("counts what of the account's waits in the sale", async () => {
    const read = readerOf(at);
    const refusal = await clickRefusal({ q: quoteOf(2n * TAO, 200_000_000n), waitingTaoWei: TAO, capTaoWei: 40n * TAO, market, read });
    expect(read.mock.calls[0]).toEqual([[3n * TAO - 10n ** 15n]]);
    expect(refusal).toMatch(/^Right now up to .* USDC can be delivered\. Above that, receive TAO and claim it on Base\.$/);
  });

  it("goes by the request's own floor when it is above the market's: a size the market's floor passes is refused", async () => {
    // a quote read when TAO was dearer: its floor is 247 USDC a TAO, over what the pool pays from about 1 TAO on
    const q = quoteOf(2n * TAO, 247_000_000n);
    expect(saleClears(market, at(2n * TAO - 10n ** 15n))).toBe(true);
    const refusal = await clickRefusal({ q, waitingTaoWei: 0n, capTaoWei: 40n * TAO, market, read: readerOf(at) });
    expect(refusal).not.toBeNull();
    // the figure it gives is the limit at that floor, never the market's
    const atFloor = exactLimit(at, 40n * TAO, { ...market, minUsdcPerTao: 247_000_000n });
    expect(atFloor > 0n && atFloor < exactLimit(at, 40n * TAO, market)).toBe(true);
    const usdc = Number((/up to ([\d,.]+) USDC/.exec(refusal as string) ?? ["", "0"])[1].replace(/,/g, ""));
    expect(usdc).toBeGreaterThan(0);
    expect(usdc).toBeLessThanOrEqual(Number(((at(atFloor).grossUsdc as bigint) * 9_985n) / 10_000n) / 1e6);
  });

  it("goes by the market's floor when it is above the request's (the larger of the two)", async () => {
    const q = quoteOf(2n * TAO, 100_000_000n);
    expect(await clickRefusal({ q, waitingTaoWei: 0n, capTaoWei: 40n * TAO, market: { ...market, minUsdcPerTao: 248_000_000n }, read: readerOf(at) })).not.toBeNull();
  });

  it("says no USDC delivery can be made while a pool is thin", async () => {
    expect(await clickRefusal({ q: quoteOf(TAO / 10n), waitingTaoWei: 0n, capTaoWei: TAO, market: { ...market, thin: true }, read: readerOf(at) })).toBe(NO_DELIVERY);
  });
});

describe("a USDC unstake's checks, before anything is recorded (Task 59a review, M10)", () => {
  const ok = () => vi.fn(async () => null as string | null);
  const passing = () => vi.fn(async () => undefined);
  const impacted = (rate: bigint) =>
    Object.freeze({ ...quoteOf(TAO), impact: { tradeIn: 1_000_000n, tradeOut: rate, probeIn: 1_000_000n, probeOut: 1_000_000n } }) as WithdrawalQuote;
  const refusal = (p: Promise<void>) => p.then(() => undefined, (e: unknown) => e as FlowError);

  it("all pass: nothing thrown, the limit and the veto each asked once, the limit first", async () => {
    const deliverable = ok();
    const veto = passing();
    expect(await usdcUnstakeChecks({ v32: true, q: quoteOf(TAO), deliverable, veto })).toBeUndefined();
    expect(deliverable).toHaveBeenCalledOnce();
    expect(veto).toHaveBeenCalledOnce();
    expect(deliverable.mock.invocationCallOrder[0]).toBeLessThan(veto.mock.invocationCallOrder[0]);
  });

  it("over the impact cap: refused at once, pointing to TAO; nothing read", async () => {
    const deliverable = ok();
    const veto = passing();
    const e = await refusal(usdcUnstakeChecks({ v32: true, q: impacted(969_900n), deliverable, veto }));
    expect(e).toBeInstanceOf(FlowError);
    expect(e?.message).toBe(`${IMPACT_REFUSED} ${RECEIVE_TAO_POINTER}`);
    expect(e?.state).toBe("needs-you");
    expect(deliverable).not.toHaveBeenCalled();
    expect(veto).not.toHaveBeenCalled();
    // an impact that couldn't be measured is refused too
    const unmeasured = { ...quoteOf(TAO), impact: { tradeIn: 1n, tradeOut: 1n, probeIn: 1n, probeOut: 0n } } as WithdrawalQuote;
    expect((await refusal(usdcUnstakeChecks({ v32: true, q: unmeasured, deliverable, veto })))?.message).toBe(
      `${IMPACT_UNKNOWN} ${RECEIVE_TAO_POINTER}`,
    );
  });

  it("over the live limit: refused in its words (which already say to receive TAO); the veto isn't asked", async () => {
    const veto = passing();
    const e = await refusal(usdcUnstakeChecks({ v32: true, q: quoteOf(TAO), deliverable: async () => limitText(LIMIT), veto }));
    expect(e?.message).toBe(limitText(LIMIT));
    expect(e?.state).toBe("needs-you");
    expect(veto).not.toHaveBeenCalled();
  });

  it("the limit can't be read: refused as unreadable (fail closed); the veto isn't asked", async () => {
    const veto = passing();
    const e = await refusal(usdcUnstakeChecks({ v32: true, q: quoteOf(TAO), deliverable: async () => Promise.reject(new Error("rpc down")), veto }));
    expect(e?.message).toBe(LIMIT_UNREAD);
    expect(LIMIT_UNREAD).toBe("Can't check how much USDC can be delivered right now. Try again shortly, or receive TAO.");
    expect(veto).not.toHaveBeenCalled();
  });

  it("the veto refuses, or can't check: its words, pointing to TAO", async () => {
    for (const said of [PRICE_OFF_MARKET, PRICE_UNCHECKABLE]) {
      const e = await refusal(usdcUnstakeChecks({ v32: true, q: quoteOf(TAO), deliverable: ok(), veto: async () => Promise.reject(new FlowError(said, "needs-you")) }));
      expect(e?.message).toBe(`${said} ${RECEIVE_TAO_POINTER}`);
    }
  });

  it("v3-launch: no impact cap and no limit asked; its veto (none) as before", async () => {
    const deliverable = ok();
    expect(await usdcUnstakeChecks({ v32: false, q: impacted(500_000n), deliverable })).toBeUndefined();
    expect(deliverable).not.toHaveBeenCalled();
  });

  it("never changes the quote", async () => {
    const q = quoteOf(TAO);
    await usdcUnstakeChecks({ v32: true, q, deliverable: ok(), veto: passing() });
    expect(q).toEqual({ shares: TAO * 10n ** 6n, taoWei: TAO, bridgeFeeWei: 10n ** 15n, minUsdcPerTao: 243_000_000n, deliveryDeadline: 1_800_000_000 });
  });
});

describe("every refusal of a USDC unstake points to receiving TAO", () => {
  it("adds the pointer to the veto's, the impact cap's and any other stop's words, once, keeping its state", () => {
    expect(RECEIVE_TAO_POINTER).toBe("You can receive TAO instead.");
    for (const said of [PRICE_OFF_MARKET, PRICE_UNCHECKABLE, IMPACT_REFUSED]) {
      const e = pointToTao(new FlowError(said, "needs-you")) as FlowError;
      expect(e).toBeInstanceOf(FlowError);
      expect(e.message).toBe(`${said} ${RECEIVE_TAO_POINTER}`);
      expect(e.state).toBe("needs-you");
    }
    // the limit's own words already say it
    for (const said of [limitText(LIMIT), NO_DELIVERY, LIMIT_UNREAD]) expect((pointToTao(new FlowError(said, "needs-you")) as FlowError).message).toBe(said);
    // anything else (a wallet or network error) is left as it is, for userMessage
    const other = new Error("boom");
    expect(pointToTao(other)).toBe(other);
  });
});

describe("where the site makes the checks (use-flows.ts)", () => {
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

  it("a USDC unstake runs its checks (usdcUnstakeChecks, whose behaviour is above) on the click's own reads, before it is recorded", () => {
    const unstake = block("unstake");
    const checks = unstake.indexOf("await usdcUnstakeChecks({");
    expect(checks).toBeGreaterThan(0);
    expect(checks).toBeLessThan(unstake.indexOf("data.opLog.put(op)"));
    expect(unstake).toMatch(/usdcUnstakeChecks\(\{\s*v32: isV32\(d\(\)\),\s*q,\s*deliverable: \(\) => data\.deliveryRefusal\(a, q\),\s*veto: priceVeto\(\)\?\.unstake,\s*\}\)/);
  });

  it("receiving TAO waits on none of them: no veto, no impact cap, no limit, nothing read of the indexer", () => {
    const receive = block("receiveTao");
    for (const check of ["usdcUnstakeChecks", "priceVeto", "impactRefusal", "deliveryRefusal", "getDeliveryLimit", "fetchReference", "indexer"]) expect(receive, check).not.toContain(check);
    expect(receive).toContain("keepTao: true");
    expect(receive).toContain("data.opLog.put(op)");
  });

  it("a stake: the impact cap on its quote before it is recorded, and on a stake carried on, its fresh quote's", () => {
    // R8: a stake is recorded and sent by stakeIn, which a stake and a stake after sending the full batch first both call
    // only once the cap has passed (the latter before its close too)
    const stakeIn = code.slice(code.indexOf("async function stakeIn("), code.indexOf("\n  }\n", code.indexOf("async function stakeIn(")));
    expect(stakeIn).toContain("data.opLog.put(op)");
    for (const name of ["stake", "closeThenStake"]) {
      const stake = block(name);
      expect(stake.indexOf("impactRefusal(q)"), name).toBeGreaterThan(0);
      expect(stake.indexOf("impactRefusal(q)"), name).toBeLessThan(stake.indexOf("stakeIn(q, onStart)"));
    }
    expect(block("closeThenStake").indexOf("impactRefusal(q)")).toBeLessThan(block("closeThenStake").indexOf("closeFirst({"));
    const flows = readFileSync(fileURLToPath(new URL("./flows.ts", import.meta.url)), "utf8");
    expect(flows).toMatch(/const check = async \(fresh: DepositQuote\) => \{\s*refuseImpact\(fresh\);\s*await assertPriceAgrees\(fresh, x\.oracle\);/);
  });

  it("R9 (M-1): a stake after sending the full batch first makes every check that can refuse the stake before the close is paid for: the impact cap, the oracle's check of its quote, the outside-price veto, the USDC to pay it, in that order; the stake's own checks run again after the close (stakeIn)", () => {
    const b = block("closeThenStake");
    const at = (s: string) => {
      const i = b.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      return i;
    };
    const order = ["impactRefusal(q)", "await assertPriceAgrees(q, oracle)", "await priceVeto()?.stake()", "assertStakeFunded(q, await data.getBalances(a))", "await closeFirst({", "stakeIn(q, onStart)"].map(at);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    // the close is planned for the batch the note was priced from, and the room is read with the form's own rules
    expect(b).toMatch(/planCloseFirst\(\{ d: d\(\), batchId, read: /);
    // R10 (M-1): and that read's own limits go back with it, with the batch priced, so closeFirst holds the clock at the click
    expect(b).toMatch(/closeFirst\(\{\s+batchId,\s+room: async \(\) => \{\s+const limits = await data\.getLimits\(\);\s+return \{ room: stakeRoom\(q\.amountUsd, limits\), limits \};/);
  });

  it("nowhere on the ways out: a claim, a cancel, a swap of wallet TAO, Send it now", () => {
    for (const name of ["claim", "resumeClaim", "sellWalletTao", "cancel", "depositWalletTao", "sendNow"]) {
      for (const check of ["impactRefusal", "usdcUnstakeChecks", "deliveryRefusal"]) expect(block(name), `${name}: ${check}`).not.toContain(check);
    }
  });
});
