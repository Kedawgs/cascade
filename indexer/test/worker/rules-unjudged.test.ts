import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { type Finding, markSent, reconcile, type Unjudged } from "../../src/alerts.ts";
import * as deps from "../../src/rules/deps.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import type { Rule } from "../../src/rules/index.ts";
import * as market from "../../src/rules/market.ts";
import * as ops from "../../src/rules/ops.ts";
import * as solvency from "../../src/rules/solvency.ts";
import type { BaseState, BitState, Bucket, HourAgg } from "../../src/snapshot.ts";
import { loadTickState } from "../../src/store.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { wipe } from "./d1-count.ts";
import { testConfig } from "./fixtures.ts";
import { baseState, bitState, reading, ruleCtx } from "./rule-ctx.ts";

// A condition resolves only on a reading that shows it cleared. A rule that can't judge it (this tick's reading
// missing, or lacking a field it needs) notes it unjudged, and its open alert is left as it is: neither resolved
// nor sent again. Without this, a missing reading resolved the alert and the next good one opened it again, as a
// new alert and a new email (oracle.cardinality four times in a day, validator.not_earning two minutes apart).

const E18 = 10n ** 18n;
const NOW = 1_800_000_000;
const cfg = testConfig();
const HK = cfg.deployment.stakeHotkey;
const KEY = "0x00000000000000000000000000000000000000000000000000000000000000aa" as Hex;
const USER = "0x00000000000000000000000000000000000000a1" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

/** A context with this tick's readings (none for a chain left out) and, for the ×2 rules, the previous ones. */
function ctx(o: {
  base?: Partial<BaseState>;
  bit?: Partial<BitState>;
  baseBefore?: Partial<BaseState>;
  bitBefore?: Partial<BitState>;
  meta?: Record<string, string>;
  hours?: HourAgg[];
  payoutUsers?: RuleCtx["payoutUsers"];
  pendingPayoutKeys?: Hex[];
  headTime?: number;
}): RuleCtx {
  const c = ruleCtx();
  const previous = {
    base: o.baseBefore ? reading(37_000_000n, NOW - 60, baseState(o.baseBefore)) : undefined,
    bittensor: o.bitBefore ? reading(6_900_000n, NOW - 60, bitState(o.bitBefore)) : undefined,
  };
  return ruleCtx({
    cfg,
    nowS: NOW,
    snap: { ...c.snap, base: o.base ? reading(37_000_030n, NOW, baseState(o.base)) : undefined, bittensor: o.bit ? reading(6_900_005n, NOW, bitState(o.bit)) : undefined },
    previous,
    history: { base: previous.base ? [previous.base] : [], bittensor: previous.bittensor ? [previous.bittensor] : [] },
    meta: o.meta ?? {},
    hours: o.hours ?? [],
    payoutUsers: o.payoutUsers ?? [],
    pendingPayoutKeys: o.pendingPayoutKeys ?? [],
    settled: { base: { block: 10n ** 9n, time: NOW, headTime: o.headTime }, bittensor: { block: 10n ** 9n, time: NOW, headTime: o.headTime } },
    logs: logQuery([]),
  });
}

/** What a rule found, and what it couldn't judge. */
const judged = (r: Rule, c: RuleCtx) => ({ found: r.run(c).map((f) => f.key), unjudged: c.unjudged });
const blind = (marks: Unjudged[]) => ({ found: [], unjudged: marks });
const CLEAR = { found: [], unjudged: [] };

const bucket = (tokens: bigint): Bucket => ({ tokens, isEnabled: true, capacity: 5000n * E18, rate: E18 });
const lane = { inbound: bucket(5000n * E18), outbound: bucket(5000n * E18) };
const openBatch = (o: Partial<NonNullable<BaseState["openBatch"]>> = {}) => ({ id: 9n, start: NOW - 60, totalDeposits: E18, feePot: 0n, nDeposits: 1, nRedeems: 0, ...o });
const hourRows = (n: number, o: Partial<HourAgg> = {}): HourAgg[] => Array.from({ length: n }, (_, i) => ({ hour: Math.floor(NOW / 3600) * 3600 - i * 3600, ticks: 60, spotSum: 0, spotCount: 0, ...o }));
const alphaRead = { isPaused: false, pausedUntil: 0n, pauseableAfter: 0n, migrationReadyAt: 0n, migrationTarget: ZERO, migrationExecuted: false, migrationFinished: false };

describe("the operational conditions, unread", () => {
  it("batch.past_max_wait: no reading, no open batch or no interval read is unjudged; an empty batch, or one not yet due, is clear", () => {
    const mark = [{ rule: "batch.past_max_wait" as const }];
    expect(judged(ops.batchPastMaxWait, ctx({}))).toEqual(blind(mark));
    expect(judged(ops.batchPastMaxWait, ctx({ base: { batchInterval: 3600 } }))).toEqual(blind(mark));
    expect(judged(ops.batchPastMaxWait, ctx({ base: { openBatch: openBatch({ start: NOW - 86_400 }) } }))).toEqual(blind(mark));
    expect(judged(ops.batchPastMaxWait, ctx({ base: { openBatch: openBatch({ start: NOW - 86_400, nDeposits: 0 }), batchInterval: 3600 } }))).toEqual(CLEAR);
    expect(judged(ops.batchPastMaxWait, ctx({ base: { openBatch: openBatch(), batchInterval: 3600 } }))).toEqual(CLEAR);
  });

  it("payout.overdue: no reading is unjudged for every key; a key whose batch wasn't read, for that key; a batch paid out is clear", () => {
    expect(judged(ops.payoutOverdue, ctx({ pendingPayoutKeys: [KEY] }))).toEqual(blind([{ rule: "payout.overdue" }]));
    expect(judged(ops.payoutOverdue, ctx({ bit: {}, pendingPayoutKeys: [KEY] }))).toEqual(blind([{ rule: "payout.overdue", key: `payout.overdue:${KEY}` }]));
    const paid = { payoutBatches: { [KEY]: { queuedAt: NOW - 86_400, cursor: 3, count: 3, chunk: 1, remaining: 0n } } };
    expect(judged(ops.payoutOverdue, ctx({ bit: paid, pendingPayoutKeys: [KEY] }))).toEqual(CLEAR);
  });

  it("delivery.overdue: no reading is unjudged; a user whose claimable or preference wasn't read, for that user; nothing claimable is clear", () => {
    const users = [{ user: USER, at: NOW - 86_400 }];
    expect(judged(ops.deliveryOverdue, ctx({ payoutUsers: users }))).toEqual(blind([{ rule: "delivery.overdue" }]));
    expect(judged(ops.deliveryOverdue, ctx({ base: {}, payoutUsers: users }))).toEqual(blind([{ rule: "delivery.overdue", key: `delivery.overdue:${USER}` }]));
    const pref = { minUsdcPerTao: 1n, deadline: NOW + 3600, destination: 0 };
    expect(judged(ops.deliveryOverdue, ctx({ base: { claimable: { [USER]: 0n }, deliveryOf: { [USER]: pref } }, payoutUsers: users }))).toEqual(CLEAR);
  });

  it("the balances: keeper.low_eth, keeper.low_tao, adapter.low_reserve and keeper.idle_unstaked are unjudged unread, clear when read and fine", () => {
    expect(judged(ops.keeperLowEth, ctx({ base: {} }))).toEqual(blind([{ rule: "keeper.low_eth", key: "keeper.low_eth" }]));
    expect(judged(ops.keeperLowEth, ctx({ base: { keeperBalance: E18 } }))).toEqual(CLEAR);
    expect(judged(ops.keeperLowTao, ctx({}))).toEqual(blind([{ rule: "keeper.low_tao", key: "keeper.low_tao" }]));
    // above a round (0.01 TAO) but the claim's gas unread: whether it covers a claim can't be told
    expect(judged(ops.keeperLowTao, ctx({ bit: { keeperBalance: 2n * 10n ** 16n } }))).toEqual(blind([{ rule: "keeper.low_tao", key: "keeper.low_tao" }]));
    expect(judged(ops.keeperLowTao, ctx({ bit: { keeperBalance: E18, claimGasRequired: 1_000_000n, baseFee: 10n ** 9n } }))).toEqual(CLEAR);
    expect(judged(ops.adapterLowReserve, ctx({ bit: {} }))).toEqual(blind([{ rule: "adapter.low_reserve", key: "adapter.low_reserve" }]));
    expect(judged(ops.adapterLowReserve, ctx({ bit: { adapterBalance: E18 } }))).toEqual(CLEAR);
    const idle = ctx({ bit: { balance: 10n ** 12n, pendingPayouts: 0n }, meta: { idle_since: String(NOW - 86_400) } });
    expect(judged(ops.keeperIdleUnstaked, idle)).toEqual(blind([{ rule: "keeper.idle_unstaked", key: "keeper.idle_unstaked" }]));
    // its mark is left as it is
    expect(idle.writes.meta).toEqual([]);
    expect(judged(ops.keeperIdleUnstaked, ctx({ bit: { balance: 10n ** 12n, pendingPayouts: 0n, minStakeRao: 500_000n } }))).toEqual(CLEAR);
  });

  it("the front door's limits: cap.nearly_full, batch.one_wallet, unstakes.tiny_wave and outflow.near_limit", () => {
    expect(judged(ops.capNearlyFull, ctx({ base: { openBatch: openBatch() } }))).toEqual(blind([{ rule: "cap.nearly_full", key: "cap.nearly_full" }]));
    expect(judged(ops.capNearlyFull, ctx({ base: { openBatch: openBatch(), netForwarded: 0n, depositCap: 100n * E18 } }))).toEqual(CLEAR);
    // a cap of 0 is no cap to fill
    expect(judged(ops.capNearlyFull, ctx({ base: { openBatch: openBatch(), netForwarded: 0n, depositCap: 0n } }))).toEqual(CLEAR);
    expect(judged(ops.batchOneWallet, ctx({ base: {} }))).toEqual(blind([{ rule: "batch.one_wallet" }]));
    expect(judged(ops.batchOneWallet, ctx({ base: { openBatch: openBatch() } }))).toEqual(CLEAR);
    const tiny = [{ rule: "unstakes.tiny_wave" as const, key: "unstakes.tiny_wave" }];
    // the price unread (the tiny requests can't be priced), or the redeem list unread
    expect(judged(ops.unstakesTinyWave, ctx({ bit: {}, base: { openBatch: openBatch(), maxRedeems: 10 } }))).toEqual(blind(tiny));
    expect(judged(ops.unstakesTinyWave, ctx({ bit: { price: E18 }, base: {} }))).toEqual(blind(tiny));
    expect(judged(ops.unstakesTinyWave, ctx({ bit: { price: E18 }, base: { openBatch: openBatch(), maxRedeems: 10 } }))).toEqual(CLEAR);
    const outflow = { rootStakeRao: 10n ** 12n, balance: 10n ** 12n, maxDailyOutflowBps: 1000n, minDailyOutflow: E18, price: E18 };
    expect(judged(ops.outflowNearLimit, ctx({ bit: { ...outflow, price: undefined } }))).toEqual(blind([{ rule: "outflow.near_limit", key: "outflow.near_limit" }]));
    expect(judged(ops.outflowNearLimit, ctx({ bit: outflow, base: { openBatch: openBatch() } }))).toEqual(CLEAR);
  });

  it("the rewards: rewards.uncollected and validator.not_earning", () => {
    const rewards = [{ rule: "rewards.uncollected" as const, key: "rewards.uncollected" }];
    expect(judged(ops.rewardsUncollected, ctx({}))).toEqual(blind(rewards));
    // claimed lately, but what waits unread
    expect(judged(ops.rewardsUncollected, ctx({ bit: { lastClaimAt: NOW - 3600 } }))).toEqual(blind(rewards));
    expect(judged(ops.rewardsUncollected, ctx({ bit: { lastClaimAt: NOW - 3600, unclaimed: 0n } }))).toEqual(CLEAR);
    const earning = [{ rule: "validator.not_earning" as const, key: "validator.not_earning" }];
    const dayAgo = [{ hour: Math.floor((NOW - 86_400) / 3600) * 3600, ticks: 60, spotSum: 0, spotCount: 0, unclaimedLast: E18 }];
    const staked = { stakes: { [HK]: 100n * 10n ** 9n } };
    expect(judged(ops.validatorNotEarning, ctx({ bit: staked, hours: dayAgo }))).toEqual(blind(earning));
    // no hour row a day ago to compare with
    expect(judged(ops.validatorNotEarning, ctx({ bit: { ...staked, unclaimed: E18 } }))).toEqual(blind(earning));
    expect(judged(ops.validatorNotEarning, ctx({ bit: { ...staked, unclaimed: 2n * E18 }, hours: dayAgo }))).toEqual(CLEAR);
  });

  it("rail.alpha_vault: unjudged without a reading, or with nothing found and a field unread", () => {
    const mark = [{ rule: "rail.alpha_vault" as const, key: "rail.alpha_vault" }];
    expect(judged(ops.railAlphaVault, ctx({}))).toEqual(blind(mark));
    expect(judged(ops.railAlphaVault, ctx({ bit: { alpha: { isPaused: false } } }))).toEqual(blind(mark));
    expect(judged(ops.railAlphaVault, ctx({ bit: { alpha: alphaRead } }))).toEqual(CLEAR);
  });

  it("indexer.lag and indexer.blind: a chain's head time unknown is unjudged; known and close is clear", () => {
    expect(judged(ops.indexerLag, ctx({}))).toEqual(
      blind([
        { rule: "indexer.lag", key: "indexer.lag:base" },
        { rule: "indexer.blind", key: "indexer.blind:base" },
        { rule: "indexer.lag", key: "indexer.lag:bittensor" },
        { rule: "indexer.blind", key: "indexer.blind:bittensor" },
      ]),
    );
    expect(judged(ops.indexerLag, ctx({ headTime: NOW }))).toEqual(CLEAR);
  });
});

describe("the dependency conditions, unread", () => {
  it("fmtao.backing_true and fmtao.lock_outside: the backing or the lock unread is unjudged, and the lock's marks are left alone", () => {
    const supply = { wTaoSupply: 1000n * E18 };
    const marks = blind([
      { rule: "fmtao.backing_true", key: "fmtao.backing_true:alpha" },
      { rule: "fmtao.backing_true", key: "fmtao.backing_true:lock" },
      { rule: "fmtao.lock_outside", key: "fmtao.lock_outside" },
    ]);
    const c = ctx({ bit: supply, bitBefore: supply, meta: { lock_outside_since: String(NOW - 7200) } });
    expect(judged(deps.fmtaoBackingTrue, c)).toEqual(marks);
    expect(c.writes.meta).toEqual([]);
    expect(judged(deps.fmtaoBackingTrue, ctx({}))).toEqual(marks);
    const fine = { ...supply, lockPoolFmTao: 1000n * E18, alpha: { backing: 1001n * E18 } };
    expect(judged(deps.fmtaoBackingTrue, ctx({ bit: fine, bitBefore: fine }))).toEqual(CLEAR);
  });

  it("rail.alpha_vault_admin: the pending admin unread is unjudged; none pending is clear", () => {
    expect(judged(deps.railAlphaVaultAdmin, ctx({ bit: {} }))).toEqual(blind([{ rule: "rail.alpha_vault_admin" }]));
    expect(judged(deps.railAlphaVaultAdmin, ctx({ bit: { alpha: { pendingAdmin: { admin: ZERO, schedule: 0 } } } }))).toEqual(CLEAR);
  });

  it("the validator: take, root stake and root uid unread are unjudged (every alert of the rule while the hotkey's reading is missing)", () => {
    const v = (o: Partial<NonNullable<BitState["validator"]>>) => ({ validator: { hotkey: HK, ...o } });
    expect(judged(deps.validatorTake, ctx({ bit: {} }))).toEqual(blind([{ rule: "validator.take_high" }]));
    expect(judged(deps.validatorTake, ctx({ bit: v({ rootUid: 1 }), bitBefore: v({ take: 60_000 }) }))).toEqual(blind([{ rule: "validator.take_high", key: `validator.take_high:${HK}` }]));
    expect(judged(deps.validatorTake, ctx({ bit: v({ take: 0 }), bitBefore: v({ take: 60_000 }) }))).toEqual(CLEAR);
    expect(judged(deps.validatorRootStakeDrop, ctx({ bit: {} }))).toEqual(blind([{ rule: "validator.root_stake_drop" }]));
    expect(judged(deps.validatorRootStakeDrop, ctx({ bit: v({ take: 0 }) }))).toEqual(blind([{ rule: "validator.root_stake_drop", key: `validator.root_stake_drop:${HK}` }]));
    expect(judged(deps.validatorRootStakeDrop, ctx({ bit: v({ rootStake: 100n }), bitBefore: v({ rootStake: 100n }) }))).toEqual(CLEAR);
    const seen = { [`root_uid_seen:${HK}`]: "1" };
    expect(judged(deps.validatorRootUidLost, ctx({ bit: {}, meta: seen }))).toEqual(blind([{ rule: "validator.root_uid_lost" }]));
    expect(judged(deps.validatorRootUidLost, ctx({ bit: v({ take: 0 }), bitBefore: v({ rootUid: null }), meta: seen }))).toEqual(blind([{ rule: "validator.root_uid_lost", key: `validator.root_uid_lost:${HK}` }]));
    expect(judged(deps.validatorRootUidLost, ctx({ bit: v({ rootUid: 1 }), bitBefore: v({ rootUid: null }), meta: seen }))).toEqual(CLEAR);
  });

  it("ccip.rate_limited: a chain without a reading, or a bucket unread, is unjudged for its buckets; full buckets are clear", () => {
    const c = ctx({ base: { lane }, meta: { "rate_limited_since:bittensor:inbound": String(NOW - 900) } });
    expect(judged(deps.ccipRateLimited, c)).toEqual(
      blind([
        { rule: "ccip.rate_limited", key: "ccip.rate_limited:bittensor:inbound" },
        { rule: "ccip.rate_limited", key: "ccip.rate_limited:bittensor:outbound" },
      ]),
    );
    expect(c.writes.meta).toEqual([]);
    expect(judged(deps.ccipRateLimited, ctx({ base: { lane: { inbound: lane.inbound } }, bit: { lane } }))).toEqual(blind([{ rule: "ccip.rate_limited", key: "ccip.rate_limited:base:outbound" }]));
    expect(judged(deps.ccipRateLimited, ctx({ base: { lane }, bit: { lane } }))).toEqual(CLEAR);
  });

  it("root.unlock_interval, oracle.cardinality, oracle.reverted and payout.fee_ceiling: the field unread is unjudged, read and fine is clear", () => {
    expect(judged(deps.rootUnlockInterval, ctx({ bit: {} }))).toEqual(blind([{ rule: "root.unlock_interval", key: "root.unlock_interval" }]));
    expect(judged(deps.rootUnlockInterval, ctx({ bit: { rootUnlockInterval: 0n } }))).toEqual(CLEAR);
    // the flap seen live: a reading whose slot0 didn't answer resolved the warning, the next one reopened it
    expect(judged(deps.oracleCardinality, ctx({ base: {}, baseBefore: { taoWethPool: { cardinality: 600 } } }))).toEqual(
      blind([
        { rule: "oracle.cardinality", key: "oracle.cardinality:taoWeth" },
        { rule: "oracle.cardinality", key: "oracle.cardinality:wethUsdc" },
      ]),
    );
    expect(judged(deps.oracleCardinality, ctx({ base: { taoWethPool: { cardinality: 2000 }, wethUsdcPool: { cardinality: 2000 } } }))).toEqual(CLEAR);
    expect(judged(deps.oracleReverted, ctx({ base: {} }))).toEqual(blind([{ rule: "oracle.reverted", key: "oracle.reverted" }]));
    expect(judged(deps.oracleReverted, ctx({ base: { oracleValue: 400_000_000n } }))).toEqual(CLEAR);
    expect(judged(deps.payoutFeeCeiling, ctx({ bit: { maxFeeAbs: 5n * 10n ** 15n } }))).toEqual(blind([{ rule: "payout.fee_ceiling", key: "payout.fee_ceiling" }]));
    expect(judged(deps.payoutFeeCeiling, ctx({ bit: { maxFeeAbs: 5n * 10n ** 15n, payoutFeeQuote: 10n ** 15n } }))).toEqual(CLEAR);
  });
});

describe("the market and solvency conditions, unread", () => {
  it("fmtao.unbacked: a chain's reading or its amount missing is unjudged", () => {
    const mark = [{ rule: "fmtao.unbacked" as const, key: "fmtao.unbacked" }];
    expect(judged(market.fmtaoUnbacked, ctx({ base: { fmTaoSupply: E18 } }))).toEqual(blind(mark));
    expect(judged(market.fmtaoUnbacked, ctx({ base: { fmTaoSupply: E18 }, bit: {} }))).toEqual(blind(mark));
    expect(judged(market.fmtaoUnbacked, ctx({ base: { fmTaoSupply: E18 }, bit: { lockPoolFmTao: E18 } }))).toEqual(CLEAR);
  });

  it("twap.divergence: the oracle or the spot prices unread is unjudged, and its mark is left alone", () => {
    const c = ctx({ base: {}, meta: { twap_off_since: String(NOW - 120), spot_30m: JSON.stringify([[NOW - 60, 400]]) } });
    expect(judged(market.twapDivergence, c)).toEqual(blind([{ rule: "twap.divergence", key: "twap.divergence" }]));
    expect(c.writes.meta.filter((w) => w.k === "twap_off_since")).toEqual([]);
    expect(judged(market.twapDivergence, ctx({}))).toEqual(blind([{ rule: "twap.divergence", key: "twap.divergence" }]));
    expect(judged(market.twapDivergence, ctx({ base: { oracleValue: 400_000_000n }, meta: { spot_30m: JSON.stringify([[NOW - 60, 400]]) } }))).toEqual(CLEAR);
  });

  it("pool.liquidity: no reading, less than a day of hour rows, or the pool unread is unjudged", () => {
    const mark = [{ rule: "pool.liquidity" as const, key: "pool.liquidity" }];
    const week = hourRows(24, { poolTaoLast: 100n, liquidityLast: 100n });
    expect(judged(market.poolLiquidity, ctx({ hours: week }))).toEqual(blind(mark));
    expect(judged(market.poolLiquidity, ctx({ base: { taoWethPool: { tao: 100n, liquidity: 100n } }, hours: week.slice(0, 23) }))).toEqual(blind(mark));
    expect(judged(market.poolLiquidity, ctx({ base: {}, hours: week }))).toEqual(blind(mark));
    expect(judged(market.poolLiquidity, ctx({ base: { taoWethPool: { tao: 100n, liquidity: 100n } }, hours: week }))).toEqual(CLEAR);
  });

  it("frontdoor.solvency and vault.solvency: a side unread is unjudged", () => {
    expect(judged(solvency.frontDoorSolvency, ctx({}))).toEqual(
      blind([
        { rule: "frontdoor.solvency", key: "frontdoor.solvency:tao" },
        { rule: "frontdoor.solvency", key: "frontdoor.solvency:eth" },
      ]),
    );
    const fd = { frontDoorTao: E18, frontDoorEth: E18, openBatch: openBatch({ totalDeposits: E18 }), totalClaimable: 0n, totalFeeCredit: 0n };
    expect(judged(solvency.frontDoorSolvency, ctx({ base: fd }))).toEqual(CLEAR);
    expect(judged(solvency.vaultSolvency, ctx({ bit: { rootStakeRao: 10n ** 9n, balance: E18 } }))).toEqual(blind([{ rule: "vault.solvency", key: "vault.solvency" }]));
    expect(judged(solvency.vaultSolvency, ctx({ bit: { rootStakeRao: 10n ** 9n, balance: E18, pendingPayouts: 0n } }))).toEqual(CLEAR);
  });
});

describe("no flapping, end to end", () => {
  const db = env.DB;
  beforeEach(async () => {
    await wipe(db);
  });

  /** One tick of a rule against D1: run it, reconcile with what it couldn't judge, commit, mark what was due sent. */
  async function tick(r: Rule, c: RuleCtx) {
    const state = await loadTickState(db, c.nowS);
    const findings: Finding[] = r.run(c);
    const out = reconcile(db, { open: state.openAlerts, findings, nowS: c.nowS, t: DEFAULTS, holdActive: false, unjudged: c.unjudged });
    if (out.statements.length) await db.batch(out.statements);
    const marks = markSent(db, out.due, c.nowS);
    if (marks.length) await db.batch(marks);
    return out.due.map((d) => [d.key, d.reason]);
  }
  const alerts = async () => (await db.prepare("SELECT alert_key, resolved_at FROM alerts ORDER BY id").all<{ alert_key: string; resolved_at: number | null }>()).results;

  it("oracle.cardinality: one alert while a reading misses the pool's slot0, resolved only by a reading that shows enough observations", async () => {
    const few = { taoWethPool: { cardinality: 600, cardinalityNext: 2000 }, wethUsdcPool: { cardinality: 5000 } };
    const at = (nowS: number, now: Partial<BaseState> | undefined, before: Partial<BaseState>) => ({ ...ctx({ base: now, baseBefore: before }), nowS });
    expect(await tick(deps.oracleCardinality, at(NOW, few, few))).toEqual([["oracle.cardinality:taoWeth", "alert"]]);
    // slot0 didn't answer (the pools unread), then no Base reading at all: left open, nothing sent
    expect(await tick(deps.oracleCardinality, at(NOW + 60, { taoWethPool: {}, wethUsdcPool: {} }, few))).toEqual([]);
    expect(await tick(deps.oracleCardinality, at(NOW + 120, undefined, few))).toEqual([]);
    // read again, still too few: the same alert, no second email
    expect(await tick(deps.oracleCardinality, at(NOW + 180, few, few))).toEqual([]);
    expect(await alerts()).toEqual([{ alert_key: "oracle.cardinality:taoWeth", resolved_at: null }]);
    // grown past 901: resolved (a warning resolves quietly)
    expect(await tick(deps.oracleCardinality, at(NOW + 240, { ...few, taoWethPool: { cardinality: 2000 } }, few))).toEqual([]);
    expect(await alerts()).toEqual([{ alert_key: "oracle.cardinality:taoWeth", resolved_at: NOW + 240 }]);
  });

  it("vault.solvency (critical): no 'resolved' email while the vault is unread; one when a reading shows it covered", async () => {
    const short = { rootStakeRao: 0n, balance: 10n ** 12n, pendingPayouts: E18 };
    const at = (nowS: number, now: Partial<BitState> | undefined) => ({ ...ctx({ bit: now, bitBefore: short }), nowS });
    expect(await tick(solvency.vaultSolvency, at(NOW, short))).toEqual([["vault.solvency", "alert"]]);
    // an hour on, Bittensor unread, then read without pendingPayouts: neither resolved nor re-sent
    expect(await tick(solvency.vaultSolvency, at(NOW + 3600, undefined))).toEqual([]);
    expect(await tick(solvency.vaultSolvency, at(NOW + 3660, { rootStakeRao: 0n, balance: 10n ** 12n }))).toEqual([]);
    expect(await alerts()).toEqual([{ alert_key: "vault.solvency", resolved_at: null }]);
    // covered: resolved, with its one "resolved" email
    expect(await tick(solvency.vaultSolvency, at(NOW + 3720, { ...short, balance: 2n * E18 }))).toEqual([["vault.solvency", "resolved"]]);
    expect(await alerts()).toEqual([{ alert_key: "vault.solvency", resolved_at: NOW + 3720 }]);
  });

  it("validator.not_earning: a tick without the vault's reading leaves it open (resolved 20:21 and reopened 20:23 live)", async () => {
    const dayAgo = (nowS: number) => [{ hour: Math.floor((nowS - 86_400) / 3600) * 3600, ticks: 60, spotSum: 0, spotCount: 0, unclaimedLast: E18 }];
    const flat = { unclaimed: E18, lastClaimAt: NOW - 3 * 86_400, stakes: { [HK]: 100n * 10n ** 9n } };
    const at = (nowS: number, bit: Partial<BitState> | undefined) => ({ ...ctx({ bit, hours: dayAgo(nowS) }), nowS });
    expect(await tick(ops.validatorNotEarning, at(NOW, flat))).toEqual([["validator.not_earning", "alert"]]);
    expect(await tick(ops.validatorNotEarning, at(NOW + 60, undefined))).toEqual([]);
    expect(await tick(ops.validatorNotEarning, at(NOW + 120, { ...flat, unclaimed: undefined }))).toEqual([]);
    expect(await tick(ops.validatorNotEarning, at(NOW + 180, flat))).toEqual([]);
    expect(await alerts()).toEqual([{ alert_key: "validator.not_earning", resolved_at: null }]);
  });
});
