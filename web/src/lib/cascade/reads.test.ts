import { describe, expect, it } from "vitest";
import type { Deployment } from "./config";
import { basketTwrKey, STORAGE_QUERY } from "./apy";
import { readApyPercent, readFrontDoor, readPendingRewards, readRewardCutBps, readVault, readWallet, taoPriceUsd } from "./reads";

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
      maxBatchValue: 10n ** 19n,
      maxDeposits: 50,
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
      maxBatchValue: 10n ** 19n,
      maxDeposits: 50,
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
    // v2: no per-unstake limit is asked for, nor given
    expect(bit.asked).not.toContain("maxEntryValue");
    expect(v.maxEntryValue).toBeUndefined();
  });

  it("on v3 also reads the most one unstake can carry (the vault's maxEntryValue)", async () => {
    const answers = {
      balanceOf: 10n ** 22n,
      totalAssets: 2n * 10n ** 16n,
      totalSupply: 2n * 10n ** 22n,
      rootStakeRao: 15_000_000n,
      pendingPayouts: 0n,
      stakeHotkey: `0x${"58".repeat(32)}`,
      payoutDelay: 86_400n,
      getNominatorMinRequiredStake: 20_000_000n,
      maxEntryValue: 10n * 10n ** 18n,
    };
    const D3 = { ...D, staker: "0x00000000000000000000000000000000005A4E12", oracle: "0x000000000000000000000000000000000000041E" } as Deployment;
    const v = await readVault({ bittensor: fake(answers).client }, D3, ME);
    expect(v.maxEntryValue).toBe(10n * 10n ** 18n);
    // a vault that can't say fails the read, so the form never offers an unchecked amount
    const { maxEntryValue: _m, ...without } = answers;
    await expect(readVault({ bittensor: fake(without).client }, D3, ME)).rejects.toThrow(/maxEntryValue/);
  });

  it("reads the wallet's balances and the allowances the flows need", async () => {
    const base = fake({ balanceOf: 7n, allowance: 0n }, 3n);
    const w = await readWallet({ base: base.client }, D, ME);
    expect(w).toEqual({ usdc: 7n, tao: 7n, eth: 3n, usdcRouterAllowance: 0n, usdcStakerAllowance: 0n, taoRouterAllowance: 0n, taoFrontDoorAllowance: 0n });
    // a v2 deployment has no staker to ask about
    expect(base.asked.filter((n) => n === "allowance")).toHaveLength(3);
  });

  it("on v3 also reads the USDC allowance the staker has", async () => {
    const base = fake({ balanceOf: 7n, allowance: 20_000_000n }, 3n);
    const D3 = { ...D, staker: "0x00000000000000000000000000000000005A4E12", oracle: "0x000000000000000000000000000000000000041E" } as Deployment;
    const w = await readWallet({ base: base.client }, D3, ME);
    expect(w.usdcStakerAllowance).toBe(20_000_000n);
    expect(base.asked.filter((n) => n === "allowance")).toHaveLength(4);
  });

  it("prices TAO from what selling 0.01 TAO would pay, in dollars", async () => {
    const base = fake({ quoteExactInput: () => [2_515_000n, [], [], 0n] });
    expect(await taoPriceUsd({ base: base.client })).toBeCloseTo(251.5, 6);
  });
});

describe("readPendingRewards", () => {
  const hotkey = `0x${"58".repeat(32)}` as const;
  it("asks the staking precompile with the vault's own coldkey and hotkey", async () => {
    const bit = fake({
      coldkey: `0x${"11".repeat(32)}`,
      rewardCutBps: 1000,
      totalSupply: 0n,
      getUnclaimedRootTaoByHotkey: (a: unknown[]) => (a[0] === `0x${"11".repeat(32)}` && a[1] === hotkey ? 5n : 0n),
    });
    const r = await readPendingRewards({ bittensor: bit.client }, D, hotkey);
    expect(r?.wei).toBe(5n);
  });
  it("is undefined when a read fails", async () => {
    const bit = fake({ coldkey: `0x${"11".repeat(32)}`, rewardCutBps: 1000, totalSupply: 0n, getUnclaimedRootTaoByHotkey: () => { throw new Error("boom"); } });
    expect(await readPendingRewards({ bittensor: bit.client }, D, hotkey)).toBeUndefined();
  });
});

describe("readRewardCutBps", () => {
  it("reads the v3 vault's cut", async () => {
    const bit = fake({ rewardCutBps: () => 1000 });
    const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000000000b1", oracle: "0x00000000000000000000000000000000000000b2" };
    expect(await readRewardCutBps({ bittensor: bit.client }, D3)).toBe(1000);
    expect(bit.asked).toEqual(["rewardCutBps"]);
  });
  it("is zero on v2, which has no cut, without asking", async () => {
    const bit = fake({});
    expect(await readRewardCutBps({ bittensor: bit.client }, D)).toBe(0);
    expect(bit.asked).toEqual([]);
  });
});

describe("readApyPercent", () => {
  const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000000000b1", oracle: "0x00000000000000000000000000000000000000b2" };
  const HOTKEY = `0x${"56".repeat(32)}` as const;
  const ONE = 2n ** 64n;
  const le = (bits: bigint) => `0x${Array.from({ length: 16 }, (_, k) => ((bits >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0")).join("")}`;

  /** An archive node: 12-second blocks, a BasketTwr value per block number. */
  function archive(twr: Record<string, string>, head = 9_400_000n) {
    const calls: { to: string; data: string; blockNumber: bigint }[] = [];
    const client = {
      async readContract({ functionName }: { functionName: string }) {
        return functionName === "stakeHotkey" ? HOTKEY : 1000;
      },
      async getBlock(args: { blockNumber?: bigint } = {}) {
        const number = args.blockNumber ?? head;
        return { number, timestamp: 1_800_000_000n - (head - number) * 12n };
      },
      async call(a: { to: string; data: string; blockNumber: bigint }) {
        calls.push(a);
        return { data: twr[a.blockNumber.toString()] };
      },
    };
    return { client: client as never, calls };
  }

  it("reads the vault validator's series now and 216,000 blocks back, timed by the blocks' clocks", async () => {
    const { client, calls } = archive({ "9400000": le((ONE * 1004n) / 1000n), "9184000": le(ONE) });
    const apy = await readApyPercent({ bittensorHistory: client }, D3);
    expect(calls.map((c) => c.blockNumber)).toEqual([9_400_000n, 9_184_000n]);
    expect(calls.every((c) => c.to === STORAGE_QUERY && c.data === basketTwrKey(HOTKEY))).toBe(true);
    expect(apy).toBeCloseTo(4.469, 3);
  });

  it("has nothing to show before there are 30 days of chain, or without a series", async () => {
    const young = archive({}, 100_000n);
    expect(await readApyPercent({ bittensorHistory: young.client }, D3)).toBeUndefined();
    expect(young.calls).toEqual([]);
    const none = archive({ "9400000": le(ONE) });
    expect(await readApyPercent({ bittensorHistory: none.client }, D3)).toBeUndefined();
  });
});
