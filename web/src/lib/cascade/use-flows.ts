"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Address, Hex } from "viem";
import { base } from "viem/chains";
import { type Config, useConfig } from "wagmi";
import { getCapabilities, getChainId, sendCalls, switchChain, waitForCallsStatus, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useCascadeData } from "./context";
import { cancelCall, claimCalls, type FlowCall, type FlowStore, runFlow, stakeCalls, unstakeCall, type WalletPort } from "./flows";
import { cascadeKeys } from "./hooks";
import { type ClaimOp, type DepositOp, newOpId, type OpLog, type WithdrawalOp } from "./oplog";
import { quoteSell, readFrontDoor } from "./reads";
import type { DepositQuote, WithdrawalQuote } from "./types";
import { lessSlippage } from "./units";

/** The wallet as a flow sees it, through wagmi (EIP-5792 batches when the wallet offers them). */
export function wagmiPort(config: Config, account: Address): WalletPort {
  return {
    async switchToBase() {
      if (getChainId(config) !== base.id) await switchChain(config, { chainId: base.id });
    },
    async canBatch() {
      try {
        const caps = (await getCapabilities(config, { account, chainId: base.id })) as {
          atomic?: { status?: string };
          atomicBatch?: { supported?: boolean };
        };
        const status = caps?.atomic?.status;
        return status === "supported" || status === "ready" || caps?.atomicBatch?.supported === true;
      } catch {
        return false;
      }
    },
    async sendBatch(calls: FlowCall[]) {
      const r = await sendCalls(config, {
        account,
        chainId: base.id,
        forceAtomic: true,
        calls: calls.map((c) => ({ to: c.to, abi: c.abi, functionName: c.functionName, args: c.args, value: c.value })) as never,
      });
      return { id: r.id };
    },
    async waitBatch(id: string) {
      const r = await waitForCallsStatus(config, { id, timeout: 15 * 60_000 });
      return { status: r.status === "success" ? "success" : "failure", hashes: (r.receipts ?? []).map((x) => x.transactionHash) };
    },
    send: (c: FlowCall) =>
      writeContract(config, {
        account,
        chainId: base.id,
        address: c.to,
        abi: c.abi,
        functionName: c.functionName,
        args: c.args,
        value: c.value,
      } as never),
    async wait(hash: Hex) {
      const r = await waitForTransactionReceipt(config, { hash, chainId: base.id });
      return { status: r.status === "success" ? "success" : "reverted" };
    },
  };
}

/** A deposit's or claim's progress kept in the operation log (each call's hash by key). */
function hashesStore(log: OpLog, account: Address, id: string): FlowStore {
  const op = () => log.get(account, id) as DepositOp | ClaimOp;
  return {
    hashes: () => ({ ...op().hashes }),
    setHash: (k, h) => log.update(account, id, { hashes: { ...op().hashes, [k]: h } }),
    setState: (state, error) => log.update(account, id, { state, error }),
    setCallsId: (callsId) => log.update(account, id, { callsId, mode: "batch" }),
  };
}

function withdrawalStore(log: OpLog, account: Address, id: string): FlowStore {
  const op = () => log.get(account, id) as WithdrawalOp;
  return {
    hashes: () => ({ request: op().hash }),
    setHash: (_k, h) => log.update(account, id, { hash: h }),
    setState: (state, error) => log.update(account, id, { state, error }),
    setCallsId: () => undefined,
  };
}

function scratchStore(): FlowStore {
  const hashes: Record<string, Hex | undefined> = {};
  return { hashes: () => hashes, setHash: (k, h) => void (hashes[k] = h), setState: () => undefined, setCallsId: () => undefined };
}

/** Staking, unstaking, claiming and cancelling from the connected wallet. Each records its progress
 * before the first signature, so it shows in Activity and can be resumed. */
export function useFlows(account: string | null) {
  const config = useConfig();
  const data = useCascadeData();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, store: FlowStore, calls: FlowCall[]) {
    if (!account) throw new Error("Connect a wallet first");
    setError(null);
    setBusy(label);
    try {
      await runFlow(wagmiPort(config, account as Address), store, calls);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: cascadeKeys.all() });
      void queryClient.invalidateQueries({ queryKey: ["quote"] });
    }
  }

  const a = account as Address;
  const d = () => data.deployment;

  return {
    busy,
    error,

    /** Starts a stake from a quote; returns the operation id (the Activity receipt). */
    async stake(q: DepositQuote): Promise<string> {
      const op: DepositOp = {
        id: newOpId(),
        kind: "deposit",
        account: a,
        createdAt: Date.now(),
        usdcIn: q.usdcIn,
        targetTao: q.targetTao,
        priceUsd: q.taoPriceUsd,
        feesUsd: q.feesUsd,
        hashes: {},
        state: "running",
      };
      data.opLog.put(op);
      const w = await data.getBalances(a);
      await run("stake", hashesStore(data.opLog, a, op.id), stakeCalls(q, w, d(), a));
      return op.id;
    },

    /** Carries on a stake that stopped (a rejected or interrupted wallet step). */
    async resumeStake(id: string): Promise<void> {
      const op = data.opLog.get(a, id) as DepositOp;
      const w = await data.getBalances(a);
      await run("stake", hashesStore(data.opLog, a, id), stakeCalls(op, w, d(), a));
    },

    async unstake(q: WithdrawalQuote): Promise<string> {
      const fd = await readFrontDoor(data.clients, d(), a);
      const c = unstakeCall(q.shares, fd.redeemOf, fd.redeemRequestFee, d());
      const op: WithdrawalOp = {
        id: newOpId(),
        kind: "withdrawal",
        account: a,
        createdAt: Date.now(),
        shares: q.shares,
        taoEstimate: q.taoWei,
        usdcEstimate: BigInt(Math.floor(q.usdcAmount * 1e6)),
        fee: c.value ?? 0n,
        state: "running",
      };
      data.opLog.put(op);
      await run("unstake", withdrawalStore(data.opLog, a, op.id), [c]);
      return op.id;
    },

    /** Claims what is back on Base and, unless `keepTao`, swaps it to USDC (0.5% slippage). */
    async claim(keepTao: boolean): Promise<void> {
      const fd = await readFrontDoor(data.clients, d(), a);
      if (fd.claimable === 0n) throw new Error("Nothing is waiting to be claimed yet");
      const minUsdc = keepTao ? 0n : lessSlippage(await quoteSell(data.clients, fd.claimable));
      const op: ClaimOp = {
        id: newOpId(),
        kind: "claim",
        account: a,
        createdAt: Date.now(),
        amount: fd.claimable,
        keepTao,
        minUsdc,
        hashes: {},
        state: "running",
      };
      data.opLog.put(op);
      const w = await data.getBalances(a);
      await run("claim", hashesStore(data.opLog, a, op.id), claimCalls(fd.claimable, minUsdc, w, d(), a, keepTao));
    },

    /** Takes an entry back out of the open batch. */
    async cancel(kind: "deposit" | "withdrawal", amount: bigint): Promise<void> {
      await run("cancel", scratchStore(), [cancelCall(kind, amount, d())]);
    },
  };
}
