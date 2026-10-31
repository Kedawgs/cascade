import { type Address, decodeAbiParameters, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbiParameters, size } from "viem";
import { describe, expect, it } from "vitest";
import { ALPHA_VAULT, type Deployment, MULTICALL3 } from "./config";
import { FRONT_DOOR } from "./abi";
import { basketTwrKey, STORAGE_QUERY } from "./apy";
import {
  CLOSE_GAS,
  encodeBatch,
  readApyPercent,
  readCloseOutcome,
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
  const START = 1_800_000_000;
  const D3: Deployment = { ...D, staker: "0x00000000000000000000000000000000005A4E12" as Address, oracle: "0x000000000000000000000000000000000000041E" as Address };

  /** Base and Bittensor as the front door, its adapter, the staker, the oracle, the wallet, Uniswap's quoter,
   * the vault and ForeverMoney's AlphaVault answer them, `at` seconds into the batch; each read recorded. */
  function chains(
    over: {
      at?: number;
      canClose?: boolean;
      paused?: boolean;
      entries?: boolean;
      quote?: () => bigint;
      gas?: () => bigint;
      bittensor?: Record<string, unknown> | "down";
    } = {},
  ) {
    const calls: { address: string; functionName: string; args?: readonly unknown[]; account?: unknown }[] = [];
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
    const bitAnswers: Record<string, unknown> = { paused: false, isPaused: false, migrationReadyAt: 0n, migrationFinished: false, ...(over.bittensor === "down" ? {} : over.bittensor) };
    const bitAsked: { address: string; functionName: string }[] = [];
    const bittensor = {
      async multicall({ contracts }: { contracts: { address: string; functionName: string }[] }) {
        if (over.bittensor === "down") throw new Error("HTTP request failed");
        return contracts.map((c) => (bitAsked.push({ address: c.address, functionName: c.functionName }), bitAnswers[c.functionName]));
      },
    };
    return {
      c: { base: base as never, bittensor: bittensor as never },
      calls,
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
    expect(batch).toEqual({
      id: 7n,
      start: START,
      interval: 3_600,
      canClose: true,
      paused: false,
      chainTime: START + 7_200,
      mine: { depositWei: 10n ** 17n, redeemShares: 0n },
      potWei: 10n ** 14n,
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

  it("reads nothing more for an empty or paused batch", async () => {
    for (const over of [{ paused: true }, { entries: false }]) {
      const b = chains(over);
      const batch = await readOpenBatch(b.c, D3, ME);
      expect(b.calls, JSON.stringify(over)).toEqual([]);
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
