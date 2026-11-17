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
import { isV3, isV32 } from "./config";
import { useCascadeData } from "./context";
import { usdcUnstakeChecks } from "./delivery-limit";
import { cancelTook, claimWentThrough, findStakeTx } from "./facts";
import {
  assertPriceAgrees,
  assertRedeemListOpen,
  assertSiteAllows,
  assertStakeFunded,
  cancelCall,
  cancelConfirmed,
  cancelOutcomeNote,
  claimCalls,
  claimRetryPatch,
  clearDeliveryCall,
  closeFirst,
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
  planCancelDeposit,
  planCloseFirst,
  planSendNow,
  planStakeV3,
  planUnstake,
  type Replacement,
  retryPatch,
  revertArgs,
  revertReason,
  runFlow,
  sellTaoCalls,
  splitSignature,
  userMessage,
  walletTaoDepositOp,
  stakeCalls,
  type WalletPort,
  whenWired,
  wiringNotice,
} from "./flows";
import { changedByFlow, useWiring } from "./hooks";
import { impactRefusal } from "./impact";
import { cancelStore, opStore, scratchStore, settleCancel } from "./op-store";
import { type ClaimOp, type CloseOp, type DepositOp, newOpId, type Operation, type WithdrawalOp } from "./oplog";
import { liveVetoDeps, outsidePriceVeto } from "./price-veto";
import { quoteSell, readCancelState, readCloseOutcome, readFrontDoor, readOraclePrice, readPermitNonce, readRedeemList, taoPriceUsd } from "./reads";
import type { DepositQuote, WithdrawalQuote } from "./types";
import { stakeRoom } from "../stake-form";

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
        const args = revertArgs(e);
        return { ok: false, ...(revert !== undefined ? { revert } : {}), ...(args !== undefined ? { args } : {}) };
      }
    },
  };
}

/** The app's one flow lock: a claim can't start while a stake waits in the wallet, and so on. The emergency page on
 * Bittensor takes it too (use-direct-exit.ts): one wallet prompt at a time, on one chain. */
export const appGuard = createSharedFlowGuard();

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
  // click checks again and sends nothing unless they then check out (flows.ts whenWired, in flow)
  const wiring = useWiring(account !== null);
  const blocked = wiringNotice(wiring);

  /** Runs `body` under the guard (claimed before any read), any flow but the ways out only once the
   * contracts check out (nothing is read for, recorded or sent before that; flows.ts whenWired), records
   * errors and refreshes the data. */
  async function flow<T>(label: string, body: () => Promise<T>): Promise<T> {
    if (!account) throw new Error("Connect a wallet first");
    setError(null);
    setMoved(null);
    setSaleHeld(false);
    try {
      return await guard.run(label, () => whenWired(label, () => data.checkWiring(), body));
    } catch (e) {
      setError(userMessage(e));
      if (e instanceof SaleRefusedError) setSaleHeld(true);
      throw e;
    } finally {
      // everything a flow may have changed is read again; not the 30-day yield, which none changes (hooks.ts)
      void queryClient.invalidateQueries(changedByFlow());
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
  /** v3.2's outside-price veto before a stake or a USDC unstake (price-veto.ts): the Base pools against the indexer's
   * outside reference, refusing only. Undefined on every other deployment, whose flows are as they were. */
  const priceVeto = () => outsidePriceVeto(d(), liveVetoDeps(d(), data.clients));
  /** The founder's switches (deployments.json; Task 60), asked before a flow reads or records anything: a retired
   * deployment takes no stake, and USDC delivery off no way to USDC (flows.ts assertSiteAllows). */
  const allows = (what: "stake" | "usdc") => assertSiteAllows(what, { stage: data.stage, usdcDelivery: data.usdcDelivery });

  /** A stake from quote `q`, recorded before the first wallet prompt (`onStart` gets its id), inside a flow: on v3 one
   * CascadeStaker transaction, paid by a USDC permit or an exact approval, once the quote checks out (planStakeV3). */
  async function stakeIn(q: DepositQuote, onStart?: (id: string) => void): Promise<string> {
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
        veto: priceVeto()?.stake,
      });
    });
    return op.id;
  }

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
     * once the quote checks out against the oracle (planStakeV3). On v3.2 a quote that moves the price by more than
     * 3% is refused first (impact.ts), before it is recorded: the form already says so and holds its button. */
    stake: (q: DepositQuote, onStart?: (id: string) => void) =>
      flow("stake", async () => {
        allows("stake");
        const overCap = impactRefusal(q);
        if (overCap) throw new FlowError(overCap, "needs-you");
        return stakeIn(q, onStart);
      }),

    /** v3.2 (R8, the contracts review's L-1): "send the batch, then stake", for a stake the full open batch has no room
     * for that fits once it has left (stake-form.ts closeFirstNeeded). The close first (flows.ts planCloseFirst and
     * closeFirst: closeBatch(the open id, a total still full for a full batch, R12c, at its highest line, R12e, or its
     * deposits as read for one due by time), its bridge fee paid from the batch's pot first and the rest by the account,
     * recorded as a send so Activity shows it), then the stake as `stake` makes it. A close a cancel under that
     * beat (BatchTooSmall) or another close beat, as its simulation says or on chain, goes straight on to the stake once
     * the room, read again, fits it. One flow, under the one lock: nothing else starts in between. R9 (M-1): every check
     * that can refuse the stake runs before the close is paid for: the impact cap, the oracle's check of the quote, the
     * outside-price veto, the wallet's USDC (the stake's own run from the account can't go first: the full batch refuses
     * it), each again in stakeIn after the close. R9 (L-1): the room is read at the click first (a stake that fits now goes
     * with no close; one that wouldn't fit even after it is refused), and only `batchId`, the batch the form's note was
     * priced from, is ever closed. R10 (M-1): that read's own limits enforce the clock, never the form's cached reading:
     * a close is paid for only while they still find `batchId` closable for CLOSE_FIRST_SEEN_MS (flows.ts closeFirst). */
    closeThenStake: (q: DepositQuote, batchId: bigint, onStart?: (id: string) => void) =>
      flow("stake", async () => {
        allows("stake");
        const overCap = impactRefusal(q);
        if (overCap) throw new FlowError(overCap, "needs-you");
        await assertPriceAgrees(q, oracle);
        await priceVeto()?.stake();
        assertStakeFunded(q, await data.getBalances(a));
        const wallet = port();
        await closeFirst({
          batchId,
          room: async () => {
            const limits = await data.getLimits();
            return { room: stakeRoom(q.amountUsd, limits), limits };
          },
          plan: () => planCloseFirst({ d: d(), batchId, read: () => data.getOpenBatch(a), simulate: (c) => wallet.simulate(c) }),
          sendClose: async (call, batch) => {
            const op: CloseOp = { id: newOpId(), kind: "close", account: a, createdAt: Date.now(), batchId: batch.id, value: call.value ?? 0n, hashes: {}, state: "running" };
            data.opLog.put(op);
            try {
              await send(op.id, async () => [call]);
              return "landed";
            } catch (e) {
              // mined and reverted (or replaced in the wallet): its record says so; the room decides what follows
              const sent = (data.opLog.get(a, op.id) as CloseOp | null)?.hashes.close;
              if (e instanceof FlowError && e.state === "failed" && sent) return "reverted";
              throw e;
            }
          },
        });
        return stakeIn(q, onStart);
      }),

    /** Carries on a stake that stopped, skipping whatever the chain shows already happened. A stake
     * whose swap (v3: its one transaction) the chain already shows is adopted or waited for, not sent
     * again. One not yet sent goes at today's terms, never the recorded ones (flows.ts, freshStakeTerms):
     * quoted again as a fresh stake is, and if the figure moved from the one the user saw (`accepted`
     * when they have since agreed to today's), it stops and asks them (`moved`), sending nothing. */
    resumeStake: (id: string, accepted?: bigint) =>
      flow("stake", async () => {
        allows("stake");
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
                veto: priceVeto()?.stake,
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
        allows("stake");
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
        allows("usdc");
        const [w, minUsdc] = await Promise.all([data.getBalances(a), sale(taoWei)]);
        await runFlow(port(), scratchStore(), sellTaoCalls(taoWei, minUsdc, w, a));
      }),

    /** Asks for an unstake (on v3 with a USDC delivery preference, planUnstake). Its checks come first, before the
     * request is recorded (delivery-limit.ts usdcUnstakeChecks): on v3.2 its sale's price impact within the cap, its own
     * sale (with everything of the account's waiting) clearing at the minimum it sends, read fresh at the click
     * (deliveryRefusal), then the outside-price veto. An unstake has nothing to continue, so a refused one leaves
     * nothing in Activity, only the form's message, which points to receiving TAO (receiveTao), open whatever held this
     * one. The checks refuse or allow; none changes what is sent. */
    unstake: (q: WithdrawalQuote, onStart?: (id: string) => void) =>
      flow("unstake", async () => {
        allows("usdc");
        await usdcUnstakeChecks({
          v32: isV32(d()),
          q,
          deliverable: () => data.deliveryRefusal(a, q),
          veto: priceVeto()?.unstake,
        });
        // R12b (ChatGPT r3 §2): a request that would close a full redeem list on a pot short of its bridge fee; R12d (M2): the
        // list read first, the batch and its fee only for a full one with none of the account's in it
        await assertRedeemListOpen(d(), { list: () => readRedeemList(data.clients, d(), a), batch: () => data.getOpenBatch(a) });
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

    /** v3.2's Receive TAO: asks for an unstake of `shares` (worth `taoWei` now) paid out as TAO on Base, claimed by
     * hand (planUnstake with keepTao: flows.ts receiveTaoCall, which also clears the account's USDC delivery
     * preference). Nothing is sold, so nothing price-bound holds it: it is open whenever a request can be made, while
     * the outside-price veto refuses, the indexer is down, or the sale would be over the USDC delivery limit or the
     * impact cap. Recorded before the wallet is asked, as an unstake is. */
    receiveTao: (x: { shares: bigint; taoWei: bigint }, onStart?: (id: string) => void) =>
      flow("unstake", async () => {
        // R12b (ChatGPT r3 §2): as an unstake, never a request that would close a full list on a short pot
        await assertRedeemListOpen(d(), { list: () => readRedeemList(data.clients, d(), a), batch: () => data.getOpenBatch(a) });
        const op: WithdrawalOp = {
          id: newOpId(),
          kind: "withdrawal",
          account: a,
          createdAt: Date.now(),
          shares: x.shares,
          taoEstimate: x.taoWei,
          usdcEstimate: 0n,
          fee: 0n,
          keepTao: true,
          state: "running",
        };
        data.opLog.put(op);
        onStart?.(op.id);
        await send(op.id, () =>
          planUnstake({
            q: { shares: x.shares, minUsdcPerTao: 0n, deliveryDeadline: 0 },
            d: d(),
            v3: true,
            keepTao: true,
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
        // a claim kept as TAO is always open; one sold to USDC only while USDC delivery is on
        if (!keepTao) allows("usdc");
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
        // carrying on a claim sold to USDC sells it: refused while USDC delivery is off (claim it as TAO instead)
        if (!op.keepTao) allows("usdc");
        data.opLog.update(a, op.id, claimRetryPatch(op, await claimWentThrough(data.clients, d(), op)));
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
      void queryClient.invalidateQueries(changedByFlow());
      return removed;
    },

    /** v3.2 with USDC delivery off (Task 60 follow-up): clears the account's USDC delivery preference at once
     * (flows.ts clearDeliveryCall, setDelivery(0, 0, 0) to the deployment's front door), whether or not anything is
     * claimable yet, so a payout on its way is claimed by hand, never sold. It moves nothing, so no switch holds it, and
     * it is a way out (flows.ts EXITS): it never waits for the wiring check, so it works when a stolen key has disabled
     * a bridge or removed the door, or an RPC can't be read (Task 60 review, Important 1). The reads after it show it
     * gone. */
    turnOffDelivery: () =>
      flow("delivery", async () => {
        await runFlow(port(), scratchStore(), [clearDeliveryCall(d())]);
      }),

    /** Takes an entry back out of the open batch, recorded on that entry as soon as the wallet sends it. On v3.2 a deposit's
     * cancel is checked first (flows.ts planCancelDeposit, R11): its batch `batchId` still open with the account's deposit
     * in it, else "your deposit has left"; then the five-minute cooldown, else when it opens; then run from the account.
     * R12d (M2): by its own small read (reads.ts readCancelState, one multicall), never the open batch's whole read, which
     * waits on fee quotes, prices, a log scan and Bittensor while the app's one flow lock is held. A read that fails, or a
     * check that takes longer than CANCEL_CHECK_MS, holds nothing: the cancel is a way out. R12e: such a cancel, sent
     * without its check, is read again once it lands, and the batch it came out of said when it isn't this deposit's
     * (flows.ts cancelOutcomeNote: the receipt's batch may have left, and the cancel then took from the account's entry in
     * the batch open then). Every cancel that went through is read back once, from its own receipt (flows.ts
     * cancelConfirmed), and its record settled by it (op-store.ts settleCancel): one that took this record out of its
     * batch is marked confirmed, so its receipt page shows it cancelled at once, before any read of the chain has caught
     * up (cancel-sent.ts); one that didn't has its mark taken back, as one that failed has (cancelStore), so the cancel is
     * offered again at once; one Base can't show yet stays on its way. */
    cancel: (kind: "deposit" | "withdrawal", id: string, amount: bigint, batchId?: bigint) =>
      flow("cancel", async () => {
        const wallet = port();
        let unchecked = false;
        const c =
          kind === "deposit"
            ? await planCancelDeposit({
                d: d(),
                amount,
                ...(batchId !== undefined ? { batchId } : {}),
                read: () => readCancelState(data.clients, d(), a),
                simulate: (x) => wallet.simulate(x),
                unchecked: () => {
                  unchecked = true;
                },
              })
            : cancelCall(kind, amount, d());
        const store = cancelStore(data.opLog, a, id);
        await runFlow(wallet, store, [c]);
        // the batch the cancel came out of, from its own receipt, and the cancel that receipt was read for (the record's
        // mark at that read: another tab's cancel may replace it meanwhile, and is never settled by this one's receipt)
        const read: { hash?: Hex } = {};
        const outcome = await cancelConfirmed(async () => {
          const op = data.opLog.get(a, id);
          if (op?.kind !== "deposit" && op?.kind !== "withdrawal") return undefined;
          read.hash = op.cancelled?.hash;
          return cancelTook(data.clients, d(), op, batchId);
        });
        // a deposit's cancel sent unchecked says which batch it came out of, from that same reading
        const took = async () => outcome;
        const note = await cancelOutcomeNote({ unchecked, took });
        if (note) setError(note);
        settleCancel(store, data.opLog, a, id, read.hash, outcome);
      }),

    /** Send it now: the open batch `batchId` (the one the user saw) on its way, closeBatch paying its bridge
     * fee plus 30% (the front door refunds the rest). Only once the contracts check out; the batch is read
     * again and the call run from the account first (planSendNow), and nothing is sent if it moved on. On
     * v3.2 the call itself names that batch and the account's deposit in it as the user saw it (`depositWei`),
     * so the front door refuses it if the batch left or changed in the meantime, never sending another.
     * Recorded before the wallet is asked, so a reload shows it as sending. Resolves with what the send
     * did and paid toward the fee, from its receipt, when that can be read: the batch meant, the one after
     * it (that one had already left), or only a roll of an empty batch (everything sent came back). */
    sendNow: (batchId: bigint, depositWei: bigint) =>
      flow("send", async (): Promise<{ outcome?: "sent" | "other" | "rolled"; paidWei?: bigint; ethPriceUsd?: number }> => {
        const wallet = port();
        const { call, batch } = await planSendNow({
          d: d(),
          batchId,
          depositWei,
          read: () => data.getOpenBatch(a),
          simulate: (c) => wallet.simulate(c),
          retired: data.stage === "retired",
        });
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
