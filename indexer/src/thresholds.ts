import { ConfigError } from "./errors.ts";

/** Every number the monitor's rules use (spec section 6), in one place. The THRESHOLDS var overrides
 * any of them, and the THRESHOLDS_SECRET secret overrides both, so production values needn't be public.
 * Amounts in wei or rao are bigints (decimal strings in the JSON); times are seconds. */
export const DEFAULTS = {
  /** price.drop: the share of the price that a drop must exceed beyond honest rounding */
  priceDropEpsilon: 1e-12,
  /** price.drop holds when the price is this far below the 24-hour high */
  holdPriceDropBps: 10,
  /** stake.unexplained_drop: a hotkey's stake may fall this much without a vault event */
  stakeDustRao: 1000n,
  /** keys.unexplained_tx: how long an unexplained transaction may stay unexplained */
  unexplainedTxGraceS: 900,
  /** fmtao.unbacked: FM-TAO on Base may exceed the lock by this much */
  fmtaoBackingSlackWei: 10n ** 16n,
  /** fmtao.depeg: the pool's TAO price this far from the reference */
  depegBps: 500,
  /** price.reference_unavailable: no reference price for this long */
  referenceUnavailableS: 3600,
  /** ccip.undelivered: a message not arrived this long after its source block */
  undeliveredS: 3600,
  /** batch.past_max_wait: this long past the batch's due close */
  maxWaitGraceS: 900,
  /** payout.overdue: this long past queuedAt + payoutDelay */
  payoutGraceS: 3600,
  /** delivery.overdue: this long after a user's PayoutReceived */
  deliveryGraceS: 7200,
  keeperMinEthWei: 2n * 10n ** 15n,
  keeperMinTaoWei: 10n ** 17n,
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

/** The defaults, with the THRESHOLDS var's overrides and then the THRESHOLDS_SECRET secret's (which
 * win). Unknown keys and wrong types are refused, so a typo can't silently leave a default in place. */
export function mergeThresholds(varJson: unknown, secretJson: unknown): Thresholds {
  const t: Thresholds = { ...DEFAULTS, rules: { off: [...DEFAULTS.rules.off] } };
  apply(t, "THRESHOLDS", varJson);
  apply(t, "THRESHOLDS_SECRET", secretJson);
  return t;
}

/** How far a chain's settled history may lag before the keeper holds (and `indexer.lag` warns):
 * a quarter of the payout delay, at most 30 minutes (15 minutes on v3-test, 30 at launch). The keeper
 * uses the same formula. */
export function lagLimitS(t: Thresholds, payoutDelayS: number): number {
  return Math.min(t.lagCapS, Math.floor(payoutDelayS / t.lagPayoutDelayDivisor));
}
