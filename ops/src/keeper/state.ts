import {
  type AbiEvent,
  type Address,
  decodeEventLog,
  encodeEventTopics,
  type Hex,
  hexToBigInt,
  hexToNumber,
  numberToHex,
  parseAbi,
} from "viem";
import { type ChainName, LIVE, PRECOMPILE, WALLET } from "../config.ts";
import { type DeploymentRecord, saveRecord } from "../record.ts";
import { balanceOf, nonceOf, read } from "../rpc.ts";
import { type Ctx, sendCall } from "../send.ts";
import type { KeeperDeps, KeeperState } from "./actions.ts";
import { encodeBatch, type Entry } from "./batch.ts";
import type { PayoutLog } from "./payouts.ts";

const FRONT = parseAbi([
  "struct Entry { address user; uint256 amount; }",
  "function canClose() view returns (bool)",
  "function openDeposits() view returns (Entry[])",
  "function openRedeems() view returns (Entry[])",
  "function paused() view returns (bool)",
  "function claimable(address) view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "event BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed)",
]);
const VAULT = parseAbi([
  "struct PayoutBatch { uint64 sourceChain; address frontDoor; uint64 batchId; uint64 queuedAt; uint32 cursor; uint32 count; uint32 chunk; uint256 remaining; bytes32 payoutsHash; }",
  "function paused() view returns (bool)",
  "function pendingPayouts() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function rootStakeRao() view returns (uint256)",
  "function minStakeRao() view returns (uint256)",
  "function payoutDelay() view returns (uint64)",
  "function getPayoutBatch(bytes32 key) view returns (PayoutBatch)",
  "event PayoutBatchQueued(bytes32 indexed key, uint64 indexed sourceChain, uint64 batchId, uint32 count, uint256 total, uint256 price)",
  "event DepositBounced(bytes32 indexed key, address indexed user, uint256 assets)",
  "event Redeemed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets)",
]);
const ADAPTER = parseAbi([
  "function quoteFee(uint64 destChain, address recipient, bytes message, uint256 amount) view returns (uint256)",
  "event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)",
]);
const ALPHA = parseAbi([
  "function isPaused() view returns (bool)",
  "function migrationReadyAt() view returns (uint256)",
  "function migrationFinished() view returns (bool)",
]);
const OFFRAMP = parseAbi([
  "function getExecutionState(bytes32 messageId) view returns (uint8)",
  "event ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed sequenceNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
]);
const STAKING = parseAbi(["function getNominatorMinRequiredStake() view returns (uint256)"]);
/** Every view the keeper reads, by contract (tests answer them with a fake chain). */
export const KEEPER_READ_ABIS = { FRONT, VAULT, ADAPTER, ALPHA, OFFRAMP, STAKING };
export const EXECUTION_STATES = ["UNTOUCHED", "IN_PROGRESS", "SUCCESS", "FAILURE"];
const ED_RESERVE = 10n ** 12n;
/** eth_getLogs block ranges the public RPCs accept: mainnet.base.org refuses more than 200 blocks. */
export const WINDOW: Record<ChainName, bigint> = { base: 100n, bittensor: 1_000n };

const event = (abi: readonly unknown[], name: string) =>
  (abi as AbiEvent[]).find((i) => i.type === "event" && i.name === name) as AbiEvent;

export interface ScannedLog {
  raw: { address: Address; topics: Hex[]; data: Hex };
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

/** One event from one contract, from `from` to the latest block, in windows the public RPCs accept. */
export async function scanLogs(ctx: Ctx, chain: ChainName, address: Address, ev: AbiEvent, from: bigint, topics: (Hex | null)[] = []) {
  const latest = hexToBigInt((await ctx.rpc.request(chain, "eth_blockNumber", [])) as Hex);
  const topic0 = encodeEventTopics({ abi: [ev], eventName: ev.name } as never)[0];
  const out: ScannedLog[] = [];
  for (let start = from; start <= latest; start += WINDOW[chain]) {
    const end = start + WINDOW[chain] - 1n < latest ? start + WINDOW[chain] - 1n : latest;
    const logs = (await ctx.rpc.request(chain, "eth_getLogs", [
      { address, fromBlock: numberToHex(start), toBlock: numberToHex(end), topics: [topic0, ...topics] },
    ])) as { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex }[];
    for (const l of logs) {
      const d = decodeEventLog({ abi: [ev], topics: l.topics as [Hex, ...Hex[]], data: l.data });
      out.push({
        raw: { address: l.address, topics: l.topics, data: l.data },
        args: d.args as Record<string, unknown>,
        blockNumber: hexToBigInt(l.blockNumber),
        logIndex: hexToNumber(l.logIndex),
        transactionHash: l.transactionHash,
      });
    }
  }
  return out;
}

/** The block each chain's contracts were deployed in (a recovered step falls back to the last 10,000 blocks). */
export async function startBlock(ctx: Ctx, rec: DeploymentRecord, chain: ChainName): Promise<bigint> {
  const first = rec.done[chain === "base" ? "baseAdapter" : "bitAdapter"];
  if (first && "block" in first) return BigInt(first.block);
  const latest = hexToBigInt((await ctx.rpc.request(chain, "eth_blockNumber", [])) as Hex);
  return latest > 10_000n ? latest - 10_000n : 0n;
}

/** The keeper's reads and sends. Base is never scanned for logs here (its public RPC allows 200
 * blocks a query): bridge messages come from the record, which the keeper fills as it sends. */
export function keeperDeps(ctx: Ctx, rec: DeploymentRecord, recordPath: string, users: Address[] = []): KeeperDeps {
  const a = rec.plan.addresses;
  const r = (chain: ChainName, address: Address, abi: readonly unknown[], functionName: string, args?: unknown[]) =>
    read(ctx.rpc, chain, { address, abi: abi as never, functionName, args });

  async function messages(): Promise<KeeperState["detail"]["messages"]> {
    const out: KeeperState["detail"]["messages"] = [];
    for (const m of (rec.messages ?? []).slice(-6)) {
      const dst: ChainName = m.direction === "Base → Bittensor" ? "bittensor" : "base";
      const state = Number(await r(dst, LIVE[dst].OFFRAMP, OFFRAMP, "getExecutionState", [m.id]));
      out.push({ id: m.id, direction: m.direction, state: EXECUTION_STATES[state] ?? String(state) });
    }
    return out;
  }

  const deps: KeeperDeps = {
    async readState() {
      const deposits = (await r("base", a.frontDoor, FRONT, "openDeposits")) as Entry[];
      const redeems = (await r("base", a.frontDoor, FRONT, "openRedeems")) as Entry[];
      const canClose = (await r("base", a.frontDoor, FRONT, "canClose")) as boolean;
      const fdPaused = (await r("base", a.frontDoor, FRONT, "paused")) as boolean;
      const claimable = [];
      for (const user of [...new Set([WALLET, ...users])] as Address[]) {
        claimable.push({ user, amount: (await r("base", a.frontDoor, FRONT, "claimable", [user])) as bigint });
      }
      const healthy =
        !(await r("bittensor", LIVE.ALPHA_VAULT, ALPHA, "isPaused")) &&
        (await r("bittensor", LIVE.ALPHA_VAULT, ALPHA, "migrationReadyAt")) === 0n &&
        !(await r("bittensor", LIVE.ALPHA_VAULT, ALPHA, "migrationFinished"));
      const pending = (await r("bittensor", a.vault, VAULT, "pendingPayouts")) as bigint;
      const balance = await balanceOf(ctx.rpc, "bittensor", a.vault);
      const payoutDelay = Number(await r("bittensor", a.vault, VAULT, "payoutDelay"));
      const queued = await scanLogs(ctx, "bittensor", a.vault, event(VAULT, "PayoutBatchQueued"), await startBlock(ctx, rec, "bittensor"));
      const batches = [];
      for (const q of queued) {
        const key = q.args.key as Hex;
        const b = (await r("bittensor", a.vault, VAULT, "getPayoutBatch", [key])) as { queuedAt: bigint; cursor: number; count: number };
        if (b.count > 0) batches.push({ key, queuedAt: Number(b.queuedAt), cursor: b.cursor, count: b.count });
      }
      const block = (await ctx.rpc.request("bittensor", "eth_getBlockByNumber", ["latest", false])) as { timestamp: Hex };
      const available = balance > ED_RESERVE + pending ? balance - ED_RESERVE - pending : 0n;
      const rootStake = ((await r("bittensor", a.vault, VAULT, "rootStakeRao")) as bigint) * 10n ** 9n;
      return {
        now: hexToNumber(block.timestamp),
        frontDoor: { canClose, nDeposits: deposits.length, nRedeems: redeems.length, paused: fdPaused },
        alphaVault: { healthy },
        vault: {
          paused: (await r("bittensor", a.vault, VAULT, "paused")) as boolean,
          available,
          minStakeWei: ((await r("bittensor", a.vault, VAULT, "minStakeRao")) as bigint) * 10n ** 9n,
          rootStake,
          nominatorMinWei: ((await r("bittensor", PRECOMPILE.staking, STAKING, "getNominatorMinRequiredStake")) as bigint) * 10n ** 9n,
          batches,
          payoutDelay,
        },
        detail: {
          openDeposits: [...deposits],
          openRedeems: [...redeems],
          canClose,
          depositCap: (await r("base", a.frontDoor, FRONT, "depositCap")) as bigint,
          vaultAssets: (await r("bittensor", a.vault, VAULT, "totalAssets")) as bigint,
          rootStake,
          pendingPayouts: pending,
          batches,
          payoutDelay,
          claimable,
          balances: { tao: await balanceOf(ctx.rpc, "bittensor", WALLET), eth: await balanceOf(ctx.rpc, "base", WALLET) },
          messages: await messages(),
        },
      };
    },
    sendCall: (req) => sendCall(ctx, req),
    nonce: (chain) => nonceOf(ctx.rpc, chain, WALLET),
    async quoteClose(s) {
      // the batch id is a fixed-size word, so its value does not change the message size or the fee
      const total = s.detail.openDeposits.reduce((t, e) => t + e.amount, 0n);
      const message = encodeBatch(1n, s.detail.openDeposits, s.detail.openRedeems);
      return (await r("base", a.baseAdapter, ADAPTER, "quoteFee", [BigInt(LIVE.bittensor.CHAIN_ID), a.vault, message, total])) as bigint;
    },
    async payoutLogs() {
      const from = await startBlock(ctx, rec, "bittensor");
      const bounced = await scanLogs(ctx, "bittensor", a.vault, event(VAULT, "DepositBounced"), from);
      const redeemed = await scanLogs(ctx, "bittensor", a.vault, event(VAULT, "Redeemed"), from);
      const shape = (kind: PayoutLog["kind"]) => (l: ScannedLog): PayoutLog => ({
        kind,
        key: l.args.key as Hex,
        user: l.args.user as Address,
        shares: kind === "bounced" ? 0n : (l.args.shares as bigint),
        assets: l.args.assets as bigint,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
      });
      return [...bounced.map(shape("bounced")), ...redeemed.map(shape("redeemed"))];
    },
    async batchInfo(key) {
      const b = (await r("bittensor", a.vault, VAULT, "getPayoutBatch", [key])) as { payoutsHash: Hex; count: number };
      return { payoutsHash: b.payoutsHash, count: b.count };
    },
    recordMessage(m) {
      rec.messages = [...(rec.messages ?? []), { ...m, at: new Date().toISOString() }];
      saveRecord(recordPath, rec);
    },
    log: ctx.log,
  };
  return deps;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Follows a bridge message from either adapter to SUCCESS or FAILURE on the destination OffRamp. */
export async function trackMessage(ctx: Ctx, rec: DeploymentRecord, id: Hex, opts = { pollMs: 30_000, maxMs: 2 * 3600_000 }) {
  const a = rec.plan.addresses;
  const known = rec.messages?.find((m) => m.id.toLowerCase() === id.toLowerCase());
  let dst: ChainName | undefined = known ? (known.direction === "Base → Bittensor" ? "bittensor" : "base") : undefined;
  if (!dst && (await scanLogs(ctx, "bittensor", a.bitAdapter, event(ADAPTER, "Sent"), await startBlock(ctx, rec, "bittensor"), [id])).length) {
    dst = "base";
  }
  if (!dst) {
    // not one the keeper sent: look back over Base's last 1,000 blocks (about half an hour)
    const latest = hexToBigInt((await ctx.rpc.request("base", "eth_blockNumber", [])) as Hex);
    if ((await scanLogs(ctx, "base", a.baseAdapter, event(ADAPTER, "Sent"), latest - 1_000n, [id])).length) dst = "bittensor";
  }
  if (!dst) throw new Error(`no bridge message ${id} was found from either adapter`);
  const offRamp = LIVE[dst].OFFRAMP;
  const deadline = Date.now() + opts.maxMs;
  let last = "";
  for (;;) {
    const state = EXECUTION_STATES[Number(await read(ctx.rpc, dst, { address: offRamp, abi: OFFRAMP, functionName: "getExecutionState", args: [id] }))];
    if (state !== last) ctx.log(`Bridge message ${id.slice(0, 10)}… on ${dst === "base" ? "Base" : "Bittensor"}: ${state}`);
    last = state;
    if (state === "SUCCESS") return state;
    if (state === "FAILURE") {
      // the change happened since the last poll: a recent window is enough
      const latest = hexToBigInt((await ctx.rpc.request(dst, "eth_blockNumber", [])) as Hex);
      const changed = await scanLogs(ctx, dst, offRamp, event(OFFRAMP, "ExecutionStateChanged"), latest - WINDOW[dst] + 1n, [null, null, id]);
      ctx.log(`The delivery failed; the OffRamp returned ${(changed.at(-1)?.args.returnData as Hex) ?? "nothing"}`);
      return state;
    }
    if (Date.now() > deadline) throw new Error(`message ${id} still ${state} after ${opts.maxMs / 60_000} minutes`);
    await sleep(opts.pollMs);
  }
}
