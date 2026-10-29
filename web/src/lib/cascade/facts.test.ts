import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbiParameters, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";
import { ADAPTER, ERC20, FRONT_DOOR, STAKER, VAULT } from "./abi";
import type { Deployment } from "./config";
import { claimWentThrough, confirmAccountEvents, depositFacts, findStakeTx, newScan, scanVault, withdrawalFacts } from "./facts";
import { StaleChainError } from "./fresh";
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
    /** Base transactions by hash (still waiting when `blockNumber` is null), and the account's nonce on Base. */
    baseTxs?: Record<string, { nonce: number; blockNumber: bigint | null }>;
    nonce?: number;
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
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const tx = opts.baseTxs?.[hash];
      if (!tx) throw new TransactionNotFoundError({ hash });
      return tx;
    },
    getTransactionCount: async () => opts.nonce ?? 0,
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
  it("scans Bittensor in windows of at most 1,000 blocks from the deploy block, and resumes with one window", async () => {
    const c = chains({ latest: 3_200n });
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    for (const [from, to] of c.windows) expect(to - from + 1n).toBeLessThanOrEqual(1_000n);
    expect(c.windows[0][0]).toBe(1_000n);
    const before = c.windows.length;
    await scanVault(c.clients, D, scan, ME);
    // the last 400 blocks are read again: one window
    expect(c.windows.slice(before)).toEqual([[3_199n - 400n, 3_198n]]);
  });

  /** A staked event, a payout chunk and a deposit of the account's, near the head at block 2,400. */
  const nearHead = () => {
    const staked = log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "Staked", args: { hotkey: H(1) } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint256"), [1n, 1n]), 2_390n, H(40));
    const chunk = log(
      D.vault,
      encodeEventTopics({ abi: VAULT, eventName: "PayoutChunkSent", args: { key: KEY } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint32, uint32, uint256, uint256, uint256"), [0, 1, 1n, 1n, 0n]),
      2_300n,
      H(41),
    );
    const mine = log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "Deposited", args: { key: KEY, user: ME } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint256"), [5n, 5n]), 2_200n, H(42));
    return [staked, chunk, mine];
  };

  it("reads the last blocks again on every scan, adding nothing twice", async () => {
    const c = chains({ latest: 2_500n, bitLogs: [delivered, ...nearHead()] });
    const scan = newScan(D);
    for (let i = 0; i < 3; i++) await scanVault(c.clients, D, scan, ME);
    expect(scan.staked).toHaveLength(1);
    expect(scan.payouts.get(KEY)).toHaveLength(1);
    expect(scan.deposited).toHaveLength(1);
    expect(scan.delivered.size).toBe(1);
  });

  it("finds on the next scan a log a lagging node left out, when it is in the blocks read again", async () => {
    const later = log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "Staked", args: { hotkey: H(1) } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint256"), [2n, 2n]), 2_395n, H(43));
    const c = chains({ latest: 2_500n, bitLogs: [...nearHead(), later] });
    const node = c.clients as unknown as { bittensor: { getLogs: (q: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown[]> } };
    const real = node.bittensor.getLogs;
    // a load-balanced node that says it is at the head but serves logs from one behind: no payout chunk or first stake yet
    const hidden = [H(40), H(41)];
    node.bittensor.getLogs = async (q) => (await real(q)).filter((l) => !hidden.includes((l as { transactionHash: Hex }).transactionHash));
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    expect(scan.payouts.size).toBe(0);
    expect(scan.staked.map((s) => s.block)).toEqual([2_395n]);
    node.bittensor.getLogs = real;
    await scanVault(c.clients, D, scan, ME);
    expect(scan.payouts.get(KEY)).toHaveLength(1);
    // in its block's place, so "the first stake after" a delivery reads right
    expect(scan.staked.map((s) => s.block)).toEqual([2_390n, 2_395n]);
  });

  it("keeps the last blocks' logs when a server a little behind answers the next read, since it won't read them again", async () => {
    const mine = log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "Deposited", args: { key: KEY, user: ME } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint256"), [7n, 7n]), 995n + 1_000n, H(44));
    const scan = newScan(D);
    await scanVault(chains({ latest: 2_000n, bitLogs: [mine] }).clients, D, scan, ME);
    expect(scan.deposited).toHaveLength(1);
    // the next read is answered by a server 20 blocks behind (still within freshness): it reads to 1,978 only
    const behind = chains({ latest: 1_980n, bitLogs: [mine] });
    await scanVault(behind.clients, D, scan, ME);
    expect(behind.windows.at(-1)![1]).toBe(1_978n);
    expect(scan.deposited).toHaveLength(1);
    expect(scan.next).toBe(1_999n);
  });

  it("takes the chain's copy of a saved account event it reads again, confirmed by the log itself", async () => {
    const [, , mine] = nearHead();
    const scan = newScan(D);
    scan.next = 2_400n;
    // saved with a changed amount; the read again (from block 2,000) finds the deposit at block 2,200
    scan.deposited.push({ key: KEY, txHash: H(42), block: 2_200n, assets: 10n ** 20n, unconfirmed: true });
    await scanVault(chains({ latest: 2_500n, bitLogs: [mine] }).clients, D, scan, ME);
    expect(scan.deposited).toEqual([{ key: KEY, txHash: H(42), block: 2_200n, assets: 5n }]);
  });

  it("drops a log near the head whose block was then replaced", async () => {
    const logs = nearHead();
    const c = chains({ latest: 2_400n, bitLogs: logs });
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    expect(scan.staked).toHaveLength(1);
    // block 2,390 was replaced: its stake isn't there any more
    logs.splice(0, 1);
    await scanVault(c.clients, D, scan, ME);
    expect(scan.staked).toEqual([]);
    expect(scan.deposited).toHaveLength(1);
  });

  it("stops two blocks short of the newest, so an event landing mid-read is never skipped", async () => {
    const c = chains({ latest: 1_600n });
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    expect(scan.next).toBe(1_599n);
  });

  it("calls back after each window, so its progress can be saved as it goes", async () => {
    const c = chains({ latest: 3_200n });
    const scan = newScan(D);
    const seen: bigint[] = [];
    await scanVault(c.clients, D, scan, ME, () => seen.push(scan.next));
    expect(seen).toEqual([2_000n, 3_000n, 3_199n]);
  });

  it("reads again from the deploy block when saved progress is past anything the chain has reached", async () => {
    const c = chains({ latest: 1_600n, bitLogs: [delivered] });
    const scan = newScan(D);
    scan.next = 900_000n;
    scan.staked.push({ block: 899_000n, txHash: H(99) });
    await scanVault(c.clients, D, scan, ME);
    expect(c.windows[0][0]).toBe(1_000n);
    expect(scan.staked).toEqual([]);
    expect(scan.delivered.get("3")?.txHash).toBe(H(9));
    // a node a little behind the progress saved is only waited for
    const behind = newScan(D);
    behind.next = 1_650n;
    await scanVault(chains({ latest: 1_600n }).clients, D, behind, ME);
    expect(behind.next).toBe(1_650n);
  });

  it("takes the account's saved amounts only from their receipts: a changed one is corrected", async () => {
    const redeemedLog = log(
      D.vault,
      encodeEventTopics({ abi: VAULT, eventName: "Redeemed", args: { key: KEY, user: ME } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256, uint256"), [10n ** 22n, 10n ** 16n]),
      1_500n,
      H(9),
      3,
    );
    const c = chains({ bitReceipts: { [H(9)]: { status: "success", logs: [delivered, depositedLog, redeemedLog] } } });
    const scan = newScan(D);
    scan.next = 2_000n;
    // the stored amount was changed: the receipt's stands
    scan.deposited.push({ key: KEY, txHash: H(9), block: 1_500n, assets: 10n ** 20n, unconfirmed: true });
    scan.redeemed.push({ key: KEY, txHash: H(9), block: 1_400n, assets: 1n, unconfirmed: true });
    await confirmAccountEvents(c.clients, D, scan, ME);
    expect(scan.deposited).toEqual([{ key: KEY, txHash: H(9), block: 1_500n, assets: 10n ** 16n }]);
    expect(scan.redeemed).toEqual([{ key: KEY, txHash: H(9), block: 1_500n, assets: 10n ** 16n }]);
    // a receipt that can't be read leaves the amount unconfirmed and says so
    const down = newScan(D);
    down.deposited.push({ key: KEY, txHash: H(9), block: 1_500n, assets: 10n ** 16n, unconfirmed: true });
    const failing = chains();
    (failing.clients as unknown as { bittensor: { getTransactionReceipt: () => Promise<never> } }).bittensor.getTransactionReceipt = async () => {
      throw new Error("HTTP request failed. Status: 503");
    };
    await expect(confirmAccountEvents(failing.clients, D, down, ME)).rejects.toThrow();
    expect(down.deposited[0].unconfirmed).toBe(true);
  });

  it("never drops a saved amount because a node that is behind hasn't seen its transaction", async () => {
    // the node answering is at block 1,450, before the deposit's 1,500: it can't know the transaction yet
    const behind = chains({ latest: 1_450n });
    (behind.clients as unknown as { bittensor: { getTransactionReceipt: (q: { hash: Hex }) => Promise<never> } }).bittensor.getTransactionReceipt = async ({ hash }) => {
      throw new TransactionReceiptNotFoundError({ hash });
    };
    const scan = newScan(D);
    scan.next = 2_000n;
    scan.deposited.push({ key: KEY, txHash: H(9), block: 1_500n, assets: 10n ** 16n, unconfirmed: true });
    await expect(confirmAccountEvents(behind.clients, D, scan, ME)).rejects.toThrow();
    expect(scan.deposited).toEqual([{ key: KEY, txHash: H(9), block: 1_500n, assets: 10n ** 16n, unconfirmed: true }]);
    expect(scan.next).toBe(2_000n);
  });

  it("takes no \"not found\" for proof from a server whose receipts may still be catching up with its head", async () => {
    // the server says it is at block 1,800, 100 past the deposit: its receipt index may lag that much and more
    const scan = newScan(D);
    scan.next = 2_000n;
    scan.deposited.push({ key: KEY, txHash: H(31), block: 1_700n, assets: 10n ** 16n, unconfirmed: true });
    await expect(confirmAccountEvents(chains({ latest: 1_800n }).clients, D, scan, ME)).rejects.toBeInstanceOf(StaleChainError);
    expect(scan.next).toBe(2_000n);
    expect(scan.deposited).toHaveLength(1);
  });

  it("reads the history again, rather than dropping an amount, when a node well past its block shows it isn't there", async () => {
    const shown = (bitReceipts: Record<string, unknown>) => {
      const scan = newScan(D);
      scan.next = 2_000n;
      scan.staked.push({ block: 1_600n, txHash: H(10) });
      scan.deposited.push({ key: KEY, txHash: H(31), block: 1_700n, assets: 10n ** 16n, unconfirmed: true });
      return { scan, run: confirmAccountEvents(chains({ latest: 2_500n, bitReceipts }).clients, D, scan, ME) };
    };
    // no such transaction on a node at block 2,500; and a transaction that has no deposit of the account's
    for (const receipts of [{}, { [H(31)]: { status: "success", logs: [delivered] } }]) {
      const { scan, run } = shown(receipts);
      await expect(run).rejects.toThrow();
      expect(scan.next).toBe(D.bitBlock);
      expect(scan.deposited).toEqual([]);
      expect(scan.staked).toEqual([]);
    }
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

  it("takes a delivery for a trail only from a receipt that delivered this batch, and only this batch's events in it", async () => {
    const OTHER_KEY = H(78);
    const redeemedIn = (key: Hex, assets: bigint, index: number) =>
      log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "Redeemed", args: { key, user: ME } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint256"), [10n ** 22n, assets]), 1_500n, H(9), index);
    const depositedIn = (key: Hex, index: number) =>
      log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "Deposited", args: { key, user: ME } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint256"), [1n, 1n]), 1_500n, H(9), index);
    const batch5 = log(
      D.vault,
      encodeEventTopics({ abi: VAULT, eventName: "BatchDelivered", args: { key: OTHER_KEY, sourceChain: 8453n, frontDoor: D.frontDoor } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint64, uint256"), [5n, 10n ** 16n]),
      1_500n,
      H(9),
    );
    const w: WithdrawalOp = { id: "w", kind: "withdrawal", account: ME, createdAt: 0, shares: 10n ** 22n, taoEstimate: 1n, usdcEstimate: 1n, fee: 0n, batchId: 3n, state: "sent" };
    const dep: DepositOp = { id: "d", kind: "deposit", account: ME, createdAt: 0, usdcIn: 1n, targetTao: 10n ** 16n, priceUsd: 1, hashes: {}, batchId: 3n, state: "sent" };
    const factsWith = async (logs: unknown[]) => {
      const c = chains({ bitReceipts: { [H(9)]: { status: "success", logs } } });
      // the saved history says batch 3 arrived in transaction H(9)
      const scan = newScan(D);
      scan.delivered.set("3", { key: KEY, txHash: H(9), block: 1_500n, unconfirmed: true });
      return {
        unstake: (await withdrawalFacts(c.clients, D, w, { fd, vault, scan, claims: [] })).facts,
        deposit: (await depositFacts(c.clients, D, dep, { fd, vault, scan })).facts,
      };
    };
    // the transaction delivered batch 5, with the account's redeem there: not this batch's delivery
    const wrong = await factsWith([batch5, redeemedIn(OTHER_KEY, 99n, 1), depositedIn(OTHER_KEY, 2)]);
    expect(wrong.unstake.delivered).toBeUndefined();
    expect(wrong.deposit.delivered).toBeUndefined();
    // batch 3's delivery: of the account's redeems in the transaction, only batch 3's is this one's
    const right = await factsWith([delivered, redeemedIn(OTHER_KEY, 99n, 1), redeemedIn(KEY, 10n ** 16n, 2)]);
    expect(right.unstake.delivered).toMatchObject({ outcome: "redeemed", taoWei: 10n ** 16n });
    expect(right.deposit.delivered?.outcome).toBe("deposited");
  });

  it("knows when the account's entry was too small to send back after the bridge fee", async () => {
    const redeemedLog = log(
      D.vault,
      encodeEventTopics({ abi: VAULT, eventName: "Redeemed", args: { key: KEY, user: ME } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256, uint256"), [10n ** 18n, 10n ** 12n]),
      1_500n,
      H(9),
      1,
    );
    // the chunk sent nothing: every entry in it was worth less than its share of the fee
    const chunkLog = log(
      D.vault,
      encodeEventTopics({ abi: VAULT, eventName: "PayoutChunkSent", args: { key: KEY } }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint32, uint32, uint256, uint256, uint256"), [0, 1, 10n ** 12n, 0n, 0n]),
      1_900n,
      H(10),
    );
    const dust = log(D.vault, encodeEventTopics({ abi: VAULT, eventName: "PayoutDust", args: { key: KEY, user: ME } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256"), [10n ** 12n]), 1_900n, H(10), 1);
    const c = chains({
      bitLogs: [delivered, chunkLog],
      bitReceipts: { [H(9)]: { status: "success", logs: [delivered, redeemedLog] }, [H(10)]: { status: "success", logs: [chunkLog, dust] } },
      executionState: 2,
    });
    const scan = newScan(D);
    await scanVault(c.clients, D, scan, ME);
    const op: WithdrawalOp = { id: "w", kind: "withdrawal", account: ME, createdAt: 0, shares: 10n ** 18n, taoEstimate: 1n, usdcEstimate: 1n, fee: 0n, batchId: 3n, state: "sent" };
    const f = (await withdrawalFacts(c.clients, D, op, { fd, vault, scan, claims: [] })).facts;
    expect(f.payout).toMatchObject({ txHash: H(10), dust: true, state: 0 });
    expect(f.payout?.messageId).toBeUndefined();
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
    expect(f.facts.claimed?.shared).toBeUndefined();
    // one claim that paid out several unstakes: what it paid isn't this one's alone
    const both = await withdrawalFacts(c.clients, D, op, { fd, vault, scan: newScan(D), claims: [{ ...claim, withdrawalIds: ["w", "w2"] }] });
    expect(both.facts.claimed).toMatchObject({ taoClaimed: 99n * 10n ** 14n, usdcOut: 2_450_000n, shared: true });
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
    // a cancel Base doesn't know at all is unseen: just sent, or dropped
    const pending = await depositWith(H(16));
    expect(pending.cancelMined).toBe(false);
    expect(pending.cancelPending).toBe("unseen");
    expect(took.cancelPending).toBeUndefined();
    expect((await depositWith(H(14))).cancelPending).toBeUndefined();
    const cancelled = await withdrawalFacts(c.clients, D, { ...w, cancelled: { hash: H(15), at: 1 } }, { fd, vault, scan, claims: [] });
    expect(cancelled.facts.cancelMined).toBe(true);
    expect(cancelled.facts.delivered).toBeUndefined();
    expect(cancelled.facts.payout).toBeUndefined();
  });

  it("knows whether a cancel with no receipt can still go through: still waiting, or its nonce taken by another transaction", async () => {
    const dep: DepositOp = { id: "d", kind: "deposit", account: ME, createdAt: 0, usdcIn: 1n, targetTao: 10n ** 16n, priceUsd: 1, hashes: {}, batchId: 4n, state: "sent", cancelled: { hash: H(16), at: 1 } };
    const pendingWith = async (nonce: number) =>
      (await depositFacts(chains({ baseTxs: { [H(16)]: { nonce: 7, blockNumber: null } }, nonce }).clients, D, dep, { fd, vault, scan: newScan(D) })).facts.cancelPending;
    // waiting to be mined: the account hasn't used nonce 7 yet
    expect(await pendingWith(7)).toBe("known");
    // the account's nonce is past it: another transaction took nonce 7, so this cancel can never be mined
    expect(await pendingWith(8)).toBeUndefined();
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
    // not found (a node that is behind, or not mined yet) is no answer, nor is a receipt that can't be read
    expect(await went(H(24))).toBeUndefined();
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

  it("splits the one entry the front door made of the account's requests in a batch between them, by their shares", async () => {
    const half = { ...op, shares: 5n * 10n ** 21n };
    const b = backOnBase({ logs: [landedFor(ME, HEAD - 4_000n), deliveredUsdc(2_431_337n, HEAD - 3_990n, H(62))] });
    const factsFor = (w: WithdrawalOp, siblings: WithdrawalOp[]) =>
      withdrawalFacts(b.clients, D3, w, { fd: { ...fd, claimable: 0n }, vault, scan: b.scan, claims: [], siblings }).then((r) => r.facts);
    // two unstakes of this browser in batch 3, merged into one Redeemed of 1e22 shares for 0.01 TAO
    const [first, second] = [{ ...half, id: "a" }, { ...half, id: "b" }];
    for (const f of [await factsFor(first, [first, second]), await factsFor(second, [first, second])]) {
      expect(f.delivered?.taoWei).toBe(5n * 10n ** 15n);
      expect(f.credited?.taoWei).toBe(TAO_BACK / 2n);
      // the delivery sold both halves: its USDC is shared
      expect(f.usdcDelivered?.shared).toBe(true);
    }
    // the other half was asked for from another browser: the entry still says this one is half
    expect((await factsFor(first, [first])).delivered?.taoWei).toBe(5n * 10n ** 15n);
    // the whole entry was this request's
    const whole = await factsFor(op, [op]);
    expect(whole.delivered?.taoWei).toBe(10n ** 16n);
    expect(whole.credited?.taoWei).toBe(TAO_BACK);
    expect(whole.usdcDelivered?.shared).toBeUndefined();
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
