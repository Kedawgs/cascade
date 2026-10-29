import type { Address } from "viem";
import { type Clients, createClients } from "./chain";
import { batchCloseAt, DELIVERY_TOLERANCE_BPS, DELIVERY_VALIDITY_S, type Deployment, explorer, isV3, SLIPPAGE_BPS } from "./config";
import {
  cancelTook,
  chainDeposits,
  confirmAccountEvents,
  checkDeliveries,
  depositFacts,
  droppedRequestMined,
  HistoryMismatchError,
  type Placed,
  requestBatch,
  scanVault,
  type VaultScan,
  withdrawalFacts,
} from "./facts";
import { type ClaimOp, createOpLog, type DepositOp, effectiveState, entryPriceUsd, type OpLog, type WithdrawalOp } from "./oplog";
import * as reads from "./reads";
import { createScanStore, dropSavedScans, type ScanStore } from "./scan-store";
import { chainOnlyDeposit, depositRecord, isCancelled, withdrawalRecord } from "./trail";
import type { Available, CascadeData, DepositQuote, DepositRecord, Limits, Position, PositionHistory, WithdrawalRecord } from "./types";
import { batchFree, capFree, ceilRao, floorRao, lessSlippage, taoFor, toDisplay } from "./units";
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
  now(): number;
}

/** An unstake request Base never took, and nothing took the place of. */
const REQUEST_DROPPED = "This unstake request never reached Base, so nothing was asked.";
/** Marked failed as dropped (REQUEST_DROPPED): a judgement from the chain, not the wallet's own answer,
 * so its hash is still looked at. */
const takenForDropped = (o: WithdrawalOp) => o.state === "failed" && o.error === REQUEST_DROPPED && !!o.hash;

/** A stand-in payee for quoting the bridge fee before there is an unstake. */
const ANY_ACCOUNT: Address = "0x0000000000000000000000000000000000000001";

/** Uniswap's pool fees on USDC –0.05%→ WETH –0.3%→ TAO (the same both ways). */
const POOL_FEE = 1 - (1 - 0.0005) * (1 - 0.003);
const SLIPPAGE = 0.005;
/** Room for the price to move between the limit shown and the swap. */
const LIMIT_MARGIN = 0.02;
const BRIDGE_MINUTES = 25;
const STAKE_MINUTES = 2;
const ED_RESERVE = 10n ** 12n;
/** The chain's smallest stake (getDefaultMinStake, 2e6 rao). */
const MIN_STAKE_WEI = 2n * 10n ** 15n;

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

const browserStorage = () => {
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

/** What a scan holds, by count: a read that changes none of it found nothing new to save. */
const shapeOf = (s: VaultScan) =>
  [s.delivered.size, s.staked.length, [...s.payouts.values()].reduce((n, p) => n + p.length, 0), s.deposited.length, s.redeemed.length].join(":");

const minutesUntil = (at: Date, now: number) => Math.max(0, Math.ceil((at.getTime() - now) / 60_000));
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export function createLiveCascadeData(d: Deployment, given: Partial<LiveDeps> = {}): CascadeData {
  const storage = browserStorage();
  const deps: LiveDeps = {
    clients: given.clients ?? createClients(),
    // the op log wins the browser's storage: saved history is dropped to make room for it
    opLog: given.opLog ?? createOpLog(storage, d.frontDoor, () => dropSavedScans(storage)),
    scanStore: given.scanStore ?? createScanStore(storage, d),
    readFrontDoor: reads.readFrontDoor,
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
    now: Date.now,
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

  /** A confirmation of saved history by the chain: when the chain shows it was wrong, the scan has gone
   * back to the deploy block, and that is saved at once. */
  async function confirming(account: Address, scan: VaultScan, confirm: () => Promise<void>): Promise<VaultScan> {
    try {
      await confirm();
    } catch (e) {
      if (e instanceof HistoryMismatchError) save(account, scan, true);
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

  /** The account's scan brought up to the chain's newest blocks, from where it stopped (this visit, or
   * an earlier one: progress is saved every few seconds and when a read stops). Its deliveries, stakes
   * and payout chunks are then as current as the chain; its saved amounts may still wait to be
   * confirmed (historyFor). */
  function scanFor(account: Address): Promise<VaultScan> {
    const key = account.toLowerCase();
    const running = inFlight.get(key);
    if (running) return running;
    const p = serial(account, (scan) => {
      let saved = deps.now();
      return deps
        .scan(history, d, scan, account, () => {
          // a long first read saves as it goes
          if (deps.now() - saved >= SAVE_EVERY_MS) {
            save(account, scan, true);
            saved = deps.now();
          }
        })
        .then(
          () => save(account, scan),
          (e) => {
            // a read that stopped keeps the progress it made
            save(account, scan, true);
            throw e;
          },
        )
        .then(() => scan);
    });
    inFlight.set(key, p);
    const clear = () => void inFlight.delete(key);
    p.then(clear, clear);
    return p;
  }

  /** The scan brought up to date, with the account's saved amounts confirmed by their receipts: what
   * anything that sums them needs. What can be unstaked needs only scanFor, so an old deposit's receipt
   * that can't be read never holds it up. */
  function historyFor(account: Address): Promise<VaultScan> {
    return scanFor(account).then(() => serial(account, (scan) => confirming(account, scan, () => confirmAccountEvents(history, d, scan, account))));
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

  /** This browser's unstakes still counted in their batches (not failed, not taken back out by a cancel:
   * the one decision, cancelTook), each with its batch: as recorded, or from its request's receipt, which
   * is then recorded. One whose hash can never be mined is followed to the request in its place (whose
   * hash and batch are recorded), or, with none, marked failed: it asked for nothing, and isn't searched
   * for again. Only its own hash is still looked at: if Base shows that mined after all, it is put back
   * as sent and counts again. */
  async function placedWithdrawals(a: Address, withdrawals: WithdrawalOp[]): Promise<Placed[]> {
    const all = deps.opLog.list(a).filter((o): o is WithdrawalOp => o.kind === "withdrawal");
    const revived = await Promise.all(
      withdrawals.filter(takenForDropped).map(async (o): Promise<WithdrawalOp | undefined> => {
        const batchId = await droppedRequestMined(c, o);
        if (batchId === undefined) return undefined;
        deps.opLog.update(a, o.id, { state: "sent", error: undefined, batchId });
        return { ...o, state: "sent", error: undefined, batchId };
      }),
    );
    const placed = await Promise.all(
      [...withdrawals.filter((o) => o.state !== "failed"), ...revived.filter((o) => o !== undefined)]
        .map(async (o) => {
          // a request another record already owns is never taken for this one's replacement
          const skip = new Set(all.filter((x) => x.id !== o.id && x.hash).map((x) => x.hash as string));
          const p = await requestBatch(c, d, o, { now: deps.now(), skip });
          if (p.replacedBy) deps.opLog.update(a, o.id, { hash: p.replacedBy, batchId: p.batchId });
          else if (p.batchId !== undefined && o.batchId === undefined) deps.opLog.update(a, o.id, { batchId: p.batchId });
          // still running in this tab: its own flow is waiting on it
          if (p.dropped && !deps.opLog.isActive(o.id)) deps.opLog.update(a, o.id, { state: "failed", error: REQUEST_DROPPED });
          return { ...o, batchId: p.batchId, unsure: p.unsure, dropped: p.dropped };
        }),
    );
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
      // a delivery the scan found may have burned the shares since the first reads: read them again
      [fd, v] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a)]);
    }
    const asked = fd.redeemOf + sum(away().map((w) => w.shares));
    const availableShares = v.shares > asked ? v.shares - asked : 0n;
    return { availableShares, availableTaoWei: taoFor(availableShares, v.totalAssets, v.totalSupply) };
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

  async function listDeposits(account: string): Promise<DepositRecord[]> {
    const a = account as Address;
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
    for (const e of await chainDeposits(c, scan)) if (!seen.has(e.txHash.toLowerCase())) out.push(chainOnlyDeposit(e));
    return out.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  }

  async function listWithdrawals(account: string): Promise<WithdrawalRecord[]> {
    const a = account as Address;
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
    getDeposit: async (account, id) => (await listDeposits(account)).find((r) => r.id === id) ?? null,
    listWithdrawals,
    getWithdrawal: async (account, id) => (await listWithdrawals(account)).find((r) => r.id === id) ?? null,

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
    getDeposit: fail,
    listWithdrawals: fail,
    getWithdrawal: fail,
    quoteDeposit: fail,
    quoteWithdrawal: fail,
    quoteRoundTrip: fail,
    checkWiring: fail,
    forgetWiring: () => undefined,
  };
}
