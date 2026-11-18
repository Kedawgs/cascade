import { formatUnits, parseUnits } from "viem";
import { DELIVERY_TOLERANCE_BPS } from "./cascade/config";
import { type DeliveryLimit, deliverableRefusal, LIMIT_UNREAD, limitText, RECEIVE_TAO_POINTER, roomTaoWei, saysReceiveTao, WAITING_UNKNOWN, waitingText } from "./cascade/delivery-limit";
import { CLAIM_TAO_NOW, type StakeRoom } from "./cascade/flows";
import { impactNote } from "./cascade/impact";
import type { Available, DepositQuote, Limits, Position, RoundTripCosts, StakeProof, WithdrawalQuote, WithdrawalRecord } from "./cascade/types";
import { isDelivering, offersClaim, ORIGIN_ELSEWHERE, STAKE_MISSING } from "./cascade/trail";
import { ENTRY_FULL_TEXT, entryFull, floorRao, minUnstakeText, REST_LATER, toDisplay, type UnstakeCheck } from "./cascade/units";
import { formatTao, formatUsd, formatUsdc, formatUsdcCents, formatUsdShort } from "./format";
import type { SentNotice } from "./sent";

/** What the unstake amount is typed in: TAO, or its value in USDC. */
export type UnstakeUnit = "TAO" | "USDC";

/** TAO on buttons: at least 2 decimals, up to 6 (the most the field takes), so 0.005 stays 0.005. */
const taoLabel = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** Floors to `decimals` places; the tiny nudge keeps 0.29 * 1e6 from flooring to 289999. */
const floorTo = (n: number, decimals: number) => Math.floor(n * 10 ** decimals + 1e-7) / 10 ** decimals;

/** What the stake and unstake buttons need to know to name themselves. */
export type StakeState = {
  account: string | null;
  amount: number | null;
  /** An unstake typed as a USDC value: the button names the dollars. */
  usd?: number;
  /** v3: the stake button names the amount in dollars ("Stake $20"). */
  dollars?: boolean;
  /** v3.2 (R8): the stake goes after a close of the full open batch the site sends first (closeFirstNeeded). */
  closeFirst?: boolean;
  error: string | null;
  pending: boolean;
};

/** Why no stake fits right now, by the limit that is reached. */
const FULL_TEXT = {
  cap: "Cascade is full for now. Try again later.",
  batch: "The current batch is full. A new one opens once it leaves, so try again soon.",
} as const;

type StakeLimits = Pick<Limits, "minUsd" | "maxUsd" | "full"> & { afterClose?: Pick<NonNullable<Limits["afterClose"]>, "maxTao" | "maxUsd"> };

export function validateStakeAmount(
  amount: number | null,
  limits: StakeLimits,
  /** The wallet's USDC balance when known; null skips the check. */
  balance: number | null = null,
): string | null {
  if (amount === null) return null;
  if (limits.full) return FULL_TEXT[limits.full];
  if (amount < limits.minUsd) return `The smallest stake is ${formatUsdShort(limits.minUsd)}.`;
  if (amount > limits.maxUsd) {
    return `The most you can stake right now is ${formatUsdShort(limits.maxUsd)}.`;
  }
  if (balance !== null && amount > balance + 1e-9) {
    return `You have ${formatUsdc(balance)} USDC on Base.`;
  }
  return null;
}

/** Under the amount before anything is typed: the range a stake can be, or why there is none. */
export function stakeLimitsNote(limits: StakeLimits): string {
  return limits.full ? FULL_TEXT[limits.full] : `From ${formatUsdShort(limits.minUsd)} to ${formatUsdShort(limits.maxUsd)}`;
}

/** What the stake form says under the amount: why it can't be staked (an error), or else the range a
 * stake can be, or why that isn't known yet. `balance` is the wallet's USDC when known (null skips that
 * check). */
export function stakeFormNote(
  amount: number | null,
  limits: { data?: StakeLimits; isError: boolean },
  balance: number | null,
): { error: string | null; note: string } {
  const error = limits.data ? validateStakeAmount(amount, limits.data, balance) : null;
  const range = limits.data ? stakeLimitsNote(limits.data) : limits.isError ? "Limits unavailable right now" : "Checking the limits…";
  return { error, note: error ?? range };
}

/** The stake form's amount, as typed, and the stake that just went through (the panel confirming it). */
export interface StakeFormState {
  raw: string;
  sent: SentNotice | null;
}

export type StakeFormEvent = { type: "edit"; raw: string } | { type: "sent"; notice: SentNotice } | { type: "dismiss" };

/** A stake that goes through clears the amount at once and opens the panel confirming it. The balance and
 * the limits are read again right after it (useFlows), and they count the stake just made: the amount left
 * in place would read as more than the wallet holds, or than the batch has room for, an error flashing red
 * after a stake that worked. */
export function stakeFormReducer(s: StakeFormState, e: StakeFormEvent): StakeFormState {
  if (e.type === "edit") return { ...s, raw: e.raw };
  if (e.type === "sent") return { raw: "", sent: e.notice };
  return { ...s, sent: null };
}

/** v3.2 (R8, the contracts review's L-1): whether a stake of `amount` dollars can't go into the open batch (it is full, or
 * the amount is over what is left in it) but fits once it has left (limits' afterClose: the open batch can close, and the
 * cap has the room), so the form offers to close the batch first and then stake. Never for a full cap: a close frees none
 * of it (the cap counts the open batch already). The balance, when known, must cover it. */
export function closeFirstNeeded(amount: number | null, limits: StakeLimits | undefined, balance: number | null = null): boolean {
  const after = limits?.afterClose;
  if (amount === null || !limits || !after || limits.full === "cap") return false;
  if (amount < limits.minUsd || amount > after.maxUsd) return false;
  if (balance !== null && amount > balance + 1e-9) return false;
  return limits.full === "batch" || amount > limits.maxUsd;
}

/** v3.2 (R9, L-1): the room for a stake of `amount` dollars by the limits read again at the click (flows.ts closeFirst):
 * the open batch takes it now ("now": the batch left, or a cancel made room, since the form's read: no close is sent), it
 * fits only once the batch has left ("after-close", closeFirstNeeded), or neither ("none": the cap filled, the next
 * batch's room shrank, or the batch can no longer close; a close paid for then would only strand the stake). */
export function stakeRoom(amount: number, limits: StakeLimits): StakeRoom {
  if (validateStakeAmount(amount, limits) === null) return "now";
  return closeFirstNeeded(amount, limits) ? "after-close" : "none";
}

/** What MAX types into the USDC field: the balance floored to whole cents, never more than it holds,
 * nor more than the most a stake can be right now (`most`, when the limits are known). */
export function maxStakeInput(balance: number, most?: number): string {
  return floorTo(Math.min(balance, most ?? Infinity), 2).toFixed(2);
}

/** What the stake form's MAX types, or null while it can't offer one: the balance or the limits not
 * read yet (before the limits, MAX would type the whole balance, past the most a stake can be). With
 * no room at all it types the balance, and the form says why that can't be staked. */
export function stakeMaxInput(balance: number | null, limits: StakeLimits | undefined): string | null {
  if (balance === null || !limits) return null;
  // v3.2 (R8): a full batch the site can close first: MAX types the most the next batch takes
  if (limits.full === "batch" && limits.afterClose) return maxStakeInput(balance, limits.afterClose.maxUsd);
  return maxStakeInput(balance, limits.full ? undefined : limits.maxUsd);
}

/** 1e-6 TAO in wei: the finest step a TAO amount is shown in. */
const MICRO_TAO = 10n ** 12n;

/** Why TAO sitting in the wallet can't be deposited as it is, or null when it can. Its figures are cut
 * to the 6 decimals shown the safe way, as the unstake button's are: the most rounded down, the least
 * up, so neither names an amount that wouldn't go in. */
export function walletTaoNote(tao: bigint, limits: Pick<Limits, "minTao" | "maxTao" | "full">): string | null {
  if (tao < limits.minTao) {
    const least = ((limits.minTao + MICRO_TAO - 1n) / MICRO_TAO) * MICRO_TAO;
    return `Deposits start at ${taoLabel.format(toDisplay(least, 18))} TAO.`;
  }
  if (tao <= limits.maxTao) return null;
  if (limits.maxTao < limits.minTao && limits.full) return FULL_TEXT[limits.full];
  return `Deposits take at most ${taoLabel.format(floorTo(toDisplay(limits.maxTao, 18), 6))} TAO right now.`;
}

/** R6 (ChatGPT R2 claim B): whoever controls a contract wallet's address on Bittensor can withdraw its stake there
 * (contracts/README.md, "Who can use direct access"), and that need not be the wallet's owner on Base: said plainly. */
export const CONTRACT_WALLET_NOTE =
  "This wallet is a contract account: it can leave only through Unstake here, and its address on Bittensor may belong to someone else, who could withdraw its stake there. A regular wallet avoids this.";

/** R6 (ChatGPT R2 claim B): a stake into an address whose redeem origin is already Bittensor (DIRECT_ORIGIN, or another
 * chain's door) still mints, but the shares can then leave only on Bittensor, by whoever controls the address there. */
export const ORIGIN_DEPOSIT_NOTE =
  "This address withdraws on Bittensor, not here, so a new stake could leave only there, by whoever controls the address on Bittensor. Set Base as its withdrawal chain from Bittensor first, or use another wallet.";

/** The warning before a stake into an address that already withdraws on Bittensor (live.ts getPosition), or null. */
export const originDepositNote = (p: Pick<Position, "withdrawsOnBittensor"> | undefined): string | null => (p?.withdrawsOnBittensor ? ORIGIN_DEPOSIT_NOTE : null);

/** What the stake form knows of the connected wallet: its code on Base, its wagmi connector, and
 * whether it says it runs a batch atomically there (atomicOf). */
export interface WalletKind {
  code?: string;
  connectorId?: string;
  atomic?: string;
}

/** Whether a wallet runs a batch atomically on Base, from its EIP-5792 capabilities for Base: the
 * current `atomic.status` ("supported", or "ready" for a key account it would first upgrade), or the
 * older `atomicBatch.supported`. */
export function atomicOf(caps: unknown): string | undefined {
  const c = caps as { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } } | undefined;
  return c?.atomic?.status ?? (c?.atomicBatch?.supported ? "supported" : undefined);
}

/** What a stake from this wallet should know first: nothing for a plain key account or an EIP-7702 one
 * (code 0xef0100 + the delegate's address: a key account that can still act on Bittensor), nor while
 * its code isn't known. Any other contract account can only leave through the front door: one with
 * code, a Base Account (a smart account, though it has no code until its first transaction), or one
 * with no code that runs batches atomically (a key account can't without a delegation, which is code). */
export function contractWalletNote(w: WalletKind): string | null {
  if (w.connectorId === "baseAccount") return CONTRACT_WALLET_NOTE;
  if (w.code === undefined) return null;
  if (w.code !== "0x") return w.code.toLowerCase().startsWith("0xef0100") ? null : CONTRACT_WALLET_NOTE;
  return w.atomic === "supported" ? CONTRACT_WALLET_NOTE : null;
}

/** Where "Stake again at today's price" goes: the stake form with the same amount typed in, when it is known. */
export function stakeAgainHref(amountUsd?: number): string {
  return amountUsd !== undefined && amountUsd > 0 ? `/stake?amount=${amountUsd.toFixed(2)}` : "/stake";
}

/** The amount a link may type into the stake form (`/stake?amount=20.00`): plain dollars, to the cent;
 * anything else types nothing. The form then quotes it afresh and checks it like anything typed. */
export function stakeAmountParam(raw: string | null): string {
  return raw !== null && /^\d{1,9}(\.\d{1,2})?$/.test(raw) ? raw : "";
}

export function stakeButtonLabel(s: StakeState): string {
  if (!s.account) return "Connect wallet";
  if (s.pending) return "Confirm in your wallet…";
  if (s.amount !== null && s.amount > 0 && s.error === null) {
    const stake = s.dollars ? `Stake ${formatUsdShort(s.amount)}` : `Stake ${formatUsdc(s.amount)} USDC`;
    return s.closeFirst ? `Send the batch, then ${stake.charAt(0).toLowerCase()}${stake.slice(1)}` : stake;
  }
  return "Stake";
}

/** v3: Cascade's fees on a stake, "$0.05 + 0.15%": the flat fee, and the percentage read back from the
 * quote (the chain floors the swap fee, so it is rounded to hundredths of a percent). */
export function cascadeFeesText(q: Pick<DepositQuote, "usdcIn" | "depositFeeUsdc" | "swapFeeUsdc">): string {
  const parts: string[] = [];
  if (q.depositFeeUsdc > 0n) parts.push(formatUsdShort(toDisplay(q.depositFeeUsdc, 6)));
  const rate = swapFeeRate(q);
  if (rate > 0) parts.push(`${Number((rate * 100).toFixed(2))}%`);
  return parts.length > 0 ? parts.join(" + ") : "None";
}

/** Cascade's percentage fee as a fraction of what it is taken from (the USDC after the flat fee). */
function swapFeeRate(q: Pick<DepositQuote, "usdcIn" | "depositFeeUsdc" | "swapFeeUsdc">): number {
  const base = q.usdcIn - q.depositFeeUsdc;
  return base > 0n ? toDisplay(q.swapFeeUsdc, 6) / toDisplay(base, 6) : 0;
}

/** The pools' fees on the way in (and out), in percent: USDC –0.05%→ WETH –0.3%→ TAO keeps
 * 0.9995 × 0.997, so about 0.35% goes to the pools. The stake form, the break-even line and the FAQ
 * all read it from here. */
export const POOL_FEE_PCT = 0.35;
export const POOL_FEES_TEXT = `about ${POOL_FEE_PCT}%`;
const EXIT_POOL_FEE = POOL_FEE_PCT / 100;

/** v3: about how many days of yield pay for a round trip: this stake's Cascade and pool fees, plus an
 * estimated way out (Cascade's percentage fee and the pools' again on what was staked, the unstake
 * request fee and the bridge fee back), earned on what was staked at the yield less Cascade's cut
 * of rewards. Null without an amount or a yield. */
export function breakEvenDays(
  q: Pick<DepositQuote, "usdcIn" | "amountUsd" | "feesUsd" | "depositFeeUsdc" | "swapFeeUsdc">,
  exit: RoundTripCosts,
  yieldPct: number,
): number | null {
  const staked = Math.max(0, q.amountUsd - q.feesUsd);
  const perDay = (staked * yieldPct * (1 - exit.rewardCutBps / 10_000)) / 100 / 365;
  if (!(perDay > 0)) return null;
  const out = staked * (swapFeeRate(q) + EXIT_POOL_FEE) + exit.exitFixedUsd;
  return Math.max(1, Math.round((q.feesUsd + out) / perDay));
}

/** "You will stake": on v3 the quote's estimate and the least the stake accepts (its 0.5% floor,
 * rounded down to the 0.0001 TAO shown); on v2 the exact amount the swap buys. */
export function stakeAmountText(q: Pick<DepositQuote, "estTao" | "minTaoOut">, v3: boolean): string {
  if (!v3) return `${formatTao(q.estTao, 4)} TAO`;
  const least = Number(q.minTaoOut / 10n ** 14n) / 1e4;
  return `about ${formatTao(q.estTao, 4)} TAO (at least ${formatTao(least, 4)} TAO)`;
}

/** The line under the stake form. v3 says nothing about how many wallet prompts to expect (that
 * depends on the wallet); v2 keeps its wording. */
export function stakeFootText(v3: boolean): string {
  return v3 ? "No Bittensor wallet needed." : "Your wallet asks you to confirm each step, or just once with a smart account. No Bittensor wallet needed.";
}

export function breakEvenText(days: number): string {
  return `Covers its fees in about ${days} day${days === 1 ? "" : "s"} at today's yield.`;
}

/** v3: the least USDC an unstake's automatic delivery pays, as the line under the button says it: the
 * TAO that comes back at the minimum price, floored to the cent. The bridge fee is only known when the
 * payout is sent, so today's is padded by a quarter; this is the figure shown, not the one sent. */
export function deliveryFloorUsd(q: Pick<WithdrawalQuote, "taoWei" | "bridgeFeeWei" | "minUsdcPerTao">): number {
  const bridgeFee = (q.bridgeFeeWei * 5n) / 4n;
  const tao = q.taoWei > bridgeFee ? q.taoWei - bridgeFee : 0n;
  const units = (tao * q.minUsdcPerTao) / 10n ** 18n;
  return toDisplay((units / 10_000n) * 10_000n, 6);
}

/** v3: the line under the unstake button; the floor once a quote has named it. */
export function deliveryNote(floorUsd: number | null): string {
  if (floorUsd === null) return "USDC arrives in your wallet automatically.";
  return `USDC arrives in your wallet automatically, at least ${formatUsd(floorUsd)} (today's price less ${DELIVERY_TOLERANCE_BPS / 100}%). If the price falls further, you can claim by hand.`;
}

/** v3: an unstake whose USDC is to be delivered automatically, with a step still being checked against
 * the chain ("checking": its arrival or its return rests on the history indexer's word): it may be
 * delivering what waits on Base right now, so the claim by hand isn't suggested meanwhile. */
const mayBeDelivering = (r: WithdrawalRecord): boolean => r.awaitingDelivery === true && r.steps.some((s) => s.status === "checking");

/** Whether the Stake page offers "Claim as USDC" for what is waiting on Base: whenever something is,
 * except on v3 while an unstake's USDC is being delivered automatically (delivery sells everything
 * waiting at once), or may be while its steps are still being checked (claimChecking), and no unstake
 * offers the claim by hand. While the unstakes load that isn't known, so v3 waits; if they can't be read
 * it offers the claim, which needs only Base. */
export function offerClaim(
  claimable: bigint,
  v3: boolean,
  withdrawals: readonly WithdrawalRecord[] | undefined,
  unreadable = false,
): boolean {
  if (claimable === 0n) return false;
  if (!v3) return true;
  if (!withdrawals) return unreadable;
  if (withdrawals.some(offersClaim)) return true;
  return !withdrawals.some((w) => isDelivering(w) || mayBeDelivering(w));
}

/** v3: something waits on Base while an unstake that may be delivering it is still being checked (and
 * none is known to be delivering, nor offers the claim): the Stake page suggests no claim, but claiming
 * it as TAO stays within reach, as claiming always is. */
export function claimChecking(claimable: bigint, v3: boolean, withdrawals: readonly WithdrawalRecord[] | undefined): boolean {
  if (claimable === 0n || !v3 || !withdrawals) return false;
  if (withdrawals.some(offersClaim) || withdrawals.some(isDelivering)) return false;
  return withdrawals.some(mayBeDelivering);
}

export const CLAIM_CHECKING =
  "One of your unstakes is still being checked against the chain, and this may already be on its way to your wallet as USDC. You can still claim it as TAO now.";

/** v3.2 with USDC delivery off (the founder's switch, spec §5): the claim banner for whatever waits on Base, whether or
 * not an unstake's USDC is being delivered (the keeper may still deliver: a claim now, kept as TAO, clears the
 * preference first), with the prompt while the chain holds a delivery preference for the account, or that can't be
 * told yet (unknown taken as set, as N3). Null with nothing to claim: claim() refuses NothingToClaim. */
export function deliveryOffClaim(claimable: bigint, preference: { data?: boolean; isError: boolean }): { prompt: string | null } | null {
  if (claimable === 0n) return null;
  return { prompt: preference.isError || preference.data !== false ? CLAIM_TAO_NOW : null };
}

/** v3.2 with USDC delivery off (Task 60 follow-up): the button that clears the account's preference at once
 * (use-flows.ts turnOffDelivery), the controller's words, and the line beside it while nothing is claimable yet. */
export const TURN_OFF_DELIVERY = "Turn off USDC delivery for my account";
export const DELIVERY_IS_OFF = "USDC delivery is off.";

/** Whether to offer turning off USDC delivery for the account: only with the switch off, while the chain holds its
 * preference or its read failed (unknown means offer it). Not while the read is loading: it would appear and vanish for
 * every account without one. Whether anything is claimable doesn't matter: a claim can't clear a preference until a
 * payout lands (claim() refuses NothingToClaim), this can. */
export function turnOffDeliveryOffered(usdcDelivery: boolean, preference: { data?: boolean; isError: boolean }): boolean {
  return !usdcDelivery && (preference.isError || preference.data === true);
}

/** v3: a claim by hand clears the account's delivery preference (CascadeFrontDoor.claim), so the claim
 * banner says so while any unstake is still on its way with automatic delivery ahead of it. */
export function claimEndsDelivery(v3: boolean, withdrawals: readonly WithdrawalRecord[] | undefined): boolean {
  return v3 && (withdrawals ?? []).some((w) => w.awaitingDelivery === true);
}

export const CLAIM_ENDS_DELIVERY =
  "Claiming now also turns off automatic delivery for unstakes still on their way: you'll claim those by hand when they arrive.";

/** What MAX types into the TAO field: the exact available amount, floored to six decimals. */
export function maxUnstakeInput(taoWei: bigint): string {
  const floored = (taoWei / 10n ** 12n) * 10n ** 12n;
  return formatUnits(floored, 18);
}

/** The unstake form's button. In the TAO view (`asTao`: the person's choice, or USDC delivery off) it says what the
 * request is, "Receive ... TAO", never the USDC view's "Unstake ...": the two views' buttons can't be taken for each
 * other (review of f9c59861, finding 6). */
export function unstakeButtonLabel(s: StakeState, x: { asTao?: boolean } = {}): string {
  if (!s.account) return "Connect wallet";
  if (s.pending) return "Confirm in your wallet…";
  const ok = s.amount !== null && s.amount > 0 && s.error === null;
  if (x.asTao) return ok ? `Receive ${taoLabel.format(floorTo(s.amount as number, 6))} TAO` : "Receive TAO";
  if (ok) {
    return s.usd !== undefined ? `Unstake ${formatUsd(s.usd)}` : `Unstake ${taoLabel.format(floorTo(s.amount as number, 6))} TAO`;
  }
  return "Unstake";
}

/** The TAO (wei) an unstake asks for: typed in TAO, or a USDC value converted at `priceUsd` and
 * floored to whole rao. Null for nothing, zero or unreadable input. */
export function unstakeRequestWei(raw: string, unit: UnstakeUnit, priceUsd: number): bigint | null {
  if (raw.trim() === "") return null;
  try {
    if (unit === "TAO") {
      const wei = parseUnits(raw, 18);
      return wei > 0n ? wei : null;
    }
    if (!(priceUsd > 0)) return null;
    const usd = parseUnits(raw, 6);
    if (usd <= 0n) return null;
    const wei = floorRao((usd * 10n ** 18n) / BigInt(Math.round(priceUsd * 1e6)));
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

/** The unstake form's amount: as typed, everything that can be unstaked (`all`, after MAX), or the exact
 * TAO a unit switch or MAX carried over (`pinned`, until the amount is edited). */
export interface UnstakeFormState {
  raw: string;
  all: boolean;
  pinned: bigint | null;
}

/** The unstake form once an unstake has gone through: empty, at once. What can be unstaked is read again
 * right after (useFlows) and counts the request just made, so the amount left in place would read as
 * more than can be unstaked (or, after MAX, as nothing entered): an error flashing red after an unstake
 * that worked. */
export const UNSTAKE_FORM_CLEARED: UnstakeFormState = { raw: "", all: false, pinned: null };

/** The TAO (wei) the unstake form asks for, or null with nothing to ask. */
export function unstakeFormRequest(s: UnstakeFormState, unit: UnstakeUnit, availableWei: bigint, priceUsd: number): bigint | null {
  return s.all ? availableWei : (s.pinned ?? unstakeRequestWei(s.raw, unit, priceUsd));
}

/** The amount in the other unit, shown under the field: "≈ $1.26" or "≈ 0.0396 TAO". */
export function unstakeEquivalent(taoWei: bigint, typedIn: UnstakeUnit, priceUsd: number): string {
  const tao = toDisplay(taoWei, 18);
  return typedIn === "TAO" ? `≈ ${formatUsd(tao * priceUsd)}` : `≈ ${formatTao(tao, 4)} TAO`;
}

/** The TAO MAX asks for: the whole stake, or with a per-unstake limit (`mostWei`, units.unstakeMostWei)
 * at most that, leaving at least the minimum unstake (`minWei`, the deployment's: config.minUnstakeWei, always
 * given) behind so what stays can be unstaked later. Null, so MAX fills nothing, when that
 * comes to less than the minimum (the open batch's request is already at the limit) or there is nothing to
 * unstake: never zero or less. */
export function unstakeMaxWei(availableWei: bigint, mostWei: bigint | undefined, minWei: bigint): bigint | null {
  if (availableWei <= 0n) return null;
  if (mostWei === undefined || availableWei <= mostWei) return availableWei;
  const leavingMin = availableWei - minWei;
  const max = leavingMin < mostWei ? leavingMin : mostWei;
  return max >= minWei ? max : null;
}

/** What MAX types in the unit shown: exact TAO (six decimals), or its USDC value floored to cents. */
export function maxUnstakeInputIn(taoWei: bigint, unit: UnstakeUnit, priceUsd: number): string {
  if (unit === "TAO") return maxUnstakeInput(taoWei);
  return floorTo(toDisplay(taoWei, 18) * priceUsd, 2).toFixed(2);
}

/** Switching the unit shows the same request in the other unit and pins its exact TAO, so a
 * round trip through cents never changes what is sent. */
export function switchUnstakeUnit(
  request: bigint | null,
  unit: UnstakeUnit,
  priceUsd: number,
): { unit: UnstakeUnit; raw: string; pinned: bigint | null } {
  const next: UnstakeUnit = unit === "TAO" ? "USDC" : "TAO";
  return { unit: next, raw: request === null ? "" : maxUnstakeInputIn(request, next, priceUsd), pinned: request };
}

/** The dollars an unstake typed in USDC names on its button. A fixed amount (carried over by a unit
 * switch, or MAX) sends exact TAO, so its dollars follow the current price; otherwise they are the
 * dollars typed. Undefined when the button should name TAO. */
export function unstakeLabelUsd(s: {
  unit: UnstakeUnit;
  raw: string;
  fixed: boolean;
  requestWei: bigint | null;
  priceUsd: number;
}): number | undefined {
  if (s.unit !== "USDC" || s.requestWei === null) return undefined;
  if (s.fixed) return s.priceUsd > 0 ? floorTo(toDisplay(s.requestWei, 18) * s.priceUsd, 2) : undefined;
  const typed = Number(s.raw);
  return Number.isFinite(typed) && typed > 0 ? typed : undefined;
}

/** Dollars, floored to cents: what can be unstaked never reads higher than it is. */
const usdDown = (taoWei: bigint, priceUsd: number) => formatUsd(floorTo(toDisplay(taoWei, 18) * priceUsd, 2));
/** The minimum in dollars, rounded up to the cent so typing the figure shown is always enough. */
const MIN_USD = (priceUsd: number, minWei: bigint) => `about ${formatUsd(Math.ceil(toDisplay(minWei, 18) * priceUsd * 100 - 1e-7) / 100)}`;

/** "One unstake can carry up to $2,475.00 (9.9 TAO); unstake the rest a day later (…)", in the unit shown. */
function oneUnstakeText(mostWei: bigint, unit: UnstakeUnit, priceUsd: number): string {
  const tao = `${maxUnstakeInput(mostWei)} TAO`;
  return `One unstake can carry up to ${unit === "USDC" && priceUsd > 0 ? `${usdDown(mostWei, priceUsd)} (${tao})` : tao}; ${REST_LATER}`;
}

/** The line under the unstake field: how much can go and the minimum (`minWei`, the deployment's, always given),
 * in the unit shown and in that unit alone: typing dollars, the minimum is in dollars; its TAO figure shows once the
 * field is switched to TAO (the founder, 2026-11-18: beside a dollar field, "(0.033 TAO)" read as the amount to
 * type). A stake larger than one unstake can carry (`mostWei`) says so instead. */
export function unstakeNote(availableWei: bigint, unit: UnstakeUnit, priceUsd: number, mostWei: bigint | undefined, minWei: bigint): string {
  const minTao = minUnstakeText(minWei);
  if (availableWei >= minWei && entryFull(availableWei, mostWei, minWei)) return `${ENTRY_FULL_TEXT}.`;
  if (mostWei !== undefined && availableWei > mostWei) {
    const min = unit === "USDC" && priceUsd > 0 ? MIN_USD(priceUsd, minWei) : minTao;
    return `${oneUnstakeText(mostWei, unit, priceUsd)}. The minimum is ${min}.`;
  }
  if (unit === "USDC" && priceUsd > 0) {
    return `You can unstake up to ${usdDown(availableWei, priceUsd)}. The minimum is ${MIN_USD(priceUsd, minWei)}.`;
  }
  return `You can unstake up to ${maxUnstakeInput(availableWei)} TAO. The minimum is ${minTao}.`;
}

/** v3.2: why no stake can be sent right now, in plain words, or null when one can (the stake form then holds its
 * button): stake is missing (the vault lens reads it; StakeProof only says so on v3.2), so a stake sent now would only
 * park until Cascade is reconnected, beside the site's own notice that staking is paused (Task 59 review, Minor 2).
 * Not read yet, or not missing: the form as before. */
export const stakeHold = (proof: Pick<StakeProof, "stakeMissing"> | undefined): string | null => (proof?.stakeMissing ? STAKE_MISSING : null);

/** v3.2: why no unstake can be requested right now, in plain words, or null when one can (the form then holds its
 * button): the account's shares withdraw elsewhere (their redeem origin isn't Base's, so the vault would skip the
 * request and its fee would be spent for nothing: Review Focus 4), said first since setting Base from Bittensor is
 * the user's to do; or stake is missing (the vault refuses every delivery until Cascade is reconnected). */
export function requestHold(a: Pick<Available, "originElsewhere" | "stakeMissing"> | null): string | null {
  if (a?.originElsewhere) return ORIGIN_ELSEWHERE;
  if (a?.stakeMissing) return STAKE_MISSING;
  return null;
}

/** v3.2's unstake form on the window (spec §3.5, §7): one daily allowance is shared by every unstake, first come;
 * the part of a request over what is left of it stays staked, to be asked for again. */
export const UNSTAKE_WINDOW_NOTE = "Unstakes share a daily limit; any part over it stays staked, and you unstake it again a day later.";

/** What the unstake form says it pays. On v3.2 the leaver pays every cost of its exit (spec Revision 23,
 * design-leaver-pays.md): the payout's entries also bear the cost of the walk that unstakes them, a fee the chain
 * charges on a removal, unknowable at request time and none today, so the quote says it is less that share. */
export const unstakeReceiveText = (usdcAmount: number, v32: boolean): string =>
  `about ${formatUsdcCents(usdcAmount)} USDC${v32 ? ", less its share of any unstake fee the chain charges (none today)" : ""}`;

/** Why an amount can't be unstaked, in dollars when the user types dollars (`minWei`, the deployment's minimum,
 * always given). */
export function unstakeErrorText(
  check: Extract<UnstakeCheck, { ok: false }>,
  availableWei: bigint,
  unit: UnstakeUnit,
  priceUsd: number,
  mostWei: bigint | undefined,
  minWei: bigint,
): string {
  if (unit !== "USDC" || !(priceUsd > 0)) return check.reason;
  switch (check.code) {
    case "overEntry":
      return mostWei !== undefined ? `${oneUnstakeText(mostWei, unit, priceUsd)}.` : check.reason;
    case "tooMuch":
      return `That's more than you can unstake (up to ${usdDown(availableWei, priceUsd)}).`;
    case "belowMin":
      return `The minimum unstake is ${MIN_USD(priceUsd, minWei)}.`;
    case "leavesDust":
      return `That would leave less than ${MIN_USD(priceUsd, minWei)} staked, too little to unstake later.`;
    case "stakeBelowMin":
      return `Your stake is below the minimum unstake of ${MIN_USD(priceUsd, minWei)}.`;
    default:
      return check.reason;
  }
}

/** The unstake form's red line when its quote can't be read: the USDC sale's quote, so it says the amount can't go. */
export const QUOTE_FAILED = "This amount can't be sent back right now";

/** The unstake form's red line under the amount: the amount check's own refusal (`checkError`, unstakeErrorText), else
 * a quote that couldn't be read (QUOTE_FAILED). In the TAO-only form (v3.2 with USDC delivery off, `taoOnly`) the
 * check's alone: the quote is the USDC sale's (the pools, the fees, the prices), which Receive TAO doesn't need, and it
 * can fail exactly when the pools can't be trusted, so it says nothing above the one way out (Task 60 review,
 * Important 2). Null when nothing is wrong. */
export function unstakeFormError(x: { checkError: string | null; quoteFailed: boolean; taoOnly: boolean }): string | null {
  if (x.checkError !== null) return x.checkError;
  return x.quoteFailed && !x.taoOnly ? QUOTE_FAILED : null;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A wait for the stake form: minutes up to 90, hours up to 36, then days ("about 27 minutes", "about 3 hours", "about 2 days"). */
export function etaText(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m <= 90) return `about ${plural(m, "minute")}`;
  if (m <= 36 * 60) return `about ${plural(Math.round(m / 60), "hour")}`;
  return `about ${plural(Math.round(m / 1_440), "day")}`;
}

/** A wait for the unstake form: hours as the smallest unit, days past 36 hours. */
export function unstakeEtaText(minutes: number): string {
  const h = Math.max(1, Math.round(minutes / 60));
  return h <= 36 ? `about ${plural(h, "hour")}` : `about ${plural(Math.round(h / 24), "day")}`;
}

// ---- v3.2's unstake form (Task 59a): USDC within the live delivery limit and the impact cap; Receive TAO always open ----

/** The way out that sells nothing: v3.2's unstake as TAO, claimed on Base by hand (use-flows.ts receiveTao). The front
 * door keeps one delivery preference per account and deliver sells everything credited to it, so a later USDC request
 * would sell this TAO too (Task 59a review, C1).
 * It is no longer a second button under the form (the founder, 2026-11-18: "I dont think we need all this ... it maybe
 * should just be a link in other ways out"): it is the form itself, switched to TAO from a link under "Other ways
 * out" (AS_TAO_LINK), and from RECEIVE_TAO_LABEL right where a USDC unstake is refused, so the way out that needs no
 * sale is one step away whenever the sale can't go. Switched, the form is the one USDC delivery off shows: one
 * button, Receive TAO's. */
export const RECEIVE_TAO_LABEL = "Receive TAO instead";
/** Unstake's other ways out: the link that switches the form to TAO, and what follows it. */
export const AS_TAO_LINK = "Receive TAO instead of USDC";
export const AS_TAO_NOTE = "nothing is sold; your TAO comes back to Base for you to claim.";
/** The same place once the form is switched to TAO: the way back. */
export const AS_USDC_LINK = "Unstake to USDC";
export const AS_USDC_NOTE = "your TAO is sold on Base and the USDC is sent to your wallet.";
/** Under the switched form's button: the way back, beside it. */
export const BACK_TO_USDC_LABEL = "Unstake to USDC instead";
/** The same with USDC delivery off (Task 60): no USDC unstake is offered, so nothing later would sell it. */
export const RECEIVE_TAO_NOTE_OFF = "Nothing is sold: your TAO comes back to Base for you to claim.";
/** Receiving TAO clears the account's USDC delivery preference (flows.ts receiveTaoCall), as a claim does. */
export const RECEIVE_ENDS_DELIVERY = "This also turns off automatic USDC delivery for your other unstakes: you'll claim those by hand.";
/** The folded part of the form (the founder, 2026-11-18: "this unstake page text is really too much going on"): how a
 * USDC unstake's sale goes, what a later USDC unstake does to TAO received now, and the daily limit sit under one
 * heading, closed until asked for. What decides or refuses a click stays in the open. */
export const UNSTAKE_MORE_LABEL = "How unstaking works";
export const RECEIVE_TAO_LATER = "If this TAO is still waiting to be claimed when you next unstake to USDC, it is sold too.";

/** The Unstake page's heading. v3-launch's says USDC, its one way out; v3.2's fits both, USDC and Receive TAO (Task 59a
 * review, M9), and with USDC delivery off (Task 60) only TAO. */
export function unstakeHeading(x: { v32: boolean; usdcDelivery: boolean }): { title: string; sub: string } {
  if (!x.v32) return { title: "Unstake to USDC", sub: "We sell your staked TAO and send the USDC back to the same wallet." };
  return {
    title: "Unstake",
    sub: x.usdcDelivery ? "Your staked TAO comes back to the same wallet on Base, as USDC or as TAO." : "Your staked TAO comes back to the same wallet on Base, as TAO to claim.",
  };
}

/** v3.2: when a USDC unstake's TAO is sold, and what happens if it can't be (the founder's C-L2 decision and the
 * queued-deliveries question of 2026-11-05), marked as the USDC path's (Task 59a review, M9): back on Base after the
 * batch, the bridges and the safety wait (the quote's ETA, when known), sold one sale at a time by the keeper, and if
 * the market doesn't allow it, left on Base to claim whenever the user likes. */
export function deliveryLaterText(etaMinutes: number | undefined): string {
  const when = etaMinutes !== undefined ? `With USDC, your TAO is back on Base in ${unstakeEtaText(etaMinutes)} and sold then` : "With USDC, your TAO is sold once it is back on Base";
  return `${when}, one sale at a time, so a busy day can take longer. If the market doesn't allow a sale, your TAO stays on Base for you to claim any time.`;
}

/** The unit the unstake amount is typed in: on v3.2 while TAO's price can't be read, TAO (no dollar figure can be
 * converted, and Receive TAO needs none: Task 59a review, M6), and with USDC delivery off (nothing is sold, so no dollar
 * figure is asked for: Task 60); otherwise the one chosen. */
export const shownUnstakeUnit = (unit: UnstakeUnit, x: { v32: boolean; priceMissing: boolean; usdcDelivery?: boolean }): UnstakeUnit =>
  x.v32 && (x.priceMissing || x.usdcDelivery === false) ? "TAO" : unit;

/** What v3.2's unstake form offers right now: the USDC unstake's button; before it, what else of the account's a USDC
 * unstake sells (`warning`); its lines (the quote's price impact and the live delivery limit, each a note or the reason
 * it is refused); and Receive TAO, with whether it also ends an automatic USDC delivery (`endsDelivery`). */
export interface UnstakeActions {
  usdc: boolean;
  warning: string | null;
  notes: { text: string; refused: boolean }[];
  tao: { offered: boolean; enabled: boolean; endsDelivery: boolean };
}

/** The unstake form's ways out. On v3.2 a USDC unstake goes only once its quote is in, its price impact is within the
 * cap (impact.ts), and the live limit is read and its sale under it (delivery-limit.ts): over it, with no USDC delivery
 * to be had, or the limit unreadable (fail closed, a failed refetch's stale figures included: M4), it is refused, saying
 * why. Whenever the account has TAO waiting (its request in the open batch, its payouts on their way from requests made
 * anywhere, its TAO on Base: the chains' figures), the form says, before the button, that a USDC unstake sells that too
 * (the latest request decides for all: C1); while not all of that is read (the scan of the account's events not
 * complete, the limit loading or unreadable), it says so without a figure (fix round 2). Receive TAO is offered beside it
 * with any wallet, and is on whenever a request can be made at all (an amount that checks out, no flow running, nothing
 * holding requests, the contracts as built, ETH for the request fee when the quote has read it): never held by the
 * impact cap, the limit, a quote or the outside-price veto (asked only at the click, of USDC alone: usdcUnstakeChecks),
 * none of which is an input here. It says it also ends the account's USDC delivery whenever the chain holds a
 * preference, or that isn't read yet or can't be (unknown taken as set: I1, re-review N3). With USDC delivery off
 * (`usdcDelivery` false, v3.2's switch: Task 60, spec §5) no USDC unstake and no USDC line at all, and Receive TAO, its
 * one way out, as above, saying it ends the delivery the chain holds (`preference`, unknown taken as set). Every other
 * deployment's form is as it was: the USDC button by the quote, and nothing else. */
export function unstakeActions(x: {
  v32: boolean;
  account: string | null;
  /** The request's shares, once its amount checks out. */
  shares: bigint | null;
  quote: WithdrawalQuote | undefined;
  limit: { data?: DeliveryLimit; isError: boolean };
  pending: boolean;
  lowEth: boolean;
  hold: string | null;
  blocked: string | null;
  /** v3.2: whether the site offers USDC delivery (config.usdcDeliveryOn); on unless given. */
  usdcDelivery?: boolean;
  /** v3.2 with USDC delivery off: whether the chain holds a delivery preference for the account (its own read). */
  preference?: { data?: boolean; isError: boolean };
}): UnstakeActions {
  const canRequest = x.account !== null && !x.pending && x.hold === null && x.blocked === null;
  const usdcBase = canRequest && x.quote !== undefined && !x.lowEth;
  if (!x.v32) return { usdc: usdcBase, warning: null, notes: [], tao: { offered: false, enabled: false, endsDelivery: false } };
  if (x.usdcDelivery === false) {
    const pref = x.preference ?? { isError: false };
    return {
      usdc: false,
      warning: null,
      notes: [],
      tao: {
        offered: x.account !== null,
        enabled: canRequest && x.shares !== null && !x.lowEth,
        endsDelivery: x.account !== null && (pref.isError || pref.data !== false),
      },
    };
  }
  const notes: UnstakeActions["notes"] = [];
  const impact = impactNote(x.quote);
  if (impact) notes.push(impact.refused ? { text: `${impact.text} ${RECEIVE_TAO_POINTER}`, refused: true } : impact);
  const l = x.limit.data;
  let limitRefused = true;
  // a failed read first: the last good reading, kept beside it, is no answer now (M4)
  if (x.limit.isError) notes.push({ text: LIMIT_UNREAD, refused: true });
  else if (l && l.clearsAll) limitRefused = false;
  else if (l) {
    limitRefused = roomTaoWei(l) === 0n || (x.quote !== undefined && deliverableRefusal(x.quote, l) !== null);
    notes.push({ text: limitText(l), refused: limitRefused });
  }
  // what else a USDC unstake sells: the figure once every payout of the account's on its way is read, else no figure
  const known = !x.limit.isError && x.limit.data?.waitingComplete === true;
  const waiting = x.limit.data?.waitingTaoWei ?? 0n;
  // ...but not when the account's waiting TAO is already set to be sold: its USDC delivery preference is known to be
  // on (its earlier unstakes were USDC ones), so this one changes nothing for them and the line only puzzled (the
  // founder, 2026-11-18, twice). Unknown or off, the line stays: it is what tells someone who asked for TAO that this
  // request would sell it.
  const alreadyUsdc = !x.limit.isError && x.limit.data?.preferenceSet === true;
  return {
    usdc: usdcBase && !impact?.refused && !limitRefused,
    warning: x.account === null || alreadyUsdc ? null : !known ? WAITING_UNKNOWN : waiting > 0n ? waitingText(waiting) : null,
    notes,
    tao: {
      offered: x.account !== null,
      enabled: canRequest && x.shares !== null && !x.lowEth,
      endsDelivery: x.account !== null && (x.limit.isError || x.limit.data === undefined || x.limit.data.preferenceSet),
    },
  };
}

/** The Unstake page's choice of TAO: offered only where there are two ways (v3.2 with USDC delivery on), and taken
 * only where offered, so a choice made earlier can never leave a form on TAO that has no way back. */
export const taoChoice = (x: { v32: boolean; usdcDelivery: boolean; asTao: boolean }): { offered: boolean; asTao: boolean } => {
  const offered = x.v32 && x.usdcDelivery;
  return { offered, asTao: offered && x.asTao };
};

/** Whether the USDC form shows the switch to TAO: a USDC unstake is what the form offers (`taoOnly` false), there is a
 * switch (`canSwitch`), and the USDC unstake can't go while the TAO one could:
 * - one of its lines refuses it (the limit, the price impact, the limit unread);
 * - it was refused at the click in words that point to TAO (the pointer flows.ts adds, or a limit refusal's own:
 *   saysReceiveTao, the one test both use);
 * - its quote failed (`quoteFailed`: the price can't be read, say), or its limit isn't read yet (`limitUnread`), with
 *   an amount the TAO unstake would take: the USDC button is off and nothing else says why not TAO.
 * Never otherwise: a form that can send shows its one button (review of f9c59861, findings 2 and 3). */
export const offersTao = (
  a: Pick<UnstakeActions, "notes" | "tao" | "usdc">,
  x: { taoOnly: boolean; canSwitch: boolean; flowError: string | null | undefined; quoteFailed: boolean; limitUnread: boolean },
): boolean =>
  !x.taoOnly &&
  x.canSwitch &&
  a.tao.offered &&
  (a.notes.some((n) => n.refused) || saysReceiveTao(x.flowError) || (a.tao.enabled && !a.usdc && (x.quoteFailed || x.limitUnread)));

/** What the form's one submit sends, decided in one place: in the TAO view (the person's choice, or USDC delivery
 * off) the TAO unstake, nothing sold; in the USDC view the USDC unstake; or nothing, when that view's own request
 * can't go. Never the other view's (review of f9c59861, G). Both are off while any request is pending: `usdc` and
 * `tao.enabled` are (unstakeActions). */
export const unstakeSubmit = (x: {
  taoOnly: boolean;
  hasAccount: boolean;
  hasQuote: boolean;
  hasRequest: boolean;
  actions: Pick<UnstakeActions, "usdc" | "tao">;
}): "receiveTao" | "unstake" | null => {
  if (!x.hasAccount) return null;
  if (x.taoOnly) return x.hasRequest && x.actions.tao.enabled ? "receiveTao" : null;
  return x.hasQuote && x.actions.usdc ? "unstake" : null;
};

/** One claim button's label: "Confirm in your wallet…" on the one pressed (`pressed`, its `keepTao`) while its claim
 * runs, never on another (Task 59a re-review, N2); its own label otherwise. */
export const claimButtonLabel = (choice: { label: string; keepTao: boolean }, x: { busy: string | null; pressed: boolean | null }): string =>
  x.busy === "claim" && x.pressed === choice.keepTao ? "Confirm in your wallet…" : choice.label;

/** The claim buttons for what is back on Base, the first one leading: Claim as USDC, and after a sale the price check
 * held (`saleHeld`) or a claim whose swap failed (`claimFailed`, the receipt's) the TAO; but for an unstake asked as TAO
 * (`keepsTao`), Claim as TAO first and Claim as USDC beside it (Task 59a review, M12). With USDC delivery off
 * (`usdcDelivery` false, Task 60) Claim as TAO alone, whatever was asked for: no USDC option is offered. */
export function claimChoices(x: { keepsTao: boolean; saleHeld: boolean; claimFailed?: boolean; usdcDelivery?: boolean }): { label: string; keepTao: boolean }[] {
  if (x.usdcDelivery === false) return [{ label: "Claim as TAO", keepTao: true }];
  if (x.keepsTao) {
    return [
      { label: "Claim as TAO", keepTao: true },
      { label: "Claim as USDC", keepTao: false },
    ];
  }
  const usdc = { label: "Claim as USDC", keepTao: false };
  if (x.saleHeld) return [usdc, { label: "Claim as TAO instead", keepTao: true }];
  if (x.claimFailed) return [usdc, { label: "Claim now and swap to USDC separately", keepTao: true }];
  return [usdc];
}
