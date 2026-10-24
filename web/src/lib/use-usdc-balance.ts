"use client";

import { erc20Abi } from "viem";
import { useReadContract } from "wagmi";
import { base } from "wagmi/chains";
import { useCascadeAccount } from "./account";
import { useMockUsdcBalance } from "./cascade/hooks";
import { BASE_USDC, USDC_DECIMALS, type BalanceQuery } from "./usdc-balance";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * The current account's USDC on Base: from the mock for the demo account, from the
 * chain for a connected wallet, pending when nobody is signed in.
 */
export function useUsdcBalance(): BalanceQuery {
  const { state } = useCascadeAccount();
  const demo = state.status === "demo";
  const wallet = state.status === "wallet";
  const account = demo || wallet ? state.account : null;

  const mock = useMockUsdcBalance(demo && account ? account : "", demo);
  const chain = useReadContract({
    address: BASE_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet && account ? (account as `0x${string}`) : ZERO],
    chainId: base.id,
    query: { enabled: wallet, refetchInterval: 30_000 },
  });

  if (demo) {
    if (mock.isError) return { status: "error" };
    return mock.data === undefined ? { status: "pending" } : { status: "success", data: mock.data };
  }
  if (wallet) {
    if (chain.isError) return { status: "error" };
    if (chain.data === undefined) return { status: "pending" };
    return { status: "success", data: Number(chain.data) / 10 ** USDC_DECIMALS };
  }
  return { status: "pending" };
}
