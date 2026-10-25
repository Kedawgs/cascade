import { describe, expect, it } from "vitest";
import type { Deployment } from "./config";
import { readFrontDoor, readVault, readWallet, taoPriceUsd } from "./reads";

const D: Deployment = {
  frontDoor: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  baseAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  vault: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  bitAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  bitBlock: 9357492n,
  vaultSs58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
  hotkeySs58: "5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
};
const ME = "0x000000000000000000000000000000000000a11c" as const;

/** A client that answers multicalls by function name and records what was asked. */
function fake(answers: Record<string, unknown>, balance = 0n) {
  const asked: string[] = [];
  const pinned: (bigint | undefined)[] = [];
  const client = {
    async getBlock() {
      return { number: 9_400_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
    },
    async multicall({ contracts, blockNumber }: { contracts: { functionName: string }[]; blockNumber?: bigint }) {
      pinned.push(blockNumber);
      return contracts.map((c) => {
        asked.push(c.functionName);
        if (!(c.functionName in answers)) throw new Error(`unexpected ${c.functionName}`);
        return answers[c.functionName];
      });
    },
    async readContract({ functionName, args }: { functionName: string; args: unknown[] }) {
      asked.push(functionName);
      return (answers[functionName] as (a: unknown[]) => unknown)(args);
    },
    async getBalance({ blockNumber }: { blockNumber?: bigint } = {}) {
      pinned.push(blockNumber);
      return balance;
    },
  };
  return { client: client as never, asked, pinned };
}

describe("reads", () => {
  it("maps the front door's state, including the open batch", async () => {
    const base = fake({
      depositOf: 10n ** 16n,
      redeemOf: 0n,
      claimable: 5n,
      openBatch: [3n, 1_800_000_000n, 10n ** 16n, 0n, 1n, 0n],
      netForwarded: 2n * 10n ** 16n,
      depositCap: 15n * 10n ** 16n,
      minDeposit: 10n ** 16n,
      redeemRequestFee: 10n ** 14n,
      canClose: false,
      batchInterval: 600n,
    });
    const fd = await readFrontDoor({ base: base.client }, D, ME);
    expect(fd).toEqual({
      depositOf: 10n ** 16n,
      redeemOf: 0n,
      claimable: 5n,
      openBatchId: 3n,
      openStart: 1_800_000_000,
      openTotal: 10n ** 16n,
      openDeposits: 1,
      openRedeems: 0,
      netForwarded: 2n * 10n ** 16n,
      depositCap: 15n * 10n ** 16n,
      minDeposit: 10n ** 16n,
      redeemRequestFee: 10n ** 14n,
      canClose: false,
      batchInterval: 600,
    });
  });

  it("reads the vault on Bittensor", async () => {
    const bit = fake(
      {
        balanceOf: 10n ** 22n,
        totalAssets: 2n * 10n ** 16n,
        totalSupply: 2n * 10n ** 22n,
        rootStakeRao: 15_000_000n,
        pendingPayouts: 0n,
        stakeHotkey: `0x${"58".repeat(32)}`,
        payoutDelay: 3600n,
        getNominatorMinRequiredStake: 20_000_000n,
      },
      2n * 10n ** 16n,
    );
    const v = await readVault({ bittensor: bit.client }, D, ME);
    expect(v).toMatchObject({ shares: 10n ** 22n, rootStakeWei: 15n * 10n ** 15n, nominatorMinWei: 2n * 10n ** 16n, payoutDelay: 3600, balanceWei: 2n * 10n ** 16n });
    // read at a block known to be recent, so a lagging server errors instead of answering from the past
    expect(bit.pinned).toEqual([9_400_000n, 9_400_000n]);
  });

  it("reads the wallet's balances and the allowances the flows need", async () => {
    const base = fake({ balanceOf: 7n, allowance: 0n }, 3n);
    const w = await readWallet({ base: base.client }, D, ME);
    expect(w).toEqual({ usdc: 7n, tao: 7n, eth: 3n, usdcRouterAllowance: 0n, taoRouterAllowance: 0n, taoFrontDoorAllowance: 0n });
    expect(base.asked.filter((n) => n === "allowance")).toHaveLength(3);
  });

  it("prices TAO from what selling 0.01 TAO would pay, in dollars", async () => {
    const base = fake({ quoteExactInput: () => [2_515_000n, [], [], 0n] });
    expect(await taoPriceUsd({ base: base.client })).toBeCloseTo(251.5, 6);
  });
});
