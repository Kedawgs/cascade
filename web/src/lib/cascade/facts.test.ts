import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbiParameters, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";
import { ADAPTER, ERC20, FRONT_DOOR, STAKER, VAULT } from "./abi";
import type { Deployment } from "./config";
import { claimWentThrough, depositFacts, findStakeTx, newScan, scanVault, withdrawalFacts } from "./facts";
import type { ClaimOp, DepositOp, WithdrawalOp } from "./oplog";
import type { FrontDoorState, VaultState } from "./reads";

const D: Deployment = {
  frontDoor: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  baseAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  vault: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  bitAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  bitBlock: 1_000n,
  vaultSs58: "x",
  hotkeySs58: "y",
};
const ME = getAddress("0x000000000000000000000000000000000000a11c");
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const KEY = H(77);

const log = (address: string, topics: Hex[], data: Hex, block: bigint, tx: Hex, index = 0) => ({
  address,
  topics,
  data,
  blockNumber: block,
  transactionHash: tx,
  logIndex: index,
});
const delivered = log(
  D.vault,
  encodeEventTopics({ abi: VAULT, eventName: "BatchDelivered", args: { key: KEY, sourceChain: 8453n, frontDoor: D.frontDoor } }) as Hex[],
  encodeAbiParameters(parseAbiParameters("uint64, uint256"), [3n, 10n ** 16n]),
  1_500n,
  H(9),
);
const depositedLog = log(
  D.vault,
  encodeEventTopics({ abi: VAULT, eventName: "Deposited", args: { key: KEY, user: ME } }) as Hex[],
  encodeAbiParameters(parseAbiParameters("uint256, uint256"), [10n ** 16n, 10n ** 22n]),
  1_500n,
  H(9),
  1,
);
const deliveredMsg = log(
  D.bitAdapter,
  encodeEventTopics({ abi: ADAPTER, eventName: "Delivered", args: { messageId: H(8), sender: D.baseAdapter, recipient: D.vault } }) as Hex[],
  encodeAbiParameters(parseAbiParameters("uint64, uint256"), [8453n, 10n ** 16n]),
  1_500n,
  H(9),
  2,
);

function chains(
  opts: {
    latest?: bigint;
    bitLogs?: unknown[];
    bitReceipts?: Record<string, unknown>;
    baseReceipts?: Record<string, unknown>;
    executionState?: number;
    /** What each successive request's server reports as its head (defaults to `latest`). */
    heads?: bigint[];
  } = {},
) {
  const windows: [bigint, bigint][] = [];
  let headCalls = 0;
  const bittensor = {
    getBlockNumber: async () => opts.latest ?? 2_500n,
    request: async ({ method }: { method: string }) => {
      if (method !== "eth_blockNumber") throw new Error(`unexpected ${method}`);
      const h = opts.heads?.[headCalls++] ?? opts.latest ?? 2_500n;
      return `0x${h.toString(16)}`;
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      windows.push([fromBlock, toBlock]);
      return (opts.bitLogs ?? []).filter((l) => {
        const b = (l as { blockNumber: bigint }).blockNumber;
        return b >= fromBlock && b <= toBlock;
      });
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => opts.bitReceipts?.[hash] ?? null,
    getBlock: async (q: { blockTag?: string }) =>
      q?.blockTag === "latest"
        ? { number: opts.latest ?? 2_500n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }
        : { timestamp: 1_800_000_000n },
  };
  const base = {
    getLogs: async () => {
      throw new Error("the public Base RPC refuses eth_getLogs");
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = opts.baseReceipts?.[hash];
      if (!r) throw new Error("receipt not found");
      return r;
    },
    readContract: async () => opts.executionState ?? 0,
  };
  return { clients: { base, bittensor } as never, windows };
}

const fd: FrontDoorState = {
  depositOf: 0n,
  redeemOf: 0n,
  claimable: 0n,
  openBatchId: 4n,
  openStart: 1_800_000_000,
  openTotal: 0n,
  openDeposits: 0,
  openRedeems: 0,
  netForwarded: 0n,
  depositCap: 0n,
  minDeposit: 0n,
  redeemRequestFee: 0n,
  canClose: false,
  batchInterval: 600,
  maxBatchValue: 0n,
  maxDeposits: 50,
};
const vault: VaultState = {
  shares: 10n ** 22n,
  totalAssets: 10n ** 16n,
  totalSupply: 10n ** 22n,
  rootStakeWei: 0n,
  pendingPayouts: 0n,
  balanceWei: 10n ** 16n + 10n ** 12n,
  stakeHotkey: H(1),
  payoutDelay: 3600,
  nominatorMinWei: 2n * 10n ** 16n,
};

describe("facts", () => {
  it("scans Bittensor in windows of at most 1,000 blocks from the deploy block, and resumes", async () => {
    const c = chains({ latest: 3_200n });
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    for (const [from, to] of c.windows) expect(to - from + 1n).toBeLessThanOrEqual(1_000n);
    expect(c.windows[0][0]).toBe(1_000n);
    const before = c.windows.length;
    await scanVault(c.clients, D, scan, ME);
    expect(c.windows.length).toBe(before);
  });

  it("stops two blocks short of the newest, so an event landing mid-read is never skipped", async () => {
    const c = chains({ latest: 1_600n });
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    expect(scan.next).toBe(1_599n);
  });

  it("never takes a window of logs from a server that hasn't reached it", async () => {
    // the first answer comes from a server stuck before the delivery: its head is below the window
    const c = chains({ latest: 1_600n, bitLogs: [delivered], heads: [1_200n, 1_600n] });
    const lagging = c.clients as { bittensor: { getLogs: (q: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown[]> } };
    const real = lagging.bittensor.getLogs;
    let first = true;
    lagging.bittensor.getLogs = async (q) => {
      if (first) {
        first = false;
        return [];
      }
      return real(q);
    };
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    expect(scan.delivered.get("3")?.txHash).toBe(H(9));
  });

  it("finds a deposit's delivery, its bridge message and that it waits for the minimum", async () => {
    const depositReceipt = {
      status: "success",
      blockNumber: 50n,
      logs: [
        log(
          D.frontDoor,
          encodeEventTopics({ abi: FRONT_DOOR, eventName: "DepositRequested", args: { batchId: 3n, user: ME } }) as Hex[],
          encodeAbiParameters(parseAbiParameters("uint256, address"), [10n ** 16n, ME]),
          50n,
          H(2),
        ),
      ],
    };
    const c = chains({
      bitLogs: [delivered, depositedLog],
      bitReceipts: { [H(9)]: { status: "success", logs: [delivered, depositedLog, deliveredMsg] } },
      baseReceipts: { [H(1)]: { status: "success", logs: [] }, [H(2)]: depositReceipt },
    });
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    const op: DepositOp = {
      id: "d",
      kind: "deposit",
      account: ME,
      createdAt: 0,
      usdcIn: 1n,
      targetTao: 10n ** 16n,
      priceUsd: 1,
      hashes: { swap: H(1), deposit: H(2) },
      state: "sent",
    };
    const f = await depositFacts(c.clients, D, op, { fd, vault, scan });
    expect(f.batchId).toBe(3n);
    expect(f.facts.depositMined).toBe(true);
    expect(f.facts.stillOpen).toBe(false);
    expect(f.facts.delivered).toMatchObject({ txHash: H(9), messageId: H(8), outcome: "deposited" });
    expect(f.facts.waitingForMinimum).toBe(true);
  });

  it("closes at the interval, or by the deployment's max wait (flagged as an upper bound)", async () => {
    const c = chains({ baseReceipts: { [H(1)]: { status: "success", logs: [] }, [H(2)]: { status: "success", logs: [] } } });
    const scan = newScan(D);
    const op = { kind: "deposit", id: "x", account: ME, createdAt: 0, usdcIn: 1n, targetTao: 10n ** 16n, priceUsd: 1, hashes: { swap: H(1), deposit: H(2) }, state: "sent" } as const;
    const plain = await depositFacts(c.clients, D, op, { fd, vault, scan });
    expect(plain.facts.closesAt.getTime()).toBe((fd.openStart + fd.batchInterval) * 1000);
    expect(plain.facts.closesBy).toBeUndefined();
    const L = await depositFacts(c.clients, { ...D, batchMaxWaitS: 86_400 }, op, { fd, vault, scan });
    expect(L.facts.closesAt.getTime()).toBe((fd.openStart + 86_400) * 1000);
    expect(L.facts.closesBy).toBe(true);
  });

  it("an unstake's batch closes the same way: at the interval, or by the max wait (flagged as an upper bound)", async () => {
    const c = chains({ baseReceipts: { [H(3)]: { status: "success", logs: [] } } });
    const op: WithdrawalOp = { id: "w", kind: "withdrawal", account: ME, createdAt: 0, shares: 1n, taoEstimate: 1n, usdcEstimate: 1n, fee: 0n, hash: H(3), state: "sent" };
    const plain = await withdrawalFacts(c.clients, D, op, { fd, vault, scan: newScan(D), claims: [] });
    expect(plain.facts.closesAt.getTime()).toBe((fd.openStart + fd.batchInterval) * 1000);
    expect(plain.facts.closesBy).toBeUndefined();
    const L = await withdrawalFacts(c.clients, { ...D, batchMaxWaitS: 86_400 }, op, { fd, vault, scan: newScan(D), claims: [] });
    expect(L.facts.closesAt.getTime()).toBe((fd.openStart + 86_400) * 1000);
    expect(L.facts.closesBy).toBe(true);
  });

  it("reads a payout's bridge state from the Base OffRamp, without Base logs", async () => {
    const redeemedLog = log(
      D.vault,
      encodeEventTopics({ abi: VAULT, eventName: "Redeemed", args: { key: KEY, user: ME } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256, uint256"), [10n ** 22n, 10n ** 16n]),
      1_500n,
      H(9),
      1,
    );
    const payoutLog = log(
      D.vault,
      encodeEventTopics({ abi: VAULT, eventName: "PayoutChunkSent", args: { key: KEY } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint32, uint32, uint256, uint256, uint256"), [0, 1, 10n ** 16n, 9n * 10n ** 15n, 10n ** 15n]),
      1_900n,
      H(10),
    );
    const sentLog = log(
      D.bitAdapter,
      encodeEventTopics({ abi: ADAPTER, eventName: "Sent", args: { messageId: H(6), sender: D.vault, recipient: D.frontDoor } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint64, uint256, uint256, uint256"), [8453n, 9n * 10n ** 15n, 10n ** 15n, 1n]),
      1_900n,
      H(10),
      1,
    );
    const c = chains({
      bitLogs: [delivered, redeemedLog, payoutLog],
      bitReceipts: { [H(9)]: { status: "success", logs: [delivered, redeemedLog] }, [H(10)]: { status: "success", logs: [payoutLog, sentLog] } },
      baseReceipts: {
        [H(3)]: {
          status: "success",
          blockNumber: 40n,
          logs: [
            log(
              D.frontDoor,
              encodeEventTopics({ abi: FRONT_DOOR, eventName: "RedeemRequested", args: { batchId: 3n, user: ME } }) as Hex[],
              encodeAbiParameters(parseAbiParameters("uint256"), [10n ** 22n]),
              40n,
              H(3),
            ),
          ],
        },
      },
      executionState: 1,
    });
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    const op: WithdrawalOp = {
      id: "w",
      kind: "withdrawal",
      account: ME,
      createdAt: 0,
      shares: 10n ** 22n,
      taoEstimate: 10n ** 16n,
      usdcEstimate: 1n,
      fee: 0n,
      hash: H(3),
      state: "sent",
    };
    const f = await withdrawalFacts(c.clients, D, op, { fd, vault, scan, claims: [] });
    expect(f.batchId).toBe(3n);
    expect(f.facts.delivered).toMatchObject({ outcome: "redeemed", taoWei: 10n ** 16n });
    expect(f.facts.payout).toMatchObject({ messageId: H(6), state: 1 });
  });

  it("reads a payout's state from the chunk that carries the account's entry, not the latest one", async () => {
    const OTHER = getAddress("0x000000000000000000000000000000000000b0b0");
    const redeemedBy = (user: Hex, index: number) =>
      log(
        D.vault,
        encodeEventTopics({ abi: VAULT, eventName: "Redeemed", args: { key: KEY, user } }) as Hex[],
        encodeAbiParameters(parseAbiParameters("uint256, uint256"), [10n ** 22n, 10n ** 16n]),
        1_500n,
        H(9),
        index,
      );
    // the payout list is the batch's entries in log order: someone else's, then the account's
    const deliveryLogs = [delivered, redeemedBy(OTHER, 1), redeemedBy(ME, 2)];
    const chunkLog = (chunk: number, block: bigint, tx: Hex) =>
      log(
        D.vault,
        encodeEventTopics({ abi: VAULT, eventName: "PayoutChunkSent", args: { key: KEY } }) as Hex[],
        encodeAbiParameters(parseAbiParameters("uint32, uint32, uint256, uint256, uint256"), [chunk, 1, 10n ** 16n, 9n * 10n ** 15n, 10n ** 15n]),
        block,
        tx,
      );
    const sentLog = (messageId: Hex, block: bigint, tx: Hex) =>
      log(
        D.bitAdapter,
        encodeEventTopics({ abi: ADAPTER, eventName: "Sent", args: { messageId, sender: D.vault, recipient: D.frontDoor } }) as Hex[],
        encodeAbiParameters(parseAbiParameters("uint64, uint256, uint256, uint256"), [8453n, 9n * 10n ** 15n, 10n ** 15n, 1n]),
        block,
        tx,
        1,
      );
    const first = chunkLog(0, 1_900n, H(10));
    const second = chunkLog(1, 1_950n, H(11));
    const receipts = {
      [H(9)]: { status: "success", logs: deliveryLogs },
      [H(10)]: { status: "success", logs: [first, sentLog(H(6), 1_900n, H(10))] },
      [H(11)]: { status: "success", logs: [second, sentLog(H(7), 1_950n, H(11))] },
    };
    const op: WithdrawalOp = { id: "w", kind: "withdrawal", account: ME, createdAt: 0, shares: 10n ** 22n, taoEstimate: 1n, usdcEstimate: 1n, fee: 0n, batchId: 3n, state: "sent" };
    const payoutOf = async (bitLogs: unknown[], bitReceipts: Record<string, unknown>) => {
      const c = chains({ bitLogs, bitReceipts, executionState: 2 });
      const scan = newScan(D);
      await scanVault(c.clients, D, scan, ME);
      return (await withdrawalFacts(c.clients, D, op, { fd, vault, scan, claims: [] })).facts.payout;
    };
    // only the first chunk (someone else's entry) has left: this payout hasn't
    expect(await payoutOf([delivered, first], receipts)).toBeUndefined();
    // both left: the account's is the second chunk's message
    expect(await payoutOf([delivered, first, second], receipts)).toMatchObject({ txHash: H(11), messageId: H(7), state: 2 });
    // the account's entry in the first chunk, and a later chunk that sent nothing (no message): still the first's
    const mineFirst = { ...receipts, [H(9)]: { status: "success", logs: [delivered, redeemedBy(ME, 1), redeemedBy(OTHER, 2)] }, [H(11)]: { status: "success", logs: [second] } };
    expect(await payoutOf([delivered, first, second], mineFirst)).toMatchObject({ txHash: H(10), messageId: H(6), state: 2 });
  });

  it("reads what a claim paid from its receipts, for the unstakes it names", async () => {
    const claimedLog = log(
      D.frontDoor,
      encodeEventTopics({ abi: FRONT_DOOR, eventName: "Claimed", args: { user: ME } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256"), [99n * 10n ** 14n]),
      60n,
      H(21),
    );
    const usdcIn = log(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      encodeEventTopics({ abi: ERC20, eventName: "Transfer", args: { from: "0xd0b53D9277642d899DF5C87A3966A349A798F224", to: ME } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256"), [2_450_000n]),
      61n,
      H(22),
    );
    const c = chains({ baseReceipts: { [H(21)]: { status: "success", logs: [claimedLog] }, [H(22)]: { status: "success", logs: [usdcIn] } } });
    const op: WithdrawalOp = { id: "w", kind: "withdrawal", account: ME, createdAt: 0, shares: 1n, taoEstimate: 1n, usdcEstimate: 1n, fee: 0n, state: "sent" };
    const claim: ClaimOp = {
      id: "k",
      kind: "claim",
      account: ME,
      createdAt: 10,
      amount: 99n * 10n ** 14n,
      keepTao: false,
      minUsdc: 1n,
      hashes: { claim: H(21), swap: H(22) },
      withdrawalIds: ["w"],
      state: "sent",
    };
    const other: ClaimOp = { ...claim, id: "k2", withdrawalIds: ["someone-else"] };
    const f = await withdrawalFacts(c.clients, D, op, { fd, vault, scan: newScan(D), claims: [other, claim] });
    expect(f.facts.claimed).toMatchObject({ hash: H(21), taoClaimed: 99n * 10n ** 14n, usdcOut: 2_450_000n, keptTao: false, swapFailed: false });
    const none = await withdrawalFacts(c.clients, D, op, { fd, vault, scan: newScan(D), claims: [other] });
    expect(none.facts.claimed).toBeUndefined();
  });

  it("calls a record cancelled only when its cancel came out of the record's own batch, whatever that batch did after", async () => {
    const cancelIn = (eventName: "DepositCancelled" | "RedeemCancelled", batchId: bigint, tx: Hex) => ({
      status: "success",
      logs: [
        log(
          D.frontDoor,
          encodeEventTopics({ abi: FRONT_DOOR, eventName, args: { batchId, user: ME } }) as Hex[],
          encodeAbiParameters(parseAbiParameters("uint256"), [10n ** 16n]),
          60n,
          tx,
        ),
      ],
    });
    const redeemedLog = log(
      D.vault,
      encodeEventTopics({ abi: VAULT, eventName: "Redeemed", args: { key: KEY, user: ME } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256, uint256"), [10n ** 22n, 10n ** 16n]),
      1_500n,
      H(9),
      3,
    );
    // batch 3 was delivered, with a deposit and a redeem of the account's (other requests than the cancelled ones)
    const c = chains({
      bitLogs: [delivered],
      bitReceipts: { [H(9)]: { status: "success", logs: [delivered, depositedLog, deliveredMsg, redeemedLog] } },
      baseReceipts: {
        [H(1)]: { status: "success", logs: [] },
        [H(2)]: { status: "success", logs: [] },
        [H(3)]: { status: "success", logs: [] },
        [H(12)]: cancelIn("DepositCancelled", 3n, H(12)),
        // mined after batch 3 closed: it came out of batch 4
        [H(13)]: cancelIn("DepositCancelled", 4n, H(13)),
        [H(14)]: { status: "reverted", logs: [] },
        [H(15)]: cancelIn("RedeemCancelled", 3n, H(15)),
      },
    });
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    const dep: DepositOp = { id: "d", kind: "deposit", account: ME, createdAt: 0, usdcIn: 1n, targetTao: 10n ** 16n, priceUsd: 1, hashes: { swap: H(1), deposit: H(2) }, batchId: 3n, state: "sent" };
    const depositWith = (hash: Hex) => depositFacts(c.clients, D, { ...dep, cancelled: { hash, at: 1 } }, { fd, vault, scan }).then((r) => r.facts);
    const took = await depositWith(H(12));
    expect(took.cancelMined).toBe(true);
    expect(took.delivered).toBeUndefined();
    for (const notTaken of [H(13), H(14)]) {
      const f = await depositWith(notTaken);
      expect(f.cancelMined).toBe(false);
      expect(f.delivered?.outcome).toBe("deposited");
    }
    const w: WithdrawalOp = { id: "w", kind: "withdrawal", account: ME, createdAt: 0, shares: 10n ** 22n, taoEstimate: 1n, usdcEstimate: 1n, fee: 0n, hash: H(3), batchId: 3n, state: "sent" };
    const cancelled = await withdrawalFacts(c.clients, D, { ...w, cancelled: { hash: H(15), at: 1 } }, { fd, vault, scan, claims: [] });
    expect(cancelled.facts.cancelMined).toBe(true);
    expect(cancelled.facts.delivered).toBeUndefined();
    expect(cancelled.facts.payout).toBeUndefined();
  });

  it("says a claim went through only when its receipt succeeded and shows the account's Claimed event", async () => {
    const claimedLog = log(
      D.frontDoor,
      encodeEventTopics({ abi: FRONT_DOOR, eventName: "Claimed", args: { user: ME } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256"), [99n * 10n ** 14n]),
      60n,
      H(21),
    );
    const c = chains({
      baseReceipts: {
        [H(21)]: { status: "success", logs: [claimedLog] },
        // a wallet batch that failed whole
        [H(22)]: { status: "reverted", logs: [] },
        // a smart account's transaction that was mined, but whose claim reverted inside it
        [H(23)]: { status: "success", logs: [] },
      },
    });
    const base = (c.clients as unknown as { base: { getTransactionReceipt: (q: { hash: Hex }) => Promise<unknown> } }).base;
    const known = base.getTransactionReceipt;
    base.getTransactionReceipt = async (q) => {
      if (q.hash === H(24)) throw new TransactionReceiptNotFoundError({ hash: q.hash });
      if (q.hash === H(25)) throw new Error("HTTP request failed. Status: 503");
      return known(q);
    };
    const went = (hash: Hex) => claimWentThrough(c.clients, { account: ME, hashes: { claim: hash } });
    expect(await went(H(21))).toBe(true);
    expect(await went(H(22))).toBe(false);
    expect(await went(H(23))).toBe(false);
    // never mined (dropped) is not through; a receipt that can't be read is never taken for an answer
    expect(await went(H(24))).toBe(false);
    await expect(went(H(25))).rejects.toThrow();
    expect(await claimWentThrough(c.clients, { account: ME, hashes: {} })).toBe(false);
  });

  it("reads the USDC the swap really spent from its receipt (an exact-output swap spends at most the quote)", async () => {
    const spent = log(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      encodeEventTopics({ abi: ERC20, eventName: "Transfer", args: { from: ME, to: "0xd0b53D9277642d899DF5C87A3966A349A798F224" } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256"), [19_903_212n]),
      50n,
      H(31),
    );
    const c = chains({ baseReceipts: { [H(31)]: { status: "success", logs: [spent] }, [H(32)]: { status: "success", logs: [] } } });
    const op: DepositOp = {
      id: "d",
      kind: "deposit",
      account: ME,
      createdAt: 0,
      usdcIn: 20_000_000n,
      targetTao: 78_336_398n * 10n ** 9n,
      priceUsd: 254,
      hashes: { swap: H(31), deposit: H(32) },
      batchId: 4n,
      state: "sent",
    };
    const f = await depositFacts(c.clients, D, op, { fd, vault, scan: newScan(D) });
    expect(f.facts.usdcSpent).toBe(19_903_212n);
  });
});

describe("v3 deposit facts (one stake through CascadeStaker)", () => {
  const STAKER_AT = getAddress("0x00000000000000000000000000000000005a4e12");
  const TREASURY = getAddress("0x000000000000000000000000000000000000beef");
  const D3: Deployment = { ...D, staker: STAKER_AT, oracle: getAddress("0x000000000000000000000000000000000000041e") };
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const transfer = (from: Hex, to: Hex, value: bigint, index: number) =>
    log(USDC, encodeEventTopics({ abi: ERC20, eventName: "Transfer", args: { from, to } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256"), [value]), 50n, H(41), index);
  const requested = log(
    D.frontDoor,
    encodeEventTopics({ abi: FRONT_DOOR, eventName: "DepositRequested", args: { batchId: 3n, user: ME } }) as Hex[],
    encodeAbiParameters(parseAbiParameters("uint256, address"), [77_700_000_000_000_000n, STAKER_AT]),
    50n,
    H(41),
    3,
  );
  const op3: DepositOp = {
    id: "d3",
    kind: "deposit",
    v: 3,
    account: ME,
    createdAt: 0,
    usdcIn: 20_000_000n,
    targetTao: 78_000_000_000_000_000n,
    minTaoOut: 77_611_000_000_000_000n,
    priceUsd: 254,
    hashes: { stake: H(41) },
    state: "sent",
  };

  it("reads the swap and the deposit from the stake receipt: USDC that left the account (fees included), the batch and the TAO deposited", async () => {
    const c = chains({
      baseReceipts: {
        [H(41)]: {
          status: "success",
          blockNumber: 50n,
          // the account pays the staker; the staker's own transfers (fees to the treasury) are not the account's
          logs: [transfer(ME, STAKER_AT, 20_000_000n, 0), transfer(STAKER_AT, TREASURY, 79_925n, 1), requested],
        },
      },
    });
    const f = await depositFacts(c.clients, D3, op3, { fd, vault, scan: newScan(D3) });
    expect(f.facts.swapMined).toBe(true);
    expect(f.facts.depositMined).toBe(true);
    expect(f.facts.usdcSpent).toBe(20_000_000n);
    expect(f.batchId).toBe(3n);
    expect(f.facts.taoDeposited).toBe(77_700_000_000_000_000n);
    expect(f.facts.stillOpen).toBe(false);
  });

  it("leaves both undone when the stake reverted or was never sent", async () => {
    const c = chains({ baseReceipts: { [H(42)]: { status: "reverted", blockNumber: 50n, logs: [] } } });
    const reverted = await depositFacts(c.clients, D3, { ...op3, hashes: { stake: H(42) }, state: "failed" }, { fd, vault, scan: newScan(D3) });
    expect(reverted.facts).toMatchObject({ swapMined: false, depositMined: false });
    expect(reverted.facts.usdcSpent).toBeUndefined();
    expect(reverted.batchId).toBeUndefined();
    const unsent = await depositFacts(c.clients, D3, { ...op3, hashes: {}, state: "needs-you" }, { fd, vault, scan: newScan(D3) });
    expect(unsent.facts).toMatchObject({ swapMined: false, depositMined: false });
  });
});

describe("v3: what happened to a payout once it was back on Base", () => {
  const D3: Deployment = {
    ...D,
    staker: getAddress("0x00000000000000000000000000000000005a4e12"),
    oracle: getAddress("0x000000000000000000000000000000000000041e"),
  };
  const OTHER = getAddress("0x000000000000000000000000000000000000b0b0");
  const HEAD = 30_000_000n;
  /** The payout left Bittensor at this time (the Bittensor mock's time for every block)... */
  const SENT_S = 1_800_000_000;
  /** ...and Base's newest block is three hours later: 5,400 Base blocks. */
  const TIP_S = SENT_S + 10_800;
  const baseTime = (block: bigint) => new Date((TIP_S - Number(HEAD - block) * 2) * 1000);
  const TAO_BACK = 99n * 10n ** 14n;

  const fdLog = (eventName: "PayoutReceived" | "Delivered" | "Claimed", args: Record<string, unknown>, data: Hex, block: bigint, tx: Hex, index = 0) =>
    log(D.frontDoor, encodeEventTopics({ abi: FRONT_DOOR, eventName, args } as never) as Hex[], data, block, tx, index);
  const landedFor = (user: Hex, block: bigint, index = 0) =>
    fdLog("PayoutReceived", { batchKey: KEY, user }, encodeAbiParameters(parseAbiParameters("uint32, uint256"), [0, TAO_BACK]), block, H(60), index);
  const deliveredUsdc = (usdcOut: bigint, block: bigint, tx: Hex, taoIn = TAO_BACK) =>
    fdLog("Delivered", { user: ME }, encodeAbiParameters(parseAbiParameters("uint256, uint256"), [taoIn, usdcOut]), block, tx);
  const claimedBy = (block: bigint, tx: Hex, amount = TAO_BACK) =>
    fdLog("Claimed", { user: ME }, encodeAbiParameters(parseAbiParameters("uint256"), [amount]), block, tx);

  const redeemedLog = log(
    D.vault,
    encodeEventTopics({ abi: VAULT, eventName: "Redeemed", args: { key: KEY, user: ME } }) as Hex[],
    encodeAbiParameters(parseAbiParameters("uint256, uint256"), [10n ** 22n, 10n ** 16n]),
    1_500n,
    H(9),
    1,
  );
  const payoutLog = log(
    D.vault,
    encodeEventTopics({ abi: VAULT, eventName: "PayoutChunkSent", args: { key: KEY } }) as Hex[],
    encodeAbiParameters(parseAbiParameters("uint32, uint32, uint256, uint256, uint256"), [0, 1, 10n ** 16n, TAO_BACK, 10n ** 14n]),
    1_900n,
    H(10),
  );
  const sentLog = log(
    D.bitAdapter,
    encodeEventTopics({ abi: ADAPTER, eventName: "Sent", args: { messageId: H(6), sender: D.vault, recipient: D.frontDoor } }) as Hex[],
    encodeAbiParameters(parseAbiParameters("uint64, uint256, uint256, uint256"), [8453n, TAO_BACK, 10n ** 14n, 1n]),
    1_900n,
    H(10),
    1,
  );
  const op: WithdrawalOp = {
    id: "w3",
    kind: "withdrawal",
    account: ME,
    createdAt: 0,
    shares: 10n ** 22n,
    taoEstimate: 10n ** 16n,
    usdcEstimate: 2_500_000n,
    fee: 0n,
    delivery: { minUsdcPerTao: 245_000_000n, deadline: TIP_S + 600_000 },
    hash: H(3),
    batchId: 3n,
    state: "sent",
  };

  /** A payout that the bridge has delivered to Base (OffRamp state 2), with Base's logs RPC and Base reads. */
  function backOnBase(
    opts: {
      logs?: ReturnType<typeof log>[];
      /** The head the logs server reports (HEAD unless given). */
      logsHead?: () => bigint;
      failLogs?: boolean;
      pref?: readonly [bigint, bigint, number];
      sale?: bigint;
      d?: Deployment;
    } = {},
  ) {
    const c = chains({
      bitReceipts: { [H(9)]: { status: "success", logs: [delivered, redeemedLog] }, [H(10)]: { status: "success", logs: [payoutLog, sentLog] } },
      baseReceipts: { [H(3)]: { status: "success", blockNumber: 40n, logs: [] } },
    });
    const windows: [bigint, bigint][] = [];
    const asked: unknown[] = [];
    const reads: string[] = [];
    const base = c.clients as unknown as { base: Record<string, unknown> };
    base.base.getBlock = async (q: { blockTag?: string; blockNumber?: bigint }) =>
      q.blockTag === "latest" ? { number: HEAD, timestamp: BigInt(TIP_S) } : { number: q.blockNumber, timestamp: BigInt(baseTime(q.blockNumber!).getTime() / 1000) };
    base.base.readContract = async ({ functionName }: { functionName: string }) => {
      reads.push(functionName);
      if (functionName === "getExecutionState") return 2;
      if (functionName === "deliveryOf") return opts.pref ?? [0n, 0n, 0];
      if (functionName === "quoteExactInput") return [opts.sale ?? 0n, [], [], 0n];
      throw new Error(`unexpected ${functionName}`);
    };
    base.base.multicall = async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((k) => {
        reads.push(k.functionName);
        return k.functionName === "swapFeeBps" ? 15 : 50_000n;
      });
    const baseLogs = {
      request: async ({ method, params }: { method: string; params?: { address: string; topics: unknown[]; fromBlock: Hex; toBlock: Hex }[] }) => {
        if (method === "eth_blockNumber") return `0x${(opts.logsHead?.() ?? HEAD).toString(16)}`;
        if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
        if (opts.failLogs) throw new Error("HTTP request failed. URL: https://base-rpc.publicnode.com Status: 503");
        const q = params![0];
        const [from, to] = [BigInt(q.fromBlock), BigInt(q.toBlock)];
        windows.push([from, to]);
        asked.push({ address: q.address, topics: q.topics });
        return (opts.logs ?? []).filter((l) => l.blockNumber >= from && l.blockNumber <= to);
      },
    };
    (c.clients as unknown as Record<string, unknown>).baseLogs = baseLogs;
    // the vault's side as a scan would have found it: the batch arrived, and its payout left
    const scan = newScan(opts.d ?? D3);
    scan.delivered.set("3", { key: KEY, txHash: H(9), block: 1_500n });
    scan.payouts.set(KEY, [{ txHash: H(10), block: 1_900n, chunk: 0, taken: 1 }]);
    return { clients: c.clients, scan, windows, asked, reads };
  }
  const factsOf = (b: ReturnType<typeof backOnBase>, claimable = 0n, d = D3, claims: ClaimOp[] = []) =>
    withdrawalFacts(b.clients, d, op, { fd: { ...fd, claimable }, vault, scan: b.scan, claims }).then((r) => r.facts);

  it("reads the USDC a delivery paid from the front door's Delivered log after the payout landed, in windows of at most 2,000 blocks", async () => {
    const b = backOnBase({
      logs: [
        // an earlier payout's delivery, before this one landed: not this unstake's
        deliveredUsdc(7_777_777n, HEAD - 5_000n, H(61)),
        landedFor(OTHER, HEAD - 4_000n, 0),
        landedFor(ME, HEAD - 4_000n, 1),
        deliveredUsdc(2_431_337n, HEAD - 3_990n, H(62)),
      ],
    });
    const f = await factsOf(b);
    expect(f.payout?.state).toBe(2);
    expect(f.usdcDelivered).toEqual({ hash: H(62), at: baseTime(HEAD - 3_990n), usdcOut: 2_431_337n });
    expect(f.credited).toEqual({ at: baseTime(HEAD - 4_000n), taoWei: TAO_BACK });
    expect(f.traceFailed).toBeUndefined();
    for (const [from, to] of b.windows) expect(to - from + 1n).toBeLessThanOrEqual(2_000n);
    // from a little before the payout left Bittensor (three hours of 2-second Base blocks back from the head)
    expect(b.windows[0][0]).toBeLessThan(HEAD - 5_400n);
    expect(b.windows[0][0]).toBeGreaterThanOrEqual(HEAD - 5_400n - 600n);
    // and no further than the delivery
    expect(b.windows).toHaveLength(1);
    // only the front door's logs: this batch's credits, and the account's deliveries and claims
    const sig = (eventName: "PayoutReceived" | "Delivered" | "Claimed") => encodeEventTopics({ abi: FRONT_DOOR, eventName } as never)[0];
    const [, mine] = encodeEventTopics({ abi: FRONT_DOOR, eventName: "Delivered", args: { user: ME } });
    expect(b.asked[0]).toEqual({ address: D.frontDoor, topics: [[sig("PayoutReceived"), sig("Delivered"), sig("Claimed")], [KEY, mine]] });
    expect(b.reads).not.toContain("deliveryOf");
  });

  it("takes a claim by hand after the payout landed as its end: a later delivery belongs to another payout", async () => {
    const b = backOnBase({ logs: [landedFor(ME, HEAD - 4_000n), claimedBy(HEAD - 3_995n, H(63)), deliveredUsdc(2_431_337n, HEAD - 3_990n, H(62))] });
    const f = await factsOf(b);
    expect(f.usdcDelivered).toBeUndefined();
    expect(f.claimedOnChain).toEqual({ hash: H(63), at: baseTime(HEAD - 3_995n), taoClaimed: TAO_BACK });
  });

  it("marks a delivery or a claim that took more than this payout's credit as shared", async () => {
    // a second payout landed before the keeper sold the first: one sale of both
    const sold = await factsOf(backOnBase({ logs: [landedFor(ME, HEAD - 4_000n), deliveredUsdc(4_862_674n, HEAD - 3_990n, H(62), 2n * TAO_BACK)] }));
    expect(sold.usdcDelivered).toEqual({ hash: H(62), at: baseTime(HEAD - 3_990n), usdcOut: 4_862_674n, shared: true });
    const taken = await factsOf(backOnBase({ logs: [landedFor(ME, HEAD - 4_000n), claimedBy(HEAD - 3_995n, H(63), 2n * TAO_BACK)] }));
    expect(taken.claimedOnChain).toEqual({ hash: H(63), at: baseTime(HEAD - 3_995n), taoClaimed: 2n * TAO_BACK, shared: true });
  });

  it("never shows an amount it couldn't read: a failed logs read leaves no receipt, says so, and the other facts stand", async () => {
    const f = await factsOf(backOnBase({ failLogs: true }));
    expect(f.usdcDelivered).toBeUndefined();
    expect(f.claimedOnChain).toBeUndefined();
    expect(f.credited).toBeUndefined();
    expect(f.traceFailed).toBe(true);
    expect(f.payout?.state).toBe(2);
  });

  it("still finds this payout's credit beside a settled claim from this browser, so the claim's amount is shown only if it was this payout's", async () => {
    const claimedLog = log(
      D.frontDoor,
      encodeEventTopics({ abi: FRONT_DOOR, eventName: "Claimed", args: { user: ME } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256"), [TAO_BACK]),
      HEAD - 3_995n,
      H(21),
    );
    const b = backOnBase({ logs: [landedFor(ME, HEAD - 4_000n), claimedBy(HEAD - 3_995n, H(21))] });
    (b.clients as unknown as { base: { getTransactionReceipt: unknown } }).base.getTransactionReceipt = async ({ hash }: { hash: Hex }) => {
      if (hash === H(3)) return { status: "success", blockNumber: 40n, logs: [] };
      if (hash === H(21)) return { status: "success", logs: [claimedLog] };
      throw new Error("receipt not found");
    };
    const claim: ClaimOp = {
      id: "k",
      kind: "claim",
      account: ME,
      createdAt: 10,
      amount: TAO_BACK,
      keepTao: true,
      minUsdc: 0n,
      hashes: { claim: H(21) },
      withdrawalIds: ["w3"],
      state: "sent",
    };
    const f = await factsOf(b, TAO_BACK, D3, [claim]);
    expect(f.claimed).toMatchObject({ hash: H(21), taoClaimed: TAO_BACK, keptTao: true });
    expect(f.credited?.taoWei).toBe(TAO_BACK);
    // nothing else is needed for a payout this browser's claim settled
    expect(b.reads).not.toContain("deliveryOf");
  });

  it("reads up to Base's own head, so a logs server that is behind can't hide a recent delivery, and later reads only new blocks", async () => {
    // the logs server is 100 blocks behind Base, and the delivery is in those blocks
    let serverHead = HEAD - 100n;
    const b = backOnBase({ logs: [landedFor(ME, HEAD - 4_000n), deliveredUsdc(2_431_337n, HEAD - 50n, H(62))], logsHead: () => serverHead });
    const first = await factsOf(b);
    expect(first.usdcDelivered).toBeUndefined();
    expect(b.windows.at(-1)![1]).toBeGreaterThan(serverHead);
    // it catches up: the blocks already read aren't asked for again, and the delivery is found
    const read = b.windows.length;
    serverHead = HEAD;
    const caughtUp = await factsOf(b);
    expect(caughtUp.usdcDelivered?.hash).toBe(H(62));
    expect(b.windows[read][0]).toBeGreaterThan(HEAD - 2_000n);
  });

  it("reads no more logs once the payout's end is known", async () => {
    const b = backOnBase({ logs: [landedFor(ME, HEAD - 4_000n), deliveredUsdc(2_431_337n, HEAD - 3_990n, H(62))] });
    await factsOf(b);
    const read = b.windows.length;
    const again = await factsOf(b);
    expect(again.usdcDelivered?.hash).toBe(H(62));
    expect(b.windows).toHaveLength(read);
  });

  it("reads the delivery preference and what the TAO would sell for now, once it is back and nothing has taken it", async () => {
    const pref = [245_000_000n, BigInt(TIP_S + 600_000), 6] as const;
    const live = await factsOf(backOnBase({ logs: [landedFor(ME, HEAD - 4_000n)], pref, sale: 2_440_000n }), TAO_BACK);
    expect(live.usdcDelivered).toBeUndefined();
    expect(live.preference).toEqual({ minUsdcPerTao: 245_000_000n, deadline: TIP_S + 600_000 });
    // the sale less the staker's 0.15% fee
    expect(live.saleNowUsdc).toBe(2_440_000n - 3_660n);
    const noneSet = backOnBase({ logs: [landedFor(ME, HEAD - 4_000n)], sale: 2_440_000n });
    const none = await factsOf(noneSet, TAO_BACK);
    expect(none.preference).toBeNull();
    expect(none.saleNowUsdc).toBeUndefined();
    expect(noneSet.reads).not.toContain("quoteExactInput");
  });

  it("knows a claim from this browser is still settling", async () => {
    const claim: ClaimOp = {
      id: "k",
      kind: "claim",
      account: ME,
      createdAt: 10,
      amount: TAO_BACK,
      keepTao: false,
      minUsdc: 1n,
      hashes: { claim: H(21) },
      withdrawalIds: ["w3"],
      state: "running",
    };
    const f = await factsOf(backOnBase({ logs: [landedFor(ME, HEAD - 4_000n)] }), 0n, D3, [claim]);
    expect(f.claimed).toBeUndefined();
    expect(f.claimPending).toBe(true);
  });

  it("v2: reads no Base logs and no preference", async () => {
    const b = backOnBase({ d: D, logs: [landedFor(ME, HEAD - 4_000n), deliveredUsdc(2_431_337n, HEAD - 3_990n, H(62))] });
    const f = await factsOf(b, TAO_BACK, D);
    expect(f.payout?.state).toBe(2);
    expect(b.windows).toHaveLength(0);
    expect(f.usdcDelivered).toBeUndefined();
    expect(f.preference).toBeUndefined();
    expect(b.reads).toEqual(["getExecutionState"]);
  });
});

describe("finding a v3 stake that went through before its hash was recorded", () => {
  const STAKER_AT = getAddress("0x00000000000000000000000000000000005a4e12");
  const D3: Deployment = { ...D, staker: STAKER_AT, oracle: getAddress("0x000000000000000000000000000000000000041e") };
  const OTHER = getAddress("0x000000000000000000000000000000000000b0b0");
  const HEAD = 10_000_000n;
  const NOW = 1_800_000_000_000;
  const staked = (payer: Hex, usdcIn: bigint, block: bigint, tx: Hex) =>
    log(
      STAKER_AT,
      encodeEventTopics({ abi: STAKER, eventName: "Staked", args: { payer, beneficiary: payer } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256"), [usdcIn, 79_925n, 77_700_000_000_000_000n]),
      block,
      tx,
    );

  /** Base's logs RPC: eth_blockNumber (successive answers from `heads`) and topic-filtered eth_getLogs. */
  function logsRpc(opts: { logs?: ReturnType<typeof staked>[]; heads?: bigint[]; fail?: boolean; baseHead?: bigint }) {
    const windows: [bigint, bigint][] = [];
    const asked: unknown[] = [];
    let headCalls = 0;
    const baseLogs = {
      request: async ({ method, params }: { method: string; params?: { address: string; topics: (Hex | null)[]; fromBlock: Hex; toBlock: Hex }[] }) => {
        if (method === "eth_blockNumber") return `0x${(opts.heads?.[headCalls++] ?? HEAD).toString(16)}`;
        if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
        if (opts.fail) throw new Error("HTTP request failed. URL: https://base-rpc.publicnode.com Status: 503");
        const q = params![0];
        const [from, to] = [BigInt(q.fromBlock), BigInt(q.toBlock)];
        windows.push([from, to]);
        asked.push({ address: q.address, topics: q.topics });
        return (opts.logs ?? []).filter((l) => l.blockNumber >= from && l.blockNumber <= to);
      },
    };
    const base = { getBlockNumber: async () => opts.baseHead ?? HEAD };
    return { clients: { base, baseLogs } as never, windows, asked };
  }
  // made two hours ago: 3,600 Base blocks
  const find = (rpc: ReturnType<typeof logsRpc>, over: Partial<Parameters<typeof findStakeTx>[2]> = {}) =>
    findStakeTx(rpc.clients, D3, { account: ME, usdcIn: 20_000_000n, createdAtMs: NOW - 7_200_000, nowMs: NOW, skip: new Set(), ...over });

  it("finds the account's own stake of this amount since the record was made, in windows of at most 2,000 blocks", async () => {
    const rpc = logsRpc({ logs: [staked(ME, 20_000_000n, HEAD - 100n, H(51))] });
    expect(await find(rpc)).toBe(H(51));
    for (const [from, to] of rpc.windows) expect(to - from + 1n).toBeLessThanOrEqual(2_000n);
    // two hours of 2-second blocks back from the head, and a little earlier in case the timing is off
    expect(rpc.windows[0][0]).toBeLessThan(HEAD - 3_600n);
    expect(rpc.windows[0][0]).toBeGreaterThanOrEqual(HEAD - 3_600n - 600n);
    expect(rpc.windows.at(-1)![1]).toBe(HEAD);
    // only the staker's logs, paid by and for the account
    expect(rpc.asked[0]).toEqual({
      address: STAKER_AT,
      topics: encodeEventTopics({ abi: STAKER, eventName: "Staked", args: { payer: ME, beneficiary: ME } }),
    });
  });

  it("ignores a stake of a different amount, another account's, and one another record already owns", async () => {
    const logs = [staked(ME, 19_000_000n, HEAD - 300n, H(52)), staked(OTHER, 20_000_000n, HEAD - 200n, H(53)), staked(ME, 20_000_000n, HEAD - 100n, H(54))];
    expect(await find(logsRpc({ logs }), { skip: new Set([H(54)]) })).toBeNull();
    expect(await find(logsRpc({ logs: [staked(ME, 19_000_000n, HEAD - 300n, H(52))] }))).toBeNull();
  });

  it("throws, never answering 'not found', when the logs can't be read or the server is behind", async () => {
    await expect(find(logsRpc({ fail: true }))).rejects.toThrow();
    // the head first, then every answer from a server stuck before the first window
    const behind = HEAD - 10_000n;
    await expect(find(logsRpc({ heads: [HEAD, behind, behind, behind, behind, behind] }))).rejects.toThrow();
  });

  it("searches up to Base's own head, so a logs server that is behind can't answer 'not found' for the newest blocks", async () => {
    // Base is 50 blocks ahead of everything the logs server says; the stake landed in those blocks
    const rpc = logsRpc({ baseHead: HEAD + 50n, logs: [staked(ME, 20_000_000n, HEAD + 10n, H(55))] });
    await expect(find(rpc)).rejects.toThrow();
    expect(rpc.windows.at(-1)![1]).toBe(HEAD + 50n);
  });
});
