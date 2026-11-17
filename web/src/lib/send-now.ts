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

/** An amount for the button and its note, which say once that the fee is paid in ETH: the dollar figure alone ("about
 * $1.74", "under $0.01", "$2.26"), and without a price still in ETH ("about 0.000745 ETH"), never a bare number. */
const figure = (words: string): string => (words.endsWith(" in ETH") ? words.slice(0, -" in ETH".length) : words);

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
  /** "Leaves in 3 h 12 min (by 3:45 PM), or sooner." (sooner: once its fees cover the bridge fee, or it fills) */
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

/** Whether "Send it now" is offered at all for the account's deposit or unstake in the open batch: on a retired
 * deployment (Task 60) only for an unstake, and only while none of the account's deposit is in the batch, so a retired
 * site never sends a deposit (flows.ts planSendNow refuses it at the click too). Everywhere else, as sendNowView says. */
export const sendNowOffered = (x: { retired: boolean; what: "deposit" | "unstake"; depositWei: bigint }): boolean =>
  !x.retired || (x.what === "unstake" && x.depositWei === 0n);

/** A retired deployment's unstake beside the account's deposit in the open batch: why "Send it now" isn't offered for
 * it, and the way to it (Task 60 review, Minor 5). Null everywhere else. */
export const SEND_HELD_BY_DEPOSIT = "Cancel your deposit to send your unstake now.";
export const sendNowHeldByDeposit = (x: { retired: boolean; what: "deposit" | "unstake"; depositWei: bigint }): string | null =>
  x.retired && x.what === "unstake" && x.depositWei > 0n ? SEND_HELD_BY_DEPOSIT : null;

/** What "Send it now" shows for the account's deposit or unstake in the open batch, or null when nothing
 * is: while paused (v3-launch: v3.2's pause stops no close, `closesWhilePaused`), with nothing of the account's
 * in the batch, or without a max wait. What it offers follows sendGate. A figure that can't be read is never
 * guessed: a stale read shows "–" for every time and holds the button, a fee that can't be read shows "–" and
 * holds it too, and without ETH's price amounts show in ETH. */
export function sendNowView(x: SendNowInput): SendNowView | null {
  const b = x.batch;
  if ((b.paused && !b.closesWhilePaused) || !x.maxWaitS || x.maxWaitS <= b.interval) return null;
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
      : `Leaves in ${countdown(by - nowS)} (by ${byText}), or sooner.`;
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
  // the most the wallet sends, beside words that say it is ETH: "$2.26", or "0.000969 ETH" without a price
  const most = figure(upToEth(value, price));
  const [label, note] =
    pay === 0n
      ? [
          "Send it now: no bridge fee to pay",
          // ETH is named here, with the figure: this note says it nowhere else
          `This batch's fees already cover its bridge fee, so you pay only Base's network fee.${value > 0n ? ` Up to ${upToEth(value, price)} is sent in case the fee rises; any extra is refunded.` : ""}`,
        ]
      : [`Send it now: ${figure(aboutEth(pay, price))}`, `You pay the whole batch's bridge fee, in ETH. Up to ${most} is sent; any extra is refunded.`];
  const need = ethNeeded(b);
  const short = b.ethWei !== undefined && b.ethWei < need;
  return { leaves, button: { label, note, ...(short ? { warning: needEthText(need, price) } : {}), disabled: short } };
}

/** v3.2 (R8): what the stake form says when a stake fits only once the open batch has left, so it offers to close the
 * batch first and then stake (stake-form.ts closeFirstNeeded; flows.ts planCloseFirst, which reads it all again at the
 * click): what the close costs, in plain words, and whether it can go now. The batch read (`batch`) not there yet, or
 * failing (`unread`), holds the button, as does a batch that can't close now, Bittensor's side not taking batches or not
 * checked, a bridge fee that can't be read, and a wallet short of the close's value and network fee. R9 (M-2): it says
 * first that the batch normally leaves on its own, at no cost (the keeper's next round sends a full one), and offers the
 * paid close only once the limits' reads (`after`) have found that same batch closable for CLOSE_FIRST_SEEN_MS, a
 * refresh apart; a batch closable by time alone (under half its limits) is called due, not full, the keeper perhaps
 * waiting on its fee rule. R9 (L-1): an open batch read that isn't the batch the limits read holds it too, and the
 * offer names its batch (`batchId`), the only one the click may close. R10 (M-1): so does a reading of the limits that
 * isn't fresh (`limits`: its last refresh failed, "unread", or it is older than two refreshes, "old": a hidden tab's),
 * since React Query goes on showing the last one; the click reads them again in any case (flows.ts closeFirst). */
export interface CloseFirstView {
  note: string;
  warning?: string;
  disabled: boolean;
  /** R9 (L-1): the batch the note was priced from, once the close is offered: the one the click may close
   * (use-flows.ts closeThenStake), never another. */
  batchId?: bigint;
}

/** R9 (M-2): how long reads must have found the same open batch closable (the limits' closableForMs) before a paid close
 * is offered: two reads a refresh apart (the limits are read every 30 seconds; 25 allows for a timer that fires a little
 * early). The keeper sends a full batch on its next round, at no cost to anyone, so the wait gives that round a chance
 * to come first. R10 (L-A): it doesn't show the keeper isn't sending it: the keeper's rounds are a minute apart, so 25
 * seconds may see none of them. It is a trade-off: a wait over 60 seconds would never be met by a batch a holder fills
 * just after each round and cancels from before the next (each cancel starts the clock again), and a close that lands
 * while it is full is what commits the holder's deposits (R8). */
export const CLOSE_FIRST_SEEN_MS = 25_000;

/** R12d: what the stake form says while a click on "Send the batch, then stake" reads the limits again because their
 * reading aged since the form last showed it (a tab just shown again): the click sends nothing, and says so. */
export const CLOSE_FIRST_RECHECKING = "Checking the batch again, so nothing was sent yet. Press the button again in a moment.";

/** R9 (M-2): the batch is full by its limits, and the keeper sends it on its next round for free. */
const FULL_LEAD = "The current batch is full. It normally leaves on its own within a minute or two, at no cost to you, and the next batch then has room for your stake";
/** R9 (M-2): it can close by time alone (under half its limits): due, not full, and the keeper may be waiting on its fee
 * rule (the batch's fees covering the bridge fee, or the max wait). */
const DUE_LEAD = "The current batch has no room for this stake. It is due to leave, but it isn't full, so the keeper may hold it for more fees before sending it at no cost to you";

export function closeFirstView(x: {
  batch?: OpenBatch;
  unread?: boolean;
  after: { batchId: bigint; due: "full" | "time"; closableForMs: number };
  limits?: "fresh" | "old" | "unread";
}): CloseFirstView {
  const b = x.batch;
  const lead = x.after.due === "time" ? DUE_LEAD : FULL_LEAD;
  const held = (why: string): CloseFirstView => ({ note: `${lead}. ${why}`, disabled: true });
  if (!b) return held(x.unread ? "We can't read the batch on Base right now, so it can't be sent from here yet." : "Checking what sending it costs…");
  if (b.paused) return { note: "Staking is paused right now. Try again later.", disabled: true };
  if (!b.canClose) return { note: "The current batch is full and can't be sent yet. Try again in a minute.", disabled: true };
  // R9 (L-1): the open batch isn't the one the limits found closable: it just left, or one read lags the other
  if (b.id !== x.after.batchId) return { note: "The batch may have just left. Checking the room again…", disabled: true };
  if (b.bittensor === "paused") return held("Bittensor's side isn't accepting batches right now, so it can't be sent from here; try again later.");
  if (b.bittensor !== "open") return held("We couldn't check Bittensor's side just now, so it can't be sent from here yet. Try again in a minute.");
  // R10 (M-1): the limits' clock counts only from a fresh reading of them
  if (x.limits === "unread") return held("We couldn't check the batch again just now, so it can't be sent from here yet.");
  if (x.limits === "old") return held("Checking whether it has left yet…");
  // R9 (M-2): the keeper's free close first: nothing is offered for a fee until reads a refresh apart still find it here
  if (x.after.closableForMs < CLOSE_FIRST_SEEN_MS) return held("If it hasn't left in a moment, you can send it yourself.");
  if (b.feeWei === undefined) {
    return held(
      b.feeUnconfirmed
        ? "The bridge fee couldn't be confirmed right now (our two sources for it disagree), so it can't be sent from here yet."
        : "We can't read the bridge fee right now, so it can't be sent from here yet.",
    );
  }
  const price = b.ethPriceUsd;
  const pay = feeToPay(b.feeWei, b.potWei);
  const value = sendNowValue(b.feeWei, b.potWei);
  const most = `Your wallet sends up to ${upToEth(value, price)} with the close`;
  const yourself = `${lead}. It hasn't left yet, so you can send it now yourself`;
  const note =
    pay === 0n
      ? `${yourself}: the fees already in it cover its bridge fee, so sending it now costs only Base's network fee for the two steps.${value > 0n ? ` ${most} in case the fee rises; anything extra is refunded.` : ""}`
      : `${yourself}: sending it now costs ${b.potWei > 0n ? "the part of its bridge fee its own fees don't cover" : "its bridge fee"}, ${aboutEth(pay, price)}, and Base's network fee for the two steps. ${most}; anything extra is refunded.`;
  const need = ethNeeded(b);
  const short = b.ethWei !== undefined && b.ethWei < need;
  return { note, ...(short ? { warning: needEthText(need, price) } : {}), disabled: short, batchId: b.id };
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
