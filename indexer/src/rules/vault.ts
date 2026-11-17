import { formatUnits, type Hex } from "viem";
import { MAX_HOTKEYS, STAKE_RAMP_S } from "../abi.ts";
import type { Finding } from "../alerts.ts";
import type { StoredLog } from "../logs.ts";
import { DIRECT_ORIGIN } from "../origins.ts";
import type { BitState, ChainReading } from "../snapshot.ts";
import { whoIs } from "./admin.ts";
import { isNew, type Readings, type RuleCtx, twice, txLink, unjudged, utc } from "./context.ts";
import type { Rule } from "./index.ts";

// The vault's own actions that aren't admin events but must never pass unseen: stake moved between its hotkeys
// (an owner action), and the direct entry points (depositDirect, redeemDirect, allowFrontDoorRedeems; v3.2's
// setRedeemOrigin), which the launch doesn't offer. And v3.2's stake guard and ledger (spec §3.1): stake missing, a
// surplus not adopted, repeated unstake skips, the chain's minimum stake rising.

const RAO = 10n ** 9n;
const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO`;
const big = (x: unknown) => BigInt(String(x ?? "0"));
const lower = (x: unknown) => String(x).toLowerCase() as Hex;
const v32 = (ctx: RuleCtx) => ctx.cfg.deployment.version === "v3.2";

/** The vault's logs of these events first stored this tick, after the deployment's baseline (its setup). */
function newVaultLogs(ctx: RuleCtx, events: readonly string[]): StoredLog[] {
  return ctx.logs.range("bittensor", "vault", events).filter((l) => isNew(ctx, l) && l.block > ctx.cfg.deployment.bittensor.baselineBlock);
}

const senderOf = (ctx: RuleCtx, l: StoredLog) => ctx.txs.get(`${l.chain}:${l.txHash}`)?.from ?? "not known yet";

/** vault.stake_moved (warning) and vault.stake_moved_unexpected (critical): every StakeMoved. The vault moves
 * stake only onto its stake hotkey (moveStake, removeHotkey: owner only), so a move to a hotkey that isn't the
 * configured one means the stake hotkey was changed first; that, or a move of stakeMoveCriticalRao or more at
 * once, is critical. The transaction is fetched (attribute.ts), so the sender is named. */
export const stakeMoved: Rule = {
  name: "vault.stake_moved",
  raises: ["vault.stake_moved_unexpected"],
  run(ctx) {
    const expected = ctx.cfg.deployment.stakeHotkey;
    return newVaultLogs(ctx, ["StakeMoved"]).map((l): Finding => {
      const to = lower(l.args.to);
      const rao = big(l.args.rao);
      const unexpected = to !== expected;
      const large = rao >= ctx.t.stakeMoveCriticalRao;
      const rule = unexpected || large ? "vault.stake_moved_unexpected" : "vault.stake_moved";
      const amount = tao(rao * RAO);
      const subject = unexpected
        ? `The vault moved ${amount} of stake to a hotkey that isn't the configured stake hotkey`
        : large
          ? `The vault moved ${amount} of stake, at or above the ${tao(ctx.t.stakeMoveCriticalRao * RAO)} alert threshold`
          : `The vault moved ${amount} of stake onto its stake hotkey`;
      return {
        rule,
        key: `${rule}:${l.uid}`,
        subject,
        facts: {
          from: lower(l.args.from),
          to,
          "configured stake hotkey": expected,
          asked: `${rao} rao`,
          moved: `${big(l.args.moved)} rao`,
          sender: senderOf(ctx, l),
          block: String(l.block),
          transaction: txLink(l.chain, l.txHash),
        },
      };
    });
  },
};

/** vault.direct_use (warning) and vault.direct_use_large (critical): every DepositedDirect, RedeemedDirect and
 * FrontDoorRedeemsAllowed (the launch expects none); on v3.2 setRedeemOrigin's RedeemOriginSet replaces the last
 * (ruling A3), and a RedeemedDirect says whether it accepted missing stake. A deposit or redeem of directCriticalWei or
 * more is critical; so is any direct deposit while a hold is on, when the share price is in doubt and a deposit mints
 * at it. The user is msg.sender, named by the event. */
export const directUse: Rule = {
  name: "vault.direct_use",
  raises: ["vault.direct_use_large"],
  run(ctx) {
    const isV32 = v32(ctx);
    return newVaultLogs(ctx, ["DepositedDirect", "RedeemedDirect", isV32 ? "RedeemOriginSet" : "FrontDoorRedeemsAllowed"]).map((l): Finding => {
      const user = lower(l.args.user);
      const base = {
        user,
        hold: ctx.holdActive ? "on" : "off",
        event: `vault ${l.event}`,
        // v3.2's stake guard refuses a direct deposit while stake is missing: the runbook says so (v3-launch's line kept)
        ...(isV32 ? { contracts: "v3.2" } : {}),
        block: String(l.block),
        transaction: txLink(l.chain, l.txHash),
      };
      if (l.event === "FrontDoorRedeemsAllowed") {
        return { rule: "vault.direct_use", key: `vault.direct_use:${l.uid}`, subject: "A direct depositor opted back into front-door redeems", facts: base };
      }
      if (l.event === "RedeemOriginSet") {
        // the holder's own routing (spec §3.4): the chain whose front doors may burn its shares, or none (DIRECT_ORIGIN)
        const chain = String(l.args.chain);
        const base8453 = chain === String(ctx.cfg.deployment.base.chainId);
        const direct = /^\d+$/.test(chain) && BigInt(chain) === DIRECT_ORIGIN;
        const where = direct ? "only directly on Bittensor" : base8453 ? "through Base's front doors" : `through chain ${chain}'s front doors`;
        const origin = direct ? `direct only (${chain})` : base8453 ? `Base (${chain})` : `chain ${chain}`;
        return { rule: "vault.direct_use", key: `vault.direct_use:${l.uid}`, subject: `A holder chose to redeem ${where}`, facts: { ...base, origin } };
      }
      const assets = big(l.args.assets);
      const what = l.event === "DepositedDirect" ? "deposit" : "redeem";
      const large = assets >= ctx.t.directCriticalWei;
      const duringHold = l.event === "DepositedDirect" && ctx.holdActive;
      const rule = large || duringHold ? "vault.direct_use_large" : "vault.direct_use";
      const why = large ? `, at or above the ${tao(ctx.t.directCriticalWei)} alert threshold` : duringHold ? " while a hold is on" : "";
      const flagged: Record<string, string> =
        isV32 && l.event === "RedeemedDirect"
          ? {
              "accepted missing stake":
                String(l.args.acceptedMissing) === "true" ? "yes: paid at the lower of the booked and visible stake (the leaver may be underpaid; the holders who stay never are)" : "no",
            }
          : {};
      return {
        rule,
        key: `${rule}:${l.uid}`,
        subject: `A direct ${what} of ${tao(assets)} at the vault${why}`,
        facts: { ...base, assets: tao(assets), shares: String(big(l.args.shares)), ...flagged },
      };
    });
  },
};

/** vault.stake_adopted (warning event, v3.2): every StakeAdopted. adoptStake (the keeper's, or anyone's once the
 * fallback has passed; at most once a day) booked a surplus of stake (a gift, or stake back after a write-off) into the
 * share price, vesting it on its own drip (Revision 27: the adoption drip, over rewardVesting by the claim schedule's
 * rule; it never restarts the claimed rewards' schedule). Routine, so a warning, emailed once; its transaction is fetched
 * (attribute.ts), so the keeper's call is explained. */
export const stakeAdopted: Rule = {
  name: "vault.stake_adopted",
  run(ctx) {
    return newVaultLogs(ctx, ["StakeAdopted"]).map((l): Finding => {
      const rao = big(l.args.rao);
      return {
        rule: "vault.stake_adopted",
        key: `vault.stake_adopted:${l.uid}`,
        subject: `The vault adopted ${formatUnits(rao, 9)} TAO of stake into the share price`,
        facts: { adopted: `${formatUnits(rao, 9)} TAO (${rao} rao)`, sender: whoIs(ctx, l.chain, ctx.txs.get(`${l.chain}:${l.txHash}`)?.from), block: String(l.block), transaction: txLink(l.chain, l.txHash) },
      };
    });
  },
};

// ---- v3.2: the stake guard and the ledger (spec §3.1) ----

const raoTao = (rao: bigint) => `${formatUnits(rao, 9)} TAO`;
const short = (hk: Hex) => `${hk.slice(0, 10)}…`;
const num = (s: string | undefined) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
const stakeOf = (r: ChainReading<BitState>, hk: Hex) => r.state.stakes[hk] ?? r.state.stakes[Object.keys(r.state.stakes).find((k) => k.toLowerCase() === hk) as Hex];

/** The hotkeys under the vault's coldkey that it doesn't list, each with the stake read on it (above `dust`), in a
 * reading: those SubtensorModule's StakingHotkeys names and those read with stake. None while the set is unknown. */
export function unlistedStakes(r: ChainReading<BitState>, dust: bigint): { hotkey: Hex; rao: bigint }[] {
  if (!r.state.hotkeys) return [];
  const listed = new Set(r.state.hotkeys.map(lower));
  const seen = new Set<Hex>();
  const out: { hotkey: Hex; rao: bigint }[] = [];
  for (const hk of [...(r.state.stakedHotkeys ?? []), ...Object.keys(r.state.stakes)].map(lower)) {
    if (listed.has(hk) || seen.has(hk)) continue;
    seen.add(hk);
    const rao = stakeOf(r, hk);
    if (rao !== undefined && rao > dust) out.push({ hotkey: hk, rao });
  }
  return out;
}

/** What stake.missing remembers from its first tick (meta stake_missing_fell): the block of the reading it compared
 * with (the newest kept that wasn't missing; null when there was none), and each listed hotkey whose stake fell since. */
interface Fell {
  from: string | null;
  fell: { hotkey: Hex; before: string; after: string }[];
}
const FELL_KEY = "stake_missing_fell";
const parseFell = (v: string | undefined): Fell | undefined => {
  if (!v) return undefined;
  try {
    const f = JSON.parse(v) as Fell;
    const ok = (f.from === null || (typeof f.from === "string" && /^\d+$/.test(f.from))) && Array.isArray(f.fell);
    return ok && f.fell.every((x) => typeof x.hotkey === "string" && /^\d+$/.test(x.before) && /^\d+$/.test(x.after)) ? f : undefined;
  } catch {
    return undefined;
  }
};

/** Whether a stranger can list an unlisted position while stake is missing, by its size against the chain's minimum. A
 * stranger may list only a hotkey the vault never listed (lastClaimAt 0, spec §3.1), which the readings don't show for
 * an unlisted one, so a "yes" says so (Task 56's re-review, Minor 1). */
const listable = (rao: bigint, min: bigint | undefined) =>
  min === undefined ? "not known, the chain's minimum isn't read" : rao >= min ? "yes, if the vault never listed it" : `no, below the chain's minimum of ${raoTao(min)}`;

/** The listed hotkeys whose stake fell (by more than dust) between the newest kept reading that wasn't missing and
 * `now`. */
function fellSince(ctx: RuleCtx, now: ChainReading<BitState>): Fell {
  const before = ctx.history.bittensor.find((r) => r.block < now.block && r.state.stakeMissing === false);
  if (!before) return { from: null, fell: [] };
  const fell: Fell["fell"] = [];
  for (const hk of (before.state.hotkeys ?? []).map(lower)) {
    const was = stakeOf(before, hk);
    const is = stakeOf(now, hk);
    if (was !== undefined && is !== undefined && was - is > ctx.t.stakeDustRao) fell.push({ hotkey: hk, before: String(was), after: String(is) });
  }
  return { from: String(before.block), fell };
}

/** stake.missing_small (warning condition, R6: ChatGPT R2 claim E), raised by stake.missing: on two readings in a row the
 * vault reads stake missing (missingStakeRao) above dust (stakeDustRao, the monitor's stake dust: 1,000 rao, a thousand
 * times the chain's one-rao roundings and a thousandth of the vault's 0.001 TAO tolerance floor) while its guard
 * (stakeMissing()) is false: the gap is inside the tolerance, so deposits still mint at min(visible, booked), and if the
 * stake is listed again those minters gain from the holders (at most the gap). Both read from the lens, never the
 * tolerance's formula, which the contracts own. Names where stake sits unlisted. Unjudged while either is unread. */
function missingSmall(ctx: RuleCtx): Finding[] {
  const dust = ctx.t.stakeDustRao;
  const held = twice(ctx, "bittensor", (r: Readings) => {
    const s = r.bittensor;
    if (s?.stakeMissing === undefined || s.missingStakeRao === undefined) return undefined;
    return !s.stakeMissing && s.missingStakeRao > dust;
  });
  if (held === undefined) return unjudged(ctx, "stake.missing_small", "stake.missing_small");
  if (!held) return [];
  const r = ctx.snap.bittensor as ChainReading<BitState>;
  const s = r.state;
  const missing = s.missingStakeRao as bigint;
  const unlisted = unlistedStakes(r, dust);
  return [
    {
      rule: "stake.missing_small",
      key: "stake.missing_small",
      subject: `A little stake is missing: ${raoTao(missing)} of the vault's booked stake isn't on its hotkeys`,
      facts: {
        missing: `${raoTao(missing)} (${missing} rao)`,
        "stake on hotkeys the vault doesn't list": unlisted.length ? unlisted.map((x) => `${x.hotkey}: ${raoTao(x.rao)}`).join("; ") : "none read",
        "booked stake": s.bookedStake === undefined ? "not read" : raoTao(s.bookedStake),
        "visible stake": s.rootStakeRao === undefined ? "not read" : raoTao(s.rootStakeRao),
        "what it means": "inside the vault's tolerance: deposits still mint, at a price that leaves the gap out",
        block: String(r.block),
      },
    },
  ];
}

/** stake.missing (critical condition, v3.2): the vault's stake guard holds on two readings in a row (stakeMissing(): the
 * booked stake its listed hotkeys don't show is beyond the tolerance, spec §3.1; most likely a validator's hotkey
 * swap), naming the hotkey whose stake fell (against the newest kept reading that wasn't missing, remembered from the
 * first tick in meta stake_missing_fell) and where stake now sits unlisted (each position saying whether a stranger can
 * list it: at least the chain's minimum, spec Rev 22). On v3.2 it replaces v3-launch's
 * stake.divergence: the vault guards itself (no mint, no unconsented burn; a delivery parks), so it raises no hold.
 * Unjudged, never quiet, while the guard can't be read (or holds on one reading only). */
export const stakeMissing: Rule = {
  name: "stake.missing",
  raises: ["stake.missing_small"],
  run(ctx) {
    if (!v32(ctx)) return [];
    const small = missingSmall(ctx);
    const held = twice(ctx, "bittensor", (r: Readings) => r.bittensor?.stakeMissing);
    if (held === undefined) return [...small, ...unjudged(ctx, "stake.missing", "stake.missing")];
    if (!held) {
      if (ctx.meta[FELL_KEY]) ctx.writes.meta.push({ k: FELL_KEY, v: "" });
      return small;
    }
    const r = ctx.snap.bittensor as ChainReading<BitState>;
    const s = r.state;
    let fell = parseFell(ctx.meta[FELL_KEY]);
    if (!fell) {
      fell = fellSince(ctx, r);
      ctx.writes.meta.push({ k: FELL_KEY, v: JSON.stringify(fell) });
    }
    const missing = s.missingStakeRao;
    const one = fell.fell.length === 1 ? fell.fell[0] : undefined;
    const subject = one
      ? `Stake is missing: ${raoTao(BigInt(one.before) - BigInt(one.after))} left hotkey ${short(one.hotkey)}`
      : fell.fell.length > 1
        ? `Stake is missing: it left ${fell.fell.length} of the vault's hotkeys`
        : `Stake is missing: ${missing === undefined ? "some" : raoTao(missing)} of the vault's booked stake isn't on its hotkeys`;
    const unlisted = unlistedStakes(r, ctx.t.stakeDustRao);
    const named = one?.hotkey ?? unlisted[0]?.hotkey;
    const facts: Record<string, string> = {
      missing: missing === undefined ? "not read" : `${raoTao(missing)} (${missing} rao)`,
      [fell.fell.length > 1 ? "the hotkeys whose stake fell" : "the hotkey whose stake fell"]: fell.fell.length
        ? fell.fell.map((x) => `${x.hotkey}: ${raoTao(BigInt(x.before))} before, ${raoTao(BigInt(x.after))} now`).join("; ")
        : fell.from === null
          ? "not known: stake was already missing in every reading kept"
          : "none of the listed hotkeys fell by more than dust",
      ...(fell.from !== null ? { "compared with block": fell.from } : {}),
      // I-6's way back (CascadeHotkeyLib.add): while stake is missing a stranger may list a hotkey holding at least the
      // chain's minimum (and never listed before); a smaller position only the owner, guardian or keeper can
      "stake on hotkeys the vault doesn't list": unlisted.length ? unlisted.map((x) => `${x.hotkey}: ${raoTao(x.rao)} (a stranger can list it: ${listable(x.rao, s.minStakeRao)})`).join("; ") : "none read",
      ...(s.unlistedStakeRao !== undefined ? { "unlisted on the vault's coldkey": `${raoTao(s.unlistedStakeRao)} (unlistedStakeRao)` } : {}),
      "booked stake": s.bookedStake === undefined ? "not read" : raoTao(s.bookedStake),
      "visible stake": s.rootStakeRao === undefined ? "not read" : raoTao(s.rootStakeRao),
      "hotkey set": s.hotkeys ? `${s.hotkeys.length} of ${MAX_HOTKEYS}` : "not read",
      "what stops": "deposits (a batch parks in the Bittensor adapter, a direct deposit reverts), a direct redeem that doesn't accept it, and the reward cut",
      block: String(r.block),
      ...(named ? { taostats: `https://taostats.io/hotkey/${named}` } : {}),
    };
    return [{ rule: "stake.missing", key: "stake.missing", subject, facts }];
  },
};

/** A length of time, in minutes up to two hours, in hours up to two days, else in days. */
const duration = (s: number) => (s < 7200 ? `${Math.floor(s / 60)} minutes` : s < 2 * 86_400 ? `${Math.floor(s / 3600)} hours` : `${Math.floor(s / 86_400)} days`);

/** adoptStake waits STAKE_RAMP between adoptions; the keeper is given this long beyond it before a surplus counts as
 * waiting on it. */
const ADOPT_GRACE_S = 3600;

/** stake.surplus_unadopted (warning condition, v3.2): the vault holds stake beyond its books (surplusStakeRao: a gift
 * onto its hotkeys, or stake back after a write-off) of at least the chain's minimum (adoptStake's own floor) for more
 * than surplusUnadoptedS (since: meta surplus_since), while adoption is allowed (STAKE_RAMP since the last one, and an
 * hour more for the keeper's round): the keeper isn't adopting. Time the vault is paused isn't counted (adoptStake is
 * whenNotPaused, CascadeVault.sol:732; Task 56's review, Minor 7): meta surplus_paused_at is when the pause was first
 * seen, and surplus_paused_s the paused time already left out. Unjudged while either amount, or the pause, is unread. */
export const stakeSurplusUnadopted: Rule = {
  name: "stake.surplus_unadopted",
  run(ctx) {
    if (!v32(ctx)) return [];
    const r = ctx.snap.bittensor;
    const s = r?.state;
    if (!r || s?.surplusStakeRao === undefined || s.minStakeRao === undefined || s.paused === undefined) return unjudged(ctx, "stake.surplus_unadopted", "stake.surplus_unadopted");
    const k = "surplus_since";
    const kPausedAt = "surplus_paused_at";
    const kPausedS = "surplus_paused_s";
    const since = num(ctx.meta[k]);
    let pausedAt = num(ctx.meta[kPausedAt]);
    let pausedS = num(ctx.meta[kPausedS]) ?? 0;
    if (s.surplusStakeRao < s.minStakeRao) {
      for (const key of [k, kPausedS, kPausedAt]) if (ctx.meta[key]) ctx.writes.meta.push({ k: key, v: "" });
      return [];
    }
    if (s.paused && pausedAt === undefined) {
      pausedAt = ctx.nowS;
      ctx.writes.meta.push({ k: kPausedAt, v: String(pausedAt) });
    } else if (!s.paused && pausedAt !== undefined) {
      // the pause ended: its time is left out from now on
      pausedS += Math.max(0, ctx.nowS - pausedAt);
      pausedAt = undefined;
      ctx.writes.meta.push({ k: kPausedS, v: String(pausedS) }, { k: kPausedAt, v: "" });
    }
    if (since === undefined) {
      ctx.writes.meta.push({ k, v: String(ctx.nowS) });
      return [];
    }
    // counted: from its first sight to now, or to the pause on now, less the pauses that ended
    if ((pausedAt ?? ctx.nowS) - since - pausedS <= ctx.t.surplusUnadoptedS) return [];
    if (s.lastAdoptAt !== undefined && s.lastAdoptAt > 0 && r.time - (s.lastAdoptAt + STAKE_RAMP_S) <= ADOPT_GRACE_S) return [];
    return [
      {
        rule: "stake.surplus_unadopted",
        key: "stake.surplus_unadopted",
        subject: `${raoTao(s.surplusStakeRao)} of stake has waited more than a day to be adopted into the share price`,
        facts: {
          surplus: raoTao(s.surplusStakeRao),
          "the chain's minimum": raoTao(s.minStakeRao),
          since: utc(since),
          ...(pausedS > 0 || pausedAt !== undefined ? { "not counted": `${duration(pausedS + (pausedAt === undefined ? 0 : ctx.nowS - pausedAt))} while the vault was paused` } : {}),
          "last adopted": s.lastAdoptAt === undefined ? "not read" : s.lastAdoptAt === 0 ? "never" : utc(s.lastAdoptAt),
          "booked stake": s.bookedStake === undefined ? "not read" : raoTao(s.bookedStake),
          "visible stake": s.rootStakeRao === undefined ? "not read" : raoTao(s.rootStakeRao),
        },
      },
    ];
  },
};

/** Each hotkey's UnstakeSkipped times within unstakeSkippedS (meta unstake_skips). */
const SKIPS_KEY = "unstake_skips";
const parseSkips = (v: string | undefined): Record<string, number[]> => {
  if (!v) return {};
  try {
    const m = JSON.parse(v) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(m).filter(([, t]) => Array.isArray(t) && t.every((x) => Number.isFinite(x)))) as Record<string, number[]>;
  } catch {
    return {};
  }
};

/** stake.unstake_skipped (warning condition, v3.2): the unstake walk skipped one hotkey (UnstakeSkipped: the chain
 * refused its removal, a root hold on the pair above all, or it burned its gas share, spec §3.8) unstakeSkippedCount
 * times or more within unstakeSkippedS, by the skips' block times (meta unstake_skips). One skip is the walk doing its
 * job; repeated ones mean the hotkey's stake can't leave. Clears as the skips age out. */
export const stakeUnstakeSkipped: Rule = {
  name: "stake.unstake_skipped",
  run(ctx) {
    if (!v32(ctx)) return [];
    const now: Record<string, number[]> = {};
    for (const [hk, ts] of Object.entries(parseSkips(ctx.meta[SKIPS_KEY]))) now[hk] = [...ts];
    for (const l of newVaultLogs(ctx, ["UnstakeSkipped"])) (now[lower(l.args.hotkey)] ??= []).push(ctx.blockTime("bittensor", l.block) ?? ctx.nowS);
    const from = ctx.nowS - ctx.t.unstakeSkippedS;
    for (const hk of Object.keys(now)) {
      now[hk] = now[hk].filter((t) => t > from).sort((a, b) => a - b);
      if (!now[hk].length) delete now[hk];
    }
    const v = Object.keys(now).length ? JSON.stringify(now) : "";
    if (v !== (ctx.meta[SKIPS_KEY] ?? "")) ctx.writes.meta.push({ k: SKIPS_KEY, v });
    const hold = ctx.snap.bittensor?.state.rootUnlockInterval;
    return Object.entries(now)
      .filter(([, ts]) => ts.length >= ctx.t.unstakeSkippedCount)
      .map(([hk, ts]): Finding => ({
        rule: "stake.unstake_skipped",
        key: `stake.unstake_skipped:${hk}`,
        subject: `The vault's unstake skipped hotkey ${short(hk as Hex)} ${ts.length} times in a day`,
        facts: {
          hotkey: hk,
          skips: `${ts.length} in the last ${Math.round(ctx.t.unstakeSkippedS / 3600)} hours`,
          "the last": utc(ts[ts.length - 1]),
          "the chain's root stake hold": hold === undefined ? "not read" : hold === 0n ? "none (RootStakeUnlockInterval 0)" : `${hold} blocks (RootStakeUnlockInterval)`,
          taostats: `https://taostats.io/hotkey/${hk}`,
        },
      }));
  },
};

/** The last minimum stake stake.min_raised knows (meta min_stake_known): its rao, and the block it was first read at. */
const KNOWN_MIN_KEY = "min_stake_known";
const parseKnownMin = (v: string | undefined): { rao: bigint; block: bigint } | undefined => {
  if (!v) return undefined;
  try {
    const m = JSON.parse(v) as { rao: unknown; block: unknown };
    return typeof m.rao === "string" && /^\d+$/.test(m.rao) && typeof m.block === "string" && /^\d+$/.test(m.block) ? { rao: BigInt(m.rao), block: BigInt(m.block) } : undefined;
  } catch {
    return undefined;
  }
};

/** stake.min_raised (warning event, v3.2): the chain's minimum stake (the vault's minStakeRao(): the precompile's
 * DefaultMinStake, or the fallback) rose. The unstake walk neither counts nor tries a position below it, and after a
 * swap a stranger may list the new hotkey only while it holds at least the minimum (I-6's way back), so a smaller
 * swapped position is cleared only by a gift or by the owner. Names the listed positions now below it. One alert per new
 * minimum. It compares with the last minimum known (meta min_stake_known; before any, the previous reading's), not only
 * the two newest readings, so an unread reading beside the raise can't lose it (Task 56's review, Minor 3). */
export const stakeMinRaised: Rule = {
  name: "stake.min_raised",
  run(ctx) {
    if (!v32(ctx)) return [];
    const r = ctx.snap.bittensor;
    const now = r?.state.minStakeRao;
    if (!r || now === undefined) return [];
    const p = ctx.previous.bittensor;
    const stored = parseKnownMin(ctx.meta[KNOWN_MIN_KEY]);
    const known = stored ?? (p && p.state.minStakeRao !== undefined ? { rao: p.state.minStakeRao, block: p.block } : undefined);
    // a reading not newer than the minimum known (a node answering from an older head) judges nothing
    if (known && known.block >= r.block) return [];
    if (stored?.rao !== now) ctx.writes.meta.push({ k: KNOWN_MIN_KEY, v: JSON.stringify({ rao: String(now), block: String(r.block) }) });
    if (!known || now <= known.rao) return [];
    const was = known.rao;
    // from: the newest reading kept that still showed the earlier minimum, else the block it was first read at
    const from = ctx.history.bittensor.find((x) => x.block < r.block && x.state.minStakeRao === was)?.block ?? known.block;
    const below = (r.state.hotkeys ?? []).map(lower).flatMap((hk) => {
      const rao = stakeOf(r, hk);
      return rao !== undefined && rao > 0n && rao < now ? [`${hk}: ${raoTao(rao)}`] : [];
    });
    return [
      {
        rule: "stake.min_raised",
        key: `stake.min_raised:${now}`,
        subject: `Bittensor's minimum stake rose from ${raoTao(was)} to ${raoTao(now)}`,
        facts: { before: raoTao(was), after: raoTao(now), "listed positions below it": below.length ? below.join("; ") : "none", from: String(from), to: String(r.block) },
      },
    ];
  },
};

/** SHORTFALL_TOLERANCE_RAO (CascadeVault.sol, 1,000 rao) in wei: the most of an exit's value its walk may leave untaken,
 * which a direct exit's ShortfallAbsorbed counts beside the chain's cost. */
const SHORTFALL_TOLERANCE_WEI = 1_000n * RAO;

/** stake.removal_fee (warning event, v3.2): the chain kept part of a root unstake, a removal fee (root's is 0 today;
 * the founder's ruling of 2026-11-06: the leaver pays it, never the holders). It fires only on a figure that can be
 * nothing but the chain's (Task 57's review, Important 1): a payout chunk's PayoutChunkSent.unstakeCost above zero (the
 * chain's cut of its walk, whole rao); an Unstaked receipt short of what it asked (receivedWei below wantRao × 1e9:
 * the chain kept the rest); or a direct exit's ShortfallAbsorbed above SHORTFALL_TOLERANCE (1,000 rao), since what its
 * walk leaves untaken is at most that, so the excess is the chain's cost. A ShortfallAbsorbed within it is a fact only:
 * an exit within 1,000 rao of what was liquid runs no walk at all (CascadeStakeLib.sol:77) and still logs its untaken
 * part. One alert per transaction, on the tick its logs are first stored; the web then quotes the fee (Tasks 58, 59). */
export const stakeRemovalFee: Rule = {
  name: "stake.removal_fee",
  run(ctx) {
    if (!v32(ctx)) return [];
    const byTx = new Map<Hex, StoredLog[]>();
    for (const l of newVaultLogs(ctx, ["PayoutChunkSent", "ShortfallAbsorbed", "Unstaked"])) byTx.set(l.txHash, [...(byTx.get(l.txHash) ?? []), l]);
    const out: Finding[] = [];
    for (const [hash, logs] of byTx) {
      const total = (event: string, f: (l: StoredLog) => bigint) => logs.filter((l) => l.event === event).reduce((t, l) => t + f(l), 0n);
      const kept = total("Unstaked", (l) => {
        const want = big(l.args.wantRao) * RAO;
        const got = big(l.args.receivedWei);
        return want > got ? want - got : 0n;
      });
      const chunkCost = total("PayoutChunkSent", (l) => big(l.args.unstakeCost));
      const borne = total("ShortfallAbsorbed", (l) => big(l.args.amount));
      if (chunkCost === 0n && kept === 0n && borne <= SHORTFALL_TOLERANCE_WEI) continue;
      const from = [chunkCost > 0n ? "a payout chunk's unstake (PayoutChunkSent.unstakeCost)" : "", borne > 0n ? "a direct exit (ShortfallAbsorbed)" : ""].filter(Boolean);
      const facts: Record<string, string> = {
        "the chain kept": chunkCost > 0n ? tao(chunkCost) : kept > 0n ? tao(kept) : `at least ${tao(borne - SHORTFALL_TOLERANCE_WEI)}`,
        from: from.length ? from.join(" and ") : "an unstake's receipts (Unstaked)",
      };
      if (borne > 0n) facts["the leaver bore"] = `${tao(borne)} (at most ${tao(SHORTFALL_TOLERANCE_WEI)} of it what the walk left untaken)`;
      facts["the receipts show the chain kept"] = kept > 0n ? tao(kept) : "nothing";
      Object.assign(facts, { block: String(logs[0].block), transaction: txLink("bittensor", hash) });
      out.push({
        rule: "stake.removal_fee",
        key: `stake.removal_fee:${hash}`,
        subject:
          chunkCost > 0n || kept > 0n
            ? `The chain kept ${facts["the chain kept"]} of an unstake: Bittensor may charge a root removal fee`
            : `A direct exit bore ${tao(borne)} of its unstake's cost: Bittensor may charge a root removal fee`,
        facts,
      });
    }
    return out;
  },
};

/** The vault's cap on the write-off's aggregate read (CascadeFormulas.WRITE_OFF_READ_GAS, R6). */
export const WRITE_OFF_READ_GAS = 45_000_000n;
const gasText = (g: bigint) => g.toLocaleString("en-US");

/** stake.writeoff_read_gas (warning condition, R6: ChatGPT R2 claim C): on two readings in a row the write-off's
 * aggregate read (getTotalColdkeyStakeOnSubnet of the vault's coldkey, the snapshot's eth_estimateGas: writeOffReadGas)
 * costs more than THRESHOLDS writeOffReadGasWarn. Its cost grows with every position on the coldkey, on any subnet, and
 * a dust position under any hotkey the vault ever listed pins it there for good; past WRITE_OFF_READ_GAS the vault's
 * own WriteOffTooLarge check fails open. Unjudged while it is unread. */
export const writeOffReadGas: Rule = {
  name: "stake.writeoff_read_gas",
  run(ctx) {
    if (!v32(ctx)) return [];
    const warnAt = ctx.t.writeOffReadGasWarn;
    const held = twice(ctx, "bittensor", (r: Readings) => (r.bittensor?.writeOffReadGas === undefined ? undefined : r.bittensor.writeOffReadGas > warnAt));
    if (held === undefined) return unjudged(ctx, "stake.writeoff_read_gas", "stake.writeoff_read_gas");
    if (!held) return [];
    const gas = (ctx.snap.bittensor as ChainReading<BitState>).state.writeOffReadGas as bigint;
    return [
      {
        rule: "stake.writeoff_read_gas",
        key: "stake.writeoff_read_gas",
        subject: `The write-off's check of the unlisted stake costs ${gasText(gas)} gas, of the vault's ${gasText(WRITE_OFF_READ_GAS)} cap`,
        facts: {
          "the read's gas now": gasText(gas),
          "the vault's cap (WRITE_OFF_READ_GAS)": gasText(WRITE_OFF_READ_GAS),
          "past the cap": gas > WRITE_OFF_READ_GAS ? "yes: a write-off's bound fails open; pnpm ops execute's check and the guardian's veto are what is left" : "no",
          "warned above": gasText(warnAt),
          block: String((ctx.snap.bittensor as ChainReading<BitState>).block),
        },
      },
    ];
  },
};

/** stake.writeoff_bound_off (critical condition, R11: ChatGPT r3, claim 1): on two readings in a row the vault lens's
 * unlistedStakeRao() reverted in an answered multicall (the snapshot's unlistedStakeFailed). The lens totals the vault's
 * coldkey with the staking precompile's getTotalColdkeyStakeOnSubnet, the read the vault's write-off bound makes; the
 * vault gives it WRITE_OFF_READ_GAS and takes a failure as 0 (its try/catch), so while the read fails a write-off runs
 * with no bound at all. Nothing anyone can do on chain makes it fail today (its cost is far under the cap: the warning
 * stake.writeoff_read_gas watches that), so a revert means the chain changed: most likely a runtime upgrade removed the
 * function or changed what it answers or costs. R12d (L-3): it holds too on a reading whose estimate of that read (the
 * snapshot's writeOffReadGas) is above WRITE_OFF_READ_GAS, though the lens's own uncapped read still answers: the
 * vault's capped read then fails the same way and reads 0 (stake.writeoff_read_gas warns of the climb before it). Unjudged
 * while the read is unread (the lens unchecked or another vault's, no reading) and not priced over the cap. */
export const writeOffBoundOff: Rule = {
  name: "stake.writeoff_bound_off",
  run(ctx) {
    if (!v32(ctx)) return [];
    const overCap = (s: Partial<BitState> | undefined) => s?.writeOffReadGas !== undefined && s.writeOffReadGas > WRITE_OFF_READ_GAS;
    const held = twice(ctx, "bittensor", (r: Readings) => {
      const s = r.bittensor;
      if (s?.unlistedStakeFailed || overCap(s)) return true;
      return s?.unlistedStakeRao === undefined ? undefined : false;
    });
    if (held === undefined) return unjudged(ctx, "stake.writeoff_bound_off");
    if (!held) return [];
    const now = (ctx.snap.bittensor as ChainReading<BitState>).state;
    // the lens's read answering, the bound off by its price alone
    const priced = !now.unlistedStakeFailed && overCap(now);
    return [
      {
        rule: "stake.writeoff_bound_off",
        key: "stake.writeoff_bound_off",
        subject: priced
          ? `The vault's write-off bound is off: its read of the unlisted stake costs ${gasText(now.writeOffReadGas as bigint)} gas, over the vault's ${gasText(WRITE_OFF_READ_GAS)} cap`
          : "The vault's write-off bound can't be read: the lens's read of the unlisted stake fails",
        facts: {
          "the lens read": priced
            ? "unlistedStakeRao() answers, but the read costs more gas than the vault gives it, so the vault's own capped read fails and reads 0"
            : "unlistedStakeRao() reverted (it totals the vault's coldkey with the staking precompile's getTotalColdkeyStakeOnSubnet, as the write-off's bound does)",
          "the read's gas estimate": now.writeOffReadGas === undefined ? "refused by the node too" : `${gasText(now.writeOffReadGas)} gas`,
          "the vault's cap (WRITE_OFF_READ_GAS)": gasText(WRITE_OFF_READ_GAS),
          block: String((ctx.snap.bittensor as ChainReading<BitState>).block),
        },
      },
    ];
  },
};

export const VAULT_RULES: Rule[] = [stakeMoved, directUse, stakeAdopted, stakeMissing, stakeSurplusUnadopted, stakeUnstakeSkipped, stakeMinRaised, stakeRemovalFee, writeOffReadGas, writeOffBoundOff];
