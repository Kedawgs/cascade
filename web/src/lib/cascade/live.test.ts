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
const wallet: WalletState = { usdc: 20_000_000n, tao: 0n, eth: 10n ** 15n, usdcRouterAllowance: 0n, taoRouterAllowance: 0n, taoFrontDoorAllowance: 0n };

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
    taoPriceUsd: async () => 250,
    ethPriceUsd: async () => 4000,
    quoteBuy: async (_c, usdc) => (usdc * 10n ** 12n) / 252n,
    quoteSell: async (_c, tao) => (tao * 250n) / 10n ** 12n,
    quotePayoutFee: async () => 105n * 10n ** 13n,
    scan: async () => undefined,
    now: () => 1_800_000_100_000,
    ...over,
  };
}

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
