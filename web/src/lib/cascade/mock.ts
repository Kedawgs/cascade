/**
 * Mock Cascade data for the demo. Every number here is made up.
 *
 * - Every account starts with one finished $1,000 deposit from Base on Oct 1.
 * - New deposits and withdrawals are saved in localStorage (or memory when
 *   storage is unavailable) and move forward one trail step every few seconds,
 *   so the trail screens visibly update.
 * - Step status is derived from the clock on every read, which keeps the data
 *   consistent across reloads and tabs without timers.
 */
import { chainInfo, isSourceChain } from "./chains";
import {
  formatDateTime,
  formatDuration,
  formatSignedTao,
  formatTao,
  formatUsd,
  formatUsdc,
  round,
} from "../format";
import type {
  CascadeData,
  DepositQuote,
  DepositRecord,
  DepositStepKey,
  Position,
  SourceChain,
  StakeProof,
  StepStatus,
  TrailStep,
  WithdrawalQuote,
  WithdrawalRecord,
  WithdrawalStepKey,
} from "./types";

export const MOCK_TAO_PRICE_USD = 286;
export const SWAP_FEE_RATE = 0.003;
/** Extra cost of moving USDC to Base first, per source chain. */
export const ROUTE_FEE_USD: Record<SourceChain, number> = {
  base: 0,
  ethereum: 2.5,
  bnb: 0.4,
  polygon: 0.2,
};
export const ETA_MINUTES: Record<SourceChain, number> = {
  base: 10,
  ethereum: 15,
  bnb: 13,
  polygon: 13,
};
export const DEPOSIT_LIMITS = { minUsd: 10, maxUsd: 50_000 } as const;
/** How often a demo deposit or withdrawal moves to its next step. */
export const DEMO_STEP_MS = 4_000;
export const MOCK_VALIDATOR_HOTKEY = "5HEo565WAy4Dbq3Sv271SAi7syBSofyfhhwRNjFNSM2g7tQb";
/** Demo receipts don't point anywhere real. The UI shows a "demo" hint for this value. */
export const DEMO_TX_URL = "#";

const STORAGE_KEY = "cascade.demo.v1";
const PROOF_CHECK_EVERY_MS = 5 * 60_000;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

/** localStorage, or null when it's unavailable (server render, blocked storage). */
export function browserStore(): KeyValueStore | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

interface StoredDeposit {
  id: string;
  account: string;
  createdAt: number;
  amountUsd: number;
  sourceChain: SourceChain;
  taoAmount: number;
  feesUsd: number;
  taoPriceUsd: number;
  /** When each of the 4 steps finished (may be in the future). */
  stepTimes: number[];
  rewardsTao: number;
  rewardPayouts: number;
}

interface StoredWithdrawal {
  id: string;
  account: string;
  createdAt: number;
  taoAmount: number;
  usdcAmount: number;
  feesUsd: number;
  stepTimes: number[];
}

interface StoredState {
  deposits: StoredDeposit[];
  withdrawals: StoredWithdrawal[];
}

const MINUTE = 60_000;

function seedDeposit(account: string): StoredDeposit {
  // Oct 1, 9:14 AM in the viewer's time zone, matching the approved mockup.
  const t = new Date(2026, 9, 1, 9, 14).getTime();
  return {
    id: "oct-1-base",
    account,
    createdAt: t,
    amountUsd: 1000,
    sourceChain: "base",
    taoAmount: 3.6387, // (1,000 - 3.00 fees) / 274.00
    feesUsd: 3,
    taoPriceUsd: 274,
    stepTimes: [t, t + 0.5 * MINUTE, t + 4.5 * MINUTE, t + 5 * MINUTE],
    rewardsTao: 0.0213,
    rewardPayouts: 19,
  };
}

function isStoredDeposit(v: unknown): v is StoredDeposit {
  const d = v as StoredDeposit;
  return (
    typeof d === "object" &&
    d !== null &&
    typeof d.id === "string" &&
    typeof d.account === "string" &&
    typeof d.createdAt === "number" &&
    typeof d.amountUsd === "number" &&
    isSourceChain(d.sourceChain) &&
    typeof d.taoAmount === "number" &&
    Array.isArray(d.stepTimes) &&
    d.stepTimes.length === 4
  );
}

function isStoredWithdrawal(v: unknown): v is StoredWithdrawal {
  const w = v as StoredWithdrawal;
  return (
    typeof w === "object" &&
    w !== null &&
    typeof w.id === "string" &&
    typeof w.account === "string" &&
    typeof w.createdAt === "number" &&
    typeof w.taoAmount === "number" &&
    Array.isArray(w.stepTimes) &&
    w.stepTimes.length === 4
  );
}

type StepCopy = { title: string; detail?: string; txLabel?: string };

/** Builds one trail step from copy for each state; `at` is set once the step is done. */
function makeStep<K extends string>(
  key: K,
  index: number,
  stepTimes: number[],
  doneCount: number,
  copy: Record<StepStatus, StepCopy>,
): TrailStep<K> {
  const status: StepStatus =
    index < doneCount ? "done" : index === doneCount ? "active" : "pending";
  const step: TrailStep<K> = { key, status, ...copy[status] };
  if (status === "done") {
    step.at = new Date(stepTimes[index]);
    step.txUrl = DEMO_TX_URL;
  }
  return step;
}

function countDone(stepTimes: number[], now: number): number {
  return stepTimes.filter((t) => t <= now).length;
}

function toDepositRecord(d: StoredDeposit, now: number): DepositRecord {
  const done = countDone(d.stepTimes, now);
  const usdc = formatUsdc(d.amountUsd);
  const from = chainInfo(d.sourceChain).label;
  const onBase = d.sourceChain === "base";
  const tao = formatTao(d.taoAmount);
  const payouts =
    d.rewardPayouts === 1 ? "1 reward payout so far" : `${d.rewardPayouts} reward payouts so far`;
  const step = (key: DepositStepKey, i: number, copy: Record<StepStatus, StepCopy>) =>
    makeStep(key, i, d.stepTimes, done, copy);

  const steps = [
    step("received", 0, {
      done: {
        title: `Received ${usdc} USDC on Base`,
        detail: onBase
          ? undefined
          : `${formatDateTime(new Date(d.stepTimes[0]))} · sent from ${from}`,
      },
      active: {
        title: onBase ? `Waiting for ${usdc} USDC on Base` : `Moving ${usdc} USDC from ${from} to Base`,
      },
      pending: { title: `Receive ${usdc} USDC on Base` },
    }),
    step("swapped", 1, {
      done: {
        title: `Swapped for ${tao} TAO`,
        detail: `At ${formatUsd(d.taoPriceUsd)}, fees ${formatUsd(d.feesUsd)}`,
      },
      active: { title: "Swapping for TAO", detail: `About ${tao} TAO at ${formatUsd(d.taoPriceUsd)}` },
      pending: { title: "Swap for TAO" },
    }),
    step("bridged", 2, {
      done: {
        title: "Moved to Bittensor",
        detail: `Took ${formatDuration(d.stepTimes[2] - d.stepTimes[1])}`,
      },
      active: { title: "Moving to Bittensor" },
      pending: { title: "Move to Bittensor" },
    }),
    step("staked", 3, {
      done: {
        title: "Staked and earning",
        detail:
          d.rewardPayouts > 0
            ? `${payouts}, ${formatSignedTao(d.rewardsTao)} TAO`
            : "Rewards will show up here as they're paid out",
        txLabel: "View your stake",
      },
      active: { title: "Staking on Bittensor" },
      pending: { title: "Stake and start earning" },
    }),
  ];

  return {
    id: d.id,
    createdAt: new Date(d.createdAt),
    amountUsd: d.amountUsd,
    sourceChain: d.sourceChain,
    status: done >= 4 ? "staked" : "in_progress",
    steps,
    taoAmount: d.taoAmount,
    feesUsd: d.feesUsd,
    taoPriceUsd: d.taoPriceUsd,
    rewardsTao: d.rewardsTao,
  };
}

function toWithdrawalRecord(w: StoredWithdrawal, now: number): WithdrawalRecord {
  const done = countDone(w.stepTimes, now);
  const tao = formatTao(w.taoAmount);
  const step = (key: WithdrawalStepKey, i: number, copy: Record<StepStatus, StepCopy>) =>
    makeStep(key, i, w.stepTimes, done, copy);

  const steps = [
    step("requested", 0, {
      done: { title: `Asked to withdraw ${tao} TAO` },
      active: { title: `Sending your request for ${tao} TAO` },
      pending: { title: `Ask to withdraw ${tao} TAO` },
    }),
    step("unstaked", 1, {
      done: { title: "Unstaked in the daily batch" },
      active: {
        title: "Waiting for the daily batch",
        detail: "Batches run once a day. In this demo it takes a few seconds.",
      },
      pending: { title: "Unstake in the next daily batch" },
    }),
    step("returned", 2, {
      done: {
        title: "Moved back to Base",
        detail: `Took ${formatDuration(w.stepTimes[2] - w.stepTimes[1])}`,
      },
      active: { title: "Moving back to Base" },
      pending: { title: "Move back to Base" },
    }),
    step("paid", 3, {
      done: {
        title: `Paid ${formatUsdc(w.usdcAmount)} USDC to your wallet on Base`,
        detail: `Fees ${formatUsd(w.feesUsd)}`,
      },
      active: { title: "Swapping to USDC on Base" },
      pending: { title: "Pay USDC to your wallet" },
    }),
  ];

  return {
    id: w.id,
    createdAt: new Date(w.createdAt),
    taoAmount: w.taoAmount,
    status: done >= 4 ? "paid" : "in_progress",
    steps,
    usdcAmount: w.usdcAmount,
    feesUsd: w.feesUsd,
  };
}

export interface MockOptions {
  /** Clock in ms. Defaults to Date.now. */
  now?: () => number;
  /** Where to persist. Defaults to localStorage; null keeps everything in memory. */
  store?: KeyValueStore | null;
  stepMs?: number;
  taoPriceUsd?: number;
}

export function createMockCascadeData(options: MockOptions = {}): CascadeData {
  const now = options.now ?? Date.now;
  const store = options.store === undefined ? browserStore() : options.store;
  const stepMs = options.stepMs ?? DEMO_STEP_MS;
  const price = options.taoPriceUsd ?? MOCK_TAO_PRICE_USD;
  const memory = memoryStore();
  let useMemory = store === null;

  function load(): StoredState {
    let raw: string | null = null;
    try {
      raw = useMemory || !store ? memory.getItem(STORAGE_KEY) : store.getItem(STORAGE_KEY);
    } catch {
      useMemory = true;
      raw = memory.getItem(STORAGE_KEY);
    }
    if (!raw) return { deposits: [], withdrawals: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<StoredState>;
      return {
        deposits: Array.isArray(parsed.deposits) ? parsed.deposits.filter(isStoredDeposit) : [],
        withdrawals: Array.isArray(parsed.withdrawals)
          ? parsed.withdrawals.filter(isStoredWithdrawal)
          : [],
      };
    } catch {
      return { deposits: [], withdrawals: [] };
    }
  }

  function save(state: StoredState): void {
    const json = JSON.stringify(state);
    memory.setItem(STORAGE_KEY, json);
    if (useMemory || !store) return;
    try {
      store.setItem(STORAGE_KEY, json);
    } catch {
      // Storage full or blocked: keep going in memory for this session.
      useMemory = true;
    }
  }

  const key = (account: string) => account.toLowerCase();
  const newId = (prefix: string) =>
    `${prefix}-${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const finishTimes = (start: number) => [1, 2, 3, 4].map((i) => start + i * stepMs);

  function depositsFor(account: string): StoredDeposit[] {
    const k = key(account);
    return [seedDeposit(k), ...load().deposits.filter((d) => d.account === k)];
  }

  function withdrawalsFor(account: string): StoredWithdrawal[] {
    const k = key(account);
    return load().withdrawals.filter((w) => w.account === k);
  }

  function position(account: string): Position {
    const t = now();
    const deposits = depositsFor(account).map((d) => toDepositRecord(d, t));
    const staked = deposits.filter((d) => d.status === "staked");
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

    const principal = sum(staked.map((d) => d.taoAmount));
    const rewards = sum(staked.map((d) => d.rewardsTao));
    const withdrawn = sum(withdrawalsFor(account).map((w) => w.taoAmount));
    const taoBalance = round(Math.max(0, principal + rewards - withdrawn), 4);
    const paid = sum(staked.map((d) => d.taoAmount * d.taoPriceUsd));

    return {
      taoBalance,
      usdValue: round(taoBalance * price, 2),
      rewardsEarnedTao: round(rewards, 4),
      taoPriceUsd: price,
      pendingTao: round(
        sum(deposits.filter((d) => d.status === "in_progress").map((d) => d.taoAmount)),
        4,
      ),
      avgEntryPriceUsd: principal > 0 ? round(paid / principal, 2) : null,
    };
  }

  function quoteDeposit(amountUsd: number, chain: SourceChain): DepositQuote {
    const amount = Number.isFinite(amountUsd) ? Math.max(0, amountUsd) : 0;
    const feesUsd = amount > 0 ? round(amount * SWAP_FEE_RATE + ROUTE_FEE_USD[chain], 2) : 0;
    return {
      amountUsd: amount,
      chain,
      estTao: round(Math.max(0, amount - feesUsd) / price, 4),
      feesUsd,
      etaMinutes: ETA_MINUTES[chain],
      taoPriceUsd: price,
    };
  }

  function quoteWithdrawal(taoAmount: number): WithdrawalQuote {
    const tao = Number.isFinite(taoAmount) ? Math.max(0, round(taoAmount, 4)) : 0;
    const gross = tao * price;
    const feesUsd = round(gross * SWAP_FEE_RATE, 2);
    return { taoAmount: tao, usdcAmount: round(gross - feesUsd, 2), feesUsd, taoPriceUsd: price };
  }

  const byNewest = (a: { createdAt: Date }, b: { createdAt: Date }) =>
    b.createdAt.getTime() - a.createdAt.getTime();

  return {
    limits: { ...DEPOSIT_LIMITS },

    async getPosition(account) {
      return position(account);
    },

    async getProof(account): Promise<StakeProof> {
      const { taoBalance } = position(account);
      const stakedTao = taoBalance;
      const owedTao = taoBalance;
      return {
        allStaked: stakedTao >= owedTao,
        stakedTao,
        owedTao,
        checkedAt: new Date(Math.floor(now() / PROOF_CHECK_EVERY_MS) * PROOF_CHECK_EVERY_MS),
        validatorHotkey: MOCK_VALIDATOR_HOTKEY,
        explorerUrl: DEMO_TX_URL,
      };
    },

    async listDeposits(account) {
      const t = now();
      return depositsFor(account)
        .map((d) => toDepositRecord(d, t))
        .sort(byNewest);
    },

    async getDeposit(account, id) {
      const found = depositsFor(account).find((d) => d.id === id);
      return found ? toDepositRecord(found, now()) : null;
    },

    async quoteDeposit(amountUsd, chain) {
      return quoteDeposit(amountUsd, chain);
    },

    async startDeposit(account, amountUsd, chain) {
      if (!isSourceChain(chain)) throw new Error("Pick the chain your USDC is on.");
      if (!Number.isFinite(amountUsd) || amountUsd < DEPOSIT_LIMITS.minUsd) {
        throw new RangeError(`The smallest deposit is ${formatUsd(DEPOSIT_LIMITS.minUsd)}.`);
      }
      if (amountUsd > DEPOSIT_LIMITS.maxUsd) {
        throw new RangeError(`The most you can deposit right now is ${formatUsd(DEPOSIT_LIMITS.maxUsd)}.`);
      }
      const quote = quoteDeposit(round(amountUsd, 2), chain);
      const t = now();
      const record: StoredDeposit = {
        id: newId("d"),
        account: key(account),
        createdAt: t,
        amountUsd: quote.amountUsd,
        sourceChain: chain,
        taoAmount: quote.estTao,
        feesUsd: quote.feesUsd,
        taoPriceUsd: price,
        stepTimes: finishTimes(t),
        rewardsTao: 0,
        rewardPayouts: 0,
      };
      const state = load();
      state.deposits.push(record);
      save(state);
      return toDepositRecord(record, t);
    },

    async quoteWithdrawal(taoAmount) {
      return quoteWithdrawal(taoAmount);
    },

    async startWithdrawal(account, taoAmount) {
      const quote = quoteWithdrawal(taoAmount);
      if (!(quote.taoAmount > 0)) throw new RangeError("Enter how much TAO to withdraw.");
      const { taoBalance } = position(account);
      if (quote.taoAmount > taoBalance + 1e-9) {
        throw new RangeError(`You can withdraw up to ${formatTao(taoBalance)} TAO.`);
      }
      const t = now();
      const record: StoredWithdrawal = {
        id: newId("w"),
        account: key(account),
        createdAt: t,
        taoAmount: quote.taoAmount,
        usdcAmount: quote.usdcAmount,
        feesUsd: quote.feesUsd,
        stepTimes: finishTimes(t),
      };
      const state = load();
      state.withdrawals.push(record);
      save(state);
      return toWithdrawalRecord(record, t);
    },

    async listWithdrawals(account) {
      const t = now();
      return withdrawalsFor(account)
        .map((w) => toWithdrawalRecord(w, t))
        .sort(byNewest);
    },

    async getWithdrawal(account, id) {
      const found = withdrawalsFor(account).find((w) => w.id === id);
      return found ? toWithdrawalRecord(found, now()) : null;
    },
  };
}
