import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, numberToHex, parseAbiParameters } from "viem";
import { describe, expect, it, vi } from "vitest";
import { BASE_V3, CLAIM_POLICY, WALLET } from "../src/config.ts";
import { deliver, deliverAll, deliverCommand, runLoop } from "../src/keeper/actions.ts";
import {
  checkDelivery,
  DELIVER_ABI,
  type DeliveryRead,
  deliveryDecision,
  DESTINATION_BASE,
  NO_ANSWER,
  netOfFee,
  TWAP_UNAVAILABLE,
} from "../src/keeper/delivery.ts";
import { decideNext, type State } from "../src/keeper/due.ts";
import { DELIVERY_READ_ABIS, isRevert, keeperDeps } from "../src/keeper/state.ts";
import type { StatusDetail } from "../src/keeper/status.ts";
import { isPlanV3, ROUTE_0 } from "../src/plan.ts";
import { RpcError } from "../src/rpc.ts";
import { type Sent, SendRefused } from "../src/send.ts";
import type { CallRequest } from "../src/types.ts";
import { fakeChain, revert, SENT, stubDeps, v3Record } from "./fake-keeper.ts";

const TAO = 10n ** 18n;
const NOW = 1_800_000_000;
const alice: Address = "0x000000000000000000000000000000000000a11c";
const bob: Address = "0x0000000000000000000000000000000000000B0b";
const pref = { minUsdcPerTao: 240_000_000n, deadline: NOW + 3600, destination: DESTINATION_BASE };
/** 1 TAO; the user's floor is 240 USDC; the TWAP floor 250 × (1 - 1.5%) = 246.25 USDC. */
const input = { claimable: TAO, pref, quoteUsdc: 250_000_000n, twapUsdc: 250_000_000n, slippageBps: 150, now: NOW };

describe("deliveryDecision", () => {
  it("leaves the TAO claimable with no preference, an expired one, or one for another destination", () => {
    expect(deliveryDecision({ ...input, pref: null })).toEqual({ deliver: false, reason: expect.stringMatching(/no USDC delivery preference/) });
    expect(deliveryDecision({ ...input, pref: { ...pref, deadline: NOW - 1 } })).toEqual({ deliver: false, reason: expect.stringMatching(/expired/) });
    expect(deliveryDecision({ ...input, pref: { ...pref, destination: 0 } })).toEqual({
      deliver: false,
      reason: expect.stringMatching(/destination 0, not Base \(6\)/),
    });
    expect(deliveryDecision({ ...input, claimable: 0n })).toEqual({ deliver: false, reason: expect.stringMatching(/nothing is claimable/) });
    // the deadline itself is still live, as on chain
    expect(deliveryDecision({ ...input, pref: { ...pref, deadline: NOW } }).deliver).toBe(true);
  });

  it("refuses a quote below the user's floor or the TWAP floor", () => {
    expect(deliveryDecision({ ...input, quoteUsdc: 239_000_000n })).toEqual({ deliver: false, reason: expect.stringMatching(/user's floor of 240 USDC/) });
    const twap = deliveryDecision({ ...input, pref: { ...pref, minUsdcPerTao: 100_000_000n }, quoteUsdc: 246_000_000n });
    expect(twap).toEqual({ deliver: false, reason: expect.stringMatching(/30-minute TWAP floor of 246\.25 USDC/) });
  });

  it("delivers a quote 1.2% below the TWAP value, with the keeper's minimum at the TWAP floor (the contract's whole window)", () => {
    // 250 × (1 - 1.2%) = 247: clears the TWAP floor (246.25) by less than 0.5%, as deliver allows
    const d = deliveryDecision({ ...input, quoteUsdc: 247_000_000n });
    expect(d.deliver).toBe(true);
    expect(d.keeperMinOut).toBe(246_250_000n);
    // a quote exactly at the TWAP floor still delivers, at that floor
    expect(deliveryDecision({ ...input, quoteUsdc: 246_250_000n })).toMatchObject({ deliver: true, keeperMinOut: 246_250_000n });
    // one unit below waits, with the floor named
    expect(deliveryDecision({ ...input, quoteUsdc: 246_249_999n })).toEqual({ deliver: false, reason: expect.stringMatching(/30-minute TWAP floor of 246\.25 USDC/) });
  });

  it("delivers a quote just above the user's floor with the keeper's minimum at that floor, rounded up as on chain", () => {
    // 1/3 TAO at 249 USDC a TAO: 83 USDC rounded up to the unit; the TWAP floor is 82.08… USDC
    const third = TAO / 3n;
    const userFloor = (third * 249_000_000n + TAO - 1n) / TAO;
    const at = { ...input, claimable: third, pref: { ...pref, minUsdcPerTao: 249_000_000n }, twapUsdc: 83_333_333n };
    expect(deliveryDecision({ ...at, quoteUsdc: userFloor })).toMatchObject({ deliver: true, keeperMinOut: userFloor });
    expect(deliveryDecision({ ...at, quoteUsdc: userFloor - 1n })).toEqual({ deliver: false, reason: expect.stringMatching(/user's floor of 83 USDC/) });
  });

  it("never sends a keeper's minimum below either floor or above the quote", () => {
    for (let quote = 230_000_000n; quote <= 260_000_000n; quote += 250_000n) {
      for (const minUsdcPerTao of [100_000_000n, 240_000_000n, 247_500_000n]) {
        const i = { ...input, pref: { ...pref, minUsdcPerTao }, quoteUsdc: quote };
        const userFloor = minUsdcPerTao; // 1 TAO
        const twapFloor = 246_250_000n;
        const d = deliveryDecision(i);
        expect(d.deliver).toBe(quote >= userFloor && quote >= twapFloor);
        if (!d.deliver) continue;
        expect(d.keeperMinOut).toBeGreaterThanOrEqual(userFloor);
        expect(d.keeperMinOut).toBeGreaterThanOrEqual(twapFloor);
        expect(d.keeperMinOut).toBeGreaterThanOrEqual((quote * 9950n) / 10000n);
        expect(d.keeperMinOut).toBeLessThanOrEqual(quote);
      }
    }
  });

  it("delivers a quote 1% above every floor with the keeper's minimum at quote × 0.995", () => {
    const quote = (246_250_000n * 101n) / 100n;
    const d = deliveryDecision({ ...input, quoteUsdc: quote });
    expect(d.deliver).toBe(true);
    expect(d.keeperMinOut).toBe((quote * 9950n) / 10000n);
    // the user's floor rounds up, as on chain: 1 wei of TAO at 240 USDC a TAO needs 1 USDC unit
    expect(deliveryDecision({ ...input, claimable: 1n, quoteUsdc: 0n, twapUsdc: 0n }).deliver).toBe(false);
  });

  it("says why when the pool's price history doesn't reach 30 minutes (Review Focus 5)", () => {
    expect(deliveryDecision({ ...input, twapUsdc: null })).toEqual({ deliver: false, reason: TWAP_UNAVAILABLE });
    expect(TWAP_UNAVAILABLE).toBe("the pool's price history doesn't reach 30 minutes; the user can claim by hand");
  });

  it("takes the staker's swap fee off the quote", () => {
    expect(netOfFee(1_000_000_000n, 15)).toBe(998_500_000n);
    expect(netOfFee(1_000_000_000n, 0)).toBe(1_000_000_000n);
  });
});

const rec = v3Record();
const plan = rec.plan;
if (!isPlanV3(plan)) throw new Error("v3 plan expected");
const DELIVERED = DELIVER_ABI.find((i) => i.type === "event" && i.name === "Delivered")!;
const deliveredLog = (user: Address, usdcOut: bigint) => ({
  address: plan.addresses.frontDoor,
  topics: encodeEventTopics({ abi: [DELIVERED], args: { user } } as never) as Hex[],
  data: encodeAbiParameters(parseAbiParameters("uint256, uint256"), [TAO, usdcOut]),
});

describe("delivery reads", () => {
  const answers = (over: Record<string, (args: readonly unknown[]) => unknown> = {}) => ({
    claimable: () => TAO,
    deliveryOf: () => [240_000_000n, BigInt(NOW + 3600), DESTINATION_BASE],
    oracle: () => plan.addresses.oracle,
    swapper: () => plan.addresses.staker,
    maxDeliverySlippageBps: () => 150,
    usdcValue: ([amount]: readonly unknown[]) => {
      expect(amount).toBe(TAO);
      return 250_000_000n;
    },
    deliveryRouteId: () => 0,
    routes: ([id]: readonly unknown[]) => {
      expect(id).toBe(0);
      return [0, ROUTE_0.router, ROUTE_0.buyPath, ROUTE_0.sellPath, true];
    },
    swapFeeBps: () => 15,
    quoteExactInput: ([path, amountIn]: readonly unknown[]) => {
      expect([path, amountIn]).toEqual([ROUTE_0.sellPath.toLowerCase(), TAO]);
      return [251_000_000n, [], [], 0n];
    },
    ...over,
  });

  it("quotes the claimable TAO along the staker's delivery route, net of its 0.15% fee", async () => {
    const f = fakeChain(Object.values(DELIVERY_READ_ABIS), answers());
    const r = await keeperDeps(f.ctx, rec, "unused.json").readDelivery(alice);
    expect(r).toEqual({ user: alice, claimable: TAO, pref, quoteUsdc: 251_000_000n - 376_500n, twapUsdc: 250_000_000n, slippageBps: 150, now: NOW });
    const quoter = f.calls.find((c) => c.fn === "quoteExactInput")!;
    expect([quoter.chain, quoter.to?.toLowerCase()]).toEqual(["base", BASE_V3.QUOTER_V2.toLowerCase()]);
  });

  it("reads a reverting oracle as 'no TWAP', and a user with nothing claimable with one read", async () => {
    const old = fakeChain(
      Object.values(DELIVERY_READ_ABIS),
      answers({
        usdcValue: () => {
          throw revert("OLD");
        },
      }),
    );
    const r = await keeperDeps(old.ctx, rec, "unused.json").readDelivery(alice);
    expect(r.twapUsdc).toBeNull();
    expect(deliveryDecision(r)).toEqual({ deliver: false, reason: TWAP_UNAVAILABLE });

    const none = fakeChain(Object.values(DELIVERY_READ_ABIS), answers({ claimable: () => 0n }));
    expect((await keeperDeps(none.ctx, rec, "unused.json").readDelivery(alice)).claimable).toBe(0n);
    expect(none.calls.filter((c) => c.method === "eth_call").map((c) => c.fn)).toEqual(["claimable"]);
  });

  it("does not quote a preference that isn't live", async () => {
    const f = fakeChain(Object.values(DELIVERY_READ_ABIS), answers({ deliveryOf: () => [240_000_000n, BigInt(NOW - 1), DESTINATION_BASE] }));
    const r = await keeperDeps(f.ctx, rec, "unused.json").readDelivery(alice);
    expect(deliveryDecision(r).reason).toMatch(/expired/);
    expect(f.calls.some((c) => c.fn === "quoteExactInput" || c.fn === "usdcValue")).toBe(false);
  });

  it("simulates deliver from the keeper and names the revert, the router's included", async () => {
    let reply: () => unknown = () => 250_000_000n;
    const f = fakeChain(Object.values(DELIVERY_READ_ABIS), {
      deliver: ([user, minOut], c) => {
        expect([user, minOut, c.from, c.to]).toEqual([alice, 7n, WALLET, plan.addresses.frontDoor]);
        return reply();
      },
    });
    const deps = keeperDeps(f.ctx, rec, "unused.json");
    expect(await deps.simulateDeliver(alice, 7n)).toEqual({ ok: true, usdcOut: 250_000_000n });
    reply = () => {
      throw revert("Too little received");
    };
    expect(await deps.simulateDeliver(alice, 7n)).toEqual({ ok: false, reason: expect.stringContaining("Too little received") });
  });

  it("lists each user with a Redeemed event since the deploy block once, scanning 1,000 blocks at a time", async () => {
    const REDEEMED = DELIVERY_READ_ABIS.VAULT.find((i) => i.type === "event" && i.name === "Redeemed")!;
    const log = (user: Address, block: number) => ({
      address: plan.addresses.vault,
      topics: encodeEventTopics({ abi: [REDEEMED], args: { key: `0x${"aa".repeat(32)}`, user } } as never),
      data: encodeAbiParameters(parseAbiParameters("uint256, uint256"), [1n, TAO]),
      blockNumber: numberToHex(block),
      logIndex: "0x0",
      transactionHash: `0x${"bb".repeat(32)}`,
    });
    const windows: [bigint, bigint][] = [];
    const f = fakeChain([], {}, {
      eth_blockNumber: () => numberToHex(2_600),
      eth_getLogs: (chain, p) => {
        expect(chain).toBe("bittensor");
        const q = p[0] as { fromBlock: Hex; toBlock: Hex };
        windows.push([BigInt(q.fromBlock), BigInt(q.toBlock)]);
        return BigInt(q.fromBlock) === 1n ? [log(alice, 5), log(bob, 6), log(alice, 7)] : [log(bob, 1_500)];
      },
    });
    expect(await keeperDeps(f.ctx, rec, "unused.json").deliveryCandidates()).toEqual([alice, bob]);
    // the record's deploy block is 1
    expect(windows).toEqual([
      [1n, 1_000n],
      [1_001n, 2_000n],
      [2_001n, 2_600n],
    ]);
  });

  it("rereads the last blocks, so a log a lagging node hadn't indexed yet is found on the next round", async () => {
    const REDEEMED = DELIVERY_READ_ABIS.VAULT.find((i) => i.type === "event" && i.name === "Redeemed")!;
    const carol: Address = "0x000000000000000000000000000000000000ca01";
    const late = {
      address: plan.addresses.vault,
      topics: encodeEventTopics({ abi: [REDEEMED], args: { key: `0x${"aa".repeat(32)}`, user: carol } } as never),
      data: encodeAbiParameters(parseAbiParameters("uint256, uint256"), [1n, TAO]),
      blockNumber: numberToHex(898),
      logIndex: "0x0",
      transactionHash: `0x${"bb".repeat(32)}`,
    };
    let indexed = false;
    let head = 900;
    const f = fakeChain([], {}, {
      eth_blockNumber: () => numberToHex(head),
      eth_getLogs: (_c, p) => {
        const q = p[0] as { fromBlock: Hex; toBlock: Hex };
        return indexed && BigInt(q.fromBlock) <= 898n && BigInt(q.toBlock) >= 898n ? [late] : [];
      },
    });
    const deps = keeperDeps(f.ctx, rec, "unused.json");
    // the node says block 900 is the head, but hasn't indexed block 898's logs yet
    expect(await deps.deliveryCandidates()).toEqual([]);
    indexed = true;
    head = 905;
    expect(await deps.deliveryCandidates()).toEqual([carol]);
  });

  it("keeps the candidates for the life of the deps: each later round scans only the new blocks", async () => {
    const REDEEMED = DELIVERY_READ_ABIS.VAULT.find((i) => i.type === "event" && i.name === "Redeemed")!;
    const carol: Address = "0x000000000000000000000000000000000000ca01";
    const log = (user: Address, block: number) => ({
      address: plan.addresses.vault,
      topics: encodeEventTopics({ abi: [REDEEMED], args: { key: `0x${"aa".repeat(32)}`, user } } as never),
      data: encodeAbiParameters(parseAbiParameters("uint256, uint256"), [1n, TAO]),
      blockNumber: numberToHex(block),
      logIndex: "0x0",
      transactionHash: `0x${"bb".repeat(32)}`,
    });
    const logs = [log(alice, 5), log(carol, 950), log(alice, 951)];
    let head = 900;
    let failNext = false;
    const windows: [bigint, bigint][] = [];
    const f = fakeChain([], {}, {
      eth_blockNumber: () => numberToHex(head),
      eth_getLogs: (_c, p) => {
        if (failNext) {
          failNext = false;
          throw new Error("fetch failed");
        }
        const q = p[0] as { fromBlock: Hex; toBlock: Hex };
        const [from, to] = [BigInt(q.fromBlock), BigInt(q.toBlock)];
        windows.push([from, to]);
        return logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to);
      },
    });
    const deps = keeperDeps(f.ctx, rec, "unused.json");
    expect(await deps.deliveryCandidates()).toEqual([alice]);
    head = 1_200;
    failNext = true;
    await expect(deps.deliveryCandidates()).rejects.toThrow(/fetch failed/);
    // the failed round is scanned again, from the same block
    expect(await deps.deliveryCandidates()).toEqual([alice, carol]);
    expect(await deps.deliveryCandidates()).toEqual([alice, carol]);
    // each later round starts 10 blocks back, so a block a lagging node hadn't indexed is read again
    expect(windows).toEqual([
      [1n, 900n],
      [891n, 1_200n],
      [1_191n, 1_200n],
    ]);
    // a new deps (a new run) starts over from the deploy block
    windows.length = 0;
    expect(await keeperDeps(f.ctx, rec, "unused.json").deliveryCandidates()).toEqual([alice, carol]);
    expect(windows).toEqual([
      [1n, 1_000n],
      [1_001n, 1_200n],
    ]);
  });
});

describe("a node's own error is not a revert", () => {
  const data = "0x08c379a0" + "00".repeat(96);
  it("counts code 3, revert data or 'revert' in the message as a revert, and nothing else", () => {
    expect(isRevert(revert("OLD"))).toBe(true);
    expect(isRevert(new RpcError("base eth_call: execution reverted", -32000))).toBe(true);
    expect(isRevert(new RpcError("base eth_call: VM Exception while processing transaction: revert", -32603))).toBe(true);
    expect(isRevert(new RpcError("base eth_call: error", -32015, data))).toBe(true);
    // geth's contract failures without revert data: still the contract's answer, not the node's
    expect(isRevert(new RpcError("base eth_call: out of gas", -32000))).toBe(true);
    expect(isRevert(new RpcError("base eth_call: invalid opcode: INVALID", -32000))).toBe(true);
    expect(isRevert(new RpcError("base eth_call: limit exceeded", -32005))).toBe(false);
    expect(isRevert(new RpcError("base eth_call: header not found", -32000))).toBe(false);
    expect(isRevert(new RpcError("base eth_call: internal error", -32603, "0x"))).toBe(false);
    expect(isRevert(new Error("fetch failed"))).toBe(false);
  });

  const answers = {
    claimable: () => TAO,
    deliveryOf: () => [240_000_000n, BigInt(NOW + 3600), DESTINATION_BASE],
    oracle: () => plan.addresses.oracle,
    swapper: () => plan.addresses.staker,
    maxDeliverySlippageBps: () => 150,
    usdcValue: () => 250_000_000n,
    deliveryRouteId: () => 0,
    routes: () => [0, ROUTE_0.router, ROUTE_0.buyPath, ROUTE_0.sellPath, true],
    swapFeeBps: () => 15,
    quoteExactInput: () => [251_000_000n, [], [], 0n],
  };
  const failing = (e: Error) => () => {
    throw e;
  };

  it("an oracle read the node didn't answer waits, instead of reading as a short price history", async () => {
    const f = fakeChain(Object.values(DELIVERY_READ_ABIS), { ...answers, usdcValue: failing(new RpcError("base eth_call: limit exceeded", -32005)) });
    const deps = keeperDeps(f.ctx, rec, "unused.json");
    const r = await deps.readDelivery(alice);
    expect(r.twapUsdc).not.toBeNull();
    expect(r.quoteError).toBe(NO_ANSWER);
    const simulateDeliver = vi.fn();
    expect(await checkDelivery({ readDelivery: async () => r, simulateDeliver }, alice)).toMatchObject({ deliver: false, reason: NO_ANSWER });
    expect(simulateDeliver).not.toHaveBeenCalled();
    expect(NO_ANSWER).toBe("the node didn't answer; trying again later");
  });

  it("a quote the node didn't answer waits with the same reason", async () => {
    const f = fakeChain(Object.values(DELIVERY_READ_ABIS), { ...answers, quoteExactInput: failing(new RpcError("base eth_call: header not found", -32000)) });
    expect((await keeperDeps(f.ctx, rec, "unused.json").readDelivery(alice)).quoteError).toBe(NO_ANSWER);
  });

  it("a simulation the node didn't run is a skip that says so, never 'deliver would revert'", async () => {
    const f = fakeChain(Object.values(DELIVERY_READ_ABIS), { deliver: failing(new RpcError("base eth_call: internal error", -32603)) });
    const sim = await keeperDeps(f.ctx, rec, "unused.json").simulateDeliver(alice, 7n);
    expect(sim).toEqual({ ok: false, reason: NO_ANSWER, unanswered: true });
    const c = await checkDelivery({ readDelivery: async () => ready(), simulateDeliver: async () => sim }, alice);
    expect(c).toMatchObject({ deliver: false, reason: NO_ANSWER });
  });

  it("a request that failed outright still stops the round, as before", async () => {
    const f = fakeChain(Object.values(DELIVERY_READ_ABIS), { ...answers, usdcValue: failing(new Error("fetch failed")) });
    await expect(keeperDeps(f.ctx, rec, "unused.json").readDelivery(alice)).rejects.toThrow(/fetch failed/);
  });
});

const ready = (over: Partial<DeliveryRead> = {}): DeliveryRead => ({ user: alice, ...input, quoteUsdc: 252_000_000n, ...over });
const sentWith = (logs: Sent["logs"]) => vi.fn(async (_r: CallRequest): Promise<Sent> => ({ ...SENT, logs }));

describe("deliver", () => {
  it("simulates first and skips any revert, naming it, without sending", async () => {
    const sendCall = sentWith([]);
    const simulateDeliver = vi.fn(async () => ({ ok: false as const, reason: "Error(Too little received)" }));
    const deps = stubDeps({ readDelivery: async () => ready(), simulateDeliver, sendCall });
    expect(await deliver(deps, rec, alice)).toEqual({ user: alice, delivered: false, reason: expect.stringContaining("Too little received") });
    expect(simulateDeliver).toHaveBeenCalledOnce();
    expect(sendCall).not.toHaveBeenCalled();
  });

  it("sends deliver(user, keeperMinOut) to the front door and reads the USDC from its Delivered event", async () => {
    const sendCall = sentWith([deliveredLog(alice, 251_000_000n)]);
    const deps = stubDeps({ readDelivery: async () => ready(), simulateDeliver: async () => ({ ok: true, usdcOut: 251_000_000n }), sendCall });
    const out = await deliver(deps, rec, alice);
    expect(sendCall.mock.calls[0][0]).toMatchObject({
      chain: "base",
      to: plan.addresses.frontDoor,
      functionName: "deliver",
      args: [alice, (252_000_000n * 9950n) / 10000n],
      nonce: 4,
    });
    expect(out).toMatchObject({ user: alice, delivered: true, usdcOut: 251_000_000n, hash: SENT.hash });
  });

  it("treats a refused estimate as a skip too", async () => {
    const sendCall = vi.fn(async (_r: CallRequest): Promise<Sent> => {
      throw new SendRefused("estimate", "Base: deliver would fail, nothing sent (BelowMinimum())");
    });
    const deps = stubDeps({ readDelivery: async () => ready(), simulateDeliver: async () => ({ ok: true, usdcOut: 1n }), sendCall });
    expect(await deliver(deps, rec, alice)).toEqual({
      user: alice,
      delivered: false,
      reason: expect.stringContaining("BelowMinimum"),
      refused: "Base: deliver would fail, nothing sent (BelowMinimum())",
    });
  });

  it("tries each user once, and needs a complete, verified v3 deployment", async () => {
    const readDelivery = vi.fn(async (user: Address) => ready({ user, pref: null }));
    const deps = stubDeps({ readDelivery, sendCall: sentWith([]) });
    const out = await deliverAll(deps, rec, [alice, bob]);
    expect(out.map((o) => [o.user, o.delivered])).toEqual([
      [alice, false],
      [bob, false],
    ]);
    expect(readDelivery).toHaveBeenCalledTimes(2);
    await expect(deliverAll(deps, { ...rec, verify: undefined }, [alice])).rejects.toThrow(/not complete and verified/);
    const v2 = { ...rec, plan: { ...plan, version: undefined } } as never;
    await expect(deliverAll(deps, v2, [alice])).rejects.toThrow(/v3 deployment/);
  });

  it("pnpm ops deliver prints each user's result as it happens, so a failure on a later user never hides an earlier hash", async () => {
    const carol: Address = "0x000000000000000000000000000000000000ca01";
    const first: Hex = `0x${"d1".repeat(32)}`;
    let sends = 0;
    const sendCall = vi.fn(async (_r: CallRequest): Promise<Sent> => {
      sends++;
      if (sends === 2) throw new Error("Base: no receipt yet for nonce 5; nothing more will be sent until it is mined or dropped");
      return { ...SENT, hash: first, logs: [deliveredLog(alice, 251_000_000n)] };
    });
    const lines: string[] = [];
    const deps = stubDeps({
      readDelivery: async (user) => ready({ user, ...(user === bob ? { pref: null } : {}) }),
      simulateDeliver: async () => ({ ok: true, usdcOut: 251_000_000n }),
      sendCall,
    });
    // alice is delivered, bob waits (no preference), carol's send fails: the command stops (non-zero)
    await expect(deliverCommand(deps, rec, [alice, bob, carol], (l) => lines.push(l))).rejects.toThrow(/no receipt yet/);
    expect(lines).toEqual([
      `${alice}: delivered (251 USDC, transaction ${first}, cost 0.000000000000000001 ETH)`,
      `${bob}: not delivered: no USDC delivery preference: the TAO stays claimable`,
    ]);
    expect(sendCall).toHaveBeenCalledTimes(2);
  });

  it("pnpm ops deliver without --user reads the candidates, and says when there are none", async () => {
    const lines: string[] = [];
    const none = stubDeps({ deliveryCandidates: async () => [] });
    expect(await deliverCommand(none, rec, [], (l) => lines.push(l))).toEqual([]);
    expect(lines).toEqual(["No user has redeemed through the vault yet: nothing to deliver."]);
    lines.length = 0;
    const deps = stubDeps({ deliveryCandidates: async () => [bob], readDelivery: async (user) => ready({ user, pref: null }) });
    await deliverCommand(deps, rec, [], (l) => lines.push(l));
    expect(lines).toEqual([`${bob}: not delivered: no USDC delivery preference: the TAO stays claimable`]);
  });

  it("checkDelivery passes the decision's minimum to the simulation", async () => {
    const simulateDeliver = vi.fn(async () => ({ ok: true as const, usdcOut: 1n }));
    const c = await checkDelivery(stubDeps({ readDelivery: async () => ready(), simulateDeliver }), alice);
    expect(c).toMatchObject({ user: alice, deliver: true, keeperMinOut: (252_000_000n * 9950n) / 10000n });
    expect(simulateDeliver).toHaveBeenCalledWith(alice, (252_000_000n * 9950n) / 10000n);
  });
});

const T = NOW;
const KEY: Hex = `0x${"aa".repeat(32)}`;
const baseState: State = {
  now: T,
  frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false },
  alphaVault: { healthy: true },
  vault: {
    paused: false,
    available: 10n ** 16n,
    minStakeWei: 2n * 10n ** 15n,
    rootStake: 0n,
    nominatorMinWei: 0n,
    batches: [{ key: KEY, queuedAt: T - 3600, cursor: 0, count: 1 }],
    payoutDelay: 3600,
  },
};

describe("decideNext with deliveries", () => {
  it("delivers after a due payout and before staking or closing", () => {
    const deliveries = [{ user: alice, keeperMinOut: 5n }];
    expect(decideNext({ ...baseState, deliveries }).action).toEqual({ kind: "payouts", key: KEY });
    const noPayout = { ...baseState, vault: { ...baseState.vault, batches: [] }, deliveries };
    expect(decideNext(noPayout).action).toEqual({ kind: "deliver", user: alice, keeperMinOut: 5n });
    expect(decideNext({ ...noPayout, deliveries: [] }).action).toEqual({ kind: "stake" });
    expect(decideNext({ ...noPayout, frontDoor: { ...noPayout.frontDoor, paused: true } }).action).toEqual({ kind: "stake" });
  });
});

describe("run with deliveries and rewards", () => {
  const detail = { claimable: [] } as unknown as StatusDetail;
  const state = { ...baseState, vault: { ...baseState.vault, batches: [] }, detail };
  const rewards = async () => ({
    hotkey: KEY,
    waitingWei: 2n * TAO,
    lastClaimAt: T,
    now: T,
    taoPriceUsd: 250,
    claimGasRequired: 55_000_000n,
    gasPriceWei: 1n,
    walletWei: TAO,
  });

  it("skips a delivery whose simulation reverts, stakes instead, and only reports the claim", async () => {
    const lines: string[] = [];
    const sendCall = sentWith([]);
    const simulateDeliver = vi.fn(async () => ({ ok: false as const, reason: "Error(Too little received)" }));
    const deps = stubDeps({
      readState: async () => state,
      deliveryCandidates: async () => [alice],
      readDelivery: async () => ready(),
      simulateDeliver,
      readRewards: rewards,
      sendCall,
      log: (l) => lines.push(l),
    });
    await runLoop(deps, rec, { intervalMs: 0, maxTicks: 2, policy: CLAIM_POLICY });
    expect(sendCall.mock.calls.map((c) => c[0].functionName)).toEqual(["stakeIdle", "stakeIdle"]);
    expect(simulateDeliver).toHaveBeenCalledTimes(2);
    // the same reason is logged once, not every round
    expect(lines.filter((l) => l.includes("Too little received"))).toHaveLength(1);
    expect(lines.filter((l) => /claim/i.test(l) && l.includes("pnpm ops claim"))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("Stopped"))).toBe(false);
  });

  /** A due close and nothing else (no payout due, nothing to stake), alice's delivery passing its
   * simulation, and a Base estimate for deliver that refuses while `refuse()` says so. */
  function closeDue(over: { read?: (tick: number) => Partial<DeliveryRead>; refuse?: (tick: number) => SendRefused | undefined } = {}) {
    const lines: string[] = [];
    let tick = 0;
    const sendCall = vi.fn(async (r: CallRequest): Promise<Sent> => {
      if (r.functionName === "deliver") {
        const e = (over.refuse ?? (() => new SendRefused("estimate", "Base: deliver would fail, nothing sent (out of gas)")))(tick);
        if (e) throw e;
        return { ...SENT, logs: [deliveredLog(alice, 251_000_000n)] };
      }
      return { ...SENT, logs: [] };
    });
    const deps = stubDeps({
      readState: async () => ({ ...state, vault: { ...state.vault, available: 0n } }),
      quoteClose: async () => 1n,
      deliveryCandidates: async () => {
        tick++;
        return [alice];
      },
      readDelivery: async () => ready(over.read?.(tick)),
      simulateDeliver: async () => ({ ok: true, usdcOut: 251_000_000n }),
      readRewards: rewards,
      sendCall,
      log: (l) => lines.push(l),
    });
    return { deps, lines, sends: () => sendCall.mock.calls.map((c) => c[0].functionName) };
  }

  it("a delivery whose send-time estimate fails still lets the same round close, and isn't retried unchanged", async () => {
    const w = closeDue();
    await runLoop(w.deps, rec, { intervalMs: 0, maxTicks: 3, policy: CLAIM_POLICY });
    expect(w.sends()).toEqual(["deliver", "closeBatch", "closeBatch", "closeBatch"]);
    // the reason is logged once, with what it waits on
    const held = w.lines.filter((l) => l.includes("out of gas"));
    expect(held).toEqual([expect.stringMatching(new RegExp(`^Delivery to ${alice} waits: .*out of gas.*claimable amount, the preference or the quote`))]);
    expect(w.lines.some((l) => l.startsWith("Stopped"))).toBe(false);
  });

  it("retries a held delivery once its facts change: the quote crossing the floor, or the claimable amount", async () => {
    // tick 1 refused; 2 held; 3 the quote dips below the TWAP floor; 4 back above: retried (refused again);
    // 5 held; 6 more TAO is claimable: retried, and delivered
    const quote = (t: number) => (t === 3 ? 240_000_000n : 252_000_000n);
    const w = closeDue({
      read: (t) => (t >= 6 ? { claimable: 2n * TAO, quoteUsdc: 504_000_000n, twapUsdc: 500_000_000n } : { quoteUsdc: quote(t) }),
      refuse: (t) => (t < 6 ? new SendRefused("estimate", "Base: deliver would fail, nothing sent (out of gas)") : undefined),
    });
    await runLoop(w.deps, rec, { intervalMs: 0, maxTicks: 6, policy: CLAIM_POLICY });
    expect(w.sends()).toEqual(["deliver", "closeBatch", "closeBatch", "closeBatch", "deliver", "closeBatch", "closeBatch", "deliver"]);
  });

  it("a send the wallet's guard refuses (an earlier transaction still pending) skips the delivery this round only", async () => {
    const pending = new SendRefused("waiting", "Base: an earlier transaction from the test wallet (nonce 3) is still waiting to be mined; nothing sent — try again once it is");
    const w = closeDue({ refuse: (t) => (t === 1 ? pending : undefined) });
    await runLoop(w.deps, rec, { intervalMs: 0, maxTicks: 2, policy: CLAIM_POLICY });
    // the close still goes in round 1, and round 2 delivers
    expect(w.sends()).toEqual(["deliver", "closeBatch", "deliver"]);
    expect(w.lines.filter((l) => l.includes("still waiting to be mined"))).toHaveLength(1);
  });

  it("delivers when the simulation passes, before staking", async () => {
    const sendCall = sentWith([deliveredLog(alice, 251_000_000n)]);
    const deps = stubDeps({
      readState: async () => state,
      deliveryCandidates: async () => [alice],
      readDelivery: async () => ready(),
      simulateDeliver: async () => ({ ok: true, usdcOut: 251_000_000n }),
      readRewards: rewards,
      sendCall,
    });
    await runLoop(deps, rec, { intervalMs: 0, maxTicks: 1, policy: CLAIM_POLICY });
    expect(sendCall.mock.calls.map((c) => c[0].functionName)).toEqual(["deliver"]);
  });
});
