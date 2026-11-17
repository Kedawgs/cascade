import { type Address, formatEther, type Hex } from "viem";
import type { ChainName } from "./types.ts";

/** A USDC delivery that cleared the decision and its simulation this round. */
export interface DueDelivery {
  user: Address;
  keeperMinOut: bigint;
}

/** What closing the open batch earns and costs, in USDC units (6 decimals). */
export interface CloseEconomics {
  /** The batch's estimated Cascade fees: the deposit fee and the swap fee on the TAO of each deposit the
   * staker made (TAO deposited straight into the front door paid neither), and its fee pot */
  feesUsdc: bigint;
  /** The close's bridge (CCIP) fee */
  bridgeFeeUsdc: bigint;
}

export interface State {
  now: number;
  frontDoor: {
    canClose: boolean;
    nDeposits: number;
    nRedeems: number;
    paused: boolean;
    /** When the open batch started (Base time), and the front door's batch interval, in seconds */
    openStart: number;
    batchInterval: number;
    /** At one of the front door's list or value limits: it can close before its interval. Read only when
     * it can change the close decision (false otherwise). */
    full: boolean;
    /** Base's latest block time: the clock of openStart and canClose (the keeper's `now` is Bittensor's) */
    now: number;
    /** Read only when the fees decide the close; null = a price or fee could not be read */
    closeEconomics?: CloseEconomics | null;
    /** v3.2: a pause never stops a close or a roll (I-20; the web's sendGate, Task 58 c4). Absent (v3-launch): the
     * front door's pause stops both. Deliveries stop while it is paused either way. */
    closesWhilePaused?: boolean;
  };
  /** The longest the keeper holds a batch with entries that can close, counted from its start */
  closeMaxWaitS: number;
  alphaVault: { healthy: boolean };
  vault: {
    paused: boolean;
    available: bigint;
    minStakeWei: bigint;
    /** Root stake already held, and the chain's nominator minimum for one position, in wei. */
    rootStake: bigint;
    nominatorMinWei: bigint;
    batches: { key: Hex; queuedAt: number; cursor: number; count: number }[];
    payoutDelay: number;
    /** v3.2: some of the vault's stake is not on a listed hotkey (stakeMissing()): stakeIdle reverts StakeMissing, so
     * staking waits, said in the reason, while everything else goes on. Absent on v3-launch. */
    stakeMissing?: boolean;
  };
  /** v3: deliveries ready to send (the run loop fills it; reward claims are never an action) */
  deliveries?: DueDelivery[];
  /** Actions `run` skips this round, by actionKey: each refused by its simulation or its own re-read
   * MAX_REFUSALS rounds in a row (the circuit breaker), tried again on a back-off. The next due action
   * goes ahead instead, so one refused payout or stake never starves the deliveries and closes behind it. */
  skipped?: ReadonlySet<string>;
  /** Actions refused for good (v3.2's final refusals, by actionKey): never chosen again */
  final?: ReadonlySet<string>;
  /** v3.2 (R12d, M-1): the actions the one send path refused this round for want of room under the spend cap (their own
   * worst case, their gas at the fee cap and the value they keep, would cross what is left, while their chain reads under
   * the cap): passed over for the rest of the round, so the work behind them goes on, on both chains, and a smaller send
   * that fits still goes; the next round tries them again. Named in the reason when nothing else is due. */
  noRoom?: ReadonlySet<string>;
  /** v3.2 (R12e): the actions refused this round by their own read of the chain, nothing sent (a close whose batch changed
   * since the round read it: a cancel-down the close rule now holds, the batch no longer ready, or changed again at its
   * re-read after WrongBatch or BatchTooSmall; R12f: BatchNotReady with the batch, read again, no longer closable, after its
   * simulation or reverted on chain; R12g: any revert on chain of a close or the notice's close whose batch, read again,
   * moved or shrank; the cases something was sent): passed over for the rest of the round, never a
   * failed round nor a count for the breaker; the next round decides again from its own read. Named in the reason when
   * nothing else is due. */
  readRefused?: ReadonlySet<string>;
  /** v3.2's rails (Task 50a): chains at the keeper's 24 h spend cap, whose actions are not chosen (Bittensor: payouts and
   * the stake; Base: deliveries, the close and the roll). Absent on v3-launch. */
  capped?: ReadonlySet<ChainName>;
  /** v3.2's rails: the payout keys the monitor confirmed (lowercase); when present, a payout not among them waits for
   * it. Absent on v3-launch, and when an outage is overridden (no per-key check then). */
  confirmed?: ReadonlySet<string>;
  /** v3.2: token parks due their conversion (deliverParked) during a ForeverMoney migration notice. Task 52's park job
   * fills it (the registered door's parks to the vault, unconverted, each message rebuilt and checked); absent on
   * v3-launch. During a live notice a conversion passes the spend cap too (counted; the controller's ruling for Task 52),
   * as a cancel does. */
  conversions?: readonly ParkRef[];
  /** v3.2 (Task 52): the open batch to close once at a ForeverMoney migration notice (spec M-7: flush it at once, then
   * close nothing): its id and the deposits read. Absent when none is due. */
  flush?: { id: bigint; minValue: bigint; reason: string };
  /** v3.2 (Task 52): the park jobs due (the registered door's parks to the vault): deliverParked when it would succeed,
   * refundParked with quoteRefund's fee after PARK_TIMEOUT, dropParked for an empty park after it; oldest first. */
  parkJobs?: readonly ParkJob[];
  /** v3.2 (Task 52): Cascade's own bridge messages in CCIP FAILURE, due their re-execution (on their back-off; only with
   * the deployment's automatic re-execution on). */
  reexecs?: readonly DueReexec[];
  /** v3.2 (Task 52 fix round 1, review (iv)): the lanes on which a FAILURE of Cascade's has been open v32/reexec.ts
   * LANE_WAIT_MS (30 minutes), each with why: nothing new is sent on such a lane. Toward Bittensor no close, roll or
   * flush; toward Base no payout and no park refund. Everything else goes on (the conversions above all). */
  laneWaits?: Partial<Record<"Base → Bittensor" | "Bittensor → Base", string>>;
  /** v3.2's rails: the keeper is held, but the migration notice runs, so the round may offer token-park conversions and
   * nothing else (the founder's one exception, 2026-11-08). */
  onlyConversions?: boolean;
  /** v3.2 (Task 51): the listed hotkeys due their claim this round, in the order they are claimed, each with why (read
   * only once nothing else is due: payouts, then stake or unstake, then claims, spec §3.8). Absent on v3-launch, whose
   * run never claims. */
  claims?: readonly DueClaim[];
  /** v3.2: the vault's surplus is due its adoption (adoptStake): why. Absent on v3-launch, and when none is due. */
  adopt?: { reason: string };
  /** v3.2: why the claims and the adoption wait this round, due or not: a Bittensor send of the keeper's still unsettled
   * (the round's payout or stake, the order held across invocations). */
  rewardsWait?: string;
  /** v3.2 (Task 52w; T57c m2): why the vault would refuse a batch delivered now (it reads paused, its launch door is not
   * Active there, or it reads stake missing), so it would park on Bittensor: nothing is closed, rolled or flushed while it
   * says so, failing toward not closing (the monitor can't hold the keeper there). Absent on v3-launch, whose close rule is
   * unchanged. */
  vaultRefuses?: string;
  /** v3.2 (R7, L4): why the vault's payouts are closed (its _payoutsOpen false: its primary bridge disabled on the vault,
   * or its canSendPayouts() false), so the vault would defer each redeem request the open batch brings (RedeemDeferred).
   * Read only while the batch holds redeem requests; absent on v3-launch. What it holds of the batch is payoutsHold's
   * (R8, L-C: a batch with deposits only until its max wait). The migration notice's one close (flush) goes all the same
   * (merge 7b: its redeems are deferred by design). */
  payoutsClosed?: string;
  /** v3.2 (Task 53, the hotkey watch): a swap's old hotkeys due their removal from the list (the keeper's removeHotkey(h,
   * false)): each lost its stake while the vault read stake missing, is no longer the stake hotkey (the owner's
   * setStakeHotkey came first), holds none of the vault's stake and its credits read 0. Absent on v3-launch. */
  frees?: readonly DueFree[];
  /** v3.2 (Task 53, the buffer rule; spec §3.8): why claims wait while any payout is due: Bittensor's root hold is set
   * (RootStakeUnlockInterval above 0, or it can't be read), and a claim stamps the pair it claims on, which a payout's walk
   * may need to unstake from. Absent: no hold. */
  rootHold?: string;
}

/** A swap's old hotkey due its removal from the list (Task 53), and why. */
export interface DueFree {
  hotkey: Hex;
  reason: string;
}

/** A listed hotkey due its claim, and why (core/rewards.ts claimFor). */
export interface DueClaim {
  hotkey: Hex;
  reason: string;
}

/** A park on the Bittensor adapter, as deliverParked names it: its key, and the recipient, sender and message it was
 * parked with. */
export interface ParkRef {
  key: Hex;
  recipient: Address;
  sender: Address;
  message: Hex;
  /** The Bittensor adapter that holds it (R4, D-M2: a pair the deployment added after the deploy); absent: the deploy's */
  adapter?: Address;
}

/** A park job due (Task 52): which (deliver, refund, drop), the park, the refund's quoted fee, and why. */
export type ParkJob = ParkRef & { job: "deliver" | "refund" | "drop"; fee?: bigint; reason: string };

/** A FAILURE of Cascade's own due its re-execution (Task 52): its message id, its lane, and why. */
export interface DueReexec {
  id: Hex;
  direction: "Base → Bittensor" | "Bittensor → Base";
  reason: string;
}

/** The key `run`'s circuit breaker tracks an action by: a payout per batch, a delivery per user, a park's conversion
 * per park, a park job per job and park, a re-execution per message, a claim per hotkey, else its kind. */
export function actionKey(a: Action): string {
  if (a.kind === "payouts") return `payouts:${a.key.toLowerCase()}`;
  if (a.kind === "deliver") return `deliver:${a.user.toLowerCase()}`;
  if (a.kind === "convertPark") return `convertPark:${a.key.toLowerCase()}`;
  if (a.kind === "park") return `park:${a.job}:${a.key.toLowerCase()}`;
  if (a.kind === "reexec") return `reexec:${a.id.toLowerCase()}`;
  if (a.kind === "claim") return `claim:${a.hotkey.toLowerCase()}`;
  if (a.kind === "free") return `free:${a.hotkey.toLowerCase()}`;
  return a.kind;
}

export type Action =
  | { kind: "payouts"; key: Hex }
  | { kind: "deliver"; user: Address; keeperMinOut: bigint }
  | { kind: "stake" }
  | { kind: "close" }
  /** closeBatch on an empty batch, with no value: the front door restarts its timer (BatchRolled) */
  | { kind: "roll" }
  /** v3.2: deliverParked of a token park during a ForeverMoney migration notice (Task 52's park job) */
  | ({ kind: "convertPark" } & ParkRef)
  /** v3.2 (Task 52): closeBatch(id, minValue) once at a ForeverMoney migration notice, whatever the close rule and
   * AlphaVault's health (spec M-7: flush the open batch at once; close nothing afterwards) */
  | { kind: "flush"; id: bigint; minValue: bigint }
  /** v3.2 (Task 52): a park job on one of the registered door's parks to the vault */
  | ({ kind: "park"; job: "deliver" | "refund" | "drop"; fee?: bigint } & ParkRef)
  /** v3.2 (Task 52): OffRamp.execute of a FAILURE of Cascade's own, with a raised gas limit */
  | { kind: "reexec"; id: Hex; direction: "Base → Bittensor" | "Bittensor → Base" }
  /** v3.2 (Task 51): claimRewards(hotkey), one listed hotkey's root rewards */
  | { kind: "claim"; hotkey: Hex }
  /** v3.2 (Task 51): adoptStake, the vault's surplus booked and vested */
  | { kind: "adopt" }
  /** v3.2 (Task 53): removeHotkey(hotkey, false), a swap's old hotkey's slot freed by the keeper */
  | { kind: "free"; hotkey: Hex };

const hhmm = (unix: number) => `${new Date(unix * 1000).toISOString().slice(11, 16)} UTC`;
const DAY = 86_400;
/** A time, with its day when it isn't `now`'s (UTC): "14:05 UTC", "14:05 UTC tomorrow", "14:05 UTC on 2027-01-18". */
function when(unix: number, now: number): string {
  const days = Math.floor(unix / DAY) - Math.floor(now / DAY);
  if (days === 0) return hhmm(unix);
  if (days === 1) return `${hhmm(unix)} tomorrow`;
  return `${hhmm(unix)} on ${new Date(unix * 1000).toISOString().slice(0, 10)}`;
}
const usd = (units: bigint) => `$${(Number(units) / 1e6).toFixed(2)}`;

/** A batch that can close needs no fee check when it is full or at least `closeMaxWaitS` old on Base's
 * clock. A max wait no longer than the batch interval has always passed once the batch can close (canClose
 * and not full means the interval has passed), so the test cadence (0) closes as soon as the contract
 * allows, whatever any clock read says. */
export function closesWithoutFees(s: { closeMaxWaitS: number; frontDoor: Pick<State["frontDoor"], "full" | "openStart" | "batchInterval" | "now"> }): boolean {
  return s.frontDoor.full || atMaxWait(s);
}

/** The batch is at least `closeMaxWaitS` old on Base's clock (or the max wait is no longer than the interval, the test
 * cadence's): its close goes whatever its fees and whatever its size, full or not. R12c: so a v3.2 close there names
 * minValue 0 (v32/actions.ts closeV32), and a holder's 1-rao cancel of an aged entry before each send can't hold the
 * batch's deposits on Base past it. */
export function atMaxWait(s: { closeMaxWaitS: number; frontDoor: Pick<State["frontDoor"], "openStart" | "batchInterval" | "now"> }): boolean {
  const fd = s.frontDoor;
  return s.closeMaxWaitS <= fd.batchInterval || fd.now >= fd.openStart + s.closeMaxWaitS;
}

/** The fee estimate for a batch, in USDC units: a deposit fee per deposit the staker made, the swap fee
 * on their TAO at the oracle's price, and its fee pot at ETH's price; and the close's bridge fee at ETH's
 * price. Prices are USDC units per 1e18 wei. */
export function closeEconomicsOf(r: {
  /** The staker's deposits into the batch, and their TAO */
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

/** Under a max wait, an empty batch the front door would let close is due a roll (closeBatch with no
 * value restarts its timer, for Base gas and no bridge fee), at most once an interval, so the wait counts
 * from about its first entry rather than from the last close. The test cadence (no max wait) never
 * touches an empty batch. */
function rollDue(s: State): boolean {
  const fd = s.frontDoor;
  const empty = fd.nDeposits + fd.nRedeems === 0;
  return s.closeMaxWaitS > 0 && empty && fd.canClose && fd.batchInterval > 0 && fd.now >= fd.openStart + fd.batchInterval;
}

/** A due roll goes ahead only while AlphaVault is healthy, the condition close() needs: a redeem that
 * lands first can turn the roll into a real close. */
const rollable = (s: State): boolean => rollDue(s) && s.alphaVault.healthy;

const hours = (seconds: number) => `${Number((seconds / 3600).toFixed(2))}-hour`;

/** What a held batch waits for. */
function holdWait(s: State): string {
  const until = `waits until ${when(s.frontDoor.openStart + s.closeMaxWaitS, s.frontDoor.now)}`;
  const e = s.frontDoor.closeEconomics;
  if (e) return `${until} or until its fees cover the bridge fee (${usd(e.feesUsdc)} of ${usd(e.bridgeFeeUsdc)})`;
  if (e === null) return `${until}: its fees or the bridge fee could not be priced, so it does not close early`;
  return until;
}

/** A batch with entries the front door would let close but the close rule holds. */
function isHeld(s: State): boolean {
  const fd = s.frontDoor;
  const e = fd.closeEconomics;
  const canCloseEntries = fd.canClose && fd.nDeposits + fd.nRedeems > 0;
  return canCloseEntries && !closesWithoutFees(s) && !(!!e && e.feesUsdc >= e.bridgeFeeUsdc);
}

/** R7 (L4): the open batch's `n` redeem requests, which the vault would defer while its payouts are closed (`why`). */
export const redeemsDeferred = (n: number, why: string): string =>
  `the open batch holds ${n} redeem request${n === 1 ? "" : "s"} and the vault's payouts are closed (${why}), so the vault would defer ${n === 1 ? "it" : "each"} (RedeemDeferred: the requester${n === 1 ? " keeps the shares and asks" : "s keep their shares and ask"} again)`;

/** R7 (L4), R8 (L-C): why the vault's payouts being closed (State.payoutsClosed) holds the open batch on Base, or undefined
 * when it doesn't. A batch of redeem requests alone waits until they open: closed now, the vault would only defer them.
 * A batch with deposits waits at most until its max wait (closeMaxWaitS from its start, on Base's clock), never longer
 * than the keeper holds any batch: requestRedeem on Base checks no shares, only its fee, so a stranger's request in each
 * batch would otherwise hold every deposit on Base for as long as the payouts stay closed. Past its max wait it closes,
 * and the vault defers its redeem requests (closeDefers says so). */
export function payoutsHold(s: Pick<State, "payoutsClosed" | "closeMaxWaitS" | "frontDoor">): string | undefined {
  if (!s.payoutsClosed) return undefined;
  const fd = s.frontDoor;
  const words = redeemsDeferred(fd.nRedeems, s.payoutsClosed);
  if (fd.nDeposits === 0) return `${words}; the batch stays on Base until the vault's payouts open`;
  const until = fd.openStart + s.closeMaxWaitS;
  if (fd.now >= until) return undefined;
  const n = fd.nDeposits;
  return `${words}; the batch stays on Base until the vault's payouts open, or until its max wait at ${when(until, fd.now)}, when it closes with its ${n} deposit${n === 1 ? "" : "s"} and the vault defers its redeem requests`;
}

/** R8 (L-C): what a close of a batch with deposits says when it goes at its max wait while the vault's payouts are closed
 * under its redeem requests (payoutsHold no longer holds it): they will be deferred. Undefined otherwise. */
export function closeDefers(s: Pick<State, "payoutsClosed" | "closeMaxWaitS" | "frontDoor">, id: bigint): string | undefined {
  if (!s.payoutsClosed || s.frontDoor.nDeposits === 0 || payoutsHold(s) !== undefined) return undefined;
  const { nDeposits: d, nRedeems: r } = s.frontDoor;
  return `REDEEMS DEFERRED: batch ${id} closes at its max wait with its ${d} deposit${d === 1 ? "" : "s"}, and its ${r} redeem request${r === 1 ? " goes" : "s go"} with it: the vault's payouts are closed (${s.payoutsClosed}), so it will defer ${r === 1 ? "it" : "each"} (RedeemDeferred: the requester${r === 1 ? " keeps the shares and asks" : "s keep their shares and ask"} again once they open). Deposits never wait past the max wait behind a redeem request (requestRedeem on Base checks no shares)`;
}

/** For `status`: why the keeper holds a batch the front door would let close, or undefined. */
export function closeHold(s: State): string | undefined {
  const paid = payoutsHold(s);
  if (paid && s.frontDoor.canClose) return `the keeper holds it: ${paid}`;
  return isHeld(s) ? `the keeper holds it: it ${holdWait(s)}` : undefined;
}

/** The next thing the keeper should do: a due payout, then a USDC delivery, then staking, then closing
 * (or rolling) the batch; then (v3.2, Task 51) adopting the vault's surplus, then each listed hotkey's claim (Task 53:
 * none while Bittensor's root hold is set and a payout is due, the buffer rule), then a swap's old hotkey's slot freed
 * (Task 53), last of all (spec §3.8: payouts, then stake or unstake, then claims), never on a capped Bittensor nor while
 * a Bittensor send of the keeper's is unsettled (rewardsWait). A batch with entries closes once the front door allows it and it is full, at
 * least `closeMaxWaitS` old, or its fees cover the bridge fee; fees that could not be read never close it
 * early. An empty one is rolled under a max wait while AlphaVault is healthy (see rollable). An action in
 * `s.skipped` (run's circuit breaker) is passed over for the next due one, and named in the reason when
 * nothing else is due. */
export function decideNext(s: State): { action: Action | null; reason: string } {
  const final = s.final ?? new Set<string>();
  const roomless = s.noRoom ?? new Set<string>();
  const onRead = s.readRefused ?? new Set<string>();
  const skip = final.size || roomless.size || onRead.size ? new Set([...(s.skipped ?? []), ...final, ...roomless, ...onRead]) : (s.skipped ?? new Set<string>());
  const capped = s.capped ?? new Set<ChainName>();
  const unconfirmed = (b: { key: Hex }) => s.confirmed !== undefined && !s.confirmed.has(b.key.toLowerCase());
  // a token park to convert during ForeverMoney's migration notice: first, as the notice's deadline is the risk; under a
  // hold while the notice runs, the only thing offered (the founder's one exception); on a capped Bittensor too, since a
  // conversion during the notice passes the spend cap, counted (the controller's ruling for Task 52)
  const toConvert = (s.conversions ?? []).filter((p) => !skip.has(`convertPark:${p.key.toLowerCase()}`));
  if (toConvert.length) {
    return { action: { kind: "convertPark", ...toConvert[0] }, reason: `token park ${toConvert[0].key.slice(0, 10)}… is due its conversion during ForeverMoney's migration notice` };
  }
  if (s.onlyConversions) {
    return { action: null, reason: "nothing due: the keeper is held; during ForeverMoney's migration notice only token-park conversions go, and none is due" };
  }
  // then the notice's one close (Task 52; spec M-7: flush the open batch at once, whatever the close rule)
  // a lane where one of Cascade's FAILUREs has been open half an hour takes nothing new (Task 52 fix round 1, review (iv))
  const toBittensor = s.laneWaits?.["Base → Bittensor"];
  const toBase = s.laneWaits?.["Bittensor → Base"];
  // v3.2: a batch the vault would refuse waits on Base (it would only park on Bittensor): no close, no roll, and no flush,
  // whose batch would park as ForeverMoney's token (Task 52w fix)
  const refused = s.vaultRefuses;
  if (s.flush && !skip.has("flush") && !capped.has("base") && !toBittensor && !refused) return { action: { kind: "flush", id: s.flush.id, minValue: s.flush.minValue }, reason: s.flush.reason };
  const open = s.vault.batches.filter((b) => b.cursor < b.count);
  const due = open.filter((b) => s.now >= b.queuedAt + s.vault.payoutDelay);
  const payable = due.filter((b) => !skip.has(`payouts:${b.key.toLowerCase()}`) && !unconfirmed(b) && !capped.has("bittensor"));
  const dueNow = toBase ? [] : payable;
  const held = isHeld(s);
  const closable = s.frontDoor.canClose && s.frontDoor.nDeposits + s.frontDoor.nRedeems > 0 && !held;
  /** Whether the front door's pause stops closes and rolls (v3-launch; on v3.2 it never does) */
  const doorStops = s.frontDoor.paused && !s.frontDoor.closesWhilePaused;

  if (dueNow.length && !s.vault.paused && s.alphaVault.healthy) {
    return { action: { kind: "payouts", key: dueNow[0].key }, reason: "a payout batch is past its delay" };
  }
  const ready = s.deliveries ?? [];
  if (ready.length && !s.frontDoor.paused && !capped.has("base")) {
    const d = ready[0];
    return { action: { kind: "deliver", user: d.user, keeperMinOut: d.keeperMinOut }, reason: `${d.user}'s TAO is ready to deliver as USDC` };
  }
  const stakeable = s.vault.available >= s.vault.minStakeWei;
  const bigEnough = s.vault.rootStake + s.vault.available >= s.vault.nominatorMinWei;
  const stakeDue = stakeable && bigEnough && !s.vault.paused && !s.vault.stakeMissing;
  if (stakeDue && !skip.has("stake") && !capped.has("bittensor")) {
    return { action: { kind: "stake" }, reason: "the vault holds idle TAO above the staking floor" };
  }
  // R8 (L-C): the vault's payouts closed hold a batch of redeem requests alone, and one with deposits until its max wait
  const payoutsHeld = payoutsHold(s);
  const closeDue = closable && !doorStops && s.alphaVault.healthy && !refused && !payoutsHeld;
  if (closeDue && !skip.has("close") && !capped.has("base") && !toBittensor) {
    return { action: { kind: "close" }, reason: "the open batch is ready to close" };
  }
  const rollDueNow = rollable(s) && !doorStops && !refused;
  if (rollDueNow && !skip.has("roll") && !capped.has("base") && !toBittensor) {
    return { action: { kind: "roll" }, reason: `rolling the empty batch so its ${hours(s.closeMaxWaitS)} wait starts from the next deposit` };
  }
  // v3.2 (Task 52): the park jobs (Bittensor), then the re-executions of Cascade's FAILUREs (on their destination chain),
  // after the round's own work and before the adoption and the claims
  const destOf = (r: DueReexec): ChainName => (r.direction === "Base → Bittensor" ? "bittensor" : "base");
  const parkNow = capped.has("bittensor") ? [] : (s.parkJobs ?? []).filter((p) => !skip.has(`park:${p.job}:${p.key.toLowerCase()}`) && !(toBase && p.job === "refund"));
  if (parkNow.length) {
    const p = parkNow[0];
    return {
      action: { kind: "park", job: p.job, key: p.key, recipient: p.recipient, sender: p.sender, message: p.message, ...(p.adapter ? { adapter: p.adapter } : {}), ...(p.fee !== undefined ? { fee: p.fee } : {}) },
      reason: p.reason,
    };
  }
  const reexecNow = (s.reexecs ?? []).filter((r) => !skip.has(`reexec:${r.id.toLowerCase()}`) && !capped.has(destOf(r)));
  if (reexecNow.length) return { action: { kind: "reexec", id: reexecNow[0].id, direction: reexecNow[0].direction }, reason: reexecNow[0].reason };
  // v3.2 (Task 51): after everything else, the surplus adopted, then each listed hotkey's claim (spec §3.8: payouts, then
  // stake or unstake, then claims); never while a Bittensor send of the keeper's is unsettled (the round's payout or
  // stake, across invocations too), nor on a capped Bittensor
  const rewardsGo = !s.rewardsWait && !capped.has("bittensor");
  if (s.adopt && rewardsGo && !skip.has("adopt")) return { action: { kind: "adopt" }, reason: s.adopt.reason };
  // the buffer rule (Task 53; spec §3.8; T51 review M6): once Bittensor holds root stake after each add, remove or claim,
  // a claim stamps the pair it claims on, so it waits while any payout is due, waiting or not: a payout's walk may need to
  // unstake from that pair
  const holdWaits = s.rootHold !== undefined && due.length > 0;
  const claimNow = rewardsGo && !holdWaits ? (s.claims ?? []).filter((c) => !skip.has(`claim:${c.hotkey.toLowerCase()}`)) : [];
  if (claimNow.length) return { action: { kind: "claim", hotkey: claimNow[0].hotkey }, reason: claimNow[0].reason };
  // then a swap's old hotkey's slot (Task 53): its credits were claimed first (A17)
  const freeNow = rewardsGo ? (s.frees ?? []).filter((f) => !skip.has(`free:${f.hotkey.toLowerCase()}`)) : [];
  if (freeNow.length) return { action: { kind: "free", hotkey: freeNow[0].hotkey }, reason: freeNow[0].reason };
  const rewardsDue = !!s.adopt || (s.claims ?? []).length > 0 || (s.frees ?? []).length > 0;

  if (!s.alphaVault.healthy && (due.length || closable)) {
    return { action: null, reason: "AlphaVault is paused or migrating — not paying out or closing batches" };
  }
  if (s.vault.paused && due.length) return { action: null, reason: "the vault is paused — not paying out" };
  if (doorStops && closable) return { action: null, reason: "the front door is paused — not closing the batch" };
  if (doorStops && rollDue(s)) return { action: null, reason: "the front door is paused — not rolling the empty batch" };
  if (!s.alphaVault.healthy && rollDue(s)) return { action: null, reason: "AlphaVault is paused or migrating — not rolling the empty batch" };
  const waits: string[] = [];
  if (refused && (closable || rollDue(s))) waits.push(`closing waits: ${refused}, so a batch sent now would park on Bittensor; it stays on Base until the vault takes it again`);
  else if (payoutsHeld && closable) waits.push(`closing waits: ${payoutsHeld}`);
  const notDue = open.filter((b) => !due.includes(b));
  if (notDue.length) waits.push(`next payout at ${hhmm(Math.min(...notDue.map((b) => b.queuedAt + s.vault.payoutDelay)))}`);
  if (held) waits.push(`the open batch ${holdWait(s)}`);
  if (s.vault.stakeMissing && stakeable && bigEnough && !s.vault.paused) {
    waits.push("staking waits: some of the vault's stake is not on a listed hotkey (stake missing), which needs the owner or the guardian");
  }
  const finalNow = due.filter((b) => final.has(`payouts:${b.key.toLowerCase()}`)).map((b) => `paying out batch ${b.key.slice(0, 10)}…`);
  if (finalNow.length) waits.push(`${finalNow.join(", ")} not tried again (see FINAL above)`);
  const toConfirm = due.filter((b) => unconfirmed(b) && !final.has(`payouts:${b.key.toLowerCase()}`)).map((b) => `paying out batch ${b.key.slice(0, 10)}…`);
  if (toConfirm.length) waits.push(`${toConfirm.join(", ")} wait${toConfirm.length === 1 ? "s" : ""} for the monitor to confirm ${toConfirm.length === 1 ? "it" : "them"} (not in its okKeys)`);
  // a chain at its spend cap with something due on it (SPEND CAP above says how much and until when)
  const reexecsOn = (c: ChainName) => (s.reexecs ?? []).some((r) => destOf(r) === c);
  const dueOn: Record<ChainName, boolean> = {
    bittensor: due.length > 0 || stakeDue || rewardsDue || (s.parkJobs ?? []).length > 0 || reexecsOn("bittensor"),
    base: ready.length > 0 || closeDue || rollDueNow || !!s.flush || reexecsOn("base"),
  };
  for (const c of ["bittensor", "base"] as const) {
    if (capped.has(c) && dueOn[c]) waits.push(`${c === "base" ? "Base" : "Bittensor"}'s sends wait: the keeper is at its 24 h spend cap there (see SPEND CAP above)`);
  }
  // a lane that takes nothing new while one of Cascade's FAILUREs is open on it: what waits there, and why (each round)
  const onBittensorLane = [
    ...(closeDue && !skip.has("close") ? ["closing the batch"] : []),
    ...(rollDueNow && !skip.has("roll") ? ["rolling the empty batch"] : []),
    ...(s.flush && !skip.has("flush") ? [`closing batch ${s.flush.id} once`] : []),
  ];
  if (toBittensor && onBittensorLane.length) waits.push(`new sends toward Bittensor wait (${onBittensorLane.join(", ")}): ${toBittensor}`);
  const onBaseLane = [
    ...payable.filter((b) => !s.vault.paused && s.alphaVault.healthy).map((b) => `paying out batch ${b.key.slice(0, 10)}…`),
    ...(s.parkJobs ?? []).filter((p) => p.job === "refund" && !skip.has(`park:refund:${p.key.toLowerCase()}`)).map((p) => `refunding park ${p.key.slice(0, 10)}…`),
  ];
  if (toBase && onBaseLane.length) waits.push(`new sends toward Base wait (${onBaseLane.join(", ")}): ${toBase}`);
  if (s.rewardsWait && rewardsDue) waits.push("the claims and the adoption wait for the keeper's unsettled Bittensor send (see CLAIMS WAIT above)");
  if (holdWaits && rewardsGo && (s.claims ?? []).length) waits.push(`claims wait while a payout is due: ${s.rootHold}, and a claim stamps the pair it claims on (the buffer rule)`);
  /** The due actions whose key `has` takes, in words, in the order they are offered */
  const named = (has: (key: string) => boolean): string[] => [
    ...due.filter((b) => has(`payouts:${b.key.toLowerCase()}`)).map((b) => `paying out batch ${b.key.slice(0, 10)}…`),
    ...(stakeDue && has("stake") ? ["staking"] : []),
    ...(closeDue && has("close") ? ["closing the batch"] : []),
    ...(rollDueNow && has("roll") ? ["rolling the empty batch"] : []),
    ...(s.flush && has("flush") ? [`closing batch ${s.flush.id} once`] : []),
    ...(s.parkJobs ?? []).filter((p) => has(`park:${p.job}:${p.key.toLowerCase()}`)).map((p) => `the ${p.job} of park ${p.key.slice(0, 10)}…`),
    ...(s.reexecs ?? []).filter((r) => has(`reexec:${r.id.toLowerCase()}`)).map((r) => `re-executing bridge message ${r.id.slice(0, 10)}…`),
    ...(s.adopt && has("adopt") ? ["adopting the surplus"] : []),
    ...(s.claims ?? []).filter((c) => has(`claim:${c.hotkey.toLowerCase()}`)).map((c) => `claiming on hotkey ${c.hotkey.slice(0, 10)}…`),
    ...(s.frees ?? []).filter((f) => has(`free:${f.hotkey.toLowerCase()}`)).map((f) => `freeing hotkey ${f.hotkey.slice(0, 10)}…'s slot`),
  ];
  // R12d (M-1): what waits for room under the spend cap this round, by chain: the close, the roll and the flush on Base, a
  // re-execution on its destination, the rest on Bittensor
  const chainOf = (k: string): ChainName =>
    k === "close" || k === "roll" || k === "flush" ? "base" : (s.reexecs ?? []).some((r) => `reexec:${r.id.toLowerCase()}` === k && destOf(r) === "base") ? "base" : "bittensor";
  for (const c of ["base", "bittensor"] as const) {
    // a chain at its cap is said above (R12e: an action refused at the cap is passed over too, but that line says why)
    const room = capped.has(c) ? [] : named((k) => roomless.has(k) && chainOf(k) === c);
    if (room.length) {
      waits.push(`${room.join(", ")} wait${room.length === 1 ? "s" : ""} for room under the keeper's 24 h spend cap on ${c === "base" ? "Base" : "Bittensor"} (see SPEND CAP ROOM above); ${room.length === 1 ? "it is" : "they are"} tried again each round`);
    }
  }
  // R12e: what its own read refused this round (nothing sent, but a close reverted BatchNotReady: R12f; the Skipped line says)
  const refusedOnRead = named((k) => onRead.has(k) && !roomless.has(k));
  if (refusedOnRead.length) {
    waits.push(
      `${refusedOnRead.join(", ")} wait${refusedOnRead.length === 1 ? "s" : ""}: refused by ${refusedOnRead.length === 1 ? "its" : "their"} own read of the chain this round (see Skipped above); the next round decides again from its own read`,
    );
  }
  // the payouts' final refusals are said apart (FINAL above); what waits for room, and what its own read refused, above
  const skippedNow = named((k) => skip.has(k) && !roomless.has(k) && !onRead.has(k) && !(k.startsWith("payouts:") && final.has(k)));
  if (skippedNow.length) waits.push(`${skippedNow.join(", ")} skipped after repeated refusals (tried again on a back-off; see SKIPPING above)`);
  if (waits.length) return { action: null, reason: `nothing due: ${waits.join("; ")}` };
  if (stakeable && !bigEnough) {
    return {
      action: null,
      reason: `nothing due: ${formatEther(s.vault.available)} TAO of idle TAO waits until the stake would reach the ${formatEther(s.vault.nominatorMinWei)} TAO nominator minimum`,
    };
  }
  if (s.frontDoor.canClose) return { action: null, reason: "nothing due: the open batch is empty" };
  return { action: null, reason: "nothing due: the open batch is not ready to close yet" };
}
