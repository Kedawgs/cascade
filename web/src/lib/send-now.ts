import type { Hex } from "viem";
import { chainNow, countdown, isFull, isStale, leavesBy } from "./batch-clock";
import { explorer } from "./cascade/config";
import type { CloseOp, Operation } from "./cascade/oplog";
import { timeAt } from "./cascade/trail";
import type { OpenBatch } from "./cascade/types";
import { toDisplay } from "./cascade/units";
import { formatUsd } from "./format";

/**
 * "Send it now": a deposit or unstake waiting in the open batch on Base can be sent on its way by its
 * owner once the batch can close, by paying the batch's bridge fee (CascadeFrontDoor.closeBatch, which
 * anyone may call). Without it nothing changes: the keeper still sends the batch once its fees cover the
 * bridge fee, or at the deployment's max wait.
 */

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

/** An ETH amount in words: "$1.74 in ETH" at the price read, or "0.000745 ETH" without one. */
export function inEth(wei: bigint, ethPriceUsd?: number): string {
  const n = toDisplay(wei, 18);
  return ethPriceUsd !== undefined && ethPriceUsd > 0 ? `${formatUsd(n * ethPriceUsd)} in ETH` : `${eth.format(n)} ETH`;
}

/** "about $2.28 of ETH", or "about 0.000979 ETH" without a price: what a wallet needs to hold. */
function ofEth(wei: bigint, ethPriceUsd?: number): string {
  const n = toDisplay(wei, 18);
  return ethPriceUsd !== undefined && ethPriceUsd > 0 ? `about ${formatUsd(n * ethPriceUsd)} of ETH` : `about ${eth.format(n)} ETH`;
}

/** What the wallet must hold to send the batch now: the value and closeBatch's network fee (the value
 * alone when the gas price couldn't be read). */
export const ethNeeded = (b: Pick<OpenBatch, "feeWei" | "potWei" | "gasWei">): bigint =>
  b.feeWei === undefined ? 0n : sendNowValue(b.feeWei, b.potWei) + (b.gasWei ?? 0n);

/** "You need about $2.28 of ETH on Base for this." */
export const needEthText = (wei: bigint, ethPriceUsd?: number): string => `You need ${ofEth(wei, ethPriceUsd)} on Base for this.`;

/** What "Send it now" shows: a countdown to when the batch leaves on its own, and then, before the batch
 * can close, a countdown to when the user can send it; once it can, the button (or, while a send from
 * this browser is on its way, that send). */
export interface SendNowView {
  /** "Leaves in 3 h 12 min (by 3:45 PM), or sooner if more deposits share the bridge fee." */
  leaves: string;
  /** Before the batch can close: "Send it yourself in 18 min (from 9:00 AM)." */
  yourself?: string;
  /** Once it can close: the button's words, what it costs, and why it is held when it is. */
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
  /** A send from this browser for this batch that Base hasn't shown yet (closeSentFromHere). */
  sending?: { hash: Hex };
}

const DASH_NOTE = "We can't read the batch on Base right now, so it can't be sent from here yet.";

/** What "Send it now" shows for the account's deposit or unstake in the open batch, or null when it isn't
 * offered: while paused, with nothing of the account's in the batch, or without a max wait. A figure that
 * can't be read is never guessed: a stale read shows "–" for every time and holds the button, a fee that
 * can't be read shows "–" and holds it too, and without ETH's price amounts show in ETH. */
export function sendNowView(x: SendNowInput): SendNowView | null {
  const b = x.batch;
  if (b.paused || !x.maxWaitS || x.maxWaitS <= b.interval) return null;
  if (b.mine.depositWei === 0n && b.mine.redeemShares === 0n) return null;

  const stale = isStale(x.readAt, x.now);
  const nowS = chainNow(b.chainTime, x.readAt, x.now);
  const today = new Date(nowS * 1000);
  const by = leavesBy(b, x.maxWaitS);
  const left = isFull(b) ? 0 : by - nowS;
  const leaves = stale
    ? "Leaves in –"
    : left <= 0
      ? "Leaves any moment now."
      : `Leaves in ${countdown(left)} (by ${timeAt(new Date(by * 1000), today)}), or sooner if more deposits share the bridge fee.`;
  if (x.sending) return { leaves, sending: { text: "Sending your batch to Bittensor…", txUrl: explorer.baseTx(x.sending.hash) } };

  if (!b.canClose) {
    const from = b.start + b.interval;
    // until a read says it can close, its time is "any moment now", never a time already past
    const yourself = stale
      ? "Send it yourself in –"
      : from - nowS <= 0
        ? "Send it yourself any moment now."
        : `Send it yourself in ${countdown(from - nowS)} (from ${timeAt(new Date(from * 1000), today)}).`;
    return { leaves, yourself };
  }

  if (stale) return { leaves, button: { label: "Send it now: about –", note: DASH_NOTE, disabled: true } };
  if (b.feeWei === undefined) {
    return { leaves, button: { label: "Send it now: about –", note: "We can't read the bridge fee right now, so it can't be sent from here yet.", disabled: true } };
  }
  const pay = feeToPay(b.feeWei, b.potWei);
  const value = sendNowValue(b.feeWei, b.potWei);
  const price = b.ethPriceUsd;
  const margin = `Your wallet sends up to ${inEth(value, price)}`;
  const [label, note] =
    pay === 0n
      ? [
          "Send it now: no bridge fee to pay",
          `The fees already in this batch cover its bridge fee, so you pay only Base's network fee.${value > 0n ? ` ${margin} in case the fee rises; anything extra is refunded.` : ""}`,
        ]
      : [`Send it now: about ${inEth(pay, price)}`, `You pay the bridge fee for the whole batch. ${margin}; anything extra is refunded.`];
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
