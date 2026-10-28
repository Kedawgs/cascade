import { type Address, formatEther, type Hex } from "viem";

/** A USDC delivery that cleared the decision and its simulation this round. */
export interface DueDelivery {
  user: Address;
  keeperMinOut: bigint;
}

/** What closing the open batch earns and costs, in USDC units (6 decimals). */
export interface CloseEconomics {
  /** The batch's estimated Cascade fees: its deposit fees, the swap fee on its TAO, and its fee pot */
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
  };
  /** v3: deliveries ready to send (the run loop fills it; reward claims are never an action) */
  deliveries?: DueDelivery[];
}

export type Action =
  | { kind: "payouts"; key: Hex }
  | { kind: "deliver"; user: Address; keeperMinOut: bigint }
  | { kind: "stake" }
  | { kind: "close" }
  /** closeBatch on an empty batch, with no value: the front door restarts its timer (BatchRolled) */
  | { kind: "roll" };

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
  const fd = s.frontDoor;
  return fd.full || s.closeMaxWaitS <= fd.batchInterval || fd.now >= fd.openStart + s.closeMaxWaitS;
}

/** The fee estimate for a batch, in USDC units: a deposit fee per deposit, the swap fee on its TAO at
 * the oracle's price, and its fee pot at ETH's price; and the close's bridge fee at ETH's price. Prices
 * are USDC units per 1e18 wei. */
export function closeEconomicsOf(r: {
  nDeposits: number;
  depositFeeUsdc: bigint;
  totalDeposits: bigint;
  taoPriceUsdc: bigint;
  swapFeeBps: number;
  feePot: bigint;
  ethPriceUsdc: bigint;
  bridgeFeeWei: bigint;
}): CloseEconomics {
  const E18 = 10n ** 18n;
  const feesUsdc =
    BigInt(r.nDeposits) * r.depositFeeUsdc + (r.totalDeposits * r.taoPriceUsdc * BigInt(r.swapFeeBps)) / 10_000n / E18 + (r.feePot * r.ethPriceUsdc) / E18;
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

/** For `status`: why the keeper holds a batch the front door would let close, or undefined. */
export const closeHold = (s: State): string | undefined => (isHeld(s) ? `the keeper holds it: it ${holdWait(s)}` : undefined);

/** The next thing the keeper should do: a due payout, then a USDC delivery, then staking, then closing
 * (or rolling) the batch. A batch with entries closes once the front door allows it and it is full, at
 * least `closeMaxWaitS` old, or its fees cover the bridge fee; fees that could not be read never close it
 * early. An empty one is rolled under a max wait while AlphaVault is healthy (see rollable). */
export function decideNext(s: State): { action: Action | null; reason: string } {
  const open = s.vault.batches.filter((b) => b.cursor < b.count);
  const due = open.filter((b) => s.now >= b.queuedAt + s.vault.payoutDelay);
  const held = isHeld(s);
  const closable = s.frontDoor.canClose && s.frontDoor.nDeposits + s.frontDoor.nRedeems > 0 && !held;

  if (due.length && !s.vault.paused && s.alphaVault.healthy) {
    return { action: { kind: "payouts", key: due[0].key }, reason: "a payout batch is past its delay" };
  }
  const ready = s.deliveries ?? [];
  if (ready.length && !s.frontDoor.paused) {
    const d = ready[0];
    return { action: { kind: "deliver", user: d.user, keeperMinOut: d.keeperMinOut }, reason: `${d.user}'s TAO is ready to deliver as USDC` };
  }
  const stakeable = s.vault.available >= s.vault.minStakeWei;
  const bigEnough = s.vault.rootStake + s.vault.available >= s.vault.nominatorMinWei;
  if (stakeable && bigEnough && !s.vault.paused) {
    return { action: { kind: "stake" }, reason: "the vault holds idle TAO above the staking floor" };
  }
  if (closable && !s.frontDoor.paused && s.alphaVault.healthy) {
    return { action: { kind: "close" }, reason: "the open batch is ready to close" };
  }
  if (rollable(s) && !s.frontDoor.paused) {
    return { action: { kind: "roll" }, reason: `rolling the empty batch so its ${hours(s.closeMaxWaitS)} wait starts from the next deposit` };
  }

  if (!s.alphaVault.healthy && (due.length || closable)) {
    return { action: null, reason: "AlphaVault is paused or migrating — not paying out or closing batches" };
  }
  if (s.vault.paused && due.length) return { action: null, reason: "the vault is paused — not paying out" };
  if (s.frontDoor.paused && closable) return { action: null, reason: "the front door is paused — not closing the batch" };
  if (s.frontDoor.paused && rollDue(s)) return { action: null, reason: "the front door is paused — not rolling the empty batch" };
  if (!s.alphaVault.healthy && rollDue(s)) return { action: null, reason: "AlphaVault is paused or migrating — not rolling the empty batch" };
  const waits: string[] = [];
  if (open.length) waits.push(`next payout at ${hhmm(Math.min(...open.map((b) => b.queuedAt + s.vault.payoutDelay)))}`);
  if (held) waits.push(`the open batch ${holdWait(s)}`);
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
