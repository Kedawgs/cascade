import { type Address, encodeEventTopics, formatEther, formatUnits, type Hex, parseAbi } from "viem";
import { CLAIM_POLICY, type ChainName, type ClaimPolicy, WALLET } from "../config.ts";
import { isPlanV3, type PlanV3, rolesOf } from "../plan.ts";
import { type DeploymentRecord, requireHandoff } from "../record.ts";
import { chainLabel, ReceiptTimeout, type Replacement, RevertedOnChain, type Sent, SendRefused } from "../send.ts";
import type { CallRequest } from "../types.ts";
import { checkDelivery, type DeliveryDeps, deliverRequest, deliveredFrom, explainDeliveryRevert } from "./delivery.ts";
import { type Action, actionKey, type DueDelivery, decideNext, type State } from "./due.ts";
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
import { claimGasLimit, claimRequest, decideClaim, type RewardsDeps, upfrontShortfall } from "./rewards.ts";
import { keeperMismatch } from "./signer.ts";
import type { StatusDetail } from "./status.ts";

export { KeeperHasCode } from "./failures.ts";

export type KeeperState = State & { detail: StatusDetail };

export type Message = { id: Hex; direction: "Base → Bittensor" | "Bittensor → Base"; hash: Hex };

/** A keeper transaction, with the bridge message it sent (close, payouts). */
export type Done = Sent & { messageId?: Hex };

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
   * without it, a transaction with no receipt is only logged. */
  receipt?(chain: ChainName, hash: Hex): Promise<{ reverted: boolean; logs: Sent["logs"] } | null>;
  /** Replaces the keeper's own transaction sent for `req` (one of `pending`: its hash, then each
   * replacement's, none with a receipt since) at the same nonce with a higher fee (send.ts replaceCall):
   * `run` does this to one stuck pending for REPLACE_AFTER_MS. Optional: without it, a stuck transaction
   * is only reported. */
  replace?(req: CallRequest, pending: readonly Hex[]): Promise<Replacement>;
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

/** Keeper sends need the whole deployment in place and its read-back passed; a launch, its hand-off
 * accepted by the final owners too; and `signer`, who the keeper commands sign as (keeperSigner), must be
 * the record's keeper. Refuses with KeeperNotReady, which stops `run`. */
export function requireReady(rec: DeploymentRecord, signer: Address = WALLET): void {
  const missing = rec.plan.steps.filter((s) => !rec.done[s.id]);
  if (missing.length || !rec.verify?.ok) {
    throw new KeeperNotReady(
      `the deployment is not complete and verified yet (${missing.length ? `${missing.length} step(s) to go` : "the read-back has not passed"}): run deploy, then verify`,
    );
  }
  try {
    requireHandoff(rec);
  } catch (e) {
    throw new KeeperNotReady((e as Error).message);
  }
  const keeper = rolesOf(rec.plan).keeper;
  if (keeper.toLowerCase() !== signer.toLowerCase()) throw new KeeperNotReady(keeperMismatch(keeper, signer));
}

/** Every keeper send goes through here. The keeper wallet is a plain account, with no code; code there
 * means its key has signed an EIP-7702 delegation (a thief's sweeper, as in the Binance hot-wallet drain)
 * or the address is a contract. Either way nothing is sent, and `run` stops. Its code is read on both
 * chains, the send's first, fresh before EVERY send (signerCode keeps nothing): a round with several
 * sends, each waiting for its receipt, can run for minutes, and a delegation landing after its first send
 * must stop its next. One key holds the address on both chains, a delegation can be signed for every
 * chain at once (chain id 0), and Bittensor may not run EIP-7702 at all, so code on either chain stops a
 * send on either. The refusal names the chain the code is on. */
async function keeperSend(deps: KeeperDeps, req: CallRequest): Promise<Sent> {
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
function recordSafely(deps: KeeperDeps, m: Message): void {
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

async function withMessage(deps: KeeperDeps, sent: Sent, adapter: Hex, direction: Message["direction"]): Promise<Done> {
  const messageId = messageIdFrom(sent.logs, adapter);
  if (messageId) recordSafely(deps, { id: messageId, direction, hash: sent.hash });
  return { ...sent, messageId };
}

const MIN_CLOSE_VALUE = 15n * 10n ** 14n;
/** The fee float for closeBatch: three times the live quote, at least 0.0015 ETH (the front door refunds the rest). */
export const closeValue = (quote: bigint) => (3n * quote > MIN_CLOSE_VALUE ? 3n * quote : MIN_CLOSE_VALUE);

export const closeRequest = (rec: DeploymentRecord, quote: bigint, nonce: number): CallRequest => ({
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
export const rollRequest = (rec: DeploymentRecord, nonce: number): CallRequest => ({
  chain: "base",
  nonce,
  label: "roll the empty open batch (restart its timer)",
  to: rec.plan.addresses.frontDoor,
  abi: KEEPER_ABI,
  functionName: "closeBatch",
  args: [],
});

export const stakeRequest = (rec: DeploymentRecord, nonce: number): CallRequest => ({
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
  rec: DeploymentRecord,
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

export async function close(deps: KeeperDeps, rec: DeploymentRecord): Promise<Done> {
  requireReady(rec, deps.signer);
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
export async function roll(deps: KeeperDeps, rec: DeploymentRecord): Promise<Rolled> {
  requireReady(rec, deps.signer);
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

export async function stake(deps: KeeperDeps, rec: DeploymentRecord): Promise<Done> {
  requireReady(rec, deps.signer);
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
export async function payouts(deps: KeeperDeps, rec: DeploymentRecord, key: Hex, o: { rescanned?: boolean } = {}): Promise<Done> {
  requireReady(rec, deps.signer);
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
export async function claim(deps: KeeperDeps, rec: DeploymentRecord, policy: ClaimPolicy): Promise<Done> {
  requireReady(rec, deps.signer);
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

/** The record's v3 plan; a v2 deployment has no USDC delivery. */
export function deliveryPlan(rec: DeploymentRecord): PlanV3 {
  if (!isPlanV3(rec.plan)) throw new Error("USDC delivery needs a v3 deployment (OPS_DEPLOYMENT=v3-…); this record's front door has none");
  return rec.plan;
}

/** Checks one user (decision, then simulation) and delivers when both pass. A revert in the simulation
 * or in the send's own estimate is a skip for a later round, never retried here. */
export async function deliver(deps: KeeperDeps, rec: DeploymentRecord, user: Address): Promise<Delivery> {
  requireReady(rec, deps.signer);
  const plan = deliveryPlan(rec);
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
  rec: DeploymentRecord,
  users: readonly Address[],
  report: (d: Delivery) => void = () => undefined,
): Promise<Delivery[]> {
  requireReady(rec, deps.signer);
  deliveryPlan(rec);
  const out: Delivery[] = [];
  for (const user of users) {
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
export async function deliverCommand(deps: KeeperDeps, rec: DeploymentRecord, users: readonly Address[], log: (line: string) => void): Promise<Delivery[]> {
  deliveryPlan(rec);
  const list = users.length ? users : await deps.deliveryCandidates();
  if (!list.length) log("No user has redeemed through the vault yet: nothing to deliver.");
  return deliverAll(deps, rec, list, (d) => log(deliveryLine(d)));
}

export function act(deps: KeeperDeps, rec: DeploymentRecord, a: Exclude<Action, { kind: "deliver" } | { kind: "roll" }>, o: { rescanned?: boolean } = {}): Promise<Done> {
  if (a.kind === "close") return close(deps, rec);
  if (a.kind === "stake") return stake(deps, rec);
  return payouts(deps, rec, a.key, o);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Logs whether a reward claim is due when that changes; run never claims, and a failed read only waits. */
async function reportClaim(deps: KeeperDeps, policy: ClaimPolicy, live: boolean, last: boolean | undefined): Promise<boolean | undefined> {
  try {
    const d = decideClaim(await deps.readRewards(), policy);
    if (d.claim !== last) {
      deps.log(
        d.claim
          ? `Rewards: a claim is due (${d.reason}). run never claims: claim by hand with pnpm ops claim${live ? " --live" : ""}`
          : `Rewards: no claim due (${d.reason})`,
      );
    }
    return d.claim;
  } catch (e) {
    deps.log(`Could not read the rewards (${(e as Error).message}); trying again later`);
    return last;
  }
}

/** How a run ended: it stopped itself, on a failure classifyFailure says must stop it (or one that kept
 * repeating), or its rounds ran out (`maxTicks`, which only tests set). */
export type LoopEnd = { stopped: false } | { stopped: true; kind: FailureKind; reason: string };

/** What an action is doing, for a log line. */
function doing(a: Action): string {
  switch (a.kind) {
    case "close":
      return "closing the batch";
    case "roll":
      return "rolling the empty batch";
    case "stake":
      return "staking";
    case "payouts":
      return `paying out batch ${a.key.slice(0, 10)}…`;
    case "deliver":
      return `delivering to ${a.user}`;
  }
}

/** An action another caller (or a pause) can beat: re-read after it reverts on chain. */
type Racing = Exclude<Action, { kind: "deliver" }>;

/** Why a close, roll, payout or stake that reverted on chain lost a race, from the chains as read after
 * it (`before`: the round's read): a pause, another close or an entry landing first, another caller
 * paying the batch out (processPayouts and closeBatch are anyone's), or the idle TAO gone. Undefined when
 * nothing explains it: the revert, with its transaction hash, then stops the keeper. */
export function explainRace(a: Racing, before: KeeperState, after: KeeperState): string | undefined {
  if (a.kind === "close" || a.kind === "roll") {
    const fd = after.frontDoor;
    if (fd.paused) return "the front door was paused";
    if (!after.alphaVault.healthy) return "AlphaVault was paused or began migrating";
    const moved = fd.openStart !== before.frontDoor.openStart || !fd.canClose;
    if (a.kind === "roll") return moved || fd.nDeposits + fd.nRedeems > 0 ? "an entry or another close landed first" : undefined;
    return moved || fd.nDeposits + fd.nRedeems === 0 ? "another close landed first" : undefined;
  }
  if (after.vault.paused) return "the vault was paused";
  if (a.kind === "payouts") {
    if (!after.alphaVault.healthy) return "AlphaVault was paused or began migrating";
    const batch = (s: KeeperState) => s.vault.batches.find((b) => b.key.toLowerCase() === a.key.toLowerCase());
    const was = batch(before);
    const now = batch(after);
    if (!now || now.cursor >= now.count || (was && now.cursor !== was.cursor)) return "another caller paid this batch out first";
    return undefined;
  }
  if (after.vault.available < after.vault.minStakeWei) return "the idle TAO is no longer above the staking floor";
  return undefined;
}

/** How long a held delivery waits at most before it is tried again on the same facts. */
export const HOLD_MS = 30 * 60_000;
/** A user's revert budget: this many of their deliveries reverted on chain within REVERT_WINDOW_MS,
 * explained (a price race, a preference they changed under the send) or not, and that user's delivery
 * is held for REVERT_HOLD_MS, whatever their facts do; each time the budget runs out again within the
 * window the hold doubles, up to REVERT_HOLD_MAX_MS. Each reverted delivery costs the keeper a Base
 * transaction's gas, so a floor that sits at the market price, or a user changing their preference once
 * a round, is allowed two a day and then waits; the user can claim by hand at any time. One user's
 * reverts never stop the keeper, whose other work goes on. */
export const REVERT_BUDGET = 2;
export const REVERT_WINDOW_MS = 24 * 3600_000;
export const REVERT_HOLD_MS = 6 * 3600_000;
export const REVERT_HOLD_MAX_MS = 48 * 3600_000;
/** The circuit breaker: a close, stake or payout refused this many rounds in a row (by its simulation,
 * or by its own re-read of the chain) is skipped, so the actions behind it (other payouts, deliveries,
 * the stake, the close) go ahead, and it is tried again SKIP_MS later, doubling each time it is refused
 * again, up to SKIP_MAX_MS. A refused simulation sends nothing, so skipping it can never send twice. */
export const MAX_REFUSALS = 3;
export const SKIP_MS = 5 * 60_000;
export const SKIP_MAX_MS = 60 * 60_000;

const hours = (ms: number) => `${Number((ms / 3600_000).toFixed(1))} hour${ms === 3600_000 ? "" : "s"}`;
/** A clock time for the log: "2027-01-18 14:05 UTC". */
const at = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** How long a transaction with no receipt is watched for (from when the keeper stopped waiting for its
 * receipt) before it is reported as probably dropped: long after its last replacement would have gone. */
export const LATE_RECEIPT_MS = 6 * 3600_000;
/** How long after the keeper stopped waiting for its receipt (a 5-minute wait at the send) the keeper's
 * own transaction stays pending before it is replaced at the same nonce with a higher fee (deps.replace):
 * a slow block is not a stuck transaction. A replacement that is stuck in turn is replaced after twice as
 * long, and so on, MAX_REPLACEMENTS times; each is said loudly (REPLACING). Until then the wallet's
 * guard holds the chain's sends, as before. */
export const REPLACE_AFTER_MS = 15 * 60_000;
export const MAX_REPLACEMENTS = 3;

/** A transaction sent with no receipt yet: its hash, and each replacement's, looked up each round until
 * one of them has a receipt (any of them landing ends the watch), or something else is mined at its
 * nonce; replaced at that nonce once it has been pending REPLACE_AFTER_MS (when the deps can, and the
 * call it carries is known). */
interface Unreceipted {
  /** The original's hash, then each replacement's, in order */
  hashes: Hex[];
  chain: ChainName;
  what: string;
  /** Where its bridge message, if it sent one, is read from */
  message?: { adapter: Hex; direction: Message["direction"] };
  /** The call it carries, for a replacement; unset for one the keeper can't rebuild */
  request?: CallRequest;
  /** When the keeper stopped waiting for its receipt (by the clock), how many replacements have been
   * sent, and when it is next replaced */
  since: number;
  replacements: number;
  replaceAt: number;
  /** Rounds in a row the wallet's mined nonce has been past the call's with none of the hashes mined */
  passed: number;
}

export interface RunOptions {
  intervalMs: number;
  maxTicks?: number;
  policy?: ClaimPolicy;
  rewardsEveryTicks?: number;
  live?: boolean;
  /** The longest wait between failed rounds (default 5 minutes; never less than the interval) */
  maxBackoffMs?: number;
  /** Failed rounds, or skips of one action, in a row after which each line starts STILL FAILING (default 10) */
  stillFailingAfter?: number;
  /** Rounds in a row failed on something unexpected after which the run stops (default 30) */
  maxUnexpectedRounds?: number;
  /** For tests: how the run waits between rounds, and its clock (ms) */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Does the next due thing every `intervalMs` until it stops itself. A delivery goes ahead only when its
 * simulation passes; one that would revert waits (its reason logged once) without holding up anything
 * else. A delivery that isn't sent (its re-check, its estimate or the wallet's guard refuses it), or that
 * reverts on chain, never ends the round: the round's payout, stake or close still goes ahead. One whose
 * estimate refuses it, or that reverted, is held, not retried, until the user's claimable amount,
 * preference, or the quote against the floors changes, or for 30 minutes (HOLD_MS). A reverted delivery
 * is explained by its decoded revert (a price race, the user's own change) or by re-checking the user;
 * one its simulation still passes on, on the same facts, with nothing to explain it, fails the round (the
 * log shows it) and is held too. Every reverted delivery counts against that user's revert budget
 * (REVERT_BUDGET within REVERT_WINDOW_MS): over it, that user is held for hours, said loudly, whatever
 * their facts do. No delivery ever stops the run: only states unsafe for everyone do. Reward claims are
 * only reported, every `rewardsEveryTicks` rounds. Each round starts by re-reading the record
 * (`deps.refresh`, onto `rec`, the record the deps were made with), so a read-back that failed since the
 * run started stops its sends.
 *
 * A failure inside a round ends that round, never the run, unless classifyFailure says it must stop it
 * (a keeper wallet found with code at any send, a delivery's too; a wrong key; the record not ready or
 * replaced; a payout list that doesn't match the vault's; a revert nothing explains), or 30 rounds in a
 * row fail on something unexpected: then the run logs "Stopped: <why>" and returns. Any other failure (a
 * race lost to another caller or a user, a pending transaction, an RPC fault) is logged on one line and
 * the next round decides again, after a wait that doubles with each failed round in a row (nextWaitMs);
 * from `stillFailingAfter` failed rounds in a row the line starts STILL FAILING, as does a skip of one
 * action (a lost race, a delivery the wallet's guard refuses) that many rounds in a row. A close, stake
 * or payout refused MAX_REFUSALS rounds in a row (its simulation, or its own re-read, saying no) trips
 * the circuit breaker: it is skipped, said loudly (SKIPPING), the round moves on to the next due action,
 * and it is tried again on a back-off (SKIP_MS, doubling to SKIP_MAX_MS), so one refused action never
 * starves the ones behind it. Nothing is ever
 * retried within the round that failed: a transaction with no receipt may still be pending, and the next
 * round's send guard refuses every send until it is mined or dropped; its receipt is looked up each
 * round, and a bridge message it sent is recorded once it lands. One still pending REPLACE_AFTER_MS after
 * it was sent is replaced at the same nonce with a higher fee (the same call if it still passes, else a
 * cancel), said loudly (REPLACING), at most MAX_REPLACEMENTS times with doubling waits: two transactions
 * at one nonce can't both be mined, so that never doubles a send. A close, roll, payout or stake that
 * reverts on chain is re-read first: a lost race is a skip; when that read fails, the next round's read
 * decides. Every line is logged with any URL's secrets stripped (scrubSecrets). */
export async function runLoop(deps: KeeperDeps, rec: DeploymentRecord, opts: RunOptions): Promise<LoopEnd> {
  const log = (line: string) => deps.log(scrubSecrets(line));
  const clock = opts.now ?? Date.now;
  const stillFailingAfter = opts.stillFailingAfter ?? 10;
  /** The last wait logged for each user, so each reason is logged once. */
  const waiting = new Map<string, string>();
  /** Deliveries held after a refused estimate or a revert: why, the facts they were held on (unset: a
   * timed hold that no change in the facts ends), and when the hold ends. */
  const held = new Map<string, { reason: string; facts?: string; until: number }>();
  /** Each user's reverted deliveries (when, by the clock) within REVERT_WINDOW_MS, the holds their budget
   * has cost in a row, and when the last of those ends. */
  const reverts = new Map<string, { at: number[]; strikes: number; holdEnd: number }>();
  /** How many rounds in a row each kind of skip has happened, and the ones this round. */
  const skipRuns = new Map<string, number>();
  let skippedNow = new Set<string>();
  /** The circuit breaker: each close, stake or payout's refusals in a row (by actionKey), the back-off
   * its last skip cost, and when it is tried again; and the ones refused this round. */
  const refusals = new Map<string, { n: number; backoffMs: number; until: number }>();
  let refusedNow = new Set<string>();
  /** A revert whose re-read failed: the next round's read decides. */
  let unread: { action: Racing; before: KeeperState; revert: RevertedOnChain } | undefined;
  let unreceipted: Unreceipted[] = [];
  let claimDue: boolean | undefined;

  const waits = (user: Address, reason: string) => {
    const key = user.toLowerCase();
    if (waiting.get(key) === reason) return;
    log(`Delivery to ${user} waits: ${reason}`);
    waiting.set(key, reason);
  };
  /** A skip of `key` this round, said as `line` (or by `quietly`); from `stillFailingAfter` rounds in a
   * row, loudly, every round. */
  const skipped = (key: string, what: string, line: string, quietly: () => void = () => log(line)) => {
    if (!skippedNow.has(key)) {
      skippedNow.add(key);
      skipRuns.set(key, (skipRuns.get(key) ?? 0) + 1);
    }
    const n = skipRuns.get(key) ?? 1;
    if (n >= stillFailingAfter) log(`STILL FAILING (${n} rounds; ${what}): ${line}`);
    else quietly();
  };
  const notDone = (a: Racing, why: string, hash: Hex) =>
    skipped(`not-done:${a.kind}`, doing(a), `Not done: ${why}; the transaction reverted on chain (transaction ${hash}); the next round decides again`);
  /** Holds a user's delivery for `forMs` (HOLD_MS), or until their `facts` change when those are given. */
  const hold = (key: string, reason: string, facts?: string, forMs = HOLD_MS) => held.set(key, { reason, facts, until: clock() + forMs });
  /** Counts a reverted delivery of `key`'s against the user's budget: how many fell within the window,
   * and the hold that costs (0 while within budget). Each hold within a window of the last one's end
   * doubles the one before; a window with no hold starts them again at REVERT_HOLD_MS. */
  function overBudget(key: string): { within: number; holdMs: number } {
    const now = clock();
    const r = reverts.get(key) ?? { at: [], strikes: 0, holdEnd: Number.NEGATIVE_INFINITY };
    r.at = [...r.at.filter((t) => now - t < REVERT_WINDOW_MS), now];
    reverts.set(key, r);
    if (r.at.length < REVERT_BUDGET) return { within: r.at.length, holdMs: 0 };
    if (now >= r.holdEnd + REVERT_WINDOW_MS) r.strikes = 0;
    r.strikes++;
    const holdMs = Math.min(REVERT_HOLD_MS * 2 ** (r.strikes - 1), REVERT_HOLD_MAX_MS);
    r.holdEnd = now + holdMs;
    return { within: r.at.length, holdMs };
  }
  /** Holds `user`'s delivery for the budget's hold, whatever their facts do, and says so loudly. */
  function heldLoudly(user: Address, budget: { within: number; holdMs: number }, last: string) {
    const until = clock() + budget.holdMs;
    hold(user.toLowerCase(), `held until ${at(until)}: ${budget.within} of this user's deliveries reverted on chain within ${hours(REVERT_WINDOW_MS)}`, undefined, budget.holdMs);
    log(
      `DELIVERY HELD: deliver to ${user} reverted on chain ${budget.within} times within ${hours(REVERT_WINDOW_MS)} (the last: ${last}); held ${hours(budget.holdMs)}, until ${at(until)}, whatever the price or the preference does; the user can claim by hand meanwhile, and the keeper's other work goes on`,
    );
  }

  /** A refusal of `a` (its simulation, or its own re-read, said no): counted; from MAX_REFUSALS in a row,
   * the breaker trips and returns true: `a` is skipped for a back-off (said loudly) and the round moves on
   * to the next due action. Before that, false: the round fails on it as before. */
  function tripped(a: Racing, e: SendRefused | NotNow): boolean {
    const key = actionKey(a);
    refusedNow.add(key);
    const r = refusals.get(key) ?? { n: 0, backoffMs: 0, until: 0 };
    r.n++;
    refusals.set(key, r);
    if (r.n < MAX_REFUSALS) return false;
    r.backoffMs = Math.min(Math.max(r.backoffMs * 2, SKIP_MS), SKIP_MAX_MS);
    r.until = clock() + r.backoffMs;
    // "times", not rounds: from the third on, the tries are a back-off apart
    log(
      `${r.backoffMs >= SKIP_MAX_MS ? "STILL SKIPPING" : "SKIPPING"} ${doing(a)}: refused ${r.n} times in a row (${classifyFailure(e).label}: ${oneLine(e.message)}); the keeper's other actions go ahead; tried again in ${inWords(r.backoffMs)}, at ${at(r.until)}`,
    );
    return true;
  }
  /** The actions the breaker holds back now (their back-off still running). */
  const skippedKeys = () => new Set([...refusals].filter(([, r]) => r.n >= MAX_REFUSALS && clock() < r.until).map(([k]) => k));
  /** The chain, or the keeper's own re-read of it, saying no to a send: its simulation, a gas price over
   * the cap, or NotNow. */
  const refused = (e: unknown): e is SendRefused | NotNow => (e instanceof SendRefused && (e.reason === "estimate" || e.reason === "fee")) || e instanceof NotNow;

  /** A close, roll, payout or stake that reverted on chain: true when the chains, read again, show it lost
   * a race (a skip). Nothing explaining it throws the revert (which stops the run); a read that fails
   * throws RevertUnread, and the next round's read decides. Anything else: false. */
  async function raced(e: unknown, a: Racing, before: KeeperState): Promise<boolean> {
    if (!(e instanceof RevertedOnChain)) return false;
    let after: KeeperState;
    try {
      after = await deps.readState();
    } catch (readError) {
      unread = { action: a, before, revert: e };
      throw new RevertUnread(e, readError);
    }
    const why = explainRace(a, before, after);
    if (!why) throw e;
    notDone(a, why, e.hash);
    return true;
  }

  /** A transaction sent with no receipt: its receipt is looked up in later rounds. */
  function watch(a: Action, e: ReceiptTimeout) {
    if (!e.hash) return;
    const message =
      a.kind === "close" || a.kind === "roll"
        ? { adapter: rec.plan.addresses.baseAdapter, direction: "Base → Bittensor" as const }
        : a.kind === "payouts"
          ? { adapter: rec.plan.addresses.bitAdapter, direction: "Bittensor → Base" as const }
          : undefined;
    const now = clock();
    unreceipted.push({ hashes: [e.hash], chain: e.chain, what: doing(a), message, request: e.request, since: now, replacements: 0, replaceAt: now + REPLACE_AFTER_MS, passed: 0 });
  }

  /** Reports a transaction of the keeper's that went through late (a late receipt, a replacement), and
   * records its bridge message. */
  function landed(u: Unreceipted, hash: Hex, logs: Sent["logs"], how: string) {
    const id = u.message ? messageIdFrom(logs, u.message.adapter) : undefined;
    if (id && u.message) recordSafely(deps, { id, direction: u.message.direction, hash });
    log(`${how}: ${u.what} went through (transaction ${hash}${id ? `, bridge message ${id}` : ""})`);
  }

  /** Reports a transaction of the keeper's that reverted on chain late (a late receipt, a replacement).
   * A delivery's counts against that user's revert budget, as a revert at the send does (the facts it
   * was sent on are gone, so within budget it is held on time alone). */
  function revertedLate(u: Unreceipted, hash: Hex, how: string, reason?: string) {
    const said = `${how}: ${u.what} reverted on chain (transaction ${hash}${reason ? `, ${reason}` : ""})`;
    const req = u.request;
    if (req?.functionName !== "deliver") {
      log(said);
      return;
    }
    const user = req.args[0] as Address;
    const budget = overBudget(user.toLowerCase());
    const why = explainDeliveryRevert(reason);
    if (budget.holdMs) {
      heldLoudly(user, budget, `transaction ${hash}${reason ? `, ${reason}` : ""}${why ? `: ${why}` : ""}`);
      return;
    }
    hold(user.toLowerCase(), `${said}; held for 30 minutes`);
    log(`${said}${why ? `: ${why}` : ""}; held for 30 minutes (${budget.within} of ${REVERT_BUDGET} in this user's revert budget)`);
  }

  /** Replaces `u`, pending for REPLACE_AFTER_MS with no receipt, at its nonce with a higher fee (the same
   * call if it still passes, else a cancel): said loudly, and through the guards every send passes
   * first (the record still ready, the wallet still without code: a failure of those stops the run, as
   * at any send). A replacement that lands ends the watch on `u` (nothing else can be mined at that
   * nonce); one with no receipt in its turn is watched with the original, and replaced again after twice
   * as long; one the node refuses leaves `u` watched. */
  async function replacePending(u: Unreceipted, still: Unreceipted[]) {
    const req = u.request as CallRequest;
    const latest = u.hashes.at(-1) as Hex;
    log(
      `REPLACING transaction ${latest} (${u.what}, nonce ${req.nonce}): no receipt ${inWords(clock() - u.since)} after the keeper stopped waiting for one, so it is sent again at the same nonce with a higher fee (the same call if it still passes, else a cancel that only frees the nonce)${u.replacements ? `; replacement ${u.replacements + 1} of ${MAX_REPLACEMENTS}` : ""}`,
    );
    let r: Replacement;
    try {
      requireReady(rec, deps.signer);
      await assertNoCode(deps, req.chain);
      // every hash: the pool may have evicted a later replacement and still hold the original
      r = await (deps.replace as NonNullable<KeeperDeps["replace"]>)(req, [...u.hashes]);
    } catch (e) {
      if (e instanceof ReceiptTimeout && e.hash) {
        log(`Replacement sent, no receipt yet: transaction ${e.hash} (${u.what}, nonce ${req.nonce}) is watched with the original: whichever lands ends the watch`);
        u.hashes.push(e.hash);
        u.replacements++;
        u.replaceAt = clock() + REPLACE_AFTER_MS * 2 ** u.replacements;
        still.push(u);
        return;
      }
      if (e instanceof RevertedOnChain) {
        // its estimate passed seconds before: a race, and nonce req.nonce is free; the next round decides
        revertedLate(u, e.hash, "Replacement", e.reason);
        return;
      }
      // a keeper wallet with code, a record no longer ready, a wrong key or chain: the round fails on it, and stops
      if (classifyFailure(e).stop) throw e;
      log(`Replacement not sent (${oneLine((e as Error).message)}); the watch goes on, tried again in ${inWords(REPLACE_AFTER_MS)}`);
      u.replaceAt = clock() + REPLACE_AFTER_MS;
      still.push(u);
      return;
    }
    if (!r.replaced) {
      log(`Not replaced: ${r.reason}; the watch goes on (a receipt, or the wallet's nonce passing it, ends it), tried again in ${inWords(REPLACE_AFTER_MS)}`);
      u.replaceAt = clock() + REPLACE_AFTER_MS;
      still.push(u);
      return;
    }
    if (r.cancelled) log(`Replaced: ${u.what} was cancelled at nonce ${req.nonce} (transaction ${r.hash}); the next round decides again`);
    else landed(u, r.hash, r.logs, "Replaced");
  }

  /** Looks up each transaction still with no receipt, by every hash it has (the original's and each
   * replacement's): one that landed is reported (its bridge message recorded) and ends the watch; so
   * does the wallet's mined nonce passing the call's, two rounds in a row, with none of them mined
   * (something else took the nonce); one pending REPLACE_AFTER_MS whose call is known is replaced
   * (replacePending); one with none after LATE_RECEIPT_MS is reported as probably dropped. A failure
   * that must stop the run (a replacement's guards) comes back as the round's. */
  async function lookUpReceipts(): Promise<{ error: unknown; doing: string } | undefined> {
    if (!deps.receipt) {
      unreceipted = [];
      return undefined;
    }
    const still: Unreceipted[] = [];
    let failure: { error: unknown; doing: string } | undefined;
    for (const u of unreceipted) {
      if (failure) {
        still.push(u);
        continue;
      }
      let found: { hash: Hex; reverted: boolean; logs: Sent["logs"] } | undefined;
      let unread = false;
      for (const hash of u.hashes) {
        try {
          const r = await deps.receipt(u.chain, hash);
          if (r) {
            found = { hash, ...r };
            break;
          }
        } catch {
          unread = true;
        }
      }
      if (found) {
        if (found.reverted) revertedLate(u, found.hash, "Late receipt");
        else landed(u, found.hash, found.logs, "Late receipt");
        continue;
      }
      if (unread) {
        still.push(u);
        continue;
      }
      if (u.request && deps.minedNonce) {
        // twice in a row: a node a block behind the one that answered the receipts can't end a watch early
        let mined: number | undefined;
        try {
          mined = await deps.minedNonce(u.chain);
        } catch {
          // the next round asks again
        }
        u.passed = mined !== undefined && mined > u.request.nonce ? u.passed + 1 : 0;
        if (u.passed >= 2) {
          log(
            `Watch ended: something else was mined at nonce ${u.request.nonce} on ${chainLabel(u.chain)} (the wallet's mined nonce is ${mined}), and none of transaction${u.hashes.length === 1 ? "" : "s"} ${u.hashes.join(", ")} (${u.what}) has a receipt: check them on the chain's explorer${u.message ? "; if one went through, find its bridge message with pnpm ops status" : ""}`,
          );
          continue;
        }
      }
      if (deps.replace && u.request && u.replacements < MAX_REPLACEMENTS && clock() >= u.replaceAt) {
        try {
          await replacePending(u, still);
        } catch (e) {
          failure = { error: e, doing: `replacing ${u.what}` };
          still.push(u);
        }
        continue;
      }
      if (clock() - u.since < LATE_RECEIPT_MS) still.push(u);
      else {
        log(
          `NO RECEIPT ${hours(LATE_RECEIPT_MS)} after the keeper stopped waiting for one: transaction${u.hashes.length === 1 ? "" : "s"} ${u.hashes.join(", ")} (${u.what}) probably dropped, or sit on a node this one can't see. Check them on the chain's explorer${u.message ? "; if one went through, find its bridge message with pnpm ops status" : ""}`,
        );
      }
    }
    unreceipted = still;
    return failure;
  }

  /** One round. A failure comes back, with what the round was doing then (and, for a refusal of a close,
   * stake or payout that didn't trip the breaker, that action's key), instead of being thrown; an
   * unexplained delivery revert comes back once the round's other action is done. */
  async function round(tick: number): Promise<{ error: unknown; doing: string; refusal?: string } | undefined> {
    // the record as it is now: a read-back that failed since the run started stops its sends
    try {
      deps.refresh();
    } catch (e) {
      return { error: e, doing: "re-reading the record" };
    }
    // the transactions still waited on, before the chains are read for the round: a stuck one is looked
    // up and replaced whether or not the round's read goes through
    const looked = await lookUpReceipts();
    if (looked) return looked;
    let s: KeeperState;
    try {
      s = await deps.readState({ economics: true });
    } catch (e) {
      // a revert the last round couldn't explain, and the chains still can't be read: the revert stops it
      if (unread) return { error: unread.revert, doing: `${doing(unread.action)}, read again` };
      return { error: e, doing: "reading the chains" };
    }
    if (unread) {
      const u = unread;
      unread = undefined;
      const why = explainRace(u.action, u.before, s);
      if (!why) return { error: u.revert, doing: `${doing(u.action)}, read again` };
      notDone(u.action, why, u.revert.hash);
    }
    let deliveries: DueDelivery[] = [];
    const facts = new Map<string, string | undefined>();
    try {
      for (const user of await deps.deliveryCandidates()) {
        const c = await checkDelivery(deps, user);
        const key = c.user.toLowerCase();
        facts.set(key, c.facts);
        const h = held.get(key);
        if (h && ((h.facts !== undefined && c.facts !== undefined && h.facts !== c.facts) || clock() >= h.until)) held.delete(key);
        if (c.claimable === 0n) {
          waiting.delete(key);
          continue;
        }
        const hold = held.get(key);
        if (c.deliver && c.keeperMinOut !== undefined && !hold) deliveries.push({ user: c.user, keeperMinOut: c.keeperMinOut });
        else waits(c.user, c.deliver && hold ? hold.reason : c.reason);
      }
    } catch (e) {
      return { error: e, doing: "reading the chains" };
    }
    if (tick === 1 || tick % (opts.rewardsEveryTicks ?? 30) === 0) {
      claimDue = await reportClaim(deps, opts.policy ?? CLAIM_POLICY, opts.live ?? false, claimDue);
    }
    /** An unexplained delivery revert: the round fails once its other action is done. */
    let soft: { error: unknown; doing: string } | undefined;
    let step = "deciding what is due";
    let current: Action | undefined;
    /** The action whose refusal, short of tripping the breaker, fails this round */
    let refusalOf: string | undefined;
    /** What the breaker holds back this round, and whatever trips it during the round. */
    const skip = skippedKeys();
    try {
      for (;;) {
        const next = decideNext({ ...s, deliveries, skipped: skip });
        const action = next.action;
        if (!action) {
          log(next.reason);
          break;
        }
        current = action;
        step = doing(action);
        if (action.kind === "roll") {
          // a roll that can't go ahead now is only a skip: the round ends, the next one decides again
          let r: Rolled;
          try {
            r = await roll(deps, rec);
          } catch (e) {
            if (await raced(e, action, s)) break;
            throw e;
          }
          if (!r.rolled) skipped("not-rolled", step, `Not rolled: ${r.reason}`);
          else if (r.messageId) {
            log(
              `Done: the open batch closed instead of rolling: an entry landed first and its fee pot paid the bridge (transaction ${r.hash}, bridge message ${r.messageId})`,
            );
          } else log(`Done: ${next.reason} (transaction ${r.hash})`);
          break;
        }
        if (action.kind !== "deliver") {
          let done: Done;
          try {
            done = await act(deps, rec, action, { rescanned: action.kind === "payouts" && rescannedPayout === action.key.toLowerCase() });
          } catch (e) {
            if (await raced(e, action, s)) break;
            // refused MAX_REFUSALS times in a row: skipped, and the round moves on to the next due action
            // (nothing was sent, so nothing can be sent twice); before that, the round fails on it
            if (refused(e)) {
              if (tripped(action, e)) {
                skip.add(actionKey(action));
                continue;
              }
              refusalOf = actionKey(action);
            }
            throw e;
          }
          refusals.delete(actionKey(action));
          log(`Done: ${next.reason} (transaction ${done.hash}${done.messageId ? `, bridge message ${done.messageId}` : ""})`);
          break;
        }
        // whatever becomes of this delivery, the round's next action comes after it, never instead
        deliveries = deliveries.filter((d) => d.user !== action.user);
        const key = action.user.toLowerCase();
        const f = facts.get(key);
        let d: Delivery;
        try {
          d = await deliver(deps, rec, action.user);
        } catch (e) {
          if (e instanceof RevertedOnChain) {
            // mined and reverted, so nothing is pending. Held at once, whatever the re-check finds (or if
            // it fails): a reverted delivery is never sent again blindly
            hold(key, `${e.message}; held while it is checked again`, f ?? "");
            const budget = overBudget(key);
            // the decoded revert first (a price race, the user's own change); else the user re-read
            let why = explainDeliveryRevert(e.reason);
            if (!why) {
              const again = await checkDelivery(deps, action.user);
              if (!again.deliver) why = again.reason;
              else if (again.facts !== f) why = "the user's claimable amount, preference or quote changed";
            }
            if (budget.holdMs) {
              // over budget, explained or not: this user waits, whatever the price or their preference
              // does, and the keeper's other work goes on. Said loudly every time
              heldLoudly(action.user, budget, `transaction ${e.hash}${e.reason ? `, ${e.reason}` : ""}${why ? `: ${why}` : ", and nothing explains it"}`);
              continue;
            }
            if (why) {
              const reason = `${e.message}: ${why}; not retried until the claimable amount, the preference or the quote against the floors changes, or for 30 minutes`;
              hold(key, reason, f ?? "");
              waits(action.user, reason);
              continue;
            }
            // its simulation still passes on the same facts, and the revert decodes to nothing that
            // explains it: the round fails on it (so the log shows it), and this user is held; never a stop
            hold(key, `${e.message}, while its simulation still passes on the same facts; held for 30 minutes, or until the user's facts change`, f ?? "");
            soft = { error: new DeliveryReverted(action.user, e), doing: step };
            continue;
          }
          if (e instanceof SendRefused && !classifyFailure(e).stop) {
            // the wallet's guard (an earlier transaction pending, the nonce): not this user's facts, so
            // tried again next round. A wrong key or chain stops the run, as at any send
            const said = `${e.message}; it is tried again next round`;
            skipped(`deliver:${key}`, step, said, () => waits(action.user, said));
            continue;
          }
          throw e;
        }
        if (d.delivered) {
          waiting.delete(key);
          reverts.delete(key);
          const got = d.usdcOut === undefined ? "" : `, ${Number(d.usdcOut) / 1e6} USDC`;
          log(`Done: ${next.reason} (transaction ${d.hash}${got})`);
          break;
        }
        if (d.refused !== undefined && f !== undefined) {
          const reason = `${d.refused}; not retried until the claimable amount, the preference or the quote against the floors changes, or for 30 minutes`;
          hold(key, reason, f);
          waits(action.user, reason);
        } else {
          waits(action.user, d.reason);
        }
      }
    } catch (e) {
      if (e instanceof ReceiptTimeout && current) watch(current, e);
      return { error: e, doing: step, refusal: refusalOf };
    }
    return soft;
  }

  const maxUnexpected = opts.maxUnexpectedRounds ?? 30;
  const pause = opts.sleep ?? sleep;
  /** Failed rounds in a row, and those failed on something unexpected */
  let failing = 0;
  let unexpected = 0;
  /** The failed rounds in a row so far: whether every one was a refusal of a close, stake or payout
   * short of tripping the breaker, and of which */
  let streak = { refusalsOnly: true, keys: new Set<string>() };
  /** The payout whose list the last round set to be rebuilt from a second scan of the vault's events */
  let rescannedPayout: string | undefined;
  for (let tick = 1; ; tick++) {
    const failure = await round(tick);
    rescannedPayout = failure?.error instanceof PayoutListRescan ? failure.error.key.toLowerCase() : undefined;
    // a skip that didn't happen this round starts its count again
    for (const key of [...skipRuns.keys()]) if (!skippedNow.has(key)) skipRuns.delete(key);
    skippedNow = new Set();
    // an action neither refused this round nor still held back by the breaker (it went through, or is no
    // longer due) starts its refusals again
    for (const [key, r] of [...refusals]) if (!refusedNow.has(key) && !(r.n >= MAX_REFUSALS && clock() < r.until)) refusals.delete(key);
    refusedNow = new Set();
    const f = failure && classifyFailure(failure.error);
    unexpected = f?.kind === "unexpected" ? unexpected + 1 : 0;
    if (f && (f.stop || unexpected >= maxUnexpected)) {
      const reason = f.stop ? f.message : `${unexpected} rounds in a row failed on something unexpected; the last: ${f.message}`;
      log(`Stopped: ${oneLine(reason)}`);
      return { stopped: true, kind: f.kind, reason };
    }
    if (f) {
      failing++;
      if (failure?.refusal) streak.keys.add(failure.refusal);
      else streak.refusalsOnly = false;
    } else if (failing) {
      // rounds that failed only on refusals of an action the breaker has since skipped: SKIPPING said
      // what happened, and nothing recovered
      const skippedSince = streak.refusalsOnly && [...streak.keys].every((k) => (refusals.get(k)?.n ?? 0) >= MAX_REFUSALS);
      if (!skippedSince) log(`Recovered after ${failing} failed round${failing === 1 ? "" : "s"}`);
      failing = 0;
      streak = { refusalsOnly: true, keys: new Set() };
    }
    const wait = nextWaitMs(opts.intervalMs, failing, opts.maxBackoffMs);
    if (failure && f) {
      const head = failing >= stillFailingAfter ? `STILL FAILING (${failing} rounds; ` : "Failed this round (";
      log(`${head}${f.label}, ${failure.doing}): ${oneLine(f.message)}; next round in ${inWords(wait)}`);
    }
    if (opts.maxTicks && tick >= opts.maxTicks) return { stopped: false };
    await pause(wait);
  }
}

/** `pnpm ops run`'s exit code when the keeper stops itself (classifyFailure) or refuses to start. The
 * supervisor (ops/scripts/keeper-supervised.ps1) restarts the keeper after any other non-zero exit, never
 * after this one with STOPPED_BANNER printed: what stopped it needs a person. */
export const KEEPER_STOPPED = 3;

/** How the line `run` prints with exit code 3 starts: the supervisor's proof that the 3 is the keeper's
 * own stop, not a code cmd or pnpm returned. */
export const STOPPED_BANNER = "THE KEEPER STOPPED ITSELF";

const stoppedBanner = (reason: string) =>
  `${STOPPED_BANNER}: ${oneLine(reason, 240)} (exit code ${KEEPER_STOPPED}: the supervisor won't restart it). Fix that, then start it again.`;

/** `pnpm ops run`: `start` loads the record, takes the deployment's run lock and checks the keeper's key
 * (and may log), then the loop runs until it stops itself. A start it refuses (no record, another keeper
 * running, a bad setting, a wrong key) and every stop the loop makes are deliberate: said loudly, exit
 * KEEPER_STOPPED. Anything else thrown (a crash) goes to the caller, a plain failure the supervisor
 * restarts. */
export async function runCommand(
  start: () => Promise<{ deps: KeeperDeps; rec: DeploymentRecord; policy?: ClaimPolicy }>,
  log: (line: string) => void,
  opts: RunOptions,
): Promise<number> {
  let s: Awaited<ReturnType<typeof start>>;
  try {
    s = await start();
  } catch (e) {
    const reason = scrubSecrets(oneLine(e instanceof Error ? e.message : String(e)));
    log(`Stopped: ${reason}`);
    log(stoppedBanner(reason));
    return KEEPER_STOPPED;
  }
  const end = await runLoop(s.deps, s.rec, { ...opts, ...(s.policy ? { policy: s.policy } : {}) });
  if (!end.stopped) return 0;
  log(stoppedBanner(end.reason));
  return KEEPER_STOPPED;
}
