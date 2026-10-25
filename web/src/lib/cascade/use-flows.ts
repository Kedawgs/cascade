"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { base } from "viem/chains";
import { type Config, useConfig } from "wagmi";
import { getCapabilities, getChainId, sendCalls, switchChain, waitForCallsStatus, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useCascadeData } from "./context";
import {
  cancelCall,
  claimCalls,
  createFlowGuard,
  depositTaoCalls,
  type FlowCall,
  type FlowStore,
  runFlow,
  sellTaoCalls,
  stakeCalls,
  stillToSend,
  unstakeCall,
  type WalletPort,
} from "./flows";
import { cascadeKeys } from "./hooks";
import { type ClaimOp, type DepositOp, newOpId, type OpLog, type Operation, type WithdrawalOp } from "./oplog";
import { quoteSell, readFrontDoor } from "./reads";
import type { DepositQuote, WithdrawalQuote } from "./types";
import { floorRao, lessSlippage } from "./units";

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

/** A flow's progress kept in its operation log entry. A withdrawal has one call ("request"). */
function opStore(log: OpLog, account: Address, id: string): FlowStore {
  const op = () => log.get(account, id) as Operation;
  return {
    hashes: () => {
      const o = op();
      return o.kind === "withdrawal" ? { request: o.hash } : { ...o.hashes };
    },
    setHash: (k, h) => {
      const o = op();
      if (o.kind === "withdrawal") log.update(account, id, { hash: h });
      else log.update(account, id, { hashes: { ...o.hashes, [k]: h } } as Partial<Operation>);
    },
    setState: (state, error) => log.update(account, id, { state, error }),
    callsId: () => {
      const o = op();
      return o.kind === "withdrawal" ? undefined : o.callsId;
    },
    setCallsId: (callsId) => log.update(account, id, { callsId } as Partial<Operation>),
    mode: () => op().mode,
    setMode: (mode) => log.update(account, id, { mode }),
  };
}

function scratchStore(): FlowStore {
  const hashes: Record<string, Hex | undefined> = {};
  let mode: "batch" | "sequential" | undefined;
  let callsId: string | undefined;
  return {
    hashes: () => hashes,
    setHash: (k, h) => void (hashes[k] = h),
    setState: () => undefined,
    callsId: () => callsId,
    setCallsId: (id) => void (callsId = id),
    mode: () => mode,
    setMode: (m) => void (mode = m),
  };
}

/** Staking, unstaking, claiming and cancelling from the connected wallet. One flow at a time; each is
 * recorded before the first signature, so it shows in Activity and can be continued after a stop. */
export function useFlows(account: string | null) {
  const config = useConfig();
  const data = useCascadeData();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(createFlowGuard(setBusy)).current;

  const a = account as Address;
  const d = () => data.deployment;

  /** Runs `body` under the guard (claimed before any read), records errors and refreshes the data. */
  async function flow<T>(label: string, body: () => Promise<T>): Promise<T> {
    if (!account) throw new Error("Connect a wallet first");
    setError(null);
    try {
      return await guard.run(label, body);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      void queryClient.invalidateQueries({ queryKey: cascadeKeys.all() });
      void queryClient.invalidateQueries({ queryKey: ["quote"] });
    }
  }

  /** Sends `calls` for the operation `id`, marked as running in this tab while it does. A read that
   * fails before sending leaves the operation waiting for the user, not stuck as "running". */
  async function send(id: string, build: () => Promise<FlowCall[]>) {
    const store = opStore(data.opLog, a, id);
    data.opLog.markActive(id);
    try {
      let calls: FlowCall[];
      try {
        calls = await build();
      } catch (e) {
        store.setState("needs-you", "We couldn't read your wallet just now. Continue to try again.");
        throw e;
      }
      if (calls.length === 0) {
        store.setState("sent");
        return;
      }
      await runFlow(wagmiPort(config, a), store, calls);
    } finally {
      data.opLog.markInactive(id);
    }
  }

  return {
    busy,
    error,

    /** Starts a stake from a quote; `onStart` gets the operation id before the first wallet prompt. */
    stake: (q: DepositQuote, onStart?: (id: string) => void) =>
      flow("stake", async () => {
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
        onStart?.(op.id);
        await send(op.id, async () => stakeCalls(q, await data.getBalances(a), d(), a));
        return op.id;
      }),

    /** Carries on a stake that stopped, skipping whatever the chain shows already happened. */
    resumeStake: (id: string) =>
      flow("stake", async () => {
        await send(id, async () => {
          const op = data.opLog.get(a, id) as DepositOp;
          const [w, fd] = await Promise.all([data.getBalances(a), readFrontDoor(data.clients, d(), a)]);
          const calls = op.usdcIn === 0n ? depositTaoCalls(op.targetTao, w, d()) : stakeCalls(op, w, d(), a);
          return stillToSend(calls, op, { walletTao: w.tao, depositOf: fd.depositOf });
        });
      }),

    /** Deposits TAO already sitting in the wallet (left by a cancel, a claim kept as TAO, a failed step). */
    depositWalletTao: (taoWei: bigint, priceUsd: number, onStart?: (id: string) => void) =>
      flow("stake", async () => {
        const op: DepositOp = {
          id: newOpId(),
          kind: "deposit",
          account: a,
          createdAt: Date.now(),
          usdcIn: 0n,
          targetTao: floorRao(taoWei),
          priceUsd,
          hashes: {},
          state: "running",
        };
        data.opLog.put(op);
        onStart?.(op.id);
        await send(op.id, async () => depositTaoCalls(op.targetTao, await data.getBalances(a), d()));
        return op.id;
      }),

    /** Swaps TAO sitting in the wallet back to USDC (0.5% slippage). */
    sellWalletTao: (taoWei: bigint) =>
      flow("swap", async () => {
        const [w, out] = await Promise.all([data.getBalances(a), quoteSell(data.clients, taoWei)]);
        await runFlow(wagmiPort(config, a), scratchStore(), sellTaoCalls(taoWei, lessSlippage(out), w, a));
      }),

    unstake: (q: WithdrawalQuote, onStart?: (id: string) => void) =>
      flow("unstake", async () => {
        const op: WithdrawalOp = {
          id: newOpId(),
          kind: "withdrawal",
          account: a,
          createdAt: Date.now(),
          shares: q.shares,
          taoEstimate: q.taoWei,
          usdcEstimate: BigInt(Math.floor(q.usdcAmount * 1e6)),
          fee: q.fee,
          state: "running",
        };
        data.opLog.put(op);
        onStart?.(op.id);
        await send(op.id, async () => {
          const fd = await readFrontDoor(data.clients, d(), a);
          const c = unstakeCall(q.shares, fd.redeemOf, fd.redeemRequestFee, d());
          data.opLog.update(a, op.id, { fee: c.value ?? 0n });
          return [c];
        });
        return op.id;
      }),

    /** Claims what is back on Base for the given unstakes and, unless `keepTao`, swaps it to USDC. */
    claim: (withdrawalIds: string[], keepTao: boolean) =>
      flow("claim", async () => {
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
          withdrawalIds,
          state: "running",
        };
        data.opLog.put(op);
        await send(op.id, async () => claimCalls(fd.claimable, minUsdc, await data.getBalances(a), d(), a, keepTao));
      }),

    /** Carries on a claim that stopped (usually the swap after the claim went through). */
    resumeClaim: (withdrawalId: string) =>
      flow("claim", async () => {
        const op = data.opLog
          .list(a)
          .find((o): o is ClaimOp => o.kind === "claim" && (o.withdrawalIds ?? []).includes(withdrawalId));
        if (!op) throw new Error("There is no claim to continue for this unstake");
        await send(op.id, async () => {
          const w = await data.getBalances(a);
          if (op.hashes.claim && !op.keepTao) {
            // the claim went through: swap what it paid at today's price, forgetting a swap that failed
            const minUsdc = lessSlippage(await quoteSell(data.clients, op.amount));
            data.opLog.update(a, op.id, { minUsdc, hashes: { ...op.hashes, swap: undefined } });
            return claimCalls(op.amount, minUsdc, w, d(), a, false);
          }
          return claimCalls(op.amount, op.minUsdc, w, d(), a, op.keepTao);
        });
      }),

    /** Drops an entry that never sent a transaction from this browser's list. */
    remove(id: string) {
      data.opLog.remove(a, id);
      void queryClient.invalidateQueries({ queryKey: cascadeKeys.all() });
    },

    /** Takes an entry back out of the open batch and records it on that entry. */
    cancel: (kind: "deposit" | "withdrawal", id: string, amount: bigint) =>
      flow("cancel", async () => {
        const store = scratchStore();
        await runFlow(wagmiPort(config, a), store, [cancelCall(kind, amount, d())]);
        const hash = store.hashes().cancel;
        if (hash) data.opLog.update(a, id, { cancelled: { hash, at: Date.now() } } as Partial<Operation>);
      }),
  };
}
