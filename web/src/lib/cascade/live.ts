import type { Address } from "viem";
import { type Clients, createClients } from "./chain";
import { DELIVERY_TOLERANCE_BPS, DELIVERY_VALIDITY_S, type Deployment, explorer, isV3, SLIPPAGE_BPS } from "./config";
import { chainDeposits, depositFacts, newScan, scanVault, type VaultScan, withdrawalFacts } from "./facts";
import { type ClaimOp, createOpLog, type DepositOp, effectiveState, type OpLog, type WithdrawalOp } from "./oplog";
import * as reads from "./reads";
import { chainOnlyDeposit, depositRecord, withdrawalRecord } from "./trail";
import type { CascadeData, DepositQuote, DepositRecord, Limits, Position, WithdrawalRecord } from "./types";
import { capFree, ceilRao, floorRao, lessSlippage, taoFor, toDisplay } from "./units";

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
  scan(c: Clients, d: Deployment, scan: VaultScan, account?: Address): Promise<void>;
  now(): number;
}

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

const minutesUntil = (at: Date, now: number) => Math.max(0, Math.ceil((at.getTime() - now) / 60_000));
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export function createLiveCascadeData(d: Deployment, given: Partial<LiveDeps> = {}): CascadeData {
  const deps: LiveDeps = {
    clients: given.clients ?? createClients(),
    opLog: given.opLog ?? createOpLog(browserStorage(), d.frontDoor),
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
    scan: scanVault,
    now: Date.now,
    ...given,
  };
  const c = deps.clients;
  const scans = new Map<string, VaultScan>();
  /** One scan of an account at a time: overlapping scans would read the same blocks twice and
   * double-count events. Callers arriving while one runs share it. */
  const inFlight = new Map<string, Promise<VaultScan>>();

  function scanFor(account?: Address): Promise<VaultScan> {
    const key = (account ?? "").toLowerCase();
    const running = inFlight.get(key);
    if (running) return running;
    let s = scans.get(key);
    if (!s) {
      s = newScan(d);
      scans.set(key, s);
    }
    const scan = s;
    const p = deps.scan(c, d, scan, account).then(
      () => scan,
      (e) => Promise.reject(e),
    );
    inFlight.set(key, p);
    const clear = () => void inFlight.delete(key);
    p.then(clear, clear);
    return p;
  }

  /** A record's state as this tab sees it: "running" with no flow running here means interrupted. */
  const live = <T extends DepositOp | WithdrawalOp | ClaimOp>(op: T): T & { interrupted: boolean } => {
    const seen: T = { ...op, state: effectiveState(op, deps.opLog) };
    return { ...seen, interrupted: op.state === "running" && seen.state !== "running" };
  };

  const closesAt = (fd: reads.FrontDoorState) => new Date((fd.openStart + fd.batchInterval) * 1000);
  /** Sent, its batch closed, not yet arrived in the vault. */
  const onTheBridge = (op: { batchId?: bigint }, fd: reads.FrontDoorState, scan: VaultScan) =>
    op.batchId !== undefined && op.batchId < fd.openBatchId && !scan.delivered.has(String(op.batchId));

  async function getPosition(account: string): Promise<Position> {
    const a = account as Address;
    const [fd, v, price, scan] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a), deps.taoPriceUsd(c), scanFor(a)]);
    // v3 only (v2's Rewards page stays as it was); a failed read leaves it unknown, never zero
    const waiting = isV3(d) ? await deps.readPendingRewards(c, d, v.stakeHotkey).catch(() => undefined) : undefined;
    const pendingRewardsTao =
      waiting && v.totalSupply > 0n
        ? toDisplay((waiting.wei * v.shares * BigInt(10_000 - waiting.cutBps)) / (v.totalSupply * 10_000n), 18)
        : undefined;
    const ops = deps.opLog.list(a);
    const withdrawals = ops.filter((o): o is WithdrawalOp => o.kind === "withdrawal" && o.state !== "failed");
    const deposits = ops.filter((o): o is DepositOp => o.kind === "deposit");
    const asked = fd.redeemOf + sum(withdrawals.filter((w) => onTheBridge(w, fd, scan)).map((w) => w.shares));
    const availableShares = v.shares > asked ? v.shares - asked : 0n;
    const taoWei = taoFor(v.shares, v.totalAssets, v.totalSupply);
    const pendingWei = fd.depositOf + sum(deposits.filter((o) => onTheBridge(o, fd, scan)).map((o) => o.targetTao));

    const putIn = sum(scan.deposited.map((e) => e.assets));
    const takenOut = sum(scan.redeemed.map((e) => e.assets));
    const earned = taoWei + takenOut - putIn;
    const priced = deposits.filter((o) => o.batchId !== undefined && scan.delivered.has(String(o.batchId)));
    const pricedTao = sum(priced.map((o) => o.targetTao));
    return {
      shares: v.shares,
      availableShares,
      taoWei,
      availableTaoWei: taoFor(availableShares, v.totalAssets, v.totalSupply),
      taoBalance: toDisplay(taoWei, 18),
      usdValue: toDisplay(taoWei, 18) * price,
      taoPriceUsd: price,
      pendingTao: toDisplay(pendingWei, 18),
      ...(pendingRewardsTao !== undefined ? { pendingRewardsTao } : {}),
      ...(putIn > 0n ? { rewardsEarnedTao: toDisplay(earned > 0n ? earned : 0n, 18) } : {}),
      avgEntryPriceUsd:
        pricedTao > 0n
          ? priced.reduce((acc, o) => acc + o.priceUsd * toDisplay(o.targetTao, 18), 0) / toDisplay(pricedTao, 18)
          : null,
    };
  }

  async function getLimits(): Promise<Limits> {
    const [fd, price, fees] = await Promise.all([deps.readFrontDoor(c, d), deps.taoPriceUsd(c), isV3(d) ? deps.readStakerFees(c, d) : undefined]);
    const maxTao = floorRao(capFree({ depositCap: fd.depositCap, netForwarded: fd.netForwarded, openTotal: fd.openTotal }));
    const kept = (1 - POOL_FEE) * (1 - SLIPPAGE);
    const minTaoUsd = toDisplay(fd.minDeposit, 18) * price * (1 + LIMIT_MARGIN);
    // v3: the stake's floor (0.5% under the quote) must still reach minDeposit after Cascade's fees come
    // off the USDC; the price read is what selling pays, so buying costs the pools' fees once more
    const minUsd = fees
      ? minTaoUsd / kept / (1 - POOL_FEE) / (1 - Number(fees.swapFeeBps) / 10_000) + toDisplay(fees.depositFeeUsdc, 6)
      : minTaoUsd / kept;
    return {
      minTao: fd.minDeposit,
      maxTao,
      minUsd: Math.ceil(minUsd * 100) / 100,
      maxUsd: Math.floor(toDisplay(maxTao, 18) * price * (1 - LIMIT_MARGIN) * 100) / 100,
    };
  }

  async function listDeposits(account: string): Promise<DepositRecord[]> {
    const a = account as Address;
    const [fd, v, scan] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a), scanFor(a)]);
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
      .filter(({ op, facts }) => facts.depositMined && !facts.delivered && !(op.cancelled && facts.cancelMined))
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
    const out: WithdrawalRecord[] = [];
    for (const op of withdrawals) {
      const { batchId, facts } = await withdrawalFacts(c, d, op, { fd, vault: v, scan, claims });
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

    async getProtocolStats() {
      const [v, price] = await Promise.all([deps.readVault(c, d), deps.taoPriceUsd(c)]);
      // APR and the number of stakers are hidden: no reward claims yet, no indexer.
      return { totalStakedTao: toDisplay(v.totalAssets, 18), taoPriceUsd: price };
    },

    getPosition,

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
    getPosition: fail,
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
  };
}
