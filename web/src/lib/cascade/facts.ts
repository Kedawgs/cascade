import { type Address, encodeEventTopics, type Hex, parseEventLogs, toHex } from "viem";
import { FRESH_TRIES, freshTip, StaleChainError } from "./fresh";
import { ADAPTER, ERC20, FRONT_DOOR, OFFRAMP_ABI, STAKER, VAULT } from "./abi";
import type { Clients } from "./chain";
import { batchCloseAt, CLOCK_AHEAD_MS, type Deployment, explorer, isV3, OFFRAMP, TOKENS } from "./config";
import type { ClaimOp, DepositOp, WithdrawalOp } from "./oplog";
import { type FrontDoorState, quoteSell, readStakerFees, type VaultState } from "./reads";
import type { DepositFacts, WithdrawalFacts } from "./trail";

/** Bittensor's public node answers log queries of up to 1,000 blocks. Base logs are never read. */
const WINDOW = 1_000n;
const BASE_CHAIN_ID = 8453n;
const ED_RESERVE = 10n ** 12n;

export type RawLog = { address: string; topics: readonly Hex[]; data: Hex; blockNumber: bigint | null; transactionHash: Hex | null; logIndex: number | null };
export type Receipt = { status: string; blockNumber?: bigint; logs: RawLog[] };

/** What the vault has emitted since deployment, scanned once and then only forward. The events (not the
 * caches) are saved in the browser and resumed from (scan-store.ts). */
export interface VaultScan {
  /** The vault read, and its deploy block: where the scan starts. */
  vault: Address;
  from: bigint;
  /** The first block not read yet. */
  next: bigint;
  /** BatchDelivered from our front door, by batch id. `unconfirmed` when it came from storage or a seed:
   * what can be unstaked relies on it only once its receipt confirms it (confirmDelivery). */
  delivered: Map<string, { key: Hex; txHash: Hex; block: bigint; unconfirmed?: true }>;
  /** Staked events. `unconfirmed` when from storage or a seed: a trail uses one only once its receipt
   * shows it (confirmedStakeAfter). */
  staked: Stake[];
  /** PayoutChunkSent by batch key: each chunk's number and how many of the batch's payout entries it took. */
  payouts: Map<Hex, PayoutChunk[]>;
  /** The account's own Deposited events (to show deposits made from another browser), and its direct
   * deposits on Bittensor (`kind: "direct"`). */
  deposited: AccountEvent[];
  /** The account's own Redeemed events (TAO it took out), and its direct redeems (`kind: "direct"`). */
  redeemed: AccountEvent[];
  /** The other ways the account's shares moved: a redeem reversed by a cancelled payout batch (shares
   * re-minted, `kind: "reversed"`) and the reward cut minted to it as the treasury (`kind: "cut"`). */
  adjustments: AccountEvent[];
  receipts: Map<Hex, Receipt>;
  blockTimes: Map<bigint, Date>;
  /** v3: each payout's life on Base after it left the vault, by batch key (lowercase). */
  onBase: Map<string, BasePayout>;
  /** The deployment's events in [sharedSeededFrom, sharedSeededTo) came from the history indexer's
   * seed, not this browser's own read of the chain (seed.ts, scan-store.ts): nothing from them shows
   * until the chain confirms it, a contradiction found on one of them is the indexer's (distrusted), and
   * the browser's own read of those blocks (checkSeededHistory) clears the marks. */
  sharedSeededFrom?: bigint;
  sharedSeededTo?: bigint;
  /** The same for the account's events: "rewards earned" has no figure until the browser's own read of
   * them matches. */
  accountSeededFrom?: bigint;
  accountSeededTo?: bigint;
  /** How far the browser's own read of the seeded blocks has got (seed.ts, checkSeededHistory): blocks
   * below it are as good as read by the scan itself. */
  checkedTo?: bigint;
}

export interface Stake {
  block: bigint;
  txHash: Hex;
  unconfirmed?: true;
  /** No other stake sits in [clearBefore, block): the chain's logs for those blocks were read. */
  clearBefore?: bigint;
}

/** The key a direct deposit or redeem, or a reward cut, carries: it belongs to no batch. */
export const ZERO_KEY = `0x${"0".repeat(64)}` as Hex;

export interface PayoutChunk {
  txHash: Hex;
  block: bigint;
  chunk: number;
  taken: number;
  /** From storage or a seed: used only once its receipt shows it (confirmedChunks). */
  unconfirmed?: true;
}

/** One of the account's Deposited or Redeemed events. `unconfirmed` when it came from the browser's
 * storage (or a seed) rather than this session's reading of the chain: its amount isn't used until its
 * receipt confirms it (confirmAccountEvents). `shares` is known once the event was read from the chain
 * or its receipt (a saved form carries only `assets`). */
export interface AccountEvent {
  key: Hex;
  txHash: Hex;
  block: bigint;
  assets: bigint;
  shares?: bigint;
  unconfirmed?: true;
  /** Absent for a batch's Deposited or Redeemed; "direct" for a deposit or redeem made on Bittensor;
   * "reversed" for a redeem undone by a cancelled payout batch; "cut" for the reward cut minted to the
   * treasury. */
  kind?: "direct" | "reversed" | "cut";
}

export const newScan = (d: Deployment): VaultScan => ({
  vault: d.vault,
  from: d.bitBlock,
  next: d.bitBlock,
  delivered: new Map(),
  staked: [],
  payouts: new Map(),
  deposited: [],
  redeemed: [],
  adjustments: [],
  receipts: new Map(),
  blockTimes: new Map(),
  onBase: new Map(),
});

/** Forgets every event read, to read again from the deploy block; what the indexer seeded goes with
 * them, so nothing read from here on is taken for the indexer's. */
export function restartScan(scan: VaultScan): void {
  scan.next = scan.from;
  scan.delivered.clear();
  scan.staked.length = 0;
  scan.payouts.clear();
  scan.deposited.length = 0;
  scan.redeemed.length = 0;
  scan.adjustments.length = 0;
  delete scan.sharedSeededFrom;
  delete scan.sharedSeededTo;
  delete scan.accountSeededFrom;
  delete scan.accountSeededTo;
  delete scan.checkedTo;
}
const restart = restartScan;

/** Whether an event at `block` was the indexer's (in the scan's seeded range for that half). */
export const seededShared = (scan: VaultScan, block: bigint) => scan.sharedSeededTo !== undefined && block >= (scan.sharedSeededFrom ?? scan.from) && block < scan.sharedSeededTo;
export const seededAccount = (scan: VaultScan, block: bigint) => scan.accountSeededTo !== undefined && block >= (scan.accountSeededFrom ?? scan.from) && block < scan.accountSeededTo;

/** Whether some block in [lo, hi] is in the deployment half's seeded range and not yet read by the
 * browser itself (checkedTo): an absence there isn't known, and what is there isn't confirmed. */
export function sharedUnverified(scan: VaultScan, lo: bigint, hi: bigint): boolean {
  if (scan.sharedSeededTo === undefined || lo > hi) return false;
  const from = scan.sharedSeededFrom ?? scan.from;
  const start = (scan.checkedTo ?? from) > from ? scan.checkedTo! : from;
  return hi >= start && lo < scan.sharedSeededTo;
}

/** How far past the chain's newest block saved progress may claim to be (an hour of 12-second blocks)
 * before it is taken for a corrupt entry rather than a node a little behind. */
const AHEAD = 300n;
/** Each scan starts this many blocks before where the last one stopped, so a log that a lagging
 * (load-balanced) node or a reorg hid is found on a later read; caught up, that is still one 1,000-block
 * window a read. The keeper's numbers (ops/src/keeper/state.ts). */
export const REREAD = 400n;
/** Logs this close to where a scan stopped haven't settled: the next scan reads them again (one whose
 * block was replaced is then gone), and they are never saved. */
export const SETTLE = 10n;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Before the read about to start reads blocks `from` to `to` again: drops the stakes and chunks found
 * there (read again, or gone with a replaced block; they only move a trail's status), and marks the
 * deliveries and the account's Deposited and Redeemed there unconfirmed rather than dropping them. A
 * node whose logs lag the head it reports returns too little, and neither an amount nor a delivery must
 * vanish over that: one read again is confirmed by its log; an account event that isn't waits on its
 * receipt (confirmAccountEvents), so the figure shows "–" until it is known, and a delivery that isn't
 * counts only once its receipt shows it (deliveryOf for a trail, checkDeliveries for what can be
 * unstaked), so a batch just delivered doesn't flip back to "on the bridge". */
function forget(scan: VaultScan, from: bigint, to: bigint): void {
  const kept = (e: { block: bigint }) => e.block < from || e.block > to;
  for (const [id, e] of scan.delivered) if (!kept(e)) scan.delivered.set(id, { ...e, unconfirmed: true });
  for (const [key, chunks] of scan.payouts) {
    const left = chunks.filter(kept);
    if (left.length > 0) scan.payouts.set(key, left);
    else scan.payouts.delete(key);
  }
  scan.staked.splice(0, scan.staked.length, ...scan.staked.filter(kept));
  for (const list of [scan.deposited, scan.redeemed, scan.adjustments]) {
    for (let i = 0; i < list.length; i++) if (!kept(list[i])) list[i] = { ...list[i], unconfirmed: true };
  }
}

/** A log known by its transaction and content, numbered when one transaction has several alike: the
 * same in every read of its block, and when a reorg mines the transaction again elsewhere, so a block
 * read again adds nothing twice (as the keeper knows logs). Deliveries go by batch, chunks by number. */
const staking = (txHash: Hex) => `staked:${txHash}`.toLowerCase();
const accountEvent = (kind: "deposited" | "redeemed" | "adjustments", e: { txHash: Hex; key: Hex; kind?: string }) => `${kind}:${e.kind ?? ""}:${e.txHash}:${e.key}`.toLowerCase();

function numbered(ids: string[]): string[] {
  const count = new Map<string, number>();
  return ids.map((id) => {
    const n = count.get(id) ?? 0;
    count.set(id, n + 1);
    return `${id}#${n}`;
  });
}

/** Reads the vault's logs to two blocks short of the newest, one window at a time, calling `onWindow`
 * after each so the caller can save its progress. It starts REREAD blocks before where it last stopped,
 * after dropping what it found in the last SETTLE blocks then, and adds only logs it doesn't hold. */
export async function scanVault(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, account?: Address, onWindow?: () => void): Promise<void> {
  // two blocks short of the newest: a block still being imported or replaced is read next time
  const latest = (await freshTip(c)) - 2n;
  // progress no chain could have reached yet can't be resumed: read it all again
  if (scan.next > latest + AHEAD) restart(scan);
  // only blocks this read covers again: a server a little behind reads less far than the last one did
  forget(scan, scan.next - SETTLE, latest);
  const have = new Set(
    numbered([
      ...scan.staked.map((e) => staking(e.txHash)),
      ...scan.deposited.map((e) => accountEvent("deposited", e)),
      ...scan.redeemed.map((e) => accountEvent("redeemed", e)),
      ...scan.adjustments.map((e) => accountEvent("adjustments", e)),
    ]),
  );
  const start = scan.next - REREAD > scan.from ? scan.next - REREAD : scan.from;
  for (let from = start; from <= latest; from += WINDOW) {
    const to = from + WINDOW - 1n < latest ? from + WINDOW - 1n : latest;
    const raw = await windowLogs(c, d, from, to);
    const seen = new Map<string, number>();
    /** Whether a log is new to the scan, by its id (see numbered), counting it as held from now on. */
    const fresh = (id: string) => {
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      if (have.has(`${id}#${n}`)) return false;
      have.add(`${id}#${n}`);
      return true;
    };
    for (const l of parseEventLogs({ abi: VAULT, logs: raw as never, strict: false })) {
      const block = l.blockNumber as bigint;
      const txHash = l.transactionHash as Hex;
      if (l.eventName === "BatchDelivered" && l.args.sourceChain === BASE_CHAIN_ID && l.args.frontDoor && same(l.args.frontDoor, d.frontDoor)) {
        scan.delivered.set(String(l.args.batchId), { key: l.args.key as Hex, txHash, block });
      } else if (l.eventName === "Staked") {
        const s: Stake = { block, txHash };
        if (fresh(staking(txHash))) scan.staked.push(s);
        else {
          // a stored stake read again: the chain's copy takes its place, confirmed by the log itself
          const i = scan.staked.findIndex((x) => x.unconfirmed && same(x.txHash, txHash));
          if (i >= 0) scan.staked[i] = s;
        }
      } else if (l.eventName === "PayoutChunkSent") {
        const key = l.args.key as Hex;
        const chunk: PayoutChunk = { txHash, block, chunk: Number(l.args.chunk), taken: Number(l.args.taken) };
        const chunks = scan.payouts.get(key) ?? [];
        const i = chunks.findIndex((p) => p.chunk === chunk.chunk);
        if (i < 0) scan.payouts.set(key, [...chunks, chunk]);
        else if (chunks[i].unconfirmed) scan.payouts.set(key, chunks.map((p, j) => (j === i ? chunk : p)));
      } else if (account && (l.eventName === "Deposited" || l.eventName === "DepositedDirect") && l.args.user && same(l.args.user, account)) {
        const direct = l.eventName === "DepositedDirect";
        const e: AccountEvent = { key: direct ? ZERO_KEY : (l.args.key as Hex), txHash, block, assets: l.args.assets as bigint, shares: l.args.shares as bigint, ...(direct ? { kind: "direct" as const } : {}) };
        if (fresh(accountEvent("deposited", e))) scan.deposited.push(e);
        else confirmedBy(scan.deposited, e);
      } else if (account && (l.eventName === "Redeemed" || l.eventName === "RedeemedDirect") && l.args.user && same(l.args.user, account)) {
        const direct = l.eventName === "RedeemedDirect";
        const e: AccountEvent = { key: direct ? ZERO_KEY : (l.args.key as Hex), txHash, block, assets: l.args.assets as bigint, shares: l.args.shares as bigint, ...(direct ? { kind: "direct" as const } : {}) };
        if (fresh(accountEvent("redeemed", e))) scan.redeemed.push(e);
        else confirmedBy(scan.redeemed, e);
      } else if (account && l.eventName === "RedeemReversed" && l.args.user && same(l.args.user, account)) {
        const e: AccountEvent = { key: l.args.key as Hex, txHash, block, assets: l.args.assets as bigint, shares: l.args.shares as bigint, kind: "reversed" };
        if (fresh(accountEvent("adjustments", e))) scan.adjustments.push(e);
        else confirmedBy(scan.adjustments, e);
      } else if (account && l.eventName === "RewardCutMinted" && l.args.treasury && same(l.args.treasury, account)) {
        const e: AccountEvent = { key: ZERO_KEY, txHash, block, assets: l.args.assets as bigint, shares: l.args.shares as bigint, kind: "cut" };
        if (fresh(accountEvent("adjustments", e))) scan.adjustments.push(e);
        else confirmedBy(scan.adjustments, e);
      }
    }
    // a log found on a read again goes in its block's place: "the first stake after" reads in order
    if (seen.size > 0) for (const list of [scan.staked, scan.deposited, scan.redeemed, scan.adjustments] as { block: bigint }[][]) list.sort(byBlock);
    if (to + 1n > scan.next) scan.next = to + 1n;
    onWindow?.();
  }
}

const byBlock = (a: { block: bigint }, b: { block: bigint }) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0);

/** A saved account event read again from the chain: the chain's copy takes its place, confirmed by the
 * log itself, so it never has to wait on a receipt (and a receipt index that lags can't hold it up). */
function confirmedBy(list: AccountEvent[], e: AccountEvent): void {
  const i = list.findIndex((x) => x.unconfirmed && same(x.txHash, e.txHash) && same(x.key, e.key) && (x.kind ?? "") === (e.kind ?? ""));
  if (i >= 0) list[i] = e;
}

/** How many receipts confirmAccountEvents asks Bittensor's public node for at once. */
const CONFIRM_AT_ONCE = 8;

/** Saved history that Bittensor shows to be wrong: one of its events isn't where it says, or one it
 * should hold is missing. The scan is put back to the deploy block, to read it all again (by
 * confirmAccountEvents itself, which runs under the account's lock; by live.ts for the trails); this
 * read shows nothing from it meanwhile. `seeded`: the event in question came from the history indexer's
 * seed (below the scan's seeded mark), so the indexer is distrusted (live.ts). */
export class HistoryMismatchError extends Error {
  /** `restarted`: the scan was already put back to the deploy block by the thrower (which held the
   * account's lock); otherwise the caller does it under that lock. */
  constructor(
    readonly seeded = false,
    readonly restarted = false,
  ) {
    super("The history saved in this browser didn't match Bittensor, so it is being read again.");
    this.name = "HistoryMismatchError";
  }
}

/** The vault's BatchDelivered from our front door in a receipt, under `key`: its batch id. */
function deliveredBatchIn(r: Receipt | null, d: Deployment, key: Hex): string | undefined {
  if (!mined(r)) return undefined;
  const l = parseEventLogs({ abi: VAULT, logs: r!.logs as never, eventName: "BatchDelivered", strict: false }).find(
    (l) => same(l.address, d.vault) && l.args.sourceChain === BASE_CHAIN_ID && !!l.args.frontDoor && same(l.args.frontDoor, d.frontDoor) && same(l.args.key as string, key),
  );
  return l ? String(l.args.batchId) : undefined;
}

/** The account's event `e` as its receipt shows it (the vault's log of its kind, for its key and the
 * account), with the receipt's amount, shares and block; undefined when the receipt shows no such event. */
function accountEventIn(r: Receipt | null, d: Deployment, account: Address, e: AccountEvent, list: "deposited" | "redeemed" | "adjustments"): AccountEvent | undefined {
  if (!mined(r)) return undefined;
  const names = {
    deposited: e.kind === "direct" ? (["DepositedDirect"] as const) : (["Deposited"] as const),
    redeemed: e.kind === "direct" ? (["RedeemedDirect"] as const) : (["Redeemed"] as const),
    adjustments: e.kind === "cut" ? (["RewardCutMinted"] as const) : (["RedeemReversed"] as const),
  }[list];
  for (const l of parseEventLogs({ abi: VAULT, logs: r!.logs as never, strict: false })) {
    if (!same(l.address, d.vault) || !(names as readonly string[]).includes(l.eventName)) continue;
    const a = l.args as Record<string, unknown>;
    const user = (a.user ?? a.treasury) as string | undefined;
    if (!user || !same(user, account)) continue;
    if (e.kind !== "direct" && e.kind !== "cut" && !same(a.key as string, e.key)) continue;
    return { ...e, block: (l.blockNumber as bigint | null) ?? e.block, assets: a.assets as bigint, shares: a.shares as bigint, unconfirmed: undefined };
  }
  return undefined;
}

const dropUnconfirmed = (e: AccountEvent): AccountEvent => {
  const rest: AccountEvent = { ...e };
  delete rest.unconfirmed;
  return rest;
};

/** Confirms the account's events that came from storage or a seed, by their receipts on Bittensor, a
 * few at a time and each group judged before the next is read (a padded seed fails on its first group):
 * the amount, shares (and block) are the receipt's. A receipt that can't be read, or a "not found" from
 * a server that hasn't reached the event's block, throws and leaves the event as it was, so nothing
 * unconfirmed is summed and nothing is lost to a node that is behind. Only a server that has reached the
 * block, showing no such event there, makes the saved history wrong: then nothing is dropped quietly,
 * the scan starts over from the deploy block (HistoryMismatchError, naming the indexer when the seed
 * supplied the event). The same when a receipt shows the batch arriving under the event's key but the
 * indexer's half of the scan holds no delivery of that batch with that key and transaction: the seed
 * left one out, or mislabeled it. */
export async function confirmAccountEvents(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, account: Address): Promise<void> {
  const lists = [
    ["deposited", scan.deposited],
    ["redeemed", scan.redeemed],
    ["adjustments", scan.adjustments],
  ] as const;
  const unconfirmed = lists.flatMap(([list, xs]) => xs.flatMap((e, i) => (e.unconfirmed ? [{ list, i, e }] : [])));
  if (unconfirmed.length === 0) return;
  // each transaction's receipt once, from a server past its block
  const blockOf = new Map<Hex, bigint>();
  for (const { e } of unconfirmed) blockOf.set(e.txHash, e.block > (blockOf.get(e.txHash) ?? 0n) ? e.block : blockOf.get(e.txHash)!);
  const hashes = [...blockOf.keys()];
  const receipts = new Map<Hex, Receipt | null>();
  const confirmed = new Map<string, AccountEvent>();
  for (let i = 0; i < hashes.length; i += CONFIRM_AT_ONCE) {
    const group = hashes.slice(i, i + CONFIRM_AT_ONCE);
    await Promise.all(group.map(async (hash) => void receipts.set(hash, await receiptAt(c, scan, hash, blockOf.get(hash)!))));
    for (const { list, i: at, e } of unconfirmed.filter((u) => group.includes(u.e.txHash))) {
      const r = receipts.get(e.txHash) ?? null;
      const shown = accountEventIn(r, d, account, e, list);
      if (!shown) {
        // judged before the restart clears the marks
        const seeded = seededAccount(scan, e.block);
        restart(scan);
        throw new HistoryMismatchError(seeded, true);
      }
      const batchId = e.kind === undefined ? deliveredBatchIn(r, d, e.key) : undefined;
      if (batchId !== undefined && seededShared(scan, e.block)) {
        const dl = scan.delivered.get(batchId);
        if (!dl || !same(dl.key, e.key) || !same(dl.txHash, e.txHash)) {
          restart(scan);
          throw new HistoryMismatchError(true, true);
        }
      }
      confirmed.set(`${list}:${at}`, dropUnconfirmed(shown));
    }
  }
  for (const [list, xs] of lists) for (let i = 0; i < xs.length; i++) xs[i] = confirmed.get(`${list}:${i}`) ?? xs[i];
}

/** A receipt as receiptAt gives it, or "unknown" when it can't tell yet (no answer, or no server far
 * enough past the block): a trail then stays at its previous step rather than guess. */
async function receiptOrUnknown(c: Pick<Clients, "bittensor">, scan: VaultScan, hash: Hex, block: bigint): Promise<Receipt | null | "unknown"> {
  try {
    return await receiptAt(c, scan, hash, block);
  } catch {
    return "unknown";
  }
}

/** Whether a receipt holds the vault's Staked. */
export const stakedIn = (r: Receipt | null, d: Deployment) =>
  mined(r) && parseEventLogs({ abi: VAULT, logs: r!.logs as never, eventName: "Staked", strict: false }).some((l) => same(l.address, d.vault));

/** Whether a receipt holds the vault's PayoutChunkSent for this key, chunk and taken count. */
export const chunkIn = (r: Receipt | null, d: Deployment, key: Hex, chunk: number, taken: number) =>
  mined(r) &&
  parseEventLogs({ abi: VAULT, logs: r!.logs as never, eventName: "PayoutChunkSent", strict: false }).some(
    (l) => same(l.address, d.vault) && same(l.args.key as string, key) && Number(l.args.chunk) === chunk && Number(l.args.taken) === taken,
  );

/** How many windows a trail reads itself to confirm that a seeded stake is the first after a delivery
 * (the vault stakes within minutes of a delivery; while it waits for the nominator minimum the browser's
 * own read of the seeded blocks, which goes on in the background, settles it instead). */
const STAKE_CHECK_WINDOWS = 3n;

/** The first stake after `block`, as a trail may use it: as the browser's own scan read it, or, for one
 * the indexer seeded, once its receipt shows the vault's Staked at that very block and the chain's logs
 * between `block` and it show no earlier stake (read here, a few windows at most, or by the background
 * read). Undefined when there is none and the blocks after `block` were read by the browser; "unknown"
 * while that can't be told yet (a receipt that can't be read, blocks the browser hasn't read): the
 * trail says so, never a step. Throws HistoryMismatchError when the chain contradicts a seeded stake
 * (not at its block, not there, or not the first): the caller starts the scan over (live.ts),
 * distrusting the indexer when the seed supplied it. */
export async function confirmedStakeAfter(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, block: bigint): Promise<Stake | undefined | "unknown"> {
  const i = scan.staked.findIndex((x) => x.block > block);
  const s = i >= 0 ? scan.staked[i] : undefined;
  if (!s) return sharedUnverified(scan, block + 1n, scan.next - 1n) ? "unknown" : undefined;
  if (s.unconfirmed) {
    const r = await receiptOrUnknown(c, scan, s.txHash, s.block);
    if (r === "unknown") return "unknown";
    if (!stakedIn(r, d) || (r!.blockNumber !== undefined && r!.blockNumber !== s.block)) throw new HistoryMismatchError(seededShared(scan, s.block));
    scan.staked[i] = { block: s.block, txHash: s.txHash, ...(s.clearBefore !== undefined ? { clearBefore: s.clearBefore } : {}) };
  }
  // the blocks between: read by the browser (the scan's own, or the background read), known clear, or read now
  const lo = block + 1n;
  const hi = s.block - 1n;
  const known = scan.staked[i].clearBefore;
  if (lo <= hi && sharedUnverified(scan, lo, hi) && !(known !== undefined && known <= lo)) {
    if (hi - lo + 1n > STAKE_CHECK_WINDOWS * WINDOW) return "unknown";
    try {
      for (let a = lo; a <= hi; a += WINDOW) {
        const b = a + WINDOW - 1n < hi ? a + WINDOW - 1n : hi;
        const raw = await windowLogs(c, d, a, b);
        const earlier = parseEventLogs({ abi: VAULT, logs: raw as never, eventName: "Staked", strict: false }).some((l) => same(l.address, d.vault));
        if (earlier) throw new HistoryMismatchError(true);
      }
    } catch (e) {
      if (e instanceof HistoryMismatchError) throw e;
      return "unknown";
    }
    scan.staked[i] = { ...scan.staked[i], clearBefore: lo };
  }
  return scan.staked[i];
}

/** How many chunk receipts are read at once. */
const CHUNKS_AT_ONCE = 4;

/** A batch key's payout chunks, as a trail may map an entry over them (chunkOf adds up `taken`, so a
 * missing one would shift every entry after it): numbered 0 … n with no gap, each as the browser's own
 * scan read it or, from a seed, with its receipt showing PayoutChunkSent for that key, chunk and taken
 * count at its block; and, with `entries` (how many payout entries the batch's delivery made), taking
 * no more than those. Undefined when there are none and the browser read the blocks after `since`
 * itself (the trail then says the payout hasn't left), or when the browser's own read has a gap (a node
 * that hasn't caught up: the trail waits); "unknown" while a receipt can't be read, or chunks may still
 * be missing from blocks the browser hasn't read. Throws HistoryMismatchError on a receipt that shows
 * otherwise, a gap in the seeded chunks, or seeded chunks taking more entries than the batch had. */
export async function confirmedChunks(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, key: Hex, o: { entries?: number; since?: bigint } = {}): Promise<PayoutChunk[] | undefined | "unknown"> {
  const chunks = [...(scan.payouts.get(key) ?? [])].sort((a, b) => a.chunk - b.chunk);
  const since = o.since ?? scan.from;
  if (chunks.length === 0) return sharedUnverified(scan, since, scan.next - 1n) ? "unknown" : undefined;
  const gap = chunks.findIndex((p, i) => p.chunk !== i);
  if (gap >= 0) {
    // the chunk after the gap is the indexer's: the missing one, earlier still, was the indexer's to give
    if (seededShared(scan, chunks[gap].block)) throw new HistoryMismatchError(true);
    return undefined;
  }
  const checked: (PayoutChunk | "unknown")[] = [];
  for (let i = 0; i < chunks.length; i += CHUNKS_AT_ONCE) {
    checked.push(
      ...(await Promise.all(
        chunks.slice(i, i + CHUNKS_AT_ONCE).map(async (p): Promise<PayoutChunk | "unknown"> => {
          if (!p.unconfirmed) return p;
          const r = await receiptOrUnknown(c, scan, p.txHash, p.block);
          if (r === "unknown") return "unknown";
          if (!chunkIn(r, d, key, p.chunk, p.taken) || (r!.blockNumber !== undefined && r!.blockNumber !== p.block)) throw new HistoryMismatchError(seededShared(scan, p.block));
          return { txHash: p.txHash, block: p.block, chunk: p.chunk, taken: p.taken };
        }),
      )),
    );
  }
  if (checked.some((p) => p === "unknown")) return "unknown";
  const confirmed = checked as PayoutChunk[];
  scan.payouts.set(key, confirmed);
  const taken = confirmed.reduce((n, p) => n + p.taken, 0);
  if (o.entries !== undefined && taken > o.entries) throw new HistoryMismatchError(confirmed.some((p) => seededShared(scan, p.block)));
  // a chunk still to come could sit in seeded blocks the browser hasn't read: then the list isn't known whole
  if ((o.entries === undefined || taken < o.entries) && sharedUnverified(scan, confirmed[confirmed.length - 1].block + 1n, scan.next - 1n)) return "unknown";
  return confirmed;
}

/** Whether a receipt holds the vault's BatchDelivered of batch `batchId` from our front door, under `key`. */
export function deliveryIn(r: Receipt | null, d: Deployment, batchId: string, key: Hex): boolean {
  return (
    mined(r) &&
    parseEventLogs({ abi: VAULT, logs: r!.logs as never, eventName: "BatchDelivered", strict: false }).some(
      (l) =>
        same(l.address, d.vault) &&
        String(l.args.batchId) === batchId &&
        l.args.sourceChain === BASE_CHAIN_ID &&
        !!l.args.frontDoor &&
        same(l.args.frontDoor, d.frontDoor) &&
        same(l.args.key as string, key),
    )
  );
}

/** Confirms saved deliveries of these batches by their receipts, a few at a time: one whose receipt shows
 * the vault's BatchDelivered for its batch, under its key, from our front door, at its block, is
 * confirmed. One whose receipt can't be read yet, or isn't readable from a server well past its block,
 * stays unconfirmed, and nothing relies on it (what can be unstaked mustn't fail over one receipt). One
 * whose receipt, from such a server, shows otherwise is a contradiction: HistoryMismatchError (naming
 * the indexer when the seed supplied it), and the caller starts the scan over. */
export async function checkDeliveries(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, batchIds: string[]): Promise<void> {
  const saved = batchIds.filter((id) => scan.delivered.get(id)?.unconfirmed);
  for (let i = 0; i < saved.length; i += CONFIRM_AT_ONCE) {
    await Promise.all(
      saved.slice(i, i + CONFIRM_AT_ONCE).map(async (batchId) => {
        const hit = scan.delivered.get(batchId);
        if (!hit?.unconfirmed) return;
        const r = await receiptOrUnknown(c, scan, hit.txHash, hit.block);
        if (r === "unknown") return;
        if (!deliveryIn(r, d, batchId, hit.key) || (r!.blockNumber !== undefined && r!.blockNumber !== hit.block)) throw new HistoryMismatchError(seededShared(scan, hit.block));
        scan.delivered.set(batchId, { key: hit.key, txHash: hit.txHash, block: hit.block });
      }),
    );
  }
}

/** A Bittensor receipt, asked together with the server's head (one request to one server, as windowLogs
 * asks): null only when that server is REREAD blocks past `block` and has no such transaction (a node's
 * log and receipt index can run hundreds of blocks behind the head it reports). Throws while it can't
 * tell (no answer, or a server not that far on), which must never be taken for "not there". */
export async function receiptAt(c: Pick<Clients, "bittensor">, scan: VaultScan, hash: Hex, block: bigint): Promise<Receipt | null> {
  const cached = scan.receipts.get(hash);
  if (cached) return cached;
  const [r, head] = await Promise.all([
    (c.bittensor.getTransactionReceipt({ hash }) as Promise<unknown>).catch((e) => {
      if ((e as { name?: string }).name === "TransactionReceiptNotFoundError") return null;
      throw e;
    }),
    c.bittensor.request({ method: "eth_blockNumber" }),
  ]);
  if (r) {
    scan.receipts.set(hash, r as Receipt);
    return r as Receipt;
  }
  if (BigInt(head as string) >= block + REREAD) return null;
  throw new StaleChainError();
}

/** One window of the vault's logs, taken only from a server that has reached the window's end. The
 * logs and the server's head are asked together, so they travel in one request to one server; a
 * server that is behind answers "no logs" for blocks it hasn't seen, which must not count as none. */
export async function windowLogs(c: Pick<Clients, "bittensor">, d: Deployment, from: bigint, to: bigint): Promise<RawLog[]> {
  for (let i = 0; i < FRESH_TRIES; i++) {
    const [raw, head] = await Promise.all([
      c.bittensor.getLogs({ address: d.vault, fromBlock: from, toBlock: to } as never) as Promise<unknown>,
      c.bittensor.request({ method: "eth_blockNumber" }),
    ]);
    if (BigInt(head as string) >= to) return raw as RawLog[];
  }
  throw new StaleChainError();
}

async function bitReceipt(c: Pick<Clients, "bittensor">, scan: VaultScan, hash: Hex): Promise<Receipt | null> {
  const cached = scan.receipts.get(hash);
  if (cached) return cached;
  const r = (await c.bittensor.getTransactionReceipt({ hash })) as unknown as Receipt | null;
  if (r) scan.receipts.set(hash, r);
  return r;
}

async function blockTime(c: Pick<Clients, "bittensor">, scan: VaultScan, block: bigint): Promise<Date> {
  const cached = scan.blockTimes.get(block);
  if (cached) return cached;
  const b = await c.bittensor.getBlock({ blockNumber: block });
  const at = new Date(Number(b.timestamp) * 1000);
  scan.blockTimes.set(block, at);
  return at;
}

/** A Base receipt, or null while it is not mined (Base is read by hash, never by logs). */
async function baseReceipt(c: Pick<Clients, "base">, hash: Hex | undefined): Promise<Receipt | null> {
  if (!hash) return null;
  try {
    return (await c.base.getTransactionReceipt({ hash })) as unknown as Receipt;
  } catch {
    return null;
  }
}

const mined = (r: Receipt | null) => r?.status === "success";

/** The front door's request event for `account` in a receipt (the batch it joined and, for a deposit, the TAO). */
function requestIn(r: Receipt | null, eventName: "DepositRequested" | "RedeemRequested", account: Address) {
  if (!r) return undefined;
  return parseEventLogs({ abi: FRONT_DOOR, logs: r.logs as never, eventName, strict: false }).find(
    (l) => l.args.user && same(l.args.user as string, account),
  );
}

const batchIdFrom = (r: Receipt | null, eventName: "DepositRequested" | "RedeemRequested", account: Address): bigint | undefined =>
  requestIn(r, eventName, account)?.args.batchId as bigint | undefined;

/** Where an unstake request stands on Base. `unsure` while its batch can't be known right now (it still
 * counts as asked), with `searchFailed` when a search for its replacement was made and couldn't answer,
 * and `searchedTo` when a search read further than the record says; `dead` when its hash can't be mined
 * as sent, so what took its place is still to be searched for (requestReplacement); `replacedBy` the
 * request a speed-up or replacement put in place of its hash, with that one's batch; `dropped` when
 * nothing took its place, so it asked for nothing. */
export interface RequestPlace {
  batchId?: bigint;
  unsure?: true;
  searchFailed?: true;
  searchedTo?: bigint;
  dead?: true;
  replacedBy?: Hex;
  dropped?: true;
}

/** The batch an unstake joined: as recorded, or from its request's receipt (one that shows no request,
 * as when it reverted, joined none). With no receipt it is `unsure` until its hash can't be mined as
 * sent (requestHashDead), then `dead`: requestReplacement takes it from there. */
export async function requestBatch(c: Pick<Clients, "base">, op: WithdrawalOp, now: number): Promise<RequestPlace> {
  if (op.batchId !== undefined) return { batchId: op.batchId };
  if (!op.hash) return {};
  const r = await baseReceipt(c, op.hash);
  if (r) {
    const batchId = batchIdFrom(r, "RedeemRequested", op.account);
    return batchId !== undefined ? { batchId } : {};
  }
  return (await requestHashDead(c, op, op.hash, now)) ? { dead: true } : { unsure: true };
}

/** How long after a search for a dead request's replacement couldn't answer it is tried again. */
export const SEARCH_RETRY_MS = 5 * 60_000;

/** What took the place of a `dead` request: the front door's logs are searched for the same request in
 * the two days after it was sent (findRequestTx: a speed-up made while no tab of this site watched
 * looks exactly like a drop). Found, it is that one's batch. Once those two days have passed and every
 * block of them is read with none found, it is `dropped`. Until then it stays `unsure`, still counted,
 * with `searchedTo`, the last block read, to be kept on the record (op.searchedTo): the next search
 * reads on from there, so each block is read once. One that can't be completed also stays `unsure`,
 * keeps what it read, and says so (`searchFailed`); within SEARCH_RETRY_MS of that (`searchFailedAt`) it
 * isn't searched again. `skip`: the hashes other records own, or have taken for theirs (two dead
 * records asking for the same shares are searched for one at a time, oldest first, so they never take
 * the same request). */
export async function requestReplacement(
  c: Pick<Clients, "base" | "baseLogs">,
  d: Deployment,
  op: WithdrawalOp,
  ctx: { now: number; skip: ReadonlySet<string>; searchFailedAt?: number },
): Promise<RequestPlace> {
  const failed = ctx.searchFailedAt;
  if (failed !== undefined && ctx.now >= failed && ctx.now - failed < SEARCH_RETRY_MS) return { unsure: true };
  const progress: { next?: bigint } = op.searchedTo !== undefined ? { next: op.searchedTo + 1n } : {};
  /** How far this search read, when that is further than the record says. */
  const read = () => (progress.next !== undefined && progress.next - 1n !== op.searchedTo ? { searchedTo: progress.next - 1n } : {});
  let found: Awaited<ReturnType<typeof findRequestTx>>;
  try {
    found = await findRequestTx(c, d, { account: op.account, shares: op.shares, sentAtMs: op.sentAt ?? op.createdAt, nowMs: ctx.now, skip: ctx.skip, progress });
  } catch {
    return { unsure: true, searchFailed: true, ...read() };
  }
  if (found === "none") return { dropped: true };
  if (found === "not yet") return { unsure: true, ...read() };
  return { batchId: found.batchId, replacedBy: found.hash };
}

/** How long after it was sent a request Base has never heard of is left alone before the account's
 * nonce is asked about (Base mines in seconds). */
export const DROPPED_AFTER_MS = 10 * 60_000;
/** A record made before requests kept their nonce: how long Base must not know its hash before it is
 * taken for gone. Base's nodes forget a transaction they can't take after about three hours. */
export const UNNUMBERED_DROPPED_AFTER_MS = 3 * 60 * 60_000;

/** Whether a request's hash with no receipt can't be mined as sent: the account's mined nonce is past
 * the request's (another transaction took its place: a speed-up, a cancel, or another request). Base
 * not knowing the hash isn't enough: in a fee spike a request under the base fee is invisible to Base's
 * public node and can still be mined later. So a hash Base doesn't know is taken for dead only ten
 * minutes after it was sent and once the account's nonce is past the one read before it was sent; a
 * record with none (made before it was kept) waits three hours instead. False whenever that can't be
 * told: Base not answering, or showing it mined with a receipt that isn't readable yet. */
async function requestHashDead(c: Pick<Clients, "base">, op: WithdrawalOp, hash: Hex, now: number): Promise<boolean> {
  const used = () => c.base.getTransactionCount({ address: op.account, blockTag: "latest" }).catch(() => undefined);
  let tx: { nonce: number; blockNumber: bigint | null };
  try {
    tx = (await c.base.getTransaction({ hash })) as unknown as { nonce: number; blockNumber: bigint | null };
  } catch (e) {
    if ((e as { name?: string })?.name !== "TransactionNotFoundError") return false;
    const since = now - (op.sentAt ?? op.createdAt);
    if (op.nonce === undefined) return since >= UNNUMBERED_DROPPED_AFTER_MS;
    if (since < DROPPED_AFTER_MS) return false;
    const n = await used();
    return n !== undefined && n > op.nonce;
  }
  if (tx.blockNumber !== null) return false;
  const n = await used();
  return n !== undefined && n > tx.nonce;
}

/** The batch a request taken for dropped joined after all: its own hash mined, with the account's
 * request in it. Undefined while Base shows no such thing, or can't be read. */
export async function droppedRequestMined(c: Pick<Clients, "base">, op: WithdrawalOp): Promise<bigint | undefined> {
  const r = await baseReceipt(c, op.hash);
  return mined(r) ? batchIdFrom(r, "RedeemRequested", op.account) : undefined;
}

/** An unstake still counted in its batch (not failed, not taken back out by a cancel), with that batch;
 * `unsure` when it was sent and its batch can't be known right now. */
export interface Placed {
  id: string;
  batchId?: bigint;
  shares: bigint;
  unsure?: true;
}

const closesAt = (fd: FrontDoorState, d: Deployment) => batchCloseAt(fd.openStart, fd.batchInterval, d.batchMaxWaitS);

/** Whether a record's cancel took it back out of its batch: the cancel went through on Base and came
 * out of the record's own batch (its DepositCancelled or RedeemCancelled names it; a cancel mined after
 * that batch closed came out of a later one). True wins over whatever the batch did after it: delivered
 * with other people's entries, or with another request of the account's. False once Base shows it
 * didn't (reverted, or another batch); undefined while that isn't known (no cancel, not mined yet, or
 * the receipt can't be read). The one test of "cancelled", wherever a record is counted. */
export async function cancelTook(c: Pick<Clients, "base">, op: DepositOp | WithdrawalOp, batchId = op.batchId): Promise<boolean | undefined> {
  if (!op.cancelled) return undefined;
  const r = await baseReceipt(c, op.cancelled.hash);
  if (!r) return undefined;
  if (!mined(r)) return false;
  const eventName = op.kind === "deposit" ? "DepositCancelled" : "RedeemCancelled";
  const cancel = parseEventLogs({ abi: FRONT_DOOR, logs: r.logs as never, eventName, strict: false }).find(
    (l) => !!l.args.user && same(l.args.user as string, op.account),
  );
  return cancel !== undefined && (batchId === undefined || cancel.args.batchId === batchId);
}

/** What the trail needs of a record's cancel: whether it took the record out (cancelTook) and, while it
 * has no receipt, whether it can still go through (cancelInFlight). */
async function cancelFacts(
  c: Pick<Clients, "base">,
  op: DepositOp | WithdrawalOp,
  batchId: bigint | undefined,
): Promise<{ cancelMined?: boolean; cancelPending?: "mined" | "waiting" | "unseen" }> {
  if (!op.cancelled) return { cancelMined: undefined };
  const took = await cancelTook(c, op, batchId);
  const pending = took === undefined ? await cancelInFlight(c, op.account, op.cancelled.hash) : undefined;
  return { cancelMined: took === true, ...(pending ? { cancelPending: pending } : {}) };
}

/** A cancel with no receipt yet, as Base sees it: "mined" (its receipt just isn't readable yet);
 * "waiting" to be mined, with a nonce the account hasn't used for another; "unseen" while Base doesn't
 * know it (just sent, or dropped); undefined once the account's nonce is past it, so it can never be mined. */
async function cancelInFlight(c: Pick<Clients, "base">, account: Address, hash: Hex): Promise<"mined" | "waiting" | "unseen" | undefined> {
  let tx: { nonce: number; blockNumber: bigint | null };
  try {
    tx = (await c.base.getTransaction({ hash })) as unknown as { nonce: number; blockNumber: bigint | null };
  } catch {
    return "unseen";
  }
  if (tx.blockNumber !== null) return "mined";
  const used = await c.base.getTransactionCount({ address: account, blockTag: "latest" }).catch(() => undefined);
  return used !== undefined && used > tx.nonce ? undefined : "waiting";
}

/** A batch's delivery as a trail may use it: the scan's, with its receipt (read in any case, for the
 * account's events), and only when that receipt delivered this batch under that key from our front
 * door at that block. One the scan holds that the chain contradicts (a receipt from a server well past
 * its block showing otherwise) is HistoryMismatchError: the saved history is wrong, the caller starts
 * the scan over. `unknown`: whether the batch arrived can't be told yet, so the trail says so rather than
 * a step: a saved entry whose receipt can't be read yet (a lagging node, or a block since replaced), or
 * no entry while the indexer's blocks the delivery could be in haven't been read by the browser. */
async function deliveryOf(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, batchId: bigint | undefined): Promise<{ hit?: { key: Hex; txHash: Hex; block: bigint }; r: Receipt | null; unknown?: true }> {
  const saved = batchId !== undefined ? scan.delivered.get(String(batchId)) : undefined;
  if (!saved) return batchId !== undefined && sharedUnverified(scan, scan.from, scan.next - 1n) ? { hit: undefined, r: null, unknown: true } : { hit: undefined, r: null };
  if (!saved.unconfirmed) {
    const r = await bitReceipt(c, scan, saved.txHash);
    return { hit: deliveryIn(r, d, String(batchId), saved.key) ? saved : undefined, r };
  }
  const r = await receiptOrUnknown(c, scan, saved.txHash, saved.block);
  if (r === "unknown") return { hit: undefined, r: null, unknown: true };
  if (!deliveryIn(r, d, String(batchId), saved.key) || (r!.blockNumber !== undefined && r!.blockNumber !== saved.block)) throw new HistoryMismatchError(seededShared(scan, saved.block));
  const confirmed = { key: saved.key, txHash: saved.txHash, block: saved.block };
  scan.delivered.set(String(batchId), confirmed);
  return { hit: confirmed, r };
}

/** How many payout entries a batch's delivery made (the bounced deposits and redeems the vault lists for
 * its payout chunks), from the delivery's receipt. */
function entriesIn(r: Receipt | null, d: Deployment, key: Hex): number {
  return parseEventLogs({ abi: VAULT, logs: (r?.logs ?? []) as never, strict: false }).filter(
    (l) => same(l.address, d.vault) && (l.eventName === "DepositBounced" || l.eventName === "Redeemed") && same(l.args.key as string, key),
  ).length;
}

/** The account's own vault events in a delivery's receipt, for this batch (`key`) only. */
const accountEvents = (r: Receipt | null, d: Deployment, key: Hex, account: Address) =>
  parseEventLogs({ abi: VAULT, logs: (r?.logs ?? []) as never, strict: false }).filter(
    (l) =>
      same(l.address, d.vault) &&
      "user" in l.args &&
      !!l.args.user &&
      same(l.args.user as string, account) &&
      "key" in l.args &&
      same(l.args.key as string, key),
  );

export async function depositFacts(
  c: Pick<Clients, "base" | "bittensor">,
  d: Deployment,
  op: DepositOp,
  ctx: { fd: FrontDoorState; vault: VaultState; scan: VaultScan },
): Promise<{ batchId?: bigint; facts: DepositFacts }> {
  // v3: CascadeStaker swaps and deposits in its one `stake` transaction, so both steps read that receipt
  const v3 = op.v === 3;
  const swap = await baseReceipt(c, v3 ? op.hashes.stake : op.hashes.swap);
  const dep = v3 ? swap : await baseReceipt(c, op.hashes.deposit);
  // an exact-output swap spends at most the quoted USDC, and a v3 stake takes its fees from the USDC it
  // pulls: the receipt says how much really left the account
  const usdcSpent = mined(swap)
    ? parseEventLogs({ abi: ERC20, logs: swap!.logs as never, eventName: "Transfer", strict: false })
        .filter((l) => same(l.address, TOKENS.usdc) && same(l.args.from as string, op.account))
        .reduce((sum, l) => sum + (l.args.value as bigint), 0n)
    : 0n;
  const batchId = op.batchId ?? batchIdFrom(dep, "DepositRequested", op.account);
  // the stake deposits whatever the swap gave (at least its floor), not the quote: the front door's record says
  const taoDeposited = v3 ? (requestIn(dep, "DepositRequested", op.account)?.args as { amount?: bigint } | undefined)?.amount : undefined;
  const facts: DepositFacts = {
    // a deposit of TAO already in the wallet has no swap
    swapMined: op.usdcIn === 0n ? mined(dep) || !!op.hashes.deposit : mined(swap),
    depositMined: mined(dep),
    ...(usdcSpent > 0n ? { usdcSpent } : {}),
    ...(taoDeposited !== undefined ? { taoDeposited } : {}),
    ...(await cancelFacts(c, op, batchId)),
    now: new Date(),
    depositedAt: new Date(op.createdAt),
    watchUrl: explorer.ccipAddress(d.baseAdapter),
    openBatchId: ctx.fd.openBatchId,
    closesAt: closesAt(ctx.fd, d),
    ...(d.batchMaxWaitS ? { closesBy: true as const } : {}),
    stillOpen: batchId === undefined || batchId === ctx.fd.openBatchId,
    waitingForMinimum: false,
    // the batch before the open one left Base when the open one started
    ...(batchId !== undefined && batchId === ctx.fd.openBatchId - 1n ? { sentAt: new Date(ctx.fd.openStart * 1000) } : {}),
  };
  // taken back out of its batch: what the batch did after isn't this deposit's
  const { hit, r, unknown } = !facts.cancelMined ? await deliveryOf(c, d, ctx.scan, batchId) : { hit: undefined, r: null };
  if (unknown) facts.deliveryUnknown = true;
  if (hit) {
    const mine = accountEvents(r, d, hit.key, op.account);
    const outcome = mine.some((l) => l.eventName === "DepositBounced")
      ? "bounced"
      : mine.some((l) => l.eventName === "DepositSkipped")
        ? "skipped"
        : "deposited";
    const message = parseEventLogs({ abi: ADAPTER, logs: (r?.logs ?? []) as never, eventName: "Delivered", strict: false }).find(
      (l) => same(l.address, d.bitAdapter),
    );
    facts.delivered = { at: await blockTime(c, ctx.scan, hit.block), txHash: hit.txHash, outcome, messageId: message?.args.messageId as Hex | undefined };
    const staked = await confirmedStakeAfter(c, d, ctx.scan, hit.block);
    if (staked === "unknown") facts.stakeUnknown = true;
    else if (staked) facts.staked = { at: await blockTime(c, ctx.scan, staked.block), txHash: staked.txHash };
    else {
      const idle = ctx.vault.balanceWei > ED_RESERVE + ctx.vault.pendingPayouts ? ctx.vault.balanceWei - ED_RESERVE - ctx.vault.pendingPayouts : 0n;
      facts.waitingForMinimum = outcome === "deposited" && ctx.vault.rootStakeWei + idle < ctx.vault.nominatorMinWei;
      facts.vaultWei = ctx.vault.rootStakeWei + idle;
      facts.minimumWei = ctx.vault.nominatorMinWei;
    }
  }
  return { batchId, facts };
}

export async function withdrawalFacts(
  c: Pick<Clients, "base" | "baseLogs" | "bittensor">,
  d: Deployment,
  op: WithdrawalOp,
  /** `siblings`: this browser's unstakes still counted in their batches, to share out an entry the
   * front door made of several of them. */
  ctx: { fd: FrontDoorState; vault: VaultState; scan: VaultScan; claims: ClaimOp[]; siblings?: Placed[] },
): Promise<{ batchId?: bigint; facts: WithdrawalFacts }> {
  const req = await baseReceipt(c, op.hash);
  const batchId = op.batchId ?? batchIdFrom(req, "RedeemRequested", op.account);
  const facts: WithdrawalFacts = {
    requestMined: mined(req),
    ...(await cancelFacts(c, op, batchId)),
    now: new Date(),
    requestedAt: new Date(op.createdAt),
    watchUrl: explorer.ccipAddress(d.baseAdapter),
    ...(batchId !== undefined && batchId === ctx.fd.openBatchId - 1n ? { sentAt: new Date(ctx.fd.openStart * 1000) } : {}),
    openBatchId: ctx.fd.openBatchId,
    closesAt: closesAt(ctx.fd, d),
    ...(d.batchMaxWaitS ? { closesBy: true as const } : {}),
    stillOpen: batchId === undefined || batchId === ctx.fd.openBatchId,
    claimable: ctx.fd.claimable,
    payoutDelay: ctx.vault.payoutDelay,
  };
  // taken back out of its batch: a Redeemed there is another request of the account's, not this one
  if (facts.cancelMined) return { batchId, facts };
  const { hit, r, unknown } = await deliveryOf(c, d, ctx.scan, batchId);
  if (unknown) facts.deliveryUnknown = true;
  /** This request's part of an amount paid on the account's entry in its batch. */
  let part = (amount: bigint) => amount;
  if (hit) {
    const mine = accountEvents(r, d, hit.key, op.account);
    const redeemed = mine.find((l) => l.eventName === "Redeemed");
    const entry = redeemed?.args as { shares: bigint; assets: bigint } | undefined;
    if (entry) part = partOf({ ...op, batchId }, entry.shares, ctx.siblings ?? []);
    const at = await blockTime(c, ctx.scan, hit.block);
    if (entry) facts.delivered = { at, txHash: hit.txHash, outcome: "redeemed", taoWei: part(entry.assets) };
    else if (mine.some((l) => l.eventName === "RedeemDeferred")) facts.delivered = { at, txHash: hit.txHash, outcome: "deferred" };
    else if (mine.some((l) => l.eventName === "RedeemSkipped")) facts.delivered = { at, txHash: hit.txHash, outcome: "skipped" };

    const chunks = redeemed ? await confirmedChunks(c, d, ctx.scan, hit.key, { entries: entriesIn(r, d, hit.key), since: hit.block }) : undefined;
    if (chunks === "unknown") facts.payoutUnknown = true;
    const sent = chunks && chunks !== "unknown" ? chunkOf(chunks, entryIndex(r, d, hit.key, op.account)) : undefined;
    if (redeemed && sent) {
      const pr = await bitReceipt(c, ctx.scan, sent.txHash);
      const at = await blockTime(c, ctx.scan, sent.block);
      // worth less than its share of the bridge fee: the vault kept it and sent this account nothing
      const dust = parseEventLogs({ abi: VAULT, logs: (pr?.logs ?? []) as never, eventName: "PayoutDust", strict: false }).some(
        (l) => same(l.address, d.vault) && same(l.args.key as string, hit.key) && !!l.args.user && same(l.args.user as string, op.account),
      );
      if (dust) facts.payout = { txHash: sent.txHash, state: 0, at, dust: true };
      else {
        const msg = parseEventLogs({ abi: ADAPTER, logs: (pr?.logs ?? []) as never, eventName: "Sent", strict: false }).find((l) =>
          same(l.address, d.bitAdapter),
        );
        const messageId = msg?.args.messageId as Hex | undefined;
        const state = messageId
          ? Number(await c.base.readContract({ address: OFFRAMP.base, abi: OFFRAMP_ABI, functionName: "getExecutionState", args: [messageId] }))
          : 0;
        facts.payout = { txHash: sent.txHash, messageId, state: Math.min(3, Math.max(0, state)) as 0 | 1 | 2 | 3, at };
      }
    }
  }
  const claim = ctx.claims.find((k) => k.withdrawalIds?.includes(op.id) && k.hashes.claim);
  if (claim) facts.claimed = await claimResult(c, claim);
  if (claim && !facts.claimed && (claim.state === "running" || claim.state === "sent")) facts.claimPending = true;
  // v3: once the payout is back on Base, what took it, and how much of it was this payout's
  if (isV3(d) && hit && facts.payout?.state === 2) await deliveryFacts(c, d, op, ctx, hit.key, facts, part);
  return { batchId, facts };
}

/** This request's part of the account's entry in its batch. The front door adds up an account's
 * requests in one batch into one entry, so each one's part is its shares over the larger of what the
 * entry burned (all of them, from any browser) and what this browser's requests there asked for (more,
 * when the vault couldn't burn the whole entry). An entry that was this request's alone is all its own. */
function partOf(op: WithdrawalOp, burned: bigint, siblings: Placed[]): (amount: bigint) => bigint {
  const asked = siblings.filter((o) => o.id !== op.id && o.batchId !== undefined && o.batchId === op.batchId).reduce((sum, o) => sum + o.shares, op.shares);
  const whole = burned > asked ? burned : asked;
  return (amount) => (op.shares >= whole ? amount : (amount * op.shares) / whole);
}

/** Where the account's redeem sits in its batch's payout list: the vault lists a batch's bounced
 * deposits and redeems in the order of their DepositBounced and Redeemed events in the delivery. */
function entryIndex(r: Receipt | null, d: Deployment, key: Hex, account: Address): number {
  const entries = parseEventLogs({ abi: VAULT, logs: (r?.logs ?? []) as never, strict: false }).filter(
    (l) => same(l.address, d.vault) && (l.eventName === "DepositBounced" || l.eventName === "Redeemed") && same(l.args.key as string, key),
  );
  return entries.findIndex((l) => l.eventName === "Redeemed" && same(l.args.user as string, account));
}

/** The chunk that carried payout entry `index`, once it has left: the vault sends a batch's list in
 * chunks, in turn, each taking the next `taken` entries. */
function chunkOf(chunks: PayoutChunk[], index: number): PayoutChunk | undefined {
  if (index < 0) return undefined;
  let start = 0;
  for (const c of [...chunks].sort((a, b) => a.chunk - b.chunk)) {
    if (index < start + c.taken) return c;
    start += c.taken;
  }
  return undefined;
}

/** A v3 payout back on Base: what it credited the account, then the delivery that sold it (its receipt
 * is the only source of the USDC received) or a claim by hand that took it, each marked shared when it
 * took more than this payout's credit (one sale or claim of several payouts). While neither has, and no
 * claim from this browser settled it, the account's delivery preference and what the TAO would sell for
 * now, so the trail can say whether delivery can still happen. */
async function deliveryFacts(
  c: Pick<Clients, "base" | "baseLogs" | "bittensor">,
  d: Deployment,
  op: WithdrawalOp,
  ctx: { fd: FrontDoorState; scan: VaultScan },
  key: Hex,
  facts: WithdrawalFacts,
  /** This request's part of the account's credit (see partOf). */
  part: (amount: bigint) => bigint,
): Promise<void> {
  // the batch's first chunk left Bittensor first: no part of the payout can land on Base before it
  const chunks = await confirmedChunks(c, d, ctx.scan, key);
  const first = chunks && chunks !== "unknown" ? chunks[0] : undefined;
  if (!first) {
    facts.traceFailed = true;
    return;
  }
  const id = key.toLowerCase();
  const t = ctx.scan.onBase.get(id) ?? {};
  ctx.scan.onBase.set(id, t);
  try {
    await tracePayout(c, d, { account: op.account, batchKey: key, sentAt: await blockTime(c, ctx.scan, first.block) }, t);
  } catch {
    // unreadable right now: no receipt and no amount, never a guessed one; what was read is kept
    if (!t.end) facts.traceFailed = true;
  }
  const credit = t.landed ? part(t.landed.amount) : undefined;
  if (t.landed && credit !== undefined) facts.credited = { at: t.landed.at, taoWei: credit };
  if (t.end?.kind === "delivered") {
    const { hash, at, usdcOut, taoIn } = t.end;
    facts.usdcDelivered = { hash, at, usdcOut, ...(taoIn !== credit ? { shared: true as const } : {}) };
  } else if (t.end) {
    const { hash, at, amount } = t.end;
    facts.claimedOnChain = { hash, at, taoClaimed: amount, ...(amount !== credit ? { shared: true as const } : {}) };
  }
  if (t.end || facts.claimed || ctx.fd.claimable === 0n) return;
  try {
    const [minUsdcPerTao, deadline] = (await c.base.readContract({
      address: d.frontDoor,
      abi: FRONT_DOOR,
      functionName: "deliveryOf",
      args: [op.account],
    })) as readonly [bigint, bigint, number];
    facts.preference = minUsdcPerTao === 0n ? null : { minUsdcPerTao, deadline: Number(deadline) };
  } catch {
    // unread: the trail goes by the preference this unstake asked for
  }
  const p = facts.preference;
  if (!p || p.deadline * 1000 < facts.now.getTime()) return;
  try {
    // the keeper sells everything claimable at once, and the staker takes its fee from the sale's USDC
    const [gross, fees] = await Promise.all([quoteSell(c, ctx.fd.claimable), readStakerFees(c, d)]);
    facts.saleNowUsdc = gross - (gross * fees.swapFeeBps) / 10_000n;
  } catch {
    // no quote: the trail can't tell the price is under the minimum, so it doesn't say so
  }
}

/** What a claim really paid, from its receipts: the TAO claimed and, if it swapped, the USDC received.
 * Undefined while the claim (or its swap, still in flight) has not settled. */
async function claimResult(c: Pick<Clients, "base">, k: ClaimOp): Promise<WithdrawalFacts["claimed"]> {
  const claimReceipt = await baseReceipt(c, k.hashes.claim);
  if (!mined(claimReceipt)) return undefined;
  const claimedLog = parseEventLogs({ abi: FRONT_DOOR, logs: claimReceipt!.logs as never, eventName: "Claimed", strict: false }).find(
    (l) => same(l.args.user as string, k.account),
  );
  const taoClaimed = (claimedLog?.args.amount as bigint | undefined) ?? k.amount;
  // one claim of several unstakes: what it paid isn't this one's alone
  const base = { hash: k.hashes.claim as Hex, at: new Date(k.createdAt), taoClaimed, ...((k.withdrawalIds?.length ?? 0) > 1 ? { shared: true as const } : {}) };
  if (k.keepTao) return { ...base, keptTao: true, swapFailed: false };
  const swapReceipt = await baseReceipt(c, k.hashes.swap);
  if (mined(swapReceipt)) {
    const usdcOut = parseEventLogs({ abi: ERC20, logs: swapReceipt!.logs as never, eventName: "Transfer", strict: false })
      .filter((l) => same(l.address, TOKENS.usdc) && same(l.args.to as string, k.account))
      .reduce((sum, l) => sum + (l.args.value as bigint), 0n);
    return { ...base, usdcOut, keptTao: false, swapFailed: false };
  }
  // the claim went through; a swap that stopped (not one still running) leaves the TAO in the wallet
  return k.state === "failed" || k.state === "needs-you" ? { ...base, keptTao: false, swapFailed: true } : undefined;
}

/** Whether a claim went through on Base: its receipt succeeded and shows the account's Claimed event (a
 * smart account can mine a transaction in which the claim itself reverted). False with no claim sent, or
 * a receipt that shows it didn't; undefined while Base has no receipt to show (a node that is behind, or
 * not mined yet), and throws when it can't be read: neither may ever be taken for "no". */
export async function claimWentThrough(c: Pick<Clients, "base">, k: Pick<ClaimOp, "account" | "hashes">): Promise<boolean | undefined> {
  if (!k.hashes.claim) return false;
  let r: Receipt;
  try {
    r = (await c.base.getTransactionReceipt({ hash: k.hashes.claim })) as unknown as Receipt;
  } catch (e) {
    if ((e as { name?: string }).name === "TransactionReceiptNotFoundError") return undefined;
    throw e;
  }
  return (
    mined(r) &&
    parseEventLogs({ abi: FRONT_DOOR, logs: r.logs as never, eventName: "Claimed", strict: false }).some(
      (l) => !!l.args.user && same(l.args.user as string, k.account),
    )
  );
}

/** Base log windows on RPC.baseLogs: at most 2,000 blocks. */
const BASE_LOG_WINDOW = 2_000n;
/** Base makes a block every 2 seconds. */
const BASE_BLOCK_MS = 2_000;
/** How far before a record's creation a search for its stake starts: 5 minutes of blocks. */
const STAKE_SEARCH_MARGIN = 150n;

/** One window of Base logs, taken only from a server that has reached the window's end: the logs and
 * the server's head travel in one request (see windowLogs), so "no logs" from a server that is behind
 * is never taken for none. */
async function baseWindowLogs(c: Pick<Clients, "baseLogs">, filter: { address: Address; topics: (Hex | Hex[] | null)[] }, from: bigint, to: bigint): Promise<RawLog[]> {
  for (let i = 0; i < FRESH_TRIES; i++) {
    const [raw, head] = await Promise.all([
      c.baseLogs.request({ method: "eth_getLogs", params: [{ ...filter, fromBlock: toHex(from), toBlock: toHex(to) }] } as never) as Promise<unknown>,
      c.baseLogs.request({ method: "eth_blockNumber" }),
    ]);
    if (BigInt(head as string) >= to) return raw as RawLog[];
  }
  throw new Error("Base's log server is behind right now");
}

/** How far before a payout left Bittensor its search on Base starts, for the two chains' clocks: 5 minutes of blocks. */
const PAYOUT_SEARCH_MARGIN = 150n;
/** Base's newest blocks are left for the next read: one still being made or replaced is read then. */
const BASE_SETTLE = 2n;

type LogPos = { block: bigint; index: number };
/** Where a log sits on Base. Raw JSON-RPC logs carry hex strings, decoded ones numbers. */
const posOf = (l: { blockNumber: unknown; logIndex: unknown }): LogPos => ({ block: BigInt(l.blockNumber as string), index: Number(l.logIndex) });
const later = (a: LogPos, b: LogPos) => a.block > b.block || (a.block === b.block && a.index > b.index);

/** A v3 payout's life on Base, read forward from the front door's logs and kept between reads. */
export interface BasePayout {
  /** The first Base block not read yet; unset before the first read. */
  next?: bigint;
  /** Where, when and how much the account's share was credited (its PayoutReceived). */
  landed?: LogPos & { at: Date; amount: bigint };
  /** What took it first after that: the keeper's delivery (the TAO it sold, the USDC it paid), or a
   * claim by hand (the TAO it took). Either may have taken other payouts' credit too. */
  end?: { kind: "delivered"; hash: Hex; at: Date; taoIn: bigint; usdcOut: bigint } | { kind: "claimed"; hash: Hex; at: Date; amount: bigint };
  /** A read under way: another caller waits for it rather than reading the same blocks again. */
  reading?: Promise<void>;
}

const baseBlockTime = async (c: Pick<Clients, "base">, block: bigint) => new Date(Number((await c.base.getBlock({ blockNumber: block })).timestamp) * 1000);

const frontDoorTopic = (eventName: "PayoutReceived" | "Delivered" | "Claimed") => encodeEventTopics({ abi: FRONT_DOOR, eventName } as never)[0] as Hex;

/** Follows the account's share of a v3 payout on Base: the PayoutReceived that credited it, then the
 * first Delivered (the keeper sold it for USDC) or Claimed (taken by hand) for the account after it;
 * earlier ones took earlier payouts. Topic-filtered front door logs in windows of at most 2,000 blocks,
 * from a little before the payout left Bittensor (it can't land earlier) up to the newer of the logs
 * server's head and Base's own, so a logs server that is behind fails its window check instead of
 * hiding a recent log. Resumes where it stopped; throws when a window can't be read, keeping what was. */
export function tracePayout(
  c: Pick<Clients, "base" | "baseLogs">,
  d: Deployment,
  s: { account: Address; batchKey: Hex; sentAt: Date },
  t: BasePayout,
): Promise<void> {
  if (t.end) return Promise.resolve();
  t.reading ??= readPayout(c, d, s, t).finally(() => {
    t.reading = undefined;
  });
  return t.reading;
}

async function readPayout(c: Pick<Clients, "base" | "baseLogs">, d: Deployment, s: { account: Address; batchKey: Hex; sentAt: Date }, t: BasePayout): Promise<void> {
  const [logsHead, tip] = await Promise.all([
    c.baseLogs.request({ method: "eth_blockNumber" }).then((h) => BigInt(h as string)),
    c.base.getBlock({ blockTag: "latest" }),
  ]);
  if (t.next === undefined) {
    // counted back from Base's newest block by its own clock, not the device's
    const back = BigInt(Math.ceil(Math.max(0, Number(tip.timestamp) * 1000 - s.sentAt.getTime()) / BASE_BLOCK_MS)) + PAYOUT_SEARCH_MARGIN;
    t.next = tip.number > back ? tip.number - back : 0n;
  }
  const head = logsHead > tip.number ? logsHead : tip.number;
  const latest = head - BASE_SETTLE;
  const [, user] = encodeEventTopics({ abi: FRONT_DOOR, eventName: "Delivered", args: { user: s.account } });
  // this batch's credits (any user: the user is the third topic) and the account's deliveries and claims
  const filter = {
    address: d.frontDoor,
    topics: [[frontDoorTopic("PayoutReceived"), frontDoorTopic("Delivered"), frontDoorTopic("Claimed")], [s.batchKey, user as Hex]],
  };
  for (let from = t.next; from <= latest && !t.end; from += BASE_LOG_WINDOW) {
    const to = from + BASE_LOG_WINDOW - 1n < latest ? from + BASE_LOG_WINDOW - 1n : latest;
    const raw = await baseWindowLogs(c, filter, from, to);
    const mine = parseEventLogs({ abi: FRONT_DOOR, logs: raw as never, strict: false })
      .filter((l) => same(l.address, d.frontDoor) && same(((l.args as { user?: string }).user ?? "0x"), s.account))
      .sort((a, b) => (later(posOf(a), posOf(b)) ? 1 : -1));
    for (const l of mine) {
      const at = posOf(l);
      if (!t.landed) {
        const args = l.args as { batchKey?: string; amount?: bigint };
        if (l.eventName === "PayoutReceived" && same(args.batchKey ?? "0x", s.batchKey)) {
          t.landed = { ...at, at: await baseBlockTime(c, at.block), amount: args.amount ?? 0n };
        }
      } else if ((l.eventName === "Delivered" || l.eventName === "Claimed") && later(at, t.landed)) {
        const hash = l.transactionHash as Hex;
        const when = await baseBlockTime(c, at.block);
        const args = l.args as { taoIn?: bigint; usdcOut?: bigint; amount?: bigint };
        t.end =
          l.eventName === "Delivered"
            ? { kind: "delivered", hash, at: when, taoIn: args.taoIn ?? 0n, usdcOut: args.usdcOut ?? 0n }
            : { kind: "claimed", hash, at: when, amount: args.amount ?? 0n };
        break;
      }
    }
    t.next = to + 1n;
  }
}

/** The transaction of a v3 stake the account paid for itself (payer and beneficiary both the account)
 * of exactly `usdcIn`, mined since the record was made (a little earlier, for timing), that no other
 * record (`skip`) owns: the stake a reload lost the hash of. Null if there is none; throws when the
 * logs can't be read, which must never be taken for "none". */
export async function findStakeTx(
  c: Pick<Clients, "base" | "baseLogs">,
  d: Deployment,
  s: { account: Address; usdcIn: bigint; createdAtMs: number; nowMs: number; skip: ReadonlySet<string> },
): Promise<Hex | null> {
  if (!d.staker) return null;
  const staker = d.staker;
  const topics = encodeEventTopics({ abi: STAKER, eventName: "Staked", args: { payer: s.account, beneficiary: s.account } });
  const skip = new Set([...s.skip].map((h) => h.toLowerCase()));
  return searchBaseSince(c, { sinceMs: s.createdAtMs, nowMs: s.nowMs }, { address: staker, topics }, (raw) => {
    const hit = parseEventLogs({ abi: STAKER, logs: raw as never, eventName: "Staked", strict: false }).find(
      (l) =>
        same(l.address, staker) &&
        !!l.args.payer &&
        same(l.args.payer, s.account) &&
        !!l.args.beneficiary &&
        same(l.args.beneficiary, s.account) &&
        l.args.usdcIn === s.usdcIn &&
        !!l.transactionHash &&
        !skip.has(l.transactionHash.toLowerCase()),
    );
    return hit ? (hit.transactionHash as Hex) : undefined;
  });
}

/** How long after it was sent a request's replacement is looked for: a speed-up or replacement reuses
 * its nonce, so it is mined soon after the send, whenever the user comes back to look. */
export const REPLACEMENT_SPAN_MS = 2 * 24 * 60 * 60_000;

/** The account's unstake request of exactly `shares` through the front door that no other record
 * (`skip`) owns, with the batch it joined: the request a wallet's speed-up or replacement put in place
 * of a hash that can't be mined. Searched for from a little before the request was sent (`sentAtMs`) to
 * a little after REPLACEMENT_SPAN_MS on (a later request of the same shares is another request), oldest
 * first, from `progress.next` when an earlier search got that far: each block is read once, and
 * `progress.next` follows every window read, so a search cut short keeps what it read. "none" once the
 * whole span is read and holds none; "not yet" while the span hasn't all passed (its newest blocks are
 * read next time). Throws when a window can't be read, which must never be taken for "none". */
export async function findRequestTx(
  c: Pick<Clients, "base" | "baseLogs">,
  d: Deployment,
  s: { account: Address; shares: bigint; sentAtMs: number; nowMs: number; skip: ReadonlySet<string>; progress: { next?: bigint } },
): Promise<{ hash: Hex; batchId: bigint } | "none" | "not yet"> {
  const head = await baseHead(c);
  // the device clock made both times, so their difference is the time since, whatever the clock says
  const age = Math.max(0, s.nowMs - s.sentAtMs);
  const blocks = (ms: number) => BigInt(Math.ceil(ms / BASE_BLOCK_MS));
  const sent = head > blocks(age) ? head - blocks(age) : 0n;
  const start = sent > STAKE_SEARCH_MARGIN ? sent - STAKE_SEARCH_MARGIN : 0n;
  const passed = age >= REPLACEMENT_SPAN_MS;
  const settled = head > BASE_SETTLE ? head - BASE_SETTLE : 0n;
  const spanEnd = sent + blocks(REPLACEMENT_SPAN_MS) + STAKE_SEARCH_MARGIN;
  const end = passed && spanEnd < settled ? spanEnd : settled;
  const from = s.progress.next !== undefined && s.progress.next > start ? s.progress.next : start;
  const topics = encodeEventTopics({ abi: FRONT_DOOR, eventName: "RedeemRequested", args: { user: s.account } });
  const skip = new Set([...s.skip].map((h) => h.toLowerCase()));
  const hit = await searchBase(c, from, end, { address: d.frontDoor, topics }, s.progress, (raw) => {
    const request = parseEventLogs({ abi: FRONT_DOOR, logs: raw as never, eventName: "RedeemRequested", strict: false }).find(
      (l) =>
        same(l.address, d.frontDoor) &&
        !!l.args.user &&
        same(l.args.user, s.account) &&
        l.args.shares === s.shares &&
        l.args.batchId !== undefined &&
        !!l.transactionHash &&
        !skip.has(l.transactionHash.toLowerCase()),
    );
    return request ? { hash: request.transactionHash as Hex, batchId: request.args.batchId as bigint } : undefined;
  });
  return hit ?? (passed ? "none" : "not yet");
}

/** Base's newest block as the newer of the logs server's head and Base's own: a logs server that is
 * behind then fails its window check instead of answering "none" for blocks it hasn't seen. */
async function baseHead(c: Pick<Clients, "base" | "baseLogs">): Promise<bigint> {
  const [logsHead, own] = await Promise.all([c.baseLogs.request({ method: "eth_blockNumber" }).then((h) => BigInt(h as string)), c.base.getBlockNumber()]);
  return logsHead > own ? logsHead : own;
}

/** The open batch's deposits the staker made, as the keeper counts them (ops/src/keeper/state.ts,
 * stakerDeposits): the batch's DepositRequested logs naming the staker as the payer, the only deposits
 * that paid its deposit and swap fees (TAO deposited straight into the front door paid neither). Read
 * from Base's logs back to the batch's start (its age in 2-second blocks, and five minutes more). None
 * on v2, which has no staker. Throws when the logs can't be read. */
export async function stakerDepositsIn(
  c: Pick<Clients, "base" | "baseLogs">,
  d: Deployment,
  batchId: bigint,
  ageS: number,
): Promise<{ count: number; tao: bigint }> {
  const staker = d.staker;
  if (!staker) return { count: 0, tao: 0n };
  const topics = encodeEventTopics({ abi: FRONT_DOOR, eventName: "DepositRequested", args: { batchId } }) as (Hex | null)[];
  const blocks = BigInt(Math.ceil(Math.max(ageS, 0) / 2)) + STAKE_SEARCH_MARGIN;
  const raw = await recentBaseLogs(c, { address: d.frontDoor, topics }, blocks);
  const staked = parseEventLogs({ abi: FRONT_DOOR, eventName: "DepositRequested", logs: raw as never, strict: false }).filter(
    (l) => same(l.address, d.frontDoor) && l.args.batchId === batchId && !!l.args.payer && same(l.args.payer, staker),
  );
  return { count: staked.length, tao: staked.reduce((t, l) => t + (l.args.amount ?? 0n), 0n) };
}

/** Every log matching `filter` in Base's last `blocks` blocks, oldest first, read in windows of at most
 * 2,000 blocks up to the newer of the two servers' heads less BASE_SETTLE, as Base's other scans read (a
 * block still being made or replaced is read next time). Throws when a window can't be read (or its
 * server is behind), which must never be taken for "none". */
export async function recentBaseLogs(
  c: Pick<Clients, "base" | "baseLogs">,
  filter: { address: Address; topics: (Hex | Hex[] | null)[] },
  blocks: bigint,
): Promise<RawLog[]> {
  const head = await baseHead(c);
  const end = head > BASE_SETTLE ? head - BASE_SETTLE : 0n;
  const out: RawLog[] = [];
  for (let a = end > blocks ? end - blocks : 0n; a <= end; a += BASE_LOG_WINDOW) {
    const b = a + BASE_LOG_WINDOW - 1n < end ? a + BASE_LOG_WINDOW - 1n : end;
    out.push(...(await baseWindowLogs(c, filter, a, b)));
  }
  return out;
}

/** Searches Base's logs matching `filter` from block `from` to `to`, oldest first, for the first window
 * `pick` finds something in; `progress.next` is the first block not read yet after each window. Null
 * when none does; throws when a window can't be read (or its server is behind), which must never be
 * taken for "none". */
async function searchBase<T>(
  c: Pick<Clients, "baseLogs">,
  from: bigint,
  to: bigint,
  filter: { address: Address; topics: (Hex | Hex[] | null)[] },
  progress: { next?: bigint },
  pick: (raw: RawLog[]) => T | undefined,
): Promise<T | null> {
  for (let a = from; a <= to; a += BASE_LOG_WINDOW) {
    const b = a + BASE_LOG_WINDOW - 1n < to ? a + BASE_LOG_WINDOW - 1n : to;
    const hit = pick(await baseWindowLogs(c, filter, a, b));
    if (hit !== undefined) return hit;
    progress.next = b + 1n;
  }
  return null;
}

/** Searches Base's logs matching `filter`, oldest first, from well before `sinceMs` up to the head, for
 * the first window `pick` finds something in. The record's age (`nowMs - sinceMs`) is what the device's
 * clock says, and that clock may have been put back since the record was made: a date up to
 * CLOCK_AHEAD_MS ahead of the real time is read as it is (oplog.ts), so the transaction may be that much
 * older than the record's age says, or the age may even come out negative. The search therefore
 * reaches the record's age, plus CLOCK_AHEAD_MS, plus a margin back, never only the margin, so a stake
 * sent before the clock was corrected is found rather than sent again. Null when none is found; throws
 * when a window can't be read (or its server is behind), which must never be taken for "none". */
async function searchBaseSince<T>(
  c: Pick<Clients, "base" | "baseLogs">,
  s: { sinceMs: number; nowMs: number },
  filter: { address: Address; topics: (Hex | Hex[] | null)[] },
  pick: (raw: RawLog[]) => T | undefined,
): Promise<T | null> {
  const head = await baseHead(c);
  const ageMs = Math.max(0, s.nowMs - s.sinceMs) + CLOCK_AHEAD_MS;
  const back = BigInt(Math.ceil(ageMs / BASE_BLOCK_MS)) + STAKE_SEARCH_MARGIN;
  return searchBase(c, head > back ? head - back : 0n, head, filter, {}, pick);
}

/** The account's deposits as the vault recorded them (its batch deposits, confirmed by their receipts;
 * never one the chain hasn't confirmed), with when they arrived and whether staking followed (a stake
 * after it the trail may use: confirmedStakeAfter; "unknown" while that can't be told). */
export async function chainDeposits(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan) {
  const out: { key: Hex; txHash: Hex; at: Date; assets: bigint; staked: boolean | "unknown" }[] = [];
  for (const e of scan.deposited) {
    if (e.unconfirmed || e.kind !== undefined) continue;
    const staked = await confirmedStakeAfter(c, d, scan, e.block);
    out.push({ key: e.key, txHash: e.txHash, assets: e.assets, at: await blockTime(c, scan, e.block), staked: staked === "unknown" ? "unknown" : staked !== undefined });
  }
  return out;
}
