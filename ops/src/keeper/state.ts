import {
  type AbiEvent,
  type Address,
  decodeEventLog,
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  encodePacked,
  type Hex,
  hexToBigInt,
  hexToNumber,
  numberToHex,
  parseAbi,
} from "viem";
import { BASE_V3, baseLogsTarget, type ChainName, LIVE, PRECOMPILE } from "../config.ts";
import { closeMaxWaitS as planMaxWait, isPlanV3, ROUTE_0 } from "../plan.ts";
import { type DeploymentRecord, loadRecord, RecordMismatch, sameDeployment, saveRecord } from "../record.ts";
import { balanceOf, codeAt, gasPriceOf, isRevert, nonceOf, read, RpcError } from "../rpc.ts";
import { type Ctx, describeRevert, logsOf, replaceCall, type Sent, sendCall, signerOf } from "../send.ts";
import type { Rpc } from "../rpc.ts";
import type { KeeperDeps, KeeperState, Message } from "./actions.ts";
import { encodeBatch, type Entry } from "./batch.ts";
import { DELIVER_ABI, type DeliveryRead, NO_ANSWER, netOfFee, preferenceProblem, uniqueUsers } from "./delivery.ts";
import { type CloseEconomics, closeEconomicsOf, closesWithoutFees, type State } from "./due.ts";
import type { PayoutLog } from "./payouts.ts";
import { vaultColdkey } from "./rewards.ts";

const FRONT = parseAbi([
  "struct Entry { address user; uint256 amount; }",
  "function canClose() view returns (bool)",
  "function openDeposits() view returns (Entry[])",
  "function openRedeems() view returns (Entry[])",
  "function paused() view returns (bool)",
  "function claimable(address) view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "function openBatch() view returns (uint64 id, uint64 start, uint256 totalDeposits, uint256 feePot, uint256 nDeposits, uint256 nRedeems)",
  "function batchInterval() view returns (uint64)",
  "function maxDeposits() view returns (uint32)",
  "function maxRedeems() view returns (uint32)",
  "function maxBatchValue() view returns (uint256)",
  "function minDeposit() view returns (uint256)",
  "event BatchClosed(uint64 indexed id, uint256 totalDeposits, uint256 nDeposits, uint256 nRedeems, uint256 fee, uint256 potUsed)",
  "event DepositRequested(uint64 indexed batchId, address indexed user, uint256 amount, address payer)",
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

const REWARDS_VAULT = parseAbi([
  "function stakeHotkey() view returns (bytes32)",
  "function lastClaimAt(bytes32 hotkey) view returns (uint64)",
  "function claimGasRequired() view returns (uint256)",
]);
const UNCLAIMED = parseAbi(["function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) view returns (uint256)"]);
/** Uniswap's QuoterV2 is not a view (it quotes by reverting inside), but answers an eth_call. */
const QUOTER = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const DELIVERY_FRONT = parseAbi([
  "function deliveryOf(address user) view returns (uint128 minUsdcPerTao, uint64 deadline, uint32 destination)",
  "function oracle() view returns (address)",
  "function swapper() view returns (address)",
  "function maxDeliverySlippageBps() view returns (uint16)",
]);
const STAKER = parseAbi([
  "function deliveryRouteId() view returns (uint8)",
  "function routes(uint8 id) view returns (uint8 kind, address router, bytes buyPath, bytes sellPath, bool active)",
  "function swapFeeBps() view returns (uint16)",
  "function depositFeeUsdc() view returns (uint256)",
]);
const ORACLE = parseAbi(["function usdcValue(uint256 taoWei) view returns (uint256)"]);
/** Every view the keeper reads, by contract (tests answer them with a fake chain): the close's
 * economics read the front door's oracle and staker and quote ETH on Uniswap. */
export const KEEPER_READ_ABIS = { FRONT, VAULT, ADAPTER, ALPHA, OFFRAMP, STAKING, DELIVERY_FRONT, STAKER, ORACLE, QUOTER };
/** The reads behind `rewards` and `claim`. */
export const REWARD_READ_ABIS = { REWARDS_VAULT, UNCLAIMED, QUOTER };
/** The reads (and the simulated deliver) behind `deliver`. */
export const DELIVERY_READ_ABIS = { FRONT, DELIVERY_FRONT, STAKER, ORACLE, QUOTER, DELIVER: DELIVER_ABI, VAULT };
/** The staker's RouterKind.UniswapV3: the only route kind QuoterV2 can price. */
const UNISWAP_V3 = 0;
/** WETH -0.05%-> USDC: the pool the staker's route and the oracle use, quoted for ETH's price. */
const ETH_USDC_PATH = encodePacked(["address", "uint24", "address"], [BASE_V3.WETH, 500, BASE_V3.USDC]);
const E18 = 10n ** 18n;

export { isRevert } from "../rpc.ts";

/** A node's own error (not a revert): the delivery is skipped for a later round, never sent on it. */
const unanswered = (e: unknown) => e instanceof RpcError && !isRevert(e);
export const EXECUTION_STATES = ["UNTOUCHED", "IN_PROGRESS", "SUCCESS", "FAILURE"];
const ED_RESERVE = 10n ** 12n;
/** eth_getLogs block ranges the public RPCs accept. Base's go to OPS_BASE_LOGS_RPC (mainnet.base.org
 * refuses eth_getLogs altogether); some public Base endpoints refuse more than 200 blocks. */
export const WINDOW: Record<ChainName, bigint> = { base: 100n, bittensor: 1_000n };
/** One eth_getLogs's block range on `chain`: the logs server's own (live Base: OPS_BASE_LOGS_WINDOW), else WINDOW. */
export const windowOf = (ctx: Pick<Ctx, "logsWindow">, chain: ChainName): bigint => ctx.logsWindow?.[chain] ?? WINDOW[chain];
/** The most eth_getLogs queries the keeper's first look at a batch's deposits makes on Base: that many of
 * the logs window (REQUESTED_MAX_QUERIES × windowOf) back from the head at most. The live logs server's
 * 10,000-block window covers a day's batch (43,200 blocks) in 5; a public RPC's 100-block window would
 * reach only four hours back, and the keeper then says so (a batch older than that counts its earlier
 * deposits as unpaid). The look-back starts at the batch's first block (blockAtOrAfter), so a keeper
 * restarted at any hour of a batch sees its whole life. */
const REQUESTED_MAX_QUERIES = 72n;
/** Base's block time, and the first step of blockAtOrAfter's bracket around its guess (a minute). */
const BASE_SECONDS_PER_BLOCK = 2;
const BLOCK_SEARCH_STEP = 30n;

/** The first block of `chain` at or after `time` (a Unix second), by its timestamps: a guess from the
 * head's time at `secondsPerBlock` a block, a bracket around it (each side stepped away, doubling, until
 * it is on its side of `time`), then bisected. About two reads when the guess is right (Base's steady
 * 2-second blocks), a handful more when it is off by minutes. `head + 1` when no block is at `time` yet. */
export async function blockAtOrAfter(rpc: Rpc, chain: ChainName, time: number, head: bigint, headTime: number, secondsPerBlock = BASE_SECONDS_PER_BLOCK): Promise<bigint> {
  const timeOf = async (n: bigint) => hexToNumber(((await rpc.request(chain, "eth_getBlockByNumber", [numberToHex(n), false])) as { timestamp: Hex }).timestamp);
  if (headTime < time) return head + 1n;
  const back = BigInt(Math.floor((headTime - time) / secondsPerBlock));
  const guess = back < head ? head - back : 0n;
  // lo is before `time` (or -1, before the chain); hi is at or after it
  let lo = guess - 1n;
  let hi = guess;
  for (let step = BLOCK_SEARCH_STEP; hi < head && (await timeOf(hi)) < time; step *= 2n) {
    lo = hi;
    hi = hi + step < head ? hi + step : head;
  }
  for (let step = BLOCK_SEARCH_STEP; lo >= 0n && (await timeOf(lo)) >= time; step *= 2n) {
    hi = lo;
    lo -= step;
  }
  if (lo < 0n) lo = -1n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await timeOf(mid)) >= time) hi = mid;
    else lo = mid;
  }
  return hi;
}
/** Each later scan of an event starts this many blocks before the last head it reached, so a log a
 * lagging (load-balanced) node or a reorg hid is found on a later round; still one query a round (about
 * 70 + 30 new blocks of Base's 100-block window, 400 + 5 of Bittensor's 1,000). */
const REREAD: Record<ChainName, bigint> = { base: 70n, bittensor: 400n };
/** Logs this close to the head are returned but not kept: they are read again next round, so one from a
 * block that is then dropped never sticks. */
const SETTLE: Record<ChainName, bigint> = { base: 30n, bittensor: 10n };

/** Each log with an id from its transaction and content, numbered when one transaction logs the same
 * thing twice: the same in every read of its block, and the same when a reorg mines the transaction
 * again in another block or at another index, so that copy is not taken for a second log. */
function identified(logs: readonly ScannedLog[]): [string, ScannedLog][] {
  const count = new Map<string, number>();
  return logs.map((l) => {
    const what = `${l.transactionHash}:${l.raw.topics.join(",")}:${l.raw.data}`;
    const n = count.get(what) ?? 0;
    count.set(what, n + 1);
    return [`${what}#${n}`, l];
  });
}

const event = (abi: readonly unknown[], name: string) =>
  (abi as AbiEvent[]).find((i) => i.type === "event" && i.name === name) as AbiEvent;

export interface ScannedLog {
  raw: { address: Address; topics: Hex[]; data: Hex };
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

/** One event from one contract, from `from` to `to` (default: the latest block), in windows the public
 * RPCs accept. */
export async function scanLogs(
  ctx: Ctx,
  chain: ChainName,
  address: Address,
  ev: AbiEvent,
  from: bigint,
  topics: (Hex | null)[] = [],
  to?: bigint,
) {
  const rpc = logsOf(ctx);
  const step = windowOf(ctx, chain);
  const latest = to ?? hexToBigInt((await rpc.request(chain, "eth_blockNumber", [])) as Hex);
  const topic0 = encodeEventTopics({ abi: [ev], eventName: ev.name } as never)[0];
  const out: ScannedLog[] = [];
  for (let start = from; start <= latest; start += step) {
    const end = start + step - 1n < latest ? start + step - 1n : latest;
    const logs = (await rpc.request(chain, "eth_getLogs", [
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

/** The block the deployment's Bittensor contracts start at, where every Bittensor log scan starts: its
 * Bittensor adapter's (the first created there), recorded with its transaction or, when its creation was
 * recovered, found by deploy from its code. A record without one is refused: a window counted back from
 * the head would slide with it and lose older events. */
export function startBlock(rec: DeploymentRecord): bigint {
  const first = rec.done.bitAdapter;
  if (first && "block" in first && first.block !== undefined) return BigInt(first.block);
  throw new Error(
    `the record has no block for the Bittensor adapter's creation${first ? " (it was recovered, not recorded)" : ""}, where every Bittensor log scan starts: run deploy again to find it; nothing scanned`,
  );
}

/** The keeper's reads and sends. Base is scanned for logs only for the open batch's deposits, over its
 * last blocks, when its fees decide its close (its public RPC allows 200 blocks a query): bridge messages
 * come from the record, which the keeper fills as it sends. The vault's payout events (and with them the
 * delivery candidates) and the open batch's deposits are kept for the life of these deps (one `run`
 * loop), so each round scans only the blocks since the last, and some before them (REREAD). */
export function keeperDeps(ctx: Ctx, rec: DeploymentRecord, recordPath: string, users: Address[] = []): KeeperDeps {
  const a = rec.plan.addresses;
  /** Who the keeper's sends come from (the context's signer: keeperSigner), whose nonces, balances and
   * claim the keeper reads, and who simulates a delivery. */
  const signer = signerOf(ctx).address;
  const r = (chain: ChainName, address: Address, abi: readonly unknown[], functionName: string, args?: unknown[]) =>
    read(ctx.rpc, chain, { address, abi: abi as never, functionName, args });

  /** One event's logs found so far, for the life of these deps. Each call scans to the head from REREAD
   * blocks before the last head it reached (the first time from `first(head)`, and never before it), and
   * moves on only once the whole range is in, so a failed scan is retried. Logs SETTLE blocks below the
   * head are kept; nearer ones are returned and read again next round. */
  function logCursor(chain: ChainName, address: Address, ev: AbiEvent, topics: (Hex | null)[] = []) {
    const kept: ScannedLog[] = [];
    const seen = new Set<string>();
    let scannedTo: bigint | undefined;
    return async (first: (head: bigint) => bigint | Promise<bigint>): Promise<{ logs: ScannedLog[]; head: bigint }> => {
      // the head from the server the logs come from
      const head = hexToBigInt((await logsOf(ctx).request(chain, "eth_blockNumber", [])) as Hex);
      const earliest = await first(head);
      const back = scannedTo === undefined ? earliest : scannedTo + 1n - REREAD[chain];
      const from = back > earliest ? back : earliest;
      const fresh: ScannedLog[] = [];
      if (from <= head) {
        for (const [id, l] of identified(await scanLogs(ctx, chain, address, ev, from, topics, head))) {
          if (seen.has(id)) continue;
          if (l.blockNumber + SETTLE[chain] <= head) {
            seen.add(id);
            kept.push(l);
          } else fresh.push(l);
        }
      }
      scannedTo = head;
      return { logs: [...kept, ...fresh], head };
    };
  }
  const vaultLogs = (name: string) => {
    const read = logCursor("bittensor", a.vault, event(VAULT, name));
    return () => read(() => startBlock(rec));
  };
  // `let`: rescanPayoutLogs replaces them, so the next scan of each starts over from the deploy block
  let queuedLogs = vaultLogs("PayoutBatchQueued");
  let bouncedLogs = vaultLogs("DepositBounced");
  let redeemedLogs = vaultLogs("Redeemed");
  /** Payout batches the vault has deleted (paid out or cancelled), not read again for the life of these
   * deps. A batch reads count 0 both once deleted and on a node not yet showing its queue, so it is taken
   * for deleted only when its queue is REREAD blocks deep, further behind than the scans allow a node. */
  const deleted = new Set<string>();

  async function messageState(m: { id: Hex; direction: Message["direction"] }): Promise<string> {
    const dst: ChainName = m.direction === "Base → Bittensor" ? "bittensor" : "base";
    const state = Number(await r(dst, LIVE[dst].OFFRAMP, OFFRAMP, "getExecutionState", [m.id]));
    return EXECUTION_STATES[state] ?? String(state);
  }

  async function messages(): Promise<KeeperState["detail"]["messages"]> {
    const out: KeeperState["detail"]["messages"] = [];
    for (const m of (rec.messages ?? []).slice(-6)) out.push({ id: m.id, direction: m.direction, state: await messageState(m) });
    return out;
  }

  const deps: KeeperDeps = {
    async readState(opts = {}) {
      const deposits = (await r("base", a.frontDoor, FRONT, "openDeposits")) as Entry[];
      const redeems = (await r("base", a.frontDoor, FRONT, "openRedeems")) as Entry[];
      const canClose = (await r("base", a.frontDoor, FRONT, "canClose")) as boolean;
      const fdPaused = (await r("base", a.frontDoor, FRONT, "paused")) as boolean;
      const claimable = [];
      for (const user of [...new Set([signer, ...users])] as Address[]) {
        claimable.push({ user, amount: (await r("base", a.frontDoor, FRONT, "claimable", [user])) as bigint });
      }
      const healthy =
        !(await r("bittensor", LIVE.ALPHA_VAULT, ALPHA, "isPaused")) &&
        (await r("bittensor", LIVE.ALPHA_VAULT, ALPHA, "migrationReadyAt")) === 0n &&
        !(await r("bittensor", LIVE.ALPHA_VAULT, ALPHA, "migrationFinished"));
      const pending = (await r("bittensor", a.vault, VAULT, "pendingPayouts")) as bigint;
      const balance = await balanceOf(ctx.rpc, "bittensor", a.vault);
      const payoutDelay = Number(await r("bittensor", a.vault, VAULT, "payoutDelay"));
      const { logs: queued, head } = await queuedLogs();
      const batches = [];
      for (const q of queued) {
        const key = q.args.key as Hex;
        if (deleted.has(key.toLowerCase())) continue;
        const b = (await r("bittensor", a.vault, VAULT, "getPayoutBatch", [key])) as { queuedAt: bigint; cursor: number; count: number };
        if (b.count > 0) batches.push({ key, queuedAt: Number(b.queuedAt), cursor: b.cursor, count: b.count });
        else if (q.blockNumber + REREAD.bittensor <= head) deleted.add(key.toLowerCase());
      }
      const block = (await ctx.rpc.request("bittensor", "eth_getBlockByNumber", ["latest", false])) as { timestamp: Hex };
      const available = balance > ED_RESERVE + pending ? balance - ED_RESERVE - pending : 0n;
      const rootStake = ((await r("bittensor", a.vault, VAULT, "rootStakeRao")) as bigint) * 10n ** 9n;
      const now = hexToNumber(block.timestamp);
      const { frontDoor, closeMaxWaitS } = await openBatchState(deposits, redeems, canClose, fdPaused, opts.economics ?? false);
      return {
        now,
        frontDoor,
        closeMaxWaitS,
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
          balances: { tao: await balanceOf(ctx.rpc, "bittensor", signer), eth: await balanceOf(ctx.rpc, "base", signer) },
          messages: await messages(),
        },
      };
    },
    sendCall: (req) => sendCall(ctx, req),
    signer,
    // read fresh every time, never kept: a send minutes into a round must see a delegation that landed
    // after the round's first send (one eth_getCode a chain a send is cheap)
    signerCode: (chain) => codeAt(ctx.rpc, chain, signer),
    nonce: (chain) => nonceOf(ctx.rpc, chain, signer),
    minedNonce: async (chain) => hexToNumber((await ctx.rpc.request(chain, "eth_getTransactionCount", [signer, "latest"])) as Hex),
    quoteClose: (s) => closeFeeWei(s.detail.openDeposits, s.detail.openRedeems),
    async payoutLogs() {
      const { logs: bounced } = await bouncedLogs();
      const { logs: redeemed } = await redeemedLogs();
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
    rescanPayoutLogs() {
      // new cursors: the next payoutLogs (and readState's batches) scan the vault's events again in full,
      // from the deploy block, instead of trusting a first scan one short eth_getLogs answer cut short
      queuedLogs = vaultLogs("PayoutBatchQueued");
      bouncedLogs = vaultLogs("DepositBounced");
      redeemedLogs = vaultLogs("Redeemed");
    },
    readClaimable: async (user) => (await r("base", a.frontDoor, FRONT, "claimable", [user])) as bigint,
    readMinDeposit: async () => (await r("base", a.frontDoor, FRONT, "minDeposit")) as bigint,
    messageState,
    recordMessage(m) {
      // another command may have saved the record since this one loaded it (a failed verify, a hand-run
      // close): re-read it and add only this message, so nothing it saved is written over
      const entry = { ...m, at: new Date().toISOString() };
      const now = loadRecord(recordPath) ?? rec;
      if (!sameDeployment(now, rec)) {
        rec.messages = [...(rec.messages ?? []), entry];
        ctx.log(`${recordPath} now holds another deployment: bridge message ${m.id} was not saved in it`);
        return;
      }
      now.messages = [...(now.messages ?? []), entry];
      saveRecord(recordPath, now);
      rec.messages = now.messages;
    },
    refresh() {
      // a file that can't be read or parsed now throws as it is (run waits a round on it); one that is
      // gone or holds another deployment is a RecordMismatch, which stops run
      const now = loadRecord(recordPath);
      if (!now) throw new RecordMismatch(`${recordPath} is gone`);
      if (!sameDeployment(now, rec)) throw new RecordMismatch(`${recordPath} now holds another deployment`);
      rec.verify = now.verify;
      rec.done = now.done;
      rec.messages = now.messages;
    },
    async receipt(chain, hash) {
      const r = (await ctx.rpc.request(chain, "eth_getTransactionReceipt", [hash])) as { status: Hex; logs?: Sent["logs"] } | null;
      return r ? { reverted: r.status !== "0x1", logs: r.logs ?? [] } : null;
    },
    replace: (req, pending) => replaceCall(ctx, req, pending),
    async readRewards() {
      const hotkey = (await r("bittensor", a.vault, REWARDS_VAULT, "stakeHotkey")) as Hex;
      const waitingWei = (await r("bittensor", PRECOMPILE.staking, UNCLAIMED, "getUnclaimedRootTaoByHotkey", [vaultColdkey(rec.plan), hotkey])) as bigint;
      const lastClaimAt = Number(await r("bittensor", a.vault, REWARDS_VAULT, "lastClaimAt", [hotkey]));
      const claimGasRequired = (await r("bittensor", a.vault, REWARDS_VAULT, "claimGasRequired")) as bigint;
      const now = await blockTime("bittensor");
      const gasPriceWei = await gasPriceOf(ctx.rpc, "bittensor");
      const walletWei = await balanceOf(ctx.rpc, "bittensor", signer);
      const [usdcPerTao] = (await r("base", BASE_V3.QUOTER_V2, QUOTER, "quoteExactInput", [ROUTE_0.sellPath, 10n ** 18n])) as readonly [bigint];
      return { hotkey, waitingWei, lastClaimAt, now, taoPriceUsd: Number(usdcPerTao) / 1e6, claimGasRequired, gasPriceWei, walletWei };
    },
    async deliveryCandidates() {
      if (!isPlanV3(rec.plan)) return [];
      return uniqueUsers((await redeemedLogs()).logs.map((l) => l.args.user as Address));
    },
    async readDelivery(user) {
      if (!isPlanV3(rec.plan)) throw new Error("USDC delivery needs a v3 deployment");
      const fd = a.frontDoor;
      const claimable = (await r("base", fd, FRONT, "claimable", [user])) as bigint;
      const out: DeliveryRead = { user, claimable, pref: null, quoteUsdc: 0n, twapUsdc: 0n, slippageBps: 0, now: 0 };
      if (claimable === 0n) return out;
      const [minUsdcPerTao, deadline, destination] = (await r("base", fd, DELIVERY_FRONT, "deliveryOf", [user])) as readonly [bigint, bigint, number];
      out.pref = minUsdcPerTao === 0n ? null : { minUsdcPerTao, deadline: Number(deadline), destination: Number(destination) };
      out.now = await blockTime("base");
      if (preferenceProblem(out.pref, out.now)) return out;
      // the front door's own oracle and swapper: what deliver will use
      const oracle = (await r("base", fd, DELIVERY_FRONT, "oracle")) as Address;
      try {
        out.twapUsdc = (await r("base", oracle, ORACLE, "usdcValue", [claimable])) as bigint;
      } catch (e) {
        if (unanswered(e)) {
          out.quoteError = NO_ANSWER;
          return out;
        }
        if (!isRevert(e)) throw e;
        out.twapUsdc = null;
        return out;
      }
      out.slippageBps = Number(await r("base", fd, DELIVERY_FRONT, "maxDeliverySlippageBps"));
      const staker = (await r("base", fd, DELIVERY_FRONT, "swapper")) as Address;
      const routeId = Number(await r("base", staker, STAKER, "deliveryRouteId"));
      const [kind, , , sellPath] = (await r("base", staker, STAKER, "routes", [routeId])) as readonly [number, Address, Hex, Hex, boolean];
      if (kind !== UNISWAP_V3) {
        out.quoteError = `the staker's delivery route ${routeId} is not a Uniswap v3 route, the only kind this tool can quote; it waits`;
        return out;
      }
      const feeBps = Number(await r("base", staker, STAKER, "swapFeeBps"));
      try {
        const [gross] = (await r("base", BASE_V3.QUOTER_V2, QUOTER, "quoteExactInput", [sellPath, claimable])) as readonly [bigint];
        out.quoteUsdc = netOfFee(gross, feeBps);
      } catch (e) {
        if (unanswered(e)) out.quoteError = NO_ANSWER;
        else if (isRevert(e)) out.quoteError = `Uniswap could not quote the sale (${describeRevert(ctx, e)}); it waits`;
        else throw e;
      }
      return out;
    },
    async simulateDeliver(user, keeperMinOut) {
      const data = encodeFunctionData({ abi: DELIVER_ABI, functionName: "deliver", args: [user, keeperMinOut] });
      try {
        const out = (await ctx.rpc.request("base", "eth_call", [{ from: signer, to: a.frontDoor, data }, "latest"])) as Hex;
        return { ok: true, usdcOut: decodeFunctionResult({ abi: DELIVER_ABI, functionName: "deliver", data: out }) };
      } catch (e) {
        if (unanswered(e)) return { ok: false, reason: NO_ANSWER, unanswered: true };
        if (!isRevert(e)) throw e;
        return { ok: false, reason: describeRevert(ctx, e) };
      }
    },
    log: ctx.log,
  };

  /** The close's bridge fee in ETH wei, as the adapter quotes it now. */
  async function closeFeeWei(deposits: readonly Entry[], redeems: readonly Entry[]): Promise<bigint> {
    // the batch id is a fixed-size word, so its value does not change the message size or the fee
    const total = deposits.reduce((t, e) => t + e.amount, 0n);
    const message = encodeBatch(1n, deposits, redeems);
    return (await r("base", a.baseAdapter, ADAPTER, "quoteFee", [BigInt(LIVE.bittensor.CHAIN_ID), a.vault, message, total])) as bigint;
  }

  /** The open batch as the close rule sees it, with the record's max wait and Base's time (read after
   * canClose, so not older than the block it was decided at). Its limits and prices are read only when
   * they can change the decision: it has entries, can close, and is younger than the max wait (never
   * under the test cadence); the prices only when it is not full either, and `economics` asks for them
   * (run and status: a hand-run close, stake or payout doesn't decide on them). */
  async function openBatchState(
    deposits: readonly Entry[],
    redeems: readonly Entry[],
    canClose: boolean,
    paused: boolean,
    economics: boolean,
  ): Promise<{ frontDoor: State["frontDoor"]; closeMaxWaitS: number }> {
    const fd = a.frontDoor;
    const [id, start, totalDeposits, feePot] = (await r("base", fd, FRONT, "openBatch")) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
    const batchInterval = Number(await r("base", fd, FRONT, "batchInterval"));
    const now = await blockTime("base");
    const openStart = Number(start);
    const closeMaxWaitS = planMaxWait(rec.plan);
    const entries = deposits.length + redeems.length > 0;
    const undecided = entries && canClose && !closesWithoutFees({ closeMaxWaitS, frontDoor: { full: false, openStart, batchInterval, now } });
    let full = false;
    if (undecided) {
      // canClose's own limits, without its clock: full before or after the interval
      const maxDeposits = Number(await r("base", fd, FRONT, "maxDeposits"));
      const maxRedeems = Number(await r("base", fd, FRONT, "maxRedeems"));
      const maxBatchValue = (await r("base", fd, FRONT, "maxBatchValue")) as bigint;
      const minDeposit = (await r("base", fd, FRONT, "minDeposit")) as bigint;
      full =
        deposits.length >= maxDeposits ||
        redeems.length >= maxRedeems ||
        totalDeposits >= maxBatchValue ||
        maxBatchValue - totalDeposits < minDeposit;
    }
    const frontDoor: State["frontDoor"] = {
      canClose,
      nDeposits: deposits.length,
      nRedeems: redeems.length,
      paused,
      openStart,
      batchInterval,
      full,
      now,
    };
    if (economics && undecided && !full) {
      frontDoor.closeEconomics = await closeEconomics({ id, openStart, totalDeposits, feePot }, deposits, redeems);
    }
    return { frontDoor, closeMaxWaitS };
  }

  /** The open batch's DepositRequested logs on Base, kept for one batch across rounds, from the block the
   * batch opened in (found once a batch; undefined until it is). */
  let requested: { batchId: bigint; start?: bigint; read: ReturnType<typeof logCursor> } | undefined;
  /** The batch whose deposits the logs server last failed to give: its failure is said once. */
  let logsFailedFor: bigint | undefined;
  /** The batch whose first look the logs window cut short: said once. */
  let cappedFor: bigint | undefined;

  /** The open batch's deposits the staker made (DepositRequested names it as the payer): only those paid
   * the staker's deposit and swap fees; TAO deposited straight into the front door (deposit, depositFor)
   * paid neither. Found by the batch's id over Base's logs, the first look reaching back to the block the
   * batch opened in, the first at or after `openStart` on Base's clock (blockAtOrAfter, found once a batch
   * through the logs server, whose head the scan uses), so a keeper restarted at any hour of a batch counts
   * its deposits; its max wait bounds that, since the fees decide a close only until then. The look-back is
   * cut at REQUESTED_MAX_QUERIES of the logs window (said once a batch): an older deposit then counts as
   * unpaid. Later looks scan only the new blocks. */
  async function stakerDeposits(batchId: bigint, openStart: number, staker: Address): Promise<{ count: number; tao: bigint }> {
    if (requested?.batchId !== batchId) {
      requested = { batchId, read: logCursor("base", a.frontDoor, event(FRONT, "DepositRequested"), [numberToHex(batchId, { size: 32 })]) };
    }
    const r = requested;
    const maxBack = REQUESTED_MAX_QUERIES * windowOf(ctx, "base");
    const { logs } = await r.read(async (head) => {
      if (r.start === undefined) {
        const headTime = hexToNumber(((await logsOf(ctx).request("base", "eth_getBlockByNumber", [numberToHex(head), false])) as { timestamp: Hex }).timestamp);
        r.start = await blockAtOrAfter(logsOf(ctx), "base", openStart, head, headTime);
      }
      const floor = head > maxBack ? head - maxBack : 0n;
      if (r.start < floor && cappedFor !== batchId) {
        cappedFor = batchId;
        ctx.log(
          `Base logs: batch ${batchId} opened at block ${r.start}, ${head - r.start} blocks back, further than the ${maxBack} blocks the logs window allows in ${REQUESTED_MAX_QUERIES} queries: its deposits before block ${floor} are not counted, so it may wait for its max wait instead of closing when its fees cover the bridge fee. Set OPS_BASE_LOGS_WINDOW higher (the live logs server takes 10,000).`,
        );
      }
      return r.start > floor ? r.start : floor;
    });
    const staked = logs.filter((l) => (l.args.payer as Address).toLowerCase() === staker.toLowerCase());
    return { count: staked.length, tao: staked.reduce((t, l) => t + (l.args.amount as bigint), 0n) };
  }

  /** The batch's estimated fees and its close's bridge fee, in USDC units, at the front door's oracle's
   * TAO price and Uniswap's WETH/USDC price, with the front door's staker's fees on the deposits the
   * staker made. A deposit cancelled since still counts its deposit fee, which the staker really paid to
   * the treasury; the swap fee is counted on no more than the batch's TAO now. null when any of those
   * reads fails (a revert or a node that didn't answer), or a price or the bridge fee reads 0 (a $0 bridge
   * fee would count any batch as covered): the batch then waits for its max wait, never closing early on a
   * guess. */
  async function closeEconomics(
    batch: { id: bigint; openStart: number; totalDeposits: bigint; feePot: bigint },
    deposits: readonly Entry[],
    redeems: readonly Entry[],
  ): Promise<CloseEconomics | null> {
    try {
      const oracle = (await r("base", a.frontDoor, DELIVERY_FRONT, "oracle")) as Address;
      const staker = (await r("base", a.frontDoor, DELIVERY_FRONT, "swapper")) as Address;
      const taoPriceUsdc = (await r("base", oracle, ORACLE, "usdcValue", [E18])) as bigint;
      const depositFeeUsdc = (await r("base", staker, STAKER, "depositFeeUsdc")) as bigint;
      const swapFeeBps = Number(await r("base", staker, STAKER, "swapFeeBps"));
      const [ethPriceUsdc] = (await r("base", BASE_V3.QUOTER_V2, QUOTER, "quoteExactInput", [ETH_USDC_PATH, E18])) as readonly [bigint];
      const bridgeFeeWei = await closeFeeWei(deposits, redeems);
      if (taoPriceUsdc === 0n || ethPriceUsdc === 0n || bridgeFeeWei === 0n) return null;
      let staked: { count: number; tao: bigint };
      try {
        staked = await stakerDeposits(batch.id, batch.openStart, staker);
        logsFailedFor = undefined;
      } catch (e) {
        // said once a batch, not every round of `run`
        if (logsFailedFor !== batch.id) {
          logsFailedFor = batch.id;
          const hours = planMaxWait(rec.plan) / 3600;
          ctx.log(
            `Base logs: couldn't read batch ${batch.id}'s deposits (${(e as Error).message.split("\n")[0]}), so its deposit fees are unknown and it waits for its max wait (${hours} hours) instead of closing when they cover its bridge fee. Set OPS_BASE_LOGS_RPC to a Base RPC that serves eth_getLogs (without it, OPS_BASE_RPC unless that is mainnet.base.org, else ${baseLogsTarget({}).rpcUrl}).`,
          );
        }
        return null;
      }
      const stakedTao = staked.tao < batch.totalDeposits ? staked.tao : batch.totalDeposits;
      return closeEconomicsOf({ nStaked: staked.count, depositFeeUsdc, stakedTao, taoPriceUsdc, swapFeeBps, feePot: batch.feePot, ethPriceUsdc, bridgeFeeWei });
    } catch {
      return null;
    }
  }

  async function blockTime(chain: ChainName): Promise<number> {
    const block = (await ctx.rpc.request(chain, "eth_getBlockByNumber", ["latest", false])) as { timestamp: Hex };
    return hexToNumber(block.timestamp);
  }

  return deps;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Follows a bridge message from either adapter to SUCCESS or FAILURE on the destination OffRamp. */
export async function trackMessage(ctx: Ctx, rec: DeploymentRecord, id: Hex, opts = { pollMs: 30_000, maxMs: 2 * 3600_000 }) {
  const a = rec.plan.addresses;
  const known = rec.messages?.find((m) => m.id.toLowerCase() === id.toLowerCase());
  let dst: ChainName | undefined = known ? (known.direction === "Base → Bittensor" ? "bittensor" : "base") : undefined;
  if (!dst && (await scanLogs(ctx, "bittensor", a.bitAdapter, event(ADAPTER, "Sent"), startBlock(rec), [id])).length) {
    dst = "base";
  }
  if (!dst) {
    // not one the keeper sent: look back over Base's last 1,000 blocks (about half an hour)
    const latest = hexToBigInt((await logsOf(ctx).request("base", "eth_blockNumber", [])) as Hex);
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
      const latest = hexToBigInt((await logsOf(ctx).request(dst, "eth_blockNumber", [])) as Hex);
      const changed = await scanLogs(ctx, dst, offRamp, event(OFFRAMP, "ExecutionStateChanged"), latest - windowOf(ctx, dst) + 1n, [null, null, id]);
      ctx.log(`The delivery failed; the OffRamp returned ${(changed.at(-1)?.args.returnData as Hex) ?? "nothing"}`);
      return state;
    }
    if (Date.now() > deadline) throw new Error(`message ${id} still ${state} after ${opts.maxMs / 60_000} minutes`);
    await sleep(opts.pollMs);
  }
}
