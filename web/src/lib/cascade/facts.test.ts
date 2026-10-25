import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { ADAPTER, ERC20, FRONT_DOOR, VAULT } from "./abi";
import type { Deployment } from "./config";
import { depositFacts, newScan, scanVault, withdrawalFacts } from "./facts";
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

