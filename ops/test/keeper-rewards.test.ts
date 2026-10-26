import { type Hex, numberToHex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CLAIM_POLICY, claimPolicy, PRECOMPILE, WALLET } from "../src/config.ts";
import { claim } from "../src/keeper/actions.ts";
import { CLAIM_GAS_MARGIN, claimDecision, formatRewards, type RewardsRead } from "../src/keeper/rewards.ts";
import { keeperDeps, REWARD_READ_ABIS } from "../src/keeper/state.ts";
import { ROUTE_0 } from "../src/plan.ts";
import type { CallRequest } from "../src/types.ts";
import { COLDKEY, fakeChain, SENT, stubDeps, v3Record } from "./fake-keeper.ts";

const TAO = 10n ** 18n;
const COST = 57n * 10n ** 15n;
const DAY = 86_400;
const NOW = 1_800_000_000;
const HOTKEY: Hex = `0x${"56".repeat(32)}`;
/** At $250 a TAO, τ0.057 is $14.25. */
const policy = { waitingWei: 0n, costWei: COST, taoPriceUsd: 250, lastClaimAt: NOW - DAY, now: NOW, multiple: 25n, monthlyMaxUsd: 20 };

describe("claimDecision", () => {
  it("claims once the rewards waiting reach 25 times the claim cost", () => {
    expect(claimDecision({ ...policy, waitingWei: 15n * TAO / 10n })).toMatchObject({ claim: true });
    // 25 × 0.057 = 1.425, exactly
    expect(claimDecision({ ...policy, waitingWei: 1_425n * 10n ** 15n }).claim).toBe(true);
    expect(claimDecision({ ...policy, waitingWei: 1_425n * 10n ** 15n - 1n }).claim).toBe(false);
  });

  it("claims monthly while a claim costs under $20", () => {
    const d = claimDecision({ ...policy, waitingWei: TAO, taoPriceUsd: 14 / 0.057, lastClaimAt: NOW - 31 * DAY });
    expect(d.claim).toBe(true);
    expect(d.reason).toMatch(/31 days/);
    expect(d.reason).toContain("$14.00");
  });

  it("refuses the monthly claim when a claim costs more than the $20 ceiling, and says so", () => {
    const d = claimDecision({ ...policy, waitingWei: TAO, taoPriceUsd: 66 / 0.057, lastClaimAt: NOW - 31 * DAY });
    expect(d.claim).toBe(false);
    expect(d.reason).toContain("$20");
    expect(d.reason).toContain("$66.00");
  });

  it("waits when the rewards are below 25 times the cost and the last claim is 10 days old", () => {
    const d = claimDecision({ ...policy, waitingWei: TAO, lastClaimAt: NOW - 10 * DAY });
    expect(d.claim).toBe(false);
    expect(d.reason).toMatch(/1\.425/);
    expect(d.reason).toMatch(/10 days ago/);
  });

  it("never spends more on the monthly claim than it collects", () => {
    const d = claimDecision({ ...policy, waitingWei: COST, lastClaimAt: NOW - 31 * DAY });
    expect(d.claim).toBe(false);
    expect(d.reason).toMatch(/more than the τ0\.057 waiting/);
  });

  it("does not claim monthly on an unknown TAO price", () => {
    expect(claimDecision({ ...policy, waitingWei: TAO, taoPriceUsd: Number.NaN, lastClaimAt: NOW - 31 * DAY }).claim).toBe(false);
  });
});

describe("claim policy settings", () => {
  it("defaults to τ0.057 a claim, 25 times, and $20 a month", () => {
    expect(CLAIM_POLICY).toEqual({ claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 });
    expect(claimPolicy({})).toEqual(CLAIM_POLICY);
  });

  it("takes a measured claim cost from OPS_CLAIM_COST_TAO", () => {
    expect(claimPolicy({ OPS_CLAIM_COST_TAO: "0.045" }).claimCostTao).toBe(45n * 10n ** 15n);
    expect(() => claimPolicy({ OPS_CLAIM_COST_TAO: "abc" })).toThrow(/OPS_CLAIM_COST_TAO/);
    expect(() => claimPolicy({ OPS_CLAIM_COST_TAO: "0" })).toThrow(/OPS_CLAIM_COST_TAO/);
  });
});

const read = (over: Partial<RewardsRead> = {}): RewardsRead => ({
  hotkey: HOTKEY,
  waitingWei: 15n * TAO / 10n,
  lastClaimAt: NOW - DAY,
  now: NOW,
  taoPriceUsd: 250,
  claimGasRequired: 55_000_000n,
  gasPriceWei: 5_000_000_000n,
  walletWei: TAO,
  ...over,
});

describe("claim", () => {
  const rec = v3Record();

  it("refuses with the policy's reason and sends nothing when the policy says wait", async () => {
    const sendCall = vi.fn(async (_r: CallRequest) => SENT);
    const deps = stubDeps({ readRewards: async () => read({ waitingWei: TAO, lastClaimAt: NOW - 10 * DAY }), sendCall });
    await expect(claim(deps, rec, CLAIM_POLICY)).rejects.toThrow(/not claiming: .*10 days ago.*nothing sent/);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it("claims the stake hotkey on the vault with the vault's claim gas plus a margin", async () => {
    const sendCall = vi.fn(async (_r: CallRequest) => SENT);
    await claim(stubDeps({ readRewards: async () => read(), sendCall }), rec, CLAIM_POLICY);
    expect(sendCall).toHaveBeenCalledOnce();
    expect(sendCall.mock.calls[0][0]).toMatchObject({
      chain: "bittensor",
      to: rec.plan.addresses.vault,
      functionName: "claimRewards",
      args: [HOTKEY],
      gasLimit: 55_000_000n + CLAIM_GAS_MARGIN,
      nonce: 4,
    });
  });

  it("refuses when the wallet can't pay the gas limit up front", async () => {
    const sendCall = vi.fn(async (_r: CallRequest) => SENT);
    // 57M gas at 5 gwei is τ0.285 up front
    const deps = stubDeps({ readRewards: async () => read({ walletWei: 2n * 10n ** 17n }), sendCall });
    await expect(claim(deps, rec, CLAIM_POLICY)).rejects.toThrow(/τ0\.285 up front.*holds τ0\.2/);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it("refuses before the deployment is complete and verified", async () => {
    const sendCall = vi.fn(async (_r: CallRequest) => SENT);
    await expect(claim(stubDeps({ readRewards: async () => read(), sendCall }), { ...rec, verify: undefined }, CLAIM_POLICY)).rejects.toThrow(
      /not complete and verified/,
    );
    expect(sendCall).not.toHaveBeenCalled();
  });
});

describe("rewards reads", () => {
  it("reads the vault's coldkey and stake hotkey from the precompile, and prices TAO through QuoterV2", async () => {
    const rec = v3Record();
    const f = fakeChain(
      Object.values(REWARD_READ_ABIS),
      {
        stakeHotkey: () => HOTKEY,
        getUnclaimedRootTaoByHotkey: ([coldkey, hotkey], c) => {
          expect([coldkey, hotkey, c.to.toLowerCase()]).toEqual([COLDKEY, HOTKEY, PRECOMPILE.staking.toLowerCase()]);
          return 3n * 10n ** 17n;
        },
        lastClaimAt: ([hotkey]) => {
          expect(hotkey).toBe(HOTKEY);
          return BigInt(NOW - 5 * DAY);
        },
        claimGasRequired: () => 55_000_000n,
        quoteExactInput: ([path, amountIn], c) => {
          expect([path, amountIn, c.chain]).toEqual([ROUTE_0.sellPath.toLowerCase(), TAO, "base"]);
          return [250_500_000n, [], [], 0n];
        },
      },
      {
        eth_gasPrice: () => numberToHex(5_000_000_000n),
        eth_getBalance: (_c, p) => {
          expect(p[0]).toBe(WALLET);
          return numberToHex(TAO);
        },
        eth_getBlockByNumber: () => ({ timestamp: numberToHex(NOW) }),
      },
    );
    const r = await keeperDeps(f.ctx, rec, "unused.json").readRewards();
    expect(r).toEqual({
      hotkey: HOTKEY,
      waitingWei: 3n * 10n ** 17n,
      lastClaimAt: NOW - 5 * DAY,
      now: NOW,
      taoPriceUsd: 250.5,
      claimGasRequired: 55_000_000n,
      gasPriceWei: 5_000_000_000n,
      walletWei: TAO,
    });
    expect(f.calls.filter((c) => c.method === "eth_call" && c.chain === "bittensor").every((c) => c.fn !== "quoteExactInput")).toBe(true);
  });

  it("prints what is waiting, the cost, the ratio and the decision", () => {
    const text = formatRewards(read({ waitingWei: 3n * 10n ** 17n, lastClaimAt: NOW - 5 * DAY }), CLAIM_POLICY).join("\n");
    expect(text).toContain("τ0.3");
    expect(text).toContain("τ0.057");
    expect(text).toContain("$14.25");
    expect(text).toMatch(/5\.26× the cost/);
    expect(text).toMatch(/Decision: wait/);
  });
});
