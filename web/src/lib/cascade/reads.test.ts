import { decodeAbiParameters, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbiParameters, size } from "viem";
import { describe, expect, it } from "vitest";
import { type Deployment, MULTICALL3 } from "./config";
import { FRONT_DOOR } from "./abi";
import { basketTwrKey, STORAGE_QUERY } from "./apy";
import {
  CLOSE_GAS,
  encodeBatch,
  readApyPercent,
  readBatchClosed,
  readFrontDoor,
  readNextBatch,
  readOpenBatch,
  readPendingRewards,
  readRewardCutBps,
  readVault,
  readWallet,
  taoPriceUsd,
} from "./reads";

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
const H32 = `0x${"ab".repeat(32)}` as Hex;

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
    const without: Record<string, unknown> = { ...answers };
    delete without.maxEntryValue;
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

describe("the open batch, for Send it now", () => {
  const ALICE = getAddress("0x00000000000000000000000000000000000a11ce");
  const BOB = getAddress("0x0000000000000000000000000000000000000b0b");
  const deposits = [
    { user: ALICE, amount: 2n * 10n ** 17n },
    { user: getAddress(ME), amount: 10n ** 17n },
  ];
  const redeems = [{ user: BOB, amount: 5n * 10n ** 21n }];
  const FEE = 744_898_037_875_672n;

  /** Base as the front door, its adapter, the wallet and Uniswap's quoter answer it; each eth_call recorded. */
  function base(over: { canClose?: boolean; paused?: boolean; entries?: boolean; quote?: () => bigint; gas?: () => bigint } = {}) {
    const calls: { address: string; functionName: string; args?: readonly unknown[]; account?: unknown }[] = [];
    const asked: string[] = [];
    const empty = over.entries === false;
    const answers: Record<string, unknown> = {
      openBatch: [7n, 1_800_000_000n, empty ? 0n : 3n * 10n ** 17n, 10n ** 14n, empty ? 0n : 2n, empty ? 0n : 1n],
      openDeposits: empty ? [] : deposits,
      openRedeems: empty ? [] : redeems,
      canClose: over.canClose ?? true,
      batchInterval: 3_600n,
      paused: over.paused ?? false,
      depositOf: empty ? 0n : 10n ** 17n,
      redeemOf: 0n,
      getCurrentBlockTimestamp: 1_800_007_200n,
    };
    let multicalls = 0;
    const client = {
      async multicall({ contracts }: { contracts: { address: string; functionName: string; args?: readonly unknown[] }[] }) {
        multicalls++;
        return contracts.map((c) => {
          asked.push(c.functionName);
          if (!(c.functionName in answers)) throw new Error(`unexpected ${c.functionName}`);
          if (c.functionName === "depositOf" || c.functionName === "redeemOf") expect(c.args).toEqual([ME]);
          // Base's clock, from the same block as the rest
          if (c.functionName === "getCurrentBlockTimestamp") expect(c.address).toBe(MULTICALL3);
          return answers[c.functionName];
        });
      },
      async readContract(c: { address: string; functionName: string; args?: readonly unknown[]; account?: unknown }) {
        calls.push(c);
        if (c.functionName === "quoteFee") return (over.quote ?? (() => FEE))();
        if (c.functionName === "quoteExactInput") return [2_330_000n, [], [], 0n];
        throw new Error(`unexpected ${c.functionName}`);
      },
      async getBalance({ address }: { address: string }) {
        asked.push("getBalance");
        expect(address).toBe(ME);
        return 10n ** 16n;
      },
      async estimateFeesPerGas() {
        asked.push("estimateFeesPerGas");
        return { maxFeePerGas: (over.gas ?? (() => 7_000_000n))(), maxPriorityFeePerGas: 1_000_000n };
      },
    };
    return {
      client: client as never,
      calls,
      asked,
      get multicalls() {
        return multicalls;
      },
    };
  }

  it("for anyone: when it started, what waits in it and Base's clock, in one multicall and nothing else", async () => {
    const b = base();
    expect(await readNextBatch({ base: b.client }, D)).toEqual({
      id: 7n,
      start: 1_800_000_000,
      interval: 3_600,
      canClose: true,
      paused: false,
      deposits: 2,
      redeems: 1,
      chainTime: 1_800_007_200,
    });
    expect(b.multicalls).toBe(1);
    expect(b.asked).toEqual(["openBatch", "canClose", "batchInterval", "paused", "getCurrentBlockTimestamp"]);
    expect(b.calls).toEqual([]);
  });

  it("encodes the batch exactly as the front door does: abi.encode(1, id, deposits, redeems)", () => {
    const message = encodeBatch(7n, deposits, redeems);
    const [kind, id, d, r] = decodeAbiParameters(
      parseAbiParameters("uint8, uint64, (address user, uint256 amount)[], (address user, uint256 amount)[]"),
      message,
    );
    expect([kind, id]).toEqual([1, 7n]);
    expect(d).toEqual(deposits);
    expect(r).toEqual(redeems);
    // the adapter prices gas from the message's shape (CcipAdapterBase.gasFor): six header words, then
    // two words per entry; any other shape would be quoted at its gas cap
    expect(size(message)).toBe(32 * (6 + 2 * 3));
  });

  it("asks the bridge for the fee of this batch's exact message, as the front door asks it", async () => {
    const b = base();
    const batch = await readOpenBatch({ base: b.client }, D, ME);
    const quote = b.calls.find((c) => c.functionName === "quoteFee");
    // the primary bridge (wiring.ts checks it is this adapter), to the vault on Bittensor (chain 964),
    // for the batch's TAO, from the front door: the call closeBatch makes inside
    expect(quote).toMatchObject({ address: D.baseAdapter, args: [964n, D.vault, encodeBatch(7n, deposits, redeems), 3n * 10n ** 17n], account: D.frontDoor });
    expect(batch).toEqual({
      id: 7n,
      start: 1_800_000_000,
      interval: 3_600,
      canClose: true,
      paused: false,
      chainTime: 1_800_007_200,
      mine: { depositWei: 10n ** 17n, redeemShares: 0n },
      potWei: 10n ** 14n,
      feeWei: FEE,
      ethWei: 10n ** 16n,
      // a generous allowance for closeBatch's gas at today's price
      gasWei: CLOSE_GAS * 7_000_000n,
      ethPriceUsd: 2_330,
    });
  });

  it("before the batch can close, reads nothing it can't use yet: no fee, balance, gas or price", async () => {
    for (const over of [{ canClose: false }, { paused: true }, { entries: false }]) {
      const b = base(over);
      const batch = await readOpenBatch({ base: b.client }, D, ME);
      expect(b.calls, JSON.stringify(over)).toEqual([]);
      expect(b.asked).not.toContain("getBalance");
      expect(batch).not.toHaveProperty("feeWei");
      expect(batch).not.toHaveProperty("ethPriceUsd");
    }
  });

  it("leaves out only the figure a failed read was for: never a guess in its place", async () => {
    const fail = (): never => {
      throw new Error("rate limited");
    };
    const batch = await readOpenBatch({ base: base({ quote: fail, gas: fail }).client }, D, ME);
    expect(batch).not.toHaveProperty("feeWei");
    expect(batch).not.toHaveProperty("gasWei");
    expect(batch).toMatchObject({ ethWei: 10n ** 16n, ethPriceUsd: 2_330, canClose: true });
  });

  it("reads what a send paid from its receipt: the front door's BatchClosed, its fee and the pot's share", async () => {
    const topics = encodeEventTopics({ abi: FRONT_DOOR, eventName: "BatchClosed", args: { id: 7n } });
    const data = encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, uint256, uint256"), [3n * 10n ** 17n, 2n, 1n, FEE, 10n ** 14n]);
    const log = (address: string) => ({ address, topics, data, blockNumber: 1n, logIndex: 0, transactionHash: H32, transactionIndex: 0, blockHash: H32, removed: false });
    const receipt = (logs: unknown[]) => ({ base: { getTransactionReceipt: async () => ({ logs }) } as never });
    expect(await readBatchClosed(receipt([log(D.frontDoor)]), D, H32)).toEqual({ feeWei: FEE, potUsedWei: 10n ** 14n });
    // another contract's event of the same shape isn't the front door's
    expect(await readBatchClosed(receipt([log(D.baseAdapter)]), D, H32)).toBeUndefined();
    expect(await readBatchClosed({ base: { getTransactionReceipt: async () => Promise.reject(new Error("not found")) } as never }, D, H32)).toBeUndefined();
  });
});
