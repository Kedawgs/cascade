import type { Hex } from "viem";
import { chainNow, countdown, isFull, isStale, leavesBy, SEND_GRACE_S } from "./batch-clock";
import { explorer } from "./cascade/config";
import type { CloseOp, Operation } from "./cascade/oplog";
import { timeAt } from "./cascade/trail";
import type { CloseEconomics, OpenBatch } from "./cascade/types";
import { toDisplay } from "./cascade/units";
import { formatUsd } from "./format";

/**
 * "Send it now": a deposit or unstake waiting in the open batch on Base can be sent on its way by its
 * owner once the batch can close, by paying the batch's bridge fee (CascadeFrontDoor.closeBatch, which
 * anyone may call). Without it nothing changes: the keeper still sends the batch once its fees cover the
 * bridge fee, or at the deployment's max wait. It is offered only when the keeper won't send the batch
 * for free (sendGate): never for a full batch or one past its max wait, nor while its fees cover the
 * bridge fee, and only from five minutes past its interval, when the keeper has had several turns.
 */

export { SEND_GRACE_S };

/** The keeper's fee rule (ops/src/keeper/due.ts, closeEconomicsOf), the same arithmetic: the staker's
 * deposit fee on each deposit it made, its swap fee on their TAO at the oracle's price, and the pot at
 * ETH's price, against the bridge fee at ETH's price. Prices are USDC units per 1e18 wei. */
export function closeEconomicsOf(r: {
  nStaked: number;
  depositFeeUsdc: bigint;
  stakedTao: bigint;
  taoPriceUsdc: bigint;
  swapFeeBps: number;
  feePot: bigint;
  ethPriceUsdc: bigint;
  bridgeFeeWei: bigint;
}): CloseEconomics {
  const E18 = 10n ** 18n;
  const feesUsdc =
    BigInt(r.nStaked) * r.depositFeeUsdc + (r.stakedTao * r.taoPriceUsdc * BigInt(r.swapFeeBps)) / 10_000n / E18 + (r.feePot * r.ethPriceUsdc) / E18;
  return { feesUsdc, bridgeFeeUsdc: (r.bridgeFeeWei * r.ethPriceUsdc) / E18 };
}

/** Whether the keeper would send the batch at its interval for its own fees (decideNext's isHeld): only
 * when they were weighed and cover the bridge fee; fees that couldn't be read never close it early. */
const feesCover = (e: CloseEconomics | null | undefined): boolean => !!e && e.feesUsdc >= e.bridgeFeeUsdc;

/** Whether the user may send the batch now (on Base's clock, `nowS`):
 * - "blocked": it can close, but Bittensor's side can't take it (paused, or migrating);
 * - "unchecked": it can close, but Bittensor's side couldn't be checked: never sent on a guess;
 * - "free": the keeper sends it any moment at no cost to the user: it's full, or past its max wait (with
 *   no max wait, as soon as it can close);
 * - "covered": its fees cover the bridge fee, so the keeper sends it at its interval;
 * - "early": before five minutes past its interval (or Base hasn't yet said it can close);
 * - "open": the keeper is holding it for more fees, and the user may send it, paying the bridge fee.
 * A batch the keeper should already have sent, still open five minutes later, is one the keeper is
 * holding after all (its reads differ) or isn't running for: "open". That is one its fees cover, five
 * minutes past its interval, and any batch five minutes past its max wait. */
export type SendGate = "blocked" | "unchecked" | "free" | "covered" | "early" | "open";

export function sendGate(b: OpenBatch, maxWaitS: number | undefined, nowS: number): SendGate {
  if (b.canClose && b.bittensor === "paused") return "blocked";
  if (b.canClose && b.bittensor !== "open") return "unchecked";
  const by = leavesBy(b, maxWaitS);
  if (nowS >= by + SEND_GRACE_S) return "open";
  if (isFull(b) || nowS >= by) return "free";
  const offerFrom = b.start + b.interval + SEND_GRACE_S;
  if (nowS < offerFrom && feesCover(b.economics)) return "covered";
  if (nowS < offerFrom || !b.canClose) return "early";
  return "open";
}

/** The margin closeBatch carries over the bridge fee, in percent: the fee can move between the read and
 * the block (another entry joining, gas prices on the way), and the front door refunds whatever the fee
 * doesn't take. */
export const HEADROOM_PCT = 30n;
/** closeBatch's value is rounded up to 0.000001 ETH, so the wallet shows a short figure. */
const ETH_STEP = 10n ** 12n;

/** What the user pays toward the bridge fee: the fee less what the batch's pot of unstake-request fees
 * already holds (the front door spends the pot first). */
export const feeToPay = (feeWei: bigint, potWei: bigint): bigint => (feeWei > potWei ? feeWei - potWei : 0n);

/** What closeBatch is sent with: enough for the pot and the value together to cover the fee plus 30%,
 * rounded up to 0.000001 ETH. With an empty pot (a batch of deposits alone) that is the fee to pay plus
 * 30%; the margin is on the whole fee, because the whole fee is what moves. */
export function sendNowValue(feeWei: bigint, potWei: bigint): bigint {
  const budget = (feeWei * (100n + HEADROOM_PCT) + 99n) / 100n;
  const value = budget > potWei ? budget - potWei : 0n;
  return ((value + ETH_STEP - 1n) / ETH_STEP) * ETH_STEP;
}

const eth = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const priced = (p: number | undefined): p is number => p !== undefined && p > 0;
/** Dollars rounded up to the cent, for a most or a need, never understated ($0.0001 of float noise aside). */
const usdUp = (n: number) => formatUsd(Math.ceil(Math.round(n * 1e6) / 1e4) / 100);
/** Dollars to the nearest cent, "under $0.01" below half a cent: never "$0.00" for an amount that isn't nothing. */
const usdNear = (n: number) => (n > 0 && n < 0.005 ? "under $0.01" : formatUsd(n));

/** An ETH amount in words: "$1.74 in ETH" at the price read ("under $0.01 in ETH" for a tiny one), or
 * "0.000745 ETH" without a price. */
export function inEth(wei: bigint, ethPriceUsd?: number): string {
  const n = toDisplay(wei, 18);
  return priced(ethPriceUsd) ? `${usdNear(n * ethPriceUsd)} in ETH` : `${eth.format(n)} ETH`;
}

/** "about $1.74 in ETH", "under $0.01 in ETH", or "about 0.000745 ETH" without a price. */
const aboutEth = (wei: bigint, ethPriceUsd?: number): string => {
  const words = inEth(wei, ethPriceUsd);
  return words.startsWith("under") ? words : `about ${words}`;
};

/** The most the wallet sends: "$2.26 in ETH", rounded up to the cent, or "0.000969 ETH". */
const upToEth = (wei: bigint, ethPriceUsd?: number): string =>
  priced(ethPriceUsd) ? `${usdUp(toDisplay(wei, 18) * ethPriceUsd)} in ETH` : `${eth.format(toDisplay(wei, 18))} ETH`;

/** "about $2.29 of ETH" (rounded up to the cent), or "about 0.000979 ETH" without a price: what a wallet needs to hold. */
const ofEth = (wei: bigint, ethPriceUsd?: number): string =>
  priced(ethPriceUsd) ? `about ${usdUp(toDisplay(wei, 18) * ethPriceUsd)} of ETH` : `about ${eth.format(toDisplay(wei, 18))} ETH`;

/** What the wallet must hold to send the batch now: the value and closeBatch's network fee (the value
 * alone when the gas price couldn't be read). */
export const ethNeeded = (b: Pick<OpenBatch, "feeWei" | "potWei" | "gasWei">): bigint =>
  b.feeWei === undefined ? 0n : sendNowValue(b.feeWei, b.potWei) + (b.gasWei ?? 0n);

/** "You need about $2.28 of ETH on Base for this." */
export const needEthText = (wei: bigint, ethPriceUsd?: number): string => `You need ${ofEth(wei, ethPriceUsd)} on Base for this.`;

/** What "Send it now" shows: a countdown to when the batch leaves on its own, and then, until it's
 * offered, a countdown to when the user can send it; once it is, the button (or, while a send from this
 * browser is on its way, that send). When the keeper sends the batch for free, or Bittensor's side can't
 * take it, only `leaves`, saying so. */
export interface SendNowView {
  /** "Leaves in 3 h 12 min (by 3:45 PM), or sooner once its fees cover the bridge fee." */
  leaves: string;
  /** Until it's offered: "Send it yourself in 18 min (from 9:05 AM)." */
  yourself?: string;
  /** Once it's offered: the button's words, what it costs, and why it is held when it is. */
  button?: { label: string; note: string; warning?: string; disabled: boolean };
  /** A send from this browser Base hasn't shown yet, in place of the button. */
  sending?: { text: string; txUrl: string };
}

export interface SendNowInput {
  batch: OpenBatch;
  /** The deployment's max wait (the launch cadence's 24 hours): without one, or one no longer than the
   * batch interval, the keeper sends each batch as soon as it can close, so there is nothing to offer. */
  maxWaitS?: number;
  /** When the read landed and now, by this device's clock (ms): the countdowns run on Base's clock from
   * the read's block time (batch-clock.ts), and a stale read shows "–". */
  readAt: number;
  now: number;
  /** What of the account's waits in it, for the words when Bittensor's side can't take it. */
  what: "deposit" | "unstake";
  /** A send from this browser for this batch that Base hasn't shown yet (closeSentFromHere). */
  sending?: { hash: Hex };
}

const DASH_NOTE = "We can't read the batch on Base right now, so it can't be sent from here yet.";

/** Bittensor's side can't take a batch: the keeper holds it too, so no time is named. */
export const blockedText = (what: "deposit" | "unstake") =>
  `Bittensor's side isn't accepting batches right now; your ${what} waits on Base and you can still cancel it.`;

/** Bittensor's side couldn't be read: said as that, not as a pause, and nothing is offered meanwhile. */
export const uncheckedText = (what: "deposit" | "unstake") =>
  `We couldn't check Bittensor's side just now; your ${what} waits on Base and you can still cancel it. Try again in a minute.`;

/** What "Send it now" shows for the account's deposit or unstake in the open batch, or null when nothing
 * is: while paused, with nothing of the account's in the batch, or without a max wait. What it offers
 * follows sendGate. A figure that can't be read is never guessed: a stale read shows "–" for every time
 * and holds the button, a fee that can't be read shows "–" and holds it too, and without ETH's price
 * amounts show in ETH. */
export function sendNowView(x: SendNowInput): SendNowView | null {
  const b = x.batch;
  if (b.paused || !x.maxWaitS || x.maxWaitS <= b.interval) return null;
  if (b.mine.depositWei === 0n && b.mine.redeemShares === 0n) return null;

  const stale = isStale(x.readAt, x.now);
  const nowS = chainNow(b.chainTime, x.readAt, x.now);
  const today = new Date(nowS * 1000);
  const by = leavesBy(b, x.maxWaitS);
  const gate = sendGate(b, x.maxWaitS, nowS);
  if (!stale && gate === "blocked") return { leaves: blockedText(x.what) };
  if (!stale && gate === "unchecked") return { leaves: uncheckedText(x.what) };
  if (!stale && gate === "free") return { leaves: "Leaves any moment now." };
  if (!stale && gate === "covered") return { leaves: "Leaves within the hour: its fees cover the bridge fee." };
  const byText = timeAt(new Date(by * 1000), today);
  const leaves = stale
    ? "Leaves in –"
    : by - nowS <= 0
      ? // past its max wait and five minutes more: the keeper hasn't sent it
        `It was due to leave by ${byText} and hasn't left yet; you can send it yourself.`
      : `Leaves in ${countdown(by - nowS)} (by ${byText}), or sooner once its fees cover the bridge fee.`;
  if (x.sending) return { leaves, sending: { text: "Sending your batch to Bittensor…", txUrl: explorer.baseTx(x.sending.hash) } };

  if (stale) return b.canClose ? { leaves, button: { label: "Send it now: about –", note: DASH_NOTE, disabled: true } } : { leaves, yourself: "Send it yourself in –" };
  if (gate === "early") {
    const from = b.start + b.interval + SEND_GRACE_S;
    // until a read says it can close, its time is "any moment now", never a time already past
    const yourself =
      from - nowS <= 0 ? "Send it yourself any moment now." : `Send it yourself in ${countdown(from - nowS)} (from ${timeAt(new Date(from * 1000), today)}).`;
    return { leaves, yourself };
  }

  if (b.feeWei === undefined) {
    const note = b.feeUnconfirmed
      ? "The bridge fee couldn't be confirmed right now (our two sources for it disagree), so it can't be sent from here yet."
      : "We can't read the bridge fee right now, so it can't be sent from here yet.";
    return { leaves, button: { label: "Send it now: about –", note, disabled: true } };
  }
  const pay = feeToPay(b.feeWei, b.potWei);
  const value = sendNowValue(b.feeWei, b.potWei);
  const price = b.ethPriceUsd;
  const margin = `Your wallet sends up to ${upToEth(value, price)}`;
  const [label, note] =
    pay === 0n
      ? [
          "Send it now: no bridge fee to pay",
          `The fees already in this batch cover its bridge fee, so you pay only Base's network fee.${value > 0n ? ` ${margin} in case the fee rises; anything extra is refunded.` : ""}`,
        ]
      : [`Send it now: ${aboutEth(pay, price)}`, `You pay the bridge fee for the whole batch. ${margin}; anything extra is refunded.`];
  const need = ethNeeded(b);
  const short = b.ethWei !== undefined && b.ethWei < need;
  return { leaves, button: { label, note, ...(short ? { warning: needEthText(need, price) } : {}), disabled: short } };
}

/** How long a send from this browser shows as sending while Base doesn't show the batch gone. */
const SENDING_MS = 10 * 60_000;

/** A send of batch `batchId` from this browser with a transaction, not failed, made in the last ten
 * minutes: while the batch still reads as open, it is on its way, not to be offered again. */
export function closeSentFromHere(ops: readonly Operation[], batchId: bigint, now: number): { hash: Hex } | undefined {
  const op = ops.find(
    (o): o is CloseOp => o.kind === "close" && o.batchId === batchId && !!o.hashes.close && o.state !== "failed" && now - o.createdAt < SENDING_MS,
  );
  return op?.hashes.close ? { hash: op.hashes.close } : undefined;
}
