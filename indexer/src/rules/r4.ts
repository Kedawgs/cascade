import { formatUnits, type Hex } from "viem";
import type { Finding } from "../alerts.ts";
import type { ChainName } from "../config.ts";
import { type Payout, payoutList } from "../crosscheck/payouts.ts";
import { STAKE_RAMP_S } from "../abi.ts";
import type { StoredLog } from "../logs.ts";
import { blocksIn, lookbackFrom } from "../blocktime.ts";
import { BITTENSOR_BLOCK_S } from "../parks.ts";
import { type BaseState, type BitState, type ChainReading, payoutRailClosedOf, primaryDisabledOf } from "../snapshot.ts";
import { messageOutcome } from "./ccip.ts";
import { isNew, type Readings, type RuleCtx, twice, txLink, unjudged, utc } from "./context.ts";
import type { Rule } from "./index.ts";

// Checkpoint R4's monitor rules (r4o-dispatch.md): the stamp bot gone quiet (D-L3), a batch that blocks every deposit
// (A-L1), the deposit cap counting TAO that has left the vault (A-L2), Bittensor's minimum stake near the redeem floor,
// payouts the vault's primary bridge can't send (S-H1: its canSendPayouts()), and a bounce-only payout queue whose door
// or bridge is going (S-L4). v3.2 only. A reading or a field missing is unjudged (an open alert left as it is), never
// quiet.

const RAO = 10n ** 9n;
const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO`;
const one = (rule: Finding["rule"], key: string, subject: string, facts: Record<string, string> = {}): Finding[] => [{ rule, key, subject, facts }];
const lower = (a: string) => a.toLowerCase() as Hex;
const hours = (s: number) => `${Math.floor(s / 3_600)} hours`;

/** CascadeConstants.MIN_REDEEM_VALUE in rao: the smallest front-door redeem burned, 0.03 TAO (test/node/r4-pins.test.ts
 * holds it to the contracts'). The Bittensor adapter's conversion floor is the chain's minimum stake: once that climbs to
 * it, a queued payout of a minimum entry reverts BelowConversionFloor. */
export const MIN_REDEEM_VALUE_RAO = 30_000_000n;

const SIDES: readonly { chain: ChainName; name: string }[] = [
  { chain: "bittensor", name: "Bittensor" },
  { chain: "base", name: "Base" },
];

/** admin.stamp_quiet (critical condition, D-L3): with the stamp bot switched on (THRESHOLDS stampQuietS above 0, the
 * founder's, with the bot), a chain whose owner clock (lastOwnerClose: every relayed stamp moves it to its asOf) is older
 * than stampQuietS: the pre-signed stack isn't being relayed (the PC off, the relayer out of gas, the stack run out), and
 * the copied-seed defence (runbook 7.2) has stopped. Off at 0. */
export const adminStampQuiet: Rule = {
  name: "admin.stamp_quiet",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2" || !(ctx.t.stampQuietS > 0)) return [];
    return SIDES.flatMap(({ chain, name }) => {
      const r = ctx.snap[chain];
      const last = r?.state.exits?.lastOwnerClose;
      if (!r || last === undefined) return unjudged(ctx, "admin.stamp_quiet", `admin.stamp_quiet:${chain}`);
      const age = r.time - last;
      if (age <= ctx.t.stampQuietS) return [];
      return one("admin.stamp_quiet", `admin.stamp_quiet:${chain}`, `No owner stamp has landed on ${name} for ${hours(age)}`, {
        "last stamp (the owner's clock)": utc(last),
        "expected within": hours(ctx.t.stampQuietS),
      });
    });
  },
};

/** R7 (L1), R8: how many readings in a row (this tick's and the ones before it, a tick a minute) the open batch must read
 * closable because it is full before batch.deposits_blocked fires: 7, the most the store allows (it keeps 6 readings
 * before this tick's). The half rule makes "full" routine (half the batch limit can close at once), and a keeper with
 * several actions queued, or backing off after a failed round, can take a few rounds to close it; seven minutes of it
 * means nothing is closing it. */
export const FULL_UNCLOSED_READINGS = 7;

/** batch.deposits_blocked (critical condition, A-L1; R7, L1): the open batch the front door lets close because it is full,
 * canClose() true before its interval (its deposit or redeem list, or since R6b's room rule half its value limit or of
 * the cap's room, or no room for a minimum deposit), still the same batch on FULL_UNCLOSED_READINGS readings in a row,
 * each from an older block. The keeper closes a full batch on its next round (each minute), so it isn't closing (down,
 * out of ETH, at its Base spend cap, held, or the vault's payouts closed under a batch with unstakes); meanwhile
 * deposits may be refused. Judged
 * by canClose() as read, never a copy of the door's rule; past its interval canClose() is true by time alone, so full
 * can't be told and nothing is judged full there (batch.past_max_wait watches a batch kept open). A field unread on any
 * of the readings, or too few readings, is unjudged. Before R7 it fired on room under minDeposit with canClose() false,
 * which the room rule made impossible on a v3.2 door. */
export const batchDepositsBlocked: Rule = {
  name: "batch.deposits_blocked",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const r = ctx.snap.base;
    const ob = r?.state.openBatch;
    if (!r || !ob) return unjudged(ctx, "batch.deposits_blocked", "batch.deposits_blocked");
    /** This batch, closable by its limits (before its interval), on reading `x`; undefined when unread there */
    const fullOn = (x: ChainReading<BaseState>): boolean | undefined => {
      const b = x.state.openBatch;
      if (!b || x.state.canClose === undefined || x.state.batchInterval === undefined) return undefined;
      return b.id === ob.id && x.state.canClose && x.time < b.start + x.state.batchInterval;
    };
    let block = r.block;
    for (const x of [r, ...ctx.history.base.slice(0, FULL_UNCLOSED_READINGS - 1)]) {
      if (x !== r && x.block >= block) return unjudged(ctx, "batch.deposits_blocked", "batch.deposits_blocked");
      block = x.block;
      const full = fullOn(x);
      if (full === undefined) return unjudged(ctx, "batch.deposits_blocked", "batch.deposits_blocked");
      if (!full) return [];
    }
    if (ctx.history.base.length < FULL_UNCLOSED_READINGS - 1) return unjudged(ctx, "batch.deposits_blocked", "batch.deposits_blocked");
    const s = r.state;
    const room = s.maxBatchValue === undefined ? undefined : s.maxBatchValue > ob.totalDeposits ? s.maxBatchValue - ob.totalDeposits : 0n;
    return one("batch.deposits_blocked", `batch.deposits_blocked:${ob.id}`, `The open batch is full and can close at once, but nothing has closed it for ${FULL_UNCLOSED_READINGS} readings in a row`, {
      batch: String(ob.id),
      "readings in a row": String(FULL_UNCLOSED_READINGS),
      ...(s.maxDeposits !== undefined ? { deposits: `${ob.nDeposits} of ${s.maxDeposits}` } : {}),
      ...(s.maxRedeems !== undefined ? { "redeem requests": `${ob.nRedeems} of ${s.maxRedeems}` } : {}),
      "batch total": tao(ob.totalDeposits),
      ...(room !== undefined ? { "room left": tao(room) } : {}),
      ...(s.minDeposit !== undefined ? { "the least deposit": tao(s.minDeposit) } : {}),
      "its interval ends": utc(ob.start + s.batchInterval!),
    });
  },
};

/** Build B: how many closes in 24 hours of deposit lists at half their limit, of small deposits, make batch.deposits_full. */
export const SMALL_LIST_CLOSES = 2;

/** batch.deposits_full (warning condition; R6, Fable's full review, L-2, rethought for build B's list half rule). The front
 * door closes a batch at once once half its deposit slots are taken (2 x deposits >= maxDeposits, 25 of 50), so while the
 * keeper runs a list no longer stays full to be held (a list left closable is batch.deposits_blocked's, critical). What
 * can still be pushed on the keeper is the cost of those closes: lists filled to half with deposits near the minimum,
 * about 1 TAO at the launch's 0.04, each closed at once and its bridge fee paid by its closer beyond the pot (the keeper's
 * 0.01 ETH a day of Base spend). So it watches the closes: at least SMALL_LIST_CLOSES batches closed in the last 24 hours
 * (their blocks' times) with their deposit list at half its limit or more, their deposits averaging at most twice
 * minDeposit (both as read now). Once is an honest rush; twice a day, someone may be forcing closes (the response: a
 * higher minDeposit, setCaps). The closes come from the 25 hours of Base's front door closes the prefetch loads; one whose
 * block time is unknown (no stored header) counts by its block, within 24 hours of Base's blocks at its measured block
 * time (R12d: before, it counted as now), and with that unknown too (a first tick) by the prefetch's window alone. The
 * limits unread: unjudged. */
export const batchDepositsFull: Rule = {
  name: "batch.deposits_full",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const s = ctx.snap.base?.state;
    if (!s || s.maxDeposits === undefined || s.minDeposit === undefined) return unjudged(ctx, "batch.deposits_full", "batch.deposits_full");
    const max = BigInt(s.maxDeposits);
    const min = s.minDeposit;
    const since = ctx.nowS - 86_400;
    // the first block of the last 24 hours, for a close whose block time is unknown (0 while Base's block time is)
    const fromBlock = ctx.snap.base ? lookbackFrom(ctx.snap.base.block, 86_400, ctx.blockS.base) : 0n;
    const forced = ctx.logs.range("base", "frontDoor", "BatchClosed").filter((l) => {
      const t = ctx.blockTime("base", l.block);
      if (t === undefined ? l.block < fromBlock : t < since) return false;
      const n = BigInt(String(l.args.nDeposits));
      return n > 0n && 2n * n >= max && BigInt(String(l.args.totalDeposits)) <= 2n * min * n;
    });
    if (forced.length < SMALL_LIST_CLOSES) return [];
    const last = forced[forced.length - 1];
    const beyond = forced.reduce((t, l) => {
      const x = BigInt(String(l.args.fee)) - BigInt(String(l.args.potUsed));
      return x > 0n ? t + x : t;
    }, 0n);
    return one(
      "batch.deposits_full",
      "batch.deposits_full",
      `${forced.length} batches closed in 24 hours with half their deposit slots or more taken by small deposits: each such list closes at once, its bridge fee paid by its closer`,
      {
        "closes (24 h)": String(forced.length),
        "the last": `batch ${String(last.args.id)}: ${String(last.args.nDeposits)} of ${s.maxDeposits} deposits, ${tao(BigInt(String(last.args.totalDeposits)))}`,
        "their bridge fees beyond their pots": `${formatUnits(beyond, 18)} ETH`,
        "the least deposit": tao(min),
      },
    );
  },
};

/** batch.cancel_churn (warning condition; R8, the contracts review's L-1): one address's deposit cancels in the open batch
 * (DepositCancelled; its user is the canceller, msg.sender) add up to cancelChurnPct of its maxBatchValue, or number
 * cancelChurnCount. The pattern it watches: deposit the batch full just after a keeper round and cancel before the
 * next, so honest deposits revert BatchValueFull for most of each minute, at two Base transactions a minute and no
 * loss (a close that lands while it is full commits the holder's capital: the keeper's each minute, the depositor's own
 * on the site, the founder's). batch.deposits_blocked misses it (the batch never reads full for seven readings in a
 * row). One finding per address and batch, naming the address and the amounts; it clears once the batch has closed.
 * The open batch's cancels are prefetched whatever their age (context.ts, the open batch's request transactions). The
 * open batch unread, or its limit unread with nothing found by count: unjudged. v3.2 only. */
export const batchCancelChurn: Rule = {
  name: "batch.cancel_churn",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const s = ctx.snap.base?.state;
    const ob = s?.openBatch;
    if (!s || !ob) return unjudged(ctx, "batch.cancel_churn");
    const ofBatch = (event: string) => ctx.logs.range("base", "frontDoor", event).filter((l) => String(l.args.batchId) === String(ob.id));
    const by = new Map<Hex, { n: number; amount: bigint; largest: bigint }>();
    for (const l of ofBatch("DepositCancelled")) {
      const user = lower(String(l.args.user));
      const amount = BigInt(String(l.args.amount));
      const e = by.get(user) ?? { n: 0, amount: 0n, largest: 0n };
      e.n++;
      e.amount += amount;
      if (amount > e.largest) e.largest = amount;
      by.set(user, e);
    }
    const deposited = (user: Hex) => ofBatch("DepositRequested").filter((l) => lower(String(l.args.user)) === user).reduce((t, l) => t + BigInt(String(l.args.amount)), 0n);
    const limit = s.maxBatchValue;
    const out: Finding[] = [];
    for (const [user, e] of by) {
      const byValue = limit !== undefined && e.amount * 100n >= limit * BigInt(ctx.t.cancelChurnPct);
      if (!byValue && e.n < ctx.t.cancelChurnCount) continue;
      out.push(
        ...one("batch.cancel_churn", `batch.cancel_churn:${ob.id}:${user}`, `One address has cancelled ${tao(e.amount)} of deposits in the open batch (${e.n} cancel${e.n === 1 ? "" : "s"}): the pattern of a holder that keeps the batch full between the keeper's rounds`, {
          address: user,
          batch: String(ob.id),
          cancels: String(e.n),
          "cancelled in all": tao(e.amount),
          "the largest cancel": tao(e.largest),
          "deposited in this batch": tao(deposited(user)),
          ...(limit !== undefined ? { "the batch's value limit": tao(limit) } : {}),
        }),
      );
    }
    // nothing found, but without maxBatchValue the value test couldn't be made
    return out.length === 0 && limit === undefined && by.size > 0 ? unjudged(ctx, "batch.cancel_churn") : out;
  },
};

/** cap.exits_consumed (warning condition, A-L2): the front door's netForwarded (what its deposit cap counts: every close
 * added, only payouts landing on Base taken off) at least capExitsGapWei above the vault's assets and what is between
 * them: Cascade's bridge messages still crossing (a batch closed and not arrived, a payout sent and not landed) and the
 * Bittensor adapters' parks (R4-O's fix round, Minor 7: a batch over 1 TAO in flight or parked fired it). Direct exits on
 * Bittensor (redeemDirect) take TAO out without lowering it, so the cap fills with TAO that has left. An adapter's parks
 * unread: unjudged.
 * A batch just closed is between the chains too, before its message is: a close raises netForwarded in the very reading
 * it lands in, while its bridge message reaches ctx.messages only once the scan has settled the close's block (its
 * re-read and settle margins, minutes behind the head). For those readings the batch was in neither the vault, nor the
 * crossing messages, nor a park, and read as "left" (the launch's second batch, 01:34 UTC on 2026-11-17: one false
 * warning). So what netForwarded rose by over the last CLOSE_LAG_READINGS readings, less what of it the messages
 * already show crossing to Bittensor from that time on, counts as between the chains. A real gap is found at most
 * that many readings later. */
export const CLOSE_LAG_READINGS = 5;
export const capExitsConsumed: Rule = {
  name: "cap.exits_consumed",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const s = ctx.snap.base?.state;
    const bit = ctx.snap.bittensor?.state;
    const assets = bit?.totalAssets;
    if (s?.netForwarded === undefined || assets === undefined) return unjudged(ctx, "cap.exits_consumed", "cap.exits_consumed");
    let parked = 0n;
    for (const a of ctx.cfg.bridges.bittensor.map(lower)) {
      const p = bit?.adapters?.[a];
      if (p?.parkedNative === undefined || p.parkedTokens === undefined) return unjudged(ctx, "cap.exits_consumed", "cap.exits_consumed");
      parked += p.parkedNative + p.parkedTokens;
    }
    // a parked batch's message is counted in its adapter's parks, not here (messageOutcome "parked")
    const crossing = ctx.messages.filter((m) => messageOutcome(ctx, m) === "pending").reduce((x, m) => x + BigInt(m.amount), 0n);
    // what the closes of the last few readings added and the messages don't show yet (the comment above)
    const past = ctx.history.base[Math.min(CLOSE_LAG_READINGS, ctx.history.base.length) - 1];
    let closing = 0n;
    if (past?.state.netForwarded !== undefined && s.netForwarded > past.state.netForwarded) {
      const added = s.netForwarded - past.state.netForwarded;
      const seen = ctx.messages
        .filter((m) => m.direction === "base>bittensor" && m.srcTime >= past.time && messageOutcome(ctx, m) === "pending")
        .reduce((x, m) => x + BigInt(m.amount), 0n);
      if (added > seen) closing = added - seen;
    }
    const between = assets + crossing + parked + closing;
    const gap = s.netForwarded > between ? s.netForwarded - between : 0n;
    if (gap < ctx.t.capExitsGapWei) return [];
    return one("cap.exits_consumed", "cap.exits_consumed", `The deposit cap counts ${tao(gap)} that has left the vault`, {
      "net forwarded (what the cap counts)": tao(s.netForwarded),
      "the vault's assets": tao(assets),
      "crossing between the chains": tao(crossing),
      "parked on the Bittensor adapters": tao(parked),
      ...(closing > 0n ? { "closed in the last few readings, its message not read yet": tao(closing) } : {}),
      "deposit cap": s.depositCap === undefined ? "not read" : tao(s.depositCap),
    });
  },
};

/** stake.min_near_floor (warning) and stake.min_at_floor (critical), conditions: Bittensor's minimum stake (the vault's
 * minStakeRao, the chain's) at minStakeWarnPct, or minStakeCriticalPct, of MIN_REDEEM_VALUE. The Bittensor adapter
 * converts nothing below it, so once it reaches the redeem floor a queued payout of a minimum entry reverts
 * BelowConversionFloor. One finding, the higher tier's. */
export const stakeMinNearFloor: Rule = {
  name: "stake.min_near_floor",
  raises: ["stake.min_at_floor"],
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const min = ctx.snap.bittensor?.state.minStakeRao;
    if (min === undefined) {
      unjudged(ctx, "stake.min_at_floor", "stake.min_at_floor");
      return unjudged(ctx, "stake.min_near_floor", "stake.min_near_floor");
    }
    const pct = Number((min * 100n) / MIN_REDEEM_VALUE_RAO);
    const subject = `Bittensor's minimum stake, ${tao(min * RAO)}, is ${pct}% of the ${tao(MIN_REDEEM_VALUE_RAO * RAO)} redeem floor`;
    const facts = { "minimum stake": tao(min * RAO), "redeem floor (MIN_REDEEM_VALUE)": tao(MIN_REDEEM_VALUE_RAO * RAO) };
    if (min * 100n >= MIN_REDEEM_VALUE_RAO * BigInt(ctx.t.minStakeCriticalPct)) return one("stake.min_at_floor", "stake.min_at_floor", subject, facts);
    if (min * 100n >= MIN_REDEEM_VALUE_RAO * BigInt(ctx.t.minStakeWarnPct)) return one("stake.min_near_floor", "stake.min_near_floor", subject, facts);
    return [];
  },
};

/** Why the vault's primary bridge can't send payouts: the primary disabled on the vault (R6, claim D: a switch made the
 * front door's side first, or an incident); else from ForeverMoney's state read beside its view (the AlphaVaults of the
 * rail now primary, as one: R4-O round 4): a migration finished or announced (closed for good: the queue needs the
 * owner's cancels, runbook 7.7), a pause (for as long as it lasts); or, ForeverMoney's own state reading clear, the
 * adapter's read of its AlphaVault failing, which canSendPayouts() reads as closed. */
export const PRIMARY_DISABLED_WHY = "the vault's primary bridge is disabled on the vault";
export function closedWhy(s: BitState): string {
  if (primaryDisabledOf(s)) return PRIMARY_DISABLED_WHY;
  const a = s.alpha;
  if (a.migrationFinished || a.migrationExecuted) return "ForeverMoney's migration of its AlphaVault finished";
  if (a.migrationReadyAt !== undefined && a.migrationReadyAt > 0n) return `ForeverMoney announced a migration of its AlphaVault (ready at ${utc(Number(a.migrationReadyAt))})`;
  if (a.isPaused) return "ForeverMoney's AlphaVault is paused";
  if (a.isPaused === undefined || a.migrationReadyAt === undefined || a.migrationFinished === undefined) return "ForeverMoney's AlphaVault wasn't read: see the adapter's canSendPayouts() on the explorer";
  return "the adapter's read of ForeverMoney's AlphaVault failed, or reads another vault than the monitor's (ForeverMoney's own state reads clear)";
}

/** A queued payout batch's entries not sent yet (its list from the vault's events: bounces first, then redeems; a
 * cancel's carried bounces as its new list), or undefined while its PayoutBatchQueued isn't loaded. */
function entriesLeft(logs: readonly StoredLog[], key: Hex): Payout[] | undefined {
  const mine = logs.filter((l) => lower(String(l.args.key)) === lower(key));
  if (!mine.some((l) => l.event === "PayoutBatchQueued")) return undefined;
  const list = payoutList(mine, key);
  const taken = mine.filter((l) => l.event === "PayoutChunkSent").reduce((n, l) => n + Number(l.args.taken), 0);
  // as payout.entry_above_cap reads it: a cancel leaves the bounces not sent yet as the batch's list
  const end = mine.some((l) => l.event === "PayoutBatchCancelled") ? list.filter((x) => x.shares === 0n).length : list.length;
  return list.slice(taken, end);
}

const QUEUE_EVENTS = ["DepositBounced", "Redeemed", "PayoutBatchQueued", "PayoutChunkSent", "PayoutBatchCancelled"];
const sumOf = (xs: readonly Payout[]) => `${xs.length}, ${tao(xs.reduce((t, x) => t + x.assets, 0n))}`;

/** rail.payouts_closed (critical condition, S-H1): the vault's primary bridge answers canSendPayouts() false (R4: its
 * AlphaVault paused, a migration announced or finished, or a read of it failing), the view the vault itself reads
 * before each delivery's door redeems, as this reading names the primary (the reads follow the primary rail: R4-O round
 * 4). While it is false the vault defers every front-door redeem (RedeemDeferred: nothing burned, the requester keeps
 * the shares and asks again), so the open batch's redeem requests will be deferred, not burned; and no queued payout
 * batch can be sent: each is named, its share entries (a cancel re-mints them) apart from its bounces (no cancel: owed
 * TAO; S-L4). Since R6 (ChatGPT R2 claim D) a primary disabled on the vault reads closed too, as the vault reads it
 * (payoutRailClosedOf), whatever its own view. Critical, so no hold mutes it. Why it is closed: the disable, else
 * ForeverMoney's state read beside it (closedWhy). Unjudged while the primary or its view is unread. */
export const railPayoutsClosed: Rule = {
  name: "rail.payouts_closed",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const s = ctx.snap.bittensor?.state;
    const closed = payoutRailClosedOf(s);
    if (!s || closed === undefined) return unjudged(ctx, "rail.payouts_closed", "rail.payouts_closed");
    if (!closed) return [];
    const common = { "the vault's primary bridge": lower(s.primaryBridge as Hex), why: closedWhy(s) };
    const out: Finding[] = [];
    const ob = ctx.snap.base?.state.openBatch;
    if (ob === undefined) unjudged(ctx, "rail.payouts_closed", "rail.payouts_closed:redeems");
    else if (ob.nRedeems > 0) {
      out.push(
        ...one("rail.payouts_closed", `rail.payouts_closed:redeems:${ob.id}`, `${ob.nRedeems} redeem request${ob.nRedeems === 1 ? "" : "s"} in the open batch will be deferred: the vault's bridge can't send payouts`, {
          batch: String(ob.id),
          ...common,
        }),
      );
    }
    const logs = ctx.logs.range("bittensor", "vault", QUEUE_EVENTS);
    for (const key of ctx.pendingPayoutKeys) {
      const p = s.payoutBatches[key];
      if (!p) {
        unjudged(ctx, "rail.payouts_closed", `rail.payouts_closed:queued:${key}`);
        continue;
      }
      if (p.count <= p.cursor) continue;
      const left = entriesLeft(logs, key);
      out.push(
        ...one("rail.payouts_closed", `rail.payouts_closed:queued:${key}`, "A queued payout batch can't be sent: the vault's bridge can't send payouts", {
          key,
          left: `${p.count - p.cursor} of ${p.count} entries`,
          ...(left
            ? { "share entries (a cancel re-mints them)": sumOf(left.filter((x) => x.shares !== 0n)), "bounces (no cancel: owed TAO)": sumOf(left.filter((x) => x.shares === 0n)) }
            : { entries: "not known (its PayoutBatchQueued isn't loaded)" }),
          ...common,
        }),
      );
    }
    return out;
  },
};

/** meta: the closures of the vault's primary bridge the monitor has seen (canSendPayouts() false), comma-separated, each
 * `since` (the Bittensor block of the first reading that saw it closed) or `since:until` (until, the block of the first
 * that saw it open again), kept until the scan's settled block passes `until`; '' when none (payout.no_rail). One bare
 * block, as it was first written, is one closure still open. */
export const RAIL_CLOSED_SINCE = "rail_closed_since";

interface Closure {
  since: bigint;
  until?: bigint;
}
const closuresOf = (v: string | undefined): Closure[] =>
  (v ?? "")
    .split(",")
    .filter((x) => /^\d+(:\d+)?$/.test(x))
    .map((x) => {
      const [since, until] = x.split(":");
      return until === undefined ? { since: BigInt(since) } : { since: BigInt(since), until: BigInt(until) };
    });
const closuresText = (cs: readonly Closure[]) => cs.map((c) => (c.until === undefined ? `${c.since}` : `${c.since}:${c.until}`)).join(",");

/** payout.no_rail (critical event; the stuck review's S-H1 monitor rule): a front-door Redeemed stored for the first time
 * whose block lies in a closure of the vault's primary bridge the monitor saw (meta RAIL_CLOSED_SINCE, kept by this rule
 * from payoutRailClosedOf: from the first reading that saw it closed to the first that saw it open again). Since R4 the
 * vault defers every door redeem while its primary's canSendPayouts() reads false, and since R6 (claim D) while its
 * primary is disabled, so a burn then means that guard didn't hold: the primary has no such view (the vault reads that as
 * open), its view needed more than the vault's 150,000 gas, the vault is a build from before R6 (a disabled primary did
 * not defer), or the monitor and the vault read different bridges. Its payout can't be sent through that bridge. One alert per delivery key.
 * rail.payouts_closed, a critical condition, already names every queued batch while the rail is closed (a burn's batch
 * among them), so this rule adds only the burn the vault should have deferred; both are critical, so no hold mutes
 * either. A Redeemed from before the first closed reading isn't judged one (the close may have come after it). A closure
 * that ended is kept until the scan's settled block passes its end, so a burn inside it whose log is stored late (the
 * scan behind the readings) is still caught (the review's M4). While the view is unread the closures are left as they
 * are. */
export const payoutNoRail: Rule = {
  name: "payout.no_rail",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const r = ctx.snap.bittensor;
    const closed = payoutRailClosedOf(r?.state);
    const before = closuresOf(ctx.meta[RAIL_CLOSED_SINCE]);
    const list = before.map((c) => ({ ...c }));
    const last = list[list.length - 1];
    const open = last !== undefined && last.until === undefined;
    // first seen closed at this reading: a burn from here on is the guard's failure; first seen open again: its end
    if (closed === true && !open && r) list.push({ since: r.block });
    else if (closed === false && open && r) last.until = r.block;
    if (closed === undefined) unjudged(ctx, "payout.no_rail");
    const within = (b: bigint) => list.find((c) => b >= c.since && (c.until === undefined || b < c.until));
    const burned = new Map<Hex, StoredLog[]>();
    for (const l of ctx.logs.range("bittensor", "vault", "Redeemed")) {
      if (!isNew(ctx, l) || !within(l.block)) continue;
      const key = lower(String(l.args.key));
      burned.set(key, [...(burned.get(key) ?? []), l]);
    }
    // a closure that ended goes once the scan's settled block passes its end: every log inside it is stored by then
    const kept = list.filter((c) => c.until === undefined || c.until > ctx.settled.bittensor.block);
    if (closuresText(kept) !== closuresText(before)) ctx.writes.meta.push({ k: RAIL_CLOSED_SINCE, v: closuresText(kept) });
    const s = r?.state;
    return [...burned].flatMap(([key, ls]) => {
      const c = within(ls[0].block) as Closure;
      return one("payout.no_rail", `payout.no_rail:${key}`, "Front-door redeems were burned while the vault's bridge can't send payouts", {
        key,
        "redeems burned": `${ls.length}, ${tao(ls.reduce((t, l) => t + BigInt(String(l.args.assets)), 0n))}`,
        "the vault's primary bridge": s?.primaryBridge ? lower(s.primaryBridge) : "not read",
        "closed since": `block ${c.since}`,
        ...(c.until !== undefined ? { "reopened at": `block ${c.until}` } : {}),
        ...(s ? { why: closedWhy(s) } : {}),
        transaction: txLink("bittensor", ls[0].txHash),
      });
    });
  },
};

/** payout.bounces_stranded (critical condition, S-L4): a queued payout batch whose entries left are bounces alone (no
 * cancel re-mints a bounce: it is owed TAO, and waits to be paid) while the launch door isn't Active on the vault, or the
 * vault's primary bridge is disabled: it can't be paid until they are back, and has no other exit. */
export const payoutBouncesStranded: Rule = {
  name: "payout.bounces_stranded",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const s = ctx.snap.bittensor?.state;
    if (!s || s.doorState === undefined || s.primaryBridge === undefined) return unjudged(ctx, "payout.bounces_stranded", "payout.bounces_stranded");
    const primaryOff = s.rails?.[lower(s.primaryBridge)]?.enabled === false;
    const doorGone = s.doorState !== 1;
    if (!primaryOff && !doorGone) return [];
    const logs = ctx.logs.range("bittensor", "vault", QUEUE_EVENTS);
    return ctx.pendingPayoutKeys.flatMap((key) => {
      const p = s.payoutBatches[key];
      const left = entriesLeft(logs, key);
      if (!p || !left) return unjudged(ctx, "payout.bounces_stranded", `payout.bounces_stranded:${key}`);
      if (p.count <= p.cursor) return [];
      if (!left.length || left.some((x) => x.shares !== 0n)) return [];
      return one("payout.bounces_stranded", `payout.bounces_stranded:${key}`, "A payout batch of bounces alone waits on a door or bridge that is going: a bounce can't be cancelled", {
        key,
        bounces: `${left.length}, ${tao(left.reduce((t, x) => t + x.assets, 0n))}`,
        why: [doorGone ? "the launch door isn't Active on the vault" : "", primaryOff ? `the vault's primary bridge ${s.primaryBridge} is disabled` : ""].filter(Boolean).join("; "),
      });
    });
  },
};

/** Bittensor's seconds a block this tick (measured from the readings, src/blocktime.ts), else its 12 s: the measure is only
 * unread on a first tick, where an estimate beats none. */
const bitS = (ctx: Pick<RuleCtx, "blockS">) => ctx.blockS.bittensor ?? BITTENSOR_BLOCK_S;
/** The door hold's day (the vault's STAKE_RAMP) in Bittensor blocks at `blockS` seconds a block: a RedeemDeferred whose
 * holder minted within it was deferred by the hold (spec §3.5: off-chain code tells a hold from an allowance deferral by
 * "the holder's last Deposited with shares or DepositedDirect before it"). By blocks, not times: the hold's clock is the
 * share-weighted mean of the mints anyway (S-L3), so this is the pattern's measure, not the contract's. */
export const holdBlocks = (blockS: number) => blocksIn(STAKE_RAMP_S, blockS);
/** Two holds: the spec's residual (§3.5) crowds the first-come allowance by depositing one day and unstaking the next, so
 * its burn lands within a day after the hold ends (the request's batch closes within the interval, an hour at launch, and
 * delivers in minutes). */
export const washBlocks = (blockS: number) => 2n * holdBlocks(blockS);

/** The prefetch loads the Deposited and DepositedDirect of this tick's new Redeemed and RedeemDeferred holders from this
 * far back (two holds and two hours more), in Bittensor's blocks at its block time. */
export const WASH_LOOKBACK_S = 2 * STAKE_RAMP_S + 7_200;

const hoursOf = (blocks: bigint, blockS: number) => Math.round((Number(blocks) * blockS) / 3_600);

/** The holder's last mint before a vault unstake log `x` (Redeemed or RedeemDeferred): a Deposited with shares under
 * the same key (credited in the same delivery, before its burns: `same`), else the last Deposited or DepositedDirect
 * with shares at most `window` blocks before it, in the loaded logs (the prefetch loads them for this tick's unstakes). */
function lastMint(ctx: RuleCtx, x: StoredLog, window: bigint): { mint: StoredLog; same: boolean } | undefined {
  const user = lower(String(x.args.user));
  const key = lower(String(x.args.key));
  const mine = ctx.logs.range("bittensor", "vault", ["Deposited", "DepositedDirect"]).filter((m) => BigInt(String(m.args.shares ?? "0")) > 0n && lower(String(m.args.user)) === user);
  const same = mine.find((m) => m.event === "Deposited" && lower(String(m.args.key)) === key);
  if (same) return { mint: same, same: true };
  const before = mine.filter((m) => (m.block < x.block || (m.block === x.block && m.logIndex < x.logIndex)) && x.block - m.block <= window);
  return before.length ? { mint: before[before.length - 1], same: false } : undefined;
}

/** The likely cause of a v3.2 RedeemDeferred, which names none (R4 added two to the allowance and the minimum), from what
 * is cheap to tell: the vault's primary bridge reading closed now (rail.payouts_closed: every door redeem deferred);
 * the holder's mint within the hold's day before it (the spec's own test: its last Deposited with shares or
 * DepositedDirect); the request worth less than MIN_REDEEM_VALUE at the price read; else the day's allowance or the entry
 * limit, which would need the window's reading at its block to tell apart, so both are named. A likely cause only, for
 * the founder's email (the site tells the causes apart at the delivery's block, exit-hold.ts): looser than the contract's
 * order (a mint within the day reads as the hold even when older shares were enough and the allowance deferred it), the
 * rail judged by this tick's reading rather than the delivery's, and the mints looked for only as far back as the
 * prefetch loads them (WASH_LOOKBACK_S from the scan's settled block, so less of the day during a catch-up). */
export function deferralWhy(ctx: RuleCtx, l: StoredLog): string {
  const s = ctx.snap.bittensor?.state;
  if (payoutRailClosedOf(s)) return "the vault's bridge can't send payouts now (rail.payouts_closed): every front-door redeem is deferred meanwhile";
  const held = lastMint(ctx, l, holdBlocks(bitS(ctx)));
  if (held) return `the one-day hold: the holder deposited ${held.same ? "in the same batch" : `about ${hoursOf(l.block - held.mint.block, bitS(ctx))} hours before`}`;
  const requested = BigInt(String(l.args.requested ?? "0"));
  if (s?.price !== undefined && (requested * s.price) / 10n ** 18n < MIN_REDEEM_VALUE_RAO * RAO) return "the request was worth less than the 0.03 TAO minimum at the price read";
  return "the day's unstake allowance or the entry limit spent (the event names no cause; see outflow.near_limit)";
}

/** unstakes.wash (warning event; R4-K's monitor rule for B-H1): a front-door Redeemed, or a RedeemDeferred, stored for
 * the first time whose holder has a Deposited with shares under the same key (credited in the same delivery, before the
 * burn), or a Deposited or DepositedDirect within the window before it: the hold's day (holdBlocks) for a deferral, which
 * the hold then deferred (the zero-exposure wash refused, or an honest early unstake), two for a burn (washBlocks), which
 * took shares held a day (older shares only, in one batch). The wash itself is refused since R4; what is left is the
 * spec's stated residual (§3.5: a day of price exposure on twice the capital can still crowd the allowance, rotating
 * capital and addresses), a liveness cost with no loss, which a stranger or an honest holder trips as easily: a warning
 * that never holds. One alert per unstake log. v3.2 only. */
export const unstakesWash: Rule = {
  name: "unstakes.wash",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const baseline = ctx.cfg.deployment.bittensor.baselineBlock;
    const exits = ctx.logs.range("bittensor", "vault", ["Redeemed", "RedeemDeferred"]).filter((l) => isNew(ctx, l) && l.block > baseline);
    return exits.flatMap((x): Finding[] => {
      const held = x.event === "RedeemDeferred";
      const found = lastMint(ctx, x, held ? holdBlocks(bitS(ctx)) : washBlocks(bitS(ctx)));
      if (!found) return [];
      const { mint: last, same } = found;
      const user = lower(String(x.args.user));
      const key = lower(String(x.args.key));
      const blocks = x.block - last.block;
      const h = hoursOf(blocks, bitS(ctx));
      const subject = held
        ? `A holder's unstake was deferred by the one-day hold: a deposit ${same ? "in the same batch" : `about ${h} hours before it`}`
        : same
          ? "A holder deposited and unstaked in one batch: the pattern that crowds the daily unstake limit"
          : `A holder unstaked about ${h} hours after a deposit: the pattern that crowds the daily unstake limit`;
      return one("unstakes.wash", `unstakes.wash:${x.uid}`, subject, {
        user,
        key,
        "the deposit": `${tao(BigInt(String(last.args.assets)))} (${last.event}) at block ${last.block}`,
        "the unstake": held ? `${String(x.args.requested)} shares asked, nothing burned` : `${tao(BigInt(String(x.args.assets)))} burned`,
        apart: same ? "the same batch" : `about ${h} hours (${blocks} blocks)`,
        transaction: txLink("bittensor", x.txHash),
      });
    });
  },
};

/** stake.add_fee (warning event; the vault-favour review's Low 1), beside stake.removal_fee: a Staked whose measured stake
 * (what the chain added to the hotkey) is more than 1 rao short of the rao staked. stakeIdle books the measured, so the
 * chain's cut of an add is borne by every holder, not the depositor. One alert per transaction, on the tick it is first
 * stored. */
export const stakeAddFee: Rule = {
  name: "stake.add_fee",
  run(ctx) {
    if (ctx.cfg.deployment.version !== "v3.2") return [];
    const out: Finding[] = [];
    const byTx = new Map<Hex, bigint>();
    for (const l of ctx.logs.range("bittensor", "vault", ["Staked"])) {
      if (!isNew(ctx, l) || l.block <= ctx.cfg.deployment.bittensor.baselineBlock) continue;
      const asked = BigInt(String(l.args.rao));
      const got = BigInt(String(l.args.measured));
      if (asked > got + 1n) byTx.set(l.txHash, (byTx.get(l.txHash) ?? 0n) + (asked - got));
    }
    for (const [hash, kept] of byTx) {
      out.push(...one("stake.add_fee", `stake.add_fee:${hash}`, `The chain kept ${tao(kept * RAO)} of a stake add: every holder bears it`, { "the chain kept": tao(kept * RAO), transaction: txLink("bittensor", hash) }));
    }
    return out;
  },
};

export const R4_RULES: Rule[] = [adminStampQuiet, batchDepositsBlocked, batchDepositsFull, batchCancelChurn, capExitsConsumed, stakeMinNearFloor, railPayoutsClosed, payoutNoRail, payoutBouncesStranded, unstakesWash, stakeAddFee];
