import { type Address, encodeEventTopics, formatEther, formatUnits, type Hex, parseAbi } from "viem";
import { checkDelivery, type DeliveryDeps, type DeliveryPlan, deliverRequest, deliveredFrom, explainDeliveryRevert } from "./delivery.ts";
import { type Action, actionKey, type DueDelivery, decideNext, type State } from "./due.ts";
import { chainLabel, ReceiptTimeout, RevertedOnChain, SendRefused } from "./errors.ts";
import {
  classifyFailure,
  DeliveryReverted,
  type FailureKind,
  inWords,
  KeeperHasCode,
  KeeperNotReady,
  nextWaitMs,
  NotNow,
  oneLine,
  PayoutListMismatch,
  PayoutListRescan,
  RevertUnread,
  scrubSecrets,
} from "./failures.ts";
import { type Payout, type PayoutLog, payoutsHash, rebuildPayouts } from "./payouts.ts";
import { type ClaimPolicy, claimGasLimit, claimRequest, decideClaim, type RewardsDeps, upfrontShortfall } from "./rewards.ts";
import type { StatusDetail } from "./status.ts";
import type { KeeperMemory, Racing } from "./memory.ts";
import type { CallRequest, ChainName, Replacement, Sent } from "./types.ts";

export { KeeperHasCode } from "./failures.ts";

export type KeeperState = State & { detail: StatusDetail };

export type Message = { id: Hex; direction: "Base → Bittensor" | "Bittensor → Base"; hash: Hex };

/** A keeper transaction, with the bridge message it sent (close, payouts). */
export type Done = Sent & { messageId?: Hex };

/** The contracts a keeper action sends to: a deployment record (record.ts DeploymentRecord) is one. */
export interface KeeperContracts {
  plan: { addresses: { frontDoor: Address; vault: Address; baseAdapter: Address; bitAdapter: Address } };
  /** v3.2 (R4-O's fix round, Minor 5): every listed pair's adapter that sends each way, the deploy's first, where a late
   * receipt's bridge message is looked for (after a switch the close or payout went through another pair's). Absent:
   * the plan's adapters alone (v3-launch). */
  messageAdapters?: Record<"Base → Bittensor" | "Bittensor → Base", readonly Address[]>;
}

/** What the keeper acts on, as its host builds it (design-keeper-worker.md §1): the deployment's contracts and the
 * two decisions the host's record makes. The PC's v3-launch host builds it from the deployment record
 * (keeper/actions.ts launchTarget). */
export interface KeeperTarget extends KeeperContracts {
  /** Refuses (KeeperNotReady) unless the keeper may send now, signing as `signer`: run before every send. The core's
   * entry points pass their deps too, always (required: T50a round-2 R2-3, so a future entry point can't skip it):
   * v3.2's target refuses deps that aren't depsV32's, whose sends pass the rails (T50a re-review Minor 1); v3-launch's
   * ignores them. */
  requireReady(signer: Address, deps: KeeperDeps): void;
  /** The plan USDC deliveries go through; refuses a deployment that has none. */
  deliveryPlan(): DeliveryPlan;
  /** The deployment's own actions (v3.2's: v32/actions.ts); absent, v3-launch's (this file's). */
  actions?: KeeperActions;
}

/** What act's options carry: the payout list rebuilt from a second scan (rescanned), and (v3.2) what the round passes
 * its actions: the claim policy a claim is decided again by (Task 51), the round's memory and clock (a claim's refusal
 * is kept there, Task 51 fix round 1), and a call a payout makes once its list has passed the check against the vault's
 * (the round then lets go of a rescan's flag: T51 review I1). */
export interface ActOptions {
  rescanned?: boolean;
  policy?: ClaimPolicy;
  memory?: KeeperMemory;
  now?: number;
  listChecked?: () => void;
}

/** What a round does for each action, and checks before it starts: v3-launch's are this file's (close, roll, stake,
 * payouts, deliver) and round.ts's explainRace; v3.2 brings its own (v32/actions.ts). */
export interface KeeperActions {
  act(deps: KeeperDeps, rec: KeeperTarget, a: Exclude<Action, { kind: "deliver" } | { kind: "roll" }>, o?: ActOptions): Promise<Done>;
  roll(deps: KeeperDeps, rec: KeeperTarget): Promise<Rolled>;
  deliver(deps: KeeperDeps, rec: KeeperTarget, user: Address): Promise<Delivery>;
  /** Why a close, roll, payout or stake that reverted on chain lost a race, from the chains read after it; undefined
   * when nothing explains it (the revert then stops the keeper). */
  explainRace(a: Racing, before: KeeperState, after: KeeperState): string | undefined;
  /** Run at the start of every round, before anything is looked up or sent (v3.2: the live readiness checks); a throw
   * fails the round, classified as any failure. `now` is the round's clock (ms). */
  beforeRound?(deps: KeeperDeps, memory: KeeperMemory, now: number): Promise<void>;
  /** v3.2's rails (Task 50a: v32/rails.ts), read after beforeRound and before anything is looked up, replaced or sent;
   * they say what the round may send, each said loudly by the rails once per change. A throw fails the round (nothing
   * is sent). Absent (v3-launch): no rails. */
  rails?(deps: KeeperDeps, memory: KeeperMemory, now: number): Promise<Rails>;
  /** v3.2: the round's delivery queue, oldest credit first, once its candidates are checked (logged when it changes). */
  queued?(deps: KeeperDeps, memory: KeeperMemory, queue: readonly QueuedDelivery[], candidates?: readonly Address[]): void;
  /** v3.2 (Task 51): the claims and the adoption due this round, which the round reads only once nothing else is due
   * (payouts, then stake or unstake, then claims: spec §3.8): on the first round, every `every` rounds, and each round
   * while the last reading found one that could go. Undefined: not read this round. Each decision is said by the hook
   * when it changes. `now` is the round's clock (ms); `state` the round's read (Task 53: the hotkey watch reads again at
   * once when the vault's stake goes missing or comes back). Absent (v3-launch): its run never claims or adopts. */
  rewards?(deps: KeeperDeps, memory: KeeperMemory, o: { policy: ClaimPolicy; now: number; every: number; state?: KeeperState }): Promise<Rewards | undefined>;
  /** v3.2 (R8, M-A): a claim of the keeper's whose receipt came late, reverted on chain (round.ts revertedLate), taken as
   * a revert at its send is (v32/actions.ts claimRevertedLateV32): a wait, or its hotkey's claims held in `memory`, so the
   * next reading doesn't send it again. Gives the words: a wait's why, or the hold's (said HELD). Never throws. `now` is
   * the round's clock (ms). R9 (L-2): `since`, when the keeper stopped waiting for its receipt (the watch's, the round's
   * clock), and `last`, the hotkey's lastClaimAt read before the send (its request's claimLast), so another caller's claim
   * first is a wait. Absent (v3-launch): its run never claims. */
  claimRevertedLate?(deps: KeeperDeps, memory: KeeperMemory, c: { hotkey: Hex; hash: Hex; reason?: string; now: number; since?: number; last?: number }): Promise<{ wait: string } | { held: string }>;
  /** v3.2 (Task 52): the park job and the FAILURE re-executions (v32/parked.ts, v32/reexec.ts), read once a round after the
   * state (and the delivery candidates); each job keeps its own cadence and says its decisions once. Under a hold during the
   * migration notice (`onlyConversions`), only the token parks' conversions. A throw only puts them off (said), never
   * fails the round. Absent (v3-launch): no park jobs, no re-executions. */
  bridgeWork?(deps: KeeperDeps, memory: KeeperMemory, s: KeeperState, o: { now: number; onlyConversions: boolean }): Promise<BridgeWork | undefined>;
  /** v3.2 (Task 52w): whether the round reads its bridge work before its deliveries (v3.2: while ForeverMoney's migration
   * notice runs), and then reads no delivery in a round with a token park's conversion due, which goes first: the
   * deliveries' reads never take a run's subrequests from the conversions. Absent or false: after the deliveries. */
  bridgeFirst?(s: KeeperState): boolean;
  /** v3.2 (Task 52w fix): the most delivery candidates a round reads, in turn (oldest first among those not read since the
   * turn began; a turn ends once each has been read), and a candidate whose read fails is said and skipped for the round
   * rather than failing it, read again on its next turn (R1). Absent (v3-launch): every candidate every round, a failed read failing the round, as before. */
  deliveriesPerRound?: number;
  /** v3.2: a payout rescan may take several runs (each scan keeps its progress across a read deadline), so the round keeps
   * its "rescanned once" flag until a payout of that batch gets past its list check (it calls ActOptions.listChecked) or
   * the batch is gone, never only for the next round (T51 review I1). Absent (v3-launch): the flag lasts one round, as
   * it always has. */
  rescanSpansRuns?: boolean;
}

/** The claims and the adoption a round may make (v3.2, Task 51), as decideNext reads them. */
export type Rewards = Pick<State, "claims" | "adopt" | "rewardsWait" | "frees" | "rootHold">;

/** What the rails let a round send (v3.2, Task 50a). */
export interface Rails {
  /** Set: nothing is sent this round, not even a replacement (a hold; the monitor can't be read or can't see): why */
  stop?: string;
  /** Chains at the keeper's 24 h spend cap: nothing more is sent on them (their replacements included) */
  capped?: ReadonlySet<ChainName>;
  /** The payout keys the monitor confirmed (a payout not among them waits); undefined: no per-key check */
  confirmed?: ReadonlySet<string>;
  /** Set: no delivery at all this round (usdcDelivery off, the deliveries switch off): why. Credits stay claimable. */
  noDeliveries?: string;
  /** With `stop`: ForeverMoney's migration notice runs (read on chain), so a token park's conversion still goes, and only
   * that (the founder's one exception, 2026-11-08; still under the kill switch and the lease) */
  migrationConversions?: true;
  /** ForeverMoney's migration notice runs (read on chain under a stop or at Bittensor's spend cap): a token park's
   * conversion passes the spend cap, counted (the controller's ruling for Task 52), as a cancel does */
  migrationNotice?: true;
}

/** v3.2 (Task 52): the bridge work a round may do, read after its state (core/actions.ts KeeperActions.bridgeWork): the
 * token parks to convert during ForeverMoney's migration notice, the notice's one close, the park jobs, and the
 * re-executions of Cascade's FAILUREs (automatic mode only), and the lanes that wait while one of them is open. */
export type BridgeWork = Pick<State, "conversions" | "flush" | "parkJobs" | "reexecs" | "laneWaits">;

/** One user in the round's delivery queue: what they are owed, and whether their delivery is due this round. */
export interface QueuedDelivery {
  user: Address;
  claimable: bigint;
  due: boolean;
}

export interface KeeperDeps extends RewardsDeps, DeliveryDeps {
  /** Both chains' state. `economics` prices the open batch for the close rule (frontDoor.closeEconomics),
   * which reads prices and scans Base's logs: only `run` and `status` ask for it. */
  readState(opts?: { economics?: boolean }): Promise<KeeperState>;
  sendCall(req: CallRequest): Promise<Sent>;
  /** Who the keeper's sends come from (keeperSigner): requireReady checks it is the record's keeper */
  signer: Address;
  /** The keeper wallet's (`signer`'s) code on `chain`: "0x" for a plain account. Read fresh on every
   * call, never kept: keeperSend reads it on both chains before every send. */
  signerCode(chain: ChainName): Promise<Hex>;
  nonce(chain: ChainName): Promise<number>;
  /** The keeper wallet's mined nonce on `chain` (its transaction count at the latest block): `run` tells
   * a watched nonce something else was mined at from one still pending. Optional: without it, a
   * transaction with no receipt is watched until LATE_RECEIPT_MS. */
  minedNonce?(chain: ChainName): Promise<number>;
  quoteClose(s: KeeperState): Promise<bigint>;
  /** The vault's payout events (DepositBounced, Redeemed) since the deploy block, kept across calls:
   * each call scans only the new blocks */
  payoutLogs(): Promise<PayoutLog[]>;
  batchInfo(key: Hex): Promise<{ payoutsHash: Hex; count: number }>;
  /** Forgets the payout events kept so far: the next payoutLogs scans them all again, from the deploy
   * block (payouts calls it once when the rebuilt list doesn't match the vault's, before refusing) */
  rescanPayoutLogs(): void;
  /** The TAO the front door holds for `user` to claim (or the keeper to deliver) */
  readClaimable(user: Address): Promise<bigint>;
  /** The front door's minimum deposit as it is now */
  readMinDeposit(): Promise<bigint>;
  /** A bridge message's state on its destination's OffRamp: UNTOUCHED, IN_PROGRESS, SUCCESS or FAILURE */
  messageState(m: Pick<Message, "id" | "direction">): Promise<string>;
  recordMessage(m: Message): void;
  /** Re-reads the deployment record from disk and takes its verify, done and messages onto the record
   * these deps hold (the one `run` passes to each action), so a read-back saved since the command started
   * is seen; throws RecordMismatch when the file is gone or now holds another deployment */
  refresh(): void;
  /** A transaction's receipt (null while there is none): `run` looks up those that timed out. Optional:
   * without it, a transaction with no receipt is only logged. v3.2's also gives a revert's reason, replayed (the
   * ThinPool rule needs it), and settles the journal's row. */
  receipt?(chain: ChainName, hash: Hex): Promise<{ reverted: boolean; logs: Sent["logs"]; reason?: string } | null>;
  /** Replaces the keeper's own transaction sent for `req` (one of `pending`: its hash, then each
   * replacement's, none with a receipt since) at the same nonce with a higher fee (send.ts replaceCall):
   * `run` does this to one stuck pending for REPLACE_AFTER_MS. Optional: without it, a stuck transaction
   * is only reported. */
  replace?(req: CallRequest, pending: readonly Hex[], o?: { cancel?: boolean }): Promise<Replacement>;
  log(line: string): void;
}

export const KEEPER_ABI = parseAbi([
  "function closeBatch() payable",
  "function stakeIdle()",
  "struct Payout { address user; uint256 shares; uint256 assets; }",
  "function processPayouts(bytes32 key, Payout[] payouts, uint32 maxEntries)",
]);

const SENT_EVENT = parseAbi([
  "event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)",
]);
const SENT_TOPIC = encodeEventTopics({ abi: SENT_EVENT, eventName: "Sent" })[0];

/** The bridge message id from an adapter's Sent log in a receipt. */
export function messageIdFrom(logs: Sent["logs"], adapter: Hex): Hex | undefined {
  const l = (logs ?? []).find((l) => l.address.toLowerCase() === adapter.toLowerCase() && l.topics[0] === SENT_TOPIC);
  return l?.topics[1];
}

/** Every keeper send goes through here. The keeper wallet is a plain account, with no code; code there
 * means its key has signed an EIP-7702 delegation (a thief's sweeper, as in the Binance hot-wallet drain)
 * or the address is a contract. Either way nothing is sent, and `run` stops. Its code is read on both
 * chains, the send's first, fresh before EVERY send (signerCode keeps nothing): a round with several
 * sends, each waiting for its receipt, can run for minutes, and a delegation landing after its first send
 * must stop its next. One key holds the address on both chains, a delegation can be signed for every
 * chain at once (chain id 0), and Bittensor may not run EIP-7702 at all, so code on either chain stops a
 * send on either. The refusal names the chain the code is on. */
export async function keeperSend(deps: KeeperDeps, req: CallRequest): Promise<Sent> {
  await assertNoCode(deps, req.chain);
  return deps.sendCall(req);
}

/** The keeper wallet's code, read fresh on both chains (`chain`, the send's, first): any code throws
 * KeeperHasCode, which stops `run`. Every send, and every replacement of one, passes here first. */
export async function assertNoCode(deps: Pick<KeeperDeps, "signerCode" | "signer">, chain: ChainName): Promise<void> {
  for (const c of [chain, chain === "base" ? "bittensor" : "base"] as const) {
    const code = await deps.signerCode(c);
    if (code !== "0x") throw new KeeperHasCode(c, deps.signer, code);
  }
}

/** Records a bridge message the keeper sent. The transaction has gone through: a record that can't be
 * saved (EPERM, a full disk) is said loudly, with the hash and the message id, and never thrown. */
export function recordSafely(deps: KeeperDeps, m: Message): void {
  try {
    deps.recordMessage(m);
  } catch (e) {
    deps.log(
      scrubSecrets(
        `SENT, BUT NOT SAVED: transaction ${m.hash}, bridge message ${m.id} went through, but saving it to the record failed (${oneLine((e as Error).message)}); follow it with: pnpm ops track ${m.id}`,
      ),
    );
  }
}

export async function withMessage(deps: KeeperDeps, sent: Sent, adapter: Hex, direction: Message["direction"]): Promise<Done> {
  const messageId = messageIdFrom(sent.logs, adapter);
  if (messageId) recordSafely(deps, { id: messageId, direction, hash: sent.hash });
  return { ...sent, messageId };
}

const MIN_CLOSE_VALUE = 15n * 10n ** 14n;
/** The fee float for closeBatch: three times the live quote, at least 0.0015 ETH (the front door refunds the rest). */
export const closeValue = (quote: bigint) => (3n * quote > MIN_CLOSE_VALUE ? 3n * quote : MIN_CLOSE_VALUE);

export const closeRequest = (rec: KeeperContracts, quote: bigint, nonce: number): CallRequest => ({
  chain: "base",
  nonce,
  label: "close the open batch and send it to Bittensor",
  to: rec.plan.addresses.frontDoor,
  abi: KEEPER_ABI,
  functionName: "closeBatch",
  args: [],
  value: closeValue(quote),
});

/** closeBatch with no value: on an empty batch the front door restarts its timer and refunds nothing. */
export const rollRequest = (rec: KeeperContracts, nonce: number): CallRequest => ({
  chain: "base",
  nonce,
  label: "roll the empty open batch (restart its timer)",
  to: rec.plan.addresses.frontDoor,
  abi: KEEPER_ABI,
  functionName: "closeBatch",
  args: [],
});

export const stakeRequest = (rec: KeeperContracts, nonce: number): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: "stake the vault's idle TAO",
  to: rec.plan.addresses.vault,
  abi: KEEPER_ABI,
  functionName: "stakeIdle",
  args: [],
});

/** Whether a payout list rebuilt from the vault's events is the one the vault stored for the batch. */
export const payoutsMatch = (list: Payout[], stored: { payoutsHash: Hex; count: number }): boolean =>
  list.length === stored.count && payoutsHash(list).toLowerCase() === stored.payoutsHash.toLowerCase();

/** processPayouts with the batch's full list, refused unless it matches what the vault stored. */
export function payoutsRequest(
  rec: KeeperContracts,
  key: Hex,
  list: Payout[],
  stored: { payoutsHash: Hex; count: number },
  nonce: number,
): CallRequest {
  if (!payoutsMatch(list, stored)) {
    throw new PayoutListMismatch(
      `the payout list rebuilt from the vault's events (${list.length} entries) does not match batch ${key.slice(0, 10)}… (${stored.count} entries); nothing sent`,
    );
  }
  return {
    chain: "bittensor",
    nonce,
    label: `pay out batch ${key.slice(0, 10)}… to Base`,
    to: rec.plan.addresses.vault,
    abi: KEEPER_ABI,
    functionName: "processPayouts",
    args: [key, list, 100],
  };
}

export async function close(deps: KeeperDeps, rec: KeeperTarget): Promise<Done> {
  rec.requireReady(deps.signer, deps);
  const s = await deps.readState();
  if (!s.alphaVault.healthy) throw new NotNow("AlphaVault is paused or migrating — not closing the batch");
  if (s.frontDoor.paused) throw new NotNow("the front door is paused");
  if (s.frontDoor.nDeposits + s.frontDoor.nRedeems === 0) throw new NotNow("the open batch is empty");
  if (!s.frontDoor.canClose) throw new NotNow("the open batch is not ready to close yet");
  const sent = await keeperSend(deps, closeRequest(rec, await deps.quoteClose(s), await deps.nonce("base")));
  return withMessage(deps, sent, rec.plan.addresses.baseAdapter, "Base → Bittensor");
}

/** A roll sent, or skipped with why. */
export type Rolled = ({ rolled: true } & Done) | { rolled: false; reason: string };

/** Rolls the empty open batch (see decideNext), through the same send path as close: the wallet's
 * guards, then a simulation with no value. It re-reads first and sends only while the batch is still
 * empty and can close, the front door is open, AlphaVault is healthy (as close requires), and the record
 * has a max wait. A roll is never needed, so a race it loses is a skip for a later round: an entry
 * arriving before the simulation (which then would revert), or an entry or another close landing before
 * it is mined (it reverts on chain; the front door is re-read to tell that from an unexplained revert,
 * which still stops the keeper, as does a re-read that fails). A missing receipt and the send guards'
 * refusals are thrown, for `run` to classify (classifyFailure). If a redeem lands between the simulation
 * and the transaction, its fee pot may pay for a real close; its bridge message is then recorded like a
 * close's. */
export async function roll(deps: KeeperDeps, rec: KeeperTarget): Promise<Rolled> {
  rec.requireReady(deps.signer, deps);
  const s = await deps.readState();
  const fd = s.frontDoor;
  const skip = (reason: string): Rolled => ({ rolled: false, reason });
  if (s.closeMaxWaitS === 0) return skip("the deployment has no max wait: an empty batch is left as it is");
  // as close(): a redeem landing first can make this a real close
  if (!s.alphaVault.healthy) return skip("AlphaVault is paused or migrating — not rolling the empty batch");
  if (fd.paused) return skip("the front door is paused");
  if (fd.nDeposits + fd.nRedeems > 0) return skip("the open batch has entries now; the close rule decides it");
  if (!fd.canClose) return skip("the open batch can't close yet");
  let sent: Sent;
  try {
    sent = await keeperSend(deps, rollRequest(rec, await deps.nonce("base")));
  } catch (e) {
    if (e instanceof SendRefused && e.reason === "estimate") return skip(`${e.message}; the next round decides again`);
    if (e instanceof RevertedOnChain) {
      let after: KeeperState["frontDoor"];
      try {
        after = (await deps.readState()).frontDoor;
      } catch {
        // the revert, with its transaction hash, is what stops the keeper; not the failed read
        throw e;
      }
      if (after.nDeposits + after.nRedeems > 0 || !after.canClose) {
        return skip(`an entry or another close landed first; the roll reverted (transaction ${e.hash})`);
      }
    }
    throw e;
  }
  return { rolled: true, ...(await withMessage(deps, sent, rec.plan.addresses.baseAdapter, "Base → Bittensor")) };
}

export async function stake(deps: KeeperDeps, rec: KeeperTarget): Promise<Done> {
  rec.requireReady(deps.signer, deps);
  const s = await deps.readState();
  if (s.vault.paused) throw new NotNow("the vault is paused");
  return keeperSend(deps, stakeRequest(rec, await deps.nonce("bittensor")));
}

/** Pays `key`'s batch out with the list rebuilt from the vault's events. A list that doesn't match the
 * vault's stored hash is not refused at once: one short eth_getLogs answer (a lagging replica behind the
 * head it reported, a truncated response) in a first scan would rebuild a short list for the life of the
 * process, so the vault's events are set to be scanned again in full and PayoutListRescan is thrown (a
 * passing failure); `run` then calls again with `rescanned` the next round, with the list rebuilt from
 * that second scan, and only a mismatch then is refused for good (PayoutListMismatch). */
export async function payouts(deps: KeeperDeps, rec: KeeperTarget, key: Hex, o: { rescanned?: boolean } = {}): Promise<Done> {
  rec.requireReady(deps.signer, deps);
  const s = await deps.readState();
  if (!s.alphaVault.healthy) throw new NotNow("AlphaVault is paused or migrating — not paying out");
  if (s.vault.paused) throw new NotNow("the vault is paused");
  const b = s.vault.batches.find((b) => b.key.toLowerCase() === key.toLowerCase());
  if (!b || b.cursor >= b.count) throw new NotNow(`no payout is pending for batch ${key.slice(0, 10)}…`);
  if (s.now < b.queuedAt + s.vault.payoutDelay) throw new NotNow(`batch ${key.slice(0, 10)}… is not due yet`);
  const list = rebuildPayouts(await deps.payoutLogs(), key);
  const stored = await deps.batchInfo(key);
  if (!payoutsMatch(list, stored) && !o.rescanned) {
    deps.rescanPayoutLogs();
    throw new PayoutListRescan(
      key,
      `the payout list rebuilt from the vault's events (${list.length} entries) does not match batch ${key.slice(0, 10)}… (${stored.count} entries): the vault's events are scanned again in full, and the next round decides; nothing sent`,
    );
  }
  const sent = await keeperSend(deps, payoutsRequest(rec, key, list, stored, await deps.nonce("bittensor")));
  return withMessage(deps, sent, rec.plan.addresses.bitAdapter, "Bittensor → Base");
}

/** Claims the vault's rewards on its stake hotkey, only when the claim policy says so; otherwise refuses
 * with the policy's reason. Sent with a fixed gas limit the wallet must cover up front. */
export async function claim(deps: KeeperDeps, rec: KeeperTarget, policy: ClaimPolicy): Promise<Done> {
  rec.requireReady(deps.signer, deps);
  const r = await deps.readRewards();
  const d = decideClaim(r, policy);
  if (!d.claim) throw new Error(`not claiming: ${d.reason}; nothing sent`);
  const short = upfrontShortfall(r);
  if (short) throw new Error(short);
  return keeperSend(deps, claimRequest(rec, r.hotkey, claimGasLimit(r.claimGasRequired), await deps.nonce("bittensor")));
}

/** One user's delivery: sent, with the USDC from the front door's Delivered event, or skipped with why
 * (`refused`: the send's own estimate refused it after the simulation had passed, with its message). */
export type Delivery = { user: Address } & (({ delivered: true; usdcOut?: bigint } & Sent) | { delivered: false; reason: string; refused?: string });

/** Checks one user (decision, then simulation) and delivers when both pass. A revert in the simulation
 * or in the send's own estimate is a skip for a later round, never retried here. */
export async function deliver(deps: KeeperDeps, rec: KeeperTarget, user: Address): Promise<Delivery> {
  rec.requireReady(deps.signer, deps);
  const plan = rec.deliveryPlan();
  const c = await checkDelivery(deps, user);
  if (!c.deliver || c.keeperMinOut === undefined) return { user, delivered: false, reason: c.reason };
  let sent: Sent;
  try {
    sent = await keeperSend(deps, deliverRequest(plan, user, c.keeperMinOut, await deps.nonce("base")));
  } catch (e) {
    if (e instanceof SendRefused && e.reason === "estimate") {
      return { user, delivered: false, reason: `${e.message}; it waits for a later round`, refused: e.message };
    }
    throw e;
  }
  return { user, delivered: true, ...sent, usdcOut: deliveredFrom(sent.logs, plan.addresses.frontDoor, user)?.usdcOut };
}

/** Each user once, in order, each result handed to `report` as soon as it is known: a later user's
 * failure (which stops the loop) never hides a transaction already sent. */
export async function deliverAll(
  deps: KeeperDeps,
  rec: KeeperTarget,
  users: readonly Address[],
  report: (d: Delivery) => void = () => undefined,
): Promise<Delivery[]> {
  rec.requireReady(deps.signer, deps);
  rec.deliveryPlan();
  const out: Delivery[] = [];
  for (const user of users) {
    // the outside-price veto before each delivery: a fresh reading for each user, never one a sale before it moved
    deps.vetoAfresh?.();
    const d = await deliver(deps, rec, user);
    out.push(d);
    report(d);
  }
  return out;
}

/** One user's result as `pnpm ops deliver` prints it. */
export function deliveryLine(d: Delivery): string {
  if (!d.delivered) return `${d.user}: not delivered: ${d.reason}`;
  const got = d.usdcOut === undefined ? "" : `${formatUnits(d.usdcOut, 6)} USDC, `;
  return `${d.user}: delivered (${got}transaction ${d.hash}, cost ${formatEther(d.costWei)} ETH)`;
}

/** `pnpm ops deliver`: the named users, or every user who has redeemed, each delivered once with its
 * result printed as it happens. A failure stops the command (non-zero) after what was done is printed. */
export async function deliverCommand(deps: KeeperDeps, rec: KeeperTarget, users: readonly Address[], log: (line: string) => void): Promise<Delivery[]> {
  rec.deliveryPlan();
  const list = users.length ? users : await deps.deliveryCandidates();
  if (!list.length) log("No user has redeemed through the vault yet: nothing to deliver.");
  return deliverAll(deps, rec, list, (d) => log(deliveryLine(d)));
}

export function act(deps: KeeperDeps, rec: KeeperTarget, a: Exclude<Action, { kind: "deliver" } | { kind: "roll" }>, o: ActOptions = {}): Promise<Done> {
  if (a.kind === "close") return close(deps, rec);
  if (a.kind === "stake") return stake(deps, rec);
  // v3.2's park conversion: v3-launch has no park jobs (never decided there)
  if (a.kind === "convertPark") return Promise.reject(new Error("v3-launch has no park jobs; nothing sent"));
  // v3.2's park jobs, its notice's one close and its FAILURE re-executions (Task 52): never decided on v3-launch either
  if (a.kind === "park" || a.kind === "flush" || a.kind === "reexec") return Promise.reject(new Error("v3-launch has no park jobs or re-executions; nothing sent"));
  // v3.2's claims and adoption (Task 51): v3-launch's run never claims (never decided there); its claim is the hand command
  if (a.kind === "claim" || a.kind === "adopt") return Promise.reject(new Error("v3-launch's run never claims or adopts (claim by hand with pnpm ops claim); nothing sent"));
  // v3.2's hotkey watch (Task 53): never decided on v3-launch
  if (a.kind === "free") return Promise.reject(new Error("v3-launch's run never removes a hotkey; nothing sent"));
  return payouts(deps, rec, a.key, o);
}

