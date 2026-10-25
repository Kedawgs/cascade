import type { Hex } from "viem";
import { explorer } from "./config";
import type { DepositOp, WithdrawalOp } from "./oplog";
import type { DepositRecord, DepositStepKey, StepStatus, TrailStep, WithdrawalRecord, WithdrawalStepKey } from "./records";
import { formatTao } from "../format";
import { toDisplay } from "./units";

/** What the chain says about one deposit (see facts.ts). */
export interface DepositFacts {
  swapMined: boolean;
  depositMined: boolean;
  /** The cancel (taking it back out of the open batch) went through. */
  cancelMined?: boolean;
  /** USDC the swap really took (its receipt), when known. */
  usdcSpent?: bigint;
  now: Date;
  openBatchId: bigint;
  /** When the open batch can close. */
  closesAt: Date;
  /** The deposit's batch is still the open one. */
  stillOpen: boolean;
  delivered?: { at: Date; txHash: Hex; messageId?: Hex; outcome: "deposited" | "bounced" | "skipped" };
  staked?: { at: Date; txHash: Hex };
  /** In the vault but not staked yet, because one position must reach the 0.02-TAO nominator minimum. */
  waitingForMinimum: boolean;
  /** TAO the vault has toward that minimum (staked plus idle), and the minimum itself. */
  vaultWei?: bigint;
  minimumWei?: bigint;
  /** TAO from this account's other deposits made and not yet delivered. */
  incomingWei?: bigint;
  /** Stored as running but not running in this tab: its wallet prompt may still be open somewhere. */
  interrupted?: boolean;
  /** When the deposit's batch left Base, if known. */
  sentAt?: Date;
  /** When the deposit was made (its receipt's block), and where the batch can be watched on the bridge. */
  depositedAt?: Date;
  watchUrl?: string;
}

export interface WithdrawalFacts {
  requestMined: boolean;
  cancelMined?: boolean;
  now: Date;
  /** When the unstake was asked for, when its batch left Base (if known), and where to watch the bridge. */
  requestedAt?: Date;
  sentAt?: Date;
  watchUrl?: string;
  openBatchId: bigint;
  closesAt: Date;
  stillOpen: boolean;
  delivered?: { at: Date; txHash: Hex; outcome: "redeemed" | "skipped" | "deferred"; taoWei?: bigint };
  payout?: { txHash: Hex; messageId?: Hex; state: 0 | 1 | 2 | 3; at: Date };
  claimable: bigint;
  /** The claim's receipts: TAO claimed, the USDC the swap paid (if it ran), and whether it was kept as TAO
   * or the swap failed after the claim (the TAO then sits in the wallet). */
  claimed?: { hash: Hex; at: Date; taoClaimed: bigint; usdcOut?: bigint; keptTao: boolean; swapFailed: boolean };
  payoutDelay: number;
}

/** A time of day in the viewer's own zone, like the dates elsewhere on the site: "2:32 PM". */
const timeOfDay = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const hhmm = (d: Date) => timeOfDay.format(d);
const BRIDGE_TIME = "usually 20–30 minutes";
/** An interrupted flow this old has no wallet prompt still waiting on it. */
const STALE_MS = 10 * 60_000;

/** Delivered but not staked: Bittensor stakes a position only from 0.02 TAO, so it waits for more deposits. */
const STEP = 10n ** 14n; // 0.0001 TAO, the smallest amount these messages show
const down = (wei: bigint) => formatTao(Number(wei / STEP) / 1e4, 4);
const up = (wei: bigint) => formatTao(Number((wei + STEP - 1n) / STEP) / 1e4, 4);

function waitingForMinimum(f: { vaultWei?: bigint; minimumWei?: bigint; incomingWei?: bigint }): Pick<TrailStep, "status" | "detail" | "summary"> {
  const min = f.minimumWei ?? 2n * 10n ** 16n;
  const minTao = String(toDisplay(min, 18));
  const incoming = f.incomingWei ?? 0n;
  let sofar = "";
  if (f.vaultWei !== undefined && f.vaultWei < min) {
    if (incoming > 0n && f.vaultWei + incoming >= min)
      sofar = ` The vault holds ${down(f.vaultWei)} TAO so far, and your ${down(incoming)} TAO deposit on its way takes it past that: it is staked once that one lands. Nothing for you to do.`;
    else if (incoming > 0n)
      sofar = ` The vault holds ${down(f.vaultWei)} TAO so far; with your ${down(incoming)} TAO deposit on its way, it is staked once ${up(min - f.vaultWei - incoming)} TAO more arrives, from you or anyone else.`;
    else sofar = ` The vault holds ${down(f.vaultWei)} TAO so far; it is staked once ${up(min - f.vaultWei)} TAO more arrives, from you or anyone else.`;
  }
  return {
    status: "active",
    summary: `waiting for the ${minTao} TAO minimum`,
    detail: `Waiting for the ${minTao} TAO minimum: Bittensor only stakes ${minTao} TAO or more.${sofar} Until then your TAO is safe in the vault and counted as yours, but not earning yet`,
  };
}

/** Chainlink's usual Base → Bittensor delivery time. */
const BRIDGE_MS = 20 * 60_000;

/** On the bridge: how long so far, what it is waiting for, and when it should arrive. */
function onTheBridge(f: { now: Date; sentAt?: Date }, since?: { verb: string; at: Date }): string {
  const mins = since ? Math.max(0, Math.round((f.now.getTime() - since.at.getTime()) / 60_000)) : undefined;
  const so_far = since && mins !== undefined ? ` (${since.verb} ${mins} minute${mins === 1 ? "" : "s"} ago)` : "";
  const eta = f.sentAt ? new Date(f.sentAt.getTime() + BRIDGE_MS) : undefined;
  const when = !eta
    ? ""
    : eta.getTime() > f.now.getTime()
      ? `, expected around ${hhmm(eta)}`
      : `; Chainlink's estimate was ${hhmm(eta)}, so it should land any minute`;
  return `On the bridge to Bittensor${so_far}. Chainlink waits for Base to finalize the batch (about 15–25 minutes), then delivers it on Bittensor${when}`;
}

/** Before the batch closes: its time, or that it can close now once that time has passed. */
const waitForClose = (f: { closesAt: Date; now: Date }) =>
  f.closesAt.getTime() <= f.now.getTime()
    ? "The batch can close now; it crosses as soon as it is sent"
    : `Waits for the batch to close at ${hhmm(f.closesAt)}`;

function overall<K extends string>(steps: TrailStep<K>[], doneStatus: string): "failed" | "needs_you" | "done" | "in_progress" {
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "action")) return "needs_you";
  return steps.every((s) => s.status === "done") ? (doneStatus as "done") : "in_progress";
}

/** The status of a wallet step: done once mined, otherwise whatever the operation says. */
function walletStep(mined: boolean, op: { state: string }, started: boolean): StepStatus {
  if (mined) return "done";
  if (op.state === "failed") return "failed";
  if (op.state === "needs-you") return "action";
  return started ? "active" : "pending";
}

export function depositRecord(op: DepositOp, f: DepositFacts): DepositRecord {
  const swapStatus = walletStep(f.swapMined, op, true);
  const swap: TrailStep<DepositStepKey> = {
    key: "swap",
    title: "Swap USDC for TAO",
    status: swapStatus,
    ...(op.hashes.swap && f.swapMined ? { txUrl: explorer.baseTx(op.hashes.swap) } : {}),
    ...(!f.swapMined && op.callsId && swapStatus === "active" ? { detail: "Sent from your wallet as one batch" } : {}),
    ...(swapStatus === "failed" || swapStatus === "action" ? { detail: op.error ?? "Waiting for you to confirm in your wallet" } : {}),
  };
  const depositStatus = f.swapMined ? walletStep(f.depositMined, op, true) : "pending";
  // the swap went through but the deposit did not: the TAO is sitting in the wallet
  const taoInWallet = " Your TAO is in your wallet: deposit it or swap it back to USDC from the Stake page.";
  const deposit: TrailStep<DepositStepKey> = {
    key: "deposit",
    title: "Deposit into Cascade",
    status: depositStatus,
    ...(op.hashes.deposit && f.depositMined ? { txUrl: explorer.baseTx(op.hashes.deposit) } : {}),
    ...(depositStatus === "action" ? { detail: op.error ?? "Waiting for you to confirm in your wallet" } : {}),
    ...(depositStatus === "failed" ? { detail: `${op.error ?? "The deposit didn't go through."}${taoInWallet}` } : {}),
  };

  let bridge: TrailStep<DepositStepKey> = { key: "bridge", title: "Cross to Bittensor", status: "pending" };
  if (f.delivered) {
    const d = f.delivered;
    if (d.outcome === "deposited") {
      bridge = { ...bridge, status: "done", at: d.at, txUrl: explorer.bittensorTx(d.txHash), txLabel: "View on Bittensor" };
    } else {
      bridge = {
        ...bridge,
        status: "failed",
        at: d.at,
        txUrl: explorer.bittensorTx(d.txHash),
        txLabel: "View on Bittensor",
        detail:
          d.outcome === "bounced"
            ? "The vault couldn't accept this deposit safely just then, so it sent it back. It returns to Base, where you can claim it as USDC from the Stake page"
            : "The vault skipped this deposit; the TAO stays in the vault",
      };
    }
  } else if (op.cancelled && f.cancelMined) {
    bridge = { ...bridge, status: "failed", at: new Date(op.cancelled.at), detail: "Cancelled. Your TAO is back in your wallet", txUrl: explorer.baseTx(op.cancelled.hash) };
  } else if (f.depositMined) {
    bridge = {
      ...bridge,
      status: "active",
      detail: f.stillOpen
        ? `${waitForClose(f)}, then the bridge (${BRIDGE_TIME})`
        : onTheBridge(f, f.depositedAt ? { verb: "deposited", at: f.depositedAt } : undefined),
      ...(!f.stillOpen && f.watchUrl ? { txUrl: f.watchUrl, txLabel: "Watch it on Chainlink's explorer" } : {}),
    };
  }

  let stake: TrailStep<DepositStepKey> = { key: "stake", title: "Stake on Bittensor", status: "pending" };
  if (f.delivered?.outcome === "deposited") {
    if (f.staked) stake = { ...stake, status: "done", at: f.staked.at, txUrl: explorer.bittensorTx(f.staked.txHash), txLabel: "View on Bittensor" };
    else if (f.waitingForMinimum) stake = { ...stake, ...waitingForMinimum(f) };
    else stake = { ...stake, status: "active", detail: "Staking shortly" };
  }

  const steps = [swap, deposit, bridge, stake];
  const cancelled = op.cancelled !== undefined && f.cancelMined === true && !f.delivered;
  const state = overall(steps, "staked");
  return {
    id: op.id,
    createdAt: new Date(op.createdAt),
    sourceChain: "base",
    status: cancelled ? "cancelled" : state === "done" ? "staked" : (state as DepositRecord["status"]),
    steps,
    taoWei: op.targetTao,
    taoAmount: toDisplay(op.targetTao, 18),
    // a deposit of TAO already in the wallet spent no USDC
    ...(op.usdcIn > 0n ? { amountUsd: toDisplay(f.usdcSpent ?? op.usdcIn, 6) } : {}),
    taoPriceUsd: op.priceUsd,
    ...(op.feesUsd !== undefined ? { feesUsd: op.feesUsd } : {}),
    ...(f.stillOpen && f.depositMined && !f.delivered && !cancelled ? { cancellableWei: op.targetTao } : {}),
    // stopped before the deposit landed: it can be tried again
    ...((op.state === "failed" || op.state === "needs-you") && !f.depositMined && !cancelled ? { retryable: true as const } : {}),
    ...((op.state === "needs-you" || op.state === "failed") &&
    !op.callsId &&
    !Object.values(op.hashes).some(Boolean) &&
    (!f.interrupted || f.now.getTime() - op.createdAt >= STALE_MS)
      ? { nothingSent: true as const }
      : {}),
  };
}

/** A deposit known only from the vault's `Deposited` event (made from another browser). */
export function chainOnlyDeposit(e: { key: Hex; txHash: Hex; at: Date; assets: bigint; staked: boolean }): DepositRecord {
  const done = (key: DepositStepKey, title: string): TrailStep<DepositStepKey> => ({ key, title, status: "done" });
  return {
    id: `chain-${e.txHash}`,
    createdAt: e.at,
    sourceChain: "base",
    status: e.staked ? "staked" : "in_progress",
    steps: [
      done("swap", "Swap USDC for TAO"),
      done("deposit", "Deposit into Cascade"),
      { ...done("bridge", "Cross to Bittensor"), at: e.at, txUrl: explorer.bittensorTx(e.txHash), txLabel: "View on Bittensor" },
      e.staked ? done("stake", "Stake on Bittensor") : { key: "stake", title: "Stake on Bittensor", status: "active" },
    ],
    taoWei: e.assets,
    taoAmount: toDisplay(e.assets, 18),
  };
}

export function withdrawalRecord(op: WithdrawalOp, f: WithdrawalFacts): WithdrawalRecord {
  const request: TrailStep<WithdrawalStepKey> = {
    key: "request",
    title: "Request your unstake",
    status: walletStep(f.requestMined, op, true),
    ...(op.hash && f.requestMined ? { txUrl: explorer.baseTx(op.hash) } : {}),
  };

  let unstake: TrailStep<WithdrawalStepKey> = { key: "unstake", title: "Unstake on Bittensor", status: "pending" };
  const d = f.delivered;
  if (d) {
    const link = { at: d.at, txUrl: explorer.bittensorTx(d.txHash), txLabel: "View on Bittensor" };
    if (d.outcome === "redeemed") unstake = { ...unstake, ...link, status: "done" };
    else if (d.outcome === "skipped") {
      unstake = {
        ...unstake,
        ...link,
        status: "failed",
        detail: "Your balance was smaller than this unstake when it arrived, so nothing was taken. Your stake is unchanged.",
      };
    } else {
      unstake = { ...unstake, ...link, status: "action", detail: "The daily unstake limit was reached, so nothing was taken. You can unstake again tomorrow." };
    }
  } else if (op.cancelled && f.cancelMined) {
    unstake = {
      ...unstake,
      status: "failed",
      at: new Date(op.cancelled.at),
      txUrl: explorer.baseTx(op.cancelled.hash),
      detail: "Cancelled before the batch closed. Your shares stay staked; the request fee isn't refunded",
    };
  } else if (f.requestMined) {
    unstake = {
      ...unstake,
      status: "active",
      detail: f.stillOpen
        ? `${waitForClose(f)}, then the bridge`
        : onTheBridge(f, f.requestedAt ? { verb: "requested", at: f.requestedAt } : undefined),
      ...(!f.stillOpen && f.watchUrl ? { txUrl: f.watchUrl, txLabel: "Watch it on Chainlink's explorer" } : {}),
    };
  }

  let ret: TrailStep<WithdrawalStepKey> = { key: "return", title: "Return to Base", status: "pending" };
  if (d?.outcome === "redeemed") {
    const p = f.payout;
    if (p && p.state === 2) ret = { ...ret, status: "done", at: p.at, ...(p.messageId ? { txUrl: explorer.ccip(p.messageId), txLabel: "View on the bridge" } : {}) };
    else if (p && p.state === 3) {
      // a failed delivery on the bridge is sent again: delayed, not lost
      ret = {
        ...ret,
        status: "active",
        detail: "The bridge hasn't delivered this payout yet. Cascade sends it again; nothing is lost.",
        ...(p.messageId ? { txUrl: explorer.ccip(p.messageId), txLabel: "View on the bridge" } : {}),
      };
    } else if (p) {
      ret = { ...ret, status: "active", detail: `On the bridge back to Base, ${BRIDGE_TIME}`, ...(p.messageId ? { txUrl: explorer.ccip(p.messageId), txLabel: "View on the bridge" } : {}) };
    } else {
      const from = new Date(d.at.getTime() + f.payoutDelay * 1000);
      ret = {
        ...ret,
        status: "active",
        detail: `The ${Math.round(f.payoutDelay / 3600)}-hour safety wait ends around ${hhmm(from)}, then it crosses back to Base (${BRIDGE_TIME})`,
      };
    }
  }

  let claim: TrailStep<WithdrawalStepKey> = { key: "claim", title: "Claim as USDC", status: "pending" };
  const c = f.claimed;
  if (c && c.swapFailed) {
    claim = {
      ...claim,
      status: "action",
      at: c.at,
      txUrl: explorer.baseTx(c.hash),
      detail: "Claimed, but the swap back to USDC didn't go through: the TAO is in your wallet. Swap it from the Stake page",
    };
  } else if (c) {
    claim = { ...claim, title: c.keptTao ? "Claimed, kept as TAO" : "Claim as USDC", status: "done", at: c.at, txUrl: explorer.baseTx(c.hash) };
  } else if (f.claimable > 0n) claim = { ...claim, status: "action", detail: "Your money is back on Base. Claim it as USDC" };

  const steps = [request, unstake, ret, claim];
  let status: WithdrawalRecord["status"];
  if (op.cancelled && f.cancelMined && !d) status = "cancelled";
  else if (c && !c.swapFailed) status = "paid";
  else if (steps.some((s) => s.status === "failed")) status = "failed";
  else if (f.claimable > 0n) status = "ready";
  else if (steps.some((s) => s.status === "action")) status = "needs_you";
  else status = "in_progress";

  return {
    // nothing was taken (balance too small, or the daily limit): the user can simply unstake again
    ...(d && (d.outcome === "skipped" || d.outcome === "deferred") ? { unstakeAgain: true as const } : {}),
    id: op.id,
    createdAt: new Date(op.createdAt),
    status,
    steps,
    shares: op.shares,
    taoAmount: toDisplay(d?.taoWei ?? op.taoEstimate, 18),
    usdcAmount: toDisplay(op.usdcEstimate, 6),
    claimable: f.claimable,
    ...(c && !c.swapFailed ? { received: c.keptTao ? { keptTao: toDisplay(c.taoClaimed, 18) } : { usdc: toDisplay(c.usdcOut ?? 0n, 6) } } : {}),
    ...(f.stillOpen && f.requestMined && !d && status !== "cancelled" ? { cancellableShares: op.shares } : {}),
  };
}
