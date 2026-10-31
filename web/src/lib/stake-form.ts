import { formatUnits, parseUnits } from "viem";
import { DELIVERY_TOLERANCE_BPS, MIN_UNSTAKE_WEI } from "./cascade/config";
import type { DepositQuote, Limits, RoundTripCosts, WithdrawalQuote, WithdrawalRecord } from "./cascade/types";
import { isDelivering, offersClaim } from "./cascade/trail";
import { ENTRY_FULL_TEXT, entryFull, floorRao, MIN_UNSTAKE_TEXT, REST_LATER, toDisplay, type UnstakeCheck } from "./cascade/units";
import { formatTao, formatUsd, formatUsdc, formatUsdShort } from "./format";
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
  error: string | null;
  pending: boolean;
};

/** Why no stake fits right now, by the limit that is reached. */
const FULL_TEXT = {
  cap: "Cascade is full for now. Try again later.",
  batch: "The current batch is full. A new one opens once it leaves, so try again soon.",
} as const;

type StakeLimits = Pick<Limits, "minUsd" | "maxUsd" | "full">;

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

export const CONTRACT_WALLET_NOTE =
  "This wallet is a contract account, so it can only leave Cascade through Unstake here, not directly on Bittensor. If Unstake is ever paused, leaving waits until it reopens.";

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
    return s.dollars ? `Stake ${formatUsdShort(s.amount)}` : `Stake ${formatUsdc(s.amount)} USDC`;
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

/** Whether the Stake page offers "Claim as USDC" for what is waiting on Base: whenever something is,
 * except on v3 while an unstake's USDC is being delivered automatically (delivery sells everything
 * waiting at once) and no unstake offers the claim by hand. While the unstakes load that isn't known,
 * so v3 waits; if they can't be read it offers the claim, which needs only Base. */
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
  return !withdrawals.some(isDelivering);
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

export function unstakeButtonLabel(s: StakeState): string {
  if (!s.account) return "Connect wallet";
  if (s.pending) return "Confirm in your wallet…";
  if (s.amount !== null && s.amount > 0 && s.error === null) {
    return s.usd !== undefined ? `Unstake ${formatUsd(s.usd)}` : `Unstake ${taoLabel.format(floorTo(s.amount, 6))} TAO`;
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
 * at most that, leaving at least the minimum unstake behind so what stays can be unstaked later. Null,
 * so MAX fills nothing, when that comes to less than the minimum (the open batch's request is already at
 * the limit) or there is nothing to unstake: never zero or less. */
export function unstakeMaxWei(availableWei: bigint, mostWei: bigint | undefined): bigint | null {
  if (availableWei <= 0n) return null;
  if (mostWei === undefined || availableWei <= mostWei) return availableWei;
  const leavingMin = availableWei - MIN_UNSTAKE_WEI;
  const max = leavingMin < mostWei ? leavingMin : mostWei;
  return max >= MIN_UNSTAKE_WEI ? max : null;
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
const MIN_USD = (priceUsd: number) => `about ${formatUsd(Math.ceil(toDisplay(MIN_UNSTAKE_WEI, 18) * priceUsd * 100 - 1e-7) / 100)}`;

/** "One unstake can carry up to $2,475.00 (9.9 TAO); unstake the rest a day later (…)", in the unit shown. */
function oneUnstakeText(mostWei: bigint, unit: UnstakeUnit, priceUsd: number): string {
  const tao = `${maxUnstakeInput(mostWei)} TAO`;
  return `One unstake can carry up to ${unit === "USDC" && priceUsd > 0 ? `${usdDown(mostWei, priceUsd)} (${tao})` : tao}; ${REST_LATER}`;
}

/** The line under the unstake field: how much can go and the minimum, in the unit shown. A stake larger
 * than one unstake can carry (`mostWei`) says so instead. */
export function unstakeNote(availableWei: bigint, unit: UnstakeUnit, priceUsd: number, mostWei?: bigint): string {
  if (availableWei >= MIN_UNSTAKE_WEI && entryFull(availableWei, mostWei)) return `${ENTRY_FULL_TEXT}.`;
  if (mostWei !== undefined && availableWei > mostWei) {
    const min = unit === "USDC" && priceUsd > 0 ? `${MIN_USD(priceUsd)} (${MIN_UNSTAKE_TEXT})` : MIN_UNSTAKE_TEXT;
    return `${oneUnstakeText(mostWei, unit, priceUsd)}. The minimum is ${min}.`;
  }
  if (unit === "USDC" && priceUsd > 0) {
    return `You can unstake up to ${usdDown(availableWei, priceUsd)}. The minimum is ${MIN_USD(priceUsd)} (${MIN_UNSTAKE_TEXT}).`;
  }
  return `You can unstake up to ${maxUnstakeInput(availableWei)} TAO. The minimum is ${MIN_UNSTAKE_TEXT}.`;
}

/** Why an amount can't be unstaked, in dollars when the user types dollars. */
export function unstakeErrorText(
  check: Extract<UnstakeCheck, { ok: false }>,
  availableWei: bigint,
  unit: UnstakeUnit,
  priceUsd: number,
  mostWei?: bigint,
): string {
  if (unit !== "USDC" || !(priceUsd > 0)) return check.reason;
  switch (check.code) {
    case "overEntry":
      return mostWei !== undefined ? `${oneUnstakeText(mostWei, unit, priceUsd)}.` : check.reason;
    case "tooMuch":
      return `That's more than you can unstake (up to ${usdDown(availableWei, priceUsd)}).`;
    case "belowMin":
      return `The minimum unstake is ${MIN_USD(priceUsd)} (${MIN_UNSTAKE_TEXT}).`;
    case "leavesDust":
      return `That would leave less than ${MIN_USD(priceUsd)} staked, too little to unstake later.`;
    case "stakeBelowMin":
      return `Your stake is below the minimum unstake of ${MIN_USD(priceUsd)} (${MIN_UNSTAKE_TEXT}).`;
    default:
      return check.reason;
  }
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
