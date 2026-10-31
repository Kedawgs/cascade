"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address, Hex, PublicClient } from "viem";
import { base } from "viem/chains";
import { type Config, useConfig } from "wagmi";
import {
  getCapabilities,
  getConnection,
  sendCalls,
  signTypedData,
  switchChain,
  waitForCallsStatus,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { isV3 } from "./config";
import { useCascadeData } from "./context";
import { claimWentThrough, findStakeTx } from "./facts";
import {
  assertWired,
  needsWiring,
  cancelCall,
  claimCalls,
  claimRetryPatch,
  createSharedFlowGuard,
  depositTaoCalls,
  type FlowCall,
  FlowError,
  type FlowStore,
  isRevert,
  planResumeDeposit,
  planResumeStakeV3,
  type QuoteMove,
  QuoteMovedError,
  saleFloor,
  SaleRefusedError,
  planSendNow,
  planStakeV3,
  planUnstake,
  type Replacement,
  retryPatch,
  revertReason,
  runFlow,
  sellTaoCalls,
  splitSignature,
  userMessage,
  walletTaoDepositOp,
  stakeCalls,
  type WalletPort,
  wiringNotice,
} from "./flows";
import { cascadeKeys, useWiring } from "./hooks";
import { cancelStore, opStore, scratchStore } from "./op-store";
import { type ClaimOp, type CloseOp, type DepositOp, newOpId, type Operation, type WithdrawalOp } from "./oplog";
import { quoteSell, readCloseOutcome, readFrontDoor, readOraclePrice, readPermitNonce, taoPriceUsd } from "./reads";
import type { DepositQuote, WithdrawalQuote } from "./types";

/** The wallet as a flow sees it, through wagmi (EIP-5792 batches when the wallet offers them); Base's
 * public RPC (`reader`) answers what the wallet doesn't need to: code at the account, and simulations. */
export function wagmiPort(config: Config, account: Address, reader: PublicClient): WalletPort {
  return {
    /** The wallet's own chain decides: wagmi's chain id stays on Base while the wallet sits on a chain
     * the site doesn't know, so it can't tell a wallet on another chain from one on Base. */
    async switchToBase() {
      const { connector, chainId } = getConnection(config);
      const current = connector ? await connector.getChainId().catch(() => chainId) : chainId;
      if (current !== base.id) await switchChain(config, { chainId: base.id });
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
    /** Base (through viem) notices when the wallet sped the transaction up, cancelled it or replaced it,
     * and then waits for the one in its place: `onReplaced` hears which, so the record follows it. */
    async wait(hash: Hex, onReplaced?: (r: Replacement) => void) {
      const r = await waitForTransactionReceipt(config, {
        hash,
        chainId: base.id,
        onReplaced: (x) => onReplaced?.({ hash: x.transaction.hash, reason: x.reason }),
      });
      return { status: r.status === "success" ? "success" : "reverted" };
    },
    async hasCode(address: Address) {
      const code = await reader.getCode({ address });
      return code !== undefined && code !== "0x";
    },
    async signPermit(typedData) {
      return splitSignature(await signTypedData(config, { account, ...typedData }));
    },
    async simulate(c: FlowCall) {
      try {
        await reader.simulateContract({ account, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args, value: c.value } as never);
        return { ok: true };
      } catch (e) {
        if (!isRevert(e)) throw e;
        const revert = revertReason(e);
        return { ok: false, ...(revert !== undefined ? { revert } : {}) };
      }
    },
  };
}

/** The app's one flow lock: a claim can't start while a stake waits in the wallet, and so on. */
const appGuard = createSharedFlowGuard();

/** Staking, unstaking, claiming and cancelling from the connected wallet. One flow at a time; each is
 * recorded before the first signature, so it shows in Activity and can be continued after a stop. */
export function useFlows(account: string | null) {
  const config = useConfig();
  const data = useCascadeData();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(appGuard.active);
  const [error, setError] = useState<string | null>(null);
  /** A stake being carried on whose quote moved: today's figure against the one shown, awaiting the
   * user's say-so (resumeStake with `accepted`). In this component's memory only, never stored. */
  const [moved, setMoved] = useState<(QuoteMove & { id: string }) | null>(null);
  /** The last flow held a sale of TAO to USDC by the price check (flows.ts, saleFloor): the TAO can
   * still be claimed or kept as TAO, which no check holds. */
  const [saleHeld, setSaleHeld] = useState(false);
  const guard = appGuard;
  useEffect(() => appGuard.subscribe(setBusy), []);

  const a = account as Address;
  const d = () => data.deployment;
  const port = () => wagmiPort(config, a, data.clients.base);
  // the actions are off while the contracts don't match (wiring.ts); while they can't be checked, a
  // click checks again and sends nothing unless they then check out (assertWired, in flow)
  const wiring = useWiring(account !== null);
  const blocked = wiringNotice(wiring);

  /** Runs `body` under the guard (claimed before any read), any flow but the ways out only once the
   * contracts check out (nothing is read for, recorded or sent before that; needsWiring), records errors
   * and refreshes the data. */
  async function flow<T>(label: string, body: () => Promise<T>): Promise<T> {
    if (!account) throw new Error("Connect a wallet first");
    setError(null);
    setMoved(null);
    setSaleHeld(false);
    try {
      return await guard.run(label, async () => {
        if (needsWiring(label)) await assertWired(() => data.checkWiring());
        return body();
      });
    } catch (e) {
      setError(userMessage(e));
      if (e instanceof SaleRefusedError) setSaleHeld(true);
      throw e;
    } finally {
      void queryClient.invalidateQueries({ queryKey: cascadeKeys.all() });
      void queryClient.invalidateQueries({ queryKey: ["quote"] });
      // the contracts are read again after each flow, so the next one goes by a fresh answer
      data.forgetWiring();
      void queryClient.invalidateQueries({ queryKey: ["wiring"] });
    }
  }

  /** Sends `calls` for the operation `id`, marked as running in this tab while it does. A read that
   * fails before sending leaves the operation waiting for the user, not stuck as "running"; a stop of
   * our own before sending (a declined signature, a stake that can't go through) keeps its words. */
  async function send(id: string, build: (wallet: WalletPort, store: FlowStore) => Promise<FlowCall[]>) {
    const store = opStore(data.opLog, a, id);
    const wallet = port();
    data.opLog.markActive(id);
    try {
      let calls: FlowCall[];
      try {
        calls = await build(wallet, store);
      } catch (e) {
        if (e instanceof FlowError) store.setState(e.state, e.message);
        else store.setState("needs-you", "We couldn't read your wallet just now. Continue to try again.");
        throw e;
      }
      if (calls.length === 0) {
        store.setState("sent");
        return;
      }
      await runFlow(wallet, store, calls);
    } finally {
      data.opLog.markInactive(id);
    }
  }

  /** The oracle's price, for the check every stake makes of its quote (flows.ts, assertPriceAgrees). */
  const oracle = () => readOraclePrice(data.clients, d());
  /** The same for a sale of TAO on the ways out (flows.ts, saleFloor); v2 has no oracle and sells unchecked. */
  const saleOracle = () => (isV3(d()) ? oracle : undefined);
  /** The floor of a sale of `taoWei` to USDC at today's price, once it checks out against the oracle. */
  const sale = (taoWei: bigint) => saleFloor({ taoWei, quote: () => quoteSell(data.clients, taoWei), oracle: saleOracle() });

  return {
    busy,
    error,
    /** A stake being carried on (`id`) whose quote moved since the user last saw a figure: the figures,
     * for a button that continues at today's price (resumeStake(id, moved.nowTao)). Null otherwise. */
    moved,
    /** The last flow held a sale of TAO to USDC (the price check: flows.error says why): offer the TAO
     * instead (claim(ids, true)), which is always available. */
    saleHeld,
    /** Why no stake or unstake can be sent from this site (the contracts don't match), or null. */
    blocked,
    /** No stake or unstake can start: a flow is running, or the contracts don't match (the ways out use busy alone). */
    locked: busy !== null || blocked !== null,

    /** Starts a stake from a quote; `onStart` gets the operation id before the first wallet prompt. On
     * v3 it is one CascadeStaker transaction, paid by a USDC permit or, failing that, an exact approval,
     * once the quote checks out against the oracle (planStakeV3). */
    stake: (q: DepositQuote, onStart?: (id: string) => void) =>
      flow("stake", async () => {
        const v3 = isV3(d());
        const op: DepositOp = {
          id: newOpId(),
          kind: "deposit",
          account: a,
          createdAt: Date.now(),
          usdcIn: q.usdcIn,
          targetTao: q.targetTao,
          priceUsd: q.taoPriceUsd,
          feesUsd: q.feesUsd,
          ...(v3 ? { v: 3 as const, minTaoOut: q.minTaoOut } : {}),
          hashes: {},
          state: "running",
        };
        data.opLog.put(op);
        onStart?.(op.id);
        await send(op.id, async (wallet) => {
          const w = await data.getBalances(a);
          if (!v3) return stakeCalls(q, w, d(), a);
          return planStakeV3(wallet, {
            q,
            w,
            d: d(),
            account: a,
            nonce: () => readPermitNonce(data.clients, a),
            now: Date.now(),
            oracle,
            minUsd: () => data.getLimits().then((l) => l.minUsd),
          });
        });
        return op.id;
      }),

    /** Carries on a stake that stopped, skipping whatever the chain shows already happened. A stake
     * whose swap (v3: its one transaction) the chain already shows is adopted or waited for, not sent
     * again. One not yet sent goes at today's terms, never the recorded ones (flows.ts, freshStakeTerms):
     * quoted again as a fresh stake is, and if the figure moved from the one the user saw (`accepted`
     * when they have since agreed to today's), it stops and asks them (`moved`), sending nothing. */
    resumeStake: (id: string, accepted?: bigint) =>
      flow("stake", async () => {
        const stored = data.opLog.get(a, id) as DepositOp;
        const patch = stored.v === 3 ? {} : retryPatch(stored);
        if (Object.keys(patch).length > 0) data.opLog.update(a, id, patch as Partial<Operation>);
        try {
          await send(id, async (_wallet, store) => {
            const op = data.opLog.get(a, id) as DepositOp;
            const quote = () => data.quoteDeposit(op.usdcIn);
            const record = (terms: Partial<DepositOp>) => data.opLog.update(a, id, terms);
            if (op.v === 3) {
              // stakes other records of this browser already own are never adopted for this one
              const owned = new Set(
                data.opLog
                  .list(a)
                  .filter((o): o is DepositOp => o.kind === "deposit" && o.id !== id)
                  .flatMap((o) => Object.values(o.hashes).filter((h): h is Hex => !!h)),
              );
              return planResumeStakeV3({
                op,
                w: await data.getBalances(a),
                d: d(),
                account: a,
                now: Date.now(),
                findStake: () => findStakeTx(data.clients, d(), { account: a, usdcIn: op.usdcIn, createdAtMs: op.createdAt, nowMs: Date.now(), skip: owned }),
                adopt: (hash) => store.setHash("stake", hash),
                quote,
                accepted,
                oracle,
                record,
              });
            }
            // v2, or a deposit of wallet TAO: what the chain shows done is never sent again (a deposit whose
            // hash was lost to a reload included); a v2 swap not yet sent goes at today's terms (v2 has no
            // oracle to check them against)
            const [w, fd] = await Promise.all([data.getBalances(a), readFrontDoor(data.clients, d(), a)]);
            return planResumeDeposit({ op, w, d: d(), account: a, now: Date.now(), chain: { walletTao: w.tao, depositOf: fd.depositOf }, quote, accepted, record });
          });
        } catch (e) {
          if (e instanceof QuoteMovedError) setMoved({ id, ...e.move });
          throw e;
        }
      }),

    /** Deposits TAO already sitting in the wallet (left by a cancel, a claim kept as TAO, a failed step),
     * recorded at the TAO price read at the click (or none, when it can't be read). */
    depositWalletTao: (taoWei: bigint, onStart?: (id: string) => void) =>
      flow("stake", async () => {
        const op = await walletTaoDepositOp({ id: newOpId(), account: a, taoWei, now: Date.now(), price: () => taoPriceUsd(data.clients) });
        data.opLog.put(op);
        onStart?.(op.id);
        await send(op.id, async () => depositTaoCalls(op.targetTao, await data.getBalances(a), d()));
        return op.id;
      }),

    /** Swaps TAO sitting in the wallet back to USDC (0.5% slippage), once today's sale price checks out
     * against the oracle; held, with the TAO staying in the wallet, when it doesn't. */
    sellWalletTao: (taoWei: bigint) =>
      flow("swap", async () => {
        const [w, minUsdc] = await Promise.all([data.getBalances(a), sale(taoWei)]);
        await runFlow(port(), scratchStore(), sellTaoCalls(taoWei, minUsdc, w, a));
      }),

    unstake: (q: WithdrawalQuote, onStart?: (id: string) => void) =>
      flow("unstake", async () => {
        const v3 = isV3(d());
        const op: WithdrawalOp = {
          id: newOpId(),
          kind: "withdrawal",
          account: a,
          createdAt: Date.now(),
          shares: q.shares,
          taoEstimate: q.taoWei,
          usdcEstimate: BigInt(Math.floor(q.usdcAmount * 1e6)),
          fee: q.fee,
          ...(v3 ? { delivery: { minUsdcPerTao: q.minUsdcPerTao, deadline: q.deliveryDeadline } } : {}),
          state: "running",
        };
        data.opLog.put(op);
        onStart?.(op.id);
        await send(op.id, () =>
          planUnstake({
            q,
            d: d(),
            v3,
            frontDoor: () => readFrontDoor(data.clients, d(), a),
            accountCode: () => data.clients.base.getCode({ address: a }),
            pendingNonce: () => data.clients.base.getTransactionCount({ address: a, blockTag: "pending" }),
            record: (patch) => data.opLog.update(a, op.id, patch),
          }),
        );
        return op.id;
      }),

    /** Claims what is back on Base for the given unstakes and, unless `keepTao`, swaps it to USDC. The
     * swap's floor is today's price, checked against the oracle first; a claim kept as TAO is never
     * held by that check, so the way out stays open whatever the price. */
    claim: (withdrawalIds: string[], keepTao: boolean) =>
      flow("claim", async () => {
        const fd = await readFrontDoor(data.clients, d(), a);
        if (fd.claimable === 0n) throw new FlowError("Nothing is waiting to be claimed yet", "needs-you");
        const minUsdc = keepTao ? 0n : await sale(fd.claimable);
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

    /** Carries on a claim that stopped (usually the swap after the claim went through). A claim Base
     * doesn't show going through (a wallet batch that failed whole) is sent again with the rest, one
     * step at a time; the swap is priced again either way. */
    resumeClaim: (withdrawalId: string) =>
      flow("claim", async () => {
        const op = data.opLog
          .list(a)
          .find((o): o is ClaimOp => o.kind === "claim" && (o.withdrawalIds ?? []).includes(withdrawalId));
        if (!op) throw new FlowError("There is no claim to continue for this unstake", "needs-you");
        data.opLog.update(a, op.id, claimRetryPatch(op, await claimWentThrough(data.clients, op)));
        await send(op.id, async () => {
          const w = await data.getBalances(a);
          if (op.keepTao) return claimCalls(op.amount, 0n, w, d(), a, true);
          // what the claim paid (or pays), swapped at today's price, once that checks out against the oracle
          const minUsdc = await sale(op.amount);
          data.opLog.update(a, op.id, { minUsdc });
          return claimCalls(op.amount, minUsdc, w, d(), a, false);
        });
      }),

    /** Drops an entry that never sent a transaction from this browser's list; false (and kept) if it
     * sent something or is running in this tab. */
    remove(id: string): boolean {
      const removed = data.opLog.removeUnsent(a, id);
      if (!removed) setError("This one has started sending, so it stays in your activity");
      void queryClient.invalidateQueries({ queryKey: cascadeKeys.all() });
      return removed;
    },

    /** Takes an entry back out of the open batch, recorded on that entry as soon as the wallet sends it. */
    cancel: (kind: "deposit" | "withdrawal", id: string, amount: bigint) =>
      flow("cancel", () => runFlow(port(), cancelStore(data.opLog, a, id), [cancelCall(kind, amount, d())])),

    /** Send it now: the open batch `batchId` (the one the user saw) on its way, closeBatch paying its bridge
     * fee plus 30% (the front door refunds the rest). Only once the contracts check out; the batch is read
     * again and the call run from the account first (planSendNow), and nothing is sent if it moved on.
     * Recorded before the wallet is asked, so a reload shows it as sending. Resolves with what the send
     * did and paid toward the fee, from its receipt, when that can be read: the batch meant, the one after
     * it (that one had already left), or only a roll of an empty batch (everything sent came back). */
    sendNow: (batchId: bigint) =>
      flow("send", async (): Promise<{ outcome?: "sent" | "other" | "rolled"; paidWei?: bigint; ethPriceUsd?: number }> => {
        const wallet = port();
        const { call, batch } = await planSendNow({ d: d(), batchId, read: () => data.getOpenBatch(a), simulate: (c) => wallet.simulate(c) });
        const op: CloseOp = {
          id: newOpId(),
          kind: "close",
          account: a,
          createdAt: Date.now(),
          batchId,
          value: call.value ?? 0n,
          hashes: {},
          state: "running",
        };
        data.opLog.put(op);
        await send(op.id, async () => [call]);
        const hash = (data.opLog.get(a, op.id) as CloseOp | null)?.hashes.close;
        const outcome = hash ? await readCloseOutcome(data.clients, d(), hash, batchId) : undefined;
        return {
          ...(outcome ? { outcome: outcome.kind } : {}),
          // the bridge fee less what the batch's pot paid of it
          ...(outcome && outcome.kind !== "rolled" ? { paidWei: outcome.feeWei - outcome.potUsedWei } : {}),
          ...(batch.ethPriceUsd !== undefined ? { ethPriceUsd: batch.ethPriceUsd } : {}),
        };
      }),
  };
}
