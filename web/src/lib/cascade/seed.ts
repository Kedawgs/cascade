import { type Address, encodeEventTopics, type Hex, parseEventLogs, toHex } from "viem";
import { VAULT } from "./abi";
import type { Clients } from "./chain";
import type { Deployment } from "./config";
import {
  type AccountEvent,
  chunkIn,
  deliveryIn,
  HistoryMismatchError,
  type RawLog,
  type Receipt,
  receiptAt,
  REREAD,
  stakedIn,
  type VaultScan,
  windowLogs,
} from "./facts";
import { FRESH_TRIES, StaleChainError } from "./fresh";
import type { SeedHalves } from "./indexer";
import { type DecodedScanState, decodeScanState } from "./scan-store";

// How the site checks the history indexer's seed against the chain before it uses any of it, and goes
// on checking after (spec section 5). Everything here is read-only and reads the chain; nothing here
// changes a scan except checkSeededAccount's throw, which the caller acts on under the account's lock.

/** A scan this far behind the chain's head asks the indexer first: below it, reading the windows itself
 * costs about what verifying a seed costs (one window, a few receipts, a balance). */
export const SEED_MIN_BLOCKS = 7_200n;
/** A seed whose settled block is further behind the head than this (two hours of 12-second blocks) is
 * stale: the indexer isn't keeping up, and the scan reads the chain itself. */
export const SEED_MAX_LAG = 600n;
/** How many of a seed's older events are checked against their receipts before it is used. */
export const SEED_SAMPLE = 6;
/** How many windows one step of the background check reads (CHECK_EVERY_MS apart: live.ts). */
export const CHECK_WINDOWS_PER_STEP = 3;

const WINDOW = 1_000n;
const BASE_CHAIN_ID = 8453n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** What a window of the vault's logs holds, as the scan keeps it: our front door's deliveries from Base,
 * every stake and payout chunk, and the account's own Deposited and Redeemed. */
export interface WindowEvents {
  delivered: { batchId: string; key: Hex; txHash: Hex; block: bigint }[];
  staked: { block: bigint; txHash: Hex }[];
  payouts: { key: Hex; chunk: number; taken: number; txHash: Hex; block: bigint }[];
  deposited: AccountEvent[];
  redeemed: AccountEvent[];
}

/** The events in `raw` the scan would keep (the same rules as scanVault). */
export function vaultEvents(raw: RawLog[], d: Deployment, account: Address): WindowEvents {
  const out: WindowEvents = { delivered: [], staked: [], payouts: [], deposited: [], redeemed: [] };
  for (const l of parseEventLogs({ abi: VAULT, logs: raw as never, strict: false })) {
    if (!same(l.address, d.vault)) continue;
    const block = l.blockNumber as bigint;
    const txHash = l.transactionHash as Hex;
    if (l.eventName === "BatchDelivered" && l.args.sourceChain === BASE_CHAIN_ID && l.args.frontDoor && same(l.args.frontDoor, d.frontDoor)) {
      out.delivered.push({ batchId: String(l.args.batchId), key: l.args.key as Hex, txHash, block });
    } else if (l.eventName === "Staked") {
      out.staked.push({ block, txHash });
    } else if (l.eventName === "PayoutChunkSent") {
      out.payouts.push({ key: l.args.key as Hex, chunk: Number(l.args.chunk), taken: Number(l.args.taken), txHash, block });
    } else if ((l.eventName === "Deposited" || l.eventName === "Redeemed") && l.args.user && same(l.args.user, account)) {
      const e: AccountEvent = { key: l.args.key as Hex, txHash, block, assets: l.args.assets as bigint, shares: l.args.shares as bigint };
      (l.eventName === "Deposited" ? out.deposited : out.redeemed).push(e);
    }
  }
  return out;
}

type Kind = keyof WindowEvents;
const KINDS: Kind[] = ["delivered", "staked", "payouts", "deposited", "redeemed"];

/** An event's identity, as the comparison sees it: everything the seed states about it. */
function idOf(kind: Kind, e: WindowEvents[Kind][number]): string {
  switch (kind) {
    case "delivered": {
      const x = e as WindowEvents["delivered"][number];
      return `delivered:${x.batchId}:${x.key}:${x.txHash}:${x.block}`.toLowerCase();
    }
    case "staked": {
      const x = e as WindowEvents["staked"][number];
      return `staked:${x.txHash}:${x.block}`.toLowerCase();
    }
    case "payouts": {
      const x = e as WindowEvents["payouts"][number];
      return `payout:${x.key}:${x.chunk}:${x.taken}:${x.txHash}:${x.block}`.toLowerCase();
    }
    default: {
      const x = e as AccountEvent;
      return `${kind}:${x.key}:${x.txHash}:${x.block}:${x.assets}`.toLowerCase();
    }
  }
}

type Tagged = { kind: Kind; e: WindowEvents[Kind][number]; id: string };
const tagged = (w: WindowEvents): Tagged[] => KINDS.flatMap((kind) => (w[kind] as WindowEvents[Kind][number][]).map((e) => ({ kind, e, id: idOf(kind, e) })));
const inRange = (from: bigint, to: bigint) => (t: Tagged) => t.e.block >= from && t.e.block <= to;

/** Whether `r` is a receipt showing `t` (the vault's event, as the seed states it). */
function shows(r: Receipt | null, d: Deployment, account: Address, t: Tagged): boolean {
  switch (t.kind) {
    case "delivered": {
      const x = t.e as WindowEvents["delivered"][number];
      return deliveryIn(r, d, x.batchId, x.key);
    }
    case "staked":
      return stakedIn(r, d);
    case "payouts": {
      const x = t.e as WindowEvents["payouts"][number];
      return chunkIn(r, d, x.key, x.chunk, x.taken);
    }
    default: {
      const x = t.e as AccountEvent;
      return (
        r?.status === "success" &&
        vaultEvents(r.logs, d, account)[t.kind].some((e) => same(e.key, x.key) && same(e.txHash, x.txHash) && e.assets === x.assets)
      );
    }
  }
}

const halvesOf = (s: DecodedScanState, o: DecodedScanState): WindowEvents => ({
  delivered: s.delivered,
  staked: s.staked,
  payouts: s.payouts,
  deposited: o.deposited,
  redeemed: o.redeemed,
});

export type SeedVerdict =
  /** The halves may seed the scan (seedHalves), which then resumes from `next`. */
  | { ok: true; next: bigint }
  /** The scan reads the chain itself. `distrust`: the seed was shown to contradict the chain (the
   * indexer is left alone for a day); otherwise it couldn't be judged, or wasn't worth using. */
  | { ok: false; reason: string; distrust: boolean };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Judges the indexer's two halves against the chain before any of them is used, from a server at
 * `head`: both must be valid states for this deployment and reach past the scan, not stale and not
 * ahead of the chain; the seed's last REREAD blocks must hold exactly what the chain's logs hold there
 * (an event the chain shows that the seed lacks is a definite omission; one the seed has that the window
 * lacks is checked by its receipt, since a node's logs can lag its head); and a sample of its older
 * events, spread over the history, must each be in their receipt. Only a definite contradiction
 * distrusts; a chain that can't be read well enough to tell is "no seed", nothing more. Receipts read
 * here are kept on the scan, so the trails' own confirmations don't read them again. Never throws. */
export async function verifySeed(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, account: Address, halves: SeedHalves, head: bigint): Promise<SeedVerdict> {
  const no = (reason: string, distrust = false): SeedVerdict => ({ ok: false, reason, distrust });
  for (const half of [halves.shared, halves.own]) {
    if (isRecord(half) && typeof half.vault === "string" && typeof half.from === "string" && (half.vault !== d.vault.toLowerCase() || half.from !== String(d.bitBlock))) {
      return no("it is another deployment's", true);
    }
  }
  const s = decodeScanState(halves.shared, scan);
  const o = decodeScanState(halves.own, scan);
  if (!s || !o) return no("a half isn't a valid scan state");
  const next = min(s.next, o.next);
  if (next <= scan.next) return no("it reaches no further than the saved scan");
  if (next > head + 1n) return no("it is ahead of the chain");
  if (head - next > SEED_MAX_LAG) return no(`it is ${head - next} blocks behind the chain`);
  const seed = tagged(halvesOf(s, o));

  // the seed's last blocks against the chain's logs there
  const from = max(scan.from, next - REREAD);
  const to = next - 1n;
  let raw: RawLog[];
  try {
    raw = await windowLogs(c, d, from, to);
  } catch {
    return no("the chain couldn't be read to check it");
  }
  const chain = tagged(vaultEvents(raw, d, account));
  const recent = seed.filter(inRange(from, to));
  const seedIds = new Set(recent.map((t) => t.id));
  const chainIds = new Set(chain.map((t) => t.id));
  const missing = chain.filter((t) => !seedIds.has(t.id));
  if (missing.length > 0) return no(`it left out ${missing.length} event(s) the chain shows in its last ${REREAD} blocks`, true);
  const extra = recent.filter((t) => !chainIds.has(t.id));
  try {
    for (const t of extra) {
      const r = await receiptAt(c, scan, t.e.txHash, t.e.block);
      if (!shows(r, d, account, t)) return no(`it holds an event that isn't on the chain (${t.kind} at block ${t.e.block})`, true);
    }
  } catch {
    return no("the chain couldn't be read to check it");
  }

  // a sample of what came before, spread over the history, each in its receipt
  const older = seed.filter((t) => t.e.block < from && t.kind !== "deposited" && t.kind !== "redeemed").sort((a, b) => (a.e.block < b.e.block ? -1 : a.e.block > b.e.block ? 1 : 0));
  const picks = older.length <= SEED_SAMPLE ? older : Array.from({ length: SEED_SAMPLE }, (_, i) => older[Math.floor(((i + 0.5) * older.length) / SEED_SAMPLE)]);
  try {
    const receipts = await Promise.all(picks.map((t) => receiptAt(c, scan, t.e.txHash, t.e.block)));
    for (let i = 0; i < picks.length; i++) {
      if (!shows(receipts[i], d, account, picks[i])) return no(`it holds an event that isn't on the chain (${picks[i].kind} at block ${picks[i].e.block})`, true);
    }
  } catch {
    return no("the chain couldn't be read to check it");
  }
  return { ok: true, next };
}

/** The vault's events that name a user as their second indexed argument: everything the vault does with
 * an account's entry in a delivery. */
const USER_EVENTS = ["Deposited", "Redeemed", "DepositBounced", "RedeemSkipped", "RedeemDeferred"] as const;
const userTopics = (account: Address): (Hex | Hex[] | null)[] => {
  const topic0 = USER_EVENTS.map((eventName) => encodeEventTopics({ abi: VAULT, eventName } as never)[0] as Hex);
  const [, , user] = encodeEventTopics({ abi: VAULT, eventName: "Deposited", args: { user: account } });
  return [topic0, null, user as Hex];
};

/** One window of the account's own vault events, from a server that has reached its end (as windowLogs). */
async function accountWindow(c: Pick<Clients, "bittensor">, d: Deployment, account: Address, from: bigint, to: bigint): Promise<RawLog[]> {
  const filter = { address: d.vault, topics: userTopics(account), fromBlock: toHex(from), toBlock: toHex(to) };
  for (let i = 0; i < FRESH_TRIES; i++) {
    const [raw, head] = await Promise.all([
      c.bittensor.request({ method: "eth_getLogs", params: [filter] } as never) as Promise<unknown>,
      c.bittensor.request({ method: "eth_blockNumber" }),
    ]);
    if (BigInt(head as string) >= to) return raw as RawLog[];
  }
  throw new StaleChainError();
}

/** One step of the browser's own read of the account's history below the account half's mark, in
 * windows of 1,000 blocks (`windows` of them a step), from `progress.next` (or the deploy block), which
 * it moves after each window so a later step, or visit, goes on from there. Each window's Deposited and
 * Redeemed of the account's must be exactly the scan's for those blocks, and every event of the account's
 * there (bounces and deferrals too) must have its batch's delivery in the scan when the deployment's half
 * was the indexer's: otherwise the seed left something out that no balance check could see, and this
 * throws HistoryMismatchError (naming the indexer; the caller restarts the scan at its next read). "done"
 * once the mark is reached, or when the account half isn't the indexer's; "more" while there is further
 * to read; "stopped" when the scan's mark changed under the read (it started over, or was seeded
 * again), so what was read says nothing about it and the progress isn't the scan's. A window that can't
 * be read throws, keeping the progress made. Runs outside the account's lock: it only reads the scan. */
export async function checkSeededAccount(
  c: Pick<Clients, "bittensor">,
  d: Deployment,
  scan: VaultScan,
  account: Address,
  progress: { next?: bigint },
  windows = CHECK_WINDOWS_PER_STEP,
): Promise<"more" | "done" | "stopped"> {
  const to = scan.accountSeededTo;
  if (to === undefined) return "done";
  let from = max(scan.from, progress.next ?? scan.from);
  for (let i = 0; i < windows && from < to; i++) {
    const end = min(from + WINDOW - 1n, to - 1n);
    const raw = await accountWindow(c, d, account, from, end);
    if (scan.accountSeededTo !== to) return "stopped";
    const found = vaultEvents(raw, d, account);
    for (const kind of ["deposited", "redeemed"] as const) {
      const idOfOwn = (e: AccountEvent) => `${e.key}:${e.txHash}:${e.block}`.toLowerCase();
      const chain = found[kind].map(idOfOwn).sort();
      const seeded = scan[kind]
        .filter((e) => e.block >= from && e.block <= end)
        .map(idOfOwn)
        .sort();
      if (chain.join("|") !== seeded.join("|")) throw new HistoryMismatchError(true);
    }
    if (scan.sharedSeededTo !== undefined) {
      const keys = new Set([...scan.delivered.values()].map((e) => e.key.toLowerCase()));
      for (const l of parseEventLogs({ abi: VAULT, logs: raw as never, strict: false })) {
        if (!same(l.address, d.vault) || !("user" in l.args) || !l.args.user || !same(l.args.user as string, account) || !("key" in l.args)) continue;
        const block = l.blockNumber as bigint;
        if (block < scan.sharedSeededTo && !keys.has((l.args.key as string).toLowerCase())) throw new HistoryMismatchError(true);
      }
    }
    from = end + 1n;
    progress.next = from;
  }
  return from >= to ? "done" : "more";
}
