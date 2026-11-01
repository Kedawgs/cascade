import { ConfigError } from "./errors.ts";

/** Every number the monitor's rules use (spec section 6), in one place. The THRESHOLDS var overrides
 * any of them, and the THRESHOLDS_SECRET secret overrides both, so production values needn't be public.
 * Amounts in wei or rao are bigints (decimal strings in the JSON); times are seconds. */
export const DEFAULTS = {
  /** price.drop: the share of the price that a drop must exceed beyond honest rounding */
  priceDropEpsilon: 1e-12,
  /** price.drop holds when the price is this far below the 24-hour high */
  holdPriceDropBps: 10,
  /** stake.unexplained_drop: a hotkey's stake may fall this much without a vault event; stake.divergence: stake
   * on an unlisted hotkey up to this much is dust, not a divergence */
  stakeDustRao: 1000n,
  /** stake.divergence: stake on an unlisted hotkey holds only when it is at least this share of the vault's
   * stake (counted plus unlisted) and the counted stake fell by as much; a smaller or unmatched amount (a
   * stranger's transfer_stake gift) is the stake.unlisted warning */
  stakeDivergenceMinBps: 100,
  /** vault.stake_moved: a StakeMoved of this much or more (100 TAO) is critical, whatever its destination */
  stakeMoveCriticalRao: 100n * 10n ** 9n,
  /** vault.direct_use: a direct deposit or redeem of this much or more (10 TAO) is critical */
  directCriticalWei: 10n * 10n ** 18n,
  /** keys.unexplained_tx: how long an unexplained transaction may stay unexplained */
  unexplainedTxGraceS: 900,
  /** keys.safe_unread: ticks in a row a watched Safe's nonce() may go unread (it is skipped meanwhile) */
  safeUnreadTicks: 30,
  /** keys.unexplained_tx: count readings in a row that may be provably stale (below the highest count read, or below
   * one past an own settled transaction's nonce: a load-balanced node answering from an older head) and still be
   * judged by what is known; one more is a reorg past the settle depth, and the count is taken. Must stay under
   * unexplainedTxGraceS at a reading a minute, so a count read too high is taken back before it can page */
  nonceBehindTicks: 10,
  /** fmtao.unbacked: FM-TAO on Base may exceed the lock by this much */
  fmtaoBackingSlackWei: 10n ** 16n,
  /** fmtao.depeg: the pool's TAO price this far from the reference */
  depegBps: 500,
  /** price.reference_unavailable: no reference price for this long */
  referenceUnavailableS: 3600,
  /** price.reference_unavailable: also when fewer than this share of the last hour's price reads answered */
  referenceMinAvailablePct: 50,
  /** ccip.undelivered: a message not arrived this long after its source block */
  undeliveredS: 3600,
  /** batch.past_max_wait: this long past the batch's due close */
  maxWaitGraceS: 900,
  /** payout.overdue: this long past queuedAt + payoutDelay */
  payoutGraceS: 3600,
  /** bridge.check_stuck: a delivery's check still waiting this long after the delivery */
  checkStuckS: 3600,
  /** delivery.overdue: this long after a user's PayoutReceived */
  deliveryGraceS: 7200,
  /** keeper.low_eth: 0.002 ETH on Base */
  keeperMinEthWei: 2n * 10n ** 15n,
  /** keeper.low_tao: a round of the keeper's actions on Bittensor, 0.01 TAO (about 0.0002-0.0008 TAO an action). The
   * floor is this plus a claim's up-front gas, (claimGasRequired + claimGasMargin) × the base fee (0.285 TAO at
   * launch): Bittensor takes a transaction's whole gas limit up front, so a keeper below it can't claim at all. */
  keeperMinTaoWei: 10n ** 16n,
  /** the gas the keeper sends a claim with above the vault's claimGasRequired (ops CLAIM_GAS_MARGIN) */
  claimGasMargin: 2_000_000,
  /** fmtao.backing_true: the AlphaVault's backing may fall short of wTAO's supply by this share of it (0.1%; at least
   * fmtaoBackingSlackWei). Before BACKING_HOLD is switched on, set it from a week of hour rows (README) */
  backingToleranceBps: 10,
  /** fmtao.lock_outside: this much wTAO (100 TAO) outside the lock pool for lockOutsideS is a warning (0.047 TAO was
   * on 2026-10-31; anyone can mint wTAO with depositLiquid and keep it) */
  lockOutsideMinWei: 100n * 10n ** 18n,
  /** fmtao.backing_true:lock: more than this share (5%) of wTAO's supply outside the lock pool for lockOutsideS */
  lockOutsideCriticalBps: 500,
  lockOutsideS: 3600,
  /** ccip.rate_limited: a token pool's bucket under this much (10 TAO) for longer than ccipRateLimitedS */
  ccipBucketMinWei: 10n * 10n ** 18n,
  ccipRateLimitedS: 600,
  /** validator.take_high: the validator's take above this (9%) */
  validatorTakeMaxBps: 900,
  /** validator.root_stake_drop: the validator's root stake this far (25%) below its highest of the last 24 hours */
  validatorStakeDropBps: 2500,
  /** oracle.cardinality: the observations each pool the TWAP oracle reads must keep: its 1,800-second window of
   * 2-second Base blocks, plus one */
  oracleMinCardinality: 901,
  /** payout.fee_ceiling: a full payout chunk's quoted fee above this share of the vault's maxFeeAbs */
  payoutFeeCeilingPct: 70,
  /** keeper.idle_unstaked: stakeable TAO idle this long */
  idleUnstakedS: 7200,
  adapterMinReserveWei: 5n * 10n ** 11n,
  twapDivergenceBps: 300,
  /** pool.liquidity: below this share of its 7-day median */
  liquidityDropPct: 50,
  /** batch.one_wallet: one payer with this share of a batch at least half full, or this many entries */
  oneWalletPct: 50,
  oneWalletEntries: 10,
  capNearlyFullPct: 90,
  /** unstakes.tiny_wave: this many redeems in 24 h each under this amount, or a redeem list this full */
  tinyUnstakeWei: 2n * 10n ** 16n,
  tinyUnstakeCount: 20,
  redeemListPct: 80,
  outflowNearPct: 80,
  /** rewards.uncollected: no claim for this long, or this much waiting (25 × the keeper's 0.057 TAO claim) */
  rewardsMaxAgeS: 35 * 86400,
  rewardsDueWei: 25n * 57n * 10n ** 15n,
  /** validator.not_earning: unclaimed rewards flat this long */
  notEarningS: 86400,
  /** validator.not_earning is judged only while the vault holds at least this much stake on the stake hotkey (1 TAO):
   * an empty vault earns nothing, and a tiny stake's day of root rewards can round to nothing */
  notEarningMinStakeRao: 10n ** 9n,
  /** lagLimit = min(lagCapS, payoutDelay / lagPayoutDelayDivisor) */
  lagCapS: 1800,
  lagPayoutDelayDivisor: 4,
  /** indexer.blind: a lag above max(2 × lagLimit, blindMinS) */
  blindMinS: 1800,
  /** monitor.stalled: no complete tick for this long */
  stalledS: 900,
  /** fmtao.mint_surge: FM-TAO supply up this much in an hour beyond Cascade's payouts */
  mintSurgeWei: 500n * 10n ** 18n,
  /** a critical is re-sent this often while open and unacknowledged, at most this many times */
  criticalResendS: 3600,
  criticalMaxSends: 6,
  /** warnings go out together, at most this often */
  warningEveryS: 1800,
  siteUnreachableS: 1800,
  /** monitor.chain_unreadable: this many ticks in a row without a usable reading */
  chainUnreadableTicks: 5,
  emailFailingS: 1800,
  /** the hourly logs cross-check: at most this many of each chain's newest settled blocks are re-read through the
   * second endpoint per run (Base: 20 minutes of 2-second blocks, 6 windows of 100; Bittensor: an hour of
   * 12-second blocks, one window) */
  logsCheckBaseBlocks: 600,
  logsCheckBittensorBlocks: 300,
  /** indexer.unverified: the second endpoint failing the cross-check for this long */
  logsCheckUnverifiedS: 3 * 3600,
  /** monitor.unjudged: a critical condition its rule couldn't judge for this long, tick after tick */
  unjudgedCriticalS: 1800,
  /** monitor.unjudged for site.integrity: about three incomplete site passes in a row (a pass an hour; one alone is
   * site.unreachable's warning) */
  siteUnjudgedS: 3 * 3600,
  /** rule ids switched off (the proposed rules, open question 13, can be turned off here) */
  rules: { off: [] as string[] },
};

export type Thresholds = typeof DEFAULTS;
type Key = keyof Thresholds;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** A JSON setting: a string holding JSON, or (for a var written as JSON in wrangler.jsonc) the value
 * itself. Absent or empty is `undefined`. The parse error is never echoed: it can quote the text. */
export function jsonSetting(field: string, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError(field, "is not valid JSON");
  }
}

/** One source's overrides applied to `t`: every key must be a threshold, numbers must be finite and
 * not negative, amounts decimal strings, and `rules.off` a list of rule ids. */
function apply(t: Thresholds, field: string, raw: unknown): void {
  const over = jsonSetting(field, raw);
  if (over === undefined) return;
  if (!isObject(over)) throw new ConfigError(field, "is not a JSON object");
  const out = t as Record<Key, unknown>;
  for (const [key, value] of Object.entries(over)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new ConfigError(field, `names an unknown threshold "${key}"`);
    const k = key as Key;
    const kind = typeof DEFAULTS[k];
    if (k === "rules") {
      const off = isObject(value) ? value.off : undefined;
      if (!isObject(value) || Object.keys(value).some((x) => x !== "off") || !Array.isArray(off) || !off.every((r) => typeof r === "string" && /^[a-z0-9_.]+$/.test(r))) {
        throw new ConfigError(field, `"rules" must be {"off": [rule ids]}`);
      }
      out.rules = { off: [...(off as string[])] };
    } else if (kind === "bigint") {
      if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) throw new ConfigError(field, `"${key}" must be a whole amount as a decimal string`);
      out[k] = BigInt(value);
    } else {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ConfigError(field, `"${key}" must be a number, 0 or more`);
      if (k === "lagPayoutDelayDivisor" && value === 0) throw new ConfigError(field, `"${key}" must be above 0`);
      out[k] = value;
    }
  }
}

/** The tick's cadence (src/crons.ts CRONS.tick, every minute). */
const TICK_S = 60;

/** The defaults, with the THRESHOLDS var's overrides and then the THRESHOLDS_SECRET secret's (which
 * win). Unknown keys and wrong types are refused, so a typo can't silently leave a default in place. */
export function mergeThresholds(varJson: unknown, secretJson: unknown): Thresholds {
  const t: Thresholds = { ...DEFAULTS, rules: { off: [...DEFAULTS.rules.off] } };
  apply(t, "THRESHOLDS", varJson);
  apply(t, "THRESHOLDS_SECRET", secretJson);
  // keys.unexplained_tx judges a provably stale count by a higher one until the nonceBehindTicks-th reading (a tick a
  // minute) takes the count: a count read too high (a node on a fork) must be taken back before the grace ends, or it
  // pages. At 1 or less nothing is held, so there is nothing to bound
  if (t.nonceBehindTicks > 1 && t.nonceBehindTicks * TICK_S >= t.unexplainedTxGraceS) {
    throw new ConfigError("THRESHOLDS", `nonceBehindTicks (${t.nonceBehindTicks}) at a tick a minute must stay under unexplainedTxGraceS (${t.unexplainedTxGraceS} s)`);
  }
  return t;
}

/** How far a chain's settled history may lag before the keeper holds (and `indexer.lag` warns):
 * a quarter of the payout delay, at most 30 minutes (15 minutes on v3-test, 30 at launch). The keeper
 * uses the same formula. */
export function lagLimitS(t: Thresholds, payoutDelayS: number): number {
  return Math.min(t.lagCapS, Math.floor(payoutDelayS / t.lagPayoutDelayDivisor));
}
