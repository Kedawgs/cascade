import type { Hex } from "viem";
import type { Finding } from "../alerts.ts";
import type { BitState, ChainReading } from "../snapshot.ts";
import { onset, type Readings, type RuleCtx, twice } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.1: the share price and the stake behind it.

const E18 = 10n ** 18n;
const RAO = 10n ** 9n;
const big = (x: unknown) => BigInt(String(x ?? "0"));
const pos = (x: bigint) => (x > 0n ? x : 0n);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The wei the vault's own events in blocks (from, to] lost to honest rounding: asked minus measured. */
function roundingWei(ctx: RuleCtx, from: bigint, to: bigint): bigint {
  let w = 0n;
  for (const l of ctx.logs.range("bittensor", "vault", ["Staked", "StakeMoved", "Unstaked", "PayoutChunkSent"], from + 1n, to)) {
    const a = l.args;
    if (l.event === "Staked") w += pos(big(a.rao) - big(a.measured)) * RAO;
    else if (l.event === "StakeMoved") w += pos(big(a.rao) - big(a.moved)) * RAO;
    else if (l.event === "Unstaked") w += pos(big(a.wantRao) * RAO - big(a.receivedWei));
    else w += pos(big(a.gross) - big(a.net) - big(a.fee));
  }
  return w;
}

/** How far the price fell from `a` to `b` beyond what honest rounding in between explains (converted
 * to a price change at b's supply, plus priceDropEpsilon of the price); undefined when it didn't. */
function unexplainedDrop(ctx: RuleCtx, a: ChainReading<BitState>, b: ChainReading<BitState>): bigint | undefined {
  const pa = a.state.price;
  const pb = b.state.price;
  const supply = b.state.totalSupply;
  if (pa === undefined || pb === undefined || !supply || pb >= pa || a.block >= b.block) return undefined;
  const explained = ceilDiv(roundingWei(ctx, a.block, b.block) * E18, supply) + 1n;
  const epsilon = BigInt(Math.ceil(Number(pa) * ctx.t.priceDropEpsilon));
  const drop = pa - pb;
  return drop > explained + epsilon ? drop : undefined;
}

/** The highest price of the last 24 hours (hour rows and readings), counting only since the last
 * price.drop hold was cleared: after a human looked, the same drop isn't counted again. */
function dayHigh(ctx: RuleCtx, current: ChainReading<BitState>): bigint | undefined {
  const cleared = Math.max(0, ...ctx.holds.filter((h) => h.rule === "price.drop" && h.clearedAt !== null).map((h) => h.clearedAt as number));
  const since = ctx.nowS - 86400;
  const prices = [
    ...ctx.hours.filter((r) => r.hour + 3600 > since && r.hour >= cleared).map((r) => r.priceHigh),
    ...ctx.history.bittensor.filter((r) => r.time >= since && r.time >= cleared).map((r) => r.state.price),
    current.state.price,
  ].filter((p): p is bigint => p !== undefined);
  return prices.length ? prices.reduce((x, y) => (x > y ? x : y)) : undefined;
}

const bps = (drop: bigint, of: bigint) => (of === 0n ? 0n : (drop * 10_000n) / of);

/** The readings of Bittensor, oldest first: the stored ones and this tick's. */
const series = (ctx: RuleCtx) => [...[...ctx.history.bittensor].reverse(), ...(ctx.snap.bittensor ? [ctx.snap.bittensor] : [])];

/** price.drop: the price fell, between readings from increasing blocks, by more than rounding explains,
 * and the next reading confirms it (it is still down). Holds when the price is holdPriceDropBps or more
 * below the day's high. Keyed by the reading that first showed it. Judged on the newest three readings
 * Bittensor is settled past: the vault's rounding logs are stored only once settled, so a newer reading
 * would see honest rounding as unexplained. */
export const priceDrop: Rule = {
  name: "price.drop",
  run(ctx) {
    const rs = series(ctx);
    let i = rs.length - 1;
    while (i >= 0 && rs[i].block > ctx.settled.bittensor.block) i--;
    if (i < 2) return [];
    const [e, p, s] = [rs[i - 2], rs[i - 1], rs[i]];
    if (!(e.block < p.block && p.block < s.block)) return [];
    const first = unexplainedDrop(ctx, e, p);
    if (first === undefined || unexplainedDrop(ctx, e, s) === undefined) return [];
    const high = dayHigh(ctx, s);
    const now = s.state.price as bigint;
    const below = high === undefined ? 0n : bps(high - now, high);
    const f: Finding = {
      rule: "price.drop",
      key: `price.drop:${p.block}`,
      subject: `The share price fell ${bps(first, e.state.price as bigint)} bps more than rounding explains`,
      facts: {
        from: String(e.block),
        to: String(p.block),
        confirmed: String(s.block),
        before: String(e.state.price),
        after: String(now),
        "below the 24-hour high (bps)": String(below),
        vault: `https://evm.taostats.io/address/${ctx.cfg.deployment.vault}`,
      },
    };
    if (below >= BigInt(ctx.t.holdPriceDropBps)) f.hold = { id: `price.drop:${p.block}`, summary: `the share price is ${below} bps below its 24-hour high, unexplained` };
    return [f];
  },
};

/** The vault events that move a hotkey's stake on purpose, and the arg naming the hotkey they take from. */
const STAKE_MOVES: Readonly<Record<string, string>> = { Unstaked: "hotkey", StakeMoved: "from", HotkeyRemoved: "hotkey" };

/** stake.unexplained_drop: a set hotkey's stake fell by more than stakeDustRao between two readings with
 * no vault Unstaked, StakeMoved (from it) or HotkeyRemoved of that hotkey in those blocks; judged once
 * Bittensor is settled past the later reading. Holds. */
export const stakeUnexplainedDrop: Rule = {
  name: "stake.unexplained_drop",
  run(ctx) {
    const out: Finding[] = [];
    const rs = series(ctx);
    for (let i = 1; i < rs.length; i++) {
      const a = rs[i - 1];
      const b = rs[i];
      if (a.block >= b.block || b.block > ctx.settled.bittensor.block) continue;
      const moves = ctx.logs.range("bittensor", "vault", Object.keys(STAKE_MOVES), a.block + 1n, b.block);
      for (const [hk, was] of Object.entries(a.state.stakes) as [Hex, bigint][]) {
        const now = b.state.stakes[hk];
        if (now === undefined || (a.state.hotkeys && !a.state.hotkeys.includes(hk))) continue;
        if (was - now <= ctx.t.stakeDustRao) continue;
        if (moves.some((l) => String(l.args[STAKE_MOVES[l.event]]).toLowerCase() === hk.toLowerCase())) continue;
        const id = `stake.unexplained_drop:${hk}:${b.block}`;
        out.push({
          rule: "stake.unexplained_drop",
          key: id,
          subject: `${was - now} rao of stake left hotkey ${hk.slice(0, 10)}… with no vault action`,
          facts: { hotkey: hk, from: String(a.block), to: String(b.block), before: `${was} rao`, after: `${now} rao`, taostats: `https://taostats.io/hotkey/${hk}` },
          hold: { id, summary: `stake left hotkey ${hk} without a vault action` },
        });
      }
    }
    return out;
  },
};

/** stake.hotkey_changed: the vault's stake hotkey or hotkey set differs from the last reading; or the
 * stake hotkey's owner in SubtensorModule changed (confirmed by the next reading) or, after an owner was
 * read, vanished on two readings, which holds. */
export const stakeHotkeyChanged: Rule = {
  name: "stake.hotkey_changed",
  run(ctx) {
    const s = ctx.snap.bittensor;
    const [p, e] = ctx.history.bittensor;
    if (!s || !p || p.block >= s.block) return [];
    const out: Finding[] = [];
    const hk = s.state.stakeHotkey ?? ctx.cfg.deployment.stakeHotkey;
    if (s.state.stakeHotkey && p.state.stakeHotkey && s.state.stakeHotkey !== p.state.stakeHotkey) {
      out.push({
        rule: "stake.hotkey_changed",
        key: `stake.hotkey_changed:stake:${s.state.stakeHotkey}`,
        subject: "The vault's stake hotkey changed",
        facts: { before: p.state.stakeHotkey, after: s.state.stakeHotkey, block: String(s.block) },
      });
    }
    const set = (r: ChainReading<BitState>) => (r.state.hotkeys ? [...r.state.hotkeys].sort().join(",") : undefined);
    if (set(s) !== undefined && set(p) !== undefined && set(s) !== set(p)) {
      out.push({
        rule: "stake.hotkey_changed",
        key: `stake.hotkey_changed:set:${s.block}`,
        subject: "The vault's hotkey set changed",
        facts: { before: set(p) as string, after: set(s) as string, block: String(s.block) },
      });
    }
    const ownerGone = (r: Readings) => r.bittensor?.hotkeyOwner === null;
    // only once an owner has been read: a precompile answer we can't decode reads as null on every tick,
    // and must not hold the keeper on the second
    const ownerSeen = ctx.history.bittensor.some((r) => typeof r.state.hotkeyOwner === "string");
    if (ownerSeen && twice(ctx, "bittensor", ownerGone)) {
      // found every tick while it lasts (one alert); the hold is raised once, on its first tick
      const f: Finding = {
        rule: "stake.hotkey_changed",
        key: `stake.hotkey_changed:owner_gone:${hk}`,
        subject: "The stake hotkey has no owner in SubtensorModule any more",
        facts: { hotkey: hk, block: String(s.block), taostats: `https://taostats.io/hotkey/${hk}` },
      };
      if (onset(ctx, "bittensor", ownerGone)) f.hold = { id: `stake.hotkey_changed:owner_gone:${hk}:${p.block}`, summary: `the stake hotkey ${hk} lost its owner` };
      out.push(f);
    }
    const owner = (r?: ChainReading<BitState>) => r?.state.hotkeyOwner;
    if (e && e.block < p.block && owner(s) && owner(s) === owner(p) && owner(e) && owner(e) !== owner(s)) {
      out.push({
        rule: "stake.hotkey_changed",
        key: `stake.hotkey_changed:owner:${hk}:${owner(s)}`,
        subject: "The stake hotkey's owner changed",
        facts: { hotkey: hk, before: owner(e) as string, after: owner(s) as string, block: String(p.block) },
      });
    }
    return out;
  },
};

export const PRICE_RULES: Rule[] = [priceDrop, stakeUnexplainedDrop, stakeHotkeyChanged];
