"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCascadeData } from "./context";
import type { SourceChain } from "./types";

/** Poll quickly while something is moving, slowly otherwise. */
const LIVE_MS = 1_000;
const IDLE_MS = 30_000;

export const cascadeKeys = {
  stats: () => ["cascade", "stats"] as const,
  account: (account: string) => ["cascade", account] as const,
  usdc: (account: string) => ["cascade", account, "usdc"] as const,
  rewards: (account: string) => ["cascade", account, "rewards"] as const,
  position: (account: string) => ["cascade", account, "position"] as const,
  proof: (account: string) => ["cascade", account, "proof"] as const,
  deposits: (account: string) => ["cascade", account, "deposits"] as const,
  deposit: (account: string, id: string) => ["cascade", account, "deposit", id] as const,
  withdrawals: (account: string) => ["cascade", account, "withdrawals"] as const,
  withdrawal: (account: string, id: string) => ["cascade", account, "withdrawal", id] as const,
  depositQuote: (amount: number, chain: SourceChain) => ["quote", "deposit", amount, chain] as const,
  withdrawalQuote: (tao: number) => ["quote", "withdrawal", tao] as const,
};

export function useProtocolStats() {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.stats(),
    queryFn: () => data.getProtocolStats(),
    refetchInterval: IDLE_MS,
  });
}

/** The demo account's USDC. Connected wallets read their balance from the chain instead. */
export function useMockUsdcBalance(account: string, enabled = true) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.usdc(account),
    queryFn: () => data.getUsdcBalance(account),
    refetchInterval: IDLE_MS,
    enabled,
  });
}

export function useRewards(account: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.rewards(account),
    queryFn: () => data.listRewards(account),
  });
}

export function usePosition(account: string, live = false) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.position(account),
    queryFn: () => data.getPosition(account),
    refetchInterval: live ? LIVE_MS : IDLE_MS,
  });
}

export function useProof(account: string, live = false) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.proof(account),
    queryFn: () => data.getProof(account),
    refetchInterval: live ? LIVE_MS : IDLE_MS,
  });
}

export function useDeposits(account: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.deposits(account),
    queryFn: () => data.listDeposits(account),
    refetchInterval: (q) =>
      q.state.data?.some((d) => d.status === "in_progress") ? LIVE_MS : IDLE_MS,
  });
}

export function useDeposit(account: string, id: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.deposit(account, id),
    queryFn: () => data.getDeposit(account, id),
    refetchInterval: (q) => (q.state.data?.status === "in_progress" ? LIVE_MS : false),
  });
}

export function useWithdrawals(account: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.withdrawals(account),
    queryFn: () => data.listWithdrawals(account),
    refetchInterval: (q) =>
      q.state.data?.some((w) => w.status === "in_progress") ? LIVE_MS : IDLE_MS,
  });
}

export function useWithdrawal(account: string, id: string) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.withdrawal(account, id),
    queryFn: () => data.getWithdrawal(account, id),
    refetchInterval: (q) => (q.state.data?.status === "in_progress" ? LIVE_MS : false),
  });
}

export function useDepositQuote(amountUsd: number | null, chain: SourceChain) {
  const data = useCascadeData();
  const amount = amountUsd ?? 0;
  return useQuery({
    queryKey: cascadeKeys.depositQuote(amount, chain),
    queryFn: () => data.quoteDeposit(amount, chain),
    enabled: amount > 0,
    placeholderData: keepPreviousData,
  });
}

export function useWithdrawalQuote(taoAmount: number | null) {
  const data = useCascadeData();
  const tao = taoAmount ?? 0;
  return useQuery({
    queryKey: cascadeKeys.withdrawalQuote(tao),
    queryFn: () => data.quoteWithdrawal(tao),
    enabled: tao > 0,
    placeholderData: keepPreviousData,
  });
}

export function useStartDeposit(account: string) {
  const data = useCascadeData();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ amountUsd, chain }: { amountUsd: number; chain: SourceChain }) =>
      data.startDeposit(account, amountUsd, chain),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cascadeKeys.account(account) }),
  });
}

export function useStartWithdrawal(account: string) {
  const data = useCascadeData();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taoAmount: number) => data.startWithdrawal(account, taoAmount),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cascadeKeys.account(account) }),
  });
}
