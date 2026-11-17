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
import { RULES } from "../../src/rules/ids.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { testConfigV32 } from "./fixtures.ts";
import { D, h } from "./bridge-fixtures.ts";
import { baseState, bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";

const E18 = 10n ** 18n;
const TAO_RAO = 10n ** 9n;
const NOW = 1_800_000_000;
const HK = ruleCtx().cfg.deployment.stakeHotkey;
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
  it("keeper.low_eth below 0.015 ETH (R12a: a full batch's close float and its gas) and keeper.low_tao below 0.01 TAO", () => {
    expect(DEFAULTS.keeperMinEthWei).toBe(15n * 10n ** 15n);
    expect(rules(ops.keeperLowEth, ctx({ base: { keeperBalance: 149n * 10n ** 14n } }))).toEqual(["keeper.low_eth"]);
    expect(rules(ops.keeperLowEth, ctx({ base: { keeperBalance: 15n * 10n ** 15n } }))).toEqual([]);
    // the 0.005 ETH a keeper held before R12a can't send a full batch's close (its float is three quotes)
    expect(rules(ops.keeperLowEth, ctx({ base: { keeperBalance: 5n * 10n ** 15n } }))).toEqual(["keeper.low_eth"]);
    expect(rules(ops.keeperLowTao, ctx({ bit: { keeperBalance: 9n * 10n ** 15n } }))).toEqual(["keeper.low_tao"]);
    expect(rules(ops.keeperLowTao, ctx({ bit: { keeperBalance: 11n * 10n ** 15n } }))).toEqual([]);
    // the launch keeper's 0.06 TAO (about 0.0002-0.0008 TAO an action) is no warning
    expect(rules(ops.keeperLowTao, ctx({ bit: { keeperBalance: 6n * 10n ** 16n } }))).toEqual([]);
  });

  it("R12a: keeper.low_eth warns before a full batch's close would fail: below its float (three of the read 50 + 50 quote) and one more close, when that is above the floor", () => {
    expect(DEFAULTS.keeperCloseQuotes).toBe(4);
    // a 0.0043 ETH quote: 0.0172 ETH, above the 0.015 floor
    const quote = 43n * 10n ** 14n;
    const [f] = ops.keeperLowEth.run(ctx({ base: { keeperBalance: 171n * 10n ** 14n, fullBatchQuote: quote } }));
    expect(f).toMatchObject({
      rule: "keeper.low_eth",
      subject: "The keeper has 0.0171 ETH on Base; a full batch's close needs 0.0172 ETH",
      facts: { balance: "0.0171 ETH", needed: "0.0172 ETH", "a full batch's close quote (50 + 50)": "0.0043 ETH", "the float a close sends": "0.0129 ETH (three quotes)" },
    });
    expect(rules(ops.keeperLowEth, ctx({ base: { keeperBalance: 172n * 10n ** 14n, fullBatchQuote: quote } }))).toEqual([]);
    // a low quote never lowers the floor
    expect(rules(ops.keeperLowEth, ctx({ base: { keeperBalance: 149n * 10n ** 14n, fullBatchQuote: 10n ** 15n } }))).toEqual(["keeper.low_eth"]);
    // the runbook line says what to send
    expect(RUNBOOK["keeper.low_eth"](f.facts)).toContain("0.0172 ETH");
  });

  it("guardian.low_eth below 0.0005 ETH on Base and guardian.low_tao below 0.005 TAO on Bittensor: half its launch funding, two emergency pauses at a cautious gas price", () => {
    expect(DEFAULTS.guardianMinEthWei).toBe(5n * 10n ** 14n);
    expect(DEFAULTS.guardianMinTaoWei).toBe(5n * 10n ** 15n);
    // the launch funding (0.001 ETH and 0.01 TAO, 2026-11-16) is no warning
    expect(rules(ops.guardianLowEth, ctx({ base: { guardianBalance: 10n ** 15n } }))).toEqual([]);
    expect(rules(ops.guardianLowTao, ctx({ bit: { guardianBalance: 10n ** 16n } }))).toEqual([]);
    // at the floor is fine, one wei under it warns
    expect(rules(ops.guardianLowEth, ctx({ base: { guardianBalance: 5n * 10n ** 14n } }))).toEqual([]);
    expect(rules(ops.guardianLowEth, ctx({ base: { guardianBalance: 5n * 10n ** 14n - 1n } }))).toEqual(["guardian.low_eth"]);
    expect(rules(ops.guardianLowTao, ctx({ bit: { guardianBalance: 5n * 10n ** 15n } }))).toEqual([]);
    expect(rules(ops.guardianLowTao, ctx({ bit: { guardianBalance: 5n * 10n ** 15n - 1n } }))).toEqual(["guardian.low_tao"]);
    // each judges its own chain's balance, never the other's or the keeper's
    expect(rules(ops.guardianLowEth, ctx({ base: { guardianBalance: 10n ** 15n, keeperBalance: 0n }, bit: { guardianBalance: 0n } }))).toEqual([]);
    expect(rules(ops.guardianLowTao, ctx({ bit: { guardianBalance: 10n ** 16n, keeperBalance: 0n }, base: { guardianBalance: 0n } }))).toEqual([]);
    for (const id of ["guardian.low_eth", "guardian.low_tao"] as const) expect(RULES[id]).toEqual({ tier: "warning", kind: "condition", canHold: false, mutedByHold: false });
  });

  it("the guardian's alerts say what it holds, the floor and where to send gas, and the runbook names the chain, the address and the pause it is for", () => {
    const G = "0x00000000000000000000000000000000000000a2" as Hex;
    const [e] = ops.guardianLowEth.run(ctx({ base: { guardianBalance: 4n * 10n ** 14n, guardian: G } }));
    expect(e).toEqual({
      rule: "guardian.low_eth",
      key: "guardian.low_eth",
      subject: "The guardian has 0.0004 ETH on Base, under the 0.0005 ETH kept for two emergency pauses",
      facts: { balance: "0.0004 ETH", "kept for two pauses": "0.0005 ETH", guardian: G },
    });
    const [t] = ops.guardianLowTao.run(ctx({ bit: { guardianBalance: 0n, guardian: G } }));
    expect(t).toEqual({
      rule: "guardian.low_tao",
      key: "guardian.low_tao",
      subject: "The guardian has 0 TAO on Bittensor, under the 0.005 TAO kept for two emergency pauses",
      facts: { balance: "0 TAO", "kept for two pauses": "0.005 TAO", guardian: G },
    });
    // the guardian unread on this reading: the balance is still judged, the address left out
    expect(ops.guardianLowEth.run(ctx({ base: { guardianBalance: 0n } }))[0].facts).toEqual({ balance: "0 ETH", "kept for two pauses": "0.0005 ETH" });
    // a floor set in THRESHOLDS is the one judged and named
    const raised = ctx({ base: { guardianBalance: 10n ** 15n } });
    raised.t = { ...DEFAULTS, guardianMinEthWei: 2n * 10n ** 15n };
    expect(ops.guardianLowEth.run(raised)[0].subject).toBe("The guardian has 0.001 ETH on Base, under the 0.002 ETH kept for two emergency pauses");

    const eth = RUNBOOK["guardian.low_eth"](e.facts);
    expect(eth).toContain(`Send ETH on Base to the guardian ${G}`);
    expect(eth).toContain("above 0.0005 ETH");
    expect(eth).toContain("pause()");
    expect(eth).toContain("pnpm ops pause both --for-wallet --offline");
    const tao = RUNBOOK["guardian.low_tao"](t.facts);
    expect(tao).toContain(`Send TAO on Bittensor's EVM to the guardian ${G}`);
    expect(tao).toContain("above 0.005 TAO");
    expect(tao).toContain("whole gas limit up front");
    // with no facts (the digest, a hand-rendered email) each still reads whole
    expect(RUNBOOK["guardian.low_eth"]({})).toContain("Send ETH on Base to the guardian (the address the front door's guardian() names)");
    expect(RUNBOOK["guardian.low_tao"]({})).toContain("Send TAO on Bittensor's EVM to the guardian (the address the vault's guardian() names)");
    for (const text of [eth, tao, RUNBOOK["guardian.low_eth"]({}), RUNBOOK["guardian.low_tao"]({})]) {
      expect(text).not.toMatch(/undefined/);
      // a balance that fell with nothing signed is a sweeper's work, and a swept account is never refilled (runbook 7.2)
      expect(text).toContain("Never refill a swept account");
      expect(text).toContain("runbook 7.2");
    }
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
    const staked = { [HK]: 100n * TAO_RAO };
    const [f] = ops.validatorNotEarning.run(ctx({ bit: { unclaimed: 5n * E18, lastClaimAt: NOW - 2 * 86400, stakes: staked }, hours }));
    expect(f).toMatchObject({ rule: "validator.not_earning", facts: { hotkey: HK, "the vault's stake on it": "100 TAO" } });
    expect(rules(ops.validatorNotEarning, ctx({ bit: { unclaimed: 5n * E18 + 1n, lastClaimAt: NOW - 2 * 86400, stakes: staked }, hours }))).toEqual([]);
    // a claim in the day explains it
    expect(rules(ops.validatorNotEarning, ctx({ bit: { unclaimed: 0n, lastClaimAt: NOW - 3600, stakes: staked }, hours }))).toEqual([]);
  });

  it("validator.not_earning: not while the vault's stake on the stake hotkey is under notEarningMinStakeRao (1 TAO): an empty vault earns nothing", () => {
    const dayAgo = Math.floor((NOW - 86400) / 3600) * 3600;
    const hours: HourAgg[] = [{ hour: dayAgo, ticks: 60, spotSum: 0, spotCount: 0, unclaimedLast: 0n }];
    const flat = (o: Partial<BitState>) => ctx({ bit: { unclaimed: 0n, lastClaimAt: NOW - 3 * 86400, ...o }, hours });
    expect(DEFAULTS.notEarningMinStakeRao).toBe(TAO_RAO);
    // the live vault, empty: nothing on the stake hotkey, nothing counted
    const empty = flat({ stakes: { [HK]: 0n }, rootStakeRao: 0n });
    expect(rules(ops.validatorNotEarning, empty)).toEqual([]);
    // judged, not unjudged: an alert opened before resolves
    expect(empty.unjudged).toEqual([]);
    expect(rules(ops.validatorNotEarning, flat({ stakes: { [HK]: TAO_RAO - 1n } }))).toEqual([]);
    expect(rules(ops.validatorNotEarning, flat({ stakes: { [HK]: TAO_RAO } }))).toEqual(["validator.not_earning"]);
    // the hotkey's stake unread: the vault's counted stake stands in for it
    expect(rules(ops.validatorNotEarning, flat({ rootStakeRao: 0n }))).toEqual([]);
    expect(rules(ops.validatorNotEarning, flat({ rootStakeRao: 100n * TAO_RAO }))).toEqual(["validator.not_earning"]);
    // the hotkey asked is the one the reading asked getUnclaimedRootTaoByHotkey for: the previous reading's stake hotkey
    const other = "0x00000000000000000000000000000000000000000000000000000000000000bb" as Hex;
    const moved = ruleCtx({ ...flat({ stakes: { [HK]: 100n * TAO_RAO, [other]: 0n } }), previous: { bittensor: reading(6_899_000n, NOW - 60, bitState({ stakeHotkey: other })) } });
    expect(rules(ops.validatorNotEarning, moved)).toEqual([]);
    // tunable in THRESHOLDS
    expect(rules(ops.validatorNotEarning, ruleCtx({ ...flat({ stakes: { [HK]: TAO_RAO - 1n } }), t: { ...DEFAULTS, notEarningMinStakeRao: 0n } }))).toEqual(["validator.not_earning"]);
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


// ---- v3.2 (Task 56): the outflow rule with the global window; a queued entry above the primary's cap ----

describe("v3.2's outflow and payout rules", () => {
  const cfg32 = testConfigV32();
  const c32 = (o: Parameters<typeof ctx>[0]) => ({ ...ctx(o), cfg: cfg32 });
  /** visible 1,000 TAO, booked 990 (priced 990), 20 TAO ramping since 6 hours ago (15 TAO still ramps): a base of 975 TAO;
   * the door's 10% a day is 97.5 TAO, every door's together 5% is 48.75 */
  const bit32 = (over: Partial<BitState> = {}): Partial<BitState> => ({
    rootStakeRao: 1000n * TAO_RAO,
    bookedStake: 990n * TAO_RAO,
    rampingStake: 20n * E18,
    lastStakeAt: NOW - 6 * 3600,
    balance: 500n * E18,
    maxDailyOutflowBps: 1000n,
    globalOutflowBps: 500n,
    minDailyOutflow: 10n * E18,
    burnWindow: { start: NOW - 3600, burned: 0n },
    globalWindow: { start: NOW - 3600, burned: 10n * E18 },
    price: E18,
    ...over,
  });
  const waiting = [slog({ contract: "frontDoor", chain: "base", event: "RedeemRequested", block: 37_000_000n, args: { batchId: "9", user: USER, shares: String(30n * E18) } })];
  const base = { openBatch: { id: 9n, start: 0, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 1 } };

  it("outflow.near_limit: the base is the priced stake (the lower of visible and booked) less what still ramps, never the balance; each window has its allowance, and every door's together counts too", () => {
    // every door's: 10 burned + 30 waiting = 40 TAO, at 80% of 48.75 (39): near
    const [f] = ops.outflowNearLimit.run(c32({ base, bit: bit32(), logs: waiting }));
    expect(f).toMatchObject({ rule: "outflow.near_limit", key: "outflow.near_limit", subject: "Exits are near the vault's daily outflow limit: every front door's together" });
    expect(f.facts).toMatchObject({
      base: "975 TAO (the lower of the visible and booked stake, less 15 TAO still ramping in)",
      waiting: "30 TAO",
      "this front door": "0 TAO burned of 97.5 TAO",
      "every front door": "10 TAO burned of 48.75 TAO",
    });
    // its line names the deferral's other causes on v3.2 (R4: the hold, a closed rail)
    expect(RUNBOOK["outflow.near_limit"](f.facts)).toMatch(/one-day hold/);
    // 8 burned: 38 TAO, under 39
    expect(rules(ops.outflowNearLimit, c32({ base, bit: bit32({ globalWindow: { start: NOW - 3600, burned: 8n * E18 } }), logs: waiting }))).toEqual([]);
    // the door's own: 50 burned + 30 = 80 TAO at 80% of 97.5 (78)
    const door = ops.outflowNearLimit.run(c32({ base, bit: bit32({ burnWindow: { start: NOW - 3600, burned: 50n * E18 }, globalWindow: { start: NOW - 86_401, burned: 99n * E18 } }), logs: waiting }));
    expect(door.map((x) => x.subject)).toEqual(["Exits are near the vault's daily outflow limit: this front door's"]);
    // the floor: a tiny base gives minDailyOutflow (10 TAO) to each window
    const floor = ops.outflowNearLimit.run(c32({ base, bit: bit32({ rootStakeRao: 0n, bookedStake: 0n, globalWindow: { start: NOW - 3600, burned: 0n } }), logs: waiting }));
    expect(floor[0].facts["every front door"]).toBe("0 TAO burned of 10 TAO");
  });

  it("outflow.near_limit on v3.2 is unjudged while the ledger, the ramp or either window is unread", () => {
    for (const over of [{ bookedStake: undefined }, { rampingStake: undefined }, { globalOutflowBps: undefined }, { globalWindow: undefined }, { burnWindow: undefined }]) {
      const c = c32({ base, bit: bit32(over) });
      expect(ops.outflowNearLimit.run(c), Object.keys(over)[0]).toEqual([]);
      expect(c.unjudged, Object.keys(over)[0]).toEqual([{ rule: "outflow.near_limit", key: "outflow.near_limit" }]);
    }
  });

  describe("payout.entry_above_cap", () => {
    const vault = (event: string, args: StoredLog["args"], block = 6_900_100n, logIndex = 0) => slog({ contract: "vault", event, block, logIndex, topic1: KEY, args: { key: KEY, ...args } });
    const big = 20n * E18;
    const queued = [
      vault("DepositBounced", { user: USER, assets: String(big), reason: "1" }, 6_900_100n, 0),
      vault("Redeemed", { user: h("a") as Hex, shares: "1", assets: String(E18) }, 6_900_100n, 1),
      vault("PayoutBatchQueued", { sourceChain: "8453", batchId: "9", count: 2, total: String(big + E18), price: "1" }, 6_900_100n, 2),
    ];
    it("warns when a queued, unsent entry is bigger than the primary bridge carries in a message: its chunk can't be sent", () => {
      expect(RULES["payout.entry_above_cap"]).toMatchObject({ tier: "warning", kind: "condition" });
      const [f] = ops.payoutEntryAboveCap.run(c32({ bit: { bridgeMaxMessageValue: 15n * E18, primaryBridge: cfg32.deployment.bitAdapter }, logs: queued, pendingPayoutKeys: [KEY] }));
      expect(f).toMatchObject({ rule: "payout.entry_above_cap", key: `payout.entry_above_cap:${KEY}`, subject: "A queued payout of 20 TAO is above the 15 TAO the primary bridge carries in one message" });
      expect(f.facts).toMatchObject({ key: KEY, "entries above it": `${USER}: 20 TAO`, "the primary bridge": cfg32.deployment.bitAdapter, "it carries at most": "15 TAO" });
      expect(RUNBOOK["payout.entry_above_cap"](f.facts)).toContain("setPrimaryBridge");
    });

    it("judges only what isn't sent yet: an entry a chunk took is out of it, as is a cancel's redeem; a cap that covers it raises nothing", () => {
      const sent = vault("PayoutChunkSent", { chunk: 0, taken: 1, gross: String(big), net: String(big), fee: "0", charged: "0", unstakeCost: "0" }, 6_900_101n);
      expect(ops.payoutEntryAboveCap.run(c32({ bit: { bridgeMaxMessageValue: 15n * E18 }, logs: [...queued, sent], pendingPayoutKeys: [KEY] }))).toEqual([]);
      expect(ops.payoutEntryAboveCap.run(c32({ bit: { bridgeMaxMessageValue: 20n * E18 }, logs: queued, pendingPayoutKeys: [KEY] }))).toEqual([]);
      // a redeem above the cap that a cancel re-minted (only the bounces are carried) is out of it
      const redeemBig = [vault("Redeemed", { user: USER, shares: "1", assets: String(big) }, 6_900_100n, 0), vault("PayoutBatchQueued", { sourceChain: "8453", batchId: "9", count: 1, total: String(big), price: "1" }, 6_900_100n, 1)];
      const cancel = vault("PayoutBatchCancelled", { reminted: "1", bouncesCarried: 0 }, 6_900_102n);
      expect(ops.payoutEntryAboveCap.run(c32({ bit: { bridgeMaxMessageValue: 15n * E18 }, logs: [...redeemBig, cancel], pendingPayoutKeys: [KEY] }))).toEqual([]);
    });

    it("is unjudged while the cap is unread or the batch's events aren't loaded, and v3.2's only", () => {
      const a = c32({ bit: {}, logs: queued, pendingPayoutKeys: [KEY] });
      expect(ops.payoutEntryAboveCap.run(a)).toEqual([]);
      expect(a.unjudged).toEqual([{ rule: "payout.entry_above_cap" }]);
      const b = c32({ bit: { bridgeMaxMessageValue: 15n * E18 }, logs: [], pendingPayoutKeys: [KEY] });
      expect(ops.payoutEntryAboveCap.run(b)).toEqual([]);
      expect(b.unjudged).toEqual([{ rule: "payout.entry_above_cap", key: `payout.entry_above_cap:${KEY}` }]);
      expect(ops.payoutEntryAboveCap.run(ctx({ bit: { bridgeMaxMessageValue: 15n * E18 }, logs: queued, pendingPayoutKeys: [KEY] }))).toEqual([]);
    });
  });
});
