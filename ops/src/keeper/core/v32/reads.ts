import {
  type Abi,
  type AbiEvent,
  type Address,
  decodeEventLog,
  encodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBigInt,
  hexToNumber,
  keccak256,
  numberToHex,
  padHex,
  stringToHex,
  toFunctionSelector,
} from "viem";
import {
  ADAPTER,
  ALPHA,
  CLAIM_SOURCE,
  DOOR,
  DOOR_LENS,
  ERRORS_V32,
  KEEPER_CALLS_V32,
  OFFRAMP,
  OFFRAMP_CCVS,
  OFFRAMP_EVENTS,
  ONRAMP,
  PARK_CALLS,
  PARK_EVENTS,
  PARK_JOBS,
  PARK_READS,
  QUOTER,
  RAIL_VIEWS,
  ROOT_STAKE_UNLOCK_INTERVAL_KEY,
  SYSTEM_NUMBER_KEY,
  STAKER,
  STORAGE_QUERY,
  STAKING,
  VAULT_ABI_V32,
  VAULT_KEPT,
  VAULT_LENS,
  ORACLE as ORACLE_ABI,
} from "../abi.ts";
import type { KeeperDeps, KeeperState, Rails } from "../actions.ts";
import { encodeBatch, type Entry } from "../batch.ts";
import { type DeliveryRead, NO_ANSWER, netOfFee, preferenceProblem } from "../delivery.ts";
import { type AdapterPair, adapterPairs, type DeploymentV32, pairOfBase, pairOfBit } from "../deployment.ts";
import { SendRefused } from "../errors.ts";
import { type CloseEconomics, closeEconomicsOf, closesWithoutFees, type ParkRef, type State } from "../due.ts";
import { type Journal, spendRows, spentOn } from "../journal.ts";
import { blocksIn, blockTimeOf } from "../blocktime.ts";
import { blockAtOrAfter, event, identified, type LogsCtx, logsOf, marginsOf, REREAD, type ScannedLog, SETTLE, scanLogsInParts, windowOf } from "../logs.ts";
import type { KeeperMemory } from "../memory.ts";
import type { PayoutLog } from "../payouts.ts";
import { type AdoptionRead, beingFreed, type ClaimsRead, type HotkeyRead } from "../rewards.ts";
import { balanceOf, codeAt, gasPriceOf, isEvmHalt, isRevert, nonceOf, type Rpc, RpcError, read } from "../rpc.ts";
import { describeRevert, replaceRaw, replayReason, type SendCtx, type Signer, sendRaw, settlePending } from "../send.ts";
import type { StatusDetail } from "../status.ts";
import type { CallRequest, ChainName, Sent } from "../types.ts";
import { parseReference, type Reference, SALE_PROBE_TAO, vetoReason } from "../veto.ts";
import type { VaultSolvency } from "./bounce.ts";
import type { ExecutionInputsAnswer } from "./ccip-api.ts";
import { type Direction, laneOf } from "./ccip.ts";
import type { ParkLog } from "./parked.ts";
import { deferredProblem, readDeferred } from "./deferred.ts";
import { answersU32, decodeU64, type WatchRead } from "./hotkeys.ts";
import type { PayoutInputs } from "./payout.ts";
import { type RailsEnv, railsRefusal, railsV32 } from "./rails.ts";
import { parkKeyOf } from "./requests.ts";

// The v3.2 keeper's reads and sends over the fetch-based Rpc (design-keeper-worker.md §1, reads.ts): the vault's moved
// getters through its lens, the front door's own, the published vault ABI for its logs and errors, and the core's raw
// send path. Everything kept between rounds (the log cursors and the logs of open payout batches, the batches taken
// for deleted, the open batch's deposits) lives in the round's memory (memory.reads), so a Worker that builds these
// deps afresh each invocation reads on from where the last one stopped. Deliveries (Task 50a): the candidates from
// the front door's own events on Base (credited, less delivered or claimed, with a live preference), oldest credit
// first, read with their cursors in the memory too; the outside-price veto before each. Claims (Task 51): every listed
// hotkey's credits from the one claim source (creditsOf), its last claim and the vault's stake on it, and the adoption's
// facts, read only when the round asks (claims.ts).

/** What the v3.2 reads add to a round's state: the open batch's id and deposits (closeBatch by id), and the vault's
 * solvency and stake (the bounce outlook, staking while stake is missing). */
export type KeeperStateV32 = KeeperState & {
  v32: {
    openId: bigint;
    openTotal: bigint;
    /** R12b, R12d (L-1): the batch is full by its limits before its max wait, and a close of it names this as its
     * minValue, not openTotal: the least total still full (fullCloseFloor), before its interval as after it. Absent when it
     * isn't full, and at the max wait, where the close names 0 whatever the batch (R12c: due.ts atMaxWait); a close by the
     * fee rule names feeFloor instead (R12g), or 0 when the pot covers its quote (R12h: v32/actions.ts closeV32). */
    fullFloor?: bigint;
    /** R12g: a close the fee rule decides (the batch neither full by its limits nor at its max wait; a hand close of such a
     * batch too) names this as its minValue: the total read less one minimum deposit, at least 0 (feeCloseFloor), unless
     * the pot covers the close's quote, when it names 0 (R12h). Absent when the batch is full (fullFloor) or at its max wait
     * (0). */
    feeFloor?: bigint;
    /** R12h: Base's head block when the read was made (its header, read with the batch: the time the close rule reads the
     * batch's age by), where a close sent on this read that the chain reverts with no reason its replay can read starts
     * reading the batch's cancels (v32/actions.ts minedClose). Absent when the header names no block. */
    readBlock?: bigint;
    feePot: bigint;
    vault: VaultSolvency & { stakeMissing: boolean; hotkeyCount: number };
    /** Each side's primary bridge (the door's and the vault's, through their lenses): where a close's and a payout's
     * Sent log comes from */
    primary: Record<ChainName, Address>;
    /** ForeverMoney's AlphaVault as the round read it (Task 52): its migration notice (migrationReadyAt, 0: none), whether
     * its migration has executed, whether it is paused. alphaVault.healthy is all three clear. While the notice runs, its
     * MIGRATION_DELAY() in seconds (read once and kept; undefined when it can't be read: the park job then counts 7 days) */
    alpha: { migrationReadyAt: bigint; migrationFinished: boolean; paused: boolean; migrationDelayS?: number };
  };
};

/** One of Cascade's own bridge messages, as its source adapter's Sent logs it (Task 52): its id, its lane, the source
 * block it was sent in, the token amount it carries and the gas limit the adapter asked for. */
export interface CascadeSent {
  id: Hex;
  direction: Direction;
  block: bigint;
  amount: bigint;
  gasLimit: bigint;
  /** The adapter that sent it (R4, D-M2: which pair it went through); absent: the deploy's pair */
  adapter?: Address;
}

/** How long Cascade's sends are kept (Task 52): 15 days, past PARK_TIMEOUT: a park's message is rebuilt from its send
 * within minutes of the park. In each chain's blocks at its block time, measured (blocktime.ts; Base's went from 2 s to
 * 200 ms on 2026-11-05). */
export const SENT_RETAIN_S = 15 * 86_400;

/** A lookup by id over a bounded block range (Task 52 fix round 1): what it found; that the whole range holds none; or,
 * cut off part way (a read deadline, a node's error), how far it read, its progress kept for the next call. */
export type Lookup<T> = { found: T } | { none: { from: bigint; to: bigint } } | { partial: { from: bigint; to: bigint; scannedTo: bigint; error: unknown } };

/** R12h: the most eth_getLogs windows a reverted close's cancels are read in (KeeperDepsV32.cancelsIn), so a mined revert
 * with no reason replayed costs the run at most this many subrequests and two more (the logs server's head first, and once
 * more when it trails the close's block: CANCELS_LAG_MS), before the read again that it cost already. A close's span from its read to
 * its block is seconds (the Worker's receipt wait is 40 s: 200 of Base's 200 ms blocks), one of the Worker's 10,000-block
 * windows, and two of the public RPCs' 100 for a close by hand that waited its receipt a while. */
export const CANCELS_WINDOWS = 2;
/** R12h: how long cancelsIn waits for a logs server behind the close's block before its one more look (and one subrequest
 * more): ten of Base's 200 ms blocks. */
export const CANCELS_LAG_MS = 2_000;

/** A lookup that found nothing is tried again after this long (a node that missed a log, a range read too soon). */
export const LOOKUP_RETRY_MS = 24 * 3_600_000;

/** What the transaction that wrote a message's FAILURE logged (Task 52 fix round 1): its hash, its block, and the error the
 * attempt failed with (ExecutionStateChanged's returnData). */
export interface FailureWritten {
  tx: Hex;
  block: bigint;
  returnData: Hex;
}

/** The v3.2 deps: the KeeperDeps every round uses, and what the v3.2 actions and checks read. */
export interface KeeperDepsV32 extends KeeperDeps {
  readState(opts?: { economics?: boolean }): Promise<KeeperStateV32>;
  /** R12h: the deposits cancelled from batch `batchId` (the front door's DepositCancelled) in Base blocks `from` through
   * `to`, read from the logs server in at most CANCELS_WINDOWS of its windows, the last ones up to `to` (a range longer than
   * that is read from its end: a cancel that voids a close lands after its simulation, seconds before the close's block).
   * Throws when they can't all be read: the logs server still behind `to` after one more look CANCELS_LAG_MS later, or a
   * window refused. */
  cancelsIn(batchId: bigint, from: bigint, to: bigint): Promise<{ block: bigint; user: Address; amount: bigint }[]>;
  /** What batch `key`'s payout plan reads (payout.ts PayoutInputs), and the bridge's fee for its chunk */
  readPayoutInputs(key: Hex): Promise<PayoutInputs>;
  quotePayout(sourceChain: bigint, frontDoor: Address, message: Hex, sum: bigint): Promise<bigint>;
  /** The owner's cancel of `key` (PayoutBatchCancelled), the last one, if any */
  cancelOf(key: Hex): Promise<{ bouncesCarried: number } | undefined>;
  /** keeper() on the vault (through its lens) and on the front door, and each chain's id as its RPC reports it */
  readKeepers(): Promise<{ vault: Address; frontDoor: Address }>;
  chainIds(): Promise<Record<ChainName, number>>;
  /** A for-life getter's value, any contract (readiness.ts) */
  readValue(chain: ChainName, address: Address, abi: Abi, fn: string, args?: readonly unknown[]): Promise<unknown>;
  /** The vault's lastStakeAt (through its lens) and the time of the block it was read at, Bittensor's head: one block
   * for both, so a stake landing between two reads, or a node behind another, can't set them apart (readiness.ts) */
  stakeClock(): Promise<{ lastStakeAt: number; block: bigint; time: number }>;
  code(chain: ChainName, address: Address): Promise<Hex>;
  balance(chain: ChainName, address: Address): Promise<bigint>;
  deployment: DeploymentV32;
  /** The host's rails (v32/rails.ts): the monitor, ops/hold.json, a hand run's override, the deliveries switch */
  rails: RailsEnv;
  /** The send journal (the spend cap sums it) */
  journal: Journal;
  /** ForeverMoney's migration notice: the AlphaVault's migrationReadyAt() at Bittensor's head block (0: none). Throws
   * when it can't be read (the rails then give no exception). */
  migrationNotice(): Promise<bigint>;
  /** The rails' latest answer, which the one send path checks every send against while it is fresh (railsV32 calls it) */
  railsSeen(r: Rails): void;
  /** Settles the journal's unsettled rows (core/send.ts settlePending): a receipt gives its actual cost, a nonce passed
   * with no receipt marks the row dropped. The spend cap runs it before it sums (railsV32, the send path). */
  settleJournal(): Promise<void>;
  /** Task 51: every listed hotkey (hotkeys(i), in the vault's order; the standby among them once it is listed): what
   * waits on it (the claim source), its last claim, the vault's stake on it and whether it is the stake hotkey; and what a
   * claim's decision and its up-front fee read (Bittensor's time, TAO's price, claimGasRequired, the gas price, the
   * keeper's TAO). */
  readClaims(): Promise<ClaimsRead>;
  /** Task 51: what the adoption decides by, all from the chain (the surplus, the minimum, the pause, stake missing,
   * lastAdoptAt, Bittensor's time). */
  readAdoption(): Promise<AdoptionRead>;
  /** Task 53, the hotkey watch (hotkeys.ts): stake missing and how much, the vault's root stake off its list (undefined:
   * the lens reverted), Bittensor's RootStakeUnlockInterval through the storage-query precompile (undefined: it can't be
   * read, or doesn't decode), and what the buffer rule computes from. */
  readWatch(): Promise<WatchRead>;
  /** What the keeper has spent on `chain` in the spend cap's window (gas plus value; an unsettled send at its worst case),
   * by the host's clock, as the rails and the send path sum it. */
  spent(chain: ChainName): Promise<bigint>;
  /** What a claim's worst case is read from (Task 51 fix round 1): the vault's claimGasRequired, and Bittensor's fee cap
   * now (its gas price on legacy transactions, twice it on EIP-1559 ones). */
  claimGas(): Promise<{ claimGasRequired: bigint; feeCapWei: bigint }>;
  /** Task 52: the Bittensor adapters' park events (BatchParked, ParkedDelivered, ParkedConverted, ParkedRefunded,
   * ParkedDropped) since each one's creation, every pair the deployment lists (R4, D-M2), each scan on from its cursor in
   * the memory, each log naming its adapter; and the lowest head the scans read to. */
  parkLogs(): Promise<{ logs: ParkLog[]; head: bigint; settle?: bigint }>;
  /** Task 52: lets go of the park logs of `keys` (closed, or a stranger's), so the memory keeps only what is open. */
  forgetParks(keys: readonly Hex[]): void;
  /** Task 52: a park's record on the Bittensor adapter (parked(key)), and the adapter's remote chain (its key is made with
   * it: immutable, read once). */
  readPark(key: Hex, adapter?: Address): Promise<{ amount: bigint; parkedAt: bigint; converted: boolean }>;
  parkRemoteChain(adapter?: Address): Promise<bigint>;
  /** Task 52: deliverParked's eth_call from the keeper (the plan's "when its eth_call succeeds"), and quoteRefund's fee,
   * each on the park's own adapter (R4). */
  simulateDeliverParked(p: ParkRef): Promise<{ ok: true } | { ok: false; reason: string }>;
  quoteRefund(p: ParkRef): Promise<bigint>;
  /** R4 (A-M1, C-M1; merge 7b): what a parked delivery of `p` needs at the vault's call, as its own Bittensor adapter
   * answers it: parkedDeliveryGas(message), the lane's inbound model for the message with PARK_GAS_RESERVE inside it
   * (the gas CCIP gives a delivery of it), capped at GAS_CAP; read live, never recomputed. */
  parkGas(p: ParkRef): Promise<bigint>;
  /** R4 (C-L2): whether the vault has `bridge` enabled now (bridgeEnabled, through its lens): it takes a batch from no other. */
  bridgeEnabled(bridge: Address): Promise<boolean>;
  /** Task 52: Cascade's own bridge messages on the lane `direction` (both when absent): each source adapter's Sent whose
   * payload runs from the door to the vault (Base → Bittensor) or from the vault to the door (Bittensor → Base), the topics
   * filtered and the arguments checked again; kept SENT_RETAIN_S of blocks. `recent` (a hand command's one look, Task 52w): a
   * first scan starts SENT_RETAIN_S of blocks behind the head, not at the start block (what it would drop anyway, unpinned). */
  cascadeSent(direction?: Direction, o?: { recent?: boolean }): Promise<CascadeSent[]>;
  /** Task 52: the ids cascadeSent keeps whatever their age (the re-execution's messages not yet SUCCESS: a FAILURE has no
   * expiry); replaces the last set. Its FAILUREs' lookups (failureOf) of messages no longer pinned are let go of too. */
  pinSent(ids: readonly Hex[]): void;
  /** Task 52 fix round 1 (review I1): the park job's own pins, kept apart from pinSent's: every open park's message id,
   * which cascadeSent then keeps whatever its age while the park is open; replaces the last set. The lookups by id
   * (sentById) of messages no longer pinned by either are let go of too. */
  pinParkSends(ids: readonly Hex[]): void;
  /** Task 52 fix round 1: one of Cascade's own sends, looked up by its message id: each lane's (or `direction`'s) source
   * adapter's Sent with the id and the lane's ends as its topics, its arguments checked again, over a bounded block range:
   * from the deployment's start block to the head, or, given `before` (a time, unix s: a park's parkedAt), the `lookbackS`
   * before it to an hour after it, by the source chain's block time. Chunk by chunk (logs.ts scanLogsInParts), its
   * progress kept in the memory: one cut off part way reads on from there next time. `fresh` (a hand run: the re-review's
   * N5) reads again a range that found nothing within the day. */
  sentById(id: Hex, o?: { direction?: Direction; before?: number; lookbackS?: number; fresh?: boolean }): Promise<Lookup<CascadeSent>>;
  /** Task 52 fix round 1: the transaction that wrote message `id`'s FAILURE on its destination's OffRamp (its
   * ExecutionStateChanged to FAILURE) and the error it logged, from about the time of its send (`sentBlock`, on the
   * source chain, less an hour and a tenth of the time since) to the head; chunk by chunk, its progress kept. */
  failureOf(direction: Direction, id: Hex, sentBlock: bigint, o?: { fresh?: boolean }): Promise<Lookup<FailureWritten>>;
  /** Task 52w (the re-review's N4): block `block`'s time on `chain` (unix s) */
  blockTimeAt(chain: ChainName, block: bigint): Promise<number>;
  /** Task 52 fix round 1: a transaction by its hash, as the chain knows it (its sender, recipient and calldata), or null. */
  transactionOf(chain: ChainName, hash: Hex): Promise<{ from: Address; to: Address | null; input: Hex } | null>;
  /** Task 65: message `id`'s committee results from Chainlink's CCIP API (ccip-api.ts fetchExecutionInputs), where the
   * host reads it (pnpm ops reexec on the PC); absent: not read (the Worker). */
  executionInputs?(id: Hex): Promise<ExecutionInputsAnswer>;
  /** Task 52 fix round 1: the committees (CCVs) the destination OffRamp requires for message `encoded`
   * (getCCVsForMessage): the required, the optional and how many of those. */
  ccvsFor(direction: Direction, encoded: Hex): Promise<{ required: Address[]; optional: Address[]; threshold: number }>;
  /** Task 52 fix round 1: `req` as an eth_call from the keeper at the latest block (the re-execution's explicit
   * simulation): it passes, or its revert data and reason. */
  simulate(req: CallRequest): Promise<{ ok: true } | { ok: false; data?: Hex; reason: string }>;
  /** Task 52: the encoded MessageV1 of message `id` from its source OnRamp's CCIPMessageSent at `block` (where its Sent
   * is), sent by `adapter` (R4: its pair's source adapter; absent, the deploy's), or undefined when that block has none. */
  onRampMessage(direction: Direction, block: bigint, id: Hex, adapter?: Address): Promise<Hex | undefined>;
}

/** deliverParked(address,address,bytes)'s selector: the one call the migration exception may let through. */
const DELIVER_PARKED_SELECTOR = toFunctionSelector("deliverParked(address,address,bytes)");

/** How long the rails' answer stands for the send path, within one round (or one one-shot command): a minute. */
export const RAILS_FRESH_MS = 60_000;

export interface V32Env {
  rpc: Rpc;
  /** Where log scans go (absent: rpc), and each chain's eth_getLogs block range (absent: the public RPCs') */
  logs?: Rpc;
  logsWindow?: Partial<Record<ChainName, bigint>>;
  deployment: DeploymentV32;
  signer: Signer;
  send: Pick<SendCtx, "chains" | "maxGasPrice" | "receiptTimeoutMs" | "pollMs" | "now" | "sleep">;
  journal: Journal;
  /** The round's memory: the reads keep their cursors in memory.reads */
  memory: KeeperMemory;
  /** The rails the host gives (v32/rails.ts RailsEnv) */
  rails: RailsEnv;
  log(line: string): void;
  /** The most eth_getLogs windows the lookups by id (sentById, failureOf) read in all through these deps: the Worker's
   * share of a run's subrequest budget (Task 52w), so a long lookup reads on next run and never takes the whole run from
   * the rest of the round. Absent: no limit (a hand run). */
  lookupWindows?: number;
  /** Task 65: where a re-execution reads a message's committee results when no attempt on chain carries them (Chainlink's
   * CCIP API: ccip-api.ts fetchExecutionInputs). Absent: not read. */
  executionInputs?(id: Hex): Promise<ExecutionInputsAnswer>;
}

/** A lookup by id stopped at its share of a run (V32Env.lookupWindows): it reads on next run from where it stopped. */
export class LookupShareRead extends Error {}

/** A log scan's place, kept in the memory: the last head it reached, the logs it keeps (the settle margin deep), the
 * ids of those a later scan can still read again (identified, hashed, with their block: one older than the re-read
 * window is let go of), so a re-read never takes one twice; the last settled point, every log at or below which is kept
 * (a later scan never starts past the block after it); and the lowest block whose ids `seen` still holds (a later scan
 * never starts below it, or a log there would be taken twice). The two bounds hold while the margins, counted at the
 * chain's measured block time (logs.ts marginsOf), move between runs. */
interface Cursor<T> {
  scannedTo?: bigint;
  kept: T[];
  seen: { id: Hex; block: bigint }[];
  settledTo?: bigint;
  seenFrom?: bigint;
}

interface ReadsMemory {
  /** Each chain's block time as last measured (seconds a block): the scans' margins are counted at it when this run can't
   * read it (logs.ts marginsOf; review I-1) */
  blockS?: Partial<Record<ChainName, number>>;
  queued?: Cursor<{ key: Hex; blockNumber: bigint }>;
  bounced?: Cursor<PayoutLog>;
  redeemed?: Cursor<PayoutLog>;
  cancelled?: Cursor<{ key: Hex; bouncesCarried: number; blockNumber: bigint; logIndex: number }>;
  /** Payout batches the vault has deleted (paid out or cancelled), not read again */
  deleted?: string[];
  /** The open batch's DepositRequested logs, for one batch, from the block it opened in */
  requested?: { batchId: bigint; start?: bigint; cursor: Cursor<{ payer: Address; amount: bigint }> };
  logsFailedFor?: bigint;
  cappedFor?: bigint;
  /** The front door's delivery events on Base (Task 50a): each scan's cursor, and what they say of each user */
  deliveries?: DeliveriesMemory;
  /** Task 52: the Bittensor adapter's park events, a cursor each */
  parks?: Partial<Record<ParkLog["kind"], Cursor<ParkLog>>>;
  /** R4 (D-M2): the park events of each Bittensor adapter a later pair added, by lowercase address, as `parks` */
  parksAt?: Record<string, Partial<Record<ParkLog["kind"], Cursor<ParkLog>>>>;
  /** Task 52: Cascade's own sends, by source chain (each adapter's Sent) */
  sent?: Partial<Record<ChainName, Cursor<CascadeSent & { ours: boolean }>>>;
  /** R4 (D-M2): the sends of each adapter a later pair added, by lowercase address, as `sent` */
  sentAt?: Record<string, Cursor<CascadeSent & { ours: boolean }>>;
  /** Task 52: the Bittensor adapter's remoteChainId(), immutable */
  remoteChainId?: bigint;
  /** R4: each later pair's Bittensor adapter's remoteChainId(), by lowercase address */
  remoteChainIds?: Record<string, string>;
  /** R4-O (gone since merge 7b, which reads the adapter's parkedDeliveryGas live): the gas figures it read once, deleted
   * from a memory that still holds them */
  parkGas?: Record<string, string>;
  /** Task 52: the sends kept whatever their age (pinSent), lowercase ids */
  sentPinned?: string[];
  /** Task 52 fix round 1 (review I1): the open parks' sends, kept whatever their age (pinParkSends), lowercase ids */
  sentPinnedParks?: string[];
  /** Task 52 fix round 1: the lookups by id (sentById, failureOf), each its range, how far it read, what it found, or when
   * it found none (tried again after LOOKUP_RETRY_MS) */
  lookups?: Record<string, { from: bigint; to: bigint; scannedTo?: bigint; found?: unknown; noneAt?: number }>;
  /** Task 52w (the re-review's N3): ForeverMoney's MIGRATION_DELAY(), seconds, read once a notice (let go of when it
   * ends); null: it can't be read (the AlphaVault has no such getter), so 7 days */
  migrationDelay?: number | null;
  /** R4-O round 3: each later pair's Bittensor adapter's alphaVault(), immutable, by lowercase address */
  alphaVaults?: Record<string, string>;
}

/** One of the door's delivery events, as the candidates keep it: whose, where in the chain ("block:logIndex", padded so
 * the text sorts as the chain does), and for a DeliverySet whether it set a preference (a non-zero floor). */
interface CreditLog {
  user: Address;
  pos: string;
  on?: boolean;
}

/** What the door's events say of one user: their credits since their last delivery or claim (positions, oldest first),
 * that last one's position, and their last DeliverySet. Folded from settled logs only; a position compared, never an
 * order of arrival, so the scans may settle in any order. */
interface UserCredit {
  user: Address;
  credits: string[];
  cleared?: string;
  pref?: { at: string; on: boolean };
}

interface DeliveriesMemory {
  credited?: Cursor<CreditLog>;
  delivered?: Cursor<CreditLog>;
  claimed?: Cursor<CreditLog>;
  prefs?: Cursor<CreditLog>;
  users?: Record<string, UserCredit>;
}

const posOf = (l: { blockNumber: bigint; logIndex: number }) => `${l.blockNumber.toString().padStart(20, "0")}:${String(l.logIndex).padStart(6, "0")}`;
const blockOf = (pos: string) => BigInt(pos.split(":")[0]);

/** One event folded into `users` (see UserCredit). */
function fold(users: Record<string, UserCredit>, kind: "credit" | "clear" | "pref", l: CreditLog) {
  const k = l.user.toLowerCase();
  const u = (users[k] ??= { user: l.user, credits: [] });
  if (kind === "credit") {
    if ((u.cleared === undefined || l.pos > u.cleared) && !u.credits.includes(l.pos)) {
      u.credits.push(l.pos);
      u.credits.sort();
    }
  } else if (kind === "clear") {
    if (u.cleared === undefined || l.pos > u.cleared) {
      u.cleared = l.pos;
      u.credits = u.credits.filter((c) => c > l.pos);
    }
  } else if (u.pref === undefined || l.pos > u.pref.at) u.pref = { at: l.pos, on: l.on === true };
}

const ED_RESERVE = 10n ** 12n;
/** The vault's DoorState (CascadeTypes.sol): what lens.doorState answers */
const DOOR_STATES = ["Unknown", "Active", "Removed"];
const DOOR_ACTIVE = 1;
const RAO = 10n ** 9n;
const E18 = 10n ** 18n;
const EXECUTION_STATES = ["UNTOUCHED", "IN_PROGRESS", "SUCCESS", "FAILURE"];
/** The staker's RouterKind.UniswapV3: the only route kind QuoterV2 can price. */
const UNISWAP_V3 = 0;
/** As keeper/state.ts: the most eth_getLogs queries the first look at a batch's deposits makes on Base. */
const REQUESTED_MAX_QUERIES = 72n;
const sub0 = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** R9 (L-3): the gas the vault gives a bridge's rail view (CascadeVault.sol RAIL_VIEW_GAS): its _payoutsOpen reads
 * canSendPayouts() by a staticcall capped at this. */
export const RAIL_VIEW_GAS = 150_000n;
/** canSendPayouts()'s calldata. */
const CAN_SEND_PAYOUTS = encodeFunctionData({ abi: RAIL_VIEWS, functionName: "canSendPayouts" });
/** R9 (L-3): the gas of the keeper's eth_call of the view: RAIL_VIEW_GAS for the view, as the vault's staticcall gives
 * it, plus what the call itself takes first, its intrinsic gas (21,000, and 4 a zero byte of its calldata, 16 another). */
export const RAIL_VIEW_CALL_GAS = (() => {
  let gas = RAIL_VIEW_GAS + 21_000n;
  for (let i = 2; i < CAN_SEND_PAYOUTS.length; i += 2) gas += CAN_SEND_PAYOUTS.slice(i, i + 2) === "00" ? 4n : 16n;
  return gas;
})();

/** The open batch's limits as CascadeFrontDoor.canClose judges them, without its clock (R7, L3: the contracts round's
 * rule, which this mirrors exactly; the controller holds it to the source on the merge): its deposit list at half its
 * limit (build B's list half rule, 2 x deposits >= maxDeposits: with the cancel cooldown no address can hold a list
 * there, since reaching the limit from at most half takes entries under a minute old, which can't be cancelled before
 * the keeper's next round), its redeem list full, or, only while it holds deposits (totalDeposits above 0), its value or the deposit cap's room: at half the batch
 * limit (2 × totalDeposits ≥ maxBatchValue), no room for a minimum deposit (totalDeposits + minDeposit > maxBatchValue),
 * half the cap's room (netForwarded + 2 × totalDeposits ≥ depositCap), or no room under the cap for a minimum deposit
 * (netForwarded + totalDeposits + minDeposit > depositCap). A batch of unstakes alone waits for its interval, even with
 * the cap full. */
export function doorLimitsFull(
  b: { deposits: number; redeems: number; totalDeposits: bigint },
  l: { maxDeposits: number; maxRedeems: number; maxBatchValue: bigint; minDeposit: bigint; depositCap: bigint; netForwarded: bigint },
): boolean {
  if (2 * b.deposits >= l.maxDeposits || b.redeems >= l.maxRedeems) return true;
  if (b.totalDeposits === 0n) return false;
  const t = b.totalDeposits;
  return 2n * t >= l.maxBatchValue || t + l.minDeposit > l.maxBatchValue || l.netForwarded + 2n * t >= l.depositCap || l.netForwarded + t + l.minDeposit > l.depositCap;
}

/** How many deposit entries make doorLimitsFull's list clause hold (build B's list half rule, 2 x deposits >= maxDeposits):
 * half the limit, rounded up (25 of 50, 25 of 49). */
export const listHalf = (maxDeposits: number): number => Math.ceil(maxDeposits / 2);

/** R12b (the cooldown review), R12d (L-1): the minValue of the keeper's close of a batch full by its limits, read before
 * its interval or after it (a close read before the interval can land after it, where canClose() is true by time and the
 * door no longer guards the line): the least total of deposits at which a clause of doorLimitsFull that held at the read
 * still holds, so a cancel of a rao from an aged entry (a partial cancel moves no clock) between the read and the send no
 * longer voids the close (BatchTooSmall), while one that takes the batch under every line that held still does, and the
 * keeper reads it again and holds it for its fees. By clause:
 * - the deposit list at half its limit: the least its entries carry, listHalf(maxDeposits) × minDeposit (1 TAO for 25 at
 *   the launch's 0.04), so a partial cancel can't void the close but a mass cancel of whole entries can: a list cancelled
 *   down to one entry no longer closes as "full" at the keeper's cost (R12d, L-1: before it this clause named 0);
 * - the redeem list full: 0 (each request paid its fee into the pot, which pays the close);
 * - the value and cap-room clauses, only while the batch holds deposits: the least total at which each still holds, at
 *   least 1 wei.
 * The least over the clauses that held, never above the total read. Undefined when no clause holds: the close is the fee
 * rule's, and names feeCloseFloor (R12g; before it the exact total) or 0 when the pot covers its quote (R12h), or the max
 * wait's, which names 0 (R12c). Every value clause grows with the total, so no clause that didn't hold at the read can hold
 * below it. */
export function fullCloseFloor(
  b: { deposits: number; redeems: number; totalDeposits: bigint },
  l: { maxDeposits: number; maxRedeems: number; maxBatchValue: bigint; minDeposit: bigint; depositCap: bigint; netForwarded: bigint },
): bigint | undefined {
  if (!doorLimitsFull(b, l)) return undefined;
  if (b.redeems >= l.maxRedeems) return 0n;
  const t = b.totalDeposits;
  const atLeastOne = (x: bigint) => (x < 1n ? 1n : x);
  const half = (x: bigint) => (x <= 0n ? 0n : (x + 1n) / 2n);
  const capRoom = l.depositCap - l.netForwarded;
  const floors: bigint[] = [];
  if (2 * b.deposits >= l.maxDeposits) floors.push(BigInt(listHalf(l.maxDeposits)) * l.minDeposit);
  if (t > 0n) {
    if (2n * t >= l.maxBatchValue) floors.push(atLeastOne(half(l.maxBatchValue)));
    if (t + l.minDeposit > l.maxBatchValue) floors.push(atLeastOne(l.maxBatchValue - l.minDeposit + 1n));
    if (l.netForwarded + 2n * t >= l.depositCap) floors.push(atLeastOne(half(capRoom)));
    if (l.netForwarded + t + l.minDeposit > l.depositCap) floors.push(atLeastOne(capRoom - l.minDeposit + 1n));
  }
  const least = floors.reduce((a, x) => (x < a ? x : a));
  return least > t ? t : least;
}

/** R12g (the keeper review of R12e-R12f, finding 2): the minValue of the keeper's close of a batch the fee rule closes (its
 * fees cover its bridge fee, before its max wait, not full by its limits): the total read less one minimum deposit, at
 * least 0. The rule weighs the batch's fees (due.ts closeEconomicsOf: a deposit fee for each of the staker's deposits, the
 * swap fee on their TAO, the pot) against the close's bridge fee, not the batch's size, and a cancel can't undo what it
 * relied on: the staker took the deposit and swap fees in USDC at the stake, so a cancel refunds none of them; a deposit's
 * cancel never touches the pot; and the bridge fee of a smaller batch (an entry fewer, a smaller amount) is never higher.
 * Only the estimate's own bound moves, its swap fee counted on at most the total, by at most one minimum deposit's swap fee
 * (0.00006 TAO's worth at the 0.04 TAO minimum and the launch's 15 bps; 0.0002 at the staker's 50 bps ceiling). Before R12g the close named the exact total, so a holder's
 * 1-rao cancel landing just before it (a higher tip) voided each close, BatchTooSmall, a wait the breaker counted: three in
 * a row tripped it, and every fee-rule batch then waited for its max wait (24 hours) plus the back-off. A cancel-down of more
 * than one minimum deposit still voids it (the canceller's own aged capital, five minutes old at least, each time), and the
 * next round's fee rule decides again on what is left. */
export const feeCloseFloor = (total: bigint, minDeposit: bigint): bigint => (total > minDeposit ? total - minDeposit : 0n);

/** The v3.2 keeper's deps (KeeperDepsV32) for one round, from `env`. */
export function depsV32(env: V32Env): KeeperDepsV32 {
  const d = env.deployment;
  const a = d.addresses;
  const signer = env.signer.address;
  const ctx: LogsCtx = { rpc: env.rpc, logs: env.logs, logsWindow: env.logsWindow };
  const mem = (env.memory.reads.v32 ??= {}) as ReadsMemory;
  /** The lookups' windows left through these deps (V32Env.lookupWindows; undefined: no limit) */
  let lookupLeft = env.lookupWindows;
  /** The veto's answer and the delivery route this round (never kept in the memory) */
  let vetoCache: { tick: number; at: number; result: string | undefined } | undefined;
  /** The rails' latest answer (railsSeen), for the send path */
  let lastRails: { rails: Rails; tick: number; at: number } | undefined;
  let routeCache: { tick: number; at: number; route: { routeId: number; sellPath?: Hex; feeBps: number } } | undefined;
  /** What a mined call sent back of its value (the spend cap counts the rest): a close's fee float less the bridge fee
   * its closer paid (BatchClosed: fee - potUsed), or all of it when the batch was empty after all (BatchRolled). */
  function returnedOf(req: CallRequest, logs: Sent["logs"]): bigint {
    const value = req.value ?? 0n;
    if (value === 0n || req.functionName !== "closeBatch" || req.to.toLowerCase() !== a.frontDoor.toLowerCase()) return 0n;
    for (const l of logs ?? []) {
      if (l.address.toLowerCase() !== a.frontDoor.toLowerCase()) continue;
      try {
        const e = decodeEventLog({ abi: DOOR, topics: l.topics as [Hex, ...Hex[]], data: l.data });
        if (e.eventName === "BatchRolled") return value;
        if (e.eventName === "BatchClosed") {
          const x = e.args as unknown as { fee: bigint; potUsed: bigint };
          const paid = x.fee - x.potUsed;
          return value > paid ? value - paid : 0n;
        }
      } catch {
        // another of the door's events
      }
    }
    return 0n;
  }
  /** The rails at the one send path (T50a review I2): every v3.2 send, from a round or any one-shot entry point, is
   * refused (SendRefused "rails") unless the rails allow it now: the round's own answer while it is fresh (the same
   * tick, within RAILS_FRESH_MS), else a fresh reading. Under a hold or an outage only a tagged token-park conversion
   * to the Bittensor adapter goes, and only while the migration notice runs; a delivery needs deliveries on, a payout
   * its key confirmed. */
  async function railsCheck(req: CallRequest, o: { cancel?: boolean } = {}): Promise<void> {
    const fresh = lastRails !== undefined && lastRails.tick === env.memory.tick && Date.now() - lastRails.at < RAILS_FRESH_MS;
    const rails = fresh && lastRails ? lastRails.rails : await railsV32(deps, env.memory, (env.send.now ?? Date.now)());
    // the founder's exception is only for a token park's conversion: under a stop during the notice, a tagged request is
    // checked on chain first (T50a re-review A); so is one at its chain's spend cap during the notice, which it passes too
    // (the controller's ruling for Task 52); any check that fails, or can't be read, refuses
    const asked = rails.migrationNotice === true && req.rail === "migration-conversion" && (rails.stop !== undefined || rails.capped?.has(req.chain) === true);
    const notAPark = asked ? await checkPark(req) : undefined;
    // a cancel moves nothing: no payout key, no delivery; through the cap, never through a stop
    const refusal = railsRefusal(rails, {
      chain: req.chain,
      payoutKey: !o.cancel && req.functionName === "processPayouts" ? (req.args[0] as Hex) : undefined,
      delivery: !o.cancel && req.functionName === "deliver",
      conversion: asked && notAPark === undefined,
      cancel: o.cancel === true,
    });
    if (refusal) throw new SendRefused("rails", `the rails refuse it: ${refusal}${notAPark ? ` (it is no token park's conversion: ${notAPark})` : ""}; ${req.label} not sent`);
  }

  /** Why `req` is not the conversion of a token park the exception allows, or undefined when it is, read on chain at
   * Bittensor's head block, fail closed: sent on Bittensor (T50a round-2 R2-2: a request on Base to the adapter's
   * address would be checked against Bittensor's park and sent to whatever lives there on Base); its calldata's
   * selector exactly deliverParked(address,address,bytes)'s; sent to the deployment's Bittensor adapter; its recipient
   * the vault and its sender the registered front door (a stranger's park is never ours to move); and its park, by
   * parked(key) under the adapter's own key (keccak256(abi.encode(remoteChainId, sender, recipient, message))),
   * existing, unconverted (not a native park, nor one a refused delivery converted) and not empty. */
  /** tokenParkProblem, once per request object (the send path asks it twice: the spend cap's pass, then the rails). */
  const parkChecks = new WeakMap<CallRequest, Promise<string | undefined>>();
  function checkPark(req: CallRequest): Promise<string | undefined> {
    let c = parkChecks.get(req);
    if (!c) {
      c = tokenParkProblem(req);
      parkChecks.set(req, c);
    }
    return c;
  }
  /** Whether `req` passes the spend cap (the controller's ruling for Task 52, as a cancel passes it; counted all the same:
   * its row is written ahead): a token park's conversion, tagged, while ForeverMoney's migration notice runs (read on chain
   * now; a read that fails passes nothing), its park checked on chain as the founder's exception checks it. Never the kill
   * switch or the lease (the host's, before any round), nor the rails' hold (railsCheck). */
  async function capExempt(req: CallRequest): Promise<boolean> {
    if (req.rail !== "migration-conversion") return false;
    try {
      if ((await deps.migrationNotice()) === 0n) return false;
    } catch {
      return false;
    }
    return (await checkPark(req)) === undefined;
  }
  async function tokenParkProblem(req: CallRequest): Promise<string | undefined> {
    if (req.chain !== "bittensor") return "it is not sent on Bittensor";
    let data: Hex;
    try {
      data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
    } catch {
      return "its calldata could not be encoded";
    }
    if (data.slice(0, 10).toLowerCase() !== DELIVER_PARKED_SELECTOR.toLowerCase()) return "its selector is not deliverParked(address,address,bytes)'s";
    // any pair's Bittensor adapter the deployment lists (R4, D-M2), its park read there
    const adapter = pairOfBit(d, req.to)?.bitAdapter;
    if (!adapter) return "it is not sent to the Bittensor adapter of any of the deployment's pairs";
    const [recipient, sender, message] = decodeFunctionData({ abi: PARK_CALLS, data }).args as readonly [Address, Address, Hex];
    if (recipient.toLowerCase() !== a.vault.toLowerCase()) return `its recipient ${recipient} is not the vault`;
    if (sender.toLowerCase() !== a.frontDoor.toLowerCase()) return `its sender ${sender} is not the front door`;
    let park: { key: Hex; amount: bigint; parkedAt: bigint; converted: boolean };
    try {
      const tag = numberToHex(hexToBigInt((await env.rpc.request("bittensor", "eth_blockNumber", [])) as Hex));
      const call = async (functionName: "parked" | "remoteChainId", args: readonly unknown[]) =>
        decodeFunctionResult({
          abi: PARK_READS,
          functionName,
          data: (await env.rpc.request("bittensor", "eth_call", [{ to: adapter, data: encodeFunctionData({ abi: PARK_READS, functionName, args } as never) }, tag])) as Hex,
        } as never) as unknown;
      const remote = (await call("remoteChainId", [])) as bigint;
      const key = parkKeyOf(remote, sender, recipient, message);
      const [amount, parkedAt, converted] = (await call("parked", [key])) as readonly [bigint, bigint, boolean];
      park = { key, amount, parkedAt, converted };
    } catch {
      return "its park could not be read";
    }
    const named = `${park.key.slice(0, 10)}…`;
    if (park.parkedAt === 0n) return `there is no park ${named}`;
    if (park.converted) return `park ${named} is a native or converted park`;
    if (park.amount === 0n) return `park ${named} is empty`;
    return undefined;
  }
  const sendCtx: SendCtx = {
    ...env.send,
    rpc: env.rpc,
    journal: env.journal,
    log: env.log,
    errors: ERRORS_V32,
    spendCap: d.spendCap,
    returnedOf,
    railsCheck,
    capExempt,
    settle: () => settlePending(sendCtx),
  };
  /** A node that answered with an error of its own, not a revert: says nothing about the contract. */
  const unanswered = (e: unknown) => e instanceof RpcError && !isRevert(e);
  const r = (chain: ChainName, address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => read(env.rpc, chain, { address, abi, functionName, args });
  const lens = (fn: string, args?: readonly unknown[]) => r("bittensor", a.vaultLens, VAULT_LENS, fn, args);
  const vault = (fn: string) => r("bittensor", a.vault, VAULT_KEPT, fn);
  const door = (fn: string, args?: readonly unknown[]) => r("base", a.frontDoor, DOOR, fn, args);
  const doorLens = (fn: string) => r("base", a.doorLens, DOOR_LENS, fn);
  const blockTime = async (chain: ChainName) => hexToNumber(((await env.rpc.request(chain, "eth_getBlockByNumber", ["latest", false])) as { timestamp: Hex }).timestamp);
  /** Block `block`'s time on `chain`, from its header. */
  const timeAt = async (chain: ChainName, block: bigint) => {
    const b = (await env.rpc.request(chain, "eth_getBlockByNumber", [numberToHex(block), false])) as { timestamp: Hex } | null;
    if (!b) throw new Error(`${chain === "base" ? "Base" : "Bittensor"} has no block ${block}`);
    return hexToNumber(b.timestamp);
  };

  /** One event's scan, on from its cursor in the memory (the re-read margin back from the last block scanned, logs the
   * settle margin deep kept, nearer ones read again next round: REREAD_S and SETTLE_S of the chain's blocks at its measured
   * block time, logs.ts marginsOf), each log shaped by `shape`. It never starts past the block after the last settled
   * point (a block time read slower since, after a halt, shortens the re-read below the last settle margin), nor below the
   * lowest block whose kept ids it still remembers (one read faster lengthens it past them). The cursor moves window by
   * window (logs.ts scanLogsInParts): a scan stopped part way (the Worker's read deadline, a budget, a node's error, an
   * answer that doesn't decode) keeps the logs of the windows it read in full and moves the cursor to the end of the last
   * of them, never back, then throws what stopped it, so the round fails soft, the host saves the memory, and the next run
   * reads on from there, every id it keeps from the re-read seen, so no block is skipped and no log taken twice. */
  function scan<T>(state: Cursor<T>, chain: ChainName, address: Address, ev: AbiEvent, shape: (l: ScannedLog) => T, topics: (Hex | null)[] = []) {
    return async (first: (head: bigint) => bigint | Promise<bigint>): Promise<{ logs: T[]; head: bigint; settle: bigint }> => {
      const head = hexToBigInt((await logsOf(ctx).request(chain, "eth_blockNumber", [])) as Hex);
      const earliest = await first(head);
      const { reread, settle } = await marginsOf(env.rpc, chain, (mem.blockS ??= {}));
      // a cursor saved before the margins were time has no seenFrom or settledTo: the ids it kept reach back the old re-read
      // in blocks (logs.ts REREAD), and no further (review M-1), and it kept every log its old settle depth below its last
      // head (logs.ts SETTLE), no nearer one (review Minor 2), so a re-read shorter than that depth still starts at or
      // before the first log it only returned; at or above the seed, so none is taken twice
      if (state.scannedTo !== undefined && state.seenFrom === undefined) {
        state.seenFrom = state.scannedTo + 1n - REREAD[chain];
        state.settledTo ??= state.scannedTo - SETTLE[chain];
      }
      let back = earliest;
      if (state.scannedTo !== undefined) {
        back = state.scannedTo + 1n - reread;
        if (state.settledTo !== undefined && state.settledTo + 1n < back) back = state.settledTo + 1n;
        if (state.seenFrom !== undefined && back < state.seenFrom) back = state.seenFrom;
      }
      const from = back > earliest ? back : earliest;
      const seen = new Set(state.seen.map((x) => x.id));
      const fresh: T[] = [];
      let reached = head;
      let stopped: { error: unknown } | undefined;
      if (from <= head) {
        const part = await scanLogsInParts(ctx, chain, address, ev, from, topics, head);
        reached = part.scannedTo;
        stopped = part.stopped;
        for (const [what, l] of identified(part.logs)) {
          const id = keccak256(stringToHex(what));
          if (seen.has(id)) continue;
          // settled by the chain's head, not by where the scan stopped: a nearer log is read again next round
          if (l.blockNumber + settle <= head) {
            seen.add(id);
            state.seen.push({ id, block: l.blockNumber });
            state.kept.push(shape(l));
          } else fresh.push(shape(l));
        }
      }
      // the last block scanned in full; never back (a scan that read no window, or less than the re-read of new ones)
      if (!stopped || (reached >= from && (state.scannedTo === undefined || reached > state.scannedTo))) state.scannedTo = reached;
      // every log at or below the settled point is kept: the windows read from `from` (at or before the block after the last
      // settled point) to `reached`, as deep as the head's settle margin; never back
      if (from <= reached) {
        const settledNow = reached < head - settle ? reached : head - settle;
        if (state.settledTo === undefined || settledNow > state.settledTo) state.settledTo = settledNow;
      }
      // where the next scan starts at these margins, at most: an id below that is let go of, and no later scan reads below
      // it (seenFrom), whatever its margins then
      const to = state.scannedTo;
      if (to !== undefined) {
        let next = to + 1n - reread;
        if (state.settledTo !== undefined && state.settledTo + 1n < next) next = state.settledTo + 1n;
        if (state.seenFrom === undefined || next > state.seenFrom) state.seenFrom = next;
        const keepFrom = state.seenFrom;
        state.seen = state.seen.filter((x) => x.block >= keepFrom);
      }
      if (stopped) throw stopped.error;
      return { logs: [...state.kept, ...fresh], head, settle };
    };
  }
  function cursor<T>(name: "queued" | "bounced" | "redeemed" | "cancelled"): Cursor<T> {
    const m = mem as Record<string, Cursor<unknown> | undefined>;
    return (m[name] ??= { kept: [], seen: [] }) as Cursor<T>;
  }
  const vaultEvent = (name: string) => event(VAULT_ABI_V32, name);
  const fromStart = () => d.startBlocks.bittensor;
  /** A payout scan's logs less those of batches the vault has deleted, let go of from its cursor too: a scan from the
   * deploy block (a rescan, rescanPayoutLogs) reads a deleted batch's logs again, and only open batches' are kept
   * (design §4). */
  const openOnly =
    <T extends { key: Hex }>(name: "queued" | "bounced" | "redeemed" | "cancelled") =>
    (got: { logs: T[]; head: bigint }): { logs: T[]; head: bigint } => {
      const deleted = new Set(mem.deleted ?? []);
      if (!deleted.size) return got;
      const live = (l: T) => !deleted.has(l.key.toLowerCase());
      const c = cursor<T>(name);
      c.kept = c.kept.filter(live);
      return { logs: got.logs.filter(live), head: got.head };
    };
  const payoutLog = (kind: PayoutLog["kind"]) => (l: { args: Record<string, unknown>; blockNumber: bigint; logIndex: number }): PayoutLog => ({
    kind,
    key: (l.args.key as Hex).toLowerCase() as Hex,
    user: l.args.user as Address,
    shares: kind === "bounced" ? 0n : (l.args.shares as bigint),
    assets: l.args.assets as bigint,
    blockNumber: l.blockNumber,
    logIndex: l.logIndex,
  });
  const queuedLogs = () =>
    scan(cursor<{ key: Hex; blockNumber: bigint }>("queued"), "bittensor", a.vault, vaultEvent("PayoutBatchQueued"), (l) => ({ key: l.args.key as Hex, blockNumber: l.blockNumber }))(fromStart).then(
      openOnly<{ key: Hex; blockNumber: bigint }>("queued"),
    );
  const bouncedLogs = () => scan(cursor<PayoutLog>("bounced"), "bittensor", a.vault, vaultEvent("DepositBounced"), payoutLog("bounced"))(fromStart).then(openOnly<PayoutLog>("bounced"));
  const redeemedLogs = () => scan(cursor<PayoutLog>("redeemed"), "bittensor", a.vault, vaultEvent("Redeemed"), payoutLog("redeemed"))(fromStart).then(openOnly<PayoutLog>("redeemed"));
  type Cancelled = { key: Hex; bouncesCarried: number; blockNumber: bigint; logIndex: number };
  const cancelledLogs = () =>
    scan(cursor<Cancelled>("cancelled"), "bittensor", a.vault, vaultEvent("PayoutBatchCancelled"), (l) => ({
      key: (l.args.key as Hex).toLowerCase() as Hex,
      bouncesCarried: Number(l.args.bouncesCarried),
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
    }))(fromStart).then(openOnly<Cancelled>("cancelled"));
  /** A batch taken for deleted: its logs are let go of (only open batches' are kept, design §4). */
  function forget(key: string) {
    // its queue log is let go of below, so a later scan never brings it back: the last 200 are plenty
    mem.deleted = [...(mem.deleted ?? []), key].slice(-200);
    for (const c of [mem.queued, mem.bounced, mem.redeemed, mem.cancelled] as (Cursor<{ key: Hex }> | undefined)[]) {
      if (c) c.kept = c.kept.filter((l) => l.key.toLowerCase() !== key);
    }
  }

  async function closeFeeWei(deposits: readonly Entry[], redeems: readonly Entry[]): Promise<bigint> {
    const bridge = (await doorLens("primaryBridge")) as Address;
    const total = deposits.reduce((t, e) => t + e.amount, 0n);
    return (await r("base", bridge, ADAPTER, "quoteFee", [BigInt(d.chainIds.bittensor), a.vault, encodeBatch(1n, deposits, redeems), total])) as bigint;
  }

  /** The open batch's deposits the staker made (keeper/state.ts stakerDeposits, its cursor in the memory). */
  async function stakerDeposits(batchId: bigint, openStart: number, staker: Address): Promise<{ count: number; tao: bigint }> {
    if (mem.requested?.batchId !== batchId) mem.requested = { batchId, cursor: { kept: [], seen: [] } };
    const q = mem.requested;
    const maxBack = REQUESTED_MAX_QUERIES * windowOf(ctx, "base");
    const { logs } = await scan(q.cursor, "base", a.frontDoor, event(DOOR, "DepositRequested"), (l) => ({ payer: l.args.payer as Address, amount: l.args.amount as bigint }), [
      numberToHex(batchId, { size: 32 }),
    ])(async (head) => {
      if (q.start === undefined) {
        const headTime = hexToNumber(((await logsOf(ctx).request("base", "eth_getBlockByNumber", [numberToHex(head), false])) as { timestamp: Hex }).timestamp);
        q.start = await blockAtOrAfter(logsOf(ctx), "base", openStart, head, headTime);
      }
      const floor = head > maxBack ? head - maxBack : 0n;
      if (q.start < floor && mem.cappedFor !== batchId) {
        mem.cappedFor = batchId;
        env.log(
          `Base logs: batch ${batchId} opened at block ${q.start}, ${head - q.start} blocks back, further than the ${maxBack} blocks the logs window allows in ${REQUESTED_MAX_QUERIES} queries: its deposits before block ${floor} are not counted, so it may wait for its max wait instead of closing when its fees cover the bridge fee.`,
        );
      }
      return q.start > floor ? q.start : floor;
    });
    const staked = logs.filter((l) => l.payer.toLowerCase() === staker.toLowerCase());
    return { count: staked.length, tao: staked.reduce((t, l) => t + l.amount, 0n) };
  }

  /** keeper/state.ts closeEconomics on v3.2: null when a price or the fee can't be read (the batch then waits for its
   * max wait, never closing early on a guess). */
  async function closeEconomics(batch: { id: bigint; openStart: number; totalDeposits: bigint; feePot: bigint }, deposits: readonly Entry[], redeems: readonly Entry[]): Promise<CloseEconomics | null> {
    try {
      const oracle = (await door("oracle")) as Address;
      const staker = (await door("swapper")) as Address;
      const taoPriceUsdc = (await r("base", oracle, ORACLE_ABI, "usdcValue", [E18])) as bigint;
      const depositFeeUsdc = (await r("base", staker, STAKER, "depositFeeUsdc")) as bigint;
      const swapFeeBps = Number(await r("base", staker, STAKER, "swapFeeBps"));
      const [ethPriceUsdc] = (await r("base", d.quoterV2, QUOTER, "quoteExactInput", [d.ethUsdcPath, E18])) as readonly [bigint];
      const bridgeFeeWei = await closeFeeWei(deposits, redeems);
      if (taoPriceUsdc === 0n || ethPriceUsdc === 0n || bridgeFeeWei === 0n) return null;
      let staked: { count: number; tao: bigint };
      try {
        staked = await stakerDeposits(batch.id, batch.openStart, staker);
        mem.logsFailedFor = undefined;
      } catch (e) {
        if (mem.logsFailedFor !== batch.id) {
          mem.logsFailedFor = batch.id;
          env.log(
            `Base logs: couldn't read batch ${batch.id}'s deposits (${(e as Error).message.split("\n")[0]}), so its deposit fees are unknown and it waits for its max wait (${d.batchMaxWaitS / 3600} hours) instead of closing when they cover its bridge fee.`,
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

  async function messageState(m: { id: Hex; direction: "Base → Bittensor" | "Bittensor → Base" }): Promise<string> {
    const dst: ChainName = m.direction === "Base → Bittensor" ? "bittensor" : "base";
    const state = Number(await r(dst, d.offRamps[dst], OFFRAMP, "getExecutionState", [m.id]));
    return EXECUTION_STATES[state] ?? String(state);
  }

  const deps: KeeperDepsV32 = {
    deployment: d,
    async readState(opts = {}) {
      const deposits = (await door("openDeposits")) as Entry[];
      const redeems = (await door("openRedeems")) as Entry[];
      const canClose = (await door("canClose")) as boolean;
      const fdPaused = (await door("paused")) as boolean;
      const [id, start, totalDeposits, feePot] = (await door("openBatch")) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
      const batchInterval = Number(await door("batchInterval"));
      // R12h: the header's number too (no read more): where a close sent on this read, reverted with no reason its replay
      // can read, starts reading the batch's cancels (actions.ts minedClose)
      const baseHead = (await env.rpc.request("base", "eth_getBlockByNumber", ["latest", false])) as { number?: Hex; timestamp: Hex };
      const baseNow = hexToNumber(baseHead.timestamp);
      const readBlock = typeof baseHead.number === "string" ? hexToBigInt(baseHead.number) : undefined;
      const openStart = Number(start);
      const entries = deposits.length + redeems.length > 0;
      const undecided = entries && canClose && !closesWithoutFees({ closeMaxWaitS: d.batchMaxWaitS, frontDoor: { full: false, openStart, batchInterval, now: baseNow } });
      // full: one of the door's limits is reached, so the keeper closes it at once whatever its fees. Before its interval
      // that is the door's own canClose() (R6b, U4: since the room rule a batch at half its limits, or with no room left
      // for a minimum deposit, is closable at once; the web's batch-clock.ts isFull reads it the same way). After its
      // interval canClose() is true by time alone, so the limits are read and judged as CascadeFrontDoor.canClose judges
      // them (doorLimitsFull).
      const beforeInterval = baseNow < openStart + batchInterval;
      let full = undecided && beforeInterval;
      // R12b (the cooldown review), R12d (L-1): the minValue of a close of a batch full by its limits, so a holder's 1-rao
      // cancel of an aged entry between the read and the send doesn't void it (BatchTooSmall), while a cancel-down under
      // every line that held does: the least total still full (fullCloseFloor), read whatever the interval. Before R12d a
      // read before the interval named 0, trusting canClose() to guard the line, but a close read just before the interval
      // ends can land after it, closable by time, so a value-full batch cancelled down to two entries went as one at the
      // keeper's cost. Before the interval canClose() says whether it is full; a floor its limits don't give (a mirror the
      // door disagrees with) leaves the exact total (closeV32). After it the limits as the door judges them say it. R12c: at
      // the max wait the close names 0 whatever the batch (due.ts atMaxWait), so the limits are read only while the close
      // rule needs them (undecided), as a round's read always did.
      let fullFloor: bigint | undefined;
      // R12g: a batch not full there is closed by the fee rule (or by hand): the total less one minimum deposit
      let feeFloor: bigint | undefined;
      if (undecided) {
        const b = { deposits: deposits.length, redeems: redeems.length, totalDeposits };
        const l = {
          maxDeposits: Number(await door("maxDeposits")),
          maxRedeems: Number(await door("maxRedeems")),
          maxBatchValue: (await door("maxBatchValue")) as bigint,
          minDeposit: (await door("minDeposit")) as bigint,
          depositCap: (await door("depositCap")) as bigint,
          netForwarded: (await door("netForwarded")) as bigint,
        };
        fullFloor = fullCloseFloor(b, l);
        if (!beforeInterval) full = fullFloor !== undefined;
        if (!full) feeFloor = feeCloseFloor(totalDeposits, l.minDeposit);
      }
      const frontDoor: State["frontDoor"] = {
        canClose,
        nDeposits: deposits.length,
        nRedeems: redeems.length,
        paused: fdPaused,
        // a pause never stops a close on v3.2 (I-20; Task 58 c4, the web's sendGate)
        closesWhilePaused: true,
        openStart,
        batchInterval,
        full,
        now: baseNow,
      };
      if (opts.economics && undecided && !full) frontDoor.closeEconomics = await closeEconomics({ id, openStart, totalDeposits, feePot }, deposits, redeems);

      // AlphaVault's three (Task 52 keeps them: the notice decides the park job's conversions and its one close), read at
      // the AlphaVault of the rail now primary on each chain (R4-O round 3): the deploy's until a switch, the replacement
      // pair's after one, so closes, rolls and payouts resume on the new rail once ForeverMoney's migration is done
      const primary = { base: (await doorLens("primaryBridge")) as Address, bittensor: (await lens("primaryBridge")) as Address };
      // R7 (L4): read only while the open batch holds redeem requests: why the vault's payouts are closed now, so it would
      // defer each (RedeemDeferred); what that holds of the batch on Base is due.ts payoutsHold's (decideNext, closeV32)
      const payoutsClosed = redeems.length > 0 ? await payoutsClosedOf(primary.bittensor) : undefined;
      const { alpha, noticeVault } = await alphaAt(await railVaults(primary));
      const healthy = !alpha.paused && alpha.migrationReadyAt === 0n && !alpha.migrationFinished;
      // while the notice runs: its length, read once a notice (the re-review's N3); let go of when it ends (Task 52w fix M5)
      if (alpha.migrationReadyAt === 0n) mem.migrationDelay = undefined;
      const migrationDelayS = alpha.migrationReadyAt !== 0n ? await migrationDelay(noticeVault) : undefined;
      const pending = (await lens("pendingPayouts")) as bigint;
      const balance = await balanceOf(env.rpc, "bittensor", a.vault);
      const payoutDelay = Number(await lens("payoutDelay"));
      const { logs: queued, head } = await queuedLogs();
      const deleted = new Set(mem.deleted ?? []);
      const batches: State["vault"]["batches"] = [];
      for (const q of queued) {
        const key = q.key.toLowerCase();
        if (deleted.has(key)) continue;
        let b = (await lens("getPayoutBatch", [q.key])) as { queuedAt: bigint; cursor: number; count: number };
        if (b.count === 0 && q.blockNumber + (await marginsOf(env.rpc, "bittensor", (mem.blockS ??= {}))).reread <= head) {
          // R4 (B-L2): read empty at the latest block of a node that may be behind the one that served the logs, so read
          // again at the scan's head (at or past the queue log's block) before it is forgotten for good: a node that
          // hasn't that block answers an error, and the batch is neither forgotten nor listed this round
          let pinned: typeof b | undefined;
          try {
            pinned = (await read(env.rpc, "bittensor", { address: a.vaultLens, abi: VAULT_LENS, functionName: "getPayoutBatch", args: [q.key] }, head)) as typeof b;
          } catch {
            pinned = undefined;
          }
          if (!pinned) continue;
          if (pinned.count === 0) {
            deleted.add(key);
            forget(key);
            continue;
          }
          b = pinned;
        }
        if (b.count > 0) batches.push({ key: q.key, queuedAt: Number(b.queuedAt), cursor: b.cursor, count: b.count });
      }
      const now = await blockTime("bittensor");
      const visible = (await lens("visibleStakeRao")) as bigint;
      const booked = (await lens("bookedStake")) as bigint;
      const bps = BigInt((await lens("idleBufferBps")) as number);
      const buffer = bps === 0n ? 0n : ((share: bigint, floor: bigint) => (share > floor ? share : floor))(booked * bps * (RAO / 10_000n), (await lens("minDailyOutflow")) as bigint);
      const available = sub0(sub0(sub0(balance, ED_RESERVE), pending), buffer);
      const rootStake = visible * RAO;
      const solvency: VaultSolvency = {
        grossAssets: (await lens("grossAssets")) as bigint,
        pendingPayouts: pending,
        unvestedRewards: (await lens("unvestedRewards")) as bigint,
        totalAssets: (await lens("totalAssets")) as bigint,
        totalSupply: (await vault("totalSupply")) as bigint,
      };
      const stakeMissing = (await lens("stakeMissing")) as boolean;
      const vaultPaused = (await vault("paused")) as boolean;
      // the launch door's state on the vault (CascadeFormulas.peerId: keccak256(abi.encode(uint64 chain, address door))):
      // while it isn't Active, or the vault is paused, a batch delivered parks on Bittensor (Task 52w; T57c m2)
      const doorState = Number(await lens("doorState", [keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [d.launchChain, a.frontDoor]))]));
      // or while some of its stake is not on a listed hotkey (onBridgeMessage reverts StakeMissing: the batch parks; Task
      // 52w fix, Concern 5): an incident state that stays until the owner or the guardian acts
      const vaultRefuses = vaultPaused
        ? "the vault is paused"
        : doorState !== DOOR_ACTIVE
          ? `the vault no longer takes the front door's batches (its door reads ${DOOR_STATES[doorState] ?? String(doorState)} there)`
          : stakeMissing
            ? "some of the vault's stake is not on a listed hotkey (stake missing)"
            : undefined;
      const detail: StatusDetail = {
        openDeposits: [...deposits],
        openRedeems: [...redeems],
        canClose,
        depositCap: (await door("depositCap")) as bigint,
        vaultAssets: solvency.totalAssets,
        rootStake,
        pendingPayouts: pending,
        batches,
        payoutDelay,
        claimable: [{ user: signer, amount: (await door("claimable", [signer])) as bigint }],
        balances: { tao: await balanceOf(env.rpc, "bittensor", signer), eth: await balanceOf(env.rpc, "base", signer) },
        messages: [],
      };
      return {
        now,
        frontDoor,
        closeMaxWaitS: d.batchMaxWaitS,
        alphaVault: { healthy },
        ...(vaultRefuses ? { vaultRefuses } : {}),
        ...(payoutsClosed ? { payoutsClosed } : {}),
        vault: {
          paused: vaultPaused,
          available,
          minStakeWei: ((await lens("minStakeRao")) as bigint) * RAO,
          rootStake,
          nominatorMinWei: ((await lens("minRemainRao")) as bigint) * RAO,
          batches,
          payoutDelay,
          stakeMissing,
        },
        detail,
        v32: {
          openId: id,
          openTotal: totalDeposits,
          ...(fullFloor !== undefined ? { fullFloor } : {}),
          ...(feeFloor !== undefined ? { feeFloor } : {}),
          ...(readBlock !== undefined ? { readBlock } : {}),
          feePot,
          vault: { ...solvency, stakeMissing, hotkeyCount: Number(await lens("hotkeyCount")) },
          primary,
          alpha: { ...alpha, ...(migrationDelayS !== undefined ? { migrationDelayS } : {}) },
        },
      };
    },
    sendCall: (req) => sendRaw(sendCtx, env.signer, req),
    signer,
    signerCode: (chain) => codeAt(env.rpc, chain, signer),
    nonce: (chain) => nonceOf(env.rpc, chain, signer),
    minedNonce: async (chain) => hexToNumber((await env.rpc.request(chain, "eth_getTransactionCount", [signer, "latest"])) as Hex),
    quoteClose: (s) => closeFeeWei(s.detail.openDeposits, s.detail.openRedeems),
    async payoutLogs() {
      const { logs: bounced } = await bouncedLogs();
      const { logs: redeemed } = await redeemedLogs();
      return [...bounced, ...redeemed];
    },
    async cancelsIn(batchId, fromIn, to) {
      // the logs server may trail the node that gave the receipt by a block or two: one more look, a moment later
      const headOf = async () => hexToBigInt((await logsOf(ctx).request("base", "eth_blockNumber", [])) as Hex);
      let head = await headOf();
      if (head < to) {
        await (env.send.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))))(CANCELS_LAG_MS);
        head = await headOf();
      }
      if (head < to) throw new Error(`the Base logs server is at block ${head}, behind block ${to}`);
      const span = BigInt(CANCELS_WINDOWS) * windowOf(ctx, "base");
      const lowest = to + 1n > span ? to + 1n - span : 0n;
      const from = fromIn > to ? to : fromIn < lowest ? lowest : fromIn;
      const part = await scanLogsInParts(ctx, "base", a.frontDoor, event(DOOR, "DepositCancelled"), from, [numberToHex(batchId, { size: 32 })], to);
      if (part.stopped) throw part.stopped.error;
      return part.logs
        .filter((l) => (l.args.batchId as bigint) === batchId)
        .map((l) => ({ block: l.blockNumber, user: l.args.user as Address, amount: l.args.amount as bigint }));
    },
    async cancelOf(key) {
      const { logs } = await cancelledLogs();
      const mine = logs.filter((l) => l.key === key.toLowerCase()).sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
      const last = mine.at(-1);
      return last ? { bouncesCarried: last.bouncesCarried } : undefined;
    },
    async batchInfo(key) {
      const b = (await lens("getPayoutBatch", [key])) as { payoutsHash: Hex; count: number };
      return { payoutsHash: b.payoutsHash, count: b.count };
    },
    rescanPayoutLogs() {
      // new cursors: the next scans read the vault's payout events again in full, from the deploy block
      mem.queued = undefined;
      mem.bounced = undefined;
      mem.redeemed = undefined;
      mem.cancelled = undefined;
    },
    async readPayoutInputs(key) {
      const b = (await lens("getPayoutBatch", [key])) as PayoutInputs["batch"];
      return {
        batch: b,
        pendingPayouts: (await lens("pendingPayouts")) as bigint,
        balance: await balanceOf(env.rpc, "bittensor", a.vault),
        maxFeeBps: (await lens("maxFeeBps")) as bigint,
        maxFeeAbs: (await lens("maxFeeAbs")) as bigint,
        minChunk: Number(await lens("minChunk")),
        maxMessageValue: (await lens("maxMessageValue")) as bigint,
        visibleStakeRao: (await lens("visibleStakeRao")) as bigint,
        hotkeyCount: Number(await lens("hotkeyCount")),
        unstakeGas: (await lens("unstakeGas")) as bigint,
      };
    },
    async quotePayout(sourceChain, frontDoor, message, sum) {
      const bridge = (await lens("primaryBridge")) as Address;
      return (await r("bittensor", bridge, ADAPTER, "quoteFee", [sourceChain, frontDoor, message, sum])) as bigint;
    },
    readClaimable: async (user) => (await door("claimable", [user])) as bigint,
    readMinDeposit: async () => (await door("minDeposit")) as bigint,
    messageState,
    recordMessage(m) {
      // the send's journal row carries its bridge message (design §4: the journal replaces rec.messages)
      env.journal.update(m.hash, { messageId: m.id }).catch((e: unknown) => env.log(`SENT, BUT NOT SAVED: bridge message ${m.id} of transaction ${m.hash} (${(e as Error).message})`));
    },
    refresh() {
      // v3.2 reads no record file: its readiness is checked live each round (readiness.ts)
    },
    async receipt(chain, hash) {
      const x = (await env.rpc.request(chain, "eth_getTransactionReceipt", [hash])) as {
        status: Hex;
        blockNumber: Hex;
        gasUsed?: Hex;
        effectiveGasPrice?: Hex;
        to?: Address | null;
        logs?: Sent["logs"];
      } | null;
      if (!x) return null;
      const reverted = x.status !== "0x1";
      const logs = x.logs ?? [];
      // the send's journal row, whatever its status (the rails' settling may have settled it already this round), within
      // the spend cap's rows; settled by its late receipt if it isn't yet, or was taken for dropped (a node behind
      // answered no receipt: T50a round-2 R2-1); a delivery's revert replayed for its reason (a ThinPool is never a strike),
      // and a claim's (R8, M-A: a reason the claim's table names is a wait, as at its send)
      const rows = await spendRows(env.journal, (env.send.now ?? Date.now)());
      const row = rows.find((j) => j.hashes.some((h) => h.toLowerCase() === hash.toLowerCase()));
      if (!row) return { reverted, logs };
      const replays = row.request.functionName === "deliver" || row.request.functionName === "claimRewards";
      const reason = reverted && replays ? await replayReason(sendCtx, row.request, row.from, x.blockNumber).catch(() => undefined) : undefined;
      if (row.status !== "signed" && row.status !== "sent" && row.status !== "dropped") return { reverted, logs, ...(reason ? { reason } : {}) };
      const gasUsed = hexToBigInt(x.gasUsed ?? "0x0");
      const receipt = { hash, block: hexToNumber(x.blockNumber), gasUsed, costWei: gasUsed * hexToBigInt(x.effectiveGasPrice ?? "0x0") };
      // a cancel at the row's nonce (a transfer to itself) moved none of the call's value
      const cancel = !!x.to && x.to.toLowerCase() === row.from.toLowerCase() && row.request.to.toLowerCase() !== row.from.toLowerCase();
      const returned = reverted || cancel ? 0n : returnedOf(row.request, logs);
      await env.journal
        .update(hash, { status: reverted ? "reverted" : cancel ? "cancelled" : "landed", receipt, ...(returned ? { returned } : {}) })
        .catch((e: unknown) => env.log(`the journal could not settle transaction ${hash} (${(e as Error).message})`));
      return { reverted, logs, ...(reason ? { reason } : {}) };
    },
    replace: (req, pending, o) => replaceRaw(sendCtx, env.signer, req, pending, o),
    async readRewards() {
      const hotkey = (await lens("stakeHotkey")) as Hex;
      return {
        hotkey,
        waitingWei: await creditsOf(hotkey),
        lastClaimAt: Number(await lens("lastClaimAt", [hotkey])),
        now: await blockTime("bittensor"),
        taoPriceUsd: await taoPriceUsd(),
        claimGasRequired: (await lens("claimGasRequired")) as bigint,
        gasPriceWei: await gasPriceOf(env.rpc, "bittensor"),
        walletWei: await balanceOf(env.rpc, "bittensor", signer),
      };
    },
    async readClaims() {
      const n = Number(await lens("hotkeyCount"));
      const stakeHotkey = ((await lens("stakeHotkey")) as Hex).toLowerCase();
      const hotkeys: HotkeyRead[] = [];
      for (let i = 0; i < n; i++) {
        let hotkey: Hex;
        try {
          hotkey = (await lens("hotkeys", [BigInt(i)])) as Hex;
        } catch (e) {
          // past the end the lens reverts (a removal since the count was read): the end of the set
          if (isRevert(e)) break;
          throw e;
        }
        hotkeys.push({
          hotkey,
          waitingWei: await creditsOf(hotkey),
          lastClaimAt: Number(await lens("lastClaimAt", [hotkey])),
          stakeRao: (await r("bittensor", d.stakingPrecompile, STAKING, "getStake", [hotkey, d.vaultColdkey, 0n])) as bigint,
          stakeHotkey: hotkey.toLowerCase() === stakeHotkey,
        });
      }
      // R6b (U9): a hotkey being freed (no stake, not the stake hotkey) is read for the deferred rewards its unclaimed view
      // leaves out, so the keeper never removes it with them owed (deferred.ts)
      const freeing = hotkeys.filter(beingFreed);
      if (freeing.length) {
        const dust = (await lens("hotkeyDustRao")) as bigint;
        const ask = (key: Hex) => env.rpc.request("bittensor", "eth_call", [{ to: STORAGE_QUERY, data: key }, "latest"]);
        for (const h of freeing) {
          const problem = deferredProblem(await readDeferred(ask, h.hotkey, d.vaultColdkey), dust, 0n, h.hotkey);
          if (problem) h.deferredProblem = problem;
        }
      }
      return {
        hotkeys,
        // R6b (U1, U2): the claim schedule the claim round comes before the end of
        schedule: { start: Number(await lens("vestingStart")), period: Number(await lens("vestingPeriod")), amount: (await lens("vestingAmount")) as bigint },
        now: await blockTime("bittensor"),
        // Base's: a failed read only puts off the monthly claim (its cost unpriced), never a Bittensor-only one (T51
        // review M5)
        taoPriceUsd: await taoPriceUsd().catch(() => Number.NaN),
        ...(await claimGas()),
        walletWei: await balanceOf(env.rpc, "bittensor", signer),
      };
    },
    claimGas,
    async readAdoption() {
      return {
        surplusRao: (await lens("surplusStakeRao")) as bigint,
        minStakeRao: (await lens("minStakeRao")) as bigint,
        paused: (await vault("paused")) as boolean,
        stakeMissing: (await lens("stakeMissing")) as boolean,
        lastAdoptAt: Number(await lens("lastAdoptAt")),
        now: await blockTime("bittensor"),
      };
    },
    async readWatch() {
      // the lens reverts when the staking precompile can't total the coldkey's root stake: unread, never 0
      let unlisted: bigint | undefined;
      try {
        unlisted = (await lens("unlistedStakeRao")) as bigint;
      } catch (e) {
        if (!isRevert(e)) throw e;
      }
      // a node's error or a revert is unread, which the watch takes as a hold; so is a precompile that answers nothing
      // for the block number (a key every block has): with no code at its address (an anvil fork) every eth_call answers
      // "0x", which would otherwise read as no hold (Task 53's fix round, the review's Important 6)
      let hold: bigint | undefined;
      let holdUnread: string | undefined;
      const storage = (key: Hex) => env.rpc.request("bittensor", "eth_call", [{ to: STORAGE_QUERY, data: key }, "latest"]);
      try {
        if (!answersU32(await storage(SYSTEM_NUMBER_KEY))) {
          holdUnread = "the storage-query precompile answered nothing for the block number, a key that always has an entry";
        } else {
          hold = decodeU64(await storage(ROOT_STAKE_UNLOCK_INTERVAL_KEY));
          if (hold === undefined) holdUnread = "the storage-query precompile's answer is not a u64";
        }
      } catch {
        hold = undefined;
        holdUnread = "the storage-query precompile refused it";
      }
      return {
        stakeMissing: (await lens("stakeMissing")) as boolean,
        missingStakeRao: (await lens("missingStakeRao")) as bigint,
        unlistedStakeRao: unlisted,
        rootHoldBlocks: hold,
        ...(holdUnread !== undefined ? { rootHoldUnread: holdUnread } : {}),
        ...(hold ? await blockTimeOf(env.rpc, "bittensor").then(
          (bittensorBlockS) => ({ bittensorBlockS }),
          () => ({}),
        ) : {}),
        idleBufferBps: Number(await lens("idleBufferBps")),
        bookedRao: (await lens("bookedStake")) as bigint,
        pendingPayouts: (await lens("pendingPayouts")) as bigint,
        minDailyOutflow: (await lens("minDailyOutflow")) as bigint,
      };
    },
    async spent(chain) {
      const now = (env.send.now ?? Date.now)();
      return spentOn(await spendRows(env.journal, now), chain, now);
    },
    deliveryCandidates,
    async readDelivery(user) {
      const claimable = (await door("claimable", [user])) as bigint;
      const out: DeliveryRead = { user, claimable, pref: null, quoteUsdc: 0n, twapUsdc: 0n, slippageBps: 0, now: 0 };
      if (claimable === 0n) return out;
      const [minUsdcPerTao, deadline, destination] = (await door("deliveryOf", [user])) as readonly [bigint, bigint, number];
      out.pref = minUsdcPerTao === 0n ? null : { minUsdcPerTao, deadline: Number(deadline), destination: Number(destination) };
      out.now = await blockTime("base");
      if (preferenceProblem(out.pref, out.now)) return out;
      // the front door's own oracle and swapper: what deliver will use
      const oracle = (await door("oracle")) as Address;
      try {
        out.twapUsdc = (await r("base", oracle, ORACLE_ABI, "usdcValue", [claimable])) as bigint;
      } catch (e) {
        if (unanswered(e)) {
          out.quoteError = NO_ANSWER;
          return out;
        }
        if (!isRevert(e)) throw e;
        out.twapUsdc = null;
        return out;
      }
      out.slippageBps = Number(await door("maxDeliverySlippageBps"));
      const route = await deliveryRoute();
      if (!route.sellPath) {
        out.quoteError = `the staker's delivery route ${route.routeId} is not a Uniswap v3 route, the only kind the keeper can quote; it waits`;
        return out;
      }
      try {
        const [gross] = (await r("base", d.quoterV2, QUOTER, "quoteExactInput", [route.sellPath, claimable])) as readonly [bigint];
        out.quoteUsdc = netOfFee(gross, route.feeBps);
      } catch (e) {
        if (unanswered(e)) out.quoteError = NO_ANSWER;
        else if (isRevert(e)) out.quoteError = `Uniswap could not quote the sale (${describeRevert(e, ERRORS_V32)}); it waits`;
        else throw e;
      }
      return out;
    },
    async simulateDeliver(user, keeperMinOut) {
      const data = encodeFunctionData({ abi: KEEPER_CALLS_V32, functionName: "deliver", args: [user, keeperMinOut] });
      try {
        const out = (await env.rpc.request("base", "eth_call", [{ from: signer, to: a.frontDoor, data }, "latest"])) as Hex;
        return { ok: true, usdcOut: decodeFunctionResult({ abi: KEEPER_CALLS_V32, functionName: "deliver", data: out }) as bigint };
      } catch (e) {
        if (unanswered(e)) return { ok: false, reason: NO_ANSWER, unanswered: true };
        if (!isRevert(e)) throw e;
        return { ok: false, reason: describeRevert(e, ERRORS_V32) };
      }
    },
    veto,
    async readKeepers() {
      return { vault: (await lens("keeper")) as Address, frontDoor: (await door("keeper")) as Address };
    },
    async chainIds() {
      const id = async (c: ChainName) => hexToNumber((await env.rpc.request(c, "eth_chainId", [])) as Hex);
      return { base: await id("base"), bittensor: await id("bittensor") };
    },
    readValue: (chain, address, abi, fn, args) => r(chain, address, abi, fn, args),
    async stakeClock() {
      const block = hexToBigInt((await env.rpc.request("bittensor", "eth_blockNumber", [])) as Hex);
      const tag = numberToHex(block);
      const data = encodeFunctionData({ abi: VAULT_LENS, functionName: "lastStakeAt" });
      const out = (await env.rpc.request("bittensor", "eth_call", [{ to: a.vaultLens, data }, tag])) as Hex;
      const lastStakeAt = Number(decodeFunctionResult({ abi: VAULT_LENS, functionName: "lastStakeAt", data: out }));
      const b = (await env.rpc.request("bittensor", "eth_getBlockByNumber", [tag, false])) as { timestamp: Hex } | null;
      if (!b) throw new Error(`Bittensor: block ${block}, which the RPC named its head, could not be read`);
      return { lastStakeAt, block, time: hexToNumber(b.timestamp) };
    },
    code: (chain, address) => codeAt(env.rpc, chain, address),
    balance: (chain, address) => balanceOf(env.rpc, chain, address),
    rails: env.rails,
    journal: env.journal,
    async migrationNotice() {
      // the notice of the rail now primary (R4-O round 3): the latest of its vaults' ready times, read at the head
      const head = hexToBigInt((await env.rpc.request("bittensor", "eth_blockNumber", [])) as Hex);
      const data = encodeFunctionData({ abi: ALPHA, functionName: "migrationReadyAt" });
      const primary = { base: (await doorLens("primaryBridge")) as Address, bittensor: (await lens("primaryBridge")) as Address };
      let readyAt = 0n;
      for (const vault of await railVaults(primary)) {
        const out = (await env.rpc.request("bittensor", "eth_call", [{ to: vault, data }, numberToHex(head)])) as Hex;
        const x = decodeFunctionResult({ abi: ALPHA, functionName: "migrationReadyAt", data: out }) as bigint;
        if (x > readyAt) readyAt = x;
      }
      return readyAt;
    },
    railsSeen(r) {
      lastRails = { rails: r, tick: env.memory.tick, at: Date.now() };
    },
    settleJournal: () => settlePending(sendCtx),
    vetoAfresh() {
      vetoCache = undefined;
    },
    parkLogs,
    forgetParks(keys) {
      const gone = new Set(keys.map((k) => k.toLowerCase()));
      for (const cursors of [mem.parks, ...Object.values(mem.parksAt ?? {})]) for (const c of Object.values(cursors ?? {})) if (c) c.kept = c.kept.filter((l) => !gone.has(l.key.toLowerCase()));
    },
    async readPark(key, adapter) {
      const [amount, parkedAt, converted] = (await r("bittensor", adapter ?? a.bitAdapter, PARK_READS, "parked", [key])) as readonly [bigint, bigint, boolean];
      return { amount, parkedAt, converted };
    },
    async parkRemoteChain(adapter) {
      if (adapter === undefined || adapter.toLowerCase() === a.bitAdapter.toLowerCase()) {
        mem.remoteChainId ??= (await r("bittensor", a.bitAdapter, PARK_READS, "remoteChainId")) as bigint;
        return mem.remoteChainId;
      }
      const ids = (mem.remoteChainIds ??= {});
      ids[adapter.toLowerCase()] ??= String((await r("bittensor", adapter, PARK_READS, "remoteChainId")) as bigint);
      return BigInt(ids[adapter.toLowerCase()]);
    },
    async simulateDeliverParked(p) {
      const data = encodeFunctionData({ abi: PARK_CALLS, functionName: "deliverParked", args: [p.recipient, p.sender, p.message] });
      try {
        await env.rpc.request("bittensor", "eth_call", [{ from: signer, to: p.adapter ?? a.bitAdapter, data }, "latest"]);
        return { ok: true };
      } catch (e) {
        if (unanswered(e)) return { ok: false, reason: NO_ANSWER };
        if (!isRevert(e)) throw e;
        return { ok: false, reason: describeRevert(e, ERRORS_V32) };
      }
    },
    quoteRefund: async (p) => (await r("bittensor", p.adapter ?? a.bitAdapter, PARK_JOBS, "quoteRefund", [p.recipient, p.sender, p.message])) as bigint,
    async parkGas(p) {
      const pair = pairOfBit(d, p.adapter);
      if (!pair) throw new Error(`park ${p.key.slice(0, 10)}…'s adapter ${p.adapter} is not one of the deployment's: no gas requirement for it`);
      // merge 7b: the park's own adapter's view, read live for its message (R4-K round 3: the inbound pair includes the
      // park reserve, counted once); the figures R4-O read once from Base and added up are let go of
      delete mem.parkGas;
      return (await r("bittensor", pair.bitAdapter, PARK_READS, "parkedDeliveryGas", [p.message])) as bigint;
    },
    bridgeEnabled: async (bridge) => (await lens("bridgeEnabled", [bridge])) as boolean,
    cascadeSent,
    pinSent(ids) {
      mem.sentPinned = ids.map((x) => x.toLowerCase());
      // a FAILURE's lookup is let go of once its message is no longer watched (delivered, or out of the window)
      const keep = new Set(mem.sentPinned.map((x) => `failure:${x}`));
      for (const k of Object.keys(mem.lookups ?? {})) if (k.startsWith("failure:") && !keep.has(k)) delete mem.lookups?.[k];
    },
    pinParkSends(ids) {
      mem.sentPinnedParks = ids.map((x) => x.toLowerCase());
      // a park's lookup by id is let go of once its park is closed
      const keep = new Set(mem.sentPinnedParks);
      for (const k of Object.keys(mem.lookups ?? {})) if (k.startsWith("sent:Base → Bittensor:") && !keep.has(k.slice(k.lastIndexOf(":") + 1))) delete mem.lookups?.[k];
    },
    sentById,
    failureOf,
    blockTimeAt: timeAt,
    ...(env.executionInputs ? { executionInputs: env.executionInputs } : {}),
    async transactionOf(chain, hash) {
      const tx = (await env.rpc.request(chain, "eth_getTransactionByHash", [hash])) as { from: Address; to: Address | null; input?: Hex } | null;
      return tx ? { from: tx.from, to: tx.to ?? null, input: tx.input ?? "0x" } : null;
    },
    async ccvsFor(direction, encoded) {
      const dst: ChainName = direction === "Base → Bittensor" ? "bittensor" : "base";
      const [required, optional, threshold] = (await r(dst, d.offRamps[dst], OFFRAMP_CCVS, "getCCVsForMessage", [encoded])) as readonly [Address[], Address[], number];
      return { required: [...required], optional: [...optional], threshold: Number(threshold) };
    },
    async simulate(req) {
      const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
      try {
        await env.rpc.request(req.chain, "eth_call", [{ from: signer, to: req.to, data, value: numberToHex(req.value ?? 0n) }, "latest"]);
        return { ok: true };
      } catch (e) {
        if (unanswered(e)) return { ok: false, reason: NO_ANSWER };
        if (!isRevert(e)) throw e;
        const raw = e instanceof RpcError ? e.data : undefined;
        const revert = typeof raw === "string" ? raw : (raw as { data?: unknown } | undefined)?.data;
        return { ok: false, ...(typeof revert === "string" && revert.startsWith("0x") ? { data: revert as Hex } : {}), reason: describeRevert(e, ERRORS_V32) };
      }
    },
    async onRampMessage(direction, block, id, adapter) {
      const pair = adapter === undefined ? undefined : direction === "Base → Bittensor" ? adapterPairs(d).find((p) => p.baseAdapter.toLowerCase() === adapter.toLowerCase()) : pairOfBit(d, adapter);
      if (adapter !== undefined && !pair) throw new Error(`${adapter} is not one of the deployment's adapters`);
      const lane = laneOf(d, direction, pair);
      if (typeof lane === "string") throw new Error(lane);
      const topics = encodeEventTopics({ abi: ONRAMP, eventName: "CCIPMessageSent", args: { destChainSelector: lane.destSelector, sender: lane.sourceAdapter, messageId: id } } as never).slice(1) as Hex[];
      const part = await scanLogsInParts(ctx, lane.source, lane.onRamp, event(ONRAMP, "CCIPMessageSent"), block, topics, block);
      if (part.stopped) throw part.stopped.error;
      const l = part.logs.find((x) => (x.args.messageId as Hex).toLowerCase() === id.toLowerCase());
      return l ? (l.args.encodedMessage as Hex) : undefined;
    },
    log: env.log,
  };
  return deps;

  /** The Bittensor adapters' park events (Task 52), every pair the deployment lists (R4, D-M2), each kind's scan on from
   * its cursor in the memory, from that pair's Bittensor start block (the adapter's creation), each log naming its
   * adapter; the lowest head the scans read to. The deploy's adapter keeps its cursors where they were (mem.parks). */
  async function parkLogs(): Promise<{ logs: ParkLog[]; head: bigint; settle?: bigint }> {
    const kinds = [
      ["parked", "BatchParked"],
      ["delivered", "ParkedDelivered"],
      ["converted", "ParkedConverted"],
      ["refunded", "ParkedRefunded"],
      ["dropped", "ParkedDropped"],
    ] as const;
    const out: ParkLog[] = [];
    let head: bigint | undefined;
    // the scans' settle margin (Bittensor's, at its measured block time): what the park job's settled closes are counted at
    let settle: bigint | undefined;
    for (const [i, pair] of adapterPairs(d).entries()) {
      const adapter = getAddress(pair.bitAdapter);
      const cursors = i === 0 ? (mem.parks ??= {}) : ((mem.parksAt ??= {})[adapter.toLowerCase()] ??= {});
      for (const [kind, name] of kinds) {
        const c = (cursors[kind] ??= { kept: [], seen: [] });
        const got = await scan(c, "bittensor", adapter, event(PARK_EVENTS, name), (l): ParkLog => {
          // a later pair's logs name their adapter; the deploy's carry none (absent: the deploy's)
          const base = { kind, key: (l.args.key as Hex).toLowerCase() as Hex, blockNumber: l.blockNumber, logIndex: l.logIndex, ...(i === 0 ? {} : { adapter }) };
          if (kind !== "parked") return base;
          return {
            ...base,
            messageId: l.args.messageId as Hex,
            recipient: getAddressOf(l.args.recipient),
            sender: getAddressOf(l.args.sender),
            amount: l.args.amount as bigint,
            converted: l.args.converted as boolean,
          };
        })(() => pair.startBlocks.bittensor);
        out.push(...got.logs);
        head = head === undefined || got.head < head ? got.head : head;
        settle = got.settle;
      }
    }
    return { logs: out, head: head ?? 0n, ...(settle === undefined ? {} : { settle }) };
  }

  /** Cascade's own sends on `direction`'s lane (both when absent; Task 52): the source adapter's Sent with the payload's
   * sender and recipient as topics (the door and the vault, the way the lane runs), each one's arguments checked again (a
   * node that ignores a topic filter adds nothing), from the deployment's start block on that chain, kept
   * SENT_RETAIN_S of blocks behind the head (at the chain's block time, measured), or longer while pinned (pinSent: a
   * re-execution's message not yet SUCCESS); with the block time unread, kept and scanned from the start. */
  async function cascadeSent(direction?: Direction, o: { recent?: boolean } = {}): Promise<CascadeSent[]> {
    const out: CascadeSent[] = [];
    const cursors = (mem.sent ??= {});
    for (const [dir, chain, adapter, from, to, start, first] of sendLanes()) {
      if (direction !== undefined && dir !== direction) continue;
      // the deploy's pair keeps its cursors where they were (mem.sent, by chain); a later pair's are by adapter (R4)
      const c = first ? (cursors[chain] ??= { kept: [], seen: [] }) : ((mem.sentAt ??= {})[adapter.toLowerCase()] ??= { kept: [], seen: [] });
      const topics = [null, padHex(from.toLowerCase() as Hex, { size: 32 }), padHex(to.toLowerCase() as Hex, { size: 32 })];
      const retain = await blockTimeOf(env.rpc, chain).then(
        (blockS) => blocksIn(SENT_RETAIN_S, blockS),
        () => undefined,
      );
      const got = await scan(c, chain, adapter, event(ADAPTER, "Sent"), (l) => ({
        id: (l.args.messageId as Hex).toLowerCase() as Hex,
        direction: dir,
        block: l.blockNumber,
        amount: l.args.amount as bigint,
        gasLimit: l.args.gasLimit as bigint,
        ours: (l.args.sender as string).toLowerCase() === from.toLowerCase() && (l.args.recipient as string).toLowerCase() === to.toLowerCase(),
      }), topics)((head) => {
        const recent = retain !== undefined && head > retain ? head - retain : 0n;
        return o.recent && recent > start ? recent : start;
      });
      // kept past SENT_RETAIN_S while pinned: a message not yet SUCCESS (pinSent), or an open park's (pinParkSends)
      const pinned = new Set([...(mem.sentPinned ?? []), ...(mem.sentPinnedParks ?? [])]);
      const keep = (x: { id: Hex; block: bigint; ours: boolean }) => x.ours && (retain === undefined || x.block + retain > got.head || pinned.has(x.id));
      c.kept = c.kept.filter(keep);
      for (const x of got.logs) if (keep(x)) out.push({ id: x.id, direction: x.direction, block: x.block, amount: x.amount, gasLimit: x.gasLimit, ...(first ? {} : { adapter }) });
    }
    return out;
  }

  /** Cascade's lanes as its sends are read (R4, D-M2: every pair the deployment lists): each source adapter, the payload's
   * sender and recipient, where its scans start, and whether it is the deploy's own pair. */
  function sendLanes(): [Direction, ChainName, Address, Address, Address, bigint, boolean][] {
    return adapterPairs(d).flatMap((p: AdapterPair, i): [Direction, ChainName, Address, Address, Address, bigint, boolean][] => [
      ["Base → Bittensor", "base", getAddress(p.baseAdapter), a.frontDoor, a.vault, p.startBlocks.base, i === 0],
      ["Bittensor → Base", "bittensor", getAddress(p.bitAdapter), a.vault, a.frontDoor, p.startBlocks.bittensor, i === 0],
    ]);
  }

  /** A lookup by id (Task 52 fix round 1): event `ev` of `address` on `chain` with `topics`, over the range `range` gives
   * the first time (kept in the memory under `key`, with how far it has read), the first log `pick` takes. Read chunk by
   * chunk (scanLogsInParts): a lookup cut off part way keeps the progress of the windows it read in full and says how far
   * (partial); the next call reads on from there. A range read in full with none is said so, and read again after
   * LOOKUP_RETRY_MS. */
  async function lookUp<T>(
    key: string,
    chain: ChainName,
    address: Address,
    ev: AbiEvent,
    topics: (Hex | null)[],
    range: () => Promise<{ from: bigint; to: bigint }>,
    pick: (l: ScannedLog) => T | undefined,
    fresh = false,
  ): Promise<Lookup<T>> {
    const all = (mem.lookups ??= {});
    const nowMs = (env.send.now ?? Date.now)();
    let c: (typeof all)[string] | undefined = all[key];
    // a range that found nothing is read again after LOOKUP_RETRY_MS, or at once for a hand run (fresh: the re-review's N5)
    if (c?.noneAt !== undefined && (fresh || nowMs - c.noneAt >= LOOKUP_RETRY_MS)) c = undefined;
    if (!c) {
      const r = await range();
      c = all[key] = { from: r.from, to: r.to };
    }
    if (c.found !== undefined) return { found: c.found as T };
    if (c.noneAt !== undefined) return { none: { from: c.from, to: c.to } };
    const start = c.scannedTo === undefined ? c.from : c.scannedTo + 1n;
    if (start <= c.to) {
      // at most the windows left of the share (Task 52w): the rest is read next run, from where this one stops
      const step = windowOf(ctx, chain);
      const share = (): Lookup<T> => ({ partial: { from: c.from, to: c.to, scannedTo: c.scannedTo ?? c.from - 1n, error: new LookupShareRead("this run's share of lookups by id is read") } });
      if (lookupLeft !== undefined && lookupLeft <= 0) return share();
      const last = lookupLeft === undefined ? c.to : start + BigInt(lookupLeft) * step - 1n;
      const to = last < c.to ? last : c.to;
      const part = await scanLogsInParts(ctx, chain, address, ev, start, topics, to);
      if (lookupLeft !== undefined) lookupLeft -= (part.scannedTo >= start ? Number((part.scannedTo - start) / step) + 1 : 0) + (part.stopped ? 1 : 0);
      for (const l of part.logs) {
        const x = pick(l);
        if (x !== undefined) {
          c.found = x;
          return { found: x };
        }
      }
      if (part.scannedTo >= start) c.scannedTo = part.scannedTo;
      if (part.stopped) return { partial: { from: c.from, to: c.to, scannedTo: c.scannedTo ?? c.from - 1n, error: part.stopped.error } };
      if (to < c.to) return share();
    }
    c.noneAt = nowMs;
    return { none: { from: c.from, to: c.to } };
  }

  /** `chain`'s block at about `time` (unix s), by its head's time and its block time, measured from two headers
   * (blocktime.ts): never past the head, never before the deployment's start block there. */
  async function blockNear(chain: ChainName, from?: bigint): Promise<(time: number) => bigint> {
    const head = hexToBigInt((await env.rpc.request(chain, "eth_blockNumber", [])) as Hex);
    const headTime = await blockTime(chain);
    const blockS = await blockTimeOf(env.rpc, chain, { block: head, time: headTime });
    const start = from ?? d.startBlocks[chain];
    return (time: number) => {
      const back = BigInt(Math.max(0, Math.ceil((headTime - time) / blockS)));
      const b = head > back ? head - back : 0n;
      return b < start ? start : b;
    };
  }

  /** KeeperDepsV32.sentById (Task 52 fix round 1). */
  async function sentById(id: Hex, o: { direction?: Direction; before?: number; lookbackS?: number; fresh?: boolean } = {}): Promise<Lookup<CascadeSent>> {
    // the lanes as cascadeSent reads them: each source adapter of every pair (R4), and the payload's sender and recipient
    let last: Lookup<CascadeSent> = { none: { from: 0n, to: 0n } };
    for (const [dir, chain, adapter, from, to, start, first] of sendLanes()) {
      if (o.direction !== undefined && dir !== o.direction) continue;
      const topics = [padHex(id.toLowerCase() as Hex, { size: 32 }), padHex(from.toLowerCase() as Hex, { size: 32 }), padHex(to.toLowerCase() as Hex, { size: 32 })];
      // a bounded range (`before`) and the whole one from the start are two lookups, each with its own progress (N5); a
      // later pair's are its own (by adapter), the id last as pinParkSends reads it
      const by = first ? "" : `${adapter.toLowerCase()}:`;
      last = await lookUp<CascadeSent>(
        o.before === undefined ? `sent:${dir}:all:${by}${id.toLowerCase()}` : `sent:${dir}:${by}${id.toLowerCase()}`,
        chain,
        adapter,
        event(ADAPTER, "Sent"),
        topics,
        async () => {
          if (o.before === undefined) return { from: start, to: hexToBigInt((await env.rpc.request(chain, "eth_blockNumber", [])) as Hex) };
          const at = await blockNear(chain, start);
          return { from: at(o.before - (o.lookbackS ?? 0) - 3_600), to: at(o.before + 3_600) };
        },
        (l) => {
          // its arguments checked again (a node that ignores a topic filter adds nothing)
          const ours = (l.args.messageId as string).toLowerCase() === id.toLowerCase() && (l.args.sender as string).toLowerCase() === from.toLowerCase() && (l.args.recipient as string).toLowerCase() === to.toLowerCase();
          return ours ? { id: id.toLowerCase() as Hex, direction: dir, block: l.blockNumber, amount: l.args.amount as bigint, gasLimit: l.args.gasLimit as bigint, ...(first ? {} : { adapter }) } : undefined;
        },
        o.fresh,
      );
      if ("found" in last || "partial" in last) return last;
    }
    return last;
  }

  /** KeeperDepsV32.failureOf (Task 52 fix round 1). */
  async function failureOf(direction: Direction, id: Hex, sentBlock: bigint, o: { fresh?: boolean } = {}): Promise<Lookup<FailureWritten>> {
    const lane = laneOf(d, direction);
    if (typeof lane === "string") throw new Error(lane);
    const topics = encodeEventTopics({ abi: OFFRAMP_EVENTS, eventName: "ExecutionStateChanged", args: { sourceChainSelector: lane.sourceSelector, messageId: id } } as never).slice(1) as (Hex | null)[];
    return lookUp<FailureWritten>(
      `failure:${id.toLowerCase()}`,
      lane.dest,
      lane.offRamp,
      event(OFFRAMP_EVENTS, "ExecutionStateChanged"),
      topics,
      async () => {
        // when it was sent, by its block's own time on the source chain; the FAILURE was written after it
        const sentAt = await timeAt(lane.source, sentBlock);
        const at = await blockNear(lane.dest);
        const destNow = await blockTime(lane.dest);
        return { from: at(sentAt - 3_600 - Math.ceil(Math.max(0, destNow - sentAt) / 10)), to: at(destNow) };
      },
      (l) =>
        (l.args.messageId as string).toLowerCase() === id.toLowerCase() && Number(l.args.state) === 3
          ? { tx: l.transactionHash, block: l.blockNumber, returnData: l.args.returnData as Hex }
          : undefined,
      o.fresh,
    );
  }

  /** R4-O round 3 (the coordinator's ruling): the AlphaVault each Bittensor adapter converts through, the deploy's from
   * DEPLOYMENT and a later pair's from its adapter's alphaVault() (immutable), read once and kept. */
  async function alphaVaultOf(bitAdapter: Address): Promise<Address> {
    if (bitAdapter.toLowerCase() === a.bitAdapter.toLowerCase()) return d.alphaVault;
    const kept = (mem.alphaVaults ??= {});
    kept[bitAdapter.toLowerCase()] ??= String(await r("bittensor", bitAdapter, PARK_READS, "alphaVault"));
    return getAddress(kept[bitAdapter.toLowerCase()]);
  }

  /** The AlphaVaults of the rail now primary on each chain (R4-O round 3), each once: the front door's primary's pair's
   * Bittensor adapter's (its batches convert there) and the vault's primary's (its payouts do), from the deployment's
   * adapter pairs. A primary that is no listed pair's (RAILS NOT LISTED, said by the rails) counts as the deploy's. */
  async function railVaults(primary: Record<ChainName, Address>): Promise<Address[]> {
    const halves = [pairOfBase(d, primary.base)?.bitAdapter ?? a.bitAdapter, pairOfBit(d, primary.bittensor)?.bitAdapter ?? a.bitAdapter];
    const out: Address[] = [];
    for (const h of halves) {
      const v = await alphaVaultOf(h);
      if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
    return out;
  }

  /** R7 (L4): why the vault's payouts are closed now, as its _payoutsOpen reads them (CascadeVault.sol): its primary bridge
   * `bridge` disabled on the vault, else that bridge's canSendPayouts() false; undefined when open. The view's answer is
   * read as the vault's capped staticcall reads it (R8, L-D): a call that reverted (out of gas included) reads open, and
   * so does an answer that isn't one word (`ret.length != 32`) or a word that isn't 0; only one word of 0 reads closed. R9
   * (L-3): the call is the vault's own, from the vault with the gas its staticcall gives the view (RAIL_VIEW_CALL_GAS), so
   * a view that needs more, or answers its caller differently, reads as the vault reads it; and Bittensor's EVM halting it
   * (rpc.ts isEvmHalt: "evm error", "evm fatal") is the call failing, which reads open too. A node that didn't run the
   * call (a transport or RPC error of its own: rpc.ts isRevert) says nothing of the view, so it throws, and the round fails
   * and reads again: a batch is never closed on a read that never happened (its redeems would be deferred, their fees
   * lost). */
  async function payoutsClosedOf(bridge: Address): Promise<string | undefined> {
    if (!((await lens("bridgeEnabled", [bridge])) as boolean)) return `its primary bridge ${bridge} is disabled on the vault`;
    let out: unknown;
    try {
      out = await env.rpc.request("bittensor", "eth_call", [{ from: a.vault, to: bridge, data: CAN_SEND_PAYOUTS, gas: numberToHex(RAIL_VIEW_CALL_GAS) }, "latest"]);
    } catch (e) {
      if (isRevert(e) || isEvmHalt(e)) return undefined;
      throw e;
    }
    return typeof out === "string" && /^0x0{64}$/i.test(out) ? `its primary bridge ${bridge} reads canSendPayouts() false` : undefined;
  }

  /** The vaults' three, as one: paused or finished when any is, its notice the latest any announced (the vault that
   * announced it named, for its MIGRATION_DELAY). Before a switch the one vault is the deploy's, so its notice governs. */
  async function alphaAt(vaults: readonly Address[]) {
    const alpha = { paused: false, migrationReadyAt: 0n, migrationFinished: false };
    let noticeVault = vaults[0];
    for (const v of vaults) {
      const paused = (await r("bittensor", v, ALPHA, "isPaused")) as boolean;
      const readyAt = (await r("bittensor", v, ALPHA, "migrationReadyAt")) as bigint;
      const finished = (await r("bittensor", v, ALPHA, "migrationFinished")) as boolean;
      alpha.paused ||= paused;
      alpha.migrationFinished ||= finished;
      if (readyAt > alpha.migrationReadyAt) {
        alpha.migrationReadyAt = readyAt;
        noticeVault = v;
      }
    }
    return { alpha, noticeVault };
  }

  /** ForeverMoney's MIGRATION_DELAY() in seconds (the re-review's N3), read once and kept: undefined when it can't be read
   * (the park job then counts 7 days, FM_MIGRATION_DELAY_S). An AlphaVault without the getter (it reverts), or one whose
   * answer is no notice's length (0, or more than a year), is kept as such, said once; a node's error is read again next
   * round. */
  async function migrationDelay(vault: Address): Promise<number | undefined> {
    if (mem.migrationDelay !== undefined) return mem.migrationDelay ?? undefined;
    let v: bigint;
    try {
      v = (await r("bittensor", vault, ALPHA, "MIGRATION_DELAY")) as bigint;
    } catch (e) {
      if (!isRevert(e)) return undefined;
      mem.migrationDelay = null;
      env.log("ForeverMoney's MIGRATION_DELAY() can't be read (the AlphaVault has no such getter): the notice is taken to have begun 7 days before migrationReadyAt");
      return undefined;
    }
    if (v <= 0n || v > 365n * 86_400n) {
      mem.migrationDelay = null;
      env.log(`ForeverMoney's MIGRATION_DELAY() reads ${v} s, not a notice's length: the notice is taken to have begun 7 days before migrationReadyAt`);
      return undefined;
    }
    mem.migrationDelay = Number(v);
    return mem.migrationDelay;
  }

  /** What waits to be claimed on listed hotkey `h`, in wei: the claim source (abi.ts CLAIM_SOURCE) for the vault's coldkey.
   * Every read of it is this one (Task 64 confirms the source on chain; a change is CLAIM_SOURCE's line). */
  async function creditsOf(h: Hex): Promise<bigint> {
    return (await r("bittensor", d.stakingPrecompile, [CLAIM_SOURCE], CLAIM_SOURCE.name, [d.vaultColdkey, h])) as bigint;
  }

  /** The vault's claimGasRequired and Bittensor's fee cap now: what a claim would pay a gas at most (the gas price on
   * legacy transactions, twice it on EIP-1559 ones, as the one send path signs them). */
  async function claimGas(): Promise<{ claimGasRequired: bigint; feeCapWei: bigint }> {
    const price = await gasPriceOf(env.rpc, "bittensor");
    return { claimGasRequired: (await lens("claimGasRequired")) as bigint, feeCapWei: env.send.chains.bittensor.legacy ? price : 2n * price };
  }

  /** USDC for 1 TAO along the staker's delivery route (QuoterV2), the claim policy's price; NaN when the route is not a
   * Uniswap v3 one (the monthly claim then waits: its cost can't be priced). */
  async function taoPriceUsd(): Promise<number> {
    const staker = (await door("swapper")) as Address;
    const routeId = Number(await r("base", staker, STAKER, "deliveryRouteId"));
    const [kind, , , sellPath] = (await r("base", staker, STAKER, "routes", [routeId])) as readonly [number, Address, Hex, Hex, boolean];
    if (kind !== UNISWAP_V3) return Number.NaN;
    const [usdcPerTao] = (await r("base", d.quoterV2, QUOTER, "quoteExactInput", [sellPath, E18])) as readonly [bigint];
    return Number(usdcPerTao) / 1e6;
  }

  /** The staker's live delivery route, as deliver sells along it: its id, its sell path when it is a Uniswap v3 route
   * (the only kind QuoterV2 prices; undefined otherwise), and the staker's swap fee. */
  async function deliveryRoute(): Promise<{ routeId: number; sellPath?: Hex; feeBps: number }> {
    // read once a round (the round's tick), for every candidate and the veto alike
    if (routeCache && routeCache.tick === env.memory.tick && Date.now() - routeCache.at < 60_000) return routeCache.route;
    const route = await readRoute();
    routeCache = { tick: env.memory.tick, at: Date.now(), route };
    return route;
  }
  async function readRoute(): Promise<{ routeId: number; sellPath?: Hex; feeBps: number }> {
    const staker = (await door("swapper")) as Address;
    const routeId = Number(await r("base", staker, STAKER, "deliveryRouteId"));
    const [kind, , , sellPath] = (await r("base", staker, STAKER, "routes", [routeId])) as readonly [number, Address, Hex, Hex, boolean];
    const feeBps = Number(await r("base", staker, STAKER, "swapFeeBps"));
    if (kind !== UNISWAP_V3) {
      return { routeId, feeBps };
    }
    return { routeId, sellPath, feeBps };
  }

  /** The users a delivery may be due to, oldest credit first (design §5): every user the front door credited
   * (PayoutReceived) and has not since delivered to (Delivered) or seen claim (Claimed), whose last DeliverySet set a
   * preference. Four scans of the door's events on Base, each on from its cursor in the memory; settled logs are folded
   * into each user's summary (only its positions are kept, never the logs), the newest ones laid over a copy for this
   * round alone. A user with nothing owed, no preference, and nothing a later scan can still read again is let go of. */
  async function deliveryCandidates(): Promise<Address[]> {
    const dm = (mem.deliveries ??= {});
    const users = (dm.users ??= {});
    const fresh: ["credit" | "clear" | "pref", CreditLog][] = [];
    let low: bigint | undefined;
    const scans = [
      ["credited", "PayoutReceived", "credit"],
      ["delivered", "Delivered", "clear"],
      ["claimed", "Claimed", "clear"],
      ["prefs", "DeliverySet", "pref"],
    ] as const;
    for (const [name, ev, kind] of scans) {
      const c = (dm[name] ??= { kept: [], seen: [] });
      const got = await scan(c, "base", a.frontDoor, event(DOOR, ev), (l): CreditLog => ({
        user: getAddressOf(l.args.user),
        pos: posOf(l),
        ...(kind === "pref" ? { on: (l.args.minUsdcPerTao as bigint) !== 0n } : {}),
      }))(() => d.startBlocks.base);
      // what settled this scan is folded and let go of; the rest is read again next round
      const settled = c.kept.splice(0);
      for (const l of settled) fold(users, kind, l);
      for (const l of got.logs.slice(settled.length)) fresh.push([kind, l]);
      // the lowest block any of these scans may read again (its cursor's seenFrom): a mark below it is never read again
      const from = c.seenFrom ?? 0n;
      low = low === undefined || from < low ? from : low;
    }
    for (const [k, u] of Object.entries(users)) {
      const marks = [u.cleared, u.pref?.at].filter((x): x is string => x !== undefined);
      const gone = u.credits.length === 0 && !u.pref?.on && marks.every((p) => blockOf(p) < (low ?? 0n));
      if (gone) delete users[k];
    }
    const view: Record<string, UserCredit> = Object.fromEntries(Object.entries(users).map(([k, u]) => [k, { ...u, credits: [...u.credits], ...(u.pref ? { pref: { ...u.pref } } : {}) }]));
    for (const [kind, l] of fresh) fold(view, kind, l);
    return Object.values(view)
      .filter((u) => u.credits.length > 0 && u.pref?.on)
      .sort((x, y) => (x.credits[0] < y.credits[0] ? -1 : x.credits[0] > y.credits[0] ? 1 : 0))
      .map((u) => u.user);
  }

  /** The outside-price veto (veto.ts) before a delivery, once a round (the round's tick; a one-shot command's for a
   * minute): the monitor's /v1/price, what 0.5 TAO sells for along the delivery route, and Base's clock. */
  async function veto(): Promise<string | undefined> {
    if (vetoCache && vetoCache.tick === env.memory.tick && Date.now() - vetoCache.at < 60_000) return vetoCache.result;
    let reference: Reference | null = null;
    if (env.rails.monitor) {
      try {
        reference = parseReference(JSON.parse(await env.rails.monitor.price())) ?? null;
      } catch {
        reference = null;
      }
    }
    const nowMs = (await blockTime("base")) * 1000;
    let probeUsdc: bigint | undefined;
    try {
      const route = await deliveryRoute();
      if (route.sellPath) probeUsdc = ((await r("base", d.quoterV2, QUOTER, "quoteExactInput", [route.sellPath, SALE_PROBE_TAO])) as readonly [bigint])[0];
    } catch {
      probeUsdc = undefined;
    }
    const result = vetoReason({ reference, probeUsdc, nowMs });
    vetoCache = { tick: env.memory.tick, at: Date.now(), result };
    return result;
  }
}

/** A log's address argument, checksummed. */
const getAddressOf = (x: unknown): Address => getAddress(x as string);

/** A payout chunk's PayoutChunkSent in a receipt (the published vault ABI): what the entries were charged and what the
 * walk cost them (the leaver pays), for the log. */
export function chunkSentFrom(logs: Sent["logs"], vault: Address): { charged: bigint; unstakeCost: bigint; net: bigint; fee: bigint } | undefined {
  for (const l of logs ?? []) {
    if (l.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi: VAULT_ABI_V32, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      if (e.eventName === "PayoutChunkSent") {
        const x = e.args as unknown as { charged: bigint; unstakeCost: bigint; net: bigint; fee: bigint };
        return { charged: x.charged, unstakeCost: x.unstakeCost, net: x.net, fee: x.fee };
      }
    } catch {
      // another of the vault's events
    }
  }
  return undefined;
}
