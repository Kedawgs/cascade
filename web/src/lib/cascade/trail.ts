import type { Hex } from "viem";
import { explorer } from "./config";
import { type DepositOp, entryPriceUsd, type WithdrawalOp } from "./oplog";
import type { DepositRecord, DepositStepKey, StepStatus, TrailStep, WithdrawalRecord, WithdrawalStepKey } from "./records";
import { formatDay, formatTao, formatUsdc } from "../format";
import { toDisplay } from "./units";

/** What the chain says about one deposit (see facts.ts). */
export interface DepositFacts {
  swapMined: boolean;
  depositMined: boolean;
  /** The cancel (taking it back out of the open batch) went through. */
  cancelMined?: boolean;
  /** A cancel was sent and has no receipt yet: Base has the transaction and it can still be mined
   * ("known"), or Base doesn't know it ("unseen": just sent, or dropped). */
  cancelPending?: "known" | "unseen";
  /** USDC the swap really took (its receipt), when known. */
  usdcSpent?: bigint;
  /** v3: the TAO the front door recorded for this stake (the swap's output, at least the floor), when known. */
  taoDeposited?: bigint;
  now: Date;
  openBatchId: bigint;
  /** When the open batch can close. */
  closesAt: Date;
  /** closesAt is an upper bound (the deployment has a max wait; the keeper may close sooner). */
  closesBy?: boolean;
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
  cancelPending?: "known" | "unseen";
  now: Date;
  /** When the unstake was asked for, when its batch left Base (if known), and where to watch the bridge. */
  requestedAt?: Date;
  sentAt?: Date;
  watchUrl?: string;
  openBatchId: bigint;
  closesAt: Date;
  closesBy?: boolean;
  stillOpen: boolean;
  delivered?: { at: Date; txHash: Hex; outcome: "redeemed" | "skipped" | "deferred"; taoWei?: bigint };
  /** The chunk that carried this account's entry. `dust` when the entry was worth less than its share of
   * the bridge fee: the vault kept it, and nothing comes back. */
  payout?: { txHash: Hex; messageId?: Hex; state: 0 | 1 | 2 | 3; at: Date; dust?: true };
  claimable: bigint;
  /** The claim's receipts: TAO claimed, the USDC the swap paid (if it ran), and whether it was kept as TAO
   * or the swap failed after the claim (the TAO then sits in the wallet). `shared` when the claim named
   * other unstakes too: what it paid isn't this one's alone. */
  claimed?: { hash: Hex; at: Date; taoClaimed: bigint; usdcOut?: bigint; keptTao: boolean; swapFailed: boolean; shared?: true };
  /** A claim from this browser names this unstake and hasn't settled yet. */
  claimPending?: true;
  payoutDelay: number;
  // v3 only, once the payout is back on Base (all absent on v2):
  /** This account's credit from the payout (its PayoutReceived): when it landed and the TAO credited. */
  credited?: { at: Date; taoWei: bigint };
  /** The Base logs couldn't be read just now: what isn't known from them is unknown, not absent. */
  traceFailed?: true;
  /** The front door's Delivered event that sold this payout for USDC: the only source of the USDC received.
   * `shared` when it sold more than this payout's credit (other payouts with it): its USDC isn't this one's alone. */
  usdcDelivered?: { hash: Hex; at: Date; usdcOut: bigint; shared?: true };
  /** A Claimed event took the payout first, from a claim this browser has no record of (`shared` as above). */
  claimedOnChain?: { hash: Hex; at: Date; taoClaimed: bigint; shared?: true };
  /** The account's delivery preference (`deliveryOf`): null when none is set, undefined when not read. */
  preference?: { minUsdcPerTao: bigint; deadline: number } | null;
  /** What everything claimable would sell for now, in USDC units, after the staker's swap fee. */
  saleNowUsdc?: bigint;
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

/** A payout's trip back to Base, at the slow end of its usual 20–30 minutes (when its landing isn't known). */
const RETURN_MS = 30 * 60_000;
/** How long a payout waits on Base for automatic delivery before the claim by hand is offered too. */
const DELIVERY_PATIENCE_MS = 60 * 60_000;

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
const dayLabel = (at: Date, now: Date): string => {
  const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return "";
  return days === 1 ? " tomorrow" : ` on ${weekday.format(at)}`;
};
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" });

const waitForClose = (f: { closesAt: Date; now: Date; closesBy?: boolean }) =>
  f.closesAt.getTime() <= f.now.getTime()
    ? "The batch can close now; it crosses as soon as it is sent"
    : f.closesBy
      ? `Waits for the batch to close, by about ${hhmm(f.closesAt)}${dayLabel(f.closesAt, f.now)}`
      : `Waits for the batch to close at ${hhmm(f.closesAt)}`;

function overall<K extends string>(steps: TrailStep<K>[], doneStatus: string): "failed" | "needs_you" | "done" | "in_progress" {
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "action")) return "needs_you";
  return steps.every((s) => s.status === "done") ? (doneStatus as "done") : "in_progress";
}

/** Taken back out of its batch (facts.ts's cancelTook): that wins over whatever the batch did after,
 * wherever the record shows or counts. */
export const isCancelled = (op: { cancelled?: unknown }, f: { cancelMined?: boolean }): boolean => op.cancelled !== undefined && f.cancelMined === true;

/** A cancel sent from here with no receipt yet that can still go through: "Cancelling…", with no second
 * cancel offered. One Base has and can still mine stays so however long it takes; one Base doesn't know
 * is given ten minutes to appear, then taken for dropped, and Cancel is offered again. (One whose nonce
 * the account used for another transaction can never be mined: Cancel is offered at once.) */
const isCancelling = (op: { cancelled?: { at: number } }, f: { cancelPending?: "known" | "unseen"; now: Date }): boolean =>
  op.cancelled !== undefined && (f.cancelPending === "known" || (f.cancelPending === "unseen" && f.now.getTime() - op.cancelled.at < STALE_MS));
const CANCELLING = "Cancelling…";

/** The status of a wallet step: done once mined, otherwise whatever the operation says. */
function walletStep(mined: boolean, op: { state: string }, started: boolean): StepStatus {
  if (mined) return "done";
  if (op.state === "failed") return "failed";
  if (op.state === "needs-you") return "action";
  return started ? "active" : "pending";
}

export function depositRecord(op: DepositOp, f: DepositFacts): DepositRecord {
  // v3: one `stake` transaction is both the swap and the deposit
  const swapHash = op.v === 3 ? op.hashes.stake : op.hashes.swap;
  const depositHash = op.v === 3 ? op.hashes.stake : op.hashes.deposit;
  const taoWei = f.taoDeposited ?? op.targetTao;
  const price = entryPriceUsd(op);
  const swapStatus = walletStep(f.swapMined, op, true);
  const swap: TrailStep<DepositStepKey> = {
    key: "swap",
    title: "Swap USDC for TAO",
    status: swapStatus,
    ...(swapHash && f.swapMined ? { txUrl: explorer.baseTx(swapHash) } : {}),
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
    ...(depositHash && f.depositMined ? { txUrl: explorer.baseTx(depositHash) } : {}),
    ...(depositStatus === "action" ? { detail: op.error ?? "Waiting for you to confirm in your wallet" } : {}),
    ...(depositStatus === "failed" ? { detail: `${op.error ?? "The deposit didn't go through."}${taoInWallet}` } : {}),
  };

  const cancelled = isCancelled(op, f);
  const cancelling = !cancelled && isCancelling(op, f);
  let bridge: TrailStep<DepositStepKey> = { key: "bridge", title: "Cross to Bittensor", status: "pending" };
  if (cancelled && op.cancelled) {
    bridge = { ...bridge, status: "failed", at: new Date(op.cancelled.at), detail: "Cancelled. Your TAO is back in your wallet", txUrl: explorer.baseTx(op.cancelled.hash) };
  } else if (f.delivered) {
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
  } else if (cancelling && op.cancelled) {
    bridge = { ...bridge, status: "active", detail: CANCELLING, txUrl: explorer.baseTx(op.cancelled.hash) };
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
  if (!cancelled && f.delivered?.outcome === "deposited") {
    if (f.staked) stake = { ...stake, status: "done", at: f.staked.at, txUrl: explorer.bittensorTx(f.staked.txHash), txLabel: "View on Bittensor" };
    else if (f.waitingForMinimum) stake = { ...stake, ...waitingForMinimum(f) };
    else stake = { ...stake, status: "active", detail: "Staking shortly" };
  }

  const steps = [swap, deposit, bridge, stake];
  const state = overall(steps, "staked");
  return {
    id: op.id,
    createdAt: new Date(op.createdAt),
    sourceChain: "base",
    status: cancelled ? "cancelled" : state === "done" ? "staked" : (state as DepositRecord["status"]),
    steps,
    taoWei,
    taoAmount: toDisplay(taoWei, 18),
    // a deposit of TAO already in the wallet spent no USDC
    ...(op.usdcIn > 0n ? { amountUsd: toDisplay(f.usdcSpent ?? op.usdcIn, 6) } : {}),
    // "at $X" only for a deposit recorded with a price
    ...(price !== undefined ? { taoPriceUsd: price } : {}),
    ...(op.feesUsd !== undefined ? { feesUsd: op.feesUsd } : {}),
    ...(f.stillOpen && f.depositMined && !f.delivered && !cancelled && !cancelling ? { cancellableWei: taoWei } : {}),
    // the swap worked but the deposit failed: the deposit alone can be tried again (the TAO is in the wallet)
    ...(op.state === "failed" && f.swapMined && !f.depositMined && !cancelled ? { retryable: true as const } : {}),
    // the swap itself failed (reverted, or a batch that failed whole): start a new stake at today's price
    ...(op.state === "failed" && !f.swapMined && !cancelled ? { restake: true as const } : {}),
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
  const cancelled = isCancelled(op, f);
  const cancelling = !cancelled && isCancelling(op, f);
  // taken back out of its batch: a delivery of that batch isn't this request's
  const d = cancelled ? undefined : f.delivered;
  if (cancelled && op.cancelled) {
    unstake = {
      ...unstake,
      status: "failed",
      at: new Date(op.cancelled.at),
      txUrl: explorer.baseTx(op.cancelled.hash),
      detail: "Cancelled before the batch closed. Your shares stay staked; the request fee isn't refunded",
    };
  } else if (d) {
    const link = { at: d.at, txUrl: explorer.bittensorTx(d.txHash), txLabel: "View on Bittensor" };
    if (d.outcome === "redeemed") unstake = { ...unstake, ...link, status: "done" };
    else if (d.outcome === "skipped") {
      unstake = {
        ...unstake,
        ...link,
        status: "failed",
        detail: "There was no stake to take when this request arrived, so nothing was taken.",
      };
    } else {
      unstake = { ...unstake, ...link, status: "action", detail: "The daily unstake limit was reached, so nothing was taken. You can unstake again tomorrow." };
    }
  } else if (cancelling && op.cancelled) {
    unstake = { ...unstake, status: "active", detail: CANCELLING, txUrl: explorer.baseTx(op.cancelled.hash) };
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
    if (p?.dust) ret = { ...ret, status: "failed", at: p.at, detail: "Too small to send back after the bridge fee, so nothing came back" };
    else if (p && p.state === 2) ret = { ...ret, status: "done", at: p.at, ...(p.messageId ? { txUrl: explorer.ccip(p.messageId), txLabel: "View on the bridge" } : {}) };
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

  // claimable is the wallet's whole balance on Base: this unstake is ready only once its own payout landed
  const landed = ret.status === "done";
  // v3: the unstake asked for USDC sent to the wallet automatically; claiming by hand is the fallback
  const auto = op.delivery !== undefined;
  const sold = auto ? f.usdcDelivered : undefined;
  let claim: TrailStep<WithdrawalStepKey> = { key: "claim", title: auto ? "USDC to your wallet" : "Claim as USDC", status: "pending" };
  /** v3: paid out without a claim from this browser (delivered, or taken some other way). */
  let settled = false;
  /** v3: delivery can't happen, so the claim by hand is offered. */
  let offered = false;
  /** v3: today's price is under the unstake's minimum, so it hasn't been sold for it. */
  let belowMinimum: WithdrawalRecord["belowMinimum"];
  const c = cancelled ? undefined : f.claimed;
  // a claim from this browser shows its amount only when it was this payout's alone: on v3 when it took
  // exactly this payout's credit; on v2, whose credits aren't read, when it named this unstake alone
  const ownClaim = c !== undefined && (auto ? f.credited !== undefined && c.taoClaimed === f.credited.taoWei : !c.shared);
  // and says it took more only when that is known (an unknown v3 credit says nothing)
  const sharedClaim = c !== undefined && !ownClaim && (!auto || f.credited !== undefined);
  if (sold) {
    claim = {
      ...claim,
      title: "USDC delivered",
      status: "done",
      at: sold.at,
      txUrl: explorer.baseTx(sold.hash),
      txLabel: "View the receipt",
      ...(sold.shared ? { detail: `Delivered together with your other payout: ${formatUsdc(toDisplay(sold.usdcOut, 6))} USDC in all` } : {}),
    };
    settled = true;
  } else if (c && c.swapFailed) {
    claim = {
      ...claim,
      title: "Claim as USDC",
      status: "action",
      at: c.at,
      txUrl: explorer.baseTx(c.hash),
      detail: "Claimed, but the swap back to USDC didn't go through: the TAO is in your wallet. Swap it from the Stake page",
    };
  } else if (c) {
    const total = c.keptTao ? `${formatTao(toDisplay(c.taoClaimed, 18), 4)} TAO` : `${formatUsdc(toDisplay(c.usdcOut ?? 0n, 6))} USDC`;
    claim = {
      ...claim,
      title: c.keptTao ? "Claimed, kept as TAO" : "Claim as USDC",
      status: "done",
      at: c.at,
      txUrl: explorer.baseTx(c.hash),
      // it took more than this payout: the total, not a share of it
      ...(sharedClaim ? { detail: `Claimed together with your other payout: ${total} in all` } : {}),
    };
  } else if (auto && landed) {
    const v3 = deliveryStep(op, f, claim);
    claim = v3.step;
    settled = v3.settled;
    offered = v3.offered;
    belowMinimum = v3.belowMinimum;
  } else if (landed && f.claimable > 0n) claim = { ...claim, status: "action", detail: "Your money is back on Base. Claim it as USDC" };

  const steps = [request, unstake, ret, claim];
  let status: WithdrawalRecord["status"];
  if (cancelled) status = "cancelled";
  else if ((c && !c.swapFailed) || settled) status = "paid";
  else if (steps.some((s) => s.status === "failed")) status = "failed";
  else if (landed && f.claimable > 0n && (!auto || offered)) status = "ready";
  else if (steps.some((s) => s.status === "action")) status = "needs_you";
  else status = "in_progress";

  const nothingTaken = d !== undefined && (d.outcome === "skipped" || d.outcome === "deferred");
  // taken, but too small to send back: nothing comes back either
  const nothingBack = nothingTaken || f.payout?.dust === true;
  // only what was this unstake's alone: one sale or claim of several payouts shows its total in the step instead
  const received = sold
    ? sold.shared
      ? undefined
      : { usdc: toDisplay(sold.usdcOut, 6) }
    : c && !c.swapFailed && ownClaim
      ? c.keptTao
        ? { keptTao: toDisplay(c.taoClaimed, 18) }
        : { usdc: toDisplay(c.usdcOut ?? 0n, 6) }
      : undefined;
  // nothing was taken, so nothing comes back; a paid v3 unstake shows what arrived (its receipt) or nothing, never the estimate
  const usdcAmount = nothingBack ? undefined : auto && status === "paid" ? received?.usdc : toDisplay(op.usdcEstimate, 6);
  // v3: asked for, still on its way back, its USDC to be delivered when it lands (the preference it set
  // hasn't run out); claim() clears the account's preference, so a claim by hand now would turn that off
  const awaitingDelivery =
    op.delivery !== undefined &&
    op.delivery.deadline * 1000 >= f.now.getTime() &&
    f.requestMined &&
    !landed &&
    !nothingBack &&
    (status === "in_progress" || status === "needs_you");
  return {
    // nothing was taken (balance too small, or the daily limit): the user can simply unstake again
    ...(nothingTaken ? { unstakeAgain: true as const } : {}),
    id: op.id,
    createdAt: new Date(op.createdAt),
    status,
    steps,
    shares: op.shares,
    taoAmount: toDisplay(d?.taoWei ?? op.taoEstimate, 18),
    ...(usdcAmount !== undefined ? { usdcAmount } : {}),
    claimable: f.claimable,
    ...(received ? { received } : {}),
    ...(belowMinimum ? { belowMinimum } : {}),
    ...(awaitingDelivery ? { awaitingDelivery: true as const } : {}),
    ...(f.stillOpen && f.requestMined && !d && status !== "cancelled" && !cancelling ? { cancellableShares: op.shares } : {}),
  };
}

/** Whether the record offers the claim by hand ("Claim as USDC"): on v2 once its payout is back on
 * Base; on v3 only when automatic delivery can't happen or is taking longer than usual. The one test
 * the screens use to show the claim button or banner. */
export const offersClaim = (r: Pick<WithdrawalRecord, "status">): boolean => r.status === "ready";

/** v3: what the last step says while the USDC is on its way to the wallet by itself. */
const DELIVERING = "USDC is being delivered to your wallet automatically";

/** v3: the record's USDC is being delivered automatically and the claim by hand isn't offered (yet).
 * Delivery sells everything waiting on Base, so the screens offer no claim meanwhile. */
export const isDelivering = (r: Pick<WithdrawalRecord, "status" | "steps">): boolean =>
  !offersClaim(r) && r.steps.some((s) => s.key === "claim" && s.status === "active" && s.detail === DELIVERING);

/** v3's last step once the payout is back on Base and no claim from this browser has settled it. */
function deliveryStep(
  op: WithdrawalOp,
  f: WithdrawalFacts,
  step: TrailStep<WithdrawalStepKey>,
): { step: TrailStep<WithdrawalStepKey>; settled: boolean; offered: boolean; belowMinimum?: WithdrawalRecord["belowMinimum"] } {
  const waiting = { settled: false, offered: false };
  // a claim this browser sent hasn't settled: it is what takes this payout, whatever else is claimable
  if (f.claimPending) return { step: { ...step, title: "Claim as USDC", status: "active" }, ...waiting };
  if (f.claimedOnChain) {
    const { hash, at, taoClaimed, shared } = f.claimedOnChain;
    return {
      step: {
        ...step,
        title: "Claimed",
        status: "done",
        at,
        txUrl: explorer.baseTx(hash),
        ...(shared ? { detail: `Claimed together with your other payout: ${formatTao(toDisplay(taoClaimed, 18), 4)} TAO in all` } : {}),
      },
      settled: true,
      offered: false,
    };
  }
  if (!f.traceFailed) {
    // the logs were read: nothing credited to this account from this payout (too small to send after the
    // bridge fee, say), or credited with nothing taking it while the balance read empty (an older read)
    if (!f.credited || f.claimable === 0n) return { step: { ...step, status: "active" }, ...waiting };
  } else if (f.claimable === 0n) {
    // the logs can't be read, nothing is claimable and no claim from here: paid out, amount unknown
    return {
      step: { ...step, title: "Paid out", status: "done", detail: "Sent to your wallet. The receipt can't be read right now, so the amount isn't shown" },
      settled: true,
      offered: false,
    };
  }
  // the chain's preference, or the one this unstake asked for when it couldn't be read
  const pref = f.preference !== undefined ? f.preference : (op.delivery ?? null);
  const live = pref !== null && pref.deadline * 1000 >= f.now.getTime();
  // the keeper sells everything claimable at once, and only at or above the minimum (rounded up, as the front door does)
  const floor = pref ? (f.claimable * pref.minUsdcPerTao + 10n ** 18n - 1n) / 10n ** 18n : 0n;
  const under = live && f.saleNowUsdc !== undefined && f.saleNowUsdc < floor;
  if (live && !under) {
    // the keeper can skip for reasons this page can't see (the 30-minute price floor, a pause, not running):
    // after an hour back on Base the claim by hand is offered too
    const landedAt = f.credited?.at ?? (f.payout ? new Date(f.payout.at.getTime() + RETURN_MS) : undefined);
    const slow = landedAt !== undefined && f.now.getTime() - landedAt.getTime() > DELIVERY_PATIENCE_MS;
    const detail = DELIVERING;
    if (slow) return { step: { ...step, status: "action", detail: `${detail}. It's taking longer than usual. You can keep waiting, or claim it as USDC now.` }, settled: false, offered: true };
    return { step: { ...step, status: "active", detail }, ...waiting };
  }
  const until = pref ? formatDay(new Date(pref.deadline * 1000)) : "";
  const detail = under
    ? `The price is below your minimum, so it hasn't been sold for you yet. Claim it as USDC at today's price, or wait: it's still sold for you automatically if the price recovers by ${until}`
    : pref
      ? `Automatic delivery ended on ${until}. Your money is back on Base. Claim it as USDC`
      : "Your money is back on Base. Claim it as USDC";
  const offer = { step: { ...step, title: "Claim as USDC", status: "action" as const, detail }, settled: false, offered: true };
  if (!under || f.saleNowUsdc === undefined) return offer;
  // what the sale would pay today, after the staker's fee: this payout's share when others wait with it,
  // and no figure when its own credit can't be read (never one that may be shared)
  const credit = f.credited?.taoWei;
  const usdcNow = credit === undefined ? undefined : credit >= f.claimable ? f.saleNowUsdc : (f.saleNowUsdc * credit) / f.claimable;
  return { ...offer, belowMinimum: usdcNow !== undefined ? { usdcNow: toDisplay(usdcNow, 6) } : {} };
}
