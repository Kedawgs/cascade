import { describe, expect, it } from "vitest";
import type { Deployment } from "./config";
import { createLiveCascadeData, type LiveDeps, notConfiguredData, NotConfiguredError } from "./live";
import { createOpLog, type WithdrawalOp } from "./oplog";
import type { FrontDoorState, VaultState, WalletState } from "./reads";

const D: Deployment = {
  frontDoor: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  baseAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  vault: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  bitAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  bitBlock: 1n,
  vaultSs58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
  hotkeySs58: "5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
};
const ME = "0x000000000000000000000000000000000000a11c" as const;

const fd: FrontDoorState = {
  depositOf: 0n,
  redeemOf: 10n ** 21n,
  claimable: 0n,
  openBatchId: 4n,
  openStart: 1_800_000_000,
  openTotal: 0n,
  openDeposits: 0,
  openRedeems: 1,
  netForwarded: 8n * 10n ** 16n,
  depositCap: 15n * 10n ** 16n,
  minDeposit: 10n ** 16n,
  redeemRequestFee: 10n ** 14n,
  canClose: false,
  batchInterval: 600,
};
const vault: VaultState = {
  shares: 8n * 10n ** 22n,
  totalAssets: 8n * 10n ** 16n,
  totalSupply: 8n * 10n ** 22n,
  rootStakeWei: 8n * 10n ** 16n - 10n ** 12n,
  pendingPayouts: 0n,
  balanceWei: 10n ** 12n,
  stakeHotkey: `0x${"58".repeat(32)}`,
  payoutDelay: 3600,
  nominatorMinWei: 2n * 10n ** 16n,
};
const wallet: WalletState = { usdc: 20_000_000n, tao: 0n, eth: 10n ** 15n, usdcRouterAllowance: 0n, usdcStakerAllowance: 0n, taoRouterAllowance: 0n, taoFrontDoorAllowance: 0n };

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

function deps(over: Partial<LiveDeps> = {}): LiveDeps {
  return {
    clients: {} as never,
    opLog: createOpLog(memory(), D.frontDoor),
    readFrontDoor: async () => fd,
    readVault: async () => vault,
    readWallet: async () => wallet,
    readPendingRewards: async () => undefined,
    taoPriceUsd: async () => 250,
    ethPriceUsd: async () => 4000,
    readStakerFees: async () => ({ swapFeeBps: 15n, depositFeeUsdc: 50_000n }),
    quoteBuy: async (_c, usdc) => (usdc * 10n ** 12n) / 252n,
    quoteSell: async (_c, tao) => (tao * 250n) / 10n ** 12n,
    quotePayoutFee: async () => 105n * 10n ** 13n,
    readRewardCutBps: async () => 1000,
    scan: async () => undefined,
    now: () => 1_800_000_100_000,
    ...over,
  };
}

describe("rewards waiting (v3)", () => {
  const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000000000b1", oracle: "0x00000000000000000000000000000000000000b2" };

  it("is the account's share of the vault's uncollected rewards, less the 10% cut", async () => {
    const half = { ...vault, shares: vault.totalSupply / 2n };
    const data = createLiveCascadeData(
      D3,
      deps({ readVault: async () => half, readPendingRewards: async () => ({ wei: 4n * 10n ** 15n, cutBps: 1000 }) }),
    );
    // 0.004 TAO x 1/2 x 0.9
    expect((await data.getPosition(ME)).pendingRewardsTao).toBeCloseTo(0.0018, 12);
  });

  it("stays undefined when the read fails, and the rest of the position is intact", async () => {
    const data = createLiveCascadeData(D3, deps({ readPendingRewards: async () => undefined }));
    const p = await data.getPosition(ME);
    expect(p.pendingRewardsTao).toBeUndefined();
    expect(p.taoBalance).toBeCloseTo(0.08, 12);
  });

  it("is zero, not unknown, when the chain says nothing is waiting", async () => {
    const data = createLiveCascadeData(D3, deps({ readPendingRewards: async () => ({ wei: 0n, cutBps: 1000 }) }));
    expect((await data.getPosition(ME)).pendingRewardsTao).toBe(0);
  });

  it("isn't read or shown on v2, whose Rewards page stays as it was", async () => {
    let asked = 0;
    const data = createLiveCascadeData(D, deps({ readPendingRewards: async () => (asked++, { wei: 4n * 10n ** 15n, cutBps: 1000 }) }));
    const p = await data.getPosition(ME);
    expect(asked).toBe(0);
    expect(p).not.toHaveProperty("pendingRewardsTao");
    expect(p.taoBalance).toBeCloseTo(0.08, 12);
  });
});

describe("unstakes", () => {
  it("are none, without reading either chain, when this browser has made none", async () => {
    let reads = 0;
    const count = async () => (reads++, Promise.reject(new Error("no read expected")));
    const data = createLiveCascadeData(D, deps({ scan: count, readFrontDoor: count, readVault: count }));
    expect(await data.listWithdrawals(ME)).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe("round trip", () => {
  const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000000000b1", oracle: "0x00000000000000000000000000000000000000b2" };

  it("prices the way out's request and bridge fees live, and reads Cascade's reward cut", async () => {
    const asked: bigint[] = [];
    const r = await createLiveCascadeData(
      D3,
      deps({ quotePayoutFee: async (_c, _d, _a, tao) => (asked.push(tao), 105n * 10n ** 13n), readRewardCutBps: async () => 1200 }),
    ).quoteRoundTrip(79n * 10n ** 15n);
    // the bridge fee for this stake's TAO coming back
    expect(asked).toEqual([79n * 10n ** 15n]);
    // 0.0001 ETH at $4,000 + 0.00105 TAO at $250
    expect(r.exitFixedUsd).toBeCloseTo(0.6625, 9);
    expect(r.rewardCutBps).toBe(1200);
  });

  it("fails rather than guessing when a read fails", async () => {
    const data = createLiveCascadeData(D3, deps({ ethPriceUsd: async () => Promise.reject(new Error("down")) }));
    await expect(data.quoteRoundTrip(79n * 10n ** 15n)).rejects.toThrow("down");
  });
});

describe("live data", () => {
  it("includes what is waiting to be claimed on Base with the wallet's balances", async () => {
    const data = createLiveCascadeData(D, deps({ readFrontDoor: async () => ({ ...fd, claimable: 7n * 10n ** 15n }) }));
    expect((await data.getBalances(ME)).claimable).toBe(7n * 10n ** 15n);
  });

  it("prices the position and subtracts shares already asked for", async () => {
    const data = createLiveCascadeData(D, deps());
    const p = await data.getPosition(ME);
    expect(p.taoWei).toBe(8n * 10n ** 16n);
    expect(p.taoBalance).toBeCloseTo(0.08, 10);
    expect(p.usdValue).toBeCloseTo(20, 6);
    expect(p.availableShares).toBe(8n * 10n ** 22n - 10n ** 21n);
  });

  it("also subtracts a request whose batch closed but has not arrived", async () => {
    const d = deps();
    const w: WithdrawalOp = { id: "w", kind: "withdrawal", account: ME, createdAt: 1, shares: 2n * 10n ** 21n, taoEstimate: 0n, usdcEstimate: 0n, fee: 0n, batchId: 3n, state: "sent" };
    d.opLog.put(w);
    const p = await createLiveCascadeData(D, d).getPosition(ME);
    expect(p.availableShares).toBe(8n * 10n ** 22n - 10n ** 21n - 2n * 10n ** 21n);
  });

  it("reads the limits from the cap still free and the minimum deposit", async () => {
    const l = await createLiveCascadeData(D, deps()).getLimits();
    expect(l.minTao).toBe(10n ** 16n);
    expect(l.maxTao).toBe(7n * 10n ** 16n);
    expect(l.minUsd).toBeGreaterThan(2.5);
    expect(l.maxUsd).toBeLessThan(17.5);
  });

  it("v2's minimum stays as it was: the pools' fees, the 0.5% slippage and a 2% margin", async () => {
    // 0.01 TAO at $250 / (0.9965015 x 0.995) x 1.02, up to the cent
    expect((await createLiveCascadeData(D, deps()).getLimits()).minUsd).toBe(2.58);
  });

  it("v3's minimum also covers Cascade's fees, so a stake of the amount shown clears the front door's minimum", async () => {
    const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000000000b1", oracle: "0x00000000000000000000000000000000000000b2" };
    const units = (usd: number) => BigInt(Math.round(usd * 1e6));
    const l = await createLiveCascadeData(D3, deps()).getLimits();
    // the least the stake accepts (its 0.5% floor) is what the front door is sure to get
    const floor = (await createLiveCascadeData(D3, deps()).quoteDeposit(units(l.minUsd))).minTaoOut;
    expect(floor).toBeGreaterThanOrEqual(l.minTao);
    // with room for the price to move against it before the stake goes through
    const worse = deps({ quoteBuy: async (_c, usdc) => (usdc * 10n ** 12n * 100n) / (252n * 101n) });
    expect((await createLiveCascadeData(D3, worse).quoteDeposit(units(l.minUsd))).minTaoOut).toBeGreaterThanOrEqual(l.minTao);
    // the flat fee and the percentage are counted: $0.05 + 0.15% more than without them
    const free = await createLiveCascadeData(D3, deps({ readStakerFees: async () => ({ swapFeeBps: 0n, depositFeeUsdc: 0n }) })).getLimits();
    expect(l.minUsd - free.minUsd).toBeGreaterThanOrEqual(0.05 - 1e-9);
  });

  it("shows total staked and the price, and hides APR and stakers", async () => {
    const s = await createLiveCascadeData(D, deps()).getProtocolStats();
    expect(s).toEqual({ totalStakedTao: 0.08, taoPriceUsd: 250 });
  });

  it("calls the vault fully staked when what is idle is too small to stake", async () => {
    const proof = await createLiveCascadeData(D, deps()).getProof();
    expect(proof.allStaked).toBe(true);
    expect(proof.explorerUrl).toContain(D.vaultSs58);
  });

  it("quotes a deposit with 0.5% slippage, in whole rao", async () => {
    const q = await createLiveCascadeData(D, deps()).quoteDeposit(20_000_000n);
    expect(q.targetTao % 10n ** 9n).toBe(0n);
    expect(q.targetTao).toBeLessThan(q.expectedTao);
    expect(q.feesUsd).toBeCloseTo(20 * 0.0034985, 4);
  });

  it("quotes a withdrawal with the bridge fee and the redeem fee rule", async () => {
    const data = createLiveCascadeData(D, deps());
    const q = await data.quoteWithdrawal(ME, 4n * 10n ** 22n);
    expect(q.taoWei).toBe(4n * 10n ** 16n);
    expect(q.fee).toBe(0n); // a request is already in the open batch
    const first = await createLiveCascadeData(D, deps({ readFrontDoor: async () => ({ ...fd, redeemOf: 0n }) })).quoteWithdrawal(ME, 4n * 10n ** 22n);
    expect(first.fee).toBe(10n ** 14n);
    expect(first.feesUsd).toBeGreaterThan(0.26);
  });

  it("estimates wait for the batch's max wait when the deployment has one, and are unchanged without", async () => {
    const now = fd.openStart * 1000; // the batch has just opened
    const L = { ...D, batchMaxWaitS: 86_400 };
    const plain = createLiveCascadeData(D, deps({ now: () => now }));
    const waits = createLiveCascadeData(L, deps({ now: () => now }));
    const base = await plain.quoteDeposit(20_000_000n);
    expect(base.etaMinutes).toBe(10 + 25 + 2);
    const dep = await waits.quoteDeposit(20_000_000n);
    expect(dep.etaMinutes).toBe(1_440 + 25 + 2);
    expect(dep.closesAt.getTime()).toBe((fd.openStart + 86_400) * 1000);
    const w0 = await plain.quoteWithdrawal(ME, 4n * 10n ** 22n);
    const w1 = await waits.quoteWithdrawal(ME, 4n * 10n ** 22n);
    expect(w1.etaMinutes - w0.etaMinutes).toBe(1_440 - 10);
    expect(w1.etaMinutes).toBeGreaterThanOrEqual(1_440 + 60);
    // a max wait shorter than the interval never shortens the estimate
    const short = await createLiveCascadeData({ ...D, batchMaxWaitS: 60 }, deps({ now: () => now })).quoteDeposit(20_000_000n);
    expect(short.etaMinutes).toBe(base.etaMinutes);
  });

  it("v3 deposit estimate also uses the max wait", async () => {
    const L3: Deployment = { ...D, staker: "0x00000000000000000000000000000000000000b1", oracle: "0x00000000000000000000000000000000000000b2", batchMaxWaitS: 86_400 };
    const q = await createLiveCascadeData(L3, deps({ now: () => fd.openStart * 1000 })).quoteDeposit(20_000_000n);
    expect(q.etaMinutes).toBeGreaterThanOrEqual(1_440);
  });

  it("v3 quotes a deposit net of the staker's fees, with a rao-rounded floor", async () => {
    const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000000000b1", oracle: "0x00000000000000000000000000000000000000b2" };
    const seen: bigint[] = [];
    const q = await createLiveCascadeData(
      D3,
      deps({ quoteBuy: async (_c, usdc) => (seen.push(usdc), (usdc * 10n ** 12n) / 252n) }),
    ).quoteDeposit(1_000_000_000n);
    expect(seen).toEqual([998_450_075n]);
    expect(q.depositFeeUsdc).toBe(50_000n);
    expect(q.swapFeeUsdc).toBe(1_499_925n);
    expect(q.cascadeFeesUsd).toBeCloseTo(1.549925, 6);
    const exactMin = (q.expectedTao * 9_950n) / 10_000n;
    expect(q.minTaoOut % 10n ** 9n).toBe(0n);
    expect(q.minTaoOut).toBeGreaterThanOrEqual(exactMin);
    expect(q.minTaoOut - exactMin).toBeLessThan(10n ** 9n);
    expect(q.targetTao).toBe((q.expectedTao / 10n ** 9n) * 10n ** 9n);
    expect(q.feesUsd).toBeCloseTo(q.cascadeFeesUsd + 998.450075 * 0.0034985, 4);
  });

  it("v3 quotes a withdrawal with a delivery price floor and a week's deadline", async () => {
    const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000000000b1", oracle: "0x00000000000000000000000000000000000000b2" };
    const q = await createLiveCascadeData(D3, deps()).quoteWithdrawal(ME, 4n * 10n ** 22n);
    const gross = (10n ** 18n * 250n) / 10n ** 12n; // mocked 1 TAO sale
    const net = gross - (gross * 15n) / 10_000n;
    expect(q.minUsdcPerTao).toBe((net * 9_800n) / 10_000n);
    expect(q.deliveryDeadline).toBe(1_800_000_100 + 604_800);
    // 0.04 TAO less the bridge fee, sold at the mocked price; the user gets that less 15 bps
    const sold = ((4n * 10n ** 16n - 105n * 10n ** 13n) * 250n) / 10n ** 12n;
    const fee = (sold * 15n) / 10_000n;
    expect(q.usdcAmount).toBeCloseTo(Number(sold - fee) / 1e6, 6);
    const v2 = await createLiveCascadeData(D, deps()).quoteWithdrawal(ME, 4n * 10n ** 22n);
    expect(v2.usdcAmount).toBeCloseTo(Number(sold) / 1e6, 6);
    expect(q.feesUsd - v2.feesUsd).toBeCloseTo(Number(fee) / 1e6, 6);
  });

  it("v2 quotes carry no v3 fees or limits", async () => {
    const data = createLiveCascadeData(D, deps());
    const q = await data.quoteDeposit(20_000_000n);
    expect(q.depositFeeUsdc).toBe(0n);
    expect(q.swapFeeUsdc).toBe(0n);
    expect(q.cascadeFeesUsd).toBe(0);
    expect(q.feesUsd).toBeCloseTo(20 * 0.0034985, 4);
    const w = await data.quoteWithdrawal(ME, 4n * 10n ** 22n);
    expect(w.minUsdcPerTao).toBe(0n);
    expect(w.deliveryDeadline).toBe(0);
  });

  it("a site without a deployment refuses every read", async () => {
    await expect(notConfiguredData().getProtocolStats()).rejects.toBeInstanceOf(NotConfiguredError);
  });


  it("never runs two scans of the same account at once", async () => {
    let running = 0;
    let overlapped = false;
    let calls = 0;
    const scan = async () => {
      calls++;
      running++;
      if (running > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 10));
      running--;
    };
    const data = createLiveCascadeData(D, deps({ scan }));
    await Promise.all([data.getPosition(ME), data.getPosition(ME), data.getPosition(ME)]);
    expect(overlapped).toBe(false);
    expect(calls).toBeLessThanOrEqual(1);
  });
});
