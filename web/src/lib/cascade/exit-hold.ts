import { type Address, encodeAbiParameters, type Hex, keccak256 } from "viem";
import { formatTao } from "../format";
import { type LiveFigure, shownFigure } from "../stats";
import { BASE_CHAIN, BIT_ADAPTER_V32, VAULT_LENS, VAULT_V32 } from "./abi";
import type { Clients } from "./chain";
import type { Deployment } from "./config";
import { freshTip } from "./fresh";
import { contractRefused } from "./wiring";

// v3.2's holds on a front-door unstake (R4, spec §3.5), read at one block: the one-day hold on fresh shares (B-H1: a door
// burns only shares held a day), the vault's primary bridge unable to send payouts (S-H1: every door redeem is then
// deferred), and the day's allowance left (the web copy audit's M2, a guide: others may get there first). The Unstake form
// reads them at the newest block; a RedeemDeferred, which names no cause, is told apart by them at its delivery's block.

/** CascadeConstants.STAKE_RAMP: how long a deposit's shares are held from a front-door burn. */
export const HOLD_S = 86_400;
/** CascadeConstants.MIN_REDEEM_VALUE: the least a front-door burn takes (0.03 TAO); a smaller one is deferred. */
export const MIN_REDEEM_WEI = 3n * 10n ** 16n;
/** CascadeConstants.GLOBAL_WINDOW: every door's burns together, keyed by bytes32(0). */
const GLOBAL_WINDOW = `0x${"00".repeat(32)}` as Hex;
const RAO = 10n ** 9n;

/** The approved copy (the web copy audit, N3): the vault's primary bridge can't send payouts, so every Base unstake is
 * deferred until it can. */
export const PAYOUTS_ON_HOLD = "Unstakes through Base are on hold. The bridge can't send payouts right now. Requests keep your stake; a regular wallet can withdraw on Bittensor.";

/** What the vault's lens and the primary bridge answer about one holder's front-door unstake, at one block. */
export interface ExitReads {
  /** the block's time, unix s */
  time: number;
  /** the vault's primary bridge's canSendPayouts(); undefined when it couldn't be read (the vault reads a primary with no
   * such view as open, so unknown is never said as closed) */
  payoutsOpen?: boolean;
  /** freshShares(holder): the clock of its last run of mints (unix s) and what they minted */
  fresh: { since: number; shares: bigint };
  /** csTAO it holds */
  balance: bigint;
  /** the lens's price(): wei per share unit, × 1e18 */
  price: bigint;
  /** the allowance's inputs (CascadeBatchLib._burnRedeems): the visible and booked stake (rao), what still ramps in and
   * since when, this door's and every door's daily bps, the floor, and the two windows */
  outflow?: {
    stakeRao: bigint;
    bookedRao: bigint;
    rampingWei: bigint;
    lastStakeAt: number;
    bps: bigint;
    globalBps: bigint;
    floor: bigint;
    door: { start: number; burned: bigint };
    global: { start: number; burned: bigint };
  };
}

/** What `shares` are worth at the reads' price, in wei. */
const valueOf = (r: ExitReads, shares: bigint) => (shares * r.price) / 10n ** 18n;
const sub0 = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
/** A ten-thousandth of a TAO, in wei: the figures' last place. */
const PLACE = 10n ** 14n;
/** TAO to at most four places, trailing zeros dropped ("2", "4.25"), from a count of PLACE. */
const taoOf = (places: bigint) => formatTao(Number(places) / 1e4, 4).replace(/\.?0+$/, "");
/** An amount that can go now, rounded down (never overstated); one that is held, rounded up. */
const taoDown = (wei: bigint) => taoOf(wei / PLACE);
const taoUp = (wei: bigint) => taoOf((wei + PLACE - 1n) / PLACE);
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
/** A wait in seconds, minutes or hours, each rounded up (never understated: an early request costs a fee). */
function waitUp(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return plural(s, "second");
  const m = Math.ceil(s / 60);
  if (m < 60) return plural(m, "minute");
  return plural(Math.ceil(m / 60), "hour");
}

/** When the holder's fresh shares stop being held (their clock + a day), or null when none are held at the reads' time. */
export function heldUntil(r: ExitReads): number | null {
  return r.fresh.shares > 0n && r.fresh.since + HOLD_S > r.time ? r.fresh.since + HOLD_S : null;
}

/** The shares a front door can't burn now: the fresh ones while held (at most the balance). */
const heldShares = (r: ExitReads) => (heldUntil(r) === null ? 0n : r.fresh.shares < r.balance ? r.fresh.shares : r.balance);

/** "about 23 hours" until the hold ends, on the visitor's clock. */
const waitText = (until: number, nowMs: number) => `about ${waitUp(until * 1000 - nowMs)}`;

/** When the hold ends, unless none is held or its end has passed on the visitor's clock (the reads may be a minute old). */
const holdLeft = (r: ExitReads, nowMs: number) => {
  const until = heldUntil(r);
  return until === null || until * 1000 <= nowMs ? null : until;
};

/** The Unstake form's line on fresh shares (the hold's countdown), or null when none are held. */
export function freshNote(r: ExitReads, nowMs: number): string | null {
  const until = holdLeft(r, nowMs);
  if (until === null) return null;
  return `${taoUp(valueOf(r, heldShares(r)))} TAO of your stake is from a deposit less than a day old. It can be unstaked through Base in ${waitText(until, nowMs)}.`;
}

/** The warning before an unstake of `requestWei` that reaches into fresh shares: what can go now and when the rest can,
 * or that none can yet (the older part under the minimum). Null when it doesn't reach them. A request is judged when its
 * batch arrives, so near the hold's end it may well go whole: this is a warning, never a refusal. */
export function freshWarning(r: ExitReads, requestWei: bigint, nowMs: number): string | null {
  const until = holdLeft(r, nowMs);
  if (until === null) return null;
  const older = valueOf(r, sub0(r.balance, heldShares(r)));
  if (requestWei <= older) return null;
  const wait = waitText(until, nowMs);
  if (older < MIN_REDEEM_WEI) return `None of this can be unstaked yet: it is from a deposit less than a day old. Unstake it in ${wait}.`;
  return `Only about ${taoDown(older)} TAO of this can be unstaked now. The rest is from a deposit less than a day old: it stays staked, and you can unstake it in ${wait}.`;
}

/** Why the vault deferred a front-door request of `requested` shares, from the reads at its delivery's block (CascadeBatchLib
 * ._burnRedeems' order): the rail closed (the allowance reads 0, so every redeem is); else the request worth under the
 * minimum; else the shares held a day worth under it (the hold); else the day's allowance or the entry limit. A rail that
 * couldn't be read can't be ruled out, so it is never the limit then ("unread"); the minimum and the hold are each
 * enough by themselves. */
export function deferralCause(r: ExitReads, requested: bigint): "rail" | "hold" | "minimum" | "limit" | "unread" {
  if (r.payoutsOpen === false) return "rail";
  const asked = requested < r.balance ? requested : r.balance;
  if (valueOf(r, asked) < MIN_REDEEM_WEI) return "minimum";
  const older = sub0(r.balance, heldShares(r));
  if (valueOf(r, asked < older ? asked : older) < MIN_REDEEM_WEI) return "hold";
  return r.payoutsOpen === undefined ? "unread" : "limit";
}

/** Roughly what is left of today's unstake allowance, wei: the smaller of this door's and every door's rests, each
 * max(base × bps / 10,000, floor) less its window's burns while the window runs (24 hours from its start), the base the
 * priced stake (the lower of visible and booked) less what still ramps in. Undefined when it wasn't read. A guide: the
 * vault works it out again when each batch arrives, and others may get there first. */
export function leftTodayWei(r: ExitReads): bigint | undefined {
  const o = r.outflow;
  if (!o) return undefined;
  const priced = (o.stakeRao < o.bookedRao ? o.stakeRao : o.bookedRao) * RAO;
  const elapsed = r.time - o.lastStakeAt;
  const ramp = elapsed >= HOLD_S ? 0n : (o.rampingWei * BigInt(HOLD_S - elapsed)) / BigInt(HOLD_S);
  const base = sub0(priced, ramp);
  const rest = (bps: bigint, w: { start: number; burned: bigint }) => {
    const byBps = (base * bps) / 10_000n;
    const allowance = byBps > o.floor ? byBps : o.floor;
    return sub0(allowance, r.time < w.start + 86_400 ? w.burned : 0n);
  };
  const door = rest(o.bps, o.door);
  const all = rest(o.globalBps, o.global);
  return door < all ? door : all;
}

/** What the Unstake form shows from the reads (null lines are left out): the approved notice while the vault's bridge
 * can't send payouts, the fresh shares' countdown, the warning for an amount that reaches into them, and roughly how
 * much of today's limit is left, rounded down ("–" while unread, and while the rail is closed: the vault reads the
 * allowance as 0 then). */
export function unstakeHoldLines(r: ExitReads | undefined, requestWei: bigint | null, nowMs: number): { onHold: string | null; fresh: string | null; warning: string | null; leftToday: string } {
  if (!r) return { onHold: null, fresh: null, warning: null, leftToday: "–" };
  const left = r.payoutsOpen === false ? undefined : leftTodayWei(r);
  return {
    onHold: r.payoutsOpen === false ? PAYOUTS_ON_HOLD : null,
    fresh: freshNote(r, nowMs),
    warning: requestWei === null ? null : freshWarning(r, requestWei, nowMs),
    leftToday: left === undefined ? "–" : `about ${taoDown(left)} TAO`,
  };
}

/** How long the form keeps showing the last reads after a read fails: past it, its lines go and the limit reads "–",
 * so stale figures never read as live (the codebase's shownFigure). */
export const EXIT_HOLD_KEEP_MS = 120_000;

/** The reads the form may show now: the query's data, kept through a failed read for EXIT_HOLD_KEEP_MS at most. */
export const shownExitHold = (q: LiveFigure<ExitReads>, nowMs: number): ExitReads | undefined => shownFigure(q, EXIT_HOLD_KEEP_MS, () => nowMs);

/** The vault's peerId(chain, door): keccak256(abi.encode(uint64, address)). */
const peerOf = (chain: bigint, door: Address) => keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [chain, door]));

type Answer = { status: "success"; result: unknown } | { status: "failure"; error: unknown };

/** v3.2: the reads behind a holder's front-door unstake, at `block` (the newest up-to-date one when not given): one
 * multicall through the vault lens (the primary bridge, the holder's fresh shares, the share price and, unless
 * `outflow` is false, the allowance's inputs, by this door's peer and the global window) and the vault (the holder's
 * balance), then the primary's own canSendPayouts() at the same block, in a multicall of its own. Each call may fail on its own: the allowance's
 * inputs failing leave only `outflow` unread (the rail, the countdown and a deferral's cause need none of them), and
 * any of the rest failing rejects. The view refused by the contract (a primary with no such view, which the vault reads
 * as open) leaves the rail unknown; the node not reached, or a rate limit, rejects, so it is never kept as an answer.
 * At a delivery's block `outflow: false` reads only what a cause needs. */
export async function readExitHold(
  c: Pick<Clients, "bittensor"> & Partial<Pick<Clients, "base">>,
  d: Deployment,
  account: Address,
  block?: bigint,
  o: { outflow?: boolean } = {},
): Promise<ExitReads> {
  const blockNumber = block ?? (await freshTip(c));
  const lens = { address: d.vaultLens as Address, abi: VAULT_LENS } as const;
  const core = [
    { ...lens, functionName: "primaryBridge" },
    { ...lens, functionName: "freshShares", args: [account] },
    { address: d.vault, abi: VAULT_V32, functionName: "balanceOf", args: [account] },
    { ...lens, functionName: "price" },
  ] as const;
  const inputs =
    o.outflow === false
      ? []
      : ([
          { ...lens, functionName: "visibleStakeRao" },
          { ...lens, functionName: "bookedStake" },
          { ...lens, functionName: "rampingStake" },
          { ...lens, functionName: "lastStakeAt" },
          { ...lens, functionName: "maxDailyOutflowBps" },
          { ...lens, functionName: "globalOutflowBps" },
          { ...lens, functionName: "minDailyOutflow" },
          { ...lens, functionName: "burnWindows", args: [peerOf(BASE_CHAIN, d.frontDoor)] },
          { ...lens, functionName: "burnWindows", args: [GLOBAL_WINDOW] },
        ] as const);
  const [head, answers] = await Promise.all([
    c.bittensor.getBlock({ blockNumber }),
    c.bittensor.multicall({ blockNumber, allowFailure: true, contracts: [...core, ...inputs] } as never) as Promise<Answer[]>,
  ]);
  const got = (i: number): unknown => {
    const a = answers[i];
    if (a?.status !== "success") throw a?.error ?? new Error(`no answer for ${core[i]?.functionName ?? "a read"}`);
    return a.result;
  };
  const [primary, fresh, balance, price] = [got(0), got(1), got(2), got(3)] as [Address, readonly [bigint, bigint], bigint, bigint];
  const rest = answers.slice(core.length);
  const outflow =
    inputs.length && rest.length === inputs.length && rest.every((a) => a.status === "success")
      ? (() => {
          const [stakeRao, bookedRao, rampingWei, lastStakeAt, bps, globalBps, floor, door, global] = rest.map((a) => (a as { result: unknown }).result) as [
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
            readonly [bigint, bigint],
            readonly [bigint, bigint],
          ];
          return {
            stakeRao,
            bookedRao,
            rampingWei,
            lastStakeAt: Number(lastStakeAt),
            bps,
            globalBps,
            floor,
            door: { start: Number(door[0]), burned: door[1] },
            global: { start: Number(global[0]), burned: global[1] },
          };
        })()
      : undefined;
  // the view in a multicall of its own, so its call's own error is told from the batch's: a node's failure (a timeout, a
  // rate limit, an internal error -32603 viem maps to a revert) comes under aggregate3, never as the view's refusal (a
  // readContract through the client's batch scheduler would report it under canSendPayouts: the review's N1)
  const [view] = (await c.bittensor.multicall({
    blockNumber,
    allowFailure: true,
    contracts: [{ address: primary, abi: BIT_ADAPTER_V32, functionName: "canSendPayouts" }],
  } as never)) as Answer[];
  let payoutsOpen: boolean | undefined;
  if (view?.status === "success") payoutsOpen = view.result as boolean;
  else {
    // only the contract's own refusal is an answer (no such view); anything else is the chain not read
    const e = view?.error ?? new Error("no answer for canSendPayouts");
    if (!contractRefused(e)) throw e;
    payoutsOpen = undefined;
  }
  return {
    time: Number(head.timestamp),
    ...(payoutsOpen === undefined ? {} : { payoutsOpen }),
    fresh: { since: Number(fresh[0]), shares: fresh[1] },
    balance,
    price,
    ...(outflow ? { outflow } : {}),
  };
}
