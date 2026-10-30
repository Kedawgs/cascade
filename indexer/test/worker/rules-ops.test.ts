import { env } from "cloudflare:workers";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/alerts.ts";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import type { Rule } from "../../src/rules/index.ts";
import * as ops from "../../src/rules/ops.ts";
import type { BaseState, BitState, HourAgg } from "../../src/snapshot.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { D, h } from "./bridge-fixtures.ts";
import { baseState, bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";

const E18 = 10n ** 18n;
const NOW = 1_800_000_000;
const MIN = 60;
const USER = "0x00000000000000000000000000000000000000a1" as Hex;
const KEY = h("payout key");

function ctx(o: {
  base?: Partial<BaseState>;
  bit?: Partial<BitState>;
  baseTime?: number;
  bitTime?: number;
  logs?: StoredLog[];
  meta?: Record<string, string>;
  hours?: HourAgg[];
  nowS?: number;
  payoutDelayS?: number;
  payoutUsers?: RuleCtx["payoutUsers"];
  pendingPayoutKeys?: Hex[];
  settled?: RuleCtx["settled"];
  removed?: RuleCtx["removed"];
  noBase?: boolean;
  noBit?: boolean;
}): RuleCtx {
  const c = ruleCtx();
  return ruleCtx({
    nowS: o.nowS ?? NOW,
    snap: {
      ...c.snap,
      base: o.noBase ? undefined : reading(37_000_000n, o.baseTime ?? NOW, baseState(o.base ?? {})),
      bittensor: o.noBit ? undefined : reading(6_900_000n, o.bitTime ?? NOW, bitState(o.bit ?? {})),
    },
    logs: logQuery(o.logs ?? []),
    meta: o.meta ?? {},
    hours: o.hours ?? [],
    payoutDelayS: o.payoutDelayS ?? 3600,
    payoutUsers: o.payoutUsers ?? [],
    pendingPayoutKeys: o.pendingPayoutKeys ?? [],
    removed: o.removed ?? [],
    settled: o.settled ?? c.settled,
    blockTime: () => NOW - 3600,
  });
}
const rules = (r: Rule, c: RuleCtx) => r.run(c).map((f) => f.rule);
const meta = (c: RuleCtx) => Object.fromEntries(c.writes.meta.map((w) => [w.k, w.v]));

describe("batches and payouts", () => {
  const open = (start: number) => ({ openBatch: { id: 9n, start, totalDeposits: E18, feePot: 0n, nDeposits: 1, nRedeems: 0 }, batchInterval: 3600 });

  it("batch.past_max_wait: entries past openStart + max(interval, maxWait) + 15 min, muted while held", () => {
    // the test deployment's batchMaxWaitS is 0, so the interval (1 h) counts
    expect(rules(ops.batchPastMaxWait, ctx({ base: open(NOW - 3600 - 14 * MIN) }))).toEqual([]);
    const found = ops.batchPastMaxWait.run(ctx({ base: open(NOW - 3600 - 16 * MIN) }));
    expect(found.map((f) => f.key)).toEqual(["batch.past_max_wait:9"]);
    expect(reconcile(env.DB, { open: [], findings: found, nowS: NOW, t: DEFAULTS, holdActive: true }).statements).toEqual([]);
    expect(rules(ops.batchPastMaxWait, ctx({ base: { ...open(NOW - 7200), openBatch: { ...open(0).openBatch, nDeposits: 0 } } }))).toEqual([]);
  });

  it("payout.overdue: still pending at queuedAt + payoutDelay + 61 min; completion only from payout_done_block", () => {
    const batch = (queuedAt: number) => ({ payoutBatches: { [KEY]: { queuedAt, cursor: 1, count: 3, chunk: 1, remaining: E18 } } });
    expect(rules(ops.payoutOverdue, ctx({ bit: batch(NOW - 3600 - 59 * MIN), pendingPayoutKeys: [KEY] }))).toEqual([]);
    expect(ops.payoutOverdue.run(ctx({ bit: batch(NOW - 3600 - 61 * MIN), pendingPayoutKeys: [KEY] })).map((f) => f.key)).toEqual([`payout.overdue:${KEY}`]);
    // done by payout_done_block: not pending, whatever the reading says
    expect(rules(ops.payoutOverdue, ctx({ bit: batch(NOW - 3600 - 61 * MIN), pendingPayoutKeys: [] }))).toEqual([]);
  });

  it("delivery.overdue: claimable with a live preference 121 minutes after the PayoutReceived", () => {
    const base = { claimable: { [USER]: E18 }, deliveryOf: { [USER]: { minUsdcPerTao: 300_000_000n, deadline: NOW + 86400, destination: 0 } } };
    expect(rules(ops.deliveryOverdue, ctx({ base, payoutUsers: [{ user: USER, at: NOW - 119 * MIN }] }))).toEqual([]);
    expect(rules(ops.deliveryOverdue, ctx({ base, payoutUsers: [{ user: USER, at: NOW - 121 * MIN }] }))).toEqual(["delivery.overdue"]);
    const expired = { ...base, deliveryOf: { [USER]: { ...base.deliveryOf[USER], deadline: NOW - 1 } } };
    expect(rules(ops.deliveryOverdue, ctx({ base: expired, payoutUsers: [{ user: USER, at: NOW - 121 * MIN }] }))).toEqual([]);
  });

  it("cap.nearly_full at 90% of the cap", () => {
    const at = (pct: bigint) => ({ netForwarded: pct * E18 - E18, openBatch: { id: 1n, start: 0, totalDeposits: E18, feePot: 0n, nDeposits: 1, nRedeems: 0 }, depositCap: 100n * E18 });
    expect(rules(ops.capNearlyFull, ctx({ base: at(89n) }))).toEqual([]);
    expect(rules(ops.capNearlyFull, ctx({ base: at(90n) }))).toEqual(["cap.nearly_full"]);
  });

  it("batch.one_wallet: one payer (the staker's Staked.payer for staker deposits) with 51% of a half-full batch", () => {
    const dep = (user: Hex, amount: bigint, payer: Hex, tx: Hex) =>
      slog({ contract: "frontDoor", chain: "base", event: "DepositRequested", txHash: tx, block: 37_000_000n, args: { batchId: "9", user, amount: String(amount), payer } });
    const staked = (payer: Hex, tx: Hex) => slog({ contract: "staker", chain: "base", event: "Staked", txHash: tx, block: 37_000_000n, args: { payer, beneficiary: payer } });
    const WHALE = "0x00000000000000000000000000000000000000b2" as Hex;
    const logs = [
      dep(USER, 49n * E18, USER, h("t1")),
      // the whale deposits through the staker for two users: the staker is the DepositRequested payer
      dep("0x00000000000000000000000000000000000000c1", 26n * E18, D.staker, h("t2")),
      staked(WHALE, h("t2")),
      dep("0x00000000000000000000000000000000000000c2", 25n * E18, D.staker, h("t3")),
      staked(WHALE, h("t3")),
    ];
    const base = { openBatch: { id: 9n, start: 0, totalDeposits: 100n * E18, feePot: 0n, nDeposits: 3, nRedeems: 0 }, maxBatchValue: 200n * E18 };
    const [f] = ops.batchOneWallet.run(ctx({ base, logs }));
    expect(f.facts.payer).toBe(WHALE);
    // under half full: nothing
    expect(rules(ops.batchOneWallet, ctx({ base: { ...base, maxBatchValue: 201n * E18 }, logs }))).toEqual([]);
  });

  it("unstakes.tiny_wave: 20 tiny redeems in 24 h, not 19; or a redeem list 80% full", () => {
    const tiny = (n: number) => Array.from({ length: n }, (_, i) => slog({ contract: "frontDoor", chain: "base", event: "RedeemRequested", block: 37_000_000n, args: { batchId: "9", user: USER, shares: String(10n ** 16n + BigInt(i)) } }));
    const bit = { price: E18 };
    expect(rules(ops.unstakesTinyWave, ctx({ bit, logs: tiny(19) }))).toEqual([]);
    expect(rules(ops.unstakesTinyWave, ctx({ bit, logs: tiny(20) }))).toEqual(["unstakes.tiny_wave"]);
    const list = { openBatch: { id: 9n, start: 0, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 80 }, maxRedeems: 100 };
    expect(rules(ops.unstakesTinyWave, ctx({ base: list, bit }))).toEqual(["unstakes.tiny_wave"]);
  });

  it("outflow.near_limit: burned plus waiting at 80% of the day's allowance", () => {
    // gross 1,000 TAO, 10% a day: an allowance of 100 TAO
    const bit = (burned: bigint) => ({ rootStakeRao: 1000n * 10n ** 9n, balance: 10n ** 12n, maxDailyOutflowBps: 1000n, minDailyOutflow: E18, burnWindow: { start: NOW - 3600, burned }, price: E18 });
    const waiting = [slog({ contract: "frontDoor", chain: "base", event: "RedeemRequested", block: 37_000_000n, args: { batchId: "9", user: USER, shares: String(30n * E18) } })];
    const base = { openBatch: { id: 9n, start: 0, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 1 } };
    expect(rules(ops.outflowNearLimit, ctx({ base, bit: bit(49n * E18), logs: waiting }))).toEqual([]);
    expect(rules(ops.outflowNearLimit, ctx({ base, bit: bit(50n * E18), logs: waiting }))).toEqual(["outflow.near_limit"]);
    // the window is over: its burns no longer count
    expect(rules(ops.outflowNearLimit, ctx({ base, bit: { ...bit(80n * E18), burnWindow: { start: NOW - 86401, burned: 80n * E18 } }, logs: waiting }))).toEqual([]);
  });
});

describe("keeper and vault housekeeping", () => {
  it("keeper.low_eth below 0.002 ETH and keeper.low_tao below 0.01 TAO", () => {
    expect(rules(ops.keeperLowEth, ctx({ base: { keeperBalance: 19n * 10n ** 14n } }))).toEqual(["keeper.low_eth"]);
    expect(rules(ops.keeperLowEth, ctx({ base: { keeperBalance: 21n * 10n ** 14n } }))).toEqual([]);
    expect(rules(ops.keeperLowTao, ctx({ bit: { keeperBalance: 9n * 10n ** 15n } }))).toEqual(["keeper.low_tao"]);
    expect(rules(ops.keeperLowTao, ctx({ bit: { keeperBalance: 11n * 10n ** 15n } }))).toEqual([]);
    // the launch keeper's 0.06 TAO (about 0.0002-0.0008 TAO an action) is no warning
    expect(rules(ops.keeperLowTao, ctx({ bit: { keeperBalance: 6n * 10n ** 16n } }))).toEqual([]);
  });

  it("keeper.idle_unstaked: stakeable idle at least the minimum stake for more than 2 hours", () => {
    const bit = { balance: 3n * E18 + 10n ** 12n, pendingPayouts: E18, minStakeRao: 2n * 10n ** 9n };
    const first = ctx({ bit });
    expect(rules(ops.keeperIdleUnstaked, first)).toEqual([]);
    expect(meta(first).idle_since).toBe(String(NOW));
    expect(rules(ops.keeperIdleUnstaked, ctx({ bit, meta: { idle_since: String(NOW - 121 * MIN) } }))).toEqual(["keeper.idle_unstaked"]);
    expect(rules(ops.keeperIdleUnstaked, ctx({ bit, meta: { idle_since: String(NOW - 119 * MIN) } }))).toEqual([]);
    const staked = ctx({ bit: { ...bit, balance: 10n ** 12n }, meta: { idle_since: String(NOW - 121 * MIN) } });
    expect(rules(ops.keeperIdleUnstaked, staked)).toEqual([]);
    expect(meta(staked).idle_since).toBe("");
  });

  it("adapter.low_reserve below 5e11 wei", () => {
    expect(rules(ops.adapterLowReserve, ctx({ bit: { adapterBalance: 4n * 10n ** 11n } }))).toEqual(["adapter.low_reserve"]);
    expect(rules(ops.adapterLowReserve, ctx({ bit: { adapterBalance: 5n * 10n ** 11n } }))).toEqual([]);
  });

  it("rewards.uncollected: last claim 36 days ago, or 25 claims' worth waiting", () => {
    expect(rules(ops.rewardsUncollected, ctx({ bit: { lastClaimAt: NOW - 36 * 86400, unclaimed: 0n } }))).toEqual(["rewards.uncollected"]);
    expect(rules(ops.rewardsUncollected, ctx({ bit: { lastClaimAt: NOW - 34 * 86400, unclaimed: 0n } }))).toEqual([]);
    expect(rules(ops.rewardsUncollected, ctx({ bit: { lastClaimAt: NOW, unclaimed: 25n * 57n * 10n ** 15n } }))).toEqual(["rewards.uncollected"]);
  });

  it("validator.not_earning: unclaimed rewards flat for 24 hours with no claim", () => {
    const dayAgo = Math.floor((NOW - 86400) / 3600) * 3600;
    const hours: HourAgg[] = [{ hour: dayAgo, ticks: 60, spotSum: 0, spotCount: 0, unclaimedLast: 5n * E18 }];
    expect(rules(ops.validatorNotEarning, ctx({ bit: { unclaimed: 5n * E18, lastClaimAt: NOW - 2 * 86400 }, hours }))).toEqual(["validator.not_earning"]);
    expect(rules(ops.validatorNotEarning, ctx({ bit: { unclaimed: 5n * E18 + 1n, lastClaimAt: NOW - 2 * 86400 }, hours }))).toEqual([]);
    // a claim in the day explains it
    expect(rules(ops.validatorNotEarning, ctx({ bit: { unclaimed: 0n, lastClaimAt: NOW - 3600 }, hours }))).toEqual([]);
  });

  it("rail.alpha_vault: AlphaVault paused, migration ready or finished", () => {
    expect(rules(ops.railAlphaVault, ctx({ bit: { alpha: { isPaused: false, migrationReadyAt: 1n, migrationFinished: false } } }))).toEqual(["rail.alpha_vault"]);
    expect(rules(ops.railAlphaVault, ctx({ bit: { alpha: { isPaused: true, migrationReadyAt: 0n, migrationFinished: false } } }))).toEqual(["rail.alpha_vault"]);
    expect(rules(ops.railAlphaVault, ctx({ bit: { alpha: { isPaused: false, migrationReadyAt: 0n, migrationFinished: false } } }))).toEqual([]);
  });
});

describe("the monitor itself", () => {
  const lagged = (lagS: number) => ({ base: { block: 1n, time: NOW - lagS, headTime: NOW }, bittensor: { block: 1n, time: NOW, headTime: NOW } });

  it("indexer.lag and indexer.blind follow the payout delay", () => {
    expect(ops.lagLimitOf(3600, DEFAULTS)).toBe(900);
    expect(ops.lagLimitOf(86_400, DEFAULTS)).toBe(1800);
    expect(ops.lagLimitOf(Number.NaN, DEFAULTS)).toBe(1800);
    expect(rules(ops.indexerLag, ctx({ payoutDelayS: 3600, settled: lagged(16 * MIN) }))).toEqual(["indexer.lag"]);
    expect(rules(ops.indexerLag, ctx({ payoutDelayS: 3600, settled: lagged(31 * MIN) }))).toEqual(["indexer.blind"]);
    expect(rules(ops.indexerLag, ctx({ payoutDelayS: 86_400, settled: lagged(29 * MIN) }))).toEqual([]);
    expect(rules(ops.indexerLag, ctx({ payoutDelayS: 86_400, settled: lagged(31 * MIN) }))).toEqual(["indexer.lag"]);
  });

  it("indexer.reorg names each stored log a re-read no longer found", () => {
    const [f] = ops.indexerReorg.run(ctx({ removed: [{ chain: "base", uid: h("gone") }] }));
    expect(f).toMatchObject({ rule: "indexer.reorg", key: `indexer.reorg:${h("gone")}` });
  });

  it("monitor.chain_unreadable after 5 ticks in a row without a usable reading of a chain", () => {
    const four = ctx({ noBase: true, meta: { unreadable_base: "3" } });
    expect(rules(ops.chainUnreadable, four)).toEqual([]);
    expect(meta(four).unreadable_base).toBe("4");
    expect(rules(ops.chainUnreadable, ctx({ noBase: true, meta: { unreadable_base: "4" } }))).toEqual(["monitor.chain_unreadable"]);
    const back = ctx({ meta: { unreadable_base: "7" } });
    expect(rules(ops.chainUnreadable, back)).toEqual([]);
    expect(meta(back).unreadable_base).toBe("0");
  });

  it("monitor.email_failing once emails have failed for 30 minutes", () => {
    expect(rules(ops.emailFailing, ctx({ meta: { email_failing_since: String(NOW - 29 * MIN) } }))).toEqual([]);
    expect(rules(ops.emailFailing, ctx({ meta: { email_failing_since: String(NOW - 31 * MIN) } }))).toEqual(["monitor.email_failing"]);
    expect(rules(ops.emailFailing, ctx({ meta: { email_failing_since: "" } }))).toEqual([]);
  });
});

