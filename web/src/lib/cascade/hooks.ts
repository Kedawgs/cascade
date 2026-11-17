"use client";

import { hashKey, keepPreviousData, type Query, type QueryClient, type QueryFilters, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { Address } from "viem";
import { type CancelRecord, cancelSentFromHere } from "../cancel-sent";
import { useNow } from "../client-state";
import type { FigureKey, Reading } from "../remembered";
import { APY_KEEP_MS, heroTotal, type LiveFigure, liveOnly, shownFigure, STATS_KEEP_MS, withRemembered } from "../stats";
import { DEPLOYMENT, explorer, isV3, isV32, minUnstakeWei, type Stage } from "./config";
import { readExitHold } from "./exit-hold";
import { readRewardVesting } from "./reads";
import { fetchFlow } from "./flow";
import { useCascadeData, useSnapshotAt } from "./context";
import type { Operation } from "./oplog";
import { type PendingEntry, pendingEntries } from "./pending";
import type { DepositRecord, WithdrawalRecord } from "./records";
import type { Snapshot } from "./snapshot";
import type { CancelSent } from "./trail";
import type { CascadeData } from "./types";
import { WIRING_TTL_MS } from "./wiring";

/** Chain reads: every 10 s while something is moving beyond its open batch on Base (Bittensor makes a
 * block every 12 s, and the public nodes rate-limit: see movingOffBase), every 30 s otherwise. */
const LIVE_MS = 10_000;
const IDLE_MS = 30_000;

/** Query keys hold bigints as strings (react-query hashes keys with JSON). */
export const cascadeKeys = {
  all: () => ["cascade"] as const,
  /** The protocol figures read on Bittensor: the total staked. */
  stats: () => ["cascade", "stats"] as const,
  /** The TAO price, read on Base alone. */
  taoPrice: () => ["cascade", "tao-price"] as const,
  apy: () => ["cascade", "apy"] as const,
  limits: () => ["cascade", "limits"] as const,
  proof: () => ["cascade", "proof"] as const,
  account: (account: string) => ["cascade", account] as const,
  balances: (account: string) => ["cascade", account, "balances"] as const,
  code: (account: string) => ["cascade", account, "code"] as const,
  rewards: (account: string) => ["cascade", account, "rewards"] as const,
  position: (account: string) => ["cascade", account, "position"] as const,
  /** v3: the account's share of the rewards earned and not yet collected, the Rewards page's own read. */
  pendingRewards: (account: string) => ["cascade", account, "pending-rewards"] as const,
  available: (account: string) => ["cascade", account, "available"] as const,
  history: (account: string) => ["cascade", account, "history"] as const,
  deposits: (account: string) => ["cascade", account, "deposits"] as const,
  withdrawals: (account: string) => ["cascade", account, "withdrawals"] as const,
  openBatch: (account: string) => ["cascade", account, "open-batch"] as const,
  deliveryLimit: (account: string) => ["cascade", account, "delivery-limit"] as const,
  /** v3.2 with USDC delivery off: whether the front door holds a delivery preference for the account (Task 60). */
  deliveryPreference: (account: string) => ["cascade", account, "delivery-preference"] as const,
  /** v3.2: the owner's reward vesting period, the running schedule's and the adoption drip's, in seconds, for the FAQ (reads.ts readRewardVesting). */
  rewardVesting: () => ["cascade", "reward-vesting"] as const,
  /** v3.2: what the emergency page on Bittensor reads (direct-exit.ts readDirectExit). */
  directExit: (account: string) => ["cascade", account, "direct-exit"] as const,
  /** v3.2 (R4): what holds the account's front-door unstake now: its fresh shares, the rail, today's limit (exit-hold.ts). */
  exitHold: (account: string) => ["cascade", account, "exit-hold"] as const,
  nextBatch: () => ["cascade", "next-batch"] as const,
  flow: () => ["cascade", "flow"] as const,
  depositQuote: (usdc: bigint) => ["quote", "deposit", usdc.toString()] as const,
  withdrawalQuote: (account: string, shares: bigint) => ["quote", "withdrawal", account, shares.toString()] as const,
  roundTrip: (taoWei: bigint) => ["quote", "round-trip", taoWei.toString()] as const,
};

/** What a flow may have changed, to be read again once it ends (use-flows.ts): every "cascade" query but the yield. A
 * stake, an unstake or a claim doesn't move a 30-day figure, and each restart of the yield's query sets its running
 * read aside and starts another, leaving a slow read of Bittensor's archive node in flight for nothing. */
export const changedByFlow = (): QueryFilters => ({ queryKey: cascadeKeys.all(), predicate: (q) => q.queryHash !== hashKey(cascadeKeys.apy()) });

/** Puts the server's snapshot into a new cache, dated when it was read, so the first render (on the
 * server, and in the browser while it hydrates) shows the same figures. The live reads refresh them in
 * place as they come due. */
export function seedSnapshot(client: QueryClient, s: Snapshot): void {
  if (s.apyPercent !== undefined) client.setQueryData(cascadeKeys.apy(), s.apyPercent, { updatedAt: s.at });
  if (s.stats !== undefined) client.setQueryData(cascadeKeys.stats(), s.stats, { updatedAt: s.at });
  if (s.taoPriceUsd !== undefined) client.setQueryData(cascadeKeys.taoPrice(), s.taoPriceUsd, { updatedAt: s.at });
}

/** The deployment's vault on Bittensor's explorer, for "View on Bittensor": from the build's own deployment (the address
 * the stake proof links to, live.ts getProof), so the link is in the first HTML and waits on no read. None when the site
 * has no deployment. */
export function useVaultExplorerUrl(): string | undefined {
  const data = useCascadeData();
  try {
    return explorer.account(data.deployment.vaultSs58);
  } catch {
    return undefined;
  }
}

/** Whether the site talks to a v3 deployment; false when none is configured (its reads all fail). */
export function useIsV3(): boolean {
  const data = useCascadeData();
  try {
    return isV3(data.deployment);
  } catch {
    return false;
  }
}

/** Whether the site talks to a v3.2 deployment (config.isV32); false when none is configured. */
export function useIsV32(): boolean {
  const data = useCascadeData();
  try {
    return isV32(data.deployment);
  } catch {
    return false;
  }
}

/** The deployment's stage (deployments.json, config.deploymentStage: "testing" for anything not exactly one of the
 * four). "retired" shows only the ways out (Task 60). */
export function useStage(): Stage {
  return useCascadeData().stage;
}

/** Whether the deployment is retired: the site then shows only the ways out (withdraw, claim, Receive TAO, the emergency
 * page), never a stake, a deposit or Send it now for a deposit. */
export const useRetired = (): boolean => useStage() === "retired";

/** Whether the site offers USDC delivery (config.usdcDeliveryOn: off only where a v3.2 entry says so, spec §5). */
export function useUsdcDelivery(): boolean {
  return useCascadeData().usdcDelivery;
}

/** v3.2 with USDC delivery off: whether the chain holds a USDC delivery preference for the account (its claim clears
 * it), every 30 s, only when `enabled`. */
export function useDeliveryPreference(account: string | null, enabled: boolean) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.deliveryPreference(account ?? ""),
    queryFn: () => data.getDeliveryPreference(account as string),
    enabled: enabled && account !== null,
    refetchInterval: IDLE_MS,
  });
}

/** v3.2: the owner's reward vesting period, the running schedule's and the adoption drip's while it runs (seconds,
 * reads.ts RewardVesting), read once a half hour from the vault lens for the FAQ; nothing is read on any other deployment, whose period is its vault's
 * constant. */
export function useRewardVesting() {
  const data = useCascadeData();
  const v32 = useIsV32();
  return useQuery({
    queryKey: cascadeKeys.rewardVesting(),
    queryFn: () => readRewardVesting(data.clients, data.deployment),
    enabled: v32,
    staleTime: APY_MS,
    refetchInterval: APY_MS,
    refetchOnWindowFocus: false,
  });
}

/** v3.2 (R4): what holds the account's front-door unstake now (exit-hold.ts readExitHold): its fresh shares (the one-day
 * hold), whether the vault's primary bridge can send payouts, and today's limit left; read every 30 seconds while the
 * Unstake form shows. */
export function useExitHold(account: string | null) {
  const data = useCascadeData();
  const v32 = useIsV32();
  return useQuery({
    queryKey: cascadeKeys.exitHold(account ?? ""),
    queryFn: () => readExitHold(data.clients, data.deployment, account as Address),
    enabled: v32 && account !== null,
    refetchInterval: 30_000,
  });
}

/** The smallest unstake the site's deployment takes (config.minUnstakeWei): 0.033 TAO on v3.2, else 0.011 TAO. */
export function useMinUnstakeWei(): bigint {
  const data = useCascadeData();
  try {
    return minUnstakeWei(data.deployment);
  } catch {
    return minUnstakeWei(null);
  }
}

/** Whether the contracts are wired as the build says (wiring.ts), asked while a wallet is connected: again
 * once its answer is 15 minutes old, every half minute after a check that failed, and after each flow
 * (useFlows forgets the answer, then asks). Outside the "cascade" keys, which every flow refreshes. */
export function useWiring(enabled: boolean) {
  const data = useCascadeData();
  return useQuery({
    queryKey: ["wiring"],
    queryFn: () => data.checkWiring(),
    enabled,
    staleTime: WIRING_TTL_MS,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 2,
    refetchInterval: (q) => (q.state.status === "error" ? IDLE_MS : WIRING_TTL_MS),
  });
}

/** The deployment's max wait (the launch cadence's), or none: when the site has no deployment, or one
 * whose batches leave as soon as they can close. */
export function useBatchMaxWait(): number | undefined {
  const data = useCascadeData();
  try {
    return data.deployment.batchMaxWaitS;
  } catch {
    return undefined;
  }
}

/** The open batch for the public "Next batch" line: one multicall on Base every 30 s, nothing from
 * Bittensor. Its countdown runs on Base's clock from the read's block time (batch-clock.ts). */
export function useNextBatch() {
  const data = useCascadeData();
  return useQuery({ queryKey: cascadeKeys.nextBatch(), queryFn: () => data.getNextBatch(), refetchInterval: IDLE_MS });
}

/** The open batch with the account's part in it and, once it can close, what sending it now costs:
 * read every 30 s, only while one of the account's deposits or unstakes waits in it (`enabled`). */
export function useOpenBatch(account: string, enabled: boolean) {
  const data = useCascadeData();
  return useQuery({ queryKey: cascadeKeys.openBatch(account), queryFn: () => data.getOpenBatch(account), enabled, refetchInterval: IDLE_MS });
}

/** A fetch of a public figure, as its query function is given it. */
type FigureFetch = { readonly signal: AbortSignal };

/** Whether a fetch that has just answered is still the one its query waits for. A query read again before its last
 * read answered (a flow's refresh, say) sets that read aside, and the answer that comes last is then not the one the
 * query keeps; it isn't remembered either (remembered.ts), so what a visit leaves for the next is what it showed.
 * Asked only once the read has answered: react-query stops an unobserved fetch whose function took its signal, and
 * these reads are let run to their end (the yield's is too slow to throw away). */
const stillWanted = (fetch: FigureFetch): boolean => !fetch.signal.aborted;

/** The total staked (Bittensor), every 30 s. Each reading that arrives is remembered for this browser's next visit
 * (remembered.ts), as the yield's and the TAO price's are below: these three public display figures, and no other
 * query's data. */
export function statsQuery(data: CascadeData) {
  return {
    queryKey: cascadeKeys.stats(),
    queryFn: async (fetch: FigureFetch) => {
      const stats = await data.getProtocolStats();
      if (stats.totalStakedTao !== undefined && stillWanted(fetch)) data.figures.remember("staked", stats.totalStakedTao);
      return stats;
    },
    refetchInterval: IDLE_MS,
  };
}

export function useProtocolStats() {
  const data = useCascadeData();
  return useQuery(statsQuery(data));
}

/** The TAO price, every 30 s: one read on Base, its own query, so it neither waits for the vault's read on Bittensor
 * nor fails with it. */
export function taoPriceQuery(data: CascadeData) {
  return {
    queryKey: cascadeKeys.taoPrice(),
    queryFn: async (fetch: FigureFetch) => {
      const price = await data.getTaoPrice();
      if (stillWanted(fetch)) data.figures.remember("price", price);
      return price;
    },
    refetchInterval: IDLE_MS,
  };
}

/** The TAO price's query as it is: its data may still be the server's snapshot (see useTaoPrice, useShownTaoPrice). */
export function useTaoPriceQuery() {
  const data = useCascadeData();
  return useQuery(taoPriceQuery(data));
}

/** The TAO price that values the user's own money (TAO in the wallet, what waits to be claimed): this visit's own read
 * and nothing else, kept through failed reads for an hour (see shownFigure). Never one remembered from an earlier
 * visit, and none while the query still holds the server's snapshot: that one is as old as the last deploy, and mustn't
 * pass for today's price. (The price shown as a figure is useShownTaoPrice.) */
export function useTaoPrice(): number | undefined {
  const price = useTaoPriceQuery();
  const snapshotAt = useSnapshotAt();
  return shownFigure(liveOnly(price, snapshotAt), STATS_KEEP_MS);
}

/** A 30-day figure moves slowly: read it every half hour, and keep the last good one through a failed read. */
export const APY_MS = 30 * 60_000;
/** A yield read that failed is tried again after three minutes, not thirty: Bittensor's archive node was slow or
 * turned it away, and the next try may well get through. */
export const APY_RETRY_MS = 3 * 60_000;
/** The most one attempt at the yield may take in the browser, all its reads together: three minutes. Each request waits
 * 90 s and is asked once more (chain.ts), and there are several in a row, so against a node that hangs an attempt could
 * otherwise run for many minutes with no new one started. Past this it counts as failed, and the next comes in
 * APY_RETRY_MS. */
export const APY_ATTEMPT_MS = 3 * 60_000;

/** `read`, or a failure once `ms` have passed without its answer (which is then left unused). */
function within<T>(read: Promise<T>, ms: number, late: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(late)), ms);
    read.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** The yield's query: its own, so nothing else waits on its slow read. Once every half hour after a reading, every
 * three minutes after a failure, and each attempt asks Bittensor once: the connection it reads on retries a failed
 * request once itself (chain.ts YIELD_RETRIES), so the query asks no second time on top of that. An attempt is given
 * APY_ATTEMPT_MS in all. */
export function apyQuery(data: CascadeData) {
  return {
    queryKey: cascadeKeys.apy(),
    queryFn: async (fetch: FigureFetch) => {
      const apy = await within(data.getApy(), APY_ATTEMPT_MS, "The yield took too long to read");
      if (stillWanted(fetch)) data.figures.remember("apy", apy);
      return apy;
    },
    staleTime: APY_MS,
    refetchInterval: (q: Query<number>) => (q.state.status === "error" ? APY_RETRY_MS : APY_MS),
    refetchOnWindowFocus: false,
    retry: false,
  };
}

export function useApy() {
  const data = useCascadeData();
  return useQuery(apyQuery(data));
}

const noSubscribe = () => () => {};

/** What this browser remembers of a public display figure from an earlier visit (remembered.ts), from the first render
 * after hydration on: never in the server's markup, nor in the render that hydrates it, which must match. Only the
 * four hooks below read it, for the yield, the total staked and the TAO price shown as a figure: a balance, a limit or
 * a quote is never remembered. */
function useRecalled(key: FigureKey): Reading | undefined {
  const { figures } = useCascadeData();
  return useSyncExternalStore(
    noSubscribe,
    () => figures.recall(key),
    () => undefined,
  );
}

/** A public figure as a page shows it: the value (undefined: none to show) and, with none, whether a read may still
 * bring one (`loading`: a skeleton in its place) or not (a dash). */
export interface ShownNumber {
  value: number | undefined;
  loading: boolean;
}

/** The total staked of a stats query, as a figure of its own. */
const stakedOf = (stats: LiveFigure<{ totalStakedTao?: number }>): LiveFigure<number> => ({ data: stats.data?.totalStakedTao, isError: stats.isError, dataUpdatedAt: stats.dataUpdatedAt });

/** The yield to show: this visit's reading; until it arrives, the newer of the first HTML's snapshot and the one this
 * browser remembers; kept through failed reads for 14 days from when it was read, then none. */
export function useShownApy(): ShownNumber {
  const apy = useApy();
  const snapshotAt = useSnapshotAt();
  const recalled = useRecalled("apy");
  return { value: shownFigure(withRemembered(apy, recalled, snapshotAt), APY_KEEP_MS), loading: apy.isPending };
}

/** The total staked to show, in TAO: as the yield, kept for an hour. */
export function useShownStaked(): ShownNumber {
  const stats = useProtocolStats();
  const snapshotAt = useSnapshotAt();
  const recalled = useRecalled("staked");
  return { value: shownFigure(withRemembered(stakedOf(stats), recalled, snapshotAt), STATS_KEEP_MS), loading: stats.isPending };
}

/** The TAO price shown as a figure (the price strip, the statistics card, the Rewards page): this visit's reading;
 * until it arrives, the one this browser remembers when that is under an hour old. Never the server's snapshot's, which
 * is as old as the last deploy; kept through failed reads for an hour, then none. */
export function useShownTaoPrice(): ShownNumber {
  const price = useTaoPriceQuery();
  const snapshotAt = useSnapshotAt();
  const recalled = useRecalled("price");
  // with the snapshot's price left out, whatever the query holds is this visit's own reading: it stands
  return { value: shownFigure(withRemembered(liveOnly(price, snapshotAt), recalled, 0), STATS_KEEP_MS), loading: !price.isError };
}

/** The home page's total staked, in dollars (stats.ts heroTotal): the TAO staked at the TAO price, each the newest
 * reading there is. Here the snapshot's price counts too: a total, not a price anyone acts on. */
export function useHeroTotal(): ReturnType<typeof heroTotal> {
  const stats = useProtocolStats();
  const price = useTaoPriceQuery();
  const snapshotAt = useSnapshotAt();
  const staked = useRecalled("staked");
  const priced = useRecalled("price");
  return heroTotal(withRemembered(stakedOf(stats), staked, snapshotAt), withRemembered(price, priced, snapshotAt));
}

export function useLimits() {
  const data = useCascadeData();
  return useQuery({ queryKey: cascadeKeys.limits(), queryFn: () => data.getLimits(), refetchInterval: IDLE_MS });
}

export function useBalances(account: string | null) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.balances(account ?? ""),
    queryFn: () => data.getBalances(account as string),
    enabled: account !== null,
    refetchInterval: IDLE_MS,
  });
}

export function useRewards(account: string) {
  const data = useCascadeData();
  return useQuery({ queryKey: cascadeKeys.rewards(account), queryFn: () => data.listRewards(account) });
}

/** The account's stake (getPosition); `enabled` false asks nothing of its own (the stake form with no wallet yet). */
export function usePosition(account: string, live = false, enabled = true) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.position(account),
    queryFn: () => data.getPosition(account),
    refetchInterval: live ? LIVE_MS : IDLE_MS,
    enabled,
  });
}

/** v3: the account's share of the rewards earned and not yet collected (getPendingRewards), every 30 s: the Rewards
 * page's own read, apart from the stake's (usePosition), which no longer waits on it. Null while it can't be told;
 * nothing is read on v2. */
export function usePendingRewards(account: string) {
  const data = useCascadeData();
  const v3 = useIsV3();
  return useQuery({
    queryKey: cascadeKeys.pendingRewards(account),
    queryFn: () => data.getPendingRewards(account),
    enabled: v3,
    refetchInterval: IDLE_MS,
  });
}

/** What can be unstaked. Usually as quick as the balance: it waits on the vault's history only while an
 * unstake from this browser is on its way and its arrival isn't known yet. `enabled` false asks nothing of its own
 * (the unstake screen with no wallet yet) and reads whatever the cache holds. */
export function useAvailable(account: string, live = false, enabled = true) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.available(account),
    queryFn: () => data.getAvailable(account),
    refetchInterval: live ? LIVE_MS : IDLE_MS,
    enabled,
  });
}

/** Figures that need the vault's history (TAO on its way, rewards earned, the average entry price).
 * They come after the balance, once the scan has caught up: on a first visit that is the whole history,
 * later only what is new since the last. `enabled`: false where they're wanted only some of the time. */
export function usePositionHistory(account: string, enabled = true) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.history(account),
    queryFn: () => data.getPositionHistory(account),
    enabled,
    refetchInterval: IDLE_MS,
  });
}

/** Whether the site's deployment names a history indexer, whose seed may still be being checked; false
 * when none is configured. */
export function useIndexerNamed(): boolean {
  const data = useCascadeData();
  try {
    return data.deployment.indexerUrl !== undefined;
  } catch {
    return false;
  }
}

/** The stake proof (getProof), every 10 s while something is moving (`live`), every 30 s otherwise; `enabled` false
 * asks nothing of its own (the v3-launch stake form, which has no use for it) and reads whatever the cache holds. */
export function useProof(live = false, enabled = true) {
  const data = useCascadeData();
  return useQuery({ queryKey: cascadeKeys.proof(), queryFn: () => data.getProof(), refetchInterval: live ? LIVE_MS : IDLE_MS, enabled });
}

const moving = (s: string) => s === "in_progress" || s === "needs_you";
/** A record whose next step waits on the background check of the history indexer's seed ("checking"):
 * reading the list every 10 s moves it no sooner, and costs Bittensor reads each time. */
const checking = (r: { steps: { status: string }[] }) => r.steps.some((s) => s.status === "checking");
export const depositMoving = (d: DepositRecord): boolean => moving(d.status) && !checking(d);
export const withdrawalMoving = (w: WithdrawalRecord): boolean => (moving(w.status) && !checking(w)) || w.status === "ready";

/** Mined into its batch, which is still open on Base: it can still be taken back out (trail.ts). */
const inOpenBatch = (r: { cancellableWei?: bigint; cancellableShares?: bigint }) => r.cancellableWei !== undefined || r.cancellableShares !== undefined;

/** Whether a moving record has left Base (or isn't in its batch yet), so Bittensor is worth reading every
 * 10 s. While each moving one still waits in its open batch, nothing about it changes on Bittensor until
 * the batch leaves (up to 24 hours on the launch), and reading every 10 s only spends the archive node's
 * requests per minute (past them it answers 429 with a 60-second Retry-After, which stalls every read). */
export function movingOffBase<T extends { cancellableWei?: bigint; cancellableShares?: bigint }>(records: T[] | undefined, isMoving: (r: T) => boolean): boolean {
  return records?.some((r) => isMoving(r) && !inOpenBatch(r)) ?? false;
}

/** How often a list of deposits or unstakes is read again: 10 s while one has left Base, else 30 s. */
export const listPollMs = <T extends { cancellableWei?: bigint; cancellableShares?: bigint }>(records: T[] | undefined, isMoving: (r: T) => boolean): number =>
  movingOffBase(records, isMoving) ? LIVE_MS : IDLE_MS;

/** The account's deposits: one query for the list, the lane and each receipt. */
const depositsQuery = (data: CascadeData, account: string) => ({
  queryKey: cascadeKeys.deposits(account),
  queryFn: () => data.listDeposits(account),
  refetchInterval: (q: Query<DepositRecord[]>) => listPollMs(q.state.data, depositMoving),
});

/** The account's unstakes: one query for the list, the claim banner and each receipt. */
const withdrawalsQuery = (data: CascadeData, account: string) => ({
  queryKey: cascadeKeys.withdrawals(account),
  queryFn: () => data.listWithdrawals(account),
  refetchInterval: (q: Query<WithdrawalRecord[]>) => listPollMs(q.state.data, withdrawalMoving),
});

export function useDeposits(account: string) {
  const data = useCascadeData();
  return useQuery(depositsQuery(data, account));
}

/** One deposit, picked from the account's list (null when the list doesn't hold it): a receipt reads
 * nothing of its own, so one opened from the list shows at once, and a receipt and the list on screen
 * together read the chain once, not twice. */
export function useDeposit(account: string, id: string) {
  const data = useCascadeData();
  return useQuery({ ...depositsQuery(data, account), select: (list: DepositRecord[]) => list.find((d) => d.id === id) ?? null });
}

export function useWithdrawals(account: string) {
  const data = useCascadeData();
  return useQuery(withdrawalsQuery(data, account));
}

/** One unstake, picked from the account's list (as useDeposit). */
export function useWithdrawal(account: string, id: string) {
  const data = useCascadeData();
  return useQuery({ ...withdrawalsQuery(data, account), select: (list: WithdrawalRecord[]) => list.find((w) => w.id === id) ?? null });
}

/** This browser's own records (the op log), or none where there is no deployment. Read from storage
 * on each render: they are never the chain's word, only what this browser sent. */
function opsOf(data: CascadeData, account: string): Operation[] {
  try {
    return data.opLog.list(account as Address);
  } catch {
    return [];
  }
}

/** This browser's deposits or unstakes of the last day that `listed` (the list read from the chain, once
 * read) doesn't hold yet: shown at once, unconfirmed, while Activity reads the chain (pending.ts). */
export function usePendingEntries(account: string, kind: "deposit" | "withdrawal", listed: readonly { id: string }[] | undefined): PendingEntry[] {
  const data = useCascadeData();
  const now = useNow(60_000);
  return pendingEntries(opsOf(data, account), kind, listed, now);
}

/** This browser's own entry for its deposit (or unstake) `id`, if it sent it, it went through, and it was
 * sent in the last PENDING_SHOWN_MS, as in the list: an older one may well be staked or paid by now, so
 * its receipt waits for the chain rather than call it unconfirmed. */
export function usePendingEntry(account: string, kind: "deposit" | "withdrawal", id: string): PendingEntry | null {
  const data = useCascadeData();
  const now = useNow(60_000);
  return pendingEntries(opsOf(data, account), kind, undefined, now).find((e) => e.notice.id === id) ?? null;
}

/** For a record of the account's deposits or unstakes (`kind`), the cancel this browser sent for it that the record, as
 * last read, doesn't show yet (cancel-sent.ts), or null: asked of this browser's own records as they are at this render.
 * They change with no render of their own (a cancel is recorded as the wallet sends it), so they are read again every
 * second while a flow runs (`live`), every half minute otherwise. */
export function useCancelsSent(account: string, kind: "deposit" | "withdrawal", live = false): (record: CancelRecord | null | undefined) => CancelSent | null {
  const data = useCascadeData();
  const now = useNow(live ? 1_000 : 30_000);
  const ops = opsOf(data, account);
  return (record) => (record ? cancelSentFromHere(ops, kind, record, now) : null);
}

export function useDepositQuote(usdcUnits: bigint | null) {
  const data = useCascadeData();
  const amount = usdcUnits ?? 0n;
  return useQuery({
    queryKey: cascadeKeys.depositQuote(amount),
    queryFn: () => data.quoteDeposit(amount),
    enabled: amount > 0n,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

export function useWithdrawalQuote(account: string | null, shares: bigint | null) {
  const data = useCascadeData();
  const amount = shares ?? 0n;
  return useQuery({
    queryKey: cascadeKeys.withdrawalQuote(account ?? "", amount),
    queryFn: () => data.quoteWithdrawal(account as string, amount),
    enabled: account !== null && amount > 0n,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

/** v3.2: the account's live USDC delivery limit (delivery-limit.ts), with what else of its TAO a USDC unstake sells
 * and whether the chain holds a delivery preference for it, read again every 30 seconds: the largest delivery that
 * clears every floor right now moves with the market (the click checks its own sale again in any case: use-flows.ts).
 * Only when `enabled` (v3.2's form). */
export function useDeliveryLimit(account: string | null, enabled: boolean) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.deliveryLimit(account ?? ""),
    queryFn: () => data.getDeliveryLimit(account as string),
    enabled: enabled && account !== null,
    refetchInterval: 30_000,
  });
}

/** Reads of the unstake form's, started with the screen so they load beside the balance and not after it: the form
 * mounts only once the balance and what can be unstaked are known (UnstakeForm.tsx), and each of its reads would start
 * only then. They are the form's own queries (one read each: the form finds them in the cache), started in two steps:
 * - with the wallet, unless it is known to have nothing staked: its balances, the contracts' wiring check (which holds
 *   every button until it answers), and on v3.2 with USDC delivery off the delivery preference (one read on Base);
 * - only once the stake is known and above nothing, and not while its history is being checked against the chain (the
 *   form doesn't show then): on v3.2 the live delivery limit, which scans the vault's history, and what holds an
 *   unstake, each read again every 30 seconds. A visitor with nothing staked never starts them.
 * So they start earlier than the form would ask them, never for a form that can't show. Nothing here decides anything:
 * what gates the form and its buttons is unchanged. */
export function useUnstakeReads(account: string | null): void {
  const v32 = useIsV32();
  const usdcDelivery = useUsdcDelivery();
  const position = usePosition(account ?? "", false, account !== null);
  const available = useAvailable(account ?? "", false, account !== null);
  const reads = unstakeReads({ account, shares: position.data?.shares, checking: available.data?.checking === true, v32, usdcDelivery });
  useBalances(reads.account);
  useWiring(reads.wiring);
  useDeliveryPreference(reads.account, reads.deliveryPreference);
  useDeliveryLimit(reads.staked, reads.deliveryLimit);
  useExitHold(reads.exitHold);
}

/** Which reads the unstake screen starts (useUnstakeReads), and for whom.
 * - `account`: whose balances, wiring check (`wiring`) and, on v3.2 with USDC delivery off, delivery preference
 *   (`deliveryPreference`) are read from the start: the wallet's, unless it is known to have nothing staked (`shares`
 *   0; unknown, undefined, while the balance loads).
 * - `staked`: whose delivery limit (`deliveryLimit`: v3.2 with USDC delivery on) and unstake hold (`exitHold`: v3.2) are
 *   read: the wallet's only once its stake is known and above nothing, and its history isn't being checked against the
 *   chain (`checking`); no one's before that. */
export function unstakeReads(o: { account: string | null; shares: bigint | undefined; checking: boolean; v32: boolean; usdcDelivery: boolean }) {
  const account = o.account !== null && o.shares !== 0n ? o.account : null;
  const staked = account !== null && o.shares !== undefined && o.shares > 0n && !o.checking ? account : null;
  return {
    account,
    wiring: account !== null,
    deliveryPreference: account !== null && o.v32 && !o.usdcDelivery,
    staked,
    deliveryLimit: staked !== null && o.v32 && o.usdcDelivery,
    exitHold: o.v32 ? staked : null,
  };
}

/** v3: what a later unstake of `taoWei` costs, for the break-even line. Kept apart from the deposit
 * quote so its Bittensor read never holds up the stake button. */
export function useRoundTrip(taoWei: bigint | null) {
  const data = useCascadeData();
  const amount = taoWei ?? 0n;
  return useQuery({
    queryKey: cascadeKeys.roundTrip(amount),
    queryFn: () => data.quoteRoundTrip(amount),
    enabled: amount > 0n,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

/** useFlow's query: every minute while the tab is visible, and only when the build names an indexer. A document under
 * a minute old is fresh (staleTime), so focusing the tab again or remounting never reads it sooner: at most once a
 * minute, as the spec has it. */
export function flowQuery() {
  return {
    queryKey: cascadeKeys.flow(),
    queryFn: () => (DEPLOYMENT ? fetchFlow(DEPLOYMENT) : Promise.resolve(null)),
    enabled: Boolean(DEPLOYMENT?.indexerUrl),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
    retry: false,
  };
}

/** The monitor's public flow document for the security page (null when it can't be had). */
export function useFlow() {
  return useQuery(flowQuery());
}
