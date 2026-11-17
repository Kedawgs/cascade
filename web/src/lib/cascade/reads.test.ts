import { type Address, decodeAbiParameters, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbiParameters, size } from "viem";
import { describe, expect, it } from "vitest";
import { ALPHA_VAULT, type Deployment, FEE_CHECK_BPS, MULTICALL3 } from "./config";
import { FRONT_DOOR, FRONT_DOOR_V32 } from "./abi";
import { basketTwrKey, STORAGE_QUERY } from "./apy";
import { nextBatchLine } from "../batch-clock";
import { StaleChainError } from "./fresh";
import { requestHold } from "../stake-form";
import {
  CLOSE_GAS,
  encodeBatch,
  feesAgree,
  readApyPercent,
  readCancelState,
  readCloseOutcome,
  readFrontDoor,
  readNextBatch,
  readOpenBatch,
  readOraclePrice,
  readPendingRewards,
  readRedeemList,
  readRewardCutBps,
  readRewardVesting,
  readThinPool,
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

/** A client that answers multicalls by function name and records what was asked. Multicall3's own two (the block a
 * multicall is answered at, and an address's balance) answer the fake's block and `balance` unless given. */
function fake(answers: Record<string, unknown>, balance = 0n) {
  const asked: string[] = [];
  const pinned: (bigint | undefined)[] = [];
  const own: Record<string, unknown> = { getBlockNumber: 9_400_000n, getEthBalance: balance };
  const client = {
    async getBlock() {
      return { number: 9_400_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
    },
    async multicall({ contracts, blockNumber }: { contracts: { functionName: string }[]; blockNumber?: bigint }) {
      pinned.push(blockNumber);
      return contracts.map((c) => {
        asked.push(c.functionName);
        if (c.functionName in answers) return answers[c.functionName];
        if (c.functionName in own) return own[c.functionName];
        throw new Error(`unexpected ${c.functionName}`);
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

  it("R11: on v3.2 reads the account's cancelableAt in the same multicall as its deposit (one block for both), and 0 as 0; v3-launch asks nothing of it", async () => {
    const answers = {
      depositOf: 10n ** 16n,
      redeemOf: 0n,
      claimable: 0n,
      openBatch: [3n, 1_800_000_000n, 10n ** 16n, 0n, 1n, 0n],
      netForwarded: 0n,
      depositCap: 15n * 10n ** 16n,
      minDeposit: 10n ** 16n,
      redeemRequestFee: 10n ** 14n,
      canClose: false,
      batchInterval: 600n,
      maxBatchValue: 10n ** 19n,
      maxDeposits: 50,
      cancelableAt: 1_800_000_300n,
      getCurrentBlockTimestamp: 1_800_000_100n,
    };
    const D32: Deployment = { ...D, staker: D.frontDoor, oracle: D.frontDoor, vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
    const v32 = fake(answers);
    const fd = await readFrontDoor({ base: v32.client }, D32, ME);
    expect(fd.cancelableAt).toBe(1_800_000_300);
    expect(v32.asked.at(-1)).toBe("cancelableAt");
    expect(v32.asked.filter((x) => x === "depositOf")).toHaveLength(1);
    // build B: 0, no wait (the door paused or its primary disabled)
    expect((await readFrontDoor({ base: fake({ ...answers, cancelableAt: 0n }).client }, D32, ME)).cancelableAt).toBe(0);
    const launch = fake(answers);
    expect(await readFrontDoor({ base: launch.client }, D, ME)).not.toHaveProperty("cancelableAt");
    expect(launch.asked).not.toContain("cancelableAt");
  });

  it("R12d (M1): on v3.2 the block's own time comes with cancelableAt, in the same multicall, and the device's clock when the read landed: the receipt counts the wait on Base's clock; v3-launch asks neither", async () => {
    const answers = {
      depositOf: 10n ** 16n,
      redeemOf: 0n,
      claimable: 0n,
      openBatch: [3n, 1_800_000_000n, 10n ** 16n, 0n, 1n, 0n],
      netForwarded: 0n,
      depositCap: 15n * 10n ** 16n,
      minDeposit: 10n ** 16n,
      redeemRequestFee: 10n ** 14n,
      canClose: false,
      batchInterval: 600n,
      maxBatchValue: 10n ** 19n,
      maxDeposits: 50,
      cancelableAt: 1_800_000_300n,
      getCurrentBlockTimestamp: 1_800_000_100n,
    };
    const D32: Deployment = { ...D, staker: D.frontDoor, oracle: D.frontDoor, vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
    const v32 = fake(answers);
    const before = Date.now();
    const fd = await readFrontDoor({ base: v32.client }, D32, ME);
    expect(fd.cancelClock?.chainTime).toBe(1_800_000_100);
    expect(fd.cancelClock?.readAt).toBeGreaterThanOrEqual(before);
    expect(fd.cancelClock?.readAt).toBeLessThanOrEqual(Date.now());
    // one multicall: the block's time and the cooldown from the same block
    expect(v32.pinned).toHaveLength(1);
    expect(v32.asked.filter((x) => x === "getCurrentBlockTimestamp")).toHaveLength(1);
    const launch = fake(answers);
    expect(await readFrontDoor({ base: launch.client }, D, ME)).not.toHaveProperty("cancelClock");
    expect(launch.asked).not.toContain("getCurrentBlockTimestamp");
  });

  it("R12d (M2): a cancel's own read: the open batch's id, the account's deposit and cooldown, and Base's clock, in one multicall of four, nothing else (no fee quote, price, log or Bittensor)", async () => {
    const D32: Deployment = { ...D, staker: D.frontDoor, oracle: D.frontDoor, vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
    const base = fake({ openBatch: [7n, 1_800_000_000n, 10n ** 17n, 0n, 1n, 0n], depositOf: 10n ** 17n, getCurrentBlockTimestamp: 1_800_000_100n, cancelableAt: 1_800_000_300n });
    expect(await readCancelState({ base: base.client }, D32, ME)).toEqual({ id: 7n, chainTime: 1_800_000_100, mine: { depositWei: 10n ** 17n, cancelableAt: 1_800_000_300 } });
    expect(base.asked.sort()).toEqual(["cancelableAt", "depositOf", "getCurrentBlockTimestamp", "openBatch"]);
    expect(base.pinned).toHaveLength(1);
  });

  it("R12d (M2): the redeem list's own read before an unstake: its count, its limit and the account's request, in one multicall of three", async () => {
    const D32: Deployment = { ...D, staker: D.frontDoor, oracle: D.frontDoor, vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
    const base = fake({ openBatch: [7n, 1_800_000_000n, 10n ** 17n, 0n, 1n, 50n], maxRedeems: 50, redeemOf: 3n });
    expect(await readRedeemList({ base: base.client }, D32, ME)).toEqual({ nRedeems: 50, maxRedeems: 50, redeemShares: 3n });
    expect(base.asked.sort()).toEqual(["maxRedeems", "openBatch", "redeemOf"]);
    expect(base.pinned).toHaveLength(1);
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
    // one multicall at the newest block, its balance in it (Multicall3's getEthBalance), no read of its own after
    expect(bit.pinned).toEqual([undefined]);
    expect(bit.asked).toContain("getEthBalance");
    expect(bit.asked).toContain("getBlockNumber");
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

  /** An archive node: `blockS`-second blocks (12), a BasketTwr value per block number; reached on the yield's two
   * connections (chain.ts), each request recorded with the connection it came on. */
  function archive(twr: Record<string, string>, head = 9_400_000n, blockS = 12n) {
    const calls: { to: string; data: string; blockNumber: bigint }[] = [];
    const sent: string[] = [];
    const on = (connection: "yield" | "deep") => ({
      async readContract({ functionName }: { functionName: string }) {
        sent.push(`${connection}: ${functionName}`);
        return functionName === "stakeHotkey" ? HOTKEY : 1000;
      },
      async getBlock(args: { blockNumber?: bigint } = {}) {
        const number = args.blockNumber ?? head;
        sent.push(`${connection}: header ${args.blockNumber ?? "latest"}`);
        return { number, timestamp: 1_800_000_000n - (head - number) * blockS };
      },
      async call(a: { to: string; data: string; blockNumber: bigint }) {
        calls.push(a);
        sent.push(`${connection}: series at ${a.blockNumber}`);
        return { data: twr[a.blockNumber.toString()] };
      },
    });
    return { clients: { bittensorYield: on("yield") as never, bittensorDeep: on("deep") as never }, calls, sent };
  }

  it("reads the vault validator's series now and 216,000 blocks back, timed by the blocks' clocks", async () => {
    const { clients, calls } = archive({ "9400000": le((ONE * 1004n) / 1000n), "9184000": le(ONE) });
    const apy = await readApyPercent(clients, D3);
    expect(calls.map((c) => c.blockNumber)).toEqual([9_400_000n, 9_184_000n]);
    expect(calls.every((c) => c.to === STORAGE_QUERY && c.data === basketTwrKey(HOTKEY))).toBe(true);
    expect(apy).toBeCloseTo(4.469, 3);
  });

  it("reads 30 days back by time, at Bittensor's block time as measured from two spans of its headers: at 6 s a block, 432,000 blocks", async () => {
    const { clients, calls } = archive({ "9400000": le((ONE * 1004n) / 1000n), "8968000": le(ONE) }, 9_400_000n, 6n);
    expect(await readApyPercent(clients, D3)).toBeCloseTo(4.469, 3);
    expect(calls.map((c) => c.blockNumber)).toEqual([9_400_000n, 8_968_000n]);
  });

  it("has nothing to show before there are 30 days of chain, or without a series", async () => {
    const young = archive({}, 100_000n);
    expect(await readApyPercent(young.clients, D3)).toBeUndefined();
    expect(young.calls).toEqual([]);
    const none = archive({ "9400000": le(ONE) });
    expect(await readApyPercent(none.clients, D3)).toBeUndefined();
  });

  it("sends the two reads of the block 30 days back on their own connection, which never batches: the slow read travels alone, and today's reads never wait in a batch with it", async () => {
    const { clients, sent } = archive({ "9400000": le((ONE * 1004n) / 1000n), "9184000": le(ONE) });
    await readApyPercent(clients, D3);
    // 30 days back: the series' value then and that block's header (its time), and nothing else, on the deep connection
    expect(sent.filter((x) => x.startsWith("deep: ")).sort()).toEqual(["deep: header 9184000", "deep: series at 9184000"]);
    // today's reads, and the block time's two spans of recent headers, on the yield's batching connection
    expect(sent.filter((x) => x.startsWith("yield: ")).sort()).toEqual(
      ["yield: header 9399400", "yield: header 9399700", "yield: header latest", "yield: rewardCutBps", "yield: series at 9400000", "yield: stakeHotkey"].sort(),
    );
  });

  it("fails as a whole when the read 30 days back does (the query then tries again in a few minutes), never with half a figure", async () => {
    const { clients } = archive({ "9400000": le((ONE * 1004n) / 1000n), "9184000": le(ONE) });
    const deep = clients.bittensorDeep as unknown as { call: () => Promise<never> };
    deep.call = () => Promise.reject(new Error("The request took too long to respond."));
    await expect(readApyPercent(clients, D3)).rejects.toThrow(/too long/);
  });
});

describe("the oracle's price, for the check before any stake", () => {
  const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000005A4E12" as Address, oracle: "0x000000000000000000000000000000000000041E" as Address };
  /** A Base RPC that answers usdcValue at `price` dollars a TAO (or fails), recording what it was asked. */
  const rpc = (price?: number) => {
    const asked: { address: string; functionName: string; args?: readonly unknown[] }[] = [];
    return {
      asked,
      client: {
        async readContract(c: { address: string; functionName: string; args?: readonly unknown[] }) {
          asked.push(c);
          if (price === undefined) throw new Error("HTTP request failed. Status: 429");
          if (c.functionName !== "usdcValue") throw new Error(`unexpected ${c.functionName}`);
          return ((c.args?.[0] as bigint) * BigInt(Math.round(price * 1e6))) / 10n ** 18n;
        },
      } as never,
    };
  };

  it("reads the oracle's TWAP of one TAO on the second Base RPC's short-timeout connection, not the one the quote came from", async () => {
    const [first, second] = [rpc(250), rpc(255)];
    expect(await readOraclePrice({ base: first.client, baseCheck: second.client }, D3)).toBe(255_000_000n);
    expect(second.asked).toEqual([{ address: D3.oracle, functionName: "usdcValue", args: [10n ** 18n], abi: expect.anything() }]);
    expect(first.asked).toEqual([]);
  });

  it("falls back to the first RPC when the second can't answer (the TWAP contract is still another source than the quoter), and fails when neither can", async () => {
    const first = rpc(250);
    expect(await readOraclePrice({ base: first.client, baseCheck: rpc().client }, D3)).toBe(250_000_000n);
    expect(first.asked.map((c) => c.functionName)).toEqual(["usdcValue"]);
    await expect(readOraclePrice({ base: rpc().client, baseCheck: rpc().client }, D3)).rejects.toThrow();
  });

  it("has nothing to read for a deployment without an oracle (v2)", async () => {
    const first = rpc(250);
    await expect(readOraclePrice({ base: first.client, baseCheck: first.client }, D)).rejects.toThrow(/no price oracle/);
    expect(first.asked).toEqual([]);
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
  const START = 1_800_000_000;
  const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000005A4E12" as Address, oracle: "0x000000000000000000000000000000000000041E" as Address };

  /** Base and Bittensor as the front door, its adapter, the staker, the oracle, the wallet, Uniswap's quoter,
   * the vault and ForeverMoney's AlphaVault answer them, `at` seconds into the batch; each read recorded. */
  /** v3.2's deploy rail in these reads (R4-O round 3): the door's primary and its Bittensor half */
  const RAIL_BASE = "0x000000000000000000000000000000000000Ad02";
  const RAIL_BIT = "0x000000000000000000000000000000000000Ad01";
  function chains(
    over: {
      at?: number;
      canClose?: boolean;
      paused?: boolean;
      entries?: boolean;
      quote?: () => bigint;
      /** What the second Base RPC quotes the fee at (the first's quote unless given). */
      quote2?: () => bigint;
      gas?: () => bigint;
      bittensor?: Record<string, unknown> | "down";
      /** v3.2 (R4-O round 3): each side's primary, the door's primary's Bittensor half, each Bittensor adapter's
       * AlphaVault, and each AlphaVault's three (absent: the deploy's rail, and `bittensor`'s answers for any vault) */
      rail?: { doorPrimary: string; doorHalf: string; vaultPrimary: string; vaultOf: Record<string, string>; health: Record<string, Record<string, unknown>> };
    } = {},
  ) {
    const calls: { address: string; functionName: string; args?: readonly unknown[]; account?: unknown }[] = [];
    const logsCalls: { address: string; functionName: string; args?: readonly unknown[]; account?: unknown }[] = [];
    const asked: string[] = [];
    const empty = over.entries === false;
    const answers: Record<string, unknown> = {
      openBatch: [7n, BigInt(START), empty ? 0n : 3n * 10n ** 17n, 10n ** 14n, empty ? 0n : 2n, empty ? 0n : 1n],
      openDeposits: empty ? [] : deposits,
      openRedeems: empty ? [] : redeems,
      canClose: over.canClose ?? true,
      batchInterval: 3_600n,
      paused: over.paused ?? false,
      depositOf: empty ? 0n : 10n ** 17n,
      redeemOf: 0n,
      // v3.2 (R11): the account's cancel works five minutes after its last deposit; and the redeem list's limit
      cancelableAt: BigInt(START + 300),
      maxRedeems: 50,
      // v3.2 (R12c): the door's limits, for the minValue of a close the site sends before a stake
      maxDeposits: 50,
      maxBatchValue: 10n ** 19n,
      minDeposit: 4n * 10n ** 16n,
      depositCap: 4n * 10n ** 19n,
      netForwarded: 3n * 10n ** 19n,
      getCurrentBlockTimestamp: BigInt(START + (over.at ?? 7_200)),
      swapFeeBps: 15,
      depositFeeUsdc: 50_000n,
    };
    let multicalls = 0;
    const base = {
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
        // 1 ETH sells for $2,330
        if (c.functionName === "quoteExactInput") return [((c.args?.[1] as bigint) * 2_330_000_000n) / 10n ** 18n, [], [], 0n];
        // the oracle: 1 TAO is worth $250
        if (c.functionName === "usdcValue") return ((c.args?.[0] as bigint) * 250_000_000n) / 10n ** 18n;
        // v3.2: the door lens's primary, and that Base adapter's Bittensor half (R4-O round 3)
        if (c.functionName === "primaryBridge") return over.rail?.doorPrimary ?? RAIL_BASE;
        if (c.functionName === "remoteAdapter") return over.rail?.doorHalf ?? RAIL_BIT;
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
    /** The second Base RPC's short-timeout connection: asked the bridge fee again, nothing else. */
    const baseCheck = {
      async readContract(c: { address: string; functionName: string; args?: readonly unknown[]; account?: unknown }) {
        logsCalls.push(c);
        if (c.functionName === "quoteFee") return (over.quote2 ?? over.quote ?? (() => FEE))();
        throw new Error(`unexpected ${c.functionName} on the second RPC`);
      },
    };
    const bitAnswers: Record<string, unknown> = { paused: false, isPaused: false, migrationReadyAt: 0n, migrationFinished: false, ...(over.bittensor === "down" ? {} : over.bittensor) };
    const bitAsked: { address: string; functionName: string }[] = [];
    const bittensor = {
      async multicall({ contracts }: { contracts: { address: string; functionName: string }[] }) {
        if (over.bittensor === "down") throw new Error("HTTP request failed");
        return contracts.map((c) => {
          bitAsked.push({ address: c.address, functionName: c.functionName });
          if (c.functionName === "primaryBridge") return over.rail?.vaultPrimary ?? RAIL_BIT;
          if (c.functionName === "alphaVault") return over.rail?.vaultOf[c.address] ?? ALPHA_VAULT;
          const h = over.rail?.health[c.address];
          return h && c.functionName in h ? h[c.functionName] : bitAnswers[c.functionName];
        });
      },
    };
    return {
      c: { base: base as never, baseCheck: baseCheck as never, bittensor: bittensor as never },
      calls,
      logsCalls,
      asked,
      bitAsked,
      get multicalls() {
        return multicalls;
      },
    };
  }

  it("for anyone: when it started, what waits in it and Base's clock, in one multicall and nothing else", async () => {
    const b = chains();
    expect(await readNextBatch(b.c, D)).toEqual({
      id: 7n,
      start: START,
      interval: 3_600,
      canClose: true,
      paused: false,
      deposits: 2,
      redeems: 1,
      chainTime: START + 7_200,
    });
    expect(b.multicalls).toBe(1);
    expect(b.asked).toEqual(["openBatch", "canClose", "batchInterval", "paused", "getCurrentBlockTimestamp"]);
    expect(b.calls).toEqual([]);
    expect(b.bitAsked).toEqual([]);
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

  it("once it can close, asks the bridge for the fee of this batch's exact message as the front door asks it, and Bittensor whether it can take it", async () => {
    const b = chains();
    const batch = await readOpenBatch(b.c, D3, ME, async () => Promise.reject(new Error("no weighing two hours in")));
    const quote = b.calls.find((c) => c.functionName === "quoteFee");
    // the primary bridge (wiring.ts checks it is this adapter), to the vault on Bittensor (chain 964),
    // for the batch's TAO, from the front door: the call closeBatch makes inside
    expect(quote).toMatchObject({ address: D.baseAdapter, args: [964n, D.vault, encodeBatch(7n, deposits, redeems), 3n * 10n ** 17n], account: D.frontDoor });
    // the same question of the second Base RPC, and nothing else of it
    expect(b.logsCalls).toEqual([quote]);
    expect(batch).toEqual({
      id: 7n,
      start: START,
      interval: 3_600,
      canClose: true,
      paused: false,
      chainTime: START + 7_200,
      mine: { depositWei: 10n ** 17n, redeemShares: 0n },
      potWei: 10n ** 14n,
      // R8: the deposits it holds, a v3.2 close's minValue when the site sends it before a stake
      totalWei: 3n * 10n ** 17n,
      feeWei: FEE,
      ethWei: 10n ** 16n,
      // a generous allowance for closeBatch's gas at today's price
      gasWei: CLOSE_GAS * 7_000_000n,
      ethPriceUsd: 2_330,
      bittensor: "open",
    });
    // the keeper's own reads of Bittensor's side: the vault's pause, and AlphaVault's pause and migration
    expect(b.bitAsked).toEqual([
      { address: D.vault, functionName: "paused" },
      { address: ALPHA_VAULT, functionName: "isPaused" },
      { address: ALPHA_VAULT, functionName: "migrationReadyAt" },
      { address: ALPHA_VAULT, functionName: "migrationFinished" },
    ]);
    // past five minutes after its interval the keeper has had its turns: its fees aren't weighed
    expect(b.calls.map((c) => c.functionName)).not.toContain("usdcValue");
  });

  it("takes Bittensor's side as paused when the vault or AlphaVault is paused, or a migration is announced or done", async () => {
    for (const bittensor of [{ paused: true }, { isPaused: true }, { migrationReadyAt: 1_800_000_000n }, { migrationFinished: true }] as const) {
      expect((await readOpenBatch(chains({ bittensor }).c, D3, ME)).bittensor, String(Object.keys(bittensor))).toBe("paused");
    }
  });

  it("says it couldn't check Bittensor's side when it can't be read, never open", async () => {
    expect((await readOpenBatch(chains({ bittensor: "down" }).c, D3, ME)).bittensor).toBe("unchecked");
  });

  it("while the keeper may still send it for free, weighs its fees against its bridge fee as the keeper does", async () => {
    const b = chains({ canClose: false, at: 600 });
    const asked: [bigint, number][] = [];
    const batch = await readOpenBatch(b.c, D3, ME, async (id, ageS) => (asked.push([id, ageS]), { count: 1, tao: 10n ** 17n }));
    // the staker's deposits in batch 7, ten minutes old
    expect(asked).toEqual([[7n, 600]]);
    // one staked deposit of 0.1 TAO at $250 (the oracle's price): $0.05 + 0.15% of $25; the 0.0001 ETH pot
    // at $2,330; against 0.000745 ETH at $2,330
    expect(batch.economics).toEqual({ feesUsdc: 50_000n + 37_500n + 233_000n, bridgeFeeUsdc: (FEE * 2_330_000_000n) / 10n ** 18n });
    expect(batch.feeWei).toBe(FEE);
    // it can't close yet: no wallet, gas or Bittensor reads
    expect(b.asked).not.toContain("getBalance");
    expect(b.bitAsked).toEqual([]);
    expect(batch).not.toHaveProperty("bittensor");
    expect(batch).not.toHaveProperty("ethWei");
  });

  it("counts fees it can't weigh as not covering the bridge fee, as the keeper does", async () => {
    const at = { canClose: false, at: 600 };
    expect((await readOpenBatch(chains(at).c, D3, ME, async () => Promise.reject(new Error("logs server behind")))).economics).toBeNull();
    expect((await readOpenBatch(chains(at).c, D3, ME)).economics).toBeNull();
    expect((await readOpenBatch(chains({ ...at, quote: () => 0n }).c, D3, ME, async () => ({ count: 1, tao: 10n ** 17n }))).economics).toBeNull();
  });

  it("weighs nothing for a full batch (the keeper sends it at once), nor on v2, which has no staker", async () => {
    // it could close ten minutes in: it's full
    const full = await readOpenBatch(chains({ at: 600 }).c, D3, ME, async () => ({ count: 1, tao: 10n ** 17n }));
    expect(full).not.toHaveProperty("economics");
    const b = chains({ canClose: false, at: 600 });
    expect(await readOpenBatch(b.c, D, ME, async () => ({ count: 1, tao: 10n ** 17n }))).not.toHaveProperty("economics");
    expect(b.calls).toEqual([]);
  });

  it("takes the bridge fee only when both Base RPCs agree on it, within 10%, and then the larger: a send is never priced on one server's word", async () => {
    // the second quotes 5% more: agreed, and the larger is the fee
    const higher = await readOpenBatch(chains({ quote2: () => (FEE * 105n) / 100n }).c, D3, ME);
    expect(higher.feeWei).toBe((FEE * 105n) / 100n);
    expect(higher).not.toHaveProperty("feeUnconfirmed");
    expect((await readOpenBatch(chains({ quote2: () => (FEE * 95n) / 100n }).c, D3, ME)).feeWei).toBe(FEE);
    // the second quotes a tenth of it (one of the two is lying, or stale): neither is trusted, and the batch says so
    const apart = await readOpenBatch(chains({ quote2: () => FEE / 10n }).c, D3, ME);
    expect(apart).not.toHaveProperty("feeWei");
    expect(apart.feeUnconfirmed).toBe(true);
    // the second can't answer: the fee is left out, like any read that failed, not called a disagreement
    const down = await readOpenBatch(
      chains({
        quote2: () => {
          throw new Error("HTTP request failed. Status: 429");
        },
      }).c,
      D3,
      ME,
    );
    expect(down).not.toHaveProperty("feeWei");
    expect(down).not.toHaveProperty("feeUnconfirmed");
    // the keeper's weighing uses the agreed fee too, and can't weigh an unconfirmed one
    const weighed = await readOpenBatch(chains({ canClose: false, at: 600, quote2: () => (FEE * 105n) / 100n }).c, D3, ME, async () => ({ count: 1, tao: 10n ** 17n }));
    expect(weighed.economics?.bridgeFeeUsdc).toBe((((FEE * 105n) / 100n) * 2_330_000_000n) / 10n ** 18n);
    expect((await readOpenBatch(chains({ canClose: false, at: 600, quote2: () => FEE / 10n }).c, D3, ME, async () => ({ count: 1, tao: 10n ** 17n }))).economics).toBeNull();
  });

  it("agrees two fee quotes within 10% of the larger, either way round, and not beyond", () => {
    expect(feesAgree(FEE, FEE)).toBe(true);
    // 10% of the larger: the smaller may be down to 90% of it (the larger up to a ninth more than the smaller)
    expect(feesAgree(FEE, (FEE * 10n) / 9n - 1n)).toBe(true);
    expect(feesAgree((FEE * 10n) / 9n - 1n, FEE)).toBe(true);
    expect(feesAgree(FEE, (FEE * 10n) / 9n + 1n)).toBe(false);
    expect(feesAgree(FEE, FEE / 2n)).toBe(false);
    expect(feesAgree(0n, 0n)).toBe(true);
    expect(feesAgree(0n, FEE)).toBe(false);
    expect(FEE_CHECK_BPS).toBe(1_000n);
  });

  it("reads nothing more for an empty or paused batch", async () => {
    for (const over of [{ paused: true }, { entries: false }]) {
      const b = chains(over);
      const batch = await readOpenBatch(b.c, D3, ME);
      expect(b.calls, JSON.stringify(over)).toEqual([]);
      expect(b.logsCalls, JSON.stringify(over)).toEqual([]);
      expect(b.asked).not.toContain("getBalance");
      expect(b.bitAsked).toEqual([]);
      expect(batch).not.toHaveProperty("feeWei");
    }
  });

  it("leaves out only the figure a failed read was for: never a guess in its place", async () => {
    const fail = (): never => {
      throw new Error("rate limited");
    };
    const batch = await readOpenBatch(chains({ quote: fail, gas: fail }).c, D3, ME);
    expect(batch).not.toHaveProperty("feeWei");
    expect(batch).not.toHaveProperty("gasWei");
    expect(batch).toMatchObject({ ethWei: 10n ** 16n, ethPriceUsd: 2_330, canClose: true });
  });

  it("R11: on v3.2 the account's cancelableAt comes with its entries, in the batch's one multicall; and the redeem list's count and limit (a full one's request closes it first, on its pot)", async () => {
    const D32: Deployment = { ...D3, vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
    const b = chains({ canClose: false });
    const batch = await readOpenBatch(b.c, D32, ME);
    expect(batch.mine).toEqual({ depositWei: 10n ** 17n, redeemShares: 0n, cancelableAt: START + 300 });
    expect([batch.nRedeems, batch.maxRedeems]).toEqual([1, 50]);
    expect(b.multicalls).toBe(1);
    // v3-launch: neither asked
    const launch = chains({ canClose: false });
    const l = await readOpenBatch(launch.c, D3, ME);
    expect(l.mine).toEqual({ depositWei: 10n ** 17n, redeemShares: 0n });
    expect(l).not.toHaveProperty("maxRedeems");
    expect(launch.asked).not.toContain("cancelableAt");
    expect(launch.asked).not.toContain("maxRedeems");
  });

  it("R12c: on v3.2 the door's limits come with the batch, in its one multicall (the same block): the minValue of a close the site sends before a stake (flows.ts planCloseFirst, units.ts closeFirstFloor)", async () => {
    const D32: Deployment = { ...D3, vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
    const b = chains({ canClose: false });
    const batch = await readOpenBatch(b.c, D32, ME);
    expect(batch.limits).toEqual({ nDeposits: 2, maxDeposits: 50, maxBatchValue: 10n ** 19n, minDeposit: 4n * 10n ** 16n, depositCap: 4n * 10n ** 19n, netForwarded: 3n * 10n ** 19n });
    expect(b.multicalls).toBe(1);
    // v3-launch: none asked
    const launch = chains({ canClose: false });
    expect(await readOpenBatch(launch.c, D3, ME)).not.toHaveProperty("limits");
    for (const f of ["maxDeposits", "maxBatchValue", "minDeposit", "depositCap", "netForwarded"]) expect(launch.asked).not.toContain(f);
  });

  it("on v3.2 reads a paused front door's batch on, and says so: its pause stops new stakes, never a close", async () => {
    const D32: Deployment = { ...D3, vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
    const batch = await readOpenBatch(chains({ paused: true }).c, D32, ME);
    expect(batch).toMatchObject({ paused: true, closesWhilePaused: true, feeWei: FEE, bittensor: "open" });
    // v3-launch's paused front door: nothing more read, and no such flag
    const launch = await readOpenBatch(chains({ paused: true }).c, D3, ME);
    expect(launch).not.toHaveProperty("closesWhilePaused");
    expect(launch).not.toHaveProperty("feeWei");
  });

  it("R4-O round 3: on v3.2 Bittensor's side is read at the AlphaVault of the rail now primary on each chain: the new vault's after a migration and the switch, the old one's notice before it", async () => {
    const D32: Deployment = { ...D3, vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
    const NEW = "0x000000000000000000000000000000000000a2Fa";
    const BASE2 = "0x000000000000000000000000000000000000Ad12";
    const BIT2 = "0x000000000000000000000000000000000000Ad11";
    const healthy = { isPaused: false, migrationReadyAt: 0n, migrationFinished: false };
    const finished = { ...healthy, migrationFinished: true };
    const notice = { ...healthy, migrationReadyAt: 1_800_000_000n };
    // the migration done and both primaries the replacement pair's, whose Bittensor adapter names the new vault: open
    const switched = chains({ rail: { doorPrimary: BASE2, doorHalf: BIT2, vaultPrimary: BIT2, vaultOf: { [BIT2]: NEW }, health: { [ALPHA_VAULT]: finished, [NEW]: healthy } } });
    expect((await readOpenBatch(switched.c, D32, ME)).bittensor).toBe("open");
    const at = (b: ReturnType<typeof chains>) => b.bitAsked.filter((x) => x.functionName === "migrationFinished").map((x) => x.address);
    expect(at(switched)).toEqual([NEW]);
    // before the switch the deploy's rail and its vault, whose notice holds the side
    const before = chains({ rail: { doorPrimary: RAIL_BASE, doorHalf: RAIL_BIT, vaultPrimary: RAIL_BIT, vaultOf: { [RAIL_BIT]: ALPHA_VAULT }, health: { [ALPHA_VAULT]: notice, [NEW]: healthy } } });
    expect((await readOpenBatch(before.c, D32, ME)).bittensor).toBe("paused");
    expect(at(before)).toEqual([ALPHA_VAULT]);
    // half switched (the door on the new pair, the vault still on the old): both vaults count, and the old one is done
    const half = chains({ rail: { doorPrimary: BASE2, doorHalf: BIT2, vaultPrimary: RAIL_BIT, vaultOf: { [BIT2]: NEW, [RAIL_BIT]: ALPHA_VAULT }, health: { [ALPHA_VAULT]: finished, [NEW]: healthy } } });
    expect((await readOpenBatch(half.c, D32, ME)).bittensor).toBe("paused");
    // and the other half (the vault on the new pair, the door still sending through the old one): paused too
    const other = chains({ rail: { doorPrimary: RAIL_BASE, doorHalf: RAIL_BIT, vaultPrimary: BIT2, vaultOf: { [BIT2]: NEW, [RAIL_BIT]: ALPHA_VAULT }, health: { [ALPHA_VAULT]: finished, [NEW]: healthy } } });
    expect((await readOpenBatch(other.c, D32, ME)).bittensor).toBe("paused");
    // v3-launch reads ForeverMoney's one vault, as before
    const launch = chains({ rail: { doorPrimary: BASE2, doorHalf: BIT2, vaultPrimary: BIT2, vaultOf: { [BIT2]: NEW }, health: { [ALPHA_VAULT]: finished, [NEW]: healthy } } });
    expect((await readOpenBatch(launch.c, D3, ME)).bittensor).toBe("paused");
  });

  it("on v3.2 decodes the seven-field BatchClosed: the batch the user meant, its fee and the pot's part", async () => {
    const D32: Deployment = { ...D3, vaultLens: "0x000000000000000000000000000000000000Ae15" as Address, doorLens: "0x000000000000000000000000000000000000De15" as Address };
    const log = {
      address: D32.frontDoor,
      topics: encodeEventTopics({ abi: FRONT_DOOR_V32, eventName: "BatchClosed", args: { id: 7n } }),
      data: encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, uint256, uint256, uint256"), [3n * 10n ** 17n, 2n, 1n, FEE, 10n ** 14n, 0n]),
      blockNumber: 1n,
      logIndex: 0,
      transactionHash: H32,
      transactionIndex: 0,
      blockHash: H32,
      removed: false,
    };
    const receipt = { base: { getTransactionReceipt: async () => ({ logs: [log] }) } as never };
    expect(await readCloseOutcome(receipt, D32, H32, 7n)).toEqual({ kind: "sent", feeWei: FEE, potUsedWei: 10n ** 14n });
    // v3-launch's six-field event is another topic: a v3.2 receipt never reads as one
    expect(await readCloseOutcome(receipt, D3, H32, 7n)).toBeUndefined();
  });

  describe("what a send did, from its receipt", () => {
    const closed = (id: bigint, address: string = D.frontDoor) => ({
      address,
      topics: encodeEventTopics({ abi: FRONT_DOOR, eventName: "BatchClosed", args: { id } }),
      data: encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, uint256, uint256"), [3n * 10n ** 17n, 2n, 1n, FEE, 10n ** 14n]),
      blockNumber: 1n,
      logIndex: 0,
      transactionHash: H32,
      transactionIndex: 0,
      blockHash: H32,
      removed: false,
    });
    const rolled = (id: bigint) => ({ ...closed(id), topics: encodeEventTopics({ abi: FRONT_DOOR, eventName: "BatchRolled", args: { id } }), data: "0x" });
    const receipt = (logs: unknown[]) => ({ base: { getTransactionReceipt: async () => ({ logs }) } as never });

    it("sent the batch the user meant: its fee and the pot's share of it", async () => {
      expect(await readCloseOutcome(receipt([closed(7n)]), D, H32, 7n)).toEqual({ kind: "sent", feeWei: FEE, potUsedWei: 10n ** 14n });
    });

    it("sent another batch: the one meant had already left, and the next one went in its place", async () => {
      expect(await readCloseOutcome(receipt([closed(8n)]), D, H32, 7n)).toEqual({ kind: "other", feeWei: FEE, potUsedWei: 10n ** 14n });
    });

    it("only rolled an empty batch: the one meant had already left, and all the ETH came back", async () => {
      expect(await readCloseOutcome(receipt([rolled(8n)]), D, H32, 7n)).toEqual({ kind: "rolled" });
    });

    it("can't say, from another contract's event of the same shape or a receipt it can't read", async () => {
      expect(await readCloseOutcome(receipt([closed(7n, D.baseAdapter)]), D, H32, 7n)).toBeUndefined();
      expect(await readCloseOutcome({ base: { getTransactionReceipt: async () => Promise.reject(new Error("not found")) } as never }, D, H32, 7n)).toBeUndefined();
    });
  });
});

describe("v3.2: the vault's moved getters, read through its lens", () => {
  const VL = "0x000000000000000000000000000000000000Ae15" as Address;
  const D32: Deployment = {
    ...D,
    staker: "0x00000000000000000000000000000000005A4E12" as Address,
    oracle: "0x000000000000000000000000000000000000041E" as Address,
    vaultLens: VL,
    doorLens: "0x000000000000000000000000000000000000De15" as Address,
  };
  const HOTKEY = `0x${"58".repeat(32)}` as Hex;
  const COLDKEY = `0x${"11".repeat(32)}` as Hex;
  /** Bittensor answering by `address.functionName`, every read recorded so: the vault, its lens and the precompile. */
  function bittensor(answers: Record<string, unknown>, balance = 0n) {
    const asked: string[] = [];
    /** Multicall3's own two in the vault's multicall: the block it is answered at, and the vault's balance. */
    const own: Record<string, unknown> = { [`${MULTICALL3.toLowerCase()}.getBlockNumber`]: 9_400_000n, [`${MULTICALL3.toLowerCase()}.getEthBalance`]: balance };
    const answer = (address: string, functionName: string, args?: readonly unknown[]) => {
      const key = `${address.toLowerCase()}.${functionName}`;
      if (key in own) return own[key];
      asked.push(key);
      if (!(key in answers)) throw new Error(`unexpected ${key}`);
      const a = answers[key];
      return typeof a === "function" ? (a as (x?: readonly unknown[]) => unknown)(args) : a;
    };
    const client = {
      async getBlock() {
        return { number: 9_400_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
      },
      async multicall({ contracts }: { contracts: { address: string; functionName: string; args?: readonly unknown[] }[] }) {
        return contracts.map((c) => answer(c.address, c.functionName, c.args));
      },
      async readContract(c: { address: string; functionName: string; args?: readonly unknown[] }) {
        return answer(c.address, c.functionName, c.args);
      },
      async getBalance() {
        return balance;
      },
    };
    return { client: client as never, asked };
  }
  const v = D32.vault.toLowerCase();
  const lens = VL.toLowerCase();
  const staking = "0x0000000000000000000000000000000000000805";

  it("reads the share token on the vault and the rest on the lens, its stake priced at min(visible, booked) in rao", async () => {
    const bit = bittensor(
      {
        [`${v}.balanceOf`]: 10n ** 22n,
        [`${v}.totalSupply`]: 2n * 10n ** 22n,
        [`${lens}.totalAssets`]: 2n * 10n ** 16n,
        [`${lens}.visibleStakeRao`]: 16_000_000n,
        [`${lens}.bookedStake`]: 15_000_000n,
        [`${lens}.pendingPayouts`]: 3n,
        [`${lens}.stakeHotkey`]: HOTKEY,
        [`${lens}.payoutDelay`]: 86_400n,
        [`${lens}.maxEntryValue`]: 10n * 10n ** 18n,
        [`${lens}.stakeMissing`]: false,
        [`${lens}.redeemOrigin`]: (a?: readonly unknown[]) => (a?.[0] === ME ? 8453n : 0n),
        [`${staking}.getNominatorMinRequiredStake`]: 20_000_000n,
      },
      2n * 10n ** 16n,
    );
    const r = await readVault({ bittensor: bit.client }, D32, ME);
    expect(r).toEqual({
      shares: 10n ** 22n,
      totalAssets: 2n * 10n ** 16n,
      totalSupply: 2n * 10n ** 22n,
      // the vault prices the smaller of the stake the chain shows on its hotkeys and the stake it booked
      rootStakeWei: 15n * 10n ** 15n,
      pendingPayouts: 3n,
      balanceWei: 2n * 10n ** 16n,
      stakeHotkey: HOTKEY,
      payoutDelay: 86_400,
      nominatorMinWei: 2n * 10n ** 16n,
      maxEntryValue: 10n * 10n ** 18n,
      // v3.2's guard and the account's redeem origin, read in the same multicall (Task 59)
      stakeMissing: false,
      redeemOrigin: 8453n,
    });
    // nothing asked of the vault but its token surface
    expect(bit.asked.filter((k) => k.startsWith(`${v}.`)).sort()).toEqual([`${v}.balanceOf`, `${v}.totalSupply`]);
    // a stake the chain shows below what was booked prices at what it shows
    const fallen = bittensor({ ...Object.fromEntries(bit.asked.map((k) => [k, 0n])), [`${lens}.visibleStakeRao`]: 9_000_000n, [`${lens}.bookedStake`]: 15_000_000n, [`${lens}.stakeHotkey`]: HOTKEY });
    expect((await readVault({ bittensor: fallen.client }, D32, ME)).rootStakeWei).toBe(9n * 10n ** 15n);
  });

  it("reads the coldkey and the reward cut on the lens, for the rewards waiting on the stake hotkey", async () => {
    const bit = bittensor({
      [`${lens}.coldkey`]: COLDKEY,
      [`${lens}.rewardCutBps`]: 1000,
      [`${lens}.hotkeyCount`]: 1n,
      [`${lens}.hotkeys`]: (a?: readonly unknown[]) => (a?.[0] === 0n ? HOTKEY : `0x${"00".repeat(32)}`),
      [`${staking}.getUnclaimedRootTaoByHotkey`]: (a?: readonly unknown[]) => (a?.[0] === COLDKEY && a?.[1] === HOTKEY ? 5n : 0n),
    });
    expect(await readPendingRewards({ bittensor: bit.client }, D32, HOTKEY)).toEqual({ wei: 5n, cutBps: 1000 });
    expect(bit.asked.some((k) => k.startsWith(`${v}.`))).toBe(false);
  });

  // ---- Task 59: v3.2's states read through the lens and the front door ----

  it("pendingRewards: reads what every listed hotkey has waiting, the standby's too, not only the stake hotkey's", async () => {
    const STANDBY = `0x${"40".repeat(32)}` as Hex;
    const unclaimed: Record<string, bigint> = { [HOTKEY]: 5n, [STANDBY]: 7n };
    const bit = bittensor({
      [`${lens}.coldkey`]: COLDKEY,
      [`${lens}.rewardCutBps`]: 1000,
      [`${lens}.hotkeyCount`]: 2n,
      [`${lens}.hotkeys`]: (a?: readonly unknown[]) => [HOTKEY, STANDBY][Number(a?.[0])],
      [`${staking}.getUnclaimedRootTaoByHotkey`]: (a?: readonly unknown[]) => (a?.[0] === COLDKEY ? (unclaimed[a?.[1] as string] ?? 0n) : 0n),
    });
    expect(await readPendingRewards({ bittensor: bit.client }, D32, HOTKEY)).toEqual({ wei: 12n, cutBps: 1000 });
    expect(bit.asked.filter((k) => k === `${staking}.getUnclaimedRootTaoByHotkey`)).toHaveLength(2);
    // more hotkeys than the vault can list is no reading to stand behind: unknown, never a figure
    const odd = bittensor({ [`${lens}.coldkey`]: COLDKEY, [`${lens}.rewardCutBps`]: 1000, [`${lens}.hotkeyCount`]: 5n });
    expect(await readPendingRewards({ bittensor: odd.client }, D32, HOTKEY)).toBeUndefined();
  });

  /** The vault's figures with v3.2's guard and the account's redeem origin as the lens gives them. */
  const status = (over: { stakeMissing?: boolean; origin?: bigint }) =>
    bittensor({
      [`${v}.balanceOf`]: 10n ** 22n,
      [`${v}.totalSupply`]: 2n * 10n ** 22n,
      [`${lens}.totalAssets`]: 2n * 10n ** 16n,
      [`${lens}.visibleStakeRao`]: 15_000_000n,
      [`${lens}.bookedStake`]: 16_000_000n,
      [`${lens}.pendingPayouts`]: 0n,
      [`${lens}.stakeHotkey`]: HOTKEY,
      [`${lens}.payoutDelay`]: 86_400n,
      [`${lens}.maxEntryValue`]: 10n * 10n ** 18n,
      [`${lens}.stakeMissing`]: over.stakeMissing ?? false,
      [`${lens}.redeemOrigin`]: (a?: readonly unknown[]) => (a?.[0] === ME ? (over.origin ?? 8453n) : 0n),
      [`${staking}.getNominatorMinRequiredStake`]: 20_000_000n,
    });

  it("stakeMissing: the lens's guard, read with the vault's figures, and said in plain words while it holds", async () => {
    const missing = await readVault({ bittensor: status({ stakeMissing: true }).client }, D32, ME);
    expect(missing.stakeMissing).toBe(true);
    expect(requestHold({ stakeMissing: true })).toBe(
      "Staking and unstaking are paused for a short while: Cascade is reconnecting to its validator after a change on Bittensor. Nothing has been lost.",
    );
    expect((await readVault({ bittensor: status({}).client }, D32, ME)).stakeMissing).toBe(false);
    expect(requestHold({})).toBeNull();
  });

  it("originElsewhere: the account's redeem origin, read before a request, holds the request while it isn't Base's", async () => {
    const DIRECT = 2n ** 64n - 1n;
    expect((await readVault({ bittensor: status({ origin: DIRECT }).client }, D32, ME)).redeemOrigin).toBe(DIRECT);
    expect((await readVault({ bittensor: status({}).client }, D32, ME)).redeemOrigin).toBe(8453n);
    expect(requestHold({ originElsewhere: true })).toBe(
      "This address withdraws on Bittensor, not here. Withdraw there, or set Base as its withdrawal chain from Bittensor.",
    );
    // an origin elsewhere is said first: setting Base from Bittensor is the user's to do, the reconnection isn't
    expect(requestHold({ originElsewhere: true, stakeMissing: true })).toMatch(/^This address withdraws on Bittensor/);
  });

  it("thinPool: a pool whose 30-minute mean liquidity is under the front door's floor holds USDC delivery", async () => {
    const asked: string[] = [];
    const base = (mean: readonly [bigint, bigint], floors: readonly [bigint, bigint]) => ({
      async multicall({ contracts }: { contracts: { address: string; functionName: string; args?: readonly unknown[] }[] }) {
        return contracts.map((c) => {
          asked.push(`${c.address.toLowerCase()}.${c.functionName}${c.args ? `(${c.args.join(",")})` : ""}`);
          if (c.functionName === "meanLiquidity") return mean;
          if (c.functionName === "minPoolLiquidity") return floors[Number(c.args?.[0])];
          throw new Error(`unexpected ${c.functionName}`);
        });
      },
    });
    expect(await readThinPool({ base: base([100n, 10n ** 12n], [1_000n, 10n ** 9n]) as never }, D32)).toBe(true);
    expect(asked).toEqual([`${D32.oracle!.toLowerCase()}.meanLiquidity`, `${D32.frontDoor.toLowerCase()}.minPoolLiquidity(0)`, `${D32.frontDoor.toLowerCase()}.minPoolLiquidity(1)`]);
    // the WETH/USDC pool alone under its floor holds it too
    expect(await readThinPool({ base: base([10n ** 6n, 10n], [1_000n, 10n ** 9n]) as never }, D32)).toBe(true);
    expect(await readThinPool({ base: base([10n ** 6n, 10n ** 12n], [1_000n, 10n ** 9n]) as never }, D32)).toBe(false);
    // a floor of 0 checks nothing
    expect(await readThinPool({ base: base([0n, 0n], [0n, 0n]) as never }, D32)).toBe(false);
  });

  it("pausedDoor: a paused v3.2 front door's batch line says only that new stakes are paused (its batch still leaves)", async () => {
    const batch = (paused: boolean) => ({
      async multicall({ contracts }: { contracts: { functionName: string }[] }) {
        const answers: Record<string, unknown> = { openBatch: [7n, 1_800_000_000n, 10n ** 17n, 0n, 1n, 0n], canClose: false, batchInterval: 3_600n, paused, getCurrentBlockTimestamp: 1_800_000_600n };
        return contracts.map((c) => answers[c.functionName]);
      },
    });
    const at = { readAt: 1_000, now: 1_000 };
    const paused = await readNextBatch({ base: batch(true) as never }, D32);
    expect(paused).toMatchObject({ paused: true, closesWhilePaused: true });
    expect(nextBatchLine(paused, at)).toBe("New stakes and automatic USDC delivery are paused; withdrawals and claims still work.");
    // v3-launch's paused front door holds its batch, and says so as before
    const launch: Deployment = { ...D, staker: D32.staker, oracle: D32.oracle };
    const held = await readNextBatch({ base: batch(true) as never }, launch);
    expect(held).not.toHaveProperty("closesWhilePaused");
    expect(nextBatchLine(held, at)).toBe("Next batch: on hold while Cascade is paused");
    // not paused: the countdown, on either
    expect(nextBatchLine(await readNextBatch({ base: batch(false) as never }, D32), at)).toMatch(/^Next batch leaves within /);
  });

  it("reads the reward cut and the stake hotkey (for the yield) on the lens", async () => {
    const bit = bittensor({ [`${lens}.rewardCutBps`]: 1000, [`${lens}.stakeHotkey`]: HOTKEY });
    expect(await readRewardCutBps({ bittensor: bit.client }, D32)).toBe(1000);
    expect(bit.asked).toEqual([`${lens}.rewardCutBps`]);
    const history = {
      ...(bit.client as object),
      async getBlock() {
        return { number: 100_000n, timestamp: 1_800_000_000n };
      },
    };
    // too young a chain for a 30-day figure: only the hotkey and the cut are read, both on the lens
    expect(await readApyPercent({ bittensorYield: history as never, bittensorDeep: history as never }, D32)).toBeUndefined();
    expect(bit.asked).toEqual([`${lens}.rewardCutBps`, `${lens}.stakeHotkey`, `${lens}.rewardCutBps`]);
  });

  it("reads the owner's reward vesting period, the running schedule's and the adoption drip's on the lens, in seconds, for the FAQ (Task 60; review, Minor 4; Revision 27)", async () => {
    const mc = MULTICALL3.toLowerCase();
    const NOW = 1_800_000_000n;
    const DAY = 86_400n;
    const answers = (adopt: { amount: bigint; start: bigint; period: bigint }) => ({
      [`${lens}.rewardVesting`]: 3n * DAY,
      [`${lens}.vestingPeriod`]: 10n * DAY,
      [`${lens}.adoptVestingAmount`]: adopt.amount,
      [`${lens}.adoptVestingStart`]: adopt.start,
      [`${lens}.adoptVestingPeriod`]: adopt.period,
      [`${mc}.getCurrentBlockTimestamp`]: NOW,
    });
    // an adopted gift on its own 14-day drip (Revision 27), a day in at the chain's time: its period
    const bit = bittensor(answers({ amount: 10n ** 15n, start: NOW - DAY, period: 14n * DAY }));
    expect(await readRewardVesting({ bittensor: bit.client }, D32)).toEqual({ rewardVestingS: 259_200, vestingPeriodS: 864_000, adoptVestingPeriodS: 1_209_600 });
    expect(bit.asked).toEqual([
      `${lens}.rewardVesting`,
      `${lens}.vestingPeriod`,
      `${lens}.adoptVestingAmount`,
      `${lens}.adoptVestingStart`,
      `${lens}.adoptVestingPeriod`,
      `${mc}.getCurrentBlockTimestamp`,
    ]);
    // a second before its end it still runs; at its end it has nothing left to add (CascadeFormulas.unvestedRewards)
    const drip = async (adopt: { amount: bigint; start: bigint; period: bigint }) => (await readRewardVesting({ bittensor: bittensor(answers(adopt)).client }, D32)).adoptVestingPeriodS;
    expect(await drip({ amount: 10n ** 15n, start: NOW - 14n * DAY + 1n, period: 14n * DAY })).toBe(1_209_600);
    expect(await drip({ amount: 10n ** 15n, start: NOW - 14n * DAY, period: 14n * DAY })).toBe(0);
    // never adopted; or set with nothing in it (a write-down at a supply of 0 with no adoption): 0
    expect(await drip({ amount: 0n, start: 0n, period: 0n })).toBe(0);
    expect(await drip({ amount: 0n, start: NOW - DAY, period: 14n * DAY })).toBe(0);
    // v3-launch's vesting is a constant in its vault, never read
    await expect(readRewardVesting({ bittensor: bit.client }, D)).rejects.toThrow(/v3\.2/);
  });
});

describe("readVault: the vault's figures in one round trip, and never an old picture of the chain", () => {
  const NOW_S = Math.floor(Date.now() / 1000);
  const HOTKEY = `0x${"58".repeat(32)}`;
  const TIP = 9_400_000n;

  /** Bittensor's public endpoint: the newest header it gives each time it is asked (`tips`), and the block a multicall
   * with none pinned is answered at (`latest`, each time; a pinned one is answered at its block). The vault's total
   * staked is the block it was read at, so a figure says where it came from. Every request is recorded in order; with
   * `together`, neither the header nor the figures are answered until both were asked; with `split`, a multicall with
   * no block pinned is answered as two calls would be, its last part a block later. */
  function node(o: { tips: { number: bigint; ageS: number }[]; latest: bigint[]; together?: boolean; split?: boolean }) {
    const log: string[] = [];
    const sizes: (number | undefined)[] = [];
    let tipsAsked = 0;
    let latestAsked = 0;
    let bothAsked!: () => void;
    const both = o.together ? new Promise<void>((resolve) => (bothAsked = resolve)) : Promise.resolve();
    const seen = new Set<string>();
    const ask = (what: "header" | "figures") => {
      seen.add(what);
      if (o.together && seen.size === 2) bothAsked();
    };
    const client = {
      async getBlock() {
        const t = o.tips[Math.min(tipsAsked++, o.tips.length - 1)];
        log.push("header latest");
        ask("header");
        await both;
        return { number: t.number, timestamp: BigInt(NOW_S - t.ageS) };
      },
      async multicall({ contracts, blockNumber, batchSize }: { contracts: { functionName: string; args?: readonly unknown[] }[]; blockNumber?: bigint; batchSize?: number }) {
        const at = blockNumber ?? o.latest[Math.min(latestAsked++, o.latest.length - 1)];
        log.push(blockNumber === undefined ? "figures latest" : `figures at ${blockNumber}`);
        sizes.push(batchSize);
        ask("figures");
        await both;
        const answers: Record<string, unknown> = {
          getBlockNumber: at,
          getEthBalance: 10n ** 12n,
          balanceOf: 10n ** 22n,
          totalAssets: at,
          totalSupply: 2n * 10n ** 22n,
          rootStakeRao: 15_000_000n,
          pendingPayouts: 0n,
          stakeHotkey: HOTKEY,
          payoutDelay: 3600n,
          getNominatorMinRequiredStake: 20_000_000n,
        };
        return contracts.map((c, i) => {
          if (!(c.functionName in answers)) throw new Error(`unexpected ${c.functionName}`);
          // the block the calls are answered at is asked first and last: a multicall sent as two calls names two blocks
          if (c.functionName === "getBlockNumber" && i > 0 && o.split && blockNumber === undefined) return at + 1n;
          return answers[c.functionName];
        });
      },
      async getBalance() {
        log.push("balance");
        return 0n;
      },
    };
    return { client: client as never, log, sizes };
  }

  it("asks the newest header and the figures together, and stands on the figures when they are from that block: one round trip, where there were three in a row", async () => {
    const n = node({ tips: [{ number: TIP, ageS: 12 }], latest: [TIP], together: true });
    const v = await readVault({ bittensor: n.client }, D, ME);
    expect(v.totalAssets).toBe(TIP);
    expect(n.log.sort()).toEqual(["figures latest", "header latest"]);
  });

  it("reads the vault's liquid TAO in the same multicall (Multicall3's getEthBalance), with no balance read of its own", async () => {
    const n = node({ tips: [{ number: TIP, ageS: 12 }], latest: [TIP] });
    expect((await readVault({ bittensor: n.client }, D, ME)).balanceWei).toBe(10n ** 12n);
    expect(n.log).not.toContain("balance");
  });

  it("asks the figures as one call, never split by size, and the block they are answered at first and last: figures answered across two blocks don't stand, and are read again pinned to one", async () => {
    const whole = node({ tips: [{ number: TIP, ageS: 12 }], latest: [TIP] });
    await readVault({ bittensor: whole.client }, D, ME);
    expect(whole.sizes).toEqual([0]);
    const split = node({ tips: [{ number: TIP, ageS: 12 }], latest: [TIP], split: true });
    const v = await readVault({ bittensor: split.client }, D, ME);
    expect(split.log.slice(2)).toEqual(["header latest", `figures at ${TIP}`]);
    expect(v.totalAssets).toBe(TIP);
    expect(split.sizes).toEqual([0, 0]);
  });

  it("stands on figures from a block after that header, too: they are newer than a block known to be recent", async () => {
    const n = node({ tips: [{ number: TIP, ageS: 12 }], latest: [TIP + 1n] });
    expect((await readVault({ bittensor: n.client }, D, ME)).totalAssets).toBe(TIP + 1n);
    expect(n.log).toHaveLength(2);
  });

  it("reads again, pinned to a tip known to be recent, when the figures came from a block before the header's (a server that is behind answered them)", async () => {
    const n = node({ tips: [{ number: TIP, ageS: 12 }], latest: [TIP - 1_000n] });
    const v = await readVault({ bittensor: n.client }, D, ME);
    // the pinned read's figures, not the old ones
    expect(v.totalAssets).toBe(TIP);
    expect(n.log.slice(2)).toEqual(["header latest", `figures at ${TIP}`]);
  });

  it("when the newest header is hours old, asks again as before and reads at the recent tip it then finds", async () => {
    const n = node({ tips: [{ number: 9_358_543n, ageS: 3 * 3600 }, { number: TIP, ageS: 6 }], latest: [9_358_543n] });
    const v = await readVault({ bittensor: n.client }, D, ME);
    expect(v.totalAssets).toBe(TIP);
    expect(n.log.slice(2)).toEqual(["header latest", `figures at ${TIP}`]);
  });

  it("says Bittensor is behind when every answer is old, rather than give figures from the past", async () => {
    // the figures are from the header's own block, but that block is three hours old
    const n = node({ tips: [{ number: 9_358_543n, ageS: 3 * 3600 }], latest: [9_358_543n] });
    await expect(readVault({ bittensor: n.client }, D, ME)).rejects.toBeInstanceOf(StaleChainError);
    expect(n.log.filter((x) => x.startsWith("figures at"))).toEqual([]);
  });
});
