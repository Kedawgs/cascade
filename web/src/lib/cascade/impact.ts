// v3.2's price impact on every quote (Task 59a; the founder's carry of 2026-11-04, "swaps must never hurt a customer"):
// how much of a trade's output its own size costs, against the pools' price for a small trade along the same route
// (the outside-price veto's probe, price-veto.ts: $100 of USDC for a stake, 0.5 TAO for a USDC unstake). It is the
// user's own size, not the market's offset from the wider price (that is the veto's). Shown on every v3.2 quote,
// warned at 1% or more, refused above 3%: the site's own cap, inside the staker's 5% buy floor on chain
// (CascadeStaker.MAX_BUY_SLIPPAGE_BPS), which with the delivery's floors stays the binding limit. It refuses or
// allows; it never changes an amount, a minimum or a call. v3.2's quotes alone carry it (live.ts).

/** From this impact on, in basis points, the quote says how far the trade moves the price: 1%. */
export const IMPACT_WARN_BPS = 100n;
/** Above this impact, in basis points, the site refuses the trade: 3% (the controller's cap). */
export const IMPACT_CAP_BPS = 300n;

/** A quote and the small trade it is measured against, along the same route, each in what goes in and what comes
 * out (USDC units in and TAO wei out for a stake; TAO wei in and USDC units out for a sale), the pools' fees in both,
 * so they cancel. */
export interface PriceImpact {
  tradeIn: bigint;
  tradeOut: bigint;
  probeIn: bigint;
  probeOut: bigint;
}

const BPS = 10_000n;

/** The impact in whole basis points, rounded down: 1 - the trade's rate (out per in) over the probe's. None for a
 * trade at least as good as the probe's (a smaller one), all of it for one that gets nothing out. */
export function impactBps(i: PriceImpact): bigint {
  const probe = i.probeOut * i.tradeIn;
  const trade = i.tradeOut * i.probeIn;
  return probe > trade ? ((probe - trade) * BPS) / probe : 0n;
}

/** The small trade read nothing (or nothing went in): the quote's impact can't be measured, so the cap refuses it
 * rather than let it through unmeasured (Task 59a review, M11). */
const unmeasured = (i: PriceImpact) => i.probeIn <= 0n || i.probeOut <= 0n;

/** The trade's rate is at most `1 - bps` of the probe's, decided exactly (never on the rounded figure). */
const atLeast = (i: PriceImpact, bps: bigint) => i.tradeOut * i.probeIn * BPS <= i.probeOut * i.tradeIn * (BPS - bps);

/** The quote moves the price by 1% or more: it says so. */
export const impactWarns = (i: PriceImpact): boolean => atLeast(i, IMPACT_WARN_BPS);
/** The quote moves the price by more than 3%, or its impact can't be measured: refused. Exactly 3% is allowed. */
export const impactRefused = (i: PriceImpact): boolean => unmeasured(i) || i.tradeOut * i.probeIn * BPS < i.probeOut * i.tradeIn * (BPS - IMPACT_CAP_BPS);

const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
/** The impact in percent, to the hundredth, rounded down: "1", "1.55". */
const percentText = (i: PriceImpact) => percent.format(Number(impactBps(i)) / 100);

/** The controller's words for a quote from 1% to 3%. */
export const impactWarningText = (i: PriceImpact): string => `This trade moves the price by ${percentText(i)}%.`;
/** The controller's words for a quote over the cap (IMPACT_CAP_BPS: 3%). */
export const IMPACT_REFUSED = "This trade would move the price by more than 3%. Try a smaller amount.";
/** The small trade it is measured against read nothing: refused, as the price checks fail closed. */
export const IMPACT_UNKNOWN = "Can't check this trade's price impact right now. Try again shortly.";

/** What the quote's details row says: the impact to the hundredth of a percent, or that it is under that. */
export const impactRowText = (i: PriceImpact): string => (unmeasured(i) ? "–" : impactBps(i) === 0n ? "under 0.01%" : `${percentText(i)}%`);

/** The form's line for a quote's impact: nothing under 1%, the warning from 1% to 3% included, the refusal above,
 * and a refusal when it can't be measured (IMPACT_UNKNOWN). Nothing for a quote that carries none (v3-launch's, or one
 * still loading). */
export function impactNote(q: { impact?: PriceImpact } | undefined): { text: string; refused: boolean } | null {
  const i = q?.impact;
  if (!i) return null;
  if (unmeasured(i)) return { text: IMPACT_UNKNOWN, refused: true };
  if (impactRefused(i)) return { text: IMPACT_REFUSED, refused: true };
  return impactWarns(i) ? { text: impactWarningText(i), refused: false } : null;
}

/** Why a quote can't be sent for its impact (IMPACT_REFUSED, or IMPACT_UNKNOWN), or null: the check the flows make
 * before anything is recorded or sent. It reads the quote and changes nothing of it. */
export function impactRefusal(q: { impact?: PriceImpact }): string | null {
  const note = impactNote(q);
  return note?.refused ? note.text : null;
}
