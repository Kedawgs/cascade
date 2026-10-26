import { type Address, decodeEventLog, formatUnits, type Hex, parseAbi } from "viem";
import type { PlanV3 } from "../plan.ts";
import type { Sent } from "../send.ts";
import type { CallRequest } from "../types.ts";

/** Circle's CCTP domain for Base: the only delivery destination the front door accepts. */
export const DESTINATION_BASE = 6;
/** The keeper's own minimum is the quote less 0.5%: room for the price to move before the sale lands. */
const KEEPER_ROOM_BPS = 50n;

export const TWAP_UNAVAILABLE = "the pool's price history doesn't reach 30 minutes; the user can claim by hand";

export interface DeliveryPref {
  /** USDC units (6 decimals) per 1e18 TAO wei */
  minUsdcPerTao: bigint;
  deadline: number;
  destination: number;
}

export interface DeliveryInput {
  claimable: bigint;
  /** null: no preference (the front door stores all zeros) */
  pref: DeliveryPref | null;
  /** What selling `claimable` along the staker's delivery route pays, after the staker's swap fee */
  quoteUsdc: bigint;
  /** The oracle's 30-minute value of `claimable`; null when the oracle reverted (its pools' history
   * doesn't reach 30 minutes), which makes deliver revert too */
  twapUsdc: bigint | null;
  /** The front door's maxDeliverySlippageBps */
  slippageBps: number;
  /** Base's latest block time */
  now: number;
}

const usdc = (units: bigint) => `${formatUnits(units, 6)} USDC`;
const no = (reason: string) => ({ deliver: false, reason });

/** Why a preference can't be delivered on now, or null when it is live and for Base (as deliver checks). */
export function preferenceProblem(pref: DeliveryPref | null, now: number): string | null {
  if (!pref || pref.minUsdcPerTao === 0n) return "no USDC delivery preference: the TAO stays claimable";
  if (pref.destination !== DESTINATION_BASE) return `the preference names destination ${pref.destination}, not Base (${DESTINATION_BASE})`;
  if (now > pref.deadline) return `the delivery preference expired at ${new Date(pref.deadline * 1000).toISOString()}: the TAO stays claimable`;
  return null;
}

/** Deliver only with a live Base preference and a quote that clears every floor deliver applies (the
 * user's, rounded up, and the TWAP's less the slippage allowance) by at least 0.5%; the keeper's own
 * minimum is then the quote less 0.5%. */
export function deliveryDecision(i: DeliveryInput): { deliver: boolean; keeperMinOut?: bigint; reason: string } {
  if (i.claimable === 0n) return no("nothing is claimable");
  const problem = preferenceProblem(i.pref, i.now);
  if (problem) return no(problem);
  if (i.twapUsdc === null) return no(TWAP_UNAVAILABLE);
  const pref = i.pref as DeliveryPref;
  const userFloor = (i.claimable * pref.minUsdcPerTao + 10n ** 18n - 1n) / 10n ** 18n;
  const twapFloor = (i.twapUsdc * BigInt(10_000 - i.slippageBps)) / 10_000n;
  const keeperMinOut = (i.quoteUsdc * (10_000n - KEEPER_ROOM_BPS)) / 10_000n;
  const quote = `the quote, ${usdc(i.quoteUsdc)} after the swap fee,`;
  if (keeperMinOut < userFloor) return no(`${quote} doesn't clear the user's floor of ${usdc(userFloor)} by 0.5%; it waits for a later round`);
  if (keeperMinOut < twapFloor) return no(`${quote} doesn't clear the 30-minute TWAP floor of ${usdc(twapFloor)} by 0.5%; it waits for a later round`);
  return {
    deliver: true,
    keeperMinOut,
    reason: `${quote} clears the user's floor (${usdc(userFloor)}) and the TWAP floor (${usdc(twapFloor)}) by at least 0.5%`,
  };
}

/** The staker's fee comes off the sale's output, after the swap, as sellFor takes it. */
export const netOfFee = (gross: bigint, feeBps: number) => gross - (gross * BigInt(feeBps)) / 10_000n;

export interface DeliveryRead extends DeliveryInput {
  user: Address;
  /** Set when the sale could not be quoted (the reason); the delivery then waits */
  quoteError?: string;
}

export type Simulation = { ok: true; usdcOut: bigint } | { ok: false; reason: string };

export interface DeliveryDeps {
  /** Every user with a Redeemed event on the vault since it was deployed, once each */
  deliveryCandidates(): Promise<Address[]>;
  readDelivery(user: Address): Promise<DeliveryRead>;
  /** deliver(user, keeperMinOut) as an eth_call from the keeper: any revert comes back as its reason */
  simulateDeliver(user: Address, keeperMinOut: bigint): Promise<Simulation>;
}

export interface DeliveryCheck {
  user: Address;
  claimable: bigint;
  deliver: boolean;
  keeperMinOut?: bigint;
  reason: string;
}

/** Reads, decides, and when the decision is to deliver, simulates: a delivery goes ahead only when the
 * front door would accept it now. A revert of any kind (the router's "Too little received", BelowMinimum,
 * an oracle that can't answer) is a skip for a later round, with its reason. */
export async function checkDelivery(deps: Pick<DeliveryDeps, "readDelivery" | "simulateDeliver">, user: Address): Promise<DeliveryCheck> {
  const r = await deps.readDelivery(user);
  if (r.quoteError) return { user, claimable: r.claimable, deliver: false, reason: r.quoteError };
  const d = deliveryDecision(r);
  if (!d.deliver || d.keeperMinOut === undefined) return { user, claimable: r.claimable, deliver: false, reason: d.reason };
  const sim = await deps.simulateDeliver(user, d.keeperMinOut);
  if (!sim.ok) return { user, claimable: r.claimable, deliver: false, reason: `deliver would revert now (${sim.reason}); it waits for a later round` };
  return { user, claimable: r.claimable, deliver: true, keeperMinOut: d.keeperMinOut, reason: d.reason };
}

export const DELIVER_ABI = parseAbi([
  "function deliver(address user, uint256 keeperMinOut) returns (uint256 received)",
  "event Delivered(address indexed user, uint256 taoIn, uint256 usdcOut)",
]);

export const deliverRequest = (plan: PlanV3, user: Address, keeperMinOut: bigint, nonce: number): CallRequest => ({
  chain: "base",
  nonce,
  label: `deliver ${user}'s TAO as USDC`,
  to: plan.addresses.frontDoor,
  abi: DELIVER_ABI,
  functionName: "deliver",
  args: [user, keeperMinOut],
});

/** The front door's Delivered event for `user` in a receipt (the staker's Sold names the front door as
 * its recipient, so deliveries are keyed off this one). */
export function deliveredFrom(logs: Sent["logs"], frontDoor: Address, user: Address): { taoIn: bigint; usdcOut: bigint } | undefined {
  for (const l of logs ?? []) {
    if (l.address.toLowerCase() !== frontDoor.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: DELIVER_ABI, eventName: "Delivered", topics: l.topics as [Hex, ...Hex[]], data: l.data });
      if (d.args.user.toLowerCase() === user.toLowerCase()) return { taoIn: d.args.taoIn, usdcOut: d.args.usdcOut };
    } catch {
      // another of the front door's events
    }
  }
  return undefined;
}

/** Each address once, in first-seen order, regardless of case. */
export function uniqueUsers(users: readonly Address[]): Address[] {
  const seen = new Set<string>();
  return users.filter((u) => !seen.has(u.toLowerCase()) && seen.add(u.toLowerCase()));
}
