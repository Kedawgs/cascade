// Fixture chains for v3.2's trail states (Task 59): Base (its RPC and its logs RPC) and Bittensor as v3.2's contracts
// answer them, and the real v3.2 events encoded with v3.2's own ABIs, for trail.test.ts and live.test.ts. Each log list
// is filtered as the servers filter it (block range and address; Base's by topics too). Each chain's head is now:
// these fakes' Base makes a block every 2 seconds (the real one every 0.2 s since block 53,556,128; the site measures it,
// blocktime.ts) and Bittensor every 12, unless a halt (`halt`) makes Bittensor's older blocks older still.

import { type Abi, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbiParameters, toFunctionSelector, toHex, TransactionNotFoundError } from "viem";
import { ADAPTER, BIT_ADAPTER_V32, FRONT_DOOR_V32, VAULT_V32 } from "../abi";
import type { Deployment } from "../config";
import { newScan, type VaultScan } from "../facts";
import type { DepositOp, WithdrawalOp } from "../oplog";
import type { FrontDoorState, VaultState } from "../reads";

export const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
export const USER = getAddress("0x000000000000000000000000000000000000a11c");
export const OTHER = getAddress("0x000000000000000000000000000000000000b0b0");
const base3 = { frontDoor: A(0xf00d), baseAdapter: A(0xba5e), vault: A(0xba17), bitAdapter: A(0xb17a), bitBlock: 1_000n, vaultSs58: "x", hotkeySs58: "y" };
/** v3-launch: a v3 deployment without the lenses. */
export const LAUNCH: Deployment = { ...base3, staker: A(0x5a4e), oracle: A(0x041e) };
export const V32: Deployment = { ...LAUNCH, vaultLens: A(0xae15), doorLens: A(0xde15) };

export const NOW_S = Math.floor(Date.now() / 1000);
export const BASE_HEAD = 40_000_000n;
export const BIT_HEAD = 6_000_000n;
export const DAY = 86_400;
export const baseAt = (s: number) => BASE_HEAD - BigInt(Math.ceil((NOW_S - s) / 2));
/** Bittensor's seconds a block in these chains: 12, as it is; a test may set another (and put it back) to show a search
 * follows the block time it measures. */
export const BIT_CLOCK = { blockS: 12 };
export const bitAt = (s: number) => BIT_HEAD - BigInt(Math.ceil((NOW_S - s) / BIT_CLOCK.blockS));
export const baseTs = (b: bigint) => NOW_S - Number(BASE_HEAD - b) * 2;
/** A Bittensor block's time; with `halt`, the blocks before `halt.before` are `halt.seconds` older (a chain halt). */
export const bitTs = (b: bigint, halt?: { before: bigint; seconds: number }) => NOW_S - Number(BIT_HEAD - b) * BIT_CLOCK.blockS - (halt && b < halt.before ? halt.seconds : 0);

export type Log = { address: Hex; topics: Hex[]; data: Hex; blockNumber: bigint; transactionHash: Hex; logIndex: number };
export const event = (address: Hex, abi: Abi, eventName: string, args: Record<string, unknown>, data: Hex, block: bigint, tx: Hex, index = 0): Log => ({
  address,
  topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[],
  data,
  blockNumber: block,
  transactionHash: tx,
  logIndex: index,
});
export const enc = (types: string, values: readonly unknown[]) => encodeAbiParameters(parseAbiParameters(types), values as never);
export const receipt = (logs: Log[], blockNumber?: bigint) => ({ status: "success", ...(blockNumber !== undefined ? { blockNumber } : {}), logs });

export const BATCH = 7n;
/** The CCIP message that carried batch 7, the park's key, and the vault's key for the batch. */
export const MSG = H(0x51);
export const PARK_KEY = H(0x9a);
export const VKEY = H(0x77);
export const TAO = 4n * 10n ** 16n;
export const SHARES = 4n * 10n ** 22n;
export const [STAKE_TX, CLOSE_TX, EXEC_TX, REFUND_TX, LAND_TX, REQUEST_TX, CHUNK_TX, BACK_TX] = [1, 2, 3, 4, 5, 6, 8, 10].map((n) => H(0x100 + n));
export const STAKE_MISSING_REASON = toFunctionSelector("StakeMissing()");
export const DIRECT = 2n ** 64n - 1n;

// Base: the front door's and its adapter's
export const depositRequested = (block: bigint) =>
  event(V32.frontDoor, FRONT_DOOR_V32, "DepositRequested", { batchId: BATCH, user: USER }, enc("uint256, address", [TAO, V32.staker]), block, STAKE_TX);
export const redeemRequested = (block: bigint) => event(V32.frontDoor, FRONT_DOOR_V32, "RedeemRequested", { batchId: BATCH, user: USER }, enc("uint256", [SHARES]), block, REQUEST_TX);
export const batchClosed = (block: bigint) =>
  event(V32.frontDoor, FRONT_DOOR_V32, "BatchClosed", { id: BATCH }, enc("uint256, uint256, uint256, uint256, uint256, uint256", [TAO, 1n, 1n, 10n ** 14n, 10n ** 14n, 0n]), block, CLOSE_TX);
export const baseSent = (block: bigint) =>
  event(V32.baseAdapter, ADAPTER, "Sent", { messageId: MSG, sender: V32.frontDoor, recipient: V32.vault }, enc("uint64, uint256, uint256, uint256", [964n, TAO, 10n ** 14n, 500_000n]), block, CLOSE_TX, 1);
export const payoutReceived = (key: Hex, chunk: number, user: Hex, amount: bigint, block: bigint, tx: Hex) =>
  event(V32.frontDoor, FRONT_DOOR_V32, "PayoutReceived", { batchKey: key, user }, enc("uint32, uint256", [chunk, amount]), block, tx);
// Bittensor: the adapter's and the vault's
export const adapterDelivered = (block: bigint, amount = TAO) =>
  event(V32.bitAdapter, ADAPTER, "Delivered", { messageId: MSG, sender: V32.frontDoor, recipient: V32.vault }, enc("uint64, uint256", [8453n, amount]), block, EXEC_TX, 1);
export const batchParked = (block: bigint, amount = TAO, reason: Hex = STAKE_MISSING_REASON) =>
  event(V32.bitAdapter, BIT_ADAPTER_V32, "BatchParked", { key: PARK_KEY, messageId: MSG }, enc("address, address, uint256, bool, bytes4", [V32.vault, V32.frontDoor, amount, true, reason]), block, EXEC_TX);
export const parkedRefunded = (block: bigint) => event(V32.bitAdapter, BIT_ADAPTER_V32, "ParkedRefunded", { key: PARK_KEY, messageId: H(0x52) }, "0x", block, REFUND_TX);
export const parkedDropped = (block: bigint) => event(V32.bitAdapter, BIT_ADAPTER_V32, "ParkedDropped", { key: PARK_KEY }, "0x", block, REFUND_TX);
export const vaultDelivered = (block: bigint) =>
  event(V32.vault, VAULT_V32, "BatchDelivered", { key: VKEY, sourceChain: 8453n, frontDoor: V32.frontDoor }, enc("uint64, uint256", [BATCH, TAO]), block, EXEC_TX);
export const depositBounced = (block: bigint, reason: number) => event(V32.vault, VAULT_V32, "DepositBounced", { key: VKEY, user: USER }, enc("uint256, uint8", [TAO, reason]), block, EXEC_TX, 2);
export const redeemSkipped = (block: bigint) => event(V32.vault, VAULT_V32, "RedeemSkipped", { key: VKEY, user: USER }, enc("uint256", [SHARES]), block, EXEC_TX, 2);
export const redeemed = (block: bigint) => event(V32.vault, VAULT_V32, "Redeemed", { key: VKEY, user: USER }, enc("uint256, uint256", [SHARES, TAO]), block, EXEC_TX, 2);

const matches = (want: unknown, have: Hex | undefined): boolean =>
  want === null || want === undefined || (Array.isArray(want) ? want.some((w) => matches(w, have)) : typeof want === "string" && have !== undefined && want.toLowerCase() === have.toLowerCase());

export interface ChainOptions {
  baseLogs?: Log[];
  baseReceipts?: Record<string, unknown>;
  bitLogs?: Log[];
  bitReceipts?: Record<string, unknown>;
  /** The Bittensor OffRamp's execution state of each Base-to-Bittensor message (2 = run on Bittensor, 3 = failed). */
  executed?: Record<string, number>;
  /** The adapter's parked(key): amount, parkedAt, converted (none: no record). */
  parks?: Record<string, readonly [bigint, bigint, boolean]>;
  /** The adapter's parkedNative and parkedTokens: what its parks owe (none: nothing parked). */
  parkedTotals?: readonly [bigint, bigint];
  /** The Base OffRamp's execution state of each Bittensor-to-Base message. */
  baseExecuted?: Record<string, number>;
  pref?: readonly [bigint, bigint, number];
  sale?: bigint;
  pools?: { mean: readonly [bigint, bigint]; floors: readonly [bigint, bigint] };
  /** The vault lens's redeemOrigin(account) at a past block (the archive node's answer), or a read that fails. */
  originAt?: bigint | "fail";
  /** Bittensor's blocks before `before` are `seconds` older: a halt between them. */
  halt?: { before: bigint; seconds: number };
  bittensorDown?: boolean;
}

/** The chains as clients (`base`, `baseLogs`, `bittensor`), and `asked`, every read that names something, in order. */
export function chains(o: ChainOptions) {
  const asked: string[] = [];
  const base = {
    getBlockNumber: async () => BASE_HEAD,
    getBlock: async (q?: { blockNumber?: bigint }) =>
      q?.blockNumber !== undefined ? { number: q.blockNumber, timestamp: BigInt(baseTs(q.blockNumber)) } : { number: BASE_HEAD, timestamp: BigInt(NOW_S) },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      asked.push(`base.receipt:${hash}`);
      const r = o.baseReceipts?.[hash];
      if (!r) throw new Error("receipt not found");
      return r;
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      throw new TransactionNotFoundError({ hash });
    },
    getTransactionCount: async () => 0,
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "getExecutionState") return o.baseExecuted?.[String(args?.[0])] ?? 0;
      if (functionName === "deliveryOf") return o.pref ?? [0n, 0n, 0];
      if (functionName === "quoteExactInput") return [o.sale ?? 0n, [], [], 0n];
      throw new Error(`unexpected ${functionName} on Base`);
    },
    multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) =>
      contracts.map((k) => {
        if (k.functionName === "swapFeeBps") return 15;
        if (k.functionName === "depositFeeUsdc") return 50_000n;
        if (k.functionName === "meanLiquidity" && o.pools) return o.pools.mean;
        if (k.functionName === "minPoolLiquidity" && o.pools) return o.pools.floors[Number(k.args?.[0])];
        throw new Error(`unexpected ${k.functionName} on Base`);
      }),
  };
  const baseLogs = {
    request: async ({ method, params }: { method: string; params?: { address: string; topics?: unknown[]; fromBlock: Hex; toBlock: Hex }[] }) => {
      if (method === "eth_blockNumber") return toHex(BASE_HEAD);
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const q = params![0];
      const [from, to] = [BigInt(q.fromBlock), BigInt(q.toBlock)];
      return (o.baseLogs ?? []).filter(
        (l) => l.blockNumber >= from && l.blockNumber <= to && l.address.toLowerCase() === q.address.toLowerCase() && (q.topics ?? []).every((t, i) => matches(t, l.topics[i])),
      );
    },
  };
  const bittensor = {
    request: async ({ method }: { method: string }) => {
      if (o.bittensorDown) throw new Error("HTTP request failed");
      if (method !== "eth_blockNumber") throw new Error(`unexpected ${method}`);
      return toHex(BIT_HEAD);
    },
    getBlock: async (q?: { blockNumber?: bigint }) =>
      q?.blockNumber !== undefined ? { number: q.blockNumber, timestamp: BigInt(bitTs(q.blockNumber, o.halt)) } : { number: BIT_HEAD, timestamp: BigInt(NOW_S) },
    getLogs: async ({ address, fromBlock, toBlock }: { address?: string; fromBlock: bigint; toBlock: bigint }) => {
      if (o.bittensorDown) throw new Error("HTTP request failed");
      asked.push(`bittensor.logs:${fromBlock}-${toBlock}`);
      return (o.bitLogs ?? []).filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && (!address || l.address.toLowerCase() === address.toLowerCase()));
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => o.bitReceipts?.[hash] ?? null,
    readContract: async ({ functionName, args, blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      if (o.bittensorDown) throw new Error("HTTP request failed");
      asked.push(`bittensor.${functionName}${blockNumber !== undefined ? `@${blockNumber}` : ""}`);
      if (functionName === "getExecutionState") return o.executed?.[String(args?.[0])] ?? 0;
      if (functionName === "parked") return o.parks?.[String(args?.[0])] ?? [0n, 0n, false];
      if (functionName === "parkedNative") return o.parkedTotals?.[0] ?? 0n;
      if (functionName === "parkedTokens") return o.parkedTotals?.[1] ?? 0n;
      if (functionName === "redeemOrigin") {
        if (o.originAt === "fail" || blockNumber === undefined) throw new Error("the archive node couldn't answer");
        return o.originAt ?? 8453n;
      }
      throw new Error(`unexpected ${functionName} on Bittensor`);
    },
  };
  return { base, baseLogs, bittensor, asked };
}

/** Batch 7 has left Base (8 is open). */
export const fd: FrontDoorState = {
  depositOf: 0n,
  redeemOf: 0n,
  claimable: 0n,
  openBatchId: 8n,
  openStart: NOW_S - 600,
  openTotal: 0n,
  openDeposits: 0,
  openRedeems: 0,
  netForwarded: 0n,
  depositCap: 0n,
  minDeposit: 0n,
  redeemRequestFee: 0n,
  canClose: false,
  batchInterval: 3_600,
  maxBatchValue: 0n,
  maxDeposits: 50,
};
export const vault: VaultState = {
  shares: SHARES,
  totalAssets: 10n ** 18n,
  totalSupply: 10n ** 24n,
  rootStakeWei: 10n ** 18n,
  pendingPayouts: 0n,
  balanceWei: 10n ** 12n,
  stakeHotkey: H(1),
  payoutDelay: 3_600,
  nominatorMinWei: 2n * 10n ** 16n,
  maxEntryValue: 10n ** 19n,
  stakeMissing: false,
  redeemOrigin: 8453n,
};
/** A scan that has read Bittensor to its head and holds no delivery. */
export const scanned = (d: Deployment): VaultScan => {
  const s = newScan(d);
  s.next = BIT_HEAD - 1n;
  return s;
};

/** A stake of 0.04 TAO (or an unstake request) made `ageS` seconds ago into batch 7, whose close left Base half an
 * hour after it, and the bridge's run of its message on Bittensor 25 minutes after that. */
export function crossed(ageS: number) {
  const depBlock = baseAt(NOW_S - ageS);
  const closeBlock = depBlock + 900n;
  const execBlock = bitAt(baseTs(closeBlock) + 25 * 60);
  return {
    depBlock,
    closeBlock,
    execBlock,
    parkS: bitTs(execBlock),
    stakeOp: { id: "s1", kind: "deposit", v: 3, account: USER, createdAt: (NOW_S - ageS) * 1000, usdcIn: 10_000_000n, targetTao: TAO, priceUsd: 250, hashes: { stake: STAKE_TX }, state: "sent" } as DepositOp,
    requestOp: { id: "u1", kind: "withdrawal", account: USER, createdAt: (NOW_S - ageS) * 1000, shares: SHARES, taoEstimate: TAO, usdcEstimate: 10_000_000n, fee: 10n ** 14n, hash: REQUEST_TX, state: "sent" } as WithdrawalOp,
    base: {
      baseLogs: [batchClosed(closeBlock)],
      baseReceipts: {
        [STAKE_TX]: receipt([depositRequested(depBlock)], depBlock),
        [REQUEST_TX]: receipt([redeemRequested(depBlock)], depBlock),
        [CLOSE_TX]: receipt([batchClosed(closeBlock), baseSent(closeBlock)], closeBlock),
      },
    },
  };
}
export type Crossed = ReturnType<typeof crossed>;

/** The bridge ran batch 7's message on Bittensor and the adapter parked it (the vault refused it). */
export const parkedRun = (x: Pick<Crossed, "execBlock">, amount = TAO) => ({
  bitLogs: [batchParked(x.execBlock, amount), adapterDelivered(x.execBlock, amount)],
  bitReceipts: { [EXEC_TX]: receipt([batchParked(x.execBlock, amount), adapterDelivered(x.execBlock, amount)]) },
  executed: { [MSG]: 2 },
});
