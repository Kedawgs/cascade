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
  /** stake.writeoff_read_gas (R6, ChatGPT R2 claim C): the write-off's aggregate read may cost this much gas before it
   * warns: well under the vault's WRITE_OFF_READ_GAS cap (45,000,000), so there is time to act; at launch it costs about
   * 16,875 (one listed hotkey with root stake) */
  writeOffReadGasWarn: 10_000_000n,
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
  /** keys.safe_unread: ticks in a row a watched Safe's nonce() may go unread (not judged meanwhile; its executions are still counted) */
  safeUnreadTicks: 30,
  /** keys.count_unread: ticks in a row a chain's watched transaction counts may go unread (their batch failing, an RPC
   * rate limit): keys.unexplained_tx judges nothing meanwhile, and keys.delegated, whose code reads ride in the same
   * batch, is blind. 15, at a tick a minute, is unexplainedTxGraceS: a transaction sent as the counts stopped would
   * have paged by now. One failed batch in six (Base's public RPC, 2026-11-01) makes 15 in a row by chance next to
   * impossible */
  countUnreadTicks: 15,
  /** keys.unexplained_tx: a provably stale count (below the highest count read, or below one past an own settled
   * transaction's nonce: a load-balanced node answering from an older head) is judged by what is known for up to
   * nonceBehindTicks − 1 readings in a row; the nonceBehindTicks-th takes the count (a reorg past the settle depth).
   * At a reading a minute it must come before unexplainedTxGraceS ends, so a count read too high is taken back before
   * it can page: mergeThresholds clamps it (with a warning), never refuses */
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
  /** keeper.low_eth: the floor, 0.015 ETH on Base (R12a; 0.002 before): a full 50 + 50 batch's close float, three quotes
   * of about 0.0045 ETH, and its gas, which the keeper must hold for the close to go at all */
  keeperMinEthWei: 15n * 10n ** 15n,
  /** keeper.low_eth (R12a): also below this many of the read full batch's close quote (fullBatchQuote), when that is more:
   * the keeper's float for such a close (three) and one more close's fee, so it warns while one more full close still goes */
  keeperCloseQuotes: 4,
  /** batch.redeem_fee_thin (R12a): a full redeem list's fees (redeemRequestFee × maxRedeems) below this share of a full
   * batch's close quote (150%: 1.5 times) */
  redeemFeeCoverPct: 150,
  /** keeper.low_tao: a round of the keeper's actions on Bittensor, 0.01 TAO (about 0.0002-0.0008 TAO an action). The
   * floor is this plus a claim's up-front gas, (claimGasRequired + claimGasMargin, at most claimGasCeiling) × the base
   * fee (0.285 TAO at launch): Bittensor takes a transaction's whole gas limit up front, so a keeper below it can't claim
   * at all. */
  keeperMinTaoWei: 10n ** 16n,
  /** guardian.low_eth: 0.0005 ETH on Base, half the guardian's launch funding (0.001 ETH, 2026-11-16): what two
   * emergency pauses need at a gas price far above Base's usual one. The front door's pause() used 49,794 gas in the
   * rehearsal (ops v32/budget.ts FOUNDER_STEPS_V32), 62,243 as a wallet's limit (a quarter more), so two are 124,486 gas
   * and 0.00008 ETH of Base's L1 fee (ops BASE_L1_PER_CALL, 0.00004 a call). Base's price sits well under 0.1 gwei and
   * spikes to about 1 (ops config.ts maxGasPrices): at 1 gwei two pauses need 0.0002 ETH, or 0.00043 sized as pnpm ops
   * budget sizes a founder account (the limits at twice the price, its 30% margin). The floor covers them up to about
   * 3.4 gwei. At the keeper's own 5 gwei cap they would need 0.0007 ETH (0.0017 as the budget sizes it), more than the
   * guardian holds: fund it higher, and raise this, if Base's price ever lives there. */
  guardianMinEthWei: 5n * 10n ** 14n,
  /** guardian.low_tao: 0.005 TAO on Bittensor, half the guardian's launch funding (0.01 TAO): two pauses of the vault
   * at a gas price far above Bittensor's usual one. No rehearsal measured the vault's pause(); the guardian's
   * disableBridge on the vault, which writes the same (a flag, the actor, the guardian's clock, two events), used 54,105
   * gas (FOUNDER_STEPS_V32), 67,632 as a wallet's limit, so two are 135,264 gas, which Bittensor takes whole up front.
   * Its gas price sits about 10 gwei (ops config.ts; about 5 in November 2026): at 10 gwei two need 0.00135 TAO, or
   * 0.0035 as the budget sizes it. The floor covers them up to about 37 gwei; the keeper's cap there is 100 gwei, where
   * they would need 0.0135 TAO, more than the guardian holds. */
  guardianMinTaoWei: 5n * 10n ** 15n,
  /** the gas the keeper sends a claim with above the vault's claimGasRequired (ops CLAIM_GAS_MARGIN) */
  claimGasMargin: 2_000_000,
  /** the most gas the keeper sends a claim with: Bittensor's per-transaction ceiling (ops BITTENSOR_TX_GAS_CEILING, Task
   * 65), which holds claimGasRequired + claimGasMargin at the vault's top (63,400,000) */
  claimGasCeiling: 64_900_000,
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
  /** rail.pool_low: the batch lane's bucket (an enabled one) below the front door's maxBatchValue for longer than this */
  railPoolLowS: 3600,
  /** validator.take_high: the validator's take above this (9%) */
  validatorTakeMaxBps: 900,
  /** validator.root_stake_drop: the validator's root stake this far (25%) below its highest of the last 24 hours */
  validatorStakeDropBps: 2500,
  /** oracle.cardinality: the fewest observations each pool the TWAP oracle reads must keep, whatever the block time: its
   * 1,800-second window at one observation a second, plus one (a pool writes at most one per block timestamp, and
   * timestamps are whole seconds: Base's 200 ms blocks share them), the v3.2 oracle's own MIN_CARDINALITY (TWAP_WINDOW + 1,
   * Revision 28). The rule asks more when Base's block time, as the readings measure it, ever needs more (blocks slower
   * than a second), and on v3.2 at least the oracle's MIN_CARDINALITY as read */
  oracleMinCardinality: 1_801,
  /** payout.fee_ceiling: a full payout chunk's quoted fee above this share of the vault's maxFeeAbs */
  payoutFeeCeilingPct: 70,
  /** keeper.idle_unstaked: stakeable TAO idle this long */
  idleUnstakedS: 7200,
  adapterMinReserveWei: 5n * 10n ** 11n,
  twapDivergenceBps: 300,
  /** pool.liquidity: below this share of its 7-day median */
  liquidityDropPct: 50,
  /** pool.liquidity: for this long before it alerts (a price move past a large position's range thins the in-range
   * liquidity for minutes, then it comes back) */
  liquidityLowS: 1800,
  /** batch.one_wallet: one payer with this share of a batch at least half full, or this many entries */
  oneWalletPct: 50,
  oneWalletEntries: 10,
  /** batch.cancel_churn (R8): one address's deposit cancels in the open batch adding up to this share of its
   * maxBatchValue, or this many of them */
  cancelChurnPct: 50,
  cancelChurnCount: 3,
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
  /** the hourly logs cross-check: at most this long of each chain's newest settled blocks is re-read through the second
   * endpoint per run, in blocks at its block time as measured (src/blocktime.ts; Base: 20 minutes, 6,000 of its 200 ms
   * blocks, 60 windows of 100; Bittensor: an hour, 300 of its 12-second blocks, one window) */
  logsCheckBaseS: 1200,
  logsCheckBittensorS: 3600,
  /** indexer.unverified: the second endpoint failing the cross-check for this long */
  logsCheckUnverifiedS: 3 * 3600,
  /** monitor.unjudged: a critical condition its rule couldn't judge for this long, tick after tick */
  unjudgedCriticalS: 1800,
  /** monitor.unjudged for site.integrity: about three incomplete site passes in a row (a pass an hour; one alone is
   * site.unreachable's warning) */
  siteUnjudgedS: 3 * 3600,
  /** site.redeploy_race: passes in a row that dropped files as gone with a redeployed build */
  siteRaceStreak: 3,
  /** bridge.parked (v3.2): a front-door batch parked this long, by the settled history, is critical (spec §7: "critical
   * after one hour"); the keeper delivers a park as soon as it would succeed */
  parkedCriticalS: 3600,
  /** stake.surplus_unadopted (v3.2): a surplus of at least the chain's minimum waiting this long (the keeper adopts at
   * most once a day) */
  surplusUnadoptedS: 86_400,
  /** stake.unstake_skipped (v3.2): this many UnstakeSkipped of one hotkey within unstakeSkippedS; one skip is the walk
   * doing its job */
  unstakeSkippedCount: 3,
  unstakeSkippedS: 86_400,
  /** oracle.thin_pool_repeated (v3.2): a pool held thinner than the front door's floor this long (two hours: four of the
   * oracle's 30-minute windows) */
  thinPoolRepeatedS: 7200,
  /** oracle.thin_pool_repeated (v3.2), its other form (Task 57's review, Minor 4): this many thin episodes (each held on
   * two readings) within thinPoolEpisodesS, the pool deep between them. One or two in a day can be liquidity providers
   * moving their ranges; three in a day is a pattern, a griefer thinning the pool only around the keeper's rounds (about
   * $88 a time, R3 C-L1) or a pool losing its depth on and off. A day spans every keeper round, however they are spaced. */
  thinPoolEpisodes: 3,
  thinPoolEpisodesS: 86_400,
  /** swap.below_oracle (v3.2): a settled stake or delivery this far (1%) below the oracle's value (the user's concern of
   * 2026-11-04: swaps must never hurt a customer; the on-chain floors allow 5% and 1.5%) */
  swapBelowOracleBps: 100,
  /** R4 (D-L3) admin.stamp_quiet: a chain's owner clock (its last relayed stamp) may be this old before it pages; 0, the
   * default, is off (the founder sets it with the stamp bot, e.g. 50400 for a 12-hour stack relayed hourly) */
  stampQuietS: 0,
  /** R4 (A-L2) cap.exits_consumed: the front door's netForwarded may exceed the vault's assets by this much (1 TAO) */
  capExitsGapWei: 10n ** 18n,
  /** stake.min_near_floor and stake.min_at_floor: Bittensor's minimum stake as a share of MIN_REDEEM_VALUE (0.03 TAO) */
  minStakeWarnPct: 50,
  minStakeCriticalPct: 80,
  /** R4 (the email flood): the most critical emails a tick sends; the rest stay due and go on the next ticks, each once */
  criticalEmailsPerTick: 25,
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
  // keys.unexplained_tx judges a provably stale count by a higher one for nonceBehindTicks − 1 readings (a tick a
  // minute) and takes the count on the nonceBehindTicks-th: a count read too high (a node on a fork) must be taken back
  // before the grace ends, or it pages. Clamped, never refused (a refused config runs no tick at all): a shorter hold
  // only means more false alerts, never a miss
  const most = Math.max(1, Math.ceil(t.unexplainedTxGraceS / TICK_S) - 1);
  if (t.nonceBehindTicks > most) {
    console.warn(`thresholds: nonceBehindTicks ${t.nonceBehindTicks} reaches unexplainedTxGraceS ${t.unexplainedTxGraceS} s at a tick a minute; using ${most}`);
    t.nonceBehindTicks = most;
  }
  return t;
}

/** How far a chain's settled history may lag before the keeper holds (and `indexer.lag` warns):
 * a quarter of the payout delay, at most 30 minutes (15 minutes on v3-test, 30 at launch). The keeper
 * uses the same formula. */
export function lagLimitS(t: Thresholds, payoutDelayS: number): number {
  return Math.min(t.lagCapS, Math.floor(payoutDelayS / t.lagPayoutDelayDivisor));
}
