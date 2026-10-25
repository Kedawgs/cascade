import { encodeEventTopics, type Hex, parseAbi } from "viem";
import type { ChainName } from "../config.ts";
import type { DeploymentRecord } from "../record.ts";
import type { Sent } from "../send.ts";
import type { CallRequest } from "../types.ts";
import { type Action, decideNext, type State } from "./due.ts";
import { type Payout, type PayoutLog, payoutsHash, rebuildPayouts } from "./payouts.ts";
import type { StatusDetail } from "./status.ts";

export type KeeperState = State & { detail: StatusDetail };

export type Message = { id: Hex; direction: "Base → Bittensor" | "Bittensor → Base"; hash: Hex };

/** A keeper transaction, with the bridge message it sent (close, payouts). */
export type Done = Sent & { messageId?: Hex };

export interface KeeperDeps {
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

export function act(deps: KeeperDeps, rec: DeploymentRecord, a: Action): Promise<Done> {
  if (a.kind === "close") return close(deps, rec);
  if (a.kind === "stake") return stake(deps, rec);
  return payouts(deps, rec, a.key);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does the next due thing every `intervalMs` until stopped; stops at the first failure rather than
 * retrying it. */
export async function runLoop(deps: KeeperDeps, rec: DeploymentRecord, opts: { intervalMs: number; maxTicks?: number }) {
  for (let tick = 1; ; tick++) {
    let next: ReturnType<typeof decideNext>;
    try {
      next = decideNext(await deps.readState());
    } catch (e) {
      deps.log(`Stopped: could not read the chains (${(e as Error).message})`);
      return;
    }
    if (!next.action) {
      deps.log(next.reason);
    } else {
      try {
        const done = await act(deps, rec, next.action);
        deps.log(`Done: ${next.reason} (transaction ${done.hash}${done.messageId ? `, bridge message ${done.messageId}` : ""})`);
      } catch (e) {
        deps.log(`Stopped: ${(e as Error).message}`);
        return;
      }
    }
    if (opts.maxTicks && tick >= opts.maxTicks) return;
    await sleep(opts.intervalMs);
  }
}
