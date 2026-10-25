"use client";

import { useCascadeAccount } from "./account";
import { useBalances } from "./cascade/hooks";
import { toDisplay } from "./cascade/units";
import type { BalanceQuery } from "./usdc-balance";

/** The connected wallet's USDC on Base, read from the chain; pending when nobody is signed in. */
export function useUsdcBalance(): BalanceQuery {
  const { state } = useCascadeAccount();
  const balances = useBalances(state.status === "wallet" ? state.account : null);
  if (state.status !== "wallet") return { status: "pending" };
  if (balances.isError) return { status: "error" };
  if (!balances.data) return { status: "pending" };
  return { status: "success", data: toDisplay(balances.data.usdc, 6) };
}
