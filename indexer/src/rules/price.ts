import { formatUnits, type Hex } from "viem";
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
 * below the day's high. Keyed by the reading that first showed it. Judged on every three readings in a
 * row that Bittensor is settled past: the vault's rounding logs are stored only once settled, so a newer
 * reading would see honest rounding as unexplained, and settlement can jump two readings in one tick, so
 * judging only the newest triple would skip one. A triple judged again finds the same key and hold id. */
export const priceDrop: Rule = {
  name: "price.drop",
  run(ctx) {
    const rs = series(ctx).filter((r) => r.block <= ctx.settled.bittensor.block);
    const out: Finding[] = [];
    for (let i = 2; i < rs.length; i++) {
      const f = dropIn(ctx, rs[i - 2], rs[i - 1], rs[i]);
      if (f) out.push(f);
    }
    return out;
  },
};

/** A drop from `e` to `p` that `s` confirms, in increasing blocks. */
function dropIn(ctx: RuleCtx, e: ChainReading<BitState>, p: ChainReading<BitState>, s: ChainReading<BitState>): Finding | undefined {
  if (!(e.block < p.block && p.block < s.block)) return undefined;
  const first = unexplainedDrop(ctx, e, p);
  if (first === undefined || unexplainedDrop(ctx, e, s) === undefined) return undefined;
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
  return f;
}

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
    const hk = (s?.state.stakeHotkey ?? ctx.cfg.deployment.stakeHotkey).toLowerCase() as Hex;
    // an owner read is remembered in meta, so an owner gone after the readings that showed it (a monitor
    // started again with readings that never had it) is still found
    const seenKey = `hotkey_owner_seen:${hk}`;
    if (typeof s?.state.hotkeyOwner === "string" && ctx.meta[seenKey] === undefined) ctx.writes.meta.push({ k: seenKey, v: s.state.hotkeyOwner });
    const [p, e] = ctx.history.bittensor;
    if (!s || !p || p.block >= s.block) return [];
    const out: Finding[] = [];
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
    // only once an owner has been read (now, or remembered): a precompile answer we can't decode reads as
    // null on every tick, and must not hold the keeper on the second
    const ownerSeen = ctx.meta[seenKey] !== undefined || ctx.history.bittensor.some((r) => typeof r.state.hotkeyOwner === "string");
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

const tao = (rao: bigint) => `${formatUnits(rao * RAO, 18)} TAO`;

/** The vault coldkey's stake on hotkeys the vault doesn't list, above dust, by hotkey (lowercase); undefined
 * while the reading doesn't know the vault's set (hotkeys(0) failed). */
function unlistedStake(r: ChainReading<BitState>, dust: bigint): Map<Hex, bigint> | undefined {
  if (!r.state.hotkeys) return undefined;
  const listed = new Set(r.state.hotkeys.map((h) => h.toLowerCase()));
  const out = new Map<Hex, bigint>();
  for (const [hk, rao] of Object.entries(r.state.stakes) as [Hex, bigint][]) {
    if (!listed.has(hk.toLowerCase()) && rao > dust) out.set(hk.toLowerCase() as Hex, rao);
  }
  return out;
}

/** stake.divergence (critical, holds): the vault's coldkey holds stake (more than stakeDustRao) on a hotkey the
 * vault doesn't list, on this reading and the previous one (one bad answer can't trip it). The readings ask
 * the staking precompile for the stake on every hotkey the vault lists, the configured stake hotkey and every
 * hotkey SubtensorModule.StakingHotkeys names for the coldkey (snapshot.ts), so this is the vault's own view
 * (rootStakeRao(), which sums its listed hotkeys only, and prices the shares) against the chain's: what a
 * validator's hotkey swap leaves behind (every nominator's stake moved to its new hotkey, the vault's price no
 * longer counting it, so shares mint cheaply until it is re-added with addHotkey), stake moved off a listed
 * hotkey, or the configured stake hotkey removed from the set with stake still on it. Honest operations (stake,
 * unstake, payouts, reward claims and vesting) keep every rao on a listed hotkey, so none of them can raise it.
 * One alert per hotkey while it lasts; the hold is raised once, on the first tick it is confirmed. */
export const stakeDivergence: Rule = {
  name: "stake.divergence",
  run(ctx) {
    const s = ctx.snap.bittensor;
    const p = ctx.previous.bittensor;
    if (!s || !p || p.block >= s.block) return [];
    const now = unlistedStake(s, ctx.t.stakeDustRao);
    const before = unlistedStake(p, ctx.t.stakeDustRao);
    if (!now || !before) return [];
    const e = ctx.history.bittensor[1];
    const earlier = e && e.block < p.block ? unlistedStake(e, ctx.t.stakeDustRao) : undefined;
    const out: Finding[] = [];
    for (const [hk, rao] of now) {
      if (!before.has(hk)) continue;
      const total = Object.values(s.state.stakes).reduce((a, b) => a + b, 0n);
      const f: Finding = {
        rule: "stake.divergence",
        key: `stake.divergence:${hk}`,
        subject: `${tao(rao)} of the vault's stake sits on a hotkey the vault doesn't list`,
        facts: {
          hotkey: hk,
          stake: `${rao} rao (${tao(rao)})`,
          "listed by the vault": s.state.hotkeys?.join(", ") || "none",
          "the vault counts": s.state.rootStakeRao === undefined ? "unknown" : `${s.state.rootStakeRao} rao (${tao(s.state.rootStakeRao)})`,
          "the chain holds for its coldkey": `${total} rao (${tao(total)}) on the ${Object.keys(s.state.stakes).length} hotkeys read`,
          block: String(s.block),
          taostats: `https://taostats.io/hotkey/${hk}`,
        },
      };
      if (!earlier?.has(hk)) f.hold = { id: `stake.divergence:${hk}:${p.block}`, summary: `${tao(rao)} of the vault's stake sits on hotkey ${hk}, which the vault doesn't list` };
      out.push(f);
    }
    return out;
  },
};

export const PRICE_RULES: Rule[] = [priceDrop, stakeUnexplainedDrop, stakeHotkeyChanged, stakeDivergence];
