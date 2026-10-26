import { type Address, encodeEventTopics, formatEther, formatUnits, type Hex, parseAbi } from "viem";
import { CLAIM_POLICY, type ChainName, type ClaimPolicy } from "../config.ts";
import { isPlanV3, type PlanV3 } from "../plan.ts";
import type { DeploymentRecord } from "../record.ts";
import { type Sent, SendRefused } from "../send.ts";
import type { CallRequest } from "../types.ts";
import { checkDelivery, type DeliveryCheck, type DeliveryDeps, deliverRequest, deliveredFrom } from "./delivery.ts";
import { type Action, decideNext, type State } from "./due.ts";
import { type Payout, type PayoutLog, payoutsHash, rebuildPayouts } from "./payouts.ts";
import { claimGasLimit, claimRequest, decideClaim, type RewardsDeps, upfrontShortfall } from "./rewards.ts";
import type { StatusDetail } from "./status.ts";

export type KeeperState = State & { detail: StatusDetail };

export type Message = { id: Hex; direction: "Base → Bittensor" | "Bittensor → Base"; hash: Hex };

/** A keeper transaction, with the bridge message it sent (close, payouts). */
export type Done = Sent & { messageId?: Hex };

export interface KeeperDeps extends RewardsDeps, DeliveryDeps {
  readState(): Promise<KeeperState>;
  sendCall(req: CallRequest): Promise<Sent>;
  nonce(chain: ChainName): Promise<number>;
  quoteClose(s: KeeperState): Promise<bigint>;
  payoutLogs(): Promise<PayoutLog[]>;
  batchInfo(key: Hex): Promise<{ payoutsHash: Hex; count: number }>;
  recordMessage(m: Message): void;
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

/** Keeper sends need the whole deployment in place and its read-back passed. */
export function requireReady(rec: DeploymentRecord): void {
  const missing = rec.plan.steps.filter((s) => !rec.done[s.id]);
  if (missing.length || !rec.verify?.ok) {
    throw new Error(
      `the deployment is not complete and verified yet (${missing.length ? `${missing.length} step(s) to go` : "the read-back has not passed"}): run deploy, then verify`,
    );
  }
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
  requireReady(rec);
  const s = await deps.readState();
  if (!s.alphaVault.healthy) throw new Error("AlphaVault is paused or migrating — not closing the batch");
  if (s.frontDoor.paused) throw new Error("the front door is paused");
  if (s.frontDoor.nDeposits + s.frontDoor.nRedeems === 0) throw new Error("the open batch is empty");
  if (!s.frontDoor.canClose) throw new Error("the open batch is not ready to close yet");
  const sent = await deps.sendCall(closeRequest(rec, await deps.quoteClose(s), await deps.nonce("base")));
  return withMessage(deps, sent, rec.plan.addresses.baseAdapter, "Base → Bittensor");
}

export async function stake(deps: KeeperDeps, rec: DeploymentRecord): Promise<Done> {
  requireReady(rec);
  const s = await deps.readState();
  if (s.vault.paused) throw new Error("the vault is paused");
  return deps.sendCall(stakeRequest(rec, await deps.nonce("bittensor")));
}

export async function payouts(deps: KeeperDeps, rec: DeploymentRecord, key: Hex): Promise<Done> {
  requireReady(rec);
  const s = await deps.readState();
  if (!s.alphaVault.healthy) throw new Error("AlphaVault is paused or migrating — not paying out");
  if (s.vault.paused) throw new Error("the vault is paused");
  const b = s.vault.batches.find((b) => b.key.toLowerCase() === key.toLowerCase());
  if (!b || b.cursor >= b.count) throw new Error(`no payout is pending for batch ${key.slice(0, 10)}…`);
  if (s.now < b.queuedAt + s.vault.payoutDelay) throw new Error(`batch ${key.slice(0, 10)}… is not due yet`);
  const list = rebuildPayouts(await deps.payoutLogs(), key);
  const sent = await deps.sendCall(payoutsRequest(rec, key, list, await deps.batchInfo(key), await deps.nonce("bittensor")));
  return withMessage(deps, sent, rec.plan.addresses.bitAdapter, "Bittensor → Base");
}

/** Claims the vault's rewards on its stake hotkey, only when the claim policy says so; otherwise refuses
 * with the policy's reason. Sent with a fixed gas limit the wallet must cover up front. */
export async function claim(deps: KeeperDeps, rec: DeploymentRecord, policy: ClaimPolicy): Promise<Done> {
  requireReady(rec);
  const r = await deps.readRewards();
  const d = decideClaim(r, policy);
  if (!d.claim) throw new Error(`not claiming: ${d.reason}; nothing sent`);
  const short = upfrontShortfall(r);
  if (short) throw new Error(short);
  return deps.sendCall(claimRequest(rec, r.hotkey, claimGasLimit(r.claimGasRequired), await deps.nonce("bittensor")));
}

/** One user's delivery: sent, with the USDC from the front door's Delivered event, or skipped with why. */
export type Delivery = { user: Address } & (({ delivered: true; usdcOut?: bigint } & Sent) | { delivered: false; reason: string });

/** The record's v3 plan; a v2 deployment has no USDC delivery. */
export function deliveryPlan(rec: DeploymentRecord): PlanV3 {
  if (!isPlanV3(rec.plan)) throw new Error("USDC delivery needs a v3 deployment (OPS_DEPLOYMENT=v3-…); this record's front door has none");
  return rec.plan;
}

/** Checks one user (decision, then simulation) and delivers when both pass. A revert in the simulation
 * or in the send's own estimate is a skip for a later round, never retried here. */
export async function deliver(deps: KeeperDeps, rec: DeploymentRecord, user: Address): Promise<Delivery> {
  requireReady(rec);
  const plan = deliveryPlan(rec);
  const c = await checkDelivery(deps, user);
  if (!c.deliver || c.keeperMinOut === undefined) return { user, delivered: false, reason: c.reason };
  let sent: Sent;
  try {
    sent = await deps.sendCall(deliverRequest(plan, user, c.keeperMinOut, await deps.nonce("base")));
  } catch (e) {
    if (e instanceof SendRefused && e.reason === "estimate") return { user, delivered: false, reason: `${e.message}; it waits for a later round` };
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
  requireReady(rec);
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

export function act(deps: KeeperDeps, rec: DeploymentRecord, a: Exclude<Action, { kind: "deliver" }>): Promise<Done> {
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
 * reason logged once) without holding up anything else. Reward claims are only reported, every
 * `rewardsEveryTicks` rounds. */
export async function runLoop(
  deps: KeeperDeps,
  rec: DeploymentRecord,
  opts: { intervalMs: number; maxTicks?: number; policy?: ClaimPolicy; rewardsEveryTicks?: number; live?: boolean },
) {
  const waiting = new Map<string, string>();
  let claimDue: boolean | undefined;
  for (let tick = 1; ; tick++) {
    let next: ReturnType<typeof decideNext>;
    try {
      const s = await deps.readState();
      const checks: DeliveryCheck[] = [];
      for (const user of await deps.deliveryCandidates()) checks.push(await checkDelivery(deps, user));
      for (const c of checks) {
        const key = c.user.toLowerCase();
        if (c.deliver || c.claimable === 0n) waiting.delete(key);
        else if (waiting.get(key) !== c.reason) {
          deps.log(`Delivery to ${c.user} waits: ${c.reason}`);
          waiting.set(key, c.reason);
        }
      }
      const deliveries = checks.flatMap((c) => (c.deliver && c.keeperMinOut !== undefined ? [{ user: c.user, keeperMinOut: c.keeperMinOut }] : []));
      next = decideNext({ ...s, deliveries });
    } catch (e) {
      deps.log(`Stopped: could not read the chains (${(e as Error).message})`);
      return;
    }
    if (tick === 1 || tick % (opts.rewardsEveryTicks ?? 30) === 0) {
      claimDue = await reportClaim(deps, opts.policy ?? CLAIM_POLICY, opts.live ?? false, claimDue);
    }
    const action = next.action;
    try {
      if (!action) {
        deps.log(next.reason);
      } else if (action.kind === "deliver") {
        const d = await deliver(deps, rec, action.user);
        if (d.delivered) {
          const got = d.usdcOut === undefined ? "" : `, ${Number(d.usdcOut) / 1e6} USDC`;
          deps.log(`Done: ${next.reason} (transaction ${d.hash}${got})`);
        } else {
          deps.log(`Skipped the delivery to ${d.user}: ${d.reason}`);
        }
      } else {
        const done = await act(deps, rec, action);
        deps.log(`Done: ${next.reason} (transaction ${done.hash}${done.messageId ? `, bridge message ${done.messageId}` : ""})`);
      }
    } catch (e) {
      deps.log(`Stopped: ${(e as Error).message}`);
      return;
    }
    if (opts.maxTicks && tick >= opts.maxTicks) return;
    await sleep(opts.intervalMs);
  }
}
