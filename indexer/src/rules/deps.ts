import { formatUnits, type Hex, keccak256, toBytes } from "viem";
import { BURNER_ROLE, CCIP_SELECTOR, DEFAULT_ADMIN_ROLE, DEPENDENCY_EVENTS, MINTER_ROLE } from "../abi.ts";
import type { Finding } from "../alerts.ts";
import type { ChainName, DependencyRole } from "../config.ts";
import type { StoredLog } from "../logs.ts";
import type { BaseState, BitState, Bucket, ChainReading } from "../snapshot.ts";
import { addressLink, isNew, onset, type Readings, type RuleCtx, twice, txLink, utc } from "./context.ts";
import type { Rule } from "./index.ts";

// What Cascade depends on and doesn't control (the economics and security review of 2026-10-31): ForeverMoney's rail
// (FM-TAO on Base, wTAO and the AlphaVault on Bittensor, the CCIP token pools between them, all run by ForeverMoney's
// 2-of-3 Safe), the validator the vault stakes with, the chain's root-stake hold, the oracle's pools and the payout
// fee. Each reads only this tick's readings, the readings and hour rows kept, and the logs stored: no request of its
// own (the readings and the watched events cost none either: snapshot.ts, config.ts watchFilters).

const tao = (wei: bigint) => `${formatUnits(wei, 18)} TAO`;
const lc = (x: unknown) => String(x).toLowerCase() as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
const num = (s: string | undefined) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));

/** fmtao.backing_true (critical, holds): the rail under FM-TAO short of what it owes, on two readings of Bittensor.
 * FM-TAO on every lane (Base, Robinhood) is wTAO locked in the lock pool, and wTAO is the AlphaVault's TAO, so:
 * - `alpha`: the AlphaVault's backing(wTAO) below wTAO's supply: every FM-TAO is under-backed;
 * - `lock`: less of wTAO's supply locked in the lock pool than it should be: wTAO has left the pool without FM-TAO
 *   being burned for it (a drain, or a release a forged message asked for). Nearly all wTAO is locked (13,985.61 of
 *   13,985.65 on 2026-10-31): wTAO is bridged as soon as it is minted. This sees the Robinhood lane too, which
 *   fmtao.unbacked (Base's supply against the whole lock) can't.
 * Each is short when it falls below wTAO's supply by more than backingToleranceBps of it (at least
 * fmtaoBackingSlackWei). It holds, on its first tick: a payout sends TAO into this rail. */
export const fmtaoBackingTrue: Rule = {
  name: "fmtao.backing_true",
  run(ctx) {
    const sides: { side: "alpha" | "lock"; have: (s: BitState) => bigint | undefined; what: string }[] = [
      { side: "alpha", have: (s) => s.alpha.backing, what: "The AlphaVault's backing is below wTAO's supply" },
      { side: "lock", have: (s) => s.lockPoolFmTao, what: "wTAO has left the CCIP lock pool" },
    ];
    const out: Finding[] = [];
    for (const x of sides) {
      const short = (s: BitState | undefined) => {
        const supply = s?.wTaoSupply;
        const have = s ? x.have(s) : undefined;
        if (supply === undefined || have === undefined || supply === 0n) return undefined;
        const slack = (supply * BigInt(ctx.t.backingToleranceBps)) / 10_000n;
        return supply - have > (slack > ctx.t.fmtaoBackingSlackWei ? slack : ctx.t.fmtaoBackingSlackWei) ? supply - have : undefined;
      };
      const cond = (r: Readings) => short(r.bittensor) !== undefined;
      if (!twice(ctx, "bittensor", cond)) continue;
      const now = ctx.snap.bittensor!;
      const s = now.state;
      const supply = s.wTaoSupply as bigint;
      const f: Finding = {
        rule: "fmtao.backing_true",
        key: `fmtao.backing_true:${x.side}`,
        subject: `${x.what} by ${tao(short(s) as bigint)}: FM-TAO isn't fully backed`,
        facts: {
          side: x.side,
          "wTAO supply": tao(supply),
          "AlphaVault backing (backing(wTAO))": s.alpha.backing === undefined ? "unknown" : tao(s.alpha.backing),
          "backing / supply": s.alpha.backing === undefined ? "unknown" : pct((s.alpha.backing * 10_000n) / supply),
          "wTAO in the lock pool": s.lockPoolFmTao === undefined ? "unknown" : tao(s.lockPoolFmTao),
          "wTAO outside the lock pool": s.lockPoolFmTao === undefined ? "unknown" : tao(supply - s.lockPoolFmTao),
          tolerance: pct(BigInt(ctx.t.backingToleranceBps)),
          block: String(now.block),
          alphaVault: addressLink("bittensor", ctx.cfg.tokens.bittensor.alphaVault),
          lockPool: addressLink("bittensor", ctx.cfg.tokens.bittensor.lockPool),
        },
      };
      if (onset(ctx, "bittensor", cond)) f.hold = { id: `fmtao.backing_true:${x.side}:${ctx.previous.bittensor!.block}`, summary: `${x.what}: FM-TAO isn't fully backed` };
      out.push(f);
    }
    return out;
  },
};

/** The roles an email names: FM-TAO's (Chainlink BurnMintERC20) and the AlphaVault's (read live). */
const ROLE_NAMES: Record<string, string> = Object.fromEntries(
  [
    [MINTER_ROLE, "MINTER_ROLE"],
    [BURNER_ROLE, "BURNER_ROLE"],
    [DEFAULT_ADMIN_ROLE, "DEFAULT_ADMIN_ROLE"],
    [keccak256(toBytes("GUARDIAN_ROLE")), "GUARDIAN_ROLE"],
    [keccak256(toBytes("OPERATOR_ROLE")), "OPERATOR_ROLE"],
  ].map(([k, v]) => [k.toLowerCase(), v]),
);
const roleName = (r: unknown) => ROLE_NAMES[lc(r)] ?? String(r);

/** How an email names a watched contract on its chain. */
const DEP_NAMES: Record<ChainName, Record<DependencyRole, string>> = {
  base: { fmTao: "FM-TAO (Base)", tokenPool: "FM-TAO's CCIP pool (Base)", alphaVault: "AlphaVault" },
  bittensor: { fmTao: "wTAO (Bittensor)", tokenPool: "the CCIP lock pool (Bittensor)", alphaVault: "AlphaVault (Bittensor)" },
};
const DEP_ROLES: ReadonlySet<string> = new Set<DependencyRole>(["fmTao", "tokenPool", "alphaVault"]);
const EVENT_NAMES: ReadonlySet<string> = new Set(DEPENDENCY_EVENTS.map((e) => e.name));

/** Cascade's lane on each chain's pool: the other chain's selector. */
const OUR_LANE: Record<ChainName, bigint> = { base: CCIP_SELECTOR.bittensor, bittensor: CCIP_SELECTOR.base };

/** A pool's rate-limit config, as the log stores it (JSON). */
const capacityOf = (x: unknown): bigint | undefined => {
  try {
    const c = JSON.parse(String(x)) as { capacity?: string };
    return c.capacity === undefined ? undefined : BigInt(c.capacity);
  } catch {
    return undefined;
  }
};

/** What a watched admin event means, and whether it is critical: a new way to mint or release FM-TAO or wTAO (a
 * MINTER_ROLE grant, a remote pool or lane added, a pool's router changed, the lock pool's liquidity withdrawn), an
 * admin moving (FM-TAO's admin role granted, a role's admin changed, the AlphaVault's admin transfer scheduled, a
 * pool's ownership transfer requested), a lane's bucket set to capacity 0, or Cascade's lane removed. */
function judge(l: StoredLog): { critical: boolean; what: string } {
  const a = l.args;
  switch (l.event) {
    case "RoleGranted": {
      const role = roleName(a.role);
      if (lc(a.role) === MINTER_ROLE.toLowerCase()) return { critical: true, what: `MINTER_ROLE granted to ${a.account}: it can mint` };
      if (lc(a.role) === DEFAULT_ADMIN_ROLE) return { critical: true, what: `the admin role granted to ${a.account}: it can grant itself MINTER_ROLE` };
      return { critical: false, what: `${role} granted to ${a.account}` };
    }
    case "RoleRevoked":
      return { critical: false, what: `${roleName(a.role)} revoked from ${a.account}` };
    case "RoleAdminChanged":
      return { critical: true, what: `the role that administers ${roleName(a.role)} changed to ${roleName(a.newAdminRole)}` };
    case "CCIPAdminTransferred":
      return { critical: false, what: `the CCIP admin moved to ${a.newAdmin}` };
    case "DefaultAdminTransferScheduled":
      return { critical: true, what: `an admin transfer to ${a.newAdmin} is scheduled (acceptable from ${utc(Number(a.acceptSchedule))})` };
    case "DefaultAdminTransferCanceled":
      return { critical: false, what: "a scheduled admin transfer was cancelled" };
    case "DefaultAdminDelayChangeScheduled":
      return { critical: false, what: `the admin transfer delay is to change to ${a.newDelay} seconds (from ${utc(Number(a.effectSchedule))})` };
    case "DefaultAdminDelayChangeCanceled":
      return { critical: false, what: "a scheduled change of the admin transfer delay was cancelled" };
    case "OwnershipTransferRequested":
      return { critical: true, what: `an ownership transfer to ${a.to} is requested` };
    case "OwnershipTransferred":
      return { critical: false, what: `ownership moved to ${a.to}` };
    case "RateLimitAdminSet":
      return { critical: false, what: `the rate-limit admin is now ${a.rateLimitAdmin}` };
    case "ChainAdded":
      return { critical: true, what: `a lane to chain selector ${a.remoteChainSelector} was added: another chain's pool can now ${l.chain === "base" ? "mint FM-TAO" : "release locked wTAO"}` };
    case "ChainConfigured": {
      const zero = [a.outboundRateLimiterConfig, a.inboundRateLimiterConfig].some((c) => capacityOf(c) === 0n);
      return zero
        ? { critical: true, what: `a bucket of the lane to chain selector ${a.remoteChainSelector} was set to capacity 0` }
        : { critical: false, what: `the rate limit of the lane to chain selector ${a.remoteChainSelector} changed` };
    }
    case "ChainRemoved":
      return String(a.remoteChainSelector) === String(OUR_LANE[l.chain])
        ? { critical: true, what: "Cascade's lane was removed from the pool: nothing crosses it any more" }
        : { critical: false, what: `the lane to chain selector ${a.remoteChainSelector} was removed` };
    case "RemotePoolAdded":
      return { critical: true, what: `a remote pool was added for chain selector ${a.remoteChainSelector}: it can now ${l.chain === "base" ? "mint FM-TAO" : "release locked wTAO"}` };
    case "RemotePoolRemoved":
      return { critical: false, what: `a remote pool was removed for chain selector ${a.remoteChainSelector}` };
    case "RouterUpdated":
      return { critical: true, what: `the pool's router changed to ${a.newRouter}: the router decides what the pool mints or releases` };
    case "AllowListAdd":
    case "AllowListRemove":
      return { critical: false, what: `the pool's allow list changed (${a.sender})` };
    case "LiquidityRemoved":
      return { critical: true, what: `${tao(BigInt(String(a.amount)))} of locked wTAO withdrawn by ${a.provider}` };
    case "LiquidityTransferred":
      return { critical: false, what: `${tao(BigInt(String(a.amount)))} of liquidity moved in from ${a.from}` };
    default:
      return { critical: false, what: l.event };
  }
}

/** fmtao.role_change_critical and fmtao.role_change: each admin event of ForeverMoney's watched contracts (FM-TAO,
 * wTAO, the two CCIP pools, the AlphaVault: config.ts watchFilters), on the tick it is first stored, after the
 * deployment's baseline. Critical as `judge` says; a warning otherwise. Never a hold: a role change alone moves no
 * TAO (fmtao.backing_true holds once one does). */
export const fmtaoRoleChange: Rule = {
  name: "fmtao.role_change",
  run(ctx) {
    const out: Finding[] = [];
    for (const l of ctx.logs.all()) {
      if (!DEP_ROLES.has(l.contract) || !EVENT_NAMES.has(l.event) || !isNew(ctx, l)) continue;
      if (l.block <= ctx.cfg.deployment[l.chain].baselineBlock) continue;
      const j = judge(l);
      const rule = j.critical ? "fmtao.role_change_critical" : "fmtao.role_change";
      const name = DEP_NAMES[l.chain][l.contract as DependencyRole];
      const args = Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, String(v)]));
      if ("role" in args) args.role = roleName(l.args.role);
      out.push({
        rule,
        key: `${rule}:${l.uid}`,
        subject: `ForeverMoney's ${name}: ${j.what}`,
        facts: {
          contract: name,
          event: l.event,
          ...args,
          "what it means": j.what,
          sender: ctx.txs.get(`${l.chain}:${l.txHash}`)?.from ?? "not known yet",
          address: addressLink(l.chain, l.address),
          block: String(l.block),
          transaction: txLink(l.chain, l.txHash),
        },
      });
    }
    return out;
  },
};

/** rail.alpha_vault_admin (warning): the AlphaVault has a default admin transfer pending (its admin moves once the
 * schedule passes and the new admin accepts). One alert per new admin while it is pending. */
export const railAlphaVaultAdmin: Rule = {
  name: "rail.alpha_vault_admin",
  run(ctx) {
    const p = ctx.snap.bittensor?.state.alpha.pendingAdmin;
    if (!p || p.admin === ZERO) return [];
    return [
      {
        rule: "rail.alpha_vault_admin",
        key: `rail.alpha_vault_admin:${p.admin}`,
        subject: `ForeverMoney's AlphaVault has an admin transfer pending, to ${p.admin}`,
        facts: { "new admin": p.admin, "it may accept from": utc(p.schedule), alphaVault: addressLink("bittensor", ctx.cfg.tokens.bittensor.alphaVault) },
      },
    ];
  },
};

type Validator = NonNullable<BitState["validator"]>;
const validatorOf = (r: ChainReading<BitState> | undefined): Validator | undefined => r?.state.validator;
const takeText = (t: number | null | undefined) => (t === undefined ? "unknown" : t === null ? "no Delegates entry (not open for delegation)" : `${((t * 100) / 65_535).toFixed(2)}%`);

/** validator.take_changed (warning, once per change) and validator.take_high (critical, while it lasts): the stake
 * hotkey's take (SubtensorModule Delegates, of 65,535) differs from the reading before last and is the same on the
 * last two readings (one bad answer can't trip it); or it is above validatorTakeMaxBps on two readings. 0 at launch. */
export const validatorTake: Rule = {
  name: "validator.take",
  run(ctx) {
    const s = ctx.snap.bittensor;
    const [p, e] = ctx.history.bittensor;
    const out: Finding[] = [];
    const vs = validatorOf(s);
    if (!s || !vs) return out;
    const hk = vs.hotkey;
    const same = (r: ChainReading<BitState> | undefined) => validatorOf(r)?.hotkey === hk;
    const take = (r: ChainReading<BitState> | undefined) => validatorOf(r)?.take;
    if (p && e && same(p) && same(e) && e.block < p.block && p.block < s.block && take(s) !== undefined && take(s) === take(p) && take(e) !== undefined && take(e) !== take(s)) {
      out.push({
        rule: "validator.take_changed",
        key: `validator.take_changed:${hk}:${p.block}`,
        subject: `The validator's take changed: ${takeText(take(e))} → ${takeText(take(s))}`,
        facts: { hotkey: hk, before: takeText(take(e)), after: takeText(take(s)), block: String(p.block), taostats: `https://taostats.io/hotkey/${hk}` },
      });
    }
    const high = (r: Readings) => {
      const v = r.bittensor?.validator;
      return v?.hotkey === hk && typeof v.take === "number" && v.take * 10_000 > ctx.t.validatorTakeMaxBps * 65_535;
    };
    if (twice(ctx, "bittensor", high)) {
      out.push({
        rule: "validator.take_high",
        key: `validator.take_high:${hk}`,
        subject: `The validator's take is ${takeText(vs.take)}, above ${pct(BigInt(ctx.t.validatorTakeMaxBps))}`,
        facts: { hotkey: hk, take: takeText(vs.take), limit: pct(BigInt(ctx.t.validatorTakeMaxBps)), block: String(s.block), taostats: `https://taostats.io/hotkey/${hk}` },
      });
    }
    return out;
  },
};

/** validator.root_stake_drop (warning): the stake on the validator's hotkey on root (everyone's: TotalHotkeyAlpha(hotkey,
 * 0)) more than validatorStakeDropBps below its highest of the last 24 hours (hour rows and readings), on two
 * readings: nominators leaving, a sign of trouble before the rewards show it. */
export const validatorRootStakeDrop: Rule = {
  name: "validator.root_stake_drop",
  run(ctx) {
    const s = ctx.snap.bittensor;
    const vs = validatorOf(s);
    if (!s || vs?.rootStake === undefined) return [];
    const hk = vs.hotkey;
    const since = ctx.nowS - 86_400;
    const highs = [
      ...ctx.hours.filter((h) => h.hour + 3600 > since).map((h) => h.validatorStakeHigh),
      ...ctx.history.bittensor.filter((r) => r.time >= since && validatorOf(r)?.hotkey === hk).map((r) => validatorOf(r)?.rootStake),
      vs.rootStake,
    ].filter((x): x is bigint => x !== undefined);
    const high = highs.reduce((a, b) => (a > b ? a : b));
    const low = (r: Readings) => {
      const v = r.bittensor?.validator;
      return v?.hotkey === hk && v.rootStake !== undefined && high > 0n && (high - v.rootStake) * 10_000n > high * BigInt(ctx.t.validatorStakeDropBps);
    };
    if (!twice(ctx, "bittensor", low)) return [];
    const rao = (x: bigint) => tao(x * 10n ** 9n);
    return [
      {
        rule: "validator.root_stake_drop",
        key: `validator.root_stake_drop:${hk}`,
        subject: `The validator's root stake fell ${pct(((high - vs.rootStake) * 10_000n) / high)} in a day`,
        facts: { hotkey: hk, "root stake": rao(vs.rootStake), "the day's high": rao(high), "below the day's high": pct(((high - vs.rootStake) * 10_000n) / high), block: String(s.block), taostats: `https://taostats.io/hotkey/${hk}` },
      },
    ];
  },
};

/** validator.root_uid_lost (critical): the validator's hotkey has no uid on root (SubtensorModule Uids(0, hotkey)) on two
 * readings, once a uid has been read for it (now, in the readings kept, or remembered in meta root_uid_seen:{hotkey}),
 * so a storage key the chain stops answering can't page from the start. Off root, the hotkey earns no root dividends. */
export const validatorRootUidLost: Rule = {
  name: "validator.root_uid_lost",
  run(ctx) {
    const s = ctx.snap.bittensor;
    const vs = validatorOf(s);
    if (!s || !vs) return [];
    const hk = vs.hotkey;
    const seenKey = `root_uid_seen:${hk}`;
    if (typeof vs.rootUid === "number" && ctx.meta[seenKey] === undefined) ctx.writes.meta.push({ k: seenKey, v: String(vs.rootUid) });
    const seen = ctx.meta[seenKey] !== undefined || ctx.history.bittensor.some((r) => validatorOf(r)?.hotkey === hk && typeof validatorOf(r)?.rootUid === "number");
    const gone = (r: Readings) => r.bittensor?.validator?.hotkey === hk && r.bittensor.validator.rootUid === null;
    if (!seen || !twice(ctx, "bittensor", gone)) return [];
    return [
      {
        rule: "validator.root_uid_lost",
        key: `validator.root_uid_lost:${hk}`,
        subject: "The validator's hotkey is no longer registered on root",
        facts: { hotkey: hk, "uid before": ctx.meta[seenKey] ?? "seen in an earlier reading", block: String(s.block), taostats: `https://taostats.io/hotkey/${hk}` },
      },
    ];
  },
};

/** The four buckets of Cascade's lane: each pool's inbound and outbound. */
const BUCKETS: { chain: ChainName; dir: "inbound" | "outbound"; lane: string; pool: string }[] = [
  { chain: "base", dir: "outbound", lane: "Base → Bittensor (batches)", pool: "FM-TAO's CCIP pool on Base, outbound" },
  { chain: "bittensor", dir: "inbound", lane: "Base → Bittensor (batches)", pool: "the CCIP lock pool on Bittensor, inbound" },
  { chain: "bittensor", dir: "outbound", lane: "Bittensor → Base (payouts)", pool: "the CCIP lock pool on Bittensor, outbound" },
  { chain: "base", dir: "inbound", lane: "Bittensor → Base (payouts)", pool: "FM-TAO's CCIP pool on Base, inbound" },
];

/** ccip.rate_limited (warning): a bucket of Cascade's lane (either pool, either direction) under ccipBucketMinWei for more
 * than ccipRateLimitedS (since: meta rate_limited_since:{chain}:{direction}). A batch or payout bigger than what is
 * left waits for the bucket to refill (0.6 TAO a second, 5,000 TAO at most, read live). A bucket that is off (no
 * limit) never is. A chain without a reading leaves its marks as they are. */
export const ccipRateLimited: Rule = {
  name: "ccip.rate_limited",
  run(ctx) {
    const out: Finding[] = [];
    for (const b of BUCKETS) {
      const r = ctx.snap[b.chain];
      if (!r) continue;
      const bucket = (r.state as BaseState | BitState).lane?.[b.dir] as Bucket | undefined;
      if (!bucket) continue;
      const k = `rate_limited_since:${b.chain}:${b.dir}`;
      const since = num(ctx.meta[k]);
      if (!bucket.isEnabled || bucket.tokens >= ctx.t.ccipBucketMinWei) {
        if (since !== undefined) ctx.writes.meta.push({ k, v: "" });
        continue;
      }
      if (since === undefined) {
        ctx.writes.meta.push({ k, v: String(ctx.nowS) });
        continue;
      }
      if (ctx.nowS - since <= ctx.t.ccipRateLimitedS) continue;
      out.push({
        rule: "ccip.rate_limited",
        key: `ccip.rate_limited:${b.chain}:${b.dir}`,
        subject: `CCIP's rate limit is nearly spent on ${b.lane}: ${tao(bucket.tokens)} left`,
        facts: { lane: b.lane, pool: b.pool, left: tao(bucket.tokens), capacity: tao(bucket.capacity), "refills at": `${formatUnits(bucket.rate, 18)} TAO a second`, since: utc(since), block: String(r.block) },
      });
    }
    return out;
  },
};

/** root.unlock_interval (critical): SubtensorModule's RootStakeUnlockInterval set (above 0) on two readings. Root stake
 * must then sit that many blocks after the last root stake add, remove or claim for its coldkey and hotkey before it
 * can leave root, and anyone can restart that clock on the vault's coldkey with a transfer_stake gift: the vault's
 * unstakes (and so its payouts) can be held off. 0, unset, at launch. */
export const rootUnlockInterval: Rule = {
  name: "root.unlock_interval",
  run(ctx) {
    const set = (r: Readings) => (r.bittensor?.rootUnlockInterval ?? 0n) > 0n;
    if (!twice(ctx, "bittensor", set)) return [];
    const s = ctx.snap.bittensor!;
    const blocks = s.state.rootUnlockInterval as bigint;
    return [
      {
        rule: "root.unlock_interval",
        key: "root.unlock_interval",
        subject: `Bittensor now holds root stake ${blocks} blocks before it can leave root (RootStakeUnlockInterval)`,
        facts: { blocks: String(blocks), about: `${Math.round(Number(blocks) * 12 / 60)} minutes`, block: String(s.block) },
      },
    ];
  },
};

/** oracle.cardinality (warning): a pool the TWAP oracle reads keeps fewer than oracleMinCardinality observations (slot0's
 * observationCardinality) on two readings. The oracle reads 1,800 seconds back: with a swap in every 2-second block,
 * fewer observations than that don't reach back, and usdcValue reverts ("OLD"). It grows to cardinalityNext by itself
 * as swaps write new observations. TAO/WETH kept 600 (growing to 2,000) on 2026-10-31. */
export const oracleCardinality: Rule = {
  name: "oracle.cardinality",
  run(ctx) {
    const out: Finding[] = [];
    for (const [pool, name] of [
      ["taoWeth", "TAO/WETH"],
      ["wethUsdc", "WETH/USDC"],
    ] as const) {
      const of = (s?: BaseState) => (pool === "taoWeth" ? s?.taoWethPool : s?.wethUsdcPool);
      const few = (r: Readings) => {
        const c = of(r.base)?.cardinality;
        return c !== undefined && c < ctx.t.oracleMinCardinality;
      };
      if (!twice(ctx, "base", few)) continue;
      const p = of(ctx.snap.base!.state)!;
      out.push({
        rule: "oracle.cardinality",
        key: `oracle.cardinality:${pool}`,
        subject: `The ${name} pool keeps ${p.cardinality} observations; the TWAP oracle needs ${ctx.t.oracleMinCardinality}`,
        facts: {
          pool: name,
          address: addressLink("base", pool === "taoWeth" ? ctx.cfg.tokens.base.taoWethPool : ctx.cfg.tokens.base.wethUsdcPool),
          observations: String(p.cardinality),
          "growing to": String(p.cardinalityNext ?? "unknown"),
          needed: String(ctx.t.oracleMinCardinality),
          block: String(ctx.snap.base!.block),
        },
      });
    }
    return out;
  },
};

/** oracle.reverted (critical): the front door's oracle's usdcValue reverts on two readings. Deliveries to USDC stop
 * (the keeper can't price a sale); claims of TAO on Base still work. */
export const oracleReverted: Rule = {
  name: "oracle.reverted",
  run(ctx) {
    if (!twice(ctx, "base", (r) => r.base?.oracleReverted === true)) return [];
    const oracle = ctx.snap.base?.state.oracle ?? ctx.cfg.deployment.oracle;
    return [
      {
        rule: "oracle.reverted",
        key: "oracle.reverted",
        subject: "The TWAP oracle reverts: USDC deliveries are blocked",
        facts: { oracle: addressLink("base", oracle), block: String(ctx.snap.base!.block) },
      },
    ];
  },
};

/** payout.fee_ceiling (warning): the primary bridge's fee for a full payout chunk (100 entries, the costliest message)
 * above payoutFeeCeilingPct of the vault's maxFeeAbs, on two readings. The vault refuses a chunk whose fee passes
 * max(its sum × maxFeeBps / 10,000, maxFeeAbs) (FeeTooHigh), so once the fee passes maxFeeAbs, every chunk worth less
 * than fee × 10,000 / maxFeeBps is stuck. 0.0013 TAO against 0.005 (26%) on 2026-10-31. */
export const payoutFeeCeiling: Rule = {
  name: "payout.fee_ceiling",
  run(ctx) {
    const near = (r: Readings) => {
      const s = r.bittensor;
      return s?.payoutFeeQuote !== undefined && s.maxFeeAbs !== undefined && s.maxFeeAbs > 0n && s.payoutFeeQuote * 100n > s.maxFeeAbs * BigInt(ctx.t.payoutFeeCeilingPct);
    };
    if (!twice(ctx, "bittensor", near)) return [];
    const s = ctx.snap.bittensor!.state;
    const fee = s.payoutFeeQuote as bigint;
    const abs = s.maxFeeAbs as bigint;
    const below = s.maxFeeBps ? (fee * 10_000n) / s.maxFeeBps : undefined;
    return [
      {
        rule: "payout.fee_ceiling",
        key: "payout.fee_ceiling",
        subject: `A payout chunk's bridge fee is ${(fee * 100n) / abs}% of the vault's fee ceiling`,
        facts: {
          "quoted fee (100 entries)": tao(fee),
          maxFeeAbs: tao(abs),
          maxFeeBps: s.maxFeeBps === undefined ? "unknown" : String(s.maxFeeBps),
          "share of maxFeeAbs": `${(fee * 100n) / abs}%`,
          "a chunk is refused below": below === undefined ? "unknown" : fee > abs ? `${tao(below)} (now)` : `${tao(below)}, once the fee passes maxFeeAbs`,
          bridge: s.primaryBridge ?? ctx.cfg.deployment.bitAdapter,
          block: String(ctx.snap.bittensor!.block),
        },
      },
    ];
  },
};

export const DEPENDENCY_RULES: Rule[] = [
  fmtaoBackingTrue,
  fmtaoRoleChange,
  railAlphaVaultAdmin,
  validatorTake,
  validatorRootStakeDrop,
  validatorRootUidLost,
  ccipRateLimited,
  rootUnlockInterval,
  oracleCardinality,
  oracleReverted,
  payoutFeeCeiling,
];
