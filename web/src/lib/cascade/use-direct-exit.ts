"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type Address, createWalletClient, custom, type EIP1193Provider, type Hex, toHex } from "viem";
import { base } from "viem/chains";
import { useConfig } from "wagmi";
import { getCapabilities, getConnection } from "wagmi/actions";
import { atomicOf } from "../stake-form";
import { bittensor } from "./chain";
import { useCascadeData } from "./context";
import {
  BITTENSOR_CHAIN_ID,
  BITTENSOR_WALLET_CHAIN,
  type BittensorChain,
  type BittensorWallet,
  type DirectOutcome,
  type DirectStep,
  directExitMessage,
  DirectExitStop,
  estimateOnBittensor,
  LOST,
  NO_WALLET,
  readDirectExit,
  runDirectStep,
  simulateOnBittensor,
  type Unconfirmed,
  unconfirmedHolds,
} from "./direct-exit";
import { cascadeKeys } from "./hooks";
import { appGuard } from "./use-flows";

/** How often the page reads Bittensor again: Bittensor makes a block every 12 s, and the public node rate-limits. */
const READ_MS = 30_000;
/** How long a sent step is waited for on Bittensor before the page says to look it up. */
const RECEIPT_TIMEOUT_MS = 10 * 60_000;

/** v3.2: the emergency page's reads for the account (direct-exit.ts readDirectExit). */
export function useDirectExit(account: string | null) {
  const data = useCascadeData();
  return useQuery({
    queryKey: cascadeKeys.directExit(account ?? ""),
    queryFn: () => readDirectExit(data.clients, data.deployment, account as Address),
    enabled: account !== null,
    refetchInterval: READ_MS,
  });
}

/** The wallet on Bittensor EVM through its own EIP-1193 provider: wagmi's config knows Base only (wagmi.ts), and this
 * page is the one place the site sends anything on Bittensor. viem checks the wallet is on chain 964 before each send
 * (writeContract with `chain`), so nothing goes out on another chain. A withdrawal goes from `account` with its gas limit
 * and fees (direct-exit.ts WithdrawalTx); exported for its test (use-direct-exit.test.ts). */
export function walletOn(provider: EIP1193Provider, account: Address): BittensorWallet {
  const client = createWalletClient({ account, chain: bittensor, transport: custom(provider) });
  return {
    chainId: async () => Number(await provider.request({ method: "eth_chainId" })),
    async switchChain() {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(BITTENSOR_CHAIN_ID) }] });
    },
    async addChain() {
      await provider.request({ method: "wallet_addEthereumChain", params: [BITTENSOR_WALLET_CHAIN] });
    },
    // the withdrawal names its gas limit and the fees its balance was checked at (direct-exit.ts WithdrawalTx, review M-6
    // and its review's M2); the other steps leave both to the wallet
    send: (c, tx) =>
      client.writeContract({
        address: c.to,
        abi: c.abi,
        functionName: c.functionName,
        args: c.args,
        ...(tx ? { gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
      } as never),
  };
}

/** An earlier transaction's receipt on Bittensor, looked up without waiting: its status, or null while it isn't mined. */
async function minedOn(data: ReturnType<typeof useCascadeData>, hash: Hex): Promise<"success" | "reverted" | null> {
  try {
    const r = await data.clients.bittensor.getTransactionReceipt({ hash });
    return r.status === "success" ? "success" : "reverted";
  } catch (e) {
    if ((e as { name?: string })?.name === "TransactionReceiptNotFoundError") return null;
    throw e;
  }
}

/** The emergency page's steps (direct-exit.ts runDirectStep) from the connected wallet, under the app's one flow
 * lock: `busy` is the running flow's label (anywhere in the app), `error` why the last step stopped (with its
 * transaction, when one was sent), `outcome` what it came to. A withdrawal it couldn't confirm (LOST) is kept, and its
 * receipt looked up every half minute: `holds(shares)` says whether it still holds a second one (M7). Every read
 * refreshes after a step. */
export function useDirectExitFlow(account: string | null) {
  const config = useConfig();
  const data = useCascadeData();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(appGuard.active);
  const [error, setError] = useState<{ message: string; hash?: Hex } | null>(null);
  const [outcome, setOutcome] = useState<DirectOutcome | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<Unconfirmed | null>(null);
  useEffect(() => appGuard.subscribe(setBusy), []);
  // the unconfirmed withdrawal's receipt, until it shows (a read that fails says nothing: it is read again)
  const receipt = useQuery({
    queryKey: [...cascadeKeys.directExit(account ?? ""), "receipt", unconfirmed?.hash ?? ""],
    queryFn: () => minedOn(data, unconfirmed!.hash),
    enabled: unconfirmed !== null,
    refetchInterval: (q) => (q.state.data ? false : READ_MS),
  });
  const mined = !!receipt.data;

  async function run(step: DirectStep, shownShares: bigint): Promise<void> {
    if (!account) return;
    const a = account as Address;
    setError(null);
    setOutcome(null);
    try {
      const out = await appGuard.run(directStepLabel(step), async () => {
        const { connector } = getConnection(config);
        const provider = connector ? ((await connector.getProvider().catch(() => undefined)) as EIP1193Provider | undefined) : undefined;
        if (!connector || !provider) throw new DirectExitStop(NO_WALLET);
        const chain: BittensorChain = {
          read: () => readDirectExit(data.clients, data.deployment, a),
          simulate: (call) => simulateOnBittensor(data.clients, a, call),
          estimate: (call) => estimateOnBittensor(data.clients, a, call),
          async wait(hash) {
            const r = await data.clients.bittensor.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
            return { status: r.status === "success" ? "success" : "reverted", logs: r.logs };
          },
          mined: (hash) => minedOn(data, hash),
        };
        // the wallet's kind read again at the click, as the stake form reads it (use-wallet-kind.ts): a smart account not
        // yet deployed has no code, only its atomic batches on Base give it away
        const atomic = atomicOf(await getCapabilities(config, { account: a, chainId: base.id }).catch(() => undefined));
        const kind = { connectorId: connector.id, ...(atomic ? { atomic } : {}) };
        return runDirectStep(step, { wallet: walletOn(provider, a), chain, d: data.deployment, account: a, shownShares, kind, unconfirmed: mined ? null : unconfirmed });
      });
      setOutcome(out);
      if (step === "withdraw") setUnconfirmed(null);
    } catch (e) {
      setError({ message: directExitMessage(e), ...(e instanceof DirectExitStop && e.hash ? { hash: e.hash } : {}) });
      // a withdrawal sent whose receipt didn't come: kept, so no second one goes before it shows or the shares move
      if (step === "withdraw" && e instanceof DirectExitStop && e.message === LOST && e.hash) setUnconfirmed({ hash: e.hash, shares: shownShares });
    } finally {
      void queryClient.invalidateQueries({ queryKey: cascadeKeys.all() });
    }
  }

  return { busy, error, outcome, run, holds: (shares: bigint) => unconfirmedHolds(unconfirmed, shares, mined) };
}

/** A step's label in the app's flow lock. */
export const directStepLabel = (step: DirectStep): string => (step === "origin" ? "directOrigin" : step === "base" ? "directBase" : "directExit");
