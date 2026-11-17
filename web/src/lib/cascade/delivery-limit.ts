import type { Hex } from "viem";
import { DELIVERY_TOLERANCE_BPS } from "./config";
import { FlowError } from "./flows";
import { impactRefusal } from "./impact";
import type { WithdrawalQuote } from "./types";
import { toDisplay } from "./units";
import { formatTao, formatUsdcCents } from "../format";

// v3.2's live USDC delivery limit (Task 59a; the founder's decision on R3 C-L2, 2026-11-05: deliver stays all at once,
// "Guide bigger [unstakes] back to TAO and be clear with how much we can do at that moment"). The front door's
// deliver sells everything credited to the user in one sale, and only when it clears every floor
// (CascadeFrontDoor.deliver): each pool's 30-minute mean depth at least its floor (minPoolLiquidity, else ThinPool),
// the user's own minimum (rounded up), the TWAP's value less maxDeliverySlippageBps; and the keeper sends one only
// with its 0.5% of room over those floors (ops/src/keeper/delivery.ts, deliveryDecision), quoted along the staker's live
// delivery route (routes[deliveryRouteId], as the keeper reads it). The market floor is the TWAP's marginal value, which
// ignores the sale's own price impact, so above some size no sale clears: the form reads the pools now, shows the
// largest USDC delivery that would clear right now, and refuses USDC above it, offering "Receive TAO" (no sale).
//
// The front door keeps one delivery preference per account, and deliver sells everything credited to it: the latest
// request decides for all of the account's waiting TAO. So a USDC unstake also sells what of the account's already
// waits (its request in the open batch, its payouts on their way back, its TAO on Base), Receive TAO payouts included,
// from requests made on any device, and the form says so, from the chains' figures, every time (Task 59a review, C1;
// fix round 2: the payouts on their way from the chains' events, and a standing line while those aren't all read).
//
// Every floor and the route come from the contracts, read at one block (reads.ts readDeliveryMarket); the keeper's room
// is pinned to the keeper's code by a test. It refuses or allows: it never changes an amount, a minimum or a call. The
// on-chain floors stay the binding limits; this only says which sale would meet them now.

/** The keeper's room over the floors, in basis points: it sends only when its own minimum, the quote less 0.5%,
 * clears them (ops/src/keeper/delivery.ts KEEPER_ROOM_BPS; delivery-limit.test.ts holds the two equal). */
export const KEEPER_ROOM_BPS = 50n;

/** How the search for the largest sale goes: at most LIMIT_STAGES reads of at most LIMIT_STEPS sizes each (one
 * multicall each): the account's whole TAO alone first (most accounts clear it: nothing more to read), then its
 * halvings, then sixteenths of the bracket found, twice (within 1/256 of the limit). */
export const LIMIT_STAGES = 4;
export const LIMIT_STEPS = 16;

/** What a delivery meets now, apart from its size, as the contracts say at `blockNumber`: whether a pool is thinner than
 * its floor (deliver refuses ThinPool), the front door's maxDeliverySlippageBps, the staker's swapFeeBps (taken off the
 * sale's USDC), the user's floor a USDC request sets now (deliveryFloorPerTao: the delivery terms' rule, USDC units per
 * TAO), and the path the staker's delivery route sells along, or null when it can't deliver (off, or a kind Uniswap's
 * quoter can't price, which the keeper waits on). Every size is quoted at the same block (M3). */
export interface DeliveryMarket {
  thin: boolean;
  slippageBps: bigint;
  swapFeeBps: bigint;
  minUsdcPerTao: bigint;
  sellPath: Hex | null;
  blockNumber: bigint;
}

/** One sale of `taoWei` as the market quotes it now: what it pays along the delivery's route before the staker's fee
 * (`grossUsdc`), and the oracle's 30-minute value of it (`twapUsdc`); either undefined when the contract refused it (a
 * revert: a size the pools can't take, an oracle whose history is short). A read the RPC couldn't make rejects instead. */
export interface SaleQuoteAt {
  taoWei: bigint;
  grossUsdc: bigint | undefined;
  twapUsdc: bigint | undefined;
}

/** The live limit for one account: its TAO a USDC delivery would also sell (`waitingTaoWei`: its request in the open
 * batch, its payouts on their way back from requests made anywhere, its TAO credited on Base), whether every payout of
 * its on its way was read (`waitingComplete`: not while the scan of its events isn't complete), whether the chain holds
 * a delivery preference for it (`preferenceSet`, deliveryOf: receiving TAO clears it), and the largest sale that clears
 * right now, in TAO and in USDC after the staker's fee. `clearsAll`: a sale of all the account's TAO clears
 * (`saleTaoWei` is then that). */
export interface DeliveryLimit {
  waitingTaoWei: bigint;
  waitingComplete: boolean;
  preferenceSet: boolean;
  saleTaoWei: bigint;
  saleUsdc: bigint;
  clearsAll: boolean;
}

/** What a sale pays after the staker's fee, as sellFor takes it (CascadeStaker: gross - gross * swapFeeBps / 10,000). */
export const netOfStakerFee = (gross: bigint, swapFeeBps: bigint): bigint => gross - (gross * swapFeeBps) / 10_000n;

/** The user's floor a USDC request sets, in USDC units per TAO: what 1 TAO sells for after the staker's fee, less the
 * delivery tolerance (DELIVERY_TOLERANCE_BPS), as live.ts deliveryTerms sets it (a test holds the two equal). */
export const deliveryFloorPerTao = (grossOneTao: bigint, swapFeeBps: bigint): bigint =>
  (netOfStakerFee(grossOneTao, swapFeeBps) * (10_000n - BigInt(DELIVERY_TOLERANCE_BPS))) / 10_000n;

/** Whether the keeper would send this sale now and deliver would take it: no pool thinner than its floor, a delivery
 * route that can deliver, and the keeper's own minimum (the quote after the staker's fee, less KEEPER_ROOM_BPS) at least
 * both floors deliver applies, the user's (rounded up) and the TAO's TWAP value less the slippage allowance, each as the
 * front door computes it. Never for a sale of nothing, or one the contracts refused to quote or value. */
export function saleClears(m: DeliveryMarket, s: SaleQuoteAt): boolean {
  if (m.thin || m.sellPath === null || s.taoWei <= 0n || s.grossUsdc === undefined || s.twapUsdc === undefined) return false;
  const keeperMinOut = (netOfStakerFee(s.grossUsdc, m.swapFeeBps) * (10_000n - KEEPER_ROOM_BPS)) / 10_000n;
  const userFloor = (s.taoWei * m.minUsdcPerTao + 10n ** 18n - 1n) / 10n ** 18n;
  const twapFloor = (s.twapUsdc * (10_000n - m.slippageBps)) / 10_000n;
  return keeperMinOut >= userFloor && keeperMinOut >= twapFloor;
}

/** The largest sale of at most `capTaoWei` (the account's whole TAO) that clears right now (saleClears), from at most
 * LIMIT_STAGES reads of the market (`read`, smallest size first): the cap alone (when it clears, nothing more is read),
 * its halvings, then sixteenths of the bracket the largest clearing one opens, twice. Never above the true limit (each
 * figure is a size that cleared), and within 1/256 of it while larger sales clear less (a sale's price falls with its
 * size). Nothing, with no read, while a pool is thin or the route can't deliver, or when none clears; `clearsAll` when
 * the cap does. Rejects when `read` does (the market unreadable). */
export async function findDeliveryLimit(
  capTaoWei: bigint,
  m: DeliveryMarket,
  read: (sizes: readonly bigint[]) => Promise<readonly SaleQuoteAt[]>,
): Promise<Omit<DeliveryLimit, "waitingTaoWei" | "waitingComplete" | "preferenceSet">> {
  const none = { saleTaoWei: 0n, saleUsdc: 0n, clearsAll: false };
  if (m.thin || m.sellPath === null || capTaoWei <= 0n) return none;
  const [whole] = await read([capTaoWei]);
  if (whole && saleClears(m, whole)) return { saleTaoWei: capTaoWei, saleUsdc: netOfStakerFee(whole.grossUsdc as bigint, m.swapFeeBps), clearsAll: true };
  /** The largest size of `sizes` (ascending) that clears, and the next one up (which doesn't), if any. */
  const largest = async (sizes: bigint[]) => {
    const sales = await read(sizes);
    let i = -1;
    sales.forEach((s, k) => {
      if (saleClears(m, s)) i = k;
    });
    return { best: i >= 0 ? sales[i] : undefined, above: sizes[i + 1] };
  };
  const halvings = [...new Set(Array.from({ length: LIMIT_STEPS - 1 }, (_, k) => capTaoWei >> BigInt(LIMIT_STEPS - 1 - k)))].filter((s) => s > 0n);
  const first = await largest(halvings);
  if (!first.best) return none;
  let best = first.best;
  let hi = first.above ?? capTaoWei;
  for (let stage = 2; stage < LIMIT_STAGES; stage++) {
    const lo = best.taoWei;
    const between = [...new Set(Array.from({ length: LIMIT_STEPS - 1 }, (_, j) => lo + ((hi - lo) * BigInt(j + 1)) / BigInt(LIMIT_STEPS)))].filter((s) => s > lo && s < hi);
    if (between.length === 0) break;
    // the next size up from the largest that clears (the first one when none does), else the bracket's top as it was
    const next = await largest(between);
    if (next.best) best = next.best;
    hi = next.above ?? hi;
  }
  return { saleTaoWei: best.taoWei, saleUsdc: netOfStakerFee(best.grossUsdc as bigint, m.swapFeeBps), clearsAll: false };
}

/** What a delivery of this unstake would sell: its payout (its TAO less the bridge fee) and what of the account's
 * waits to be sold with it (DeliveryLimit.waitingTaoWei). */
export const saleOf = (q: Pick<WithdrawalQuote, "taoWei" | "bridgeFeeWei">, waitingTaoWei: bigint): bigint =>
  (q.taoWei > q.bridgeFeeWei ? q.taoWei - q.bridgeFeeWei : 0n) + waitingTaoWei;

/** The TAO left for a new unstake's payout under the limit, after what of the account's already waits. */
export const roomTaoWei = (l: Pick<DeliveryLimit, "saleTaoWei" | "waitingTaoWei">): bigint => (l.saleTaoWei > l.waitingTaoWei ? l.saleTaoWei - l.waitingTaoWei : 0n);

/** No sale clears right now, or the account's own waiting TAO fills the limit: no USDC delivery for a new unstake. */
export const NO_DELIVERY = "Right now no USDC delivery can be made. Receive TAO and claim it on Base.";
/** The limit, or what of the account's waits, can't be read: a USDC unstake isn't sent (fail closed); receiving TAO
 * needs no such read. */
export const LIMIT_UNREAD = "Can't check how much USDC can be delivered right now. Try again shortly, or receive TAO.";

/** What else of the account's a USDC unstake sells (the latest request decides for all its waiting TAO), rounded down to
 * the 0.0001 TAO shown: said before the button whenever there is any and every payout of the account's on its way was
 * read (Task 59a fix round 2, the controller's words). */
export const waitingText = (taoWei: bigint): string =>
  `This also sells the ${formatTao(Number(taoWei / 10n ** 14n) / 1e4, 4)} TAO of yours on its way back to Base or waiting there.`;
/** Said before the button instead while not every payout of the account's on its way was read (the scan of its events
 * not complete, the read loading or failed): no figure (fix round 2, the controller's words). */
export const WAITING_UNKNOWN = "A USDC unstake also sells any of your TAO on its way back to Base or waiting there.";

/** The live figure, in the controller's words: the USDC a new unstake's delivery can be at most right now (the room
 * left after what of the account's already waits, at the largest clearing sale's price, rounded down to the cent), or
 * that none can be made. */
export function limitText(l: Pick<DeliveryLimit, "saleTaoWei" | "saleUsdc" | "waitingTaoWei">): string {
  const room = roomTaoWei(l);
  if (room === 0n || l.saleTaoWei === 0n) return NO_DELIVERY;
  const usdc = (((l.saleUsdc * room) / l.saleTaoWei) / 10_000n) * 10_000n;
  return `Right now up to ${formatUsdcCents(toDisplay(usdc, 6))} USDC can be delivered. Above that, receive TAO and claim it on Base.`;
}

/** Why this USDC unstake isn't sent under the live limit (limitText), or null: its sale (saleOf) is at most the
 * largest that clears, or everything the account has clears. The form's figure, at the market's floor. */
export function deliverableRefusal(q: Pick<WithdrawalQuote, "taoWei" | "bridgeFeeWei">, l: DeliveryLimit): string | null {
  return saleOf(q, l.waitingTaoWei) <= l.saleTaoWei ? null : limitText(l);
}

/** The check at the click (Task 59a review, I2 and M8): whether this request's own sale, with what of the account's
 * waits, clears at the minimum the request sends, the larger of its own floor (`q.minUsdcPerTao`, what it sends) and
 * the market's now: one quote of that sale, read fresh. When it doesn't, the limit at that floor is searched, for the
 * refusal's words (limitText). Null when it clears; rejects when the market can't be read. */
export async function clickRefusal(x: {
  q: Pick<WithdrawalQuote, "taoWei" | "bridgeFeeWei" | "minUsdcPerTao">;
  waitingTaoWei: bigint;
  capTaoWei: bigint;
  market: DeliveryMarket;
  read: (sizes: readonly bigint[]) => Promise<readonly SaleQuoteAt[]>;
}): Promise<string | null> {
  const m = { ...x.market, minUsdcPerTao: x.q.minUsdcPerTao > x.market.minUsdcPerTao ? x.q.minUsdcPerTao : x.market.minUsdcPerTao };
  const sale = saleOf(x.q, x.waitingTaoWei);
  if (!m.thin && m.sellPath !== null && sale > 0n) {
    const [s] = await x.read([sale]);
    if (s && saleClears(m, s)) return null;
  }
  const cap = x.capTaoWei > sale ? x.capTaoWei : sale;
  return limitText({ waitingTaoWei: x.waitingTaoWei, ...(await findDeliveryLimit(cap, m, x.read)) });
}

/** Every refusal of a USDC unstake points to the way that is always open (the controller's ruling on Task 58b's
 * concern 1): added to the words of one that doesn't already say it. */
export const RECEIVE_TAO_POINTER = "You can receive TAO instead.";

/** A USDC unstake's refusal (a FlowError: the veto's, the impact cap's, the limit's) with RECEIVE_TAO_POINTER, its
 * state kept; anything else as it is (userMessage words a wallet's or a network's error). */
export function pointToTao(e: unknown): unknown {
  if (!(e instanceof FlowError) || /receive TAO/i.test(e.message)) return e;
  return new FlowError(`${e.message} ${RECEIVE_TAO_POINTER}`, e.state);
}

/** A USDC unstake's checks before it is recorded or sent (use-flows.ts unstake; Task 59a review, M10). On v3.2: its
 * sale's price impact within the cap (impact.ts), then the live limit at the click (`deliverable`: its refusal's words,
 * or null; a read that fails refuses as unreadable, LIMIT_UNREAD), then the outside-price veto (`veto`, v3.2's alone).
 * Each refusal is a "needs you" FlowError pointing to receiving TAO (pointToTao), and the later checks aren't asked.
 * Elsewhere, only the veto (none on v3-launch). It resolves with nothing, and changes nothing of the quote. Receiving
 * TAO runs none of this. */
export async function usdcUnstakeChecks(x: {
  v32: boolean;
  q: WithdrawalQuote;
  deliverable: () => Promise<string | null>;
  veto?: () => Promise<void>;
}): Promise<void> {
  try {
    if (x.v32) {
      const overCap = impactRefusal(x.q);
      if (overCap) throw new FlowError(overCap, "needs-you");
      let refusal: string | null;
      try {
        refusal = await x.deliverable();
      } catch {
        throw new FlowError(LIMIT_UNREAD, "needs-you");
      }
      if (refusal) throw new FlowError(refusal, "needs-you");
    }
    await x.veto?.();
  } catch (e) {
    throw pointToTao(e);
  }
}
