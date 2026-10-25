import type { Address } from "viem";
import { type Clients, createClients } from "./chain";
import { type Deployment, explorer } from "./config";
import { chainDeposits, depositFacts, newScan, scanVault, type VaultScan, withdrawalFacts } from "./facts";
import { type ClaimOp, createOpLog, type DepositOp, type OpLog, type WithdrawalOp } from "./oplog";
import * as reads from "./reads";
import { chainOnlyDeposit, depositRecord, withdrawalRecord } from "./trail";
import type { CascadeData, DepositRecord, Limits, Position, WithdrawalRecord } from "./types";
import { capFree, floorRao, lessSlippage, taoFor, toDisplay } from "./units";

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
  taoPriceUsd: typeof reads.taoPriceUsd;
  ethPriceUsd: typeof reads.ethPriceUsd;
  quoteBuy: typeof reads.quoteBuy;
  quoteSell: typeof reads.quoteSell;
  quotePayoutFee: typeof reads.quotePayoutFee;
  scan(c: Clients, d: Deployment, scan: VaultScan, account?: Address): Promise<void>;
  now(): number;
}

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
    taoPriceUsd: reads.taoPriceUsd,
    ethPriceUsd: reads.ethPriceUsd,
    quoteBuy: reads.quoteBuy,
    quoteSell: reads.quoteSell,
    quotePayoutFee: reads.quotePayoutFee,
    scan: scanVault,
    now: Date.now,
    ...given,
  };
  const c = deps.clients;
  const scans = new Map<string, VaultScan>();

  async function scanFor(account?: Address): Promise<VaultScan> {
    const key = (account ?? "").toLowerCase();
    let s = scans.get(key);
    if (!s) {
      s = newScan(d);
      scans.set(key, s);
    }
    await deps.scan(c, d, s, account);
    return s;
  }

  const closesAt = (fd: reads.FrontDoorState) => new Date((fd.openStart + fd.batchInterval) * 1000);
  /** Sent, its batch closed, not yet arrived in the vault. */
  const onTheBridge = (op: { batchId?: bigint }, fd: reads.FrontDoorState, scan: VaultScan) =>
    op.batchId !== undefined && op.batchId < fd.openBatchId && !scan.delivered.has(String(op.batchId));

  async function getPosition(account: string): Promise<Position> {
    const a = account as Address;
    const [fd, v, price, scan] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a), deps.taoPriceUsd(c), scanFor(a)]);
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
      ...(putIn > 0n ? { rewardsEarnedTao: toDisplay(earned > 0n ? earned : 0n, 18) } : {}),
      avgEntryPriceUsd:
        pricedTao > 0n
          ? priced.reduce((acc, o) => acc + o.priceUsd * toDisplay(o.targetTao, 18), 0) / toDisplay(pricedTao, 18)
          : null,
    };
  }

  async function getLimits(): Promise<Limits> {
    const [fd, price] = await Promise.all([deps.readFrontDoor(c, d), deps.taoPriceUsd(c)]);
    const maxTao = floorRao(capFree({ depositCap: fd.depositCap, netForwarded: fd.netForwarded, openTotal: fd.openTotal }));
    const kept = (1 - POOL_FEE) * (1 - SLIPPAGE);
    return {
      minTao: fd.minDeposit,
      maxTao,
      minUsd: Math.ceil(((toDisplay(fd.minDeposit, 18) * price) / kept) * (1 + LIMIT_MARGIN) * 100) / 100,
      maxUsd: Math.floor(toDisplay(maxTao, 18) * price * (1 - LIMIT_MARGIN) * 100) / 100,
    };
  }

  async function listDeposits(account: string): Promise<DepositRecord[]> {
    const a = account as Address;
    const [fd, v, scan] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a), scanFor(a)]);
    const out: DepositRecord[] = [];
    const seen = new Set<string>();
    for (const op of deps.opLog.list(a).filter((o): o is DepositOp => o.kind === "deposit")) {
      const { batchId, facts } = await depositFacts(c, d, op, { fd, vault: v, scan });
      if (batchId !== undefined && op.batchId === undefined) deps.opLog.update(a, op.id, { batchId });
      if (facts.delivered) seen.add(facts.delivered.txHash.toLowerCase());
      out.push(depositRecord({ ...op, batchId: batchId ?? op.batchId }, facts));
    }
    for (const e of await chainDeposits(c, scan)) if (!seen.has(e.txHash.toLowerCase())) out.push(chainOnlyDeposit(e));
    return out.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  }

  async function listWithdrawals(account: string): Promise<WithdrawalRecord[]> {
    const a = account as Address;
    const [fd, v, scan] = await Promise.all([deps.readFrontDoor(c, d, a), deps.readVault(c, d, a), scanFor(a)]);
    const ops = deps.opLog.list(a);
    const claims = ops.filter((o): o is ClaimOp => o.kind === "claim");
    const out: WithdrawalRecord[] = [];
    for (const op of ops.filter((o): o is WithdrawalOp => o.kind === "withdrawal")) {
      const { batchId, facts } = await withdrawalFacts(c, d, op, { fd, vault: v, scan, claims });
      if (batchId !== undefined && op.batchId === undefined) deps.opLog.update(a, op.id, { batchId });
      out.push(withdrawalRecord({ ...op, batchId: batchId ?? op.batchId }, facts));
    }
    return out;
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
        stakedTao: toDisplay(v.rootStakeWei, 18),
        owedTao: toDisplay(v.totalAssets, 18),
        checkedAt: new Date(deps.now()),
        validatorHotkey: d.hotkeySs58,
        explorerUrl: explorer.account(d.vaultSs58),
      };
    },

    getLimits,

    getBalances: (account) => deps.readWallet(c, d, account as Address),

    // Rewards history needs reward claims, which have not happened yet.
    listRewards: async () => [],

    listDeposits,
    getDeposit: async (account, id) => (await listDeposits(account)).find((r) => r.id === id) ?? null,
    listWithdrawals,
    getWithdrawal: async (account, id) => (await listWithdrawals(account)).find((r) => r.id === id) ?? null,

    async quoteDeposit(usdcUnits) {
      const [expected, fd] = await Promise.all([deps.quoteBuy(c, usdcUnits), deps.readFrontDoor(c, d)]);
      const targetTao = floorRao(lessSlippage(expected));
      const amountUsd = toDisplay(usdcUnits, 6);
      const at = closesAt(fd);
      return {
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
      const usdc = await deps.quoteSell(c, net);
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
        feesUsd: toDisplay(bridgeFeeWei, 18) * price + toDisplay(fee, 18) * ethPrice + (usdcAmount * POOL_FEE) / (1 - POOL_FEE),
        taoPriceUsd: price,
        closesAt: at,
        etaMinutes: minutesUntil(at, deps.now()) + 2 * BRIDGE_MINUTES + Math.round(v.payoutDelay / 60),
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
  };
}
