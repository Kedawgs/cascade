import { type Hex, parseAbi } from "viem";
import type { ChainName } from "../config.ts";
import type { DeploymentRecord } from "../record.ts";
import type { Sent } from "../send.ts";
import type { CallRequest } from "../types.ts";
import { type Action, decideNext, type State } from "./due.ts";
import { type Payout, type PayoutLog, payoutsHash, rebuildPayouts } from "./payouts.ts";
import type { StatusDetail } from "./status.ts";

export type KeeperState = State & { detail: StatusDetail };

export interface KeeperDeps {
  readState(): Promise<KeeperState>;
  sendCall(req: CallRequest): Promise<Sent>;
  nonce(chain: ChainName): Promise<number>;
  quoteClose(s: KeeperState): Promise<bigint>;
  payoutLogs(): Promise<PayoutLog[]>;
  batchInfo(key: Hex): Promise<{ payoutsHash: Hex; count: number }>;
  log(line: string): void;
}

export const KEEPER_ABI = parseAbi([
  "function closeBatch() payable",
  "function stakeIdle()",
  "struct Payout { address user; uint256 shares; uint256 assets; }",
  "function processPayouts(bytes32 key, Payout[] payouts, uint32 maxEntries)",
]);

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

export async function close(deps: KeeperDeps, rec: DeploymentRecord): Promise<Sent> {
  const s = await deps.readState();
  if (!s.alphaVault.healthy) throw new Error("AlphaVault is paused or migrating — not closing the batch");
  if (s.frontDoor.paused) throw new Error("the front door is paused");
  if (s.frontDoor.nDeposits + s.frontDoor.nRedeems === 0) throw new Error("the open batch is empty");
  if (!s.frontDoor.canClose) throw new Error("the open batch is not ready to close yet");
  return deps.sendCall(closeRequest(rec, await deps.quoteClose(s), await deps.nonce("base")));
}

export async function stake(deps: KeeperDeps, rec: DeploymentRecord): Promise<Sent> {
  const s = await deps.readState();
  if (s.vault.paused) throw new Error("the vault is paused");
  return deps.sendCall(stakeRequest(rec, await deps.nonce("bittensor")));
}

export async function payouts(deps: KeeperDeps, rec: DeploymentRecord, key: Hex): Promise<Sent> {
  const s = await deps.readState();
  if (!s.alphaVault.healthy) throw new Error("AlphaVault is paused or migrating — not paying out");
  if (s.vault.paused) throw new Error("the vault is paused");
  const b = s.vault.batches.find((b) => b.key.toLowerCase() === key.toLowerCase());
  if (!b || b.cursor >= b.count) throw new Error(`no payout is pending for batch ${key.slice(0, 10)}…`);
  if (s.now < b.queuedAt + s.vault.payoutDelay) throw new Error(`batch ${key.slice(0, 10)}… is not due yet`);
  const list = rebuildPayouts(await deps.payoutLogs(), key);
  return deps.sendCall(payoutsRequest(rec, key, list, await deps.batchInfo(key), await deps.nonce("bittensor")));
}

export function act(deps: KeeperDeps, rec: DeploymentRecord, a: Action): Promise<Sent> {
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
        const sent = await act(deps, rec, next.action);
        deps.log(`Done: ${next.reason} (transaction ${sent.hash})`);
      } catch (e) {
        deps.log(`Stopped: ${(e as Error).message}`);
        return;
      }
    }
    if (opts.maxTicks && tick >= opts.maxTicks) return;
    await sleep(opts.intervalMs);
  }
}
