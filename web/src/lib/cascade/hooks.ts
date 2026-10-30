"use client";

import { keepPreviousData, type Query, type QueryClient, useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useNow } from "../client-state";
import { shownFigure, STATS_KEEP_MS } from "../stats";
import { isV3 } from "./config";
import { useCascadeData, useSnapshotAt } from "./context";
import type { Operation } from "./oplog";
import { type PendingEntry, pendingEntries } from "./pending";
import type { DepositRecord, WithdrawalRecord } from "./records";
import type { Snapshot } from "./snapshot";
import type { CascadeData } from "./types";
import { WIRING_TTL_MS } from "./wiring";

/** Chain reads: every 10 s while something is moving beyond its open batch on Base (Bittensor makes a
 * block every 12 s, and the public nodes rate-limit: see movingOffBase), every 30 s otherwise. */
const LIVE_MS = 10_000;
const IDLE_MS = 30_000;

/** Query keys hold bigints as strings (react-query hashes keys with JSON). */
export const cascadeKeys = {
  all: () => ["cascade"] as const,
  stats: () => ["cascade", "stats"] as const,
  apy: () => ["cascade", "apy"] as const,
  limits: () => ["cascade", "limits"] as const,
  proof: () => ["cascade", "proof"] as const,
  account: (account: string) => ["cascade", account] as const,
  balances: (account: string) => ["cascade", account, "balances"] as const,
  code: (account: string) => ["cascade", account, "code"] as const,
  rewards: (account: string) => ["cascade", account, "rewards"] as const,
  position: (account: string) => ["cascade", account, "position"] as const,
  available: (account: string) => ["cascade", account, "available"] as const,
  history: (account: string) => ["cascade", account, "history"] as const,
  deposits: (account: string) => ["cascade", account, "deposits"] as const,
  withdrawals: (account: string) => ["cascade", account, "withdrawals"] as const,
  depositQuote: (usdc: bigint) => ["quote", "deposit", usdc.toString()] as const,
  withdrawalQuote: (account: string, shares: bigint) => ["quote", "withdrawal", account, shares.toString()] as const,
  roundTrip: (taoWei: bigint) => ["quote", "round-trip", taoWei.toString()] as const,
};

/** Puts the server's snapshot into a new cache, dated when it was read, so the first render (on the
 * server, and in the browser while it hydrates) shows the same figures. The live reads refresh them in
 * place as they come due. */
export function seedSnapshot(client: QueryClient, s: Snapshot): void {
  if (s.apyPercent !== undefined) client.setQueryData(cascadeKeys.apy(), s.apyPercent, { updatedAt: s.at });
  if (s.stats !== undefined) client.setQueryData(cascadeKeys.stats(), s.stats, { updatedAt: s.at });
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

export function useProtocolStats() {
  const data = useCascadeData();
  return useQuery({ queryKey: cascadeKeys.stats(), queryFn: () => data.getProtocolStats(), refetchInterval: IDLE_MS });
}

/** The TAO price to show, wherever one is shown: a live read's, kept through failed reads for an hour
 * (see shownFigure), and none while the figures are still the server's snapshot. That one is as old as
 * the last deploy, and mustn't pass for today's price on a page where people decide to deposit, so the
 * first paint has "–" in its place. (Totals may show the snapshot's.) A figure is the snapshot's when it
 * is dated exactly when the snapshot was read: "no later than" would also catch the browser's own reads
 * when its clock is behind the build machine's. */
export function useTaoPrice(): number | undefined {
  const stats = useProtocolStats();
  const snapshotAt = useSnapshotAt();
  if (snapshotAt !== 0 && stats.dataUpdatedAt === snapshotAt) return undefined;
  return shownFigure(stats, STATS_KEEP_MS)?.taoPriceUsd;
}

/** A 30-day figure moves slowly: read it every half hour, and keep the last good one through a failed read. */
const APY_MS = 30 * 60_000;

export function useApy() {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.apy(),
    queryFn: () => data.getApy(),
    staleTime: APY_MS,
    refetchInterval: APY_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  });
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

export function usePosition(account: string, live = false) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.position(account),
    queryFn: () => data.getPosition(account),
    refetchInterval: live ? LIVE_MS : IDLE_MS,
  });
}

/** What can be unstaked. Usually as quick as the balance: it waits on the vault's history only while an
 * unstake from this browser is on its way and its arrival isn't known yet. */
export function useAvailable(account: string, live = false) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.available(account),
    queryFn: () => data.getAvailable(account),
    refetchInterval: live ? LIVE_MS : IDLE_MS,
  });
}

/** Figures that need the vault's history (TAO on its way, rewards earned, the average entry price).
 * They come after the balance, once the scan has caught up: on a first visit that is the whole history,
 * later only what is new since the last. */
export function usePositionHistory(account: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.history(account),
    queryFn: () => data.getPositionHistory(account),
    refetchInterval: IDLE_MS,
  });
}

export function useProof(live = false) {
  const data = useCascadeData();
  return useQuery({ queryKey: cascadeKeys.proof(), queryFn: () => data.getProof(), refetchInterval: live ? LIVE_MS : IDLE_MS });
}

const moving = (s: string) => s === "in_progress" || s === "needs_you";
export const depositMoving = (d: DepositRecord): boolean => moving(d.status);
export const withdrawalMoving = (w: WithdrawalRecord): boolean => moving(w.status) || w.status === "ready";

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
