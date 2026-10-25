import type { Hex } from "viem";
import { explorer } from "./config";
import type { DepositOp, WithdrawalOp } from "./oplog";
import type { DepositRecord, DepositStepKey, StepStatus, TrailStep, WithdrawalRecord, WithdrawalStepKey } from "./records";
import { toDisplay } from "./units";

/** What the chain says about one deposit (see facts.ts). */
export interface DepositFacts {
  swapMined: boolean;
  depositMined: boolean;
  openBatchId: bigint;
  /** When the open batch can close. */
  closesAt: Date;
  /** The deposit's batch is still the open one. */
  stillOpen: boolean;
  delivered?: { at: Date; txHash: Hex; messageId?: Hex; outcome: "deposited" | "bounced" | "skipped" };
  staked?: { at: Date; txHash: Hex };
  /** In the vault but not staked yet, because one position must reach the 0.02-TAO nominator minimum. */
  waitingForMinimum: boolean;
}

export interface WithdrawalFacts {
  requestMined: boolean;
  openBatchId: bigint;
  closesAt: Date;
  stillOpen: boolean;
  delivered?: { at: Date; txHash: Hex; outcome: "redeemed" | "skipped" | "deferred"; taoWei?: bigint };
  payout?: { txHash: Hex; messageId?: Hex; state: 0 | 1 | 2 | 3; at: Date };
  claimable: bigint;
  claimed?: { hash: Hex; at: Date };
  payoutDelay: number;
}

const hhmm = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;
const BRIDGE_TIME = "usually 20–30 minutes";

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
  const swap: TrailStep<DepositStepKey> = {
    key: "swap",
    title: "Swap USDC for TAO",
    status: walletStep(f.swapMined, op, true),
    ...(op.hashes.swap && f.swapMined ? { txUrl: explorer.baseTx(op.hashes.swap) } : {}),
    ...(!f.swapMined && op.callsId ? { detail: "Sent from your wallet as one batch" } : {}),
  };
  const deposit: TrailStep<DepositStepKey> = {
    key: "deposit",
    title: "Deposit into Cascade",
    status: f.swapMined ? walletStep(f.depositMined, op, true) : "pending",
    ...(op.hashes.deposit && f.depositMined ? { txUrl: explorer.baseTx(op.hashes.deposit) } : {}),
    ...(f.depositMined && op.batchId !== undefined ? { detail: `In batch ${op.batchId}` } : {}),
    ...(!f.depositMined && op.state === "needs-you" ? { detail: "Waiting for you to confirm in your wallet" } : {}),
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
            ? "The vault sent this deposit back to protect its price; it returns to Base for you to claim"
            : "The vault skipped this deposit; the TAO stays in the vault",
      };
    }
  } else if (f.depositMined) {
    bridge = {
      ...bridge,
      status: "active",
      detail: f.stillOpen
        ? `Waits for the batch to close at ${hhmm(f.closesAt)}, then the bridge (${BRIDGE_TIME})`
        : `On the bridge to Bittensor, ${BRIDGE_TIME}`,
    };
  }

  let stake: TrailStep<DepositStepKey> = { key: "stake", title: "Stake on Bittensor", status: "pending" };
  if (f.delivered?.outcome === "deposited") {
    if (f.staked) stake = { ...stake, status: "done", at: f.staked.at, txUrl: explorer.bittensorTx(f.staked.txHash), txLabel: "View on Bittensor" };
    else if (f.waitingForMinimum) {
      stake = { ...stake, status: "active", detail: "In the vault and counting. It is staked once the vault holds 0.02 TAO, the chain's minimum" };
    } else stake = { ...stake, status: "active", detail: "Staking shortly" };
  }

  const steps = [swap, deposit, bridge, stake];
  const state = overall(steps, "staked");
  return {
    id: op.id,
    createdAt: new Date(op.createdAt),
    sourceChain: "base",
    status: state === "done" ? "staked" : (state as DepositRecord["status"]),
    steps,
    taoWei: op.targetTao,
    taoAmount: toDisplay(op.targetTao, 18),
    amountUsd: toDisplay(op.usdcIn, 6),
    taoPriceUsd: op.priceUsd,
    ...(op.feesUsd !== undefined ? { feesUsd: op.feesUsd } : {}),
    ...(f.stillOpen && f.depositMined && !f.delivered ? { cancellableWei: op.targetTao } : {}),
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
    title: "Ask for your TAO back",
    status: walletStep(f.requestMined, op, true),
    ...(op.hash && f.requestMined ? { txUrl: explorer.baseTx(op.hash) } : {}),
    ...(f.requestMined && op.batchId !== undefined ? { detail: `In batch ${op.batchId}` } : {}),
  };

  let unstake: TrailStep<WithdrawalStepKey> = { key: "unstake", title: "Unstake on Bittensor", status: "pending" };
  const d = f.delivered;
  if (d) {
    const link = { at: d.at, txUrl: explorer.bittensorTx(d.txHash), txLabel: "View on Bittensor" };
    if (d.outcome === "redeemed") unstake = { ...unstake, ...link, status: "done" };
    else if (d.outcome === "skipped") {
      unstake = { ...unstake, ...link, status: "failed", detail: "You had fewer shares than this request when it arrived; nothing was taken" };
    } else {
      unstake = { ...unstake, ...link, status: "action", detail: "Today's withdrawal limit was reached; you kept your shares. Ask again tomorrow" };
    }
  } else if (f.requestMined) {
    unstake = {
      ...unstake,
      status: "active",
      detail: f.stillOpen ? `Waits for the batch to close at ${hhmm(f.closesAt)}, then the bridge` : `On the bridge to Bittensor, ${BRIDGE_TIME}`,
    };
  }

  let ret: TrailStep<WithdrawalStepKey> = { key: "return", title: "Return to Base", status: "pending" };
  if (d?.outcome === "redeemed") {
    const p = f.payout;
    if (p && p.state === 2) ret = { ...ret, status: "done", at: p.at, ...(p.messageId ? { txUrl: explorer.ccip(p.messageId), txLabel: "View on the bridge" } : {}) };
    else if (p && p.state === 3) {
      ret = { ...ret, status: "failed", detail: "The bridge delivery failed; the operator runs it again", ...(p.messageId ? { txUrl: explorer.ccip(p.messageId), txLabel: "View on the bridge" } : {}) };
    } else if (p) {
      ret = { ...ret, status: "active", detail: `On the bridge back to Base, ${BRIDGE_TIME}`, ...(p.messageId ? { txUrl: explorer.ccip(p.messageId), txLabel: "View on the bridge" } : {}) };
    } else {
      const from = new Date(d.at.getTime() + f.payoutDelay * 1000);
      ret = { ...ret, status: "active", detail: `After a ${Math.round(f.payoutDelay / 3600)}-hour safety delay (from ${hhmm(from)}), then the bridge back` };
    }
  }

  let claim: TrailStep<WithdrawalStepKey> = { key: "claim", title: "Claim as USDC", status: "pending" };
  if (f.claimed) claim = { ...claim, status: "done", at: f.claimed.at, txUrl: explorer.baseTx(f.claimed.hash) };
  else if (f.claimable > 0n) claim = { ...claim, status: "action", detail: "Your TAO is back on Base. Claim it as USDC" };

  const steps = [request, unstake, ret, claim];
  let status: WithdrawalRecord["status"];
  if (f.claimed) status = "paid";
  else if (steps.some((s) => s.status === "failed")) status = "failed";
  else if (f.claimable > 0n) status = "ready";
  else if (steps.some((s) => s.status === "action")) status = "needs_you";
  else status = "in_progress";

  return {
    id: op.id,
    createdAt: new Date(op.createdAt),
    status,
    steps,
    shares: op.shares,
    taoAmount: toDisplay(d?.taoWei ?? op.taoEstimate, 18),
    usdcAmount: toDisplay(op.usdcEstimate, 6),
    claimable: f.claimable,
    ...(f.stillOpen && f.requestMined && !d ? { cancellableShares: op.shares } : {}),
  };
}
