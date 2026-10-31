import { formatUnits, type Hex } from "viem";
import type { Finding } from "../alerts.ts";
import type { ChainName } from "../config.ts";
import type { Thresholds } from "../thresholds.ts";
import { type RuleCtx, unjudged, utc } from "./context.ts";
import { RULES } from "./ids.ts";
import type { Rule } from "./index.ts";

// Spec 6.3 (operational warnings), 6.4 rail.alpha_vault, and the monitor's own health: indexer.lag and
// indexer.blind on `head_time − settled_time`, with limits that follow the on-chain payoutDelay. A condition whose
// reading is missing, or lacks a field it needs, is unjudged (its open alert left as it is), never cleared.

const E18 = 10n ** 18n;
const RAO = 10n ** 9n;
/** the vault's existential reserve, as `balance − 1e12 − pendingPayouts` counts it */
const ED_RESERVE = 10n ** 12n;
const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO`;
const eth = (wei: bigint) => `${formatUnits(wei, 18)} ETH`;
const one = (rule: Finding["rule"], key: string, subject: string, facts: Record<string, string> = {}): Finding[] => [{ rule, key, subject, facts }];
const same = (a: unknown, b: Hex) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const num = (s: string | undefined) => (s ? Number(s) : undefined);

/** lagLimit = min(lagCapS, payoutDelay / lagPayoutDelayDivisor); the cap alone while payoutDelay is unknown.
 * The keeper uses the same formula (spec 8). */
export function lagLimitOf(payoutDelayS: number, t: Pick<Thresholds, "lagCapS" | "lagPayoutDelayDivisor">): number {
  if (!Number.isFinite(payoutDelayS) || payoutDelayS <= 0) return t.lagCapS;
  return Math.min(t.lagCapS, Math.floor(payoutDelayS / t.lagPayoutDelayDivisor));
}

/** batch.past_max_wait (muted while held): the open batch has entries past openStart + max(batchInterval,
 * batchMaxWaitS) + maxWaitGraceS, by Base time. */
export const batchPastMaxWait: Rule = {
  name: "batch.past_max_wait",
  run(ctx) {
    const b = ctx.snap.base;
    const ob = b?.state.openBatch;
    if (!b || !ob || b.state.batchInterval === undefined) return unjudged(ctx, "batch.past_max_wait");
    if (ob.nDeposits + ob.nRedeems === 0) return [];
    const due = ob.start + Math.max(b.state.batchInterval, ctx.cfg.deployment.batchMaxWaitS) + ctx.t.maxWaitGraceS;
    if (b.time <= due) return [];
    return one("batch.past_max_wait", `batch.past_max_wait:${ob.id}`, `Batch ${ob.id} is ${Math.floor((b.time - due) / 60) + ctx.t.maxWaitGraceS / 60} minutes past its close`, {
      batch: String(ob.id),
      opened: utc(ob.start),
      entries: String(ob.nDeposits + ob.nRedeems),
    });
  },
};

/** payout.overdue (muted while held): a payout batch pending by payout_done_block, with entries left
 * (count > cursor), at queuedAt + payoutDelay + payoutGraceS by Bittensor time. */
export const payoutOverdue: Rule = {
  name: "payout.overdue",
  run(ctx) {
    const v = ctx.snap.bittensor;
    if (!v) return unjudged(ctx, "payout.overdue");
    return ctx.pendingPayoutKeys.flatMap((key) => {
      const p = v.state.payoutBatches[key];
      if (!p) return unjudged(ctx, "payout.overdue", `payout.overdue:${key}`);
      if (p.count <= p.cursor || v.time < p.queuedAt + ctx.payoutDelayS + ctx.t.payoutGraceS) return [];
      return one("payout.overdue", `payout.overdue:${key}`, "A payout batch is overdue", { key, queued: utc(p.queuedAt), paid: `${p.cursor} of ${p.count} entries` });
    });
  },
};

/** delivery.overdue: a recent payout user with claimable TAO and a live delivery preference,
 * deliveryGraceS after their PayoutReceived. */
export const deliveryOverdue: Rule = {
  name: "delivery.overdue",
  run(ctx) {
    const b = ctx.snap.base;
    if (!b) return unjudged(ctx, "delivery.overdue");
    return ctx.payoutUsers.flatMap(({ user, at }) => {
      const key = user.toLowerCase() as Hex;
      const claimable = b.state.claimable[key] ?? b.state.claimable[user];
      const pref = b.state.deliveryOf[key] ?? b.state.deliveryOf[user];
      if (claimable === undefined || (claimable > 0n && pref === undefined)) return unjudged(ctx, "delivery.overdue", `delivery.overdue:${key}`);
      const live = pref !== undefined && pref.minUsdcPerTao > 0n && pref.deadline > b.time;
      if (claimable <= 0n || !live || b.time - at < ctx.t.deliveryGraceS) return [];
      return one("delivery.overdue", `delivery.overdue:${key}`, "A user's USDC delivery is overdue", { user: key, claimable: tao(claimable), "payout received": utc(at) });
    });
  },
};

export const keeperLowEth: Rule = {
  name: "keeper.low_eth",
  run(ctx) {
    const bal = ctx.snap.base?.state.keeperBalance;
    if (bal === undefined) return unjudged(ctx, "keeper.low_eth", "keeper.low_eth");
    if (bal >= ctx.t.keeperMinEthWei) return [];
    return one("keeper.low_eth", "keeper.low_eth", `The keeper has ${eth(bal)} on Base`, { balance: eth(bal) });
  },
};

/** keeper.low_tao: the keeper's TAO on Bittensor below what its next claim needs: a round of its actions
 * (keeperMinTaoWei) plus the claim's gas up front, (claimGasRequired + claimGasMargin) × the base fee (Bittensor takes
 * the whole gas limit's fee before running a transaction and refunds the rest; ops sends a claim with that limit).
 * The round alone while the vault's claimGasRequired or the base fee is unread: below it is found, above it unjudged
 * (whether it covers a claim can't be told). */
export const keeperLowTao: Rule = {
  name: "keeper.low_tao",
  run(ctx) {
    const s = ctx.snap.bittensor?.state;
    const bal = s?.keeperBalance;
    if (bal === undefined) return unjudged(ctx, "keeper.low_tao", "keeper.low_tao");
    const gas = s?.claimGasRequired === undefined ? undefined : s.claimGasRequired + BigInt(ctx.t.claimGasMargin);
    const upfront = gas === undefined || s?.baseFee === undefined ? undefined : gas * s.baseFee;
    const need = ctx.t.keeperMinTaoWei + (upfront ?? 0n);
    if (bal >= need) return upfront === undefined ? unjudged(ctx, "keeper.low_tao", "keeper.low_tao") : [];
    const facts: Record<string, string> = { balance: tao(bal), needed: tao(need), "a round of actions": tao(ctx.t.keeperMinTaoWei) };
    if (upfront !== undefined) facts["a claim's gas up front"] = `${tao(upfront)} (${gas} gas at ${formatUnits(s?.baseFee as bigint, 9)} gwei)`;
    return one("keeper.low_tao", "keeper.low_tao", `The keeper has ${tao(bal)} on Bittensor; ${upfront === undefined ? "a round" : "a claim"} needs ${tao(need)}`, facts);
  },
};

/** keeper.idle_unstaked: the vault's stakeable idle balance (balance − 1e12 − pendingPayouts) at least the
 * chain's minimum stake for more than idleUnstakedS (since when: meta idle_since). */
export const keeperIdleUnstaked: Rule = {
  name: "keeper.idle_unstaked",
  run(ctx) {
    const s = ctx.snap.bittensor?.state;
    if (s?.balance === undefined || s.pendingPayouts === undefined || s.minStakeRao === undefined) return unjudged(ctx, "keeper.idle_unstaked", "keeper.idle_unstaked");
    const idle = s.balance - ED_RESERVE - s.pendingPayouts;
    const since = num(ctx.meta.idle_since);
    if (idle < s.minStakeRao * RAO) {
      if (since !== undefined) ctx.writes.meta.push({ k: "idle_since", v: "" });
      return [];
    }
    if (since === undefined) {
      ctx.writes.meta.push({ k: "idle_since", v: String(ctx.nowS) });
      return [];
    }
    if (ctx.nowS - since <= ctx.t.idleUnstakedS) return [];
    return one("keeper.idle_unstaked", "keeper.idle_unstaked", `${tao(idle)} has waited unstaked since ${utc(since)}`, { idle: tao(idle), since: utc(since) });
  },
};

export const adapterLowReserve: Rule = {
  name: "adapter.low_reserve",
  run(ctx) {
    const bal = ctx.snap.bittensor?.state.adapterBalance;
    if (bal === undefined) return unjudged(ctx, "adapter.low_reserve", "adapter.low_reserve");
    if (bal >= ctx.t.adapterMinReserveWei) return [];
    return one("adapter.low_reserve", "adapter.low_reserve", "The Bittensor adapter's reserve is low", { balance: `${bal} wei`, adapter: ctx.cfg.deployment.bitAdapter });
  },
};

/** cap.nearly_full: netForwarded + the open batch's deposits at capNearlyFullPct of depositCap (a cap of 0 is none). */
export const capNearlyFull: Rule = {
  name: "cap.nearly_full",
  run(ctx) {
    const s = ctx.snap.base?.state;
    if (!s?.openBatch || s.netForwarded === undefined || s.depositCap === undefined) return unjudged(ctx, "cap.nearly_full", "cap.nearly_full");
    if (s.depositCap === 0n) return [];
    const used = s.netForwarded + s.openBatch.totalDeposits;
    if (used * 100n < s.depositCap * BigInt(ctx.t.capNearlyFullPct)) return [];
    return one("cap.nearly_full", "cap.nearly_full", "Cascade's deposit cap is nearly full", { used: tao(used), cap: tao(s.depositCap) });
  },
};

/** The open batch's front door logs of one kind (by its id). */
const openBatchLogs = (ctx: RuleCtx, event: string) => {
  const id = ctx.snap.base?.state.openBatch?.id;
  return id === undefined ? [] : ctx.logs.range("base", "frontDoor", event).filter((l) => String(l.args.batchId) === String(id));
};

/** batch.one_wallet: one payer (the staker's Staked.payer for a deposit through the staker, else the
 * DepositRequested payer) holds oneWalletPct of an open batch at least half of maxBatchValue, or
 * oneWalletEntries of its entries. */
export const batchOneWallet: Rule = {
  name: "batch.one_wallet",
  run(ctx) {
    const s = ctx.snap.base?.state;
    if (!s?.openBatch) return unjudged(ctx, "batch.one_wallet");
    const by = new Map<Hex, { amount: bigint; users: Set<string> }>();
    for (const l of openBatchLogs(ctx, "DepositRequested")) {
      let payer = String(l.args.payer).toLowerCase() as Hex;
      if (same(payer, ctx.cfg.deployment.staker)) {
        const staked = ctx.logs.inTx("base", l.txHash).find((x) => x.contract === "staker" && x.event === "Staked");
        if (staked) payer = String(staked.args.payer).toLowerCase() as Hex;
      }
      const e = by.get(payer) ?? { amount: 0n, users: new Set<string>() };
      e.amount += BigInt(String(l.args.amount));
      e.users.add(String(l.args.user).toLowerCase());
      by.set(payer, e);
    }
    const total = s.openBatch.totalDeposits;
    const halfFull = s.maxBatchValue !== undefined && total * 2n >= s.maxBatchValue;
    for (const [payer, e] of by) {
      const share = total > 0n && e.amount * 100n >= total * BigInt(ctx.t.oneWalletPct);
      if ((halfFull && share) || e.users.size >= ctx.t.oneWalletEntries) {
        return one("batch.one_wallet", `batch.one_wallet:${s.openBatch.id}:${payer}`, "One wallet is filling the open batch", {
          payer,
          deposits: tao(e.amount),
          entries: String(e.users.size),
          "batch total": tao(total),
          batch: String(s.openBatch.id),
        });
      }
    }
    // nothing found, but without maxBatchValue whether the batch is half full couldn't be told
    return s.maxBatchValue === undefined ? unjudged(ctx, "batch.one_wallet") : [];
  },
};

/** unstakes.tiny_wave: at least tinyUnstakeCount redeem requests in 24 h each worth less than
 * tinyUnstakeWei at the current price, or the open batch's redeem list at redeemListPct of maxRedeems. */
export const unstakesTinyWave: Rule = {
  name: "unstakes.tiny_wave",
  run(ctx) {
    const price = ctx.snap.bittensor?.state.price;
    const s = ctx.snap.base?.state;
    const since = ctx.nowS - 86400;
    const tiny =
      price === undefined
        ? 0
        : ctx.logs
            .range("base", "frontDoor", "RedeemRequested")
            .filter((l) => (ctx.blockTime("base", l.block) ?? ctx.nowS) >= since && (BigInt(String(l.args.shares)) * price) / E18 < ctx.t.tinyUnstakeWei).length;
    const full = s?.openBatch && s.maxRedeems ? s.openBatch.nRedeems * 100 >= s.maxRedeems * ctx.t.redeemListPct : false;
    // neither found: unjudged while the price (the requests' worth) or the redeem list is unread
    if (tiny < ctx.t.tinyUnstakeCount && !full) return price === undefined || !s?.openBatch || s.maxRedeems === undefined ? unjudged(ctx, "unstakes.tiny_wave", "unstakes.tiny_wave") : [];
    return one("unstakes.tiny_wave", "unstakes.tiny_wave", tiny >= ctx.t.tinyUnstakeCount ? `${tiny} tiny redeem requests in 24 hours` : "The open batch's redeem list is nearly full", {
      "tiny requests (24 h)": String(tiny),
      "redeem list": s?.openBatch ? `${s.openBatch.nRedeems} of ${s.maxRedeems}` : "unknown",
    });
  },
};

/** outflow.near_limit: this front door's burns in the vault's current 24-hour window plus the open batch's
 * redeems (at the current price) at outflowNearPct of max(gross × maxDailyOutflowBps / 10,000,
 * minDailyOutflow). Batches closed and not yet delivered aren't counted (their requests are not loaded). */
export const outflowNearLimit: Rule = {
  name: "outflow.near_limit",
  run(ctx) {
    const v = ctx.snap.bittensor;
    const s = v?.state;
    if (!v || !s || s.rootStakeRao === undefined || s.balance === undefined || s.maxDailyOutflowBps === undefined || s.minDailyOutflow === undefined || s.price === undefined) {
      return unjudged(ctx, "outflow.near_limit", "outflow.near_limit");
    }
    const gross = s.rootStakeRao * RAO + s.balance - ED_RESERVE;
    const byBps = (gross * s.maxDailyOutflowBps) / 10_000n;
    const allowance = byBps > s.minDailyOutflow ? byBps : s.minDailyOutflow;
    const burned = s.burnWindow && v.time < s.burnWindow.start + 86400 ? s.burnWindow.burned : 0n;
    const shares =
      openBatchLogs(ctx, "RedeemRequested").reduce((x, l) => x + BigInt(String(l.args.shares)), 0n) -
      openBatchLogs(ctx, "RedeemCancelled").reduce((x, l) => x + BigInt(String(l.args.shares)), 0n);
    const waiting = ((shares > 0n ? shares : 0n) * s.price) / E18;
    // nothing found, but with the burn window unread today's burns weren't counted
    if ((burned + waiting) * 100n < allowance * BigInt(ctx.t.outflowNearPct)) return s.burnWindow === undefined ? unjudged(ctx, "outflow.near_limit", "outflow.near_limit") : [];
    return one("outflow.near_limit", "outflow.near_limit", "Exits are near the vault's daily outflow limit", { burned: tao(burned), waiting: tao(waiting), allowance: tao(allowance) });
  },
};

/** rewards.uncollected: no claim for rewardsMaxAgeS, or rewardsDueWei waiting. */
export const rewardsUncollected: Rule = {
  name: "rewards.uncollected",
  run(ctx) {
    const v = ctx.snap.bittensor;
    const s = v?.state;
    if (!v || !s) return unjudged(ctx, "rewards.uncollected", "rewards.uncollected");
    const old = s.lastClaimAt !== undefined && v.time - s.lastClaimAt > ctx.t.rewardsMaxAgeS;
    const due = s.unclaimed !== undefined && s.unclaimed >= ctx.t.rewardsDueWei;
    if (!old && !due) return s.lastClaimAt === undefined || s.unclaimed === undefined ? unjudged(ctx, "rewards.uncollected", "rewards.uncollected") : [];
    return one("rewards.uncollected", "rewards.uncollected", "Root rewards are waiting to be claimed", {
      "last claim": s.lastClaimAt === undefined ? "unknown" : utc(s.lastClaimAt),
      unclaimed: s.unclaimed === undefined ? "unknown" : tao(s.unclaimed),
    });
  },
};

/** validator.not_earning: the stake hotkey's unclaimed rewards no higher than a day ago (the hour row then),
 * with no claim in the day. Not while the vault's stake on that hotkey is under notEarningMinStakeRao (an empty
 * vault earns nothing): the hotkey the reading asked getUnclaimedRootTaoByHotkey for (the previous reading's stake
 * hotkey, else the configured one, snapshot.ts) and its getStake from the same multicall, no request of its own; the
 * vault's counted stake (rootStakeRao, which can only be larger) when that answer is missing. */
export const validatorNotEarning: Rule = {
  name: "validator.not_earning",
  run(ctx) {
    const v = ctx.snap.bittensor;
    const s = v?.state;
    const blind = () => unjudged(ctx, "validator.not_earning", "validator.not_earning");
    if (!v || s?.unclaimed === undefined) return blind();
    const hotkey = (ctx.previous.bittensor?.state.stakeHotkey ?? ctx.cfg.deployment.stakeHotkey).toLowerCase() as Hex;
    const staked = s.stakes[hotkey] ?? s.rootStakeRao;
    if (staked === undefined) return blind();
    if (staked < ctx.t.notEarningMinStakeRao) return [];
    const dayAgo = Math.floor((ctx.nowS - ctx.t.notEarningS) / 3600) * 3600;
    const then = ctx.hours.find((r) => r.hour === dayAgo)?.unclaimedLast;
    if (then === undefined) return blind();
    if (s.unclaimed > then) return [];
    if (s.lastClaimAt !== undefined && s.lastClaimAt >= v.time - ctx.t.notEarningS) return [];
    return one("validator.not_earning", "validator.not_earning", "The validator hasn't earned in a day", {
      unclaimed: tao(s.unclaimed),
      "a day ago": tao(then),
      "the vault's stake on it": tao(staked * RAO),
      hotkey,
    });
  },
};

/** rail.alpha_vault (critical): ForeverMoney's AlphaVault paused (isPaused, or a guardian's pause until a time still to
 * come), a migration announced (a ready time or a target set), executed or finished. */
export const railAlphaVault: Rule = {
  name: "rail.alpha_vault",
  run(ctx) {
    const r = ctx.snap.bittensor;
    const a = r?.state.alpha;
    if (!r || !a) return unjudged(ctx, "rail.alpha_vault", "rail.alpha_vault");
    const set = (x: bigint | undefined) => x !== undefined && x !== 0n;
    const target = a.migrationTarget && a.migrationTarget !== "0x0000000000000000000000000000000000000000" ? a.migrationTarget : undefined;
    const why = [
      a.isPaused ? "paused" : "",
      a.pausedUntil !== undefined && a.pausedUntil > BigInt(r.time) ? `paused by its guardian until ${utc(Number(a.pausedUntil))}` : "",
      target ? `a migration to ${target} is announced` : "",
      !target && set(a.migrationReadyAt) ? "a migration is announced" : "",
      a.migrationExecuted ? "a migration was executed" : "",
      a.migrationFinished ? "migrated" : "",
    ].filter(Boolean);
    // nothing found: clear only when every field it looks at was read
    const unread = [a.isPaused, a.pausedUntil, a.migrationTarget, a.migrationReadyAt, a.migrationExecuted, a.migrationFinished].some((x) => x === undefined);
    if (why.length === 0) return unread ? unjudged(ctx, "rail.alpha_vault", "rail.alpha_vault") : [];
    const at = (x: bigint | undefined) => (x === undefined ? "unknown" : x === 0n ? "none" : utc(Number(x)));
    return one("rail.alpha_vault", "rail.alpha_vault", `ForeverMoney's AlphaVault is ${why.join(", ")}`, {
      alphaVault: ctx.cfg.tokens.bittensor.alphaVault,
      paused: String(a.isPaused ?? "unknown"),
      "paused until": at(a.pausedUntil),
      "pauseable after": at(a.pauseableAfter),
      "migration ready at": at(a.migrationReadyAt),
      "migration target": a.migrationTarget ?? "unknown",
      "migration executed": String(a.migrationExecuted ?? "unknown"),
      "migration finished": String(a.migrationFinished ?? "unknown"),
      block: String(r.block),
    });
  },
};

/** indexer.lag (warning) past lagLimit, and indexer.blind (critical) past max(2 × lagLimit, blindMinS), on
 * each chain's `head_time − settled_time`. */
export const indexerLag: Rule = {
  name: "indexer.lag",
  conditions: ["indexer.blind"],
  run(ctx) {
    const limit = lagLimitOf(ctx.payoutDelayS, ctx.t);
    const blind = Math.max(2 * limit, ctx.t.blindMinS);
    return (["base", "bittensor"] as ChainName[]).flatMap((chain) => {
      const s = ctx.settled[chain];
      if (s.headTime === undefined) return [...unjudged(ctx, "indexer.lag", `indexer.lag:${chain}`), ...unjudged(ctx, "indexer.blind", `indexer.blind:${chain}`)];
      const lag = s.headTime - s.time;
      const facts = { chain, lag: `${Math.floor(lag / 60)} minutes`, limit: `${Math.floor(limit / 60)} minutes`, "settled to": utc(s.time) };
      if (lag > blind) return one("indexer.blind", `indexer.blind:${chain}`, `The monitor can't see ${chain}: ${Math.floor(lag / 60)} minutes behind`, facts);
      if (lag > limit) return one("indexer.lag", `indexer.lag:${chain}`, `The monitor is ${Math.floor(lag / 60)} minutes behind on ${chain}`, facts);
      return [];
    });
  },
};

/** indexer.reorg: each stored log a re-read no longer found this tick. */
export const indexerReorg: Rule = {
  name: "indexer.reorg",
  run: (ctx) => ctx.removed.map((r) => ({ rule: "indexer.reorg", key: `indexer.reorg:${r.uid}`, subject: `A stored ${r.chain} log vanished from a later read`, facts: { chain: r.chain, uid: r.uid } })),
};

/** monitor.chain_unreadable: chainUnreadableTicks ticks in a row without a usable reading of a chain (none,
 * or one not newer than the last): counted in meta unreadable_{chain}. */
export const chainUnreadable: Rule = {
  name: "monitor.chain_unreadable",
  run(ctx) {
    return (["base", "bittensor"] as ChainName[]).flatMap((chain) => {
      const k = `unreadable_${chain}`;
      const was = num(ctx.meta[k]) ?? 0;
      if (ctx.snap[chain]) {
        if (was > 0) ctx.writes.meta.push({ k, v: "0" });
        return [];
      }
      const n = was + 1;
      ctx.writes.meta.push({ k, v: String(n) });
      if (n < ctx.t.chainUnreadableTicks) return [];
      return one("monitor.chain_unreadable", `monitor.chain_unreadable:${chain}`, `No usable reading of ${chain} for ${n} ticks`, { chain, ticks: String(n) });
    });
  },
};

/** monitor.email_failing: emails failing for emailFailingS (since: meta email_failing_since, kept by the
 * tick's send step). */
export const emailFailing: Rule = {
  name: "monitor.email_failing",
  run(ctx) {
    const since = num(ctx.meta.email_failing_since);
    if (since === undefined || ctx.nowS - since < ctx.t.emailFailingS) return [];
    return one("monitor.email_failing", "monitor.email_failing", "Alert emails are failing", { since: utc(since), error: ctx.meta.email_failing_error ?? "unknown" });
  },
};

/** indexer.unverified: the hourly logs cross-check (src/logs-check.ts) failing on a chain's second endpoint for
 * logsCheckUnverifiedS (since: meta logs_check_fail_since:{chain}, kept by the job; its last error beside it). */
export const indexerUnverified: Rule = {
  name: "indexer.unverified",
  run(ctx) {
    return (["base", "bittensor"] as ChainName[]).flatMap((chain) => {
      const since = num(ctx.meta[`logs_check_fail_since:${chain}`]);
      if (since === undefined || ctx.nowS - since < ctx.t.logsCheckUnverifiedS) return [];
      const hours = Math.floor((ctx.nowS - since) / 3600);
      const name = chain === "base" ? "Base" : "Bittensor";
      return one("indexer.unverified", `indexer.unverified:${chain}`, `${name}'s logs haven't been cross-checked for ${hours} hour${hours === 1 ? "" : "s"}`, {
        chain,
        chainName: name,
        since: utc(since),
        for: `${hours} hour${hours === 1 ? "" : "s"}`,
        error: ctx.meta[`logs_check_error:${chain}`] || "unknown",
      });
    });
  },
};

const UNJUDGED_SINCE = "unjudged_since:";
/** Critical conditions whose blindness another alert reports already: an incomplete site pass is site.unreachable's
 * warning (a pass runs hourly, so one bad pass would outlast unjudgedCriticalS on its own). */
const BLINDNESS_REPORTED: ReadonlySet<string> = new Set(["site.integrity"]);

/** monitor.unjudged (critical): the critical conditions the rules couldn't judge this tick (ctx.unjudged: a reading or
 * a field missing, or the rule throwing), each unjudged on every tick for unjudgedCriticalS or more (since: meta
 * unjudged_since:{rule}, set on its first such tick, cleared on the first tick it is judged again). One alert for all
 * of them, so a whole chain out is one email, and a read broken for good while the chain reads fine (a runtime change
 * breaking a storage decode, an AlphaVault upgrade dropping backing()) can't blind a critical rule in silence. Runs
 * last of the tick's rules (tick.ts), so every mark is in, runRules' own for a rule that threw too. Rules switched off
 * aren't counted. */
export const monitorUnjudged: Rule = {
  name: "monitor.unjudged",
  run(ctx) {
    const off = new Set(ctx.t.rules.off);
    const counted = (rule: string) => rule in RULES && RULES[rule as keyof typeof RULES].tier === "critical" && RULES[rule as keyof typeof RULES].kind === "condition" && !off.has(rule) && !BLINDNESS_REPORTED.has(rule);
    const marked = [...new Set(ctx.unjudged.map((u) => u.rule))].filter(counted);
    // the marks: set on a rule's first unjudged tick, cleared on the first it is judged again
    for (const [k, v] of Object.entries(ctx.meta)) {
      if (k.startsWith(UNJUDGED_SINCE) && v !== "" && !marked.includes(k.slice(UNJUDGED_SINCE.length) as (typeof marked)[number])) ctx.writes.meta.push({ k, v: "" });
    }
    const since = new Map<string, number>();
    for (const rule of marked) {
      const s = num(ctx.meta[`${UNJUDGED_SINCE}${rule}`]);
      if (s === undefined || !Number.isFinite(s)) ctx.writes.meta.push({ k: `${UNJUDGED_SINCE}${rule}`, v: String(ctx.nowS) });
      since.set(rule, s !== undefined && Number.isFinite(s) ? s : ctx.nowS);
    }
    const long = marked.filter((rule) => ctx.nowS - (since.get(rule) as number) >= ctx.t.unjudgedCriticalS);
    if (long.length === 0) return [];
    const minutes = (rule: string) => Math.floor((ctx.nowS - (since.get(rule) as number)) / 60);
    const longest = Math.max(...long.map(minutes));
    const facts: Record<string, string> = { rules: long.join(", ") };
    for (const rule of long) facts[rule] = `unjudged since ${utc(since.get(rule) as number)} (${minutes(rule)} minutes)`;
    const what = long.length === 1 ? long[0] : `${long.length} critical conditions (${long[0]} and ${long.length - 1} more)`;
    return one("monitor.unjudged", "monitor.unjudged", `The monitor hasn't been able to judge ${what} for ${longest} minutes`, facts);
  },
};

export const OPS_RULES: Rule[] = [
  batchPastMaxWait,
  payoutOverdue,
  deliveryOverdue,
  keeperLowEth,
  keeperLowTao,
  keeperIdleUnstaked,
  adapterLowReserve,
  capNearlyFull,
  batchOneWallet,
  unstakesTinyWave,
  outflowNearLimit,
  rewardsUncollected,
  validatorNotEarning,
  railAlphaVault,
  indexerLag,
  indexerReorg,
  chainUnreadable,
  emailFailing,
  indexerUnverified,
];

