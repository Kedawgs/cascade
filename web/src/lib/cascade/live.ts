import type { Address } from "viem";
import { type Clients, createClients } from "./chain";
import {
  batchCloseAt,
  BRIDGE_MINUTES,
  DELIVERY_TOLERANCE_BPS,
  DELIVERY_VALIDITY_S,
  type Deployment,
  explorer,
  isV3,
  SLIPPAGE_BPS,
  STAKE_MINUTES,
} from "./config";
import {
  cancelTook,
  chainDeposits,
  confirmAccountEvents,
  checkDeliveries,
  depositFacts,
  droppedRequestMined,
  HistoryMismatchError,
  newScan,
  type Placed,
  requestBatch,
  requestReplacement,
  restartScan,
  scanVault,
  stakerDepositsIn,
  type VaultScan,
  withdrawalFacts,
} from "./facts";
import { freshTip } from "./fresh";
import { DISTRUST_MS, distrustIndexer, fetchSeed, indexerDistrusted, type SeedHalves } from "./indexer";
import { type ClaimOp, createOpLog, type DepositOp, effectiveState, entryPriceUsd, type OpLog, type StringStorage, type WithdrawalOp } from "./oplog";
import * as reads from "./reads";
import { createScanStore, dropSavedScans, type ScanStore, seedHalves } from "./scan-store";
import { checkSeededAccount, SEED_MIN_BLOCKS, type SeedVerdict, verifySeed } from "./seed";
import { chainOnlyDeposit, depositRecord, isCancelled, withdrawalRecord } from "./trail";
import type { Available, CascadeData, DepositQuote, DepositRecord, Limits, Position, PositionHistory, WithdrawalRecord } from "./types";
import { batchFree, capFree, ceilRao, floorRao, lessSlippage, taoFor, toDisplay, unstakeMostWei } from "./units";
import { checkWiring, createWiringCheck } from "./wiring";

export class NotConfiguredError extends Error {
  constructor() {
    super("Cascade isn't connected to a deployment yet");
    this.name = "NotConfiguredError";
  }
}

export interface LiveDeps {
  clients: Clients;
  opLog: OpLog;
  readFrontDoor: typeof reads.readFrontDoor;
  readOpenBatch: typeof reads.readOpenBatch;
  readNextBatch: typeof reads.readNextBatch;
  readVault: typeof reads.readVault;
  readWallet: typeof reads.readWallet;
  readPendingRewards: typeof reads.readPendingRewards;
  taoPriceUsd: typeof reads.taoPriceUsd;
  ethPriceUsd: typeof reads.ethPriceUsd;
  readStakerFees: typeof reads.readStakerFees;
  quoteBuy: typeof reads.quoteBuy;
  quoteSell: typeof reads.quoteSell;
  quotePayoutFee: typeof reads.quotePayoutFee;
  readRewardCutBps: typeof reads.readRewardCutBps;
  readApyPercent: typeof reads.readApyPercent;
  checkWiring: typeof checkWiring;
  scan(c: Clients, d: Deployment, scan: VaultScan, account?: Address, onWindow?: () => void): Promise<void>;
  /** Where each account's scan is saved between visits. */
  scanStore: ScanStore;
  /** The browser's storage (the op log's): the indexer's distrust and the background check's progress live there too. */
  storage: StringStorage;
  /** The history indexer's two seed halves for an account, or null (indexer.ts). */
  fetchSeed(d: Deployment, account: Address): Promise<SeedHalves | null>;
  /** The judgement of a seed against the chain before it is used (seed.ts). */
  verifySeed: typeof verifySeed;
  /** The account's csTAO as of a block, for the seed's tripwire (reads.ts). */
  readSharesAt: typeof reads.readSharesAt;
  now(): number;
}

/** An unstake request Base never took, and nothing took the place of. */
const REQUEST_DROPPED = "This unstake request never reached Base, so nothing was asked.";
/** How long after a request was taken for dropped its own hash is still looked at. */
const LATE_MINE_MS = 24 * 60 * 60_000;
/** Marked failed as dropped (REQUEST_DROPPED) less than LATE_MINE_MS ago: a judgement from the chain,
 * not the wallet's own answer, so its hash is still looked at. One marked before that was dated goes by
 * when it was sent. */
const takenForDropped = (o: WithdrawalOp, now: number) =>
  o.state === "failed" && o.error === REQUEST_DROPPED && !!o.hash && now - (o.droppedAt ?? o.sentAt ?? o.createdAt) < LATE_MINE_MS;

/** A stand-in payee for quoting the bridge fee before there is an unstake. */
const ANY_ACCOUNT: Address = "0x0000000000000000000000000000000000000001";

/** Uniswap's pool fees on USDC –0.05%→ WETH –0.3%→ TAO (the same both ways). */
const POOL_FEE = 1 - (1 - 0.0005) * (1 - 0.003);
const SLIPPAGE = 0.005;
/** Room for the price to move between the limit shown and the swap. */
const LIMIT_MARGIN = 0.02;
const ED_RESERVE = 10n ** 12n;
/** The chain's smallest stake (getDefaultMinStake, 2e6 rao). */
const MIN_STAKE_WEI = 2n * 10n ** 15n;

function memoryStorage(): StringStorage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

const browserStorage = (): StringStorage => {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // storage blocked
  }
  return memoryStorage();
};

/** How often a long scan saves its progress, so a visit cut short is resumed close to where it stopped. */
const SAVE_EVERY_MS = 5_000;
/** How often a scan that found nothing new is saved anyway, for its progress: a later visit reads the
 * last 400 blocks (over an hour) again in any case. */
const SAVE_IDLE_MS = 60_000;
/** How long after the indexer was asked for an account's seed, and it couldn't be used, it is left alone
 * (its API allows 60 requests a minute per address; the scan reads on meanwhile, and once caught up has no
 * reason to ask). */
export const SEED_RETRY_MS = 5 * 60_000;
/** How often one step of the background check of a seeded account's history runs (a few windows a step,
 * seed.ts CHECK_WINDOWS_PER_STEP): about once per poll of the history, well under the archive node's
 * requests per minute alongside the screens' own reads. */
export const CHECK_EVERY_MS = 25_000;

/** A line in the browser's console about the indexer's seed: never anything on screen. */
const note = (msg: string) => console.info(`Cascade: ${msg}`);

/** What a scan holds, by count: a read that changes none of it found nothing new to save. */
const shapeOf = (s: VaultScan) =>
  [s.delivered.size, s.staked.length, [...s.payouts.values()].reduce((n, p) => n + p.length, 0), s.deposited.length, s.redeemed.length].join(":");

const minutesUntil = (at: Date, now: number) => Math.max(0, Math.ceil((at.getTime() - now) / 60_000));
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export function createLiveCascadeData(d: Deployment, given: Partial<LiveDeps> = {}): CascadeData {
  const storage: StringStorage = given.storage ?? browserStorage();
  const now = given.now ?? Date.now;
  const deps: LiveDeps = {
    clients: given.clients ?? createClients(),
    // the op log wins the browser's storage: saved history is dropped to make room for it; it judges
    // what it reads back (a record's dates) by the same clock as everything here
    opLog: given.opLog ?? createOpLog(storage, d.frontDoor, () => dropSavedScans(storage), now),
    scanStore: given.scanStore ?? createScanStore(storage, d),
    storage,
    fetchSeed: (dep, account) => fetchSeed(dep, account),
    verifySeed,
    readSharesAt: reads.readSharesAt,
    readFrontDoor: reads.readFrontDoor,
    readOpenBatch: reads.readOpenBatch,
    readNextBatch: reads.readNextBatch,
    readVault: reads.readVault,
    readWallet: reads.readWallet,
    readPendingRewards: reads.readPendingRewards,
    taoPriceUsd: reads.taoPriceUsd,
    ethPriceUsd: reads.ethPriceUsd,
    readStakerFees: reads.readStakerFees,
    quoteBuy: reads.quoteBuy,
    quoteSell: reads.quoteSell,
    quotePayoutFee: reads.quotePayoutFee,
    readRewardCutBps: reads.readRewardCutBps,
    readApyPercent: reads.readApyPercent,
    checkWiring,
    scan: scanVault,
    now,
    ...given,
  };
  const c = deps.clients;
  /** The clients the history scan and its receipt checks use: Bittensor on its own connection. */
  const history: Clients = { ...c, bittensor: c.bittensorScan ?? c.bittensor };
  /** Whether the contracts are wired as the build says, its answer kept 15 minutes (wiring.ts). */
  const wiring = createWiringCheck(c, d, deps.checkWiring);
  const scans = new Map<string, VaultScan>();
  /** One scan of an account at a time: overlapping scans would read the same blocks twice and
   * double-count events. Callers arriving while one runs share it. */
  const inFlight = new Map<string, Promise<VaultScan>>();
  /** Each account's scan changes one step at a time (a read, a confirmation, a start over): a start over
   * in the middle of a read would leave it claiming blocks whose events it no longer holds. */
  const queues = new Map<string, Promise<unknown>>();

  function serial<T>(account: Address, step: (scan: VaultScan) => Promise<T>): Promise<T> {
    const key = account.toLowerCase();
    const p = (queues.get(key) ?? Promise.resolve()).then(() => step(known(account)));
    queues.set(
      key,
      p.catch(() => undefined),
    );
    return p;
  }

  /** When each account's scan was last saved, and what it held then. */
  const lastSaved = new Map<string, { at: number; shape: string }>();
  /** Saves the account's scan: always when `now`, otherwise when it holds something new since the last
   * save or that was a minute ago (serialising a whole scan on every read is wasted work). */
  function save(account: Address, scan: VaultScan, now = false): void {
    const key = account.toLowerCase();
    const shape = shapeOf(scan);
    const last = lastSaved.get(key);
    if (!now && last && last.shape === shape && deps.now() - last.at < SAVE_IDLE_MS) return;
    deps.scanStore.save(account, scan);
    lastSaved.set(key, { at: deps.now(), shape });
  }

  /** Until when this visit leaves the indexer alone, when storage couldn't keep the decision. */
  let distrustedUntil = 0;
  /** The indexer's seed contradicted the chain: no seed is asked for again for a day (indexer.ts). */
  function distrust(): void {
    distrustedUntil = deps.now() + DISTRUST_MS;
    distrustIndexer(storage, d, deps.now());
  }
  const distrusted = () => deps.now() < distrustedUntil || indexerDistrusted(storage, d, deps.now());

  /** Accounts whose scan is to start over at its next read (scanFor): saved history the chain showed to be
   * wrong, found where the scan couldn't be emptied on the spot. Reads already under way keep the scan
   * they have (every amount they show was confirmed by its receipt); the saved copy is already empty. */
  const restartPending = new Set<string>();

  /** Saved history the chain showed to be wrong (HistoryMismatchError): the indexer is distrusted when
   * its seed was the source, and the scan starts over. One whose thrower held the account's lock and
   * emptied the scan is saved as it is; any other is emptied at the next read, so a read in progress
   * never sees its events vanish under it, and an empty copy is saved at once, so a reload doesn't start
   * from the history that was wrong. */
  function discarded(account: Address, e: HistoryMismatchError): void {
    if (e.restarted) save(account, known(account), true);
    else {
      restartPending.add(account.toLowerCase());
      save(account, newScan(d), true);
    }
    if (e.seeded) distrust();
  }

  /** A confirmation of saved history by the chain: when the chain shows it was wrong, the scan has gone
   * back to the deploy block, and that is saved at once. */
  async function confirming(account: Address, scan: VaultScan, confirm: () => Promise<void>): Promise<VaultScan> {
    try {
      await confirm();
    } catch (e) {
      if (e instanceof HistoryMismatchError) discarded(account, e);
      throw e;
    }
    return scan;
  }

  /** The account's scan as far as it has been read: this visit's, or the one saved by an earlier visit. */
  function known(account: Address): VaultScan {
    const key = account.toLowerCase();
    let s = scans.get(key);
    if (!s) {
      s = deps.scanStore.load(account);
      scans.set(key, s);
    }
    return s;
  }

  /** The chain's head as last read for each account's seed decision, and when: one read a visit, unless a
   * scan falls far behind again (it started over). */
  const heads = new Map<string, { head: bigint; at: number }>();
  /** How long a head reading serves the seed's checks. */
  const HEAD_TTL_MS = 30_000;
  /** When the indexer was last asked for each account's seed. */
  const seedAsked = new Map<string, number>();

  /** A scan far behind the chain starts from the history indexer's seed, when the deployment names one:
   * both halves are fetched and judged against the chain first (seed.ts, verifySeed), then merged through
   * the store (every event unconfirmed, as saved history is), and the scan reads on from the seed's block.
   * On any doubt (no indexer, no answer, a refusal, a half that doesn't decode, a stale seed, a chain that
   * can't be read well enough to judge) the scan reads on from where it is, as it did before there was an
   * indexer, with a line in the console; a seed shown to contradict the chain also distrusts the indexer
   * for a day. Asked at most once per SEED_RETRY_MS per account. Never throws. */
  async function seedIfWorthwhile(account: Address, scan: VaultScan): Promise<void> {
    if (!d.indexerUrl) return;
    const key = account.toLowerCase();
    const asked = seedAsked.get(key);
    if (asked !== undefined && deps.now() - asked < SEED_RETRY_MS) return;
    if (distrusted()) return;
    /** The chain's head, read now unless read moments ago. */
    const head = async (): Promise<bigint> => {
      const h = heads.get(key);
      if (h && deps.now() - h.at < HEAD_TTL_MS) return h.head;
      const read = await freshTip(history);
      heads.set(key, { head: read, at: deps.now() });
      return read;
    };
    try {
      // the scan's own end is as good a head as any for the decision: once caught up, nothing is read for it
      const known = heads.get(key);
      const seen = known && known.head > scan.next ? known.head : undefined;
      if ((seen ?? (await head())) - scan.next <= SEED_MIN_BLOCKS) return;
    } catch {
      return;
    }
    seedAsked.set(key, deps.now());
    const halves = await deps.fetchSeed(d, account);
    if (!halves) {
      note("the history indexer didn't answer, so the vault's history is read from the chain");
      return;
    }
    let verdict: SeedVerdict;
    try {
      verdict = await deps.verifySeed(history, d, scan, account, halves, await head());
    } catch {
      verdict = { ok: false, reason: "it couldn't be checked", distrust: false };
    }
    if (!verdict.ok) {
      if (verdict.distrust) distrust();
      note(`the history indexer's seed wasn't used (${verdict.reason}), so the vault's history is read from the chain`);
      return;
    }
    if (!seedHalves(scan, halves.shared, halves.own)) {
      note("the history indexer's seed reached no further than the saved history, so the vault's history is read from the chain");
      return;
    }
    save(account, scan, true);
    note(`the vault's history up to block ${verdict.next} came from the history indexer, checked against the chain; the rest is read from the chain`);
  }

  /** The account's scan brought up to the chain's newest blocks, from where it stopped (this visit, or
   * an earlier one: progress is saved every few seconds and when a read stops; a first visit far behind
   * starts from the indexer's seed, seedIfWorthwhile). Its deliveries, stakes and payout chunks are then
   * as current as the chain; its saved amounts may still wait to be confirmed (historyFor). */
  function scanFor(account: Address): Promise<VaultScan> {
    const key = account.toLowerCase();
    const running = inFlight.get(key);
    if (running) return running;
    const p = serial(account, async (scan) => {
      // history the chain showed to be wrong since the last read: start over (discarded)
      if (restartPending.delete(key)) restartScan(scan);
      await seedIfWorthwhile(account, scan);
      let saved = deps.now();
      try {
        await deps.scan(history, d, scan, account, () => {
          // a long first read saves as it goes
          if (deps.now() - saved >= SAVE_EVERY_MS) {
            save(account, scan, true);
            saved = deps.now();
          }
        });
      } catch (e) {
        // a read that stopped keeps the progress it made
        save(account, scan, true);
        throw e;
      }
      save(account, scan);
      return scan;
    });
    inFlight.set(key, p);
    const clear = () => void inFlight.delete(key);
    p.then(clear, clear);
    return p;
  }

  /** The accounts whose seeded history passed the tripwire this visit. */
  const tripwired = new Set<string>();

  /** Once per visit, for an account whose history came from the indexer: the account's Deposited and
   * Redeemed (every one confirmed by its receipt by now, shares included) must add up to its csTAO at the
   * scan's last block (csTAO is non-transferable). A seed that left one out, or added one, fails here at
   * once: the scan starts over and the indexer is distrusted (HistoryMismatchError). A balance that can't
   * be read leaves the figure hidden for this read, never wrong. */
  async function tripwire(account: Address, scan: VaultScan): Promise<void> {
    const key = account.toLowerCase();
    if (scan.accountSeededTo === undefined || tripwired.has(key)) return;
    const events = [...scan.deposited, ...scan.redeemed];
    if (events.some((e) => e.shares === undefined)) return;
    const expected = sum(scan.deposited.map((e) => e.shares!)) - sum(scan.redeemed.map((e) => e.shares!));
    const balance = await deps.readSharesAt(history, d, account, scan.next - 1n);
    if (balance !== expected) {
      restartScan(scan);
      throw new HistoryMismatchError(true, true);
    }
    tripwired.add(key);
  }

  /** The scan brought up to date, with the account's saved amounts confirmed by their receipts (and, for
   * a seeded history, their total checked against the balance): what anything that sums them needs. What
   * can be unstaked needs only scanFor, so an old deposit's receipt that can't be read never holds it up.
   * A seeded history then has its background check moved on a step. */
  function historyFor(account: Address): Promise<VaultScan> {
    return scanFor(account)
      .then(() =>
        serial(account, (scan) =>
          confirming(account, scan, async () => {
            await confirmAccountEvents(history, d, scan, account);
            await tripwire(account, scan);
          }),
        ),
      )
      .then((scan) => {
        checkInBackground(account);
        return scan;
      });
  }

  /** Where the background check of a seeded account got to, kept between visits. */
  const progressKey = (account: Address) => `cascade.check.${d.frontDoor.toLowerCase()}.${d.bitBlock}.${account.toLowerCase()}`;
  const progress = {
    load(account: Address): { next?: bigint } {
      try {
        const raw = storage.getItem(progressKey(account));
        const next = raw === null ? undefined : (JSON.parse(raw) as { next?: unknown }).next;
        return typeof next === "string" && /^\d{1,30}$/.test(next) ? { next: BigInt(next) } : {};
      } catch {
        return {};
      }
    },
    save(account: Address, p: { next?: bigint }): void {
      try {
        if (p.next === undefined) storage.removeItem?.(progressKey(account));
        else storage.setItem(progressKey(account), JSON.stringify({ next: String(p.next) }));
      } catch {
        // blocked or full: the check starts over next visit
      }
    },
  };
  const checking = new Set<string>();
  const checkedAt = new Map<string, number>();

  /** Moves the background check of a seeded account's history on a step (seed.ts, checkSeededAccount),
   * once per CHECK_EVERY_MS, under the account's lock, never in front of a read: when the browser's own
   * read of the account's events matches the seed, the account half is the browser's own from then on
   * ("rewards earned" stops being provisional); when it doesn't, the scan starts over and the indexer is
   * distrusted. A step that can't read the chain keeps its progress and is tried again later. */
  function checkInBackground(account: Address): void {
    const key = account.toLowerCase();
    if (known(account).accountSeededTo === undefined || checking.has(key)) return;
    const last = checkedAt.get(key);
    if (last !== undefined && deps.now() - last < CHECK_EVERY_MS) return;
    checking.add(key);
    checkedAt.set(key, deps.now());
    const step = serial(account, async (scan) => {
      if (scan.accountSeededTo === undefined) return;
      const p = progress.load(account);
      try {
        const r = await checkSeededAccount(history, d, scan, account, p);
        if (r === "done") {
          delete scan.accountSeededTo;
          progress.save(account, {});
          save(account, scan, true);
          note("the account's history from the history indexer matches this browser's own read of the chain");
        } else progress.save(account, p);
      } catch (e) {
        if (e instanceof HistoryMismatchError) {
          discarded(account, e);
          progress.save(account, {});
          note("the account's history from the history indexer didn't match this browser's own read of the chain: it is read again from the deploy block");
        } else progress.save(account, p);
      }
    });
    step.catch(() => undefined).finally(() => checking.delete(key));
  }

  /** Settled cancels never change: each answer is kept, so a read asks Base only about new ones. */
  const settledCancels = new Map<string, boolean>();
  /** The ids of `ops` whose cancel took them out of their batch (see cancelTook): they count nowhere. */
  async function cancelledIn(ops: (DepositOp | WithdrawalOp)[]): Promise<Set<string>> {
    const out = new Set<string>();
    await Promise.all(
      ops.map(async (o) => {
        if (!o.cancelled) return;
        const k = `${o.id}:${o.cancelled.hash}`;
        let took = settledCancels.get(k);
        if (took === undefined) {
          took = await cancelTook(c, o);
          if (took !== undefined) settledCancels.set(k, took);
        }
        if (took) out.add(o.id);
      }),
    );
    return out;
  }

  /** A record's state as this tab sees it: "running" with no flow running here means interrupted. */
  const live = <T extends DepositOp | WithdrawalOp | ClaimOp>(op: T): T & { interrupted: boolean } => {
    const seen: T = { ...op, state: effectiveState(op, deps.opLog) };
    return { ...seen, interrupted: op.state === "running" && seen.state !== "running" };
  };

  /** When the open batch can be expected to close: a launch-cadence deployment may wait up to its max wait. */
  const closesAt = (fd: reads.FrontDoorState) => batchCloseAt(fd.openStart, fd.batchInterval, d.batchMaxWaitS);
  /** Sent, its batch closed, not yet arrived in the vault (as far as `scan` has read). */
  const onTheBridge = (op: { batchId?: bigint }, fd: reads.FrontDoorState, scan: VaultScan) =>
    op.batchId !== undefined && op.batchId < fd.openBatchId && !scan.delivered.has(String(op.batchId));

  /** This browser's deposits still counted: one taken back out of a batch that has since closed is
   * neither on the bridge nor delivered (see cancelTook). */
  async function countedDeposits(a: Address, fd: reads.FrontDoorState): Promise<DepositOp[]> {
    const deposits = deps.opLog.list(a).filter((o): o is DepositOp => o.kind === "deposit");
    const gone = await cancelledIn(deposits.filter((o) => o.batchId !== undefined && o.batchId < fd.openBatchId));
    return deposits.filter((o) => !gone.has(o.id));
  }

  /** When a search for a dead request's replacement last couldn't answer, by record and hash: it isn't
   * made again on every read, only after SEARCH_RETRY_MS (facts.ts, requestReplacement). */
  const failedSearches = new Map<string, number>();

  /** This browser's unstakes still counted in their batches (not failed, not taken back out by a cancel:
   * the one decision, cancelTook), each with its batch: as recorded, or from its request's receipt, which
   * is then recorded. One whose hash can never be mined is followed to the request in its place (whose
   * hash and batch are recorded), or, with none, marked failed: it asked for nothing, and isn't searched
   * for again. For a day after, only its own hash is still looked at: if Base shows that mined after
   * all, it is put back as sent and counts again. */
  async function placedWithdrawals(a: Address, withdrawals: WithdrawalOp[]): Promise<Placed[]> {
    const all = deps.opLog.list(a).filter((o): o is WithdrawalOp => o.kind === "withdrawal");
    const revived = await Promise.all(
      withdrawals
        .filter((o) => takenForDropped(o, deps.now()))
        .map(async (o): Promise<WithdrawalOp | undefined> => {
          const batchId = await droppedRequestMined(c, o);
          if (batchId === undefined) return undefined;
          deps.opLog.update(a, o.id, { state: "sent", error: undefined, droppedAt: undefined, batchId });
          return { ...o, state: "sent", error: undefined, droppedAt: undefined, batchId };
        }),
    );
    const open = [...withdrawals.filter((o) => o.state !== "failed"), ...revived.filter((o) => o !== undefined)];
    const places = await Promise.all(open.map((o) => requestBatch(c, o, deps.now())));
    // those whose hash can't be mined, one at a time and oldest first: a request one takes for its
    // replacement is never another's, nor one another record already owns
    const adopted = new Set<string>();
    const byAge = (i: number, j: number) => open[i].createdAt - open[j].createdAt || (open[i].id < open[j].id ? -1 : 1);
    for (const i of open.flatMap((_, i) => (places[i].dead ? [i] : [])).sort(byAge)) {
      const o = open[i];
      const skip = new Set([...all.filter((x) => x.id !== o.id && x.hash).map((x) => x.hash as string), ...adopted]);
      const key = `${o.id}:${o.hash}`;
      places[i] = await requestReplacement(c, d, o, { now: deps.now(), skip, searchFailedAt: failedSearches.get(key) });
      if (places[i].searchFailed) failedSearches.set(key, deps.now());
      else if (!places[i].unsure) failedSearches.delete(key);
      if (places[i].replacedBy) adopted.add(places[i].replacedBy);
    }
    const placed = open.map((o, i) => {
      const p = places[i];
      // how far the search for its replacement has read: the next one reads on from there
      if (p.searchedTo !== undefined) deps.opLog.update(a, o.id, { searchedTo: p.searchedTo });
      if (p.replacedBy) deps.opLog.update(a, o.id, { hash: p.replacedBy, batchId: p.batchId });
      else if (p.batchId !== undefined && o.batchId === undefined) deps.opLog.update(a, o.id, { batchId: p.batchId });
      // still running in this tab: its own flow is waiting on it
      if (p.dropped && !deps.opLog.isActive(o.id)) deps.opLog.update(a, o.id, { state: "failed", error: REQUEST_DROPPED, droppedAt: deps.now() });
      return { ...o, batchId: p.batchId, unsure: p.unsure, dropped: p.dropped };
    });
    const gone = await cancelledIn(placed);
    return placed
      .filter((o) => !gone.has(o.id) && !o.dropped)
      .map(({ id, batchId, shares, unsure }) => ({ id, batchId, shares, ...(unsure ? { unsure } : {}) }));
  }

  /** The stake itself, from contract reads alone: it never waits on the vault's history. */
  async function getPosition(account: string): Promise<Position> {
    const a = account as Address;
    const [v, price] = await Promise.all([deps.readVault(c, d, a), deps.taoPriceUsd(c)]);
    // v3 only (v2's Rewards page stays as it was); a failed read leaves it unknown, never zero
    const waiting = isV3(d) ? await deps.readPendingRewards(c, d, v.stakeHotkey).catch(() => undefined) : undefined;
    const pendingRewardsTao =
      waiting && v.totalSupply > 0n
        ? toDisplay((waiting.wei * v.shares * BigInt(10_000 - waiting.cutBps)) / (v.totalSupply * 10_000n), 18)
        : undefined;
    const taoWei = taoFor(v.shares, v.totalAssets, v.totalSupply);
    return {
      shares: v.shares,
      taoWei,
      taoBalance: toDisplay(taoWei, 18),
      usdValue: toDisplay(taoWei, 18) * price,
      taoPriceUsd: price,
      ...(pendingRewardsTao !== undefined ? { pendingRewardsTao } : {}),
    };
  }

  /** Shares not already asked back: the open batch's request (the front door's own figure) and this
   * browser's unstakes whose batch closed and hasn't reached the vault. The scan as far as it has been
   * read places most of them; only one it hasn't seen arrive waits for the scan to catch up. */
  async function getAvailable(account: string): Promise<Available> {
    const a = account as Address;
    let [fd, v] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a)]);
    const withdrawals = await placedWithdrawals(a, deps.opLog.list(a).filter((o): o is WithdrawalOp => o.kind === "withdrawal"));
    let scan = known(a);
    /** In a closed batch that hasn't arrived as far as anyone can tell: a saved delivery counts only once
     * its receipt shows it, and one that can't be shown yet leaves the unstake on the bridge. */
    const arrived = (batchId: bigint) => {
      const hit = scan.delivered.get(String(batchId));
      return hit !== undefined && !hit.unconfirmed;
    };
    // one whose batch can't be known right now counts as asked too: at worst the figure is a little low
    const away = () => withdrawals.filter((w) => w.unsure || (w.batchId !== undefined && w.batchId < fd.openBatchId && !arrived(w.batchId)));
    const saved = away()
      .filter((w) => scan.delivered.has(String(w.batchId)))
      .map((w) => String(w.batchId));
    if (saved.length > 0) await serial(a, (s) => checkDeliveries(history, d, s, saved));
    if (away().length > 0) {
      scan = await scanFor(a);
      // a delivery the indexer's seed brought in counts, like a saved one, only once its receipt shows it
      const seeded = away()
        .filter((w) => scan.delivered.get(String(w.batchId))?.unconfirmed)
        .map((w) => String(w.batchId));
      if (seeded.length > 0) await serial(a, (s) => checkDeliveries(history, d, s, seeded));
      // a delivery the scan found may have burned the shares since the first reads: read them again
      [fd, v] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a)]);
    }
    const asked = fd.redeemOf + sum(away().map((w) => w.shares));
    const availableShares = v.shares > asked ? v.shares - asked : 0n;
    // one request carries at most the vault's maxEntryValue, this batch's earlier request included
    const most = v.maxEntryValue !== undefined ? unstakeMostWei(v.maxEntryValue, taoFor(fd.redeemOf, v.totalAssets, v.totalSupply)) : undefined;
    return {
      availableShares,
      availableTaoWei: taoFor(availableShares, v.totalAssets, v.totalSupply),
      ...(most !== undefined ? { mostTaoWei: most } : {}),
    };
  }

  /** What needs the vault's history: TAO on its way in, rewards earned, the average entry price. */
  async function getPositionHistory(account: string): Promise<PositionHistory> {
    const a = account as Address;
    const [fd, v, scan] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a), historyFor(a)]);
    const deposits = await countedDeposits(a, fd);
    const taoWei = taoFor(v.shares, v.totalAssets, v.totalSupply);
    const pendingWei = fd.depositOf + sum(deposits.filter((o) => onTheBridge(o, fd, scan)).map((o) => o.targetTao));
    const putIn = sum(scan.deposited.map((e) => e.assets));
    const takenOut = sum(scan.redeemed.map((e) => e.assets));
    const earned = taoWei + takenOut - putIn;
    // the deposits that reached the vault, each at the price it was made at (one without a price is left out)
    const priced = deposits.flatMap((o) => {
      const price = entryPriceUsd(o);
      return price !== undefined && o.batchId !== undefined && scan.delivered.has(String(o.batchId)) ? [{ price, tao: o.targetTao }] : [];
    });
    const pricedTao = sum(priced.map((o) => o.tao));
    return {
      pendingTao: toDisplay(pendingWei, 18),
      ...(putIn > 0n ? { rewardsEarnedTao: toDisplay(earned > 0n ? earned : 0n, 18) } : {}),
      avgEntryPriceUsd:
        pricedTao > 0n
          ? priced.reduce((acc, o) => acc + o.price * toDisplay(o.tao, 18), 0) / toDisplay(pricedTao, 18)
          : null,
      // the account's events came from the indexer and this browser hasn't read them all itself yet
      ...(scan.accountSeededTo !== undefined ? { provisional: true as const } : {}),
    };
  }

  async function getLimits(): Promise<Limits> {
    const [fd, price, fees] = await Promise.all([deps.readFrontDoor(c, d), deps.taoPriceUsd(c), isV3(d) ? deps.readStakerFees(c, d) : undefined]);
    // a deposit must fit under the deposit cap and in the open batch, or the front door refuses it
    const capRoom = capFree(fd);
    const batchRoom = batchFree(fd);
    const maxTao = floorRao(capRoom < batchRoom ? capRoom : batchRoom);
    const kept = (1 - POOL_FEE) * (1 - SLIPPAGE);
    const minTaoUsd = toDisplay(fd.minDeposit, 18) * price * (1 + LIMIT_MARGIN);
    // v3: the stake's floor (0.5% under the quote) must still reach minDeposit after Cascade's fees come
    // off the USDC; the price read is what selling pays, so buying costs the pools' fees once more
    const minUsd = fees
      ? minTaoUsd / kept / (1 - POOL_FEE) / (1 - Number(fees.swapFeeBps) / 10_000) + toDisplay(fees.depositFeeUsdc, 6)
      : minTaoUsd / kept;
    const minCents = Math.ceil(minUsd * 100) / 100;
    // what a room in TAO lets the form take, in whole cents
    const usdFor = (room: bigint) => Math.floor(toDisplay(floorRao(room), 18) * price * (1 - LIMIT_MARGIN) * 100) / 100;
    return {
      minTao: fd.minDeposit,
      maxTao,
      minUsd: minCents,
      maxUsd: usdFor(maxTao),
      // judged in dollars, as the form judges amounts: a room just over minDeposit is still under the
      // dollar minimum once the margins are counted
      full: usdFor(capRoom) < minCents ? "cap" : usdFor(batchRoom) < minCents ? "batch" : null,
    };
  }

  /** A list of trails: one whose saved stake or chunk the chain contradicts fails this read, and the scan
   * starts over for the next (discarded). */
  async function trails<T>(a: Address, list: () => Promise<T>): Promise<T> {
    try {
      return await list();
    } catch (e) {
      if (e instanceof HistoryMismatchError) discarded(a, e);
      throw e;
    }
  }

  function listDeposits(account: string): Promise<DepositRecord[]> {
    const a = account as Address;
    return trails(a, async () => {
      const [fd, v, scan] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a), historyFor(a)]);
      const out: DepositRecord[] = [];
      const seen = new Set<string>();
      const found = [];
      for (const op of deps.opLog.list(a).filter((o): o is DepositOp => o.kind === "deposit").map(live)) {
        const { batchId, facts } = await depositFacts(c, d, op, { fd, vault: v, scan });
        if (batchId !== undefined && op.batchId === undefined) deps.opLog.update(a, op.id, { batchId });
        if (facts.delivered) seen.add(facts.delivered.txHash.toLowerCase());
        found.push({ op: { ...op, batchId: batchId ?? op.batchId }, facts: { ...facts, interrupted: op.interrupted } });
      }
      // TAO this account deposited that hasn't reached the vault yet (open batch or bridge) counts toward the staking minimum
      const incomingWei = found
        .filter(({ op, facts }) => facts.depositMined && !facts.delivered && !isCancelled(op, facts))
        .reduce((sum, { op }) => sum + op.targetTao, 0n);
      for (const { op, facts } of found) out.push(depositRecord(op, { ...facts, incomingWei }));
      for (const e of await chainDeposits(c, d, scan)) if (!seen.has(e.txHash.toLowerCase())) out.push(chainOnlyDeposit(e));
      return out.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
    });
  }

  function listWithdrawals(account: string): Promise<WithdrawalRecord[]> {
    const a = account as Address;
    return trails(a, async () => {
      const ops = deps.opLog.list(a);
      const withdrawals = ops.filter((o): o is WithdrawalOp => o.kind === "withdrawal").map(live);
      // unstakes are listed from this browser's own records: with none there is nothing to scan Bittensor for
      if (withdrawals.length === 0) return [];
      const [fd, v, scan] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a), scanFor(a)]);
      const claims = ops.filter((o): o is ClaimOp => o.kind === "claim").map(live);
      // each unstake's batch and cancel first: one entry of several is shared out between those still in it
      const siblings = await placedWithdrawals(a, withdrawals);
      const out: WithdrawalRecord[] = [];
      for (const w of withdrawals) {
        // as placedWithdrawals left it: a request found in place of its hash, or a drop, shows at once
        const op = live((deps.opLog.get(a, w.id) as WithdrawalOp | undefined) ?? w);
        const { batchId, facts } = await withdrawalFacts(c, d, op, { fd, vault: v, scan, claims, siblings });
        if (batchId !== undefined && op.batchId === undefined) deps.opLog.update(a, op.id, { batchId });
        out.push(withdrawalRecord({ ...op, batchId: batchId ?? op.batchId }, facts));
      }
      return out;
    });
  }

  /** v3: Cascade's fees come off the USDC before the swap, mirroring CascadeStaker._stake. */
  async function quoteDepositV3(usdcUnits: bigint): Promise<DepositQuote> {
    const [fees, fd] = await Promise.all([deps.readStakerFees(c, d), deps.readFrontDoor(c, d)]);
    const depositFee = fees.depositFeeUsdc;
    const swapFee = usdcUnits > depositFee ? ((usdcUnits - depositFee) * fees.swapFeeBps) / 10_000n : 0n;
    const rest = usdcUnits > depositFee + swapFee ? usdcUnits - depositFee - swapFee : 0n;
    const expected = rest > 0n ? await deps.quoteBuy(c, rest) : 0n;
    const amountUsd = toDisplay(usdcUnits, 6);
    const cascadeFeesUsd = toDisplay(depositFee + swapFee, 6);
    const at = closesAt(fd);
    const targetTao = floorRao(expected);
    return {
      usdcIn: usdcUnits,
      expectedTao: expected,
      targetTao,
      estTao: toDisplay(targetTao, 18),
      amountUsd,
      taoPriceUsd: expected > 0n ? amountUsd / toDisplay(expected, 18) : 0,
      feesUsd: cascadeFeesUsd + toDisplay(rest, 6) * POOL_FEE,
      closesAt: at,
      etaMinutes: minutesUntil(at, deps.now()) + BRIDGE_MINUTES + STAKE_MINUTES,
      batchIntervalS: fd.batchInterval,
      minTaoOut: ceilRao(lessSlippage(expected, SLIPPAGE_BPS)),
      depositFeeUsdc: depositFee,
      swapFeeUsdc: swapFee,
      cascadeFeesUsd,
    };
  }

  /** v3: the lowest price per TAO a delivery sale may accept, and when the request lapses. */
  async function deliveryTerms(): Promise<{ minUsdcPerTao: bigint; deliveryDeadline: number }> {
    if (!isV3(d)) return { minUsdcPerTao: 0n, deliveryDeadline: 0 };
    const [fees, gross] = await Promise.all([deps.readStakerFees(c, d), deps.quoteSell(c, 10n ** 18n)]);
    const net = gross - (gross * fees.swapFeeBps) / 10_000n;
    return {
      minUsdcPerTao: (net * (10_000n - BigInt(DELIVERY_TOLERANCE_BPS))) / 10_000n,
      deliveryDeadline: Math.floor(deps.now() / 1000) + DELIVERY_VALIDITY_S,
    };
  }

  return {
    deployment: d,
    clients: c,
    opLog: deps.opLog,
    checkWiring: () => wiring(),
    forgetWiring: () => wiring.forget(),

    async getProtocolStats() {
      const [v, price] = await Promise.all([deps.readVault(c, d), deps.taoPriceUsd(c)]);
      // The number of stakers is hidden: no indexer.
      return { totalStakedTao: toDisplay(v.totalAssets, 18), taoPriceUsd: price };
    },

    async getApy() {
      const apy = await deps.readApyPercent(c, d);
      if (apy === undefined) throw new Error("There is no APY to show yet");
      return apy;
    },

    getPosition,
    getAvailable,
    getPositionHistory,

    async getProof() {
      const v = await deps.readVault(c, d);
      const reserved = ED_RESERVE + v.pendingPayouts;
      const idle = v.balanceWei > reserved ? v.balanceWei - reserved : 0n;
      return {
        allStaked: idle < MIN_STAKE_WEI,
        waitingForMinimum: idle >= MIN_STAKE_WEI && v.rootStakeWei + idle < v.nominatorMinWei,
        minimumTao: toDisplay(v.nominatorMinWei, 18),
        stakedTao: toDisplay(v.rootStakeWei, 18),
        owedTao: toDisplay(v.totalAssets, 18),
        checkedAt: new Date(deps.now()),
        validatorHotkey: d.hotkeySs58,
        explorerUrl: explorer.account(d.vaultSs58),
      };
    },

    getLimits,

    async getBalances(account) {
      const a = account as Address;
      const [w, fd] = await Promise.all([deps.readWallet(c, d, a), deps.readFrontDoor(c, d, a)]);
      return { ...w, claimable: fd.claimable };
    },

    // Rewards history needs reward claims, which have not happened yet.
    listRewards: async () => [],

    listDeposits,
    listWithdrawals,

    async quoteDeposit(usdcUnits) {
      if (isV3(d)) return quoteDepositV3(usdcUnits);
      const [expected, fd] = await Promise.all([deps.quoteBuy(c, usdcUnits), deps.readFrontDoor(c, d)]);
      const targetTao = floorRao(lessSlippage(expected));
      const amountUsd = toDisplay(usdcUnits, 6);
      const at = closesAt(fd);
      return {
        minTaoOut: targetTao,
        depositFeeUsdc: 0n,
        swapFeeUsdc: 0n,
        cascadeFeesUsd: 0,
        usdcIn: usdcUnits,
        expectedTao: expected,
        targetTao,
        estTao: toDisplay(targetTao, 18),
        amountUsd,
        taoPriceUsd: expected > 0n ? amountUsd / toDisplay(expected, 18) : 0,
        feesUsd: amountUsd * POOL_FEE,
        closesAt: at,
        etaMinutes: minutesUntil(at, deps.now()) + BRIDGE_MINUTES + STAKE_MINUTES,
        batchIntervalS: fd.batchInterval,
      };
    },

    async quoteWithdrawal(account, shares) {
      const a = account as Address;
      const [fd, v, price, ethPrice] = await Promise.all([
        deps.readFrontDoor(c, d, a),
        deps.readVault(c, d, a),
        deps.taoPriceUsd(c),
        deps.ethPriceUsd(c),
      ]);
      const taoWei = taoFor(shares, v.totalAssets, v.totalSupply);
      const bridgeFeeWei = await deps.quotePayoutFee(c, d, a, taoWei);
      const net = taoWei > bridgeFeeWei ? taoWei - bridgeFeeWei : 0n;
      const gross = await deps.quoteSell(c, net);
      // v3 delivery pays the sale less the staker's swap fee (as sellFor takes it); v2 stays gross
      const deliveryFee = isV3(d) ? (gross * (await deps.readStakerFees(c, d)).swapFeeBps) / 10_000n : 0n;
      const usdc = gross - deliveryFee;
      const fee = fd.redeemOf === 0n ? fd.redeemRequestFee : 0n;
      const usdcAmount = toDisplay(usdc, 6);
      const at = closesAt(fd);
      return {
        shares,
        taoWei,
        taoAmount: toDisplay(taoWei, 18),
        usdcAmount,
        fee,
        bridgeFeeWei,
        feesUsd: toDisplay(bridgeFeeWei, 18) * price + toDisplay(fee, 18) * ethPrice + (toDisplay(gross, 6) * POOL_FEE) / (1 - POOL_FEE) + toDisplay(deliveryFee, 6),
        taoPriceUsd: price,
        closesAt: at,
        etaMinutes: minutesUntil(at, deps.now()) + 2 * BRIDGE_MINUTES + Math.round(v.payoutDelay / 60),
        batchIntervalS: fd.batchInterval,
        ...(await deliveryTerms()),
      };
    },

    async quoteRoundTrip(taoWei) {
      const [fd, ethPrice, taoPrice, bridgeFeeWei, rewardCutBps] = await Promise.all([
        deps.readFrontDoor(c, d),
        deps.ethPriceUsd(c),
        deps.taoPriceUsd(c),
        // who it is paid to doesn't change the bridge's fee
        deps.quotePayoutFee(c, d, ANY_ACCOUNT, taoWei),
        deps.readRewardCutBps(c, d),
      ]);
      return {
        exitFixedUsd: toDisplay(fd.redeemRequestFee, 18) * ethPrice + toDisplay(bridgeFeeWei, 18) * taoPrice,
        rewardCutBps,
      };
    },

    // the staker's deposits in it come from Base's logs, as the keeper counts them
    getOpenBatch: (account) => deps.readOpenBatch(c, d, account as Address, (id, ageS) => stakerDepositsIn(c, d, id, ageS)),
    getNextBatch: () => deps.readNextBatch(c, d),
  };
}

/** The data source when `web/.env.local` names no deployment: every read says so. */
export function notConfiguredData(): CascadeData {
  const fail = async (): Promise<never> => {
    throw new NotConfiguredError();
  };
  const missing = (): never => {
    throw new NotConfiguredError();
  };
  return {
    get deployment() {
      return missing();
    },
    get clients() {
      return missing();
    },
    get opLog() {
      return missing();
    },
    getProtocolStats: fail,
    getApy: fail,
    getPosition: fail,
    getAvailable: fail,
    getPositionHistory: fail,
    getProof: fail,
    getLimits: fail,
    getBalances: fail,
    listRewards: fail,
    listDeposits: fail,
    listWithdrawals: fail,
    quoteDeposit: fail,
    quoteWithdrawal: fail,
    quoteRoundTrip: fail,
    getOpenBatch: fail,
    getNextBatch: fail,
    checkWiring: fail,
    forgetWiring: () => undefined,
  };
}
