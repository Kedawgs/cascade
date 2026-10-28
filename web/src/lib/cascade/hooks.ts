"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { isV3 } from "./config";
import { useCascadeData } from "./context";

/** Chain reads: every 10 s while something is moving (Bittensor makes a block every 12 s, and the
 * public nodes rate-limit), every 30 s otherwise. */
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
  rewards: (account: string) => ["cascade", account, "rewards"] as const,
  position: (account: string) => ["cascade", account, "position"] as const,
  deposits: (account: string) => ["cascade", account, "deposits"] as const,
  deposit: (account: string, id: string) => ["cascade", account, "deposit", id] as const,
  withdrawals: (account: string) => ["cascade", account, "withdrawals"] as const,
  withdrawal: (account: string, id: string) => ["cascade", account, "withdrawal", id] as const,
  depositQuote: (usdc: bigint) => ["quote", "deposit", usdc.toString()] as const,
  withdrawalQuote: (account: string, shares: bigint) => ["quote", "withdrawal", account, shares.toString()] as const,
  roundTrip: (taoWei: bigint) => ["quote", "round-trip", taoWei.toString()] as const,
};

/** Whether the site talks to a v3 deployment; false when none is configured (its reads all fail). */
export function useIsV3(): boolean {
  const data = useCascadeData();
  try {
    return isV3(data.deployment);
  } catch {
    return false;
  }
}

export function useProtocolStats() {
  const data = useCascadeData();
  return useQuery({ queryKey: cascadeKeys.stats(), queryFn: () => data.getProtocolStats(), refetchInterval: IDLE_MS });
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

export function useProof(live = false) {
  const data = useCascadeData();
  return useQuery({ queryKey: cascadeKeys.proof(), queryFn: () => data.getProof(), refetchInterval: live ? LIVE_MS : IDLE_MS });
}

const moving = (s: string) => s === "in_progress" || s === "needs_you";

export function useDeposits(account: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.deposits(account),
    queryFn: () => data.listDeposits(account),
    refetchInterval: (q) => (q.state.data?.some((d) => moving(d.status)) ? LIVE_MS : IDLE_MS),
  });
}

export function useDeposit(account: string, id: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.deposit(account, id),
    queryFn: () => data.getDeposit(account, id),
    refetchInterval: (q) => (q.state.data && moving(q.state.data.status) ? LIVE_MS : IDLE_MS),
  });
}

export function useWithdrawals(account: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.withdrawals(account),
    queryFn: () => data.listWithdrawals(account),
    refetchInterval: (q) => (q.state.data?.some((w) => moving(w.status) || w.status === "ready") ? LIVE_MS : IDLE_MS),
  });
}

export function useWithdrawal(account: string, id: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.withdrawal(account, id),
    queryFn: () => data.getWithdrawal(account, id),
    refetchInterval: (q) => (q.state.data && (moving(q.state.data.status) || q.state.data.status === "ready") ? LIVE_MS : IDLE_MS),
  });
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
