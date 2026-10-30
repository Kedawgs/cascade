import { type Address, encodeEventTopics, formatEther, formatUnits, type Hex, parseAbi } from "viem";
import { CLAIM_POLICY, type ChainName, type ClaimPolicy, WALLET } from "../config.ts";
import { isPlanV3, type PlanV3, rolesOf } from "../plan.ts";
import { type DeploymentRecord, requireHandoff } from "../record.ts";
import { describeCode } from "../rpc.ts";
import { chainLabel, RevertedOnChain, type Sent, SendRefused } from "../send.ts";
import type { CallRequest } from "../types.ts";
import { checkDelivery, type DeliveryDeps, deliverRequest, deliveredFrom } from "./delivery.ts";
import { type Action, type DueDelivery, decideNext, type State } from "./due.ts";
import { type Payout, type PayoutLog, payoutsHash, rebuildPayouts } from "./payouts.ts";
import { claimGasLimit, claimRequest, decideClaim, type RewardsDeps, upfrontShortfall } from "./rewards.ts";
import { keeperMismatch } from "./signer.ts";
import type { StatusDetail } from "./status.ts";

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
  /** The keeper wallet's (`signer`'s) code on `chain`: "0x" for a plain account. Read at most once a
   * round: `refresh`, at each round's start, forgets it. */
  signerCode(chain: ChainName): Promise<Hex>;
  nonce(chain: ChainName): Promise<number>;
  quoteClose(s: KeeperState): Promise<bigint>;
  payoutLogs(): Promise<PayoutLog[]>;
  batchInfo(key: Hex): Promise<{ payoutsHash: Hex; count: number }>;
  /** The TAO the front door holds for `user` to claim (or the keeper to deliver) */
  readClaimable(user: Address): Promise<bigint>;
  /** The front door's minimum deposit as it is now */
  readMinDeposit(): Promise<bigint>;
  /** A bridge message's state on its destination's OffRamp: UNTOUCHED, IN_PROGRESS, SUCCESS or FAILURE */
  messageState(m: Pick<Message, "id" | "direction">): Promise<string>;
  recordMessage(m: Message): void;
  /** Re-reads the deployment record from disk and takes its verify, done and messages onto the record
   * these deps hold (the one `run` passes to each action), so a read-back saved since the command started
   * is seen; throws when the file is gone or now holds another deployment */
  refresh(): void;
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
 * the record's keeper. */
export function requireReady(rec: DeploymentRecord, signer: Address = WALLET): void {
  const missing = rec.plan.steps.filter((s) => !rec.done[s.id]);
  if (missing.length || !rec.verify?.ok) {
    throw new Error(
      `the deployment is not complete and verified yet (${missing.length ? `${missing.length} step(s) to go` : "the read-back has not passed"}): run deploy, then verify`,
    );
  }
  requireHandoff(rec);
  const keeper = rolesOf(rec.plan).keeper;
  if (keeper.toLowerCase() !== signer.toLowerCase()) throw new Error(keeperMismatch(keeper, signer));
}

/** The keeper wallet has code on `chain` (either chain stops a send on either). Not a SendRefused: a
 * run's delivery treats those as a wait for the next round, and this must stop the run. */
export class KeeperHasCode extends Error {
  readonly chain: ChainName;
  readonly code: Hex;

  constructor(chain: ChainName, keeper: Address, code: Hex) {
    super(
      `${chainLabel(chain)}: the keeper wallet ${keeper} has code (an EIP-7702 delegation or a contract): ${describeCode(code)}; assume its key is compromised; stop and rotate the keeper; nothing sent`,
    );
    this.chain = chain;
    this.code = code;
  }
}

/** Every keeper send goes through here. The keeper wallet is a plain account, with no code; code there
 * means its key has signed an EIP-7702 delegation (a thief's sweeper, as in the Binance hot-wallet drain)
 * or the address is a contract. Either way nothing is sent, and `run` stops. Its code is read on both
 * chains, the send's first, each at most once a round (signerCode): one key holds the address on both, a
 * delegation can be signed for every chain at once (chain id 0), and Bittensor may not run EIP-7702 at
 * all, so code on either chain stops a send on either. The refusal names the chain the code is on. */
async function keeperSend(deps: KeeperDeps, req: CallRequest): Promise<Sent> {
  for (const chain of [req.chain, req.chain === "base" ? "bittensor" : "base"] as const) {
    const code = await deps.signerCode(chain);
    if (code !== "0x") throw new KeeperHasCode(chain, deps.signer, code);
  }
  return deps.sendCall(req);
}

async function withMessage(deps: KeeperDeps, sent: Sent, adapter: Hex, direction: Message["direction"]): Promise<Done> {
  const messageId = messageIdFrom(sent.logs, adapter);
  if (messageId) deps.recordMessage({ id: messageId, direction, hash: sent.hash });
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

/** processPayouts with the batch's full list, refused unless it matches what the vault stored. */
export function payoutsRequest(
  rec: DeploymentRecord,
  key: Hex,
  list: Payout[],
  stored: { payoutsHash: Hex; count: number },
  nonce: number,
): CallRequest {
  if (list.length !== stored.count || payoutsHash(list).toLowerCase() !== stored.payoutsHash.toLowerCase()) {
    throw new Error(
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
  if (!s.alphaVault.healthy) throw new Error("AlphaVault is paused or migrating — not closing the batch");
  if (s.frontDoor.paused) throw new Error("the front door is paused");
  if (s.frontDoor.nDeposits + s.frontDoor.nRedeems === 0) throw new Error("the open batch is empty");
  if (!s.frontDoor.canClose) throw new Error("the open batch is not ready to close yet");
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
 * which still stops the keeper, as do a re-read that fails, a missing receipt and the send guards'
 * refusals). If a redeem lands between the simulation and the transaction, its fee pot may pay for a
 * real close; its bridge message is then recorded like a close's. */
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
  if (s.vault.paused) throw new Error("the vault is paused");
  return keeperSend(deps, stakeRequest(rec, await deps.nonce("bittensor")));
}

export async function payouts(deps: KeeperDeps, rec: DeploymentRecord, key: Hex): Promise<Done> {
  requireReady(rec, deps.signer);
  const s = await deps.readState();
  if (!s.alphaVault.healthy) throw new Error("AlphaVault is paused or migrating — not paying out");
  if (s.vault.paused) throw new Error("the vault is paused");
  const b = s.vault.batches.find((b) => b.key.toLowerCase() === key.toLowerCase());
  if (!b || b.cursor >= b.count) throw new Error(`no payout is pending for batch ${key.slice(0, 10)}…`);
  if (s.now < b.queuedAt + s.vault.payoutDelay) throw new Error(`batch ${key.slice(0, 10)}… is not due yet`);
  const list = rebuildPayouts(await deps.payoutLogs(), key);
  const sent = await keeperSend(deps, payoutsRequest(rec, key, list, await deps.batchInfo(key), await deps.nonce("bittensor")));
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

export function act(deps: KeeperDeps, rec: DeploymentRecord, a: Exclude<Action, { kind: "deliver" } | { kind: "roll" }>): Promise<Done> {
  if (a.kind === "close") return close(deps, rec);
  if (a.kind === "stake") return stake(deps, rec);
  return payouts(deps, rec, a.key);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Does the next due thing every `intervalMs` until stopped; stops at the first failure rather than
 * retrying it. A delivery goes ahead only when its simulation passes; one that would revert waits (its
 * reason logged once) without holding up anything else. A delivery that isn't sent (its re-check, its
 * estimate or the wallet's guard refuses it) never ends the round: the round's payout, stake or close
 * still goes ahead. One whose estimate refuses it is held, not retried, until the user's claimable
 * amount, preference, or the quote against the floors changes. Reward claims are only reported, every
 * `rewardsEveryTicks` rounds. Each round starts by re-reading the record (`deps.refresh`, onto `rec`, the
 * record the deps were made with), so a read-back that failed since the run started stops its sends. A
 * keeper wallet found with code at any send, a delivery's too, stops the run (KeeperHasCode). */
export async function runLoop(
  deps: KeeperDeps,
  rec: DeploymentRecord,
  opts: { intervalMs: number; maxTicks?: number; policy?: ClaimPolicy; rewardsEveryTicks?: number; live?: boolean },
) {
  /** The last wait logged for each user, so each reason is logged once. */
  const waiting = new Map<string, string>();
  /** Deliveries whose send-time estimate refused them, with the facts they were refused on. */
  const held = new Map<string, { facts: string; reason: string }>();
  const waits = (user: Address, reason: string) => {
    const key = user.toLowerCase();
    if (waiting.get(key) === reason) return;
    deps.log(`Delivery to ${user} waits: ${reason}`);
    waiting.set(key, reason);
  };
  let claimDue: boolean | undefined;
  for (let tick = 1; ; tick++) {
    // the record as it is now: a read-back that failed since the run started stops its sends
    try {
      deps.refresh();
    } catch (e) {
      deps.log(`Stopped: ${(e as Error).message}`);
      return;
    }
    let s: KeeperState;
    let deliveries: DueDelivery[] = [];
    const facts = new Map<string, string | undefined>();
    try {
      s = await deps.readState({ economics: true });
      for (const user of await deps.deliveryCandidates()) {
        const c = await checkDelivery(deps, user);
        const key = c.user.toLowerCase();
        facts.set(key, c.facts);
        if (c.facts !== undefined && held.get(key)?.facts !== c.facts) held.delete(key);
        if (c.claimable === 0n) {
          waiting.delete(key);
          continue;
        }
        const hold = held.get(key);
        if (c.deliver && c.keeperMinOut !== undefined && !hold) deliveries.push({ user: c.user, keeperMinOut: c.keeperMinOut });
        else waits(c.user, c.deliver && hold ? hold.reason : c.reason);
      }
    } catch (e) {
      deps.log(`Stopped: could not read the chains (${(e as Error).message})`);
      return;
    }
    if (tick === 1 || tick % (opts.rewardsEveryTicks ?? 30) === 0) {
      claimDue = await reportClaim(deps, opts.policy ?? CLAIM_POLICY, opts.live ?? false, claimDue);
    }
    try {
      for (;;) {
        const next = decideNext({ ...s, deliveries });
        const action = next.action;
        if (!action) {
          deps.log(next.reason);
          break;
        }
        if (action.kind === "roll") {
          // a roll that can't go ahead now is only a skip: the round ends, the next one decides again
          const r = await roll(deps, rec);
          if (!r.rolled) deps.log(`Not rolled: ${r.reason}`);
          else if (r.messageId) {
            deps.log(
              `Done: the open batch closed instead of rolling: an entry landed first and its fee pot paid the bridge (transaction ${r.hash}, bridge message ${r.messageId})`,
            );
          } else deps.log(`Done: ${next.reason} (transaction ${r.hash})`);
          break;
        }
        if (action.kind !== "deliver") {
          const done = await act(deps, rec, action);
          deps.log(`Done: ${next.reason} (transaction ${done.hash}${done.messageId ? `, bridge message ${done.messageId}` : ""})`);
          break;
        }
        // whatever becomes of this delivery, the round's next action comes after it, never instead
        deliveries = deliveries.filter((d) => d.user !== action.user);
        const key = action.user.toLowerCase();
        let d: Delivery;
        try {
          d = await deliver(deps, rec, action.user);
        } catch (e) {
          // the wallet's guard (an earlier transaction pending, the nonce, the chain): not this user's
          // facts, so tried again next round. Anything else (a keeper wallet with code) stops the run
          if (!(e instanceof SendRefused)) throw e;
          waits(action.user, `${e.message}; it is tried again next round`);
          continue;
        }
        if (d.delivered) {
          waiting.delete(key);
          const got = d.usdcOut === undefined ? "" : `, ${Number(d.usdcOut) / 1e6} USDC`;
          deps.log(`Done: ${next.reason} (transaction ${d.hash}${got})`);
          break;
        }
        const f = facts.get(key);
        if (d.refused !== undefined && f !== undefined) {
          const reason = `${d.refused}; not retried until the claimable amount, the preference or the quote against the floors changes`;
          held.set(key, { facts: f, reason });
          waits(action.user, reason);
        } else {
          waits(action.user, d.reason);
        }
      }
    } catch (e) {
      deps.log(`Stopped: ${(e as Error).message}`);
      return;
    }
    if (opts.maxTicks && tick >= opts.maxTicks) return;
    await sleep(opts.intervalMs);
  }
}
