import { env } from "cloudflare:workers";
import { type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/alerts.ts";
import { BURNER_ROLE, CCIP_SELECTOR, DEFAULT_ADMIN_ROLE, DEPENDENCY_EVENTS, MINTER_ROLE } from "../../src/abi.ts";
import { type Config, rolesOf } from "../../src/config.ts";
import { decode, identify, type StoredLog } from "../../src/logs.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import * as deps from "../../src/rules/deps.ts";
import { RULES } from "../../src/rules/ids.ts";
import type { Rule } from "../../src/rules/index.ts";
import { keeperLowTao, railAlphaVault } from "../../src/rules/ops.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import type { BaseState, BitState, Bucket, ChainReading, HourAgg } from "../../src/snapshot.ts";
import { logOf, upsertLogs } from "../../src/store.ts";
import { REREAD } from "../../src/scan.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { TICK_RULES } from "../../src/tick.ts";
import { wipe } from "./d1-count.ts";
import { rawLog, testConfig } from "./fixtures.ts";
import { baseState, bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";

// The rules on what Cascade depends on and doesn't control: ForeverMoney's rail (FM-TAO, wTAO, the CCIP pools and the
// AlphaVault), the validator, the chain's root-stake hold, the oracle's pools, the keeper's claim and the payout fee.

const E18 = 10n ** 18n;
const NOW = 1_800_000_000;
const cfg = testConfig();
const t = cfg.tokens;
const HK = cfg.deployment.stakeHotkey;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const STRANGER = "0x00000000000000000000000000000000000000bb" as Hex;

const bit = (block: bigint, o: Partial<BitState> = {}, time = NOW): ChainReading<BitState> => reading(block, time, bitState(o));
const base = (block: bigint, o: Partial<BaseState> = {}, time = NOW): ChainReading<BaseState> => reading(block, time, baseState(o));

/** A context with this tick's readings and the earlier ones (newest first). */
function ctx(o: {
  bit?: ChainReading<BitState>;
  base?: ChainReading<BaseState>;
  bitBefore?: ChainReading<BitState>[];
  baseBefore?: ChainReading<BaseState>[];
  meta?: Record<string, string>;
  hours?: HourAgg[];
  logs?: StoredLog[];
  nowS?: number;
  holds?: RuleCtx["holds"];
  cfg?: Config;
}): RuleCtx {
  const c = ruleCtx();
  const history = { base: o.baseBefore ?? [], bittensor: o.bitBefore ?? [] };
  return ruleCtx({
    cfg: o.cfg ?? cfg,
    nowS: o.nowS ?? NOW,
    snap: { ...c.snap, at: o.nowS ?? NOW, base: o.base, bittensor: o.bit },
    previous: { base: history.base[0], bittensor: history.bittensor[0] },
    history,
    meta: o.meta ?? {},
    hours: o.hours ?? [],
    logs: logQuery(o.logs ?? []),
    holds: o.holds ?? [],
    txs: new Map([[`base:${keccak256(toBytes("grant tx"))}`, { chain: "base", hash: keccak256(toBytes("grant tx")), from: STRANGER }]]),
  });
}
const rules = (r: Rule, c: RuleCtx) => r.run(c).map((f) => f.rule);
const keys = (r: Rule, c: RuleCtx) => r.run(c).map((f) => f.key);
const written = (c: RuleCtx) => Object.fromEntries(c.writes.meta.map((w) => [w.k, w.v]));

describe("the dependency rules", () => {
  it("are in the tick, each with its tier and a runbook line that says what to do", () => {
    for (const r of deps.DEPENDENCY_RULES) expect(TICK_RULES).toContain(r);
    expect(RULES["fmtao.backing_true"]).toEqual({ tier: "critical", kind: "condition", canHold: true, mutedByHold: false });
    expect(RULES["fmtao.role_change_critical"]).toMatchObject({ tier: "critical", kind: "event", canHold: false });
    expect(RULES["fmtao.role_change"]).toMatchObject({ tier: "warning", kind: "event" });
    expect(RULES["fmtao.lock_outside"]).toMatchObject({ tier: "warning", kind: "condition", canHold: false });
    expect(RULES["rail.alpha_vault"]).toMatchObject({ tier: "critical", canHold: false });
    expect(RULES["rail.alpha_vault_admin"]).toMatchObject({ tier: "warning", kind: "condition" });
    expect(RULES["validator.take_changed"]).toMatchObject({ tier: "warning", kind: "event" });
    expect(RULES["validator.take_high"]).toMatchObject({ tier: "critical", kind: "condition", canHold: false });
    expect(RULES["validator.root_stake_drop"]).toMatchObject({ tier: "warning", kind: "condition" });
    expect(RULES["validator.root_uid_lost"]).toMatchObject({ tier: "critical", kind: "condition", canHold: false });
    expect(RULES["ccip.rate_limited"]).toMatchObject({ tier: "warning", kind: "condition" });
    expect(RULES["root.unlock_interval"]).toMatchObject({ tier: "critical", kind: "condition", canHold: false });
    expect(RULES["oracle.cardinality"]).toMatchObject({ tier: "warning", kind: "condition" });
    expect(RULES["oracle.reverted"]).toMatchObject({ tier: "critical", kind: "condition", canHold: false });
    expect(RULES["payout.fee_ceiling"]).toMatchObject({ tier: "warning", kind: "condition" });
    for (const id of [
      "fmtao.backing_true",
      "fmtao.lock_outside",
      "fmtao.role_change",
      "fmtao.role_change_critical",
      "rail.alpha_vault_admin",
      "validator.take_changed",
      "validator.take_high",
      "validator.root_stake_drop",
      "validator.root_uid_lost",
      "ccip.rate_limited",
      "root.unlock_interval",
      "oracle.cardinality",
      "oracle.reverted",
      "payout.fee_ceiling",
    ] as const) {
      expect(RUNBOOK[id]({}).length, id).toBeGreaterThan(80);
    }
    // fmtao.unbacked stays, and its runbook names its blind spot
    expect(RUNBOOK["fmtao.unbacked"]({})).toContain("Robinhood");
  });
});

describe("fmtao.backing_true and fmtao.lock_outside", () => {
  // the live rail on 2026-10-31: backing 13,992.86 TAO, wTAO 13,985.65, 13,985.61 of it in the lock pool
  const live = { alpha: { backing: 13_992_856_362_690_000_000_000n }, wTaoSupply: 13_985_652_876_083_000_000_000n, lockPoolFmTao: 13_985_605_961_534_429_495_505n };
  const at = (block: bigint, o: Partial<BitState>) => bit(block, { ...live, ...o, alpha: { ...live.alpha, ...o.alpha } });
  const holding = testConfig({ BACKING_HOLD: "true" });

  it("is quiet on the live rail: backing above wTAO's supply, and nearly all of it locked", () => {
    const c = ctx({ bit: at(11n, {}), bitBefore: [at(10n, {})] });
    expect(deps.fmtaoBackingTrue.run(c)).toEqual([]);
    expect(c.writes.meta).toEqual([]);
  });

  it("finds the AlphaVault's backing below wTAO's supply by more than 0.1%, on two readings: critical, without a hold while BACKING_HOLD is off (the default)", () => {
    const short = { alpha: { backing: (live.wTaoSupply * 9985n) / 10_000n } };
    expect(deps.fmtaoBackingTrue.run(ctx({ bit: at(11n, short), bitBefore: [at(10n, {})] }))).toEqual([]);
    expect(cfg.backingHold).toBe(false);
    const [f] = deps.fmtaoBackingTrue.run(ctx({ bit: at(12n, short), bitBefore: [at(11n, short), at(10n, {})] }));
    expect(f).toMatchObject({ rule: "fmtao.backing_true", key: "fmtao.backing_true:alpha", facts: { hold: "off (BACKING_HOLD is false)" } });
    expect(f.hold).toBeUndefined();
    expect(f.facts["backing / supply"]).toBe("99.85%");
    // within the tolerance (0.05% short): nothing
    const near = { alpha: { backing: (live.wTaoSupply * 9995n) / 10_000n } };
    expect(deps.fmtaoBackingTrue.run(ctx({ bit: at(12n, near), bitBefore: [at(11n, near)] }))).toEqual([]);
  });

  it("holds on the alpha side's first tick once BACKING_HOLD is on, and not again while it lasts", () => {
    const short = { alpha: { backing: (live.wTaoSupply * 9985n) / 10_000n } };
    const [f] = deps.fmtaoBackingTrue.run(ctx({ cfg: holding, bit: at(12n, short), bitBefore: [at(11n, short), at(10n, {})] }));
    expect(f).toMatchObject({ key: "fmtao.backing_true:alpha", hold: { id: "fmtao.backing_true:alpha:11" }, facts: { hold: "on (BACKING_HOLD)" } });
    const later = deps.fmtaoBackingTrue.run(ctx({ cfg: holding, bit: at(13n, short), bitBefore: [at(12n, short), at(11n, short)] }));
    expect(later.map((x) => [x.key, x.hold])).toEqual([["fmtao.backing_true:alpha", undefined]]);
  });

  it("wTAO outside the lock pool: a warning once 100 TAO or more has stayed out an hour, marked in meta; under 100 TAO, or back in, clears it", () => {
    const out = (tao: bigint) => ({ lockPoolFmTao: live.wTaoSupply - tao * E18 });
    // first seen: marked, nothing yet
    const first = ctx({ bit: at(12n, out(150n)) });
    expect(deps.fmtaoBackingTrue.run(first)).toEqual([]);
    expect(written(first)).toEqual({ lock_outside_since: String(NOW) });
    // an hour on, still out: the warning, never a hold
    expect(deps.fmtaoBackingTrue.run(ctx({ bit: at(12n, out(150n)), meta: { lock_outside_since: String(NOW - 3599) } }))).toEqual([]);
    const [f] = deps.fmtaoBackingTrue.run(ctx({ bit: at(12n, out(150n)), meta: { lock_outside_since: String(NOW - 3601) } }));
    expect(f).toMatchObject({ rule: "fmtao.lock_outside", key: "fmtao.lock_outside", facts: { "wTAO outside the lock pool": "150 TAO" } });
    expect(f.hold).toBeUndefined();
    // a stranger's 50 wTAO kept out (anyone can mint it with depositLiquid, simulated live): never marked
    const small = ctx({ bit: at(12n, out(50n)), meta: { lock_outside_since: String(NOW - 7200) } });
    expect(deps.fmtaoBackingTrue.run(small)).toEqual([]);
    expect(written(small)).toEqual({ lock_outside_since: "" });
    // a reading that couldn't read the lock leaves the mark as it is
    const unread = ctx({ bit: bit(12n, { wTaoSupply: live.wTaoSupply }), meta: { lock_outside_since: String(NOW - 7200) } });
    expect(deps.fmtaoBackingTrue.run(unread)).toEqual([]);
    expect(unread.writes.meta).toEqual([]);
  });

  it("escalates to critical when more than 5% of wTAO's supply has stayed outside the lock an hour (its own mark), never with a hold", () => {
    const drained = { lockPoolFmTao: live.wTaoSupply - 1_000n * E18 }; // 7.15%
    const first = ctx({ cfg: holding, bit: at(12n, drained), meta: { lock_outside_since: String(NOW - 7200) } });
    // the warning while the critical's own hour runs
    expect(keys(deps.fmtaoBackingTrue, first)).toEqual(["fmtao.lock_outside"]);
    expect(written(first)).toEqual({ lock_outside_critical_since: String(NOW) });
    const [f, ...rest] = deps.fmtaoBackingTrue.run(ctx({ cfg: holding, bit: at(12n, drained), meta: { lock_outside_since: String(NOW - 7200), lock_outside_critical_since: String(NOW - 3601) } }));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ rule: "fmtao.backing_true", key: "fmtao.backing_true:lock", facts: { "wTAO outside the lock pool": "1000 TAO", "share of wTAO's supply": "7.15%" } });
    expect(f.hold).toBeUndefined();
    // back under 5% (but still over 100 TAO): the critical's mark clears, the warning stands
    const back = ctx({ bit: at(12n, { lockPoolFmTao: live.wTaoSupply - 200n * E18 }), meta: { lock_outside_since: String(NOW - 7200), lock_outside_critical_since: String(NOW - 3601) } });
    expect(keys(deps.fmtaoBackingTrue, back)).toEqual(["fmtao.lock_outside"]);
    expect(written(back)).toEqual({ lock_outside_critical_since: "" });
  });

  it("judges nothing it couldn't read", () => {
    const unread = bit(12n, { wTaoSupply: live.wTaoSupply });
    expect(deps.fmtaoBackingTrue.run(ctx({ bit: unread, bitBefore: [bit(11n, { wTaoSupply: live.wTaoSupply })] }))).toEqual([]);
  });
});

describe("fmtao.role_change", () => {
  const dep = (o: { contract: "fmTao" | "tokenPool" | "alphaVault"; chain: "base" | "bittensor"; event: string; args?: StoredLog["args"]; block?: bigint; tx?: string }) =>
    slog({
      contract: o.contract as StoredLog["contract"],
      chain: o.chain,
      event: o.event,
      args: o.args ?? {},
      block: o.block ?? (o.chain === "base" ? 37_000_500n : 6_900_500n),
      address: o.chain === "base" ? (o.contract === "fmTao" ? t.base.fmTao : t.base.tokenPool) : o.contract === "fmTao" ? t.bittensor.fmTao : o.contract === "tokenPool" ? t.bittensor.lockPool : t.bittensor.alphaVault,
      txHash: keccak256(toBytes(o.tx ?? `${o.event} ${o.block}`)),
    });
  const config = (capacity: bigint, isEnabled = true) => JSON.stringify({ isEnabled, capacity: String(capacity), rate: capacity === 0n ? "0" : "600000000000000000" });
  const judged = (l: StoredLog) => deps.fmtaoRoleChange.run(ctx({ logs: [l] })).map((f) => [f.rule, f.subject]);

  it("a MINTER_ROLE grant on FM-TAO is critical, and names the grantor and the transaction's sender", () => {
    const SAFE = "0xadf60fcc63217961c931d57f1dce2c5d70af3546" as Hex;
    const l = dep({ contract: "fmTao", chain: "base", event: "RoleGranted", args: { role: MINTER_ROLE, account: STRANGER, sender: SAFE }, tx: "grant tx" });
    const [f] = deps.fmtaoRoleChange.run(ctx({ logs: [l] }));
    expect(f).toMatchObject({ rule: "fmtao.role_change_critical", key: `fmtao.role_change_critical:base:${l.txHash}` });
    expect(f.subject).toContain("MINTER_ROLE");
    // the grantor (the event's sender: ForeverMoney's Safe) and who sent the transaction (its from: a signer)
    expect(f.facts).toMatchObject({ contract: "FM-TAO (Base)", role: "MINTER_ROLE", account: STRANGER, sender: SAFE, "sent by": STRANGER });
    expect(f.hold).toBeUndefined();
    expect(RUNBOOK["fmtao.role_change_critical"](f.facts)).toContain("ForeverMoney");
    // pointing TOKENS at a new pool too soon after its setup makes the hourly cross-check call its setup events omitted
    // (Bittensor's blocks are judged once REREAD, 400 blocks of 12 s, behind the settled point, over the hour before)
    expect(Number(REREAD.bittensor) * 12 + DEFAULTS.logsCheckBittensorBlocks * 12).toBeLessThan(3 * 3600);
    expect(RUNBOOK["fmtao.role_change_critical"](f.facts)).toMatch(/at least three hours after the new pool's own setup.*indexer\.logs_omitted.*acknowledge/);
  });

  it("an admin moving is critical: FM-TAO's admin role granted, a role's admin changed, the AlphaVault's admin transfer scheduled, a pool's ownership transfer requested", () => {
    for (const l of [
      dep({ contract: "fmTao", chain: "base", event: "RoleGranted", args: { role: DEFAULT_ADMIN_ROLE, account: STRANGER, sender: STRANGER } }),
      dep({ contract: "fmTao", chain: "base", event: "RoleAdminChanged", args: { role: MINTER_ROLE, previousAdminRole: DEFAULT_ADMIN_ROLE, newAdminRole: BURNER_ROLE } }),
      dep({ contract: "alphaVault", chain: "bittensor", event: "DefaultAdminTransferScheduled", args: { newAdmin: STRANGER, acceptSchedule: NOW + 172_800 } }),
      dep({ contract: "tokenPool", chain: "bittensor", event: "OwnershipTransferRequested", args: { from: ZERO, to: STRANGER } }),
    ]) {
      expect(judged(l)[0][0], l.event).toBe("fmtao.role_change_critical");
    }
  });

  it("a new way to mint or release is critical (a remote pool or lane added, the router changed, the lock pool's liquidity withdrawn)", () => {
    for (const l of [
      dep({ contract: "tokenPool", chain: "base", event: "RemotePoolAdded", args: { remoteChainSelector: String(CCIP_SELECTOR.bittensor), remotePoolAddress: "0x1234" } }),
      dep({ contract: "tokenPool", chain: "bittensor", event: "ChainAdded", args: { remoteChainSelector: "1", remoteToken: "0x12", outboundRateLimiterConfig: config(5000n * E18), inboundRateLimiterConfig: config(5000n * E18) } }),
      dep({ contract: "tokenPool", chain: "base", event: "RouterUpdated", args: { oldRouter: ZERO, newRouter: STRANGER } }),
      dep({ contract: "tokenPool", chain: "bittensor", event: "LiquidityRemoved", args: { provider: STRANGER, amount: String(100n * E18) } }),
    ]) {
      expect(judged(l)[0][0], l.event).toBe("fmtao.role_change_critical");
    }
  });

  it("a lane's bucket set to capacity 0, either direction, or Cascade's lane removed, is critical; a rate-limit change otherwise a warning", () => {
    const configured = (out: bigint, inn: bigint) =>
      dep({ contract: "tokenPool", chain: "bittensor", event: "ChainConfigured", args: { remoteChainSelector: String(CCIP_SELECTOR.base), outboundRateLimiterConfig: config(out, out > 0n), inboundRateLimiterConfig: config(inn, inn > 0n) }, tx: `configured ${out} ${inn}` });
    expect(judged(configured(5000n * E18, 0n))[0][0]).toBe("fmtao.role_change_critical");
    // on TokenPool 1.5.1 a bucket at capacity 0 is a bucket switched off: no limit (only ChainRemoved freezes a lane)
    expect(judged(configured(0n, 5000n * E18))[0]).toEqual(["fmtao.role_change_critical", expect.stringContaining("no limit")]);
    expect(RUNBOOK["fmtao.role_change_critical"]({})).toContain("no limit");
    expect(RUNBOOK["fmtao.role_change_critical"]({})).not.toContain("freezes the lane or");
    const [[rule, subject]] = judged(configured(4000n * E18, 5000n * E18));
    expect(rule).toBe("fmtao.role_change");
    expect(subject).toContain("rate limit");
    expect(judged(dep({ contract: "tokenPool", chain: "bittensor", event: "ChainRemoved", args: { remoteChainSelector: String(CCIP_SELECTOR.base) } }))[0][0]).toBe("fmtao.role_change_critical");
    expect(judged(dep({ contract: "tokenPool", chain: "bittensor", event: "ChainRemoved", args: { remoteChainSelector: "6180753054346818345" } }))[0][0]).toBe("fmtao.role_change");
  });

  it("everything else is a warning: a revoke, another role, the CCIP admin, an ownership accepted, the rate-limit admin", () => {
    for (const l of [
      dep({ contract: "fmTao", chain: "base", event: "RoleRevoked", args: { role: MINTER_ROLE, account: STRANGER, sender: STRANGER } }),
      dep({ contract: "alphaVault", chain: "bittensor", event: "RoleGranted", args: { role: keccak256(toBytes("GUARDIAN_ROLE")), account: STRANGER, sender: STRANGER } }),
      dep({ contract: "fmTao", chain: "base", event: "CCIPAdminTransferred", args: { previousAdmin: ZERO, newAdmin: STRANGER } }),
      dep({ contract: "tokenPool", chain: "base", event: "OwnershipTransferred", args: { from: ZERO, to: STRANGER } }),
      dep({ contract: "tokenPool", chain: "base", event: "RateLimitAdminSet", args: { rateLimitAdmin: STRANGER } }),
    ]) {
      expect(judged(l)[0][0], l.event).toBe("fmtao.role_change");
    }
    const guardian = deps.fmtaoRoleChange.run(ctx({ logs: [dep({ contract: "alphaVault", chain: "bittensor", event: "RoleGranted", args: { role: keccak256(toBytes("GUARDIAN_ROLE")), account: STRANGER, sender: STRANGER } })] }));
    expect(guardian[0].facts).toMatchObject({ contract: "AlphaVault (Bittensor)", role: "GUARDIAN_ROLE" });
  });

  it("a pool upgrade in one transaction is one critical email listing every watched event in it, keyed by the transaction", () => {
    const NEW_POOL = "0x00000000000000000000000000000000000000cc" as Hex;
    const upgrade = [
      dep({ contract: "fmTao", chain: "base", event: "RoleGranted", args: { role: MINTER_ROLE, account: NEW_POOL, sender: STRANGER }, tx: "upgrade" }),
      dep({ contract: "fmTao", chain: "base", event: "RoleGranted", args: { role: BURNER_ROLE, account: NEW_POOL, sender: STRANGER }, tx: "upgrade" }),
      dep({ contract: "tokenPool", chain: "base", event: "RemotePoolAdded", args: { remoteChainSelector: String(CCIP_SELECTOR.bittensor), remotePoolAddress: "0x1234" }, tx: "upgrade" }),
      dep({ contract: "fmTao", chain: "base", event: "RoleRevoked", args: { role: MINTER_ROLE, account: t.base.tokenPool, sender: STRANGER }, tx: "upgrade" }),
    ].map((l, i) => ({ ...l, logIndex: i }));
    const found = deps.fmtaoRoleChange.run(ctx({ logs: upgrade }));
    expect(found).toHaveLength(1);
    const [f] = found;
    expect(f).toMatchObject({ rule: "fmtao.role_change_critical", key: `fmtao.role_change_critical:base:${upgrade[0].txHash}` });
    expect(f.subject).toContain("4 admin changes in one transaction");
    expect(Object.keys(f.facts).filter((k) => k.startsWith("event "))).toEqual(["event 1", "event 2", "event 3", "event 4"]);
    expect(f.facts["event 1"]).toContain("MINTER_ROLE granted to");
    expect(f.facts["event 4"]).toContain("MINTER_ROLE revoked from");
    // after a planned upgrade, the monitor must be pointed at the new pools
    expect(RUNBOOK["fmtao.role_change_critical"](f.facts)).toContain("TOKENS.base.tokenPool");
    // two transactions: two alerts
    const other = dep({ contract: "tokenPool", chain: "base", event: "RouterUpdated", args: { oldRouter: ZERO, newRouter: STRANGER }, tx: "another" });
    expect(deps.fmtaoRoleChange.run(ctx({ logs: [...upgrade, other] }))).toHaveLength(2);
    // warnings alone in a transaction: one warning for it
    const quiet = [
      dep({ contract: "tokenPool", chain: "base", event: "OwnershipTransferred", args: { from: ZERO, to: STRANGER }, tx: "accept" }),
      { ...dep({ contract: "tokenPool", chain: "base", event: "RateLimitAdminSet", args: { rateLimitAdmin: STRANGER }, tx: "accept" }), logIndex: 1 },
    ];
    expect(keys(deps.fmtaoRoleChange, ctx({ logs: quiet }))).toEqual([`fmtao.role_change:base:${quiet[0].txHash}`]);
  });

  it("reports each event once, on the tick it is first stored, never the deployment's setup, and never the deployment's own logs", () => {
    const l = dep({ contract: "fmTao", chain: "base", event: "RoleGranted", args: { role: MINTER_ROLE, account: STRANGER, sender: STRANGER } });
    const stored = ruleCtx({ logs: logQuery([l]), newUids: new Set() });
    expect(deps.fmtaoRoleChange.run(stored)).toEqual([]);
    const setup = dep({ contract: "fmTao", chain: "base", event: "RoleGranted", args: { role: MINTER_ROLE, account: STRANGER, sender: STRANGER }, block: cfg.deployment.base.baselineBlock });
    expect(deps.fmtaoRoleChange.run(ctx({ logs: [setup] }))).toEqual([]);
    const own = slog({ contract: "vault", event: "KeeperSet", args: { keeper: STRANGER }, block: 6_900_500n });
    expect(deps.fmtaoRoleChange.run(ctx({ logs: [own] }))).toEqual([]);
  });
});

describe("rail.alpha_vault and rail.alpha_vault_admin", () => {
  const alpha = (o: Partial<BitState["alpha"]>): BitState["alpha"] => ({ isPaused: false, migrationReadyAt: 0n, migrationFinished: false, pausedUntil: 0n, pauseableAfter: 0n, migrationTarget: ZERO, migrationExecuted: false, pendingAdmin: { admin: ZERO, schedule: 0 }, ...o });
  const on = (o: Partial<BitState["alpha"]>) => ctx({ bit: bit(10n, { alpha: alpha(o) }) });

  it("is quiet on the live AlphaVault (nothing paused, announced or pending)", () => {
    expect([...railAlphaVault.run(on({})), ...deps.railAlphaVaultAdmin.run(on({}))]).toEqual([]);
  });

  it("a guardian's pause until a time to come is critical, and an expired one isn't", () => {
    const [f] = railAlphaVault.run(on({ pausedUntil: BigInt(NOW + 3600) }));
    expect(f).toMatchObject({ rule: "rail.alpha_vault" });
    expect(f.subject).toContain("paused by its guardian until 2027-01-15 09:00 UTC");
    expect(railAlphaVault.run(on({ pausedUntil: BigInt(NOW - 1) }))).toEqual([]);
  });

  it("a migration announced (a target or a ready time) or executed is critical", () => {
    expect(railAlphaVault.run(on({ migrationTarget: STRANGER }))[0].subject).toContain(`a migration to ${STRANGER} is announced`);
    expect(railAlphaVault.run(on({ migrationReadyAt: BigInt(NOW + 86_400) }))[0].subject).toContain("a migration is announced");
    expect(railAlphaVault.run(on({ migrationExecuted: true }))[0].subject).toContain("executed");
  });

  it("a pending default admin is a warning", () => {
    const [f] = deps.railAlphaVaultAdmin.run(on({ pendingAdmin: { admin: STRANGER, schedule: NOW + 172_800 } }));
    expect(f).toMatchObject({ rule: "rail.alpha_vault_admin", key: `rail.alpha_vault_admin:${STRANGER}`, facts: { "new admin": STRANGER, "it may accept from": "2027-01-17 08:00 UTC" } });
  });
});

describe("the validator", () => {
  const v = (block: bigint, o: Partial<NonNullable<BitState["validator"]>>, time = NOW) => bit(block, { validator: { hotkey: HK, take: 0, rootStake: 1_000_000n * 10n ** 9n, rootUid: 1, ...o } }, time);

  it("validator.take_changed: a take that moved and stayed on the next reading, once", () => {
    // 0% → 5% on block 11, confirmed on 12
    expect(deps.validatorTake.run(ctx({ bit: v(11n, { take: 3277 }), bitBefore: [v(10n, {})] }))).toEqual([]);
    const [f] = deps.validatorTake.run(ctx({ bit: v(12n, { take: 3277 }), bitBefore: [v(11n, { take: 3277 }), v(10n, {})] }));
    expect(f).toMatchObject({ rule: "validator.take_changed", key: `validator.take_changed:${HK}:11`, facts: { before: "0.00%", after: "5.00%" } });
    expect(deps.validatorTake.run(ctx({ bit: v(13n, { take: 3277 }), bitBefore: [v(12n, { take: 3277 }), v(11n, { take: 3277 })] }))).toEqual([]);
    // the entry gone: Delegates is a ValueQuery, so no entry is the chain's default take (11,796 of 65,535: 18%, read
    // from the runtime metadata): the change is reported, and the take is high (validator.take_high, below)
    const gone = deps.validatorTake.run(ctx({ bit: v(12n, { take: null }), bitBefore: [v(11n, { take: null }), v(10n, {})] }));
    expect(gone.find((f) => f.rule === "validator.take_changed")?.facts.after).toBe("no entry: the chain's default take, 18.00%");
  });

  it("validator.take_high: a take above 9% on two readings is critical; no Delegates entry is the default 18%", () => {
    const high = 5965; // 9.10%
    const [f] = deps.validatorTake.run(ctx({ bit: v(12n, { take: high }), bitBefore: [v(11n, { take: high }), v(10n, { take: high })] }));
    expect(f).toMatchObject({ rule: "validator.take_high", key: `validator.take_high:${HK}`, facts: { take: "9.10%" } });
    expect(keys(deps.validatorTake, ctx({ bit: v(12n, { take: 5898 }), bitBefore: [v(11n, { take: 5898 }), v(10n, { take: 5898 })] }))).toEqual([]);
    const [none] = deps.validatorTake.run(ctx({ bit: v(12n, { take: null }), bitBefore: [v(11n, { take: null }), v(10n, { take: null })] }));
    expect(none).toMatchObject({ rule: "validator.take_high", facts: { take: "no entry: the chain's default take, 18.00%" } });
    expect(deps.DEFAULT_DELEGATE_TAKE).toBe(11_796);
  });

  it("validator.root_stake_drop: root stake more than 25% below the day's high, on two readings", () => {
    const hourly = (high: bigint): HourAgg[] => [{ hour: NOW - 7200, ticks: 60, spotSum: 0, spotCount: 0, validatorStakeHigh: high }];
    const day = 1_000_000n * 10n ** 9n;
    const fell = (block: bigint) => v(block, { rootStake: (day * 74n) / 100n });
    expect(rules(deps.validatorRootStakeDrop, ctx({ bit: fell(12n), bitBefore: [fell(11n)], hours: hourly(day) }))).toEqual(["validator.root_stake_drop"]);
    const [f] = deps.validatorRootStakeDrop.run(ctx({ bit: fell(12n), bitBefore: [fell(11n)], hours: hourly(day) }));
    expect(f.facts).toMatchObject({ "below the day's high": "26.00%" });
    const less = (block: bigint) => v(block, { rootStake: (day * 76n) / 100n });
    expect(rules(deps.validatorRootStakeDrop, ctx({ bit: less(12n), bitBefore: [less(11n)], hours: hourly(day) }))).toEqual([]);
    // an hour row older than a day doesn't count
    expect(rules(deps.validatorRootStakeDrop, ctx({ bit: fell(12n), bitBefore: [fell(11n)], hours: [{ ...hourly(day)[0], hour: NOW - 90_000 }] }))).toEqual([]);
  });

  it("validator.root_uid_lost: no root uid on two readings, once a uid has been read; remembered in meta", () => {
    const none = (block: bigint) => v(block, { rootUid: null });
    expect(rules(deps.validatorRootUidLost, ctx({ bit: none(12n), bitBefore: [none(11n), v(10n, {})] }))).toEqual(["validator.root_uid_lost"]);
    // never read a uid (a key that doesn't answer): nothing
    expect(rules(deps.validatorRootUidLost, ctx({ bit: none(12n), bitBefore: [none(11n)] }))).toEqual([]);
    expect(rules(deps.validatorRootUidLost, ctx({ bit: none(12n), bitBefore: [none(11n)], meta: { [`root_uid_seen:${HK}`]: "1" } }))).toEqual(["validator.root_uid_lost"]);
    const first = ctx({ bit: v(10n, {}) });
    deps.validatorRootUidLost.run(first);
    expect(written(first)[`root_uid_seen:${HK}`]).toBe("1");
  });
});

describe("ccip.rate_limited", () => {
  const lane = (inbound: bigint, outbound = 5000n): BitState["lane"] => ({ inbound: bucketOf(inbound), outbound: bucketOf(outbound) });
  const bucketOf = (tao: bigint, isEnabled = true): Bucket => ({ tokens: tao * E18, isEnabled, capacity: 5000n * E18, rate: 6n * 10n ** 17n });

  it("a bucket under 10 TAO for more than 10 minutes, either pool, either direction", () => {
    const low = ctx({ bit: bit(10n, { lane: lane(9n) }) });
    expect(deps.ccipRateLimited.run(low)).toEqual([]);
    expect(written(low)["rate_limited_since:bittensor:inbound"]).toBe(String(NOW));
    expect(keys(deps.ccipRateLimited, ctx({ bit: bit(10n, { lane: lane(9n) }), meta: { "rate_limited_since:bittensor:inbound": String(NOW - 601) } }))).toEqual(["ccip.rate_limited:bittensor:inbound"]);
    expect(keys(deps.ccipRateLimited, ctx({ bit: bit(10n, { lane: lane(9n) }), meta: { "rate_limited_since:bittensor:inbound": String(NOW - 599) } }))).toEqual([]);
    const [f] = deps.ccipRateLimited.run(ctx({ base: base(10n, { lane: { inbound: bucketOf(5000n), outbound: bucketOf(2n) } }), meta: { "rate_limited_since:base:outbound": String(NOW - 900) } }));
    expect(f).toMatchObject({ key: "ccip.rate_limited:base:outbound", facts: { lane: "Base → Bittensor (batches)", pool: "FM-TAO's CCIP pool on Base, outbound" } });
    // refilled: the mark is cleared
    const back = ctx({ bit: bit(10n, { lane: lane(5000n) }), meta: { "rate_limited_since:bittensor:inbound": String(NOW - 900) } });
    expect(deps.ccipRateLimited.run(back)).toEqual([]);
    expect(written(back)["rate_limited_since:bittensor:inbound"]).toBe("");
  });

  it("a bucket that is off (no limit) isn't rate limited; a chain not read leaves its marks alone", () => {
    expect(deps.ccipRateLimited.run(ctx({ bit: bit(10n, { lane: { inbound: bucketOf(0n, false) } }), meta: { "rate_limited_since:bittensor:inbound": String(NOW - 900) } }))).toEqual([]);
    const unread = ctx({ meta: { "rate_limited_since:bittensor:inbound": String(NOW - 900) } });
    expect(deps.ccipRateLimited.run(unread)).toEqual([]);
    expect(unread.writes.meta).toEqual([]);
  });
});

describe("root.unlock_interval", () => {
  it("is critical once RootStakeUnlockInterval is set, on two readings; unset (0) is quiet", () => {
    const set = (block: bigint) => bit(block, { rootUnlockInterval: 360n });
    const [f] = deps.rootUnlockInterval.run(ctx({ bit: set(12n), bitBefore: [set(11n)] }));
    expect(f).toMatchObject({ rule: "root.unlock_interval", key: "root.unlock_interval", facts: { blocks: "360", "about": "72 minutes" } });
    expect(deps.rootUnlockInterval.run(ctx({ bit: set(12n), bitBefore: [bit(11n, { rootUnlockInterval: 0n })] }))).toEqual([]);
    expect(deps.rootUnlockInterval.run(ctx({ bit: bit(12n, { rootUnlockInterval: 0n }), bitBefore: [bit(11n, { rootUnlockInterval: 0n })] }))).toEqual([]);
    // the front door has pause() only: no redeem-only pause to point at
    expect(RUNBOOK["root.unlock_interval"](f.facts)).not.toMatch(/pausing redeems|pause redeems/);
    expect(RUNBOOK["root.unlock_interval"](f.facts)).toContain("no redeem-only pause");
  });
});

describe("the oracle", () => {
  const pools = (taoWeth: number, next = 2000) => ({ taoWethPool: { cardinality: taoWeth, cardinalityNext: next }, wethUsdcPool: { cardinality: 5000, cardinalityNext: 5000 } });

  it("oracle.cardinality: a pool keeping fewer than 901 observations (the 30-minute window of 2-second blocks) warns, saying when it grows by itself", () => {
    // the live TAO/WETH pool on 2026-10-31: 600, growing to 2,000
    const [f] = deps.oracleCardinality.run(ctx({ base: base(11n, pools(600)), baseBefore: [base(10n, pools(600))] }));
    expect(f).toMatchObject({ rule: "oracle.cardinality", key: "oracle.cardinality:taoWeth", facts: { observations: "600", needed: "901", "growing to": "2000" } });
    expect(deps.oracleCardinality.run(ctx({ base: base(11n, pools(901)), baseBefore: [base(10n, pools(901))] }))).toEqual([]);
  });

  it("oracle.reverted: usdcValue reverting on two readings is critical (deliveries stop); twap.divergence no longer reports it", () => {
    const reverted = (block: bigint) => base(block, { oracleReverted: true });
    expect(rules(deps.oracleReverted, ctx({ base: reverted(11n), baseBefore: [reverted(10n)] }))).toEqual(["oracle.reverted"]);
    expect(rules(deps.oracleReverted, ctx({ base: reverted(11n), baseBefore: [base(10n)] }))).toEqual([]);
    // the reading marks an answer that doesn't decode as reverted too: the runbook says so
    expect(RUNBOOK["oracle.reverted"]({})).toContain("doesn't decode");
  });
});

describe("keeper.low_tao", () => {
  it("needs a claim's up-front gas on top of a round: (claimGasRequired + 2M) × the base fee, plus 0.01 TAO", () => {
    // the launch: 57M gas × 5 gwei = 0.285 TAO up front, plus 0.01: 0.295 TAO
    const live = { claimGasRequired: 55_000_000n, baseFee: 5_000_000_000n };
    const [f] = keeperLowTao.run(ctx({ bit: bit(10n, { ...live, keeperBalance: 59_999_500_000_000_000n }) }));
    expect(f).toMatchObject({ rule: "keeper.low_tao", facts: { balance: "0.0599995 TAO", needed: "0.295 TAO", "a claim's gas up front": "0.285 TAO (57000000 gas at 5 gwei)" } });
    expect(keeperLowTao.run(ctx({ bit: bit(10n, { ...live, keeperBalance: 295n * 10n ** 15n }) }))).toEqual([]);
    expect(rules(keeperLowTao, ctx({ bit: bit(10n, { ...live, keeperBalance: 294n * 10n ** 15n }) }))).toEqual(["keeper.low_tao"]);
    // without the claim's inputs: the round alone, as before
    expect(keeperLowTao.run(ctx({ bit: bit(10n, { keeperBalance: 11n * 10n ** 15n }) }))).toEqual([]);
  });
});

describe("payout.fee_ceiling", () => {
  const fee = (quote: bigint) => ({ payoutFeeQuote: quote, maxFeeAbs: 5n * 10n ** 15n, maxFeeBps: 100n });

  it("warns when a full chunk's quoted fee passes 70% of maxFeeAbs, on two readings; the live quote (26%) is quiet", () => {
    expect(deps.payoutFeeCeiling.run(ctx({ bit: bit(11n, fee(1_315_670_000_000_000n)), bitBefore: [bit(10n, fee(1_315_670_000_000_000n))] }))).toEqual([]);
    const over = 3_600_000_000_000_000n;
    const [f] = deps.payoutFeeCeiling.run(ctx({ bit: bit(11n, fee(over)), bitBefore: [bit(10n, fee(over))] }));
    expect(f).toMatchObject({ rule: "payout.fee_ceiling", key: "payout.fee_ceiling", facts: { "share of maxFeeAbs": "72%" } });
    expect(f.facts["a chunk is refused below"]).toContain("0.36 TAO");
    expect(deps.payoutFeeCeiling.run(ctx({ bit: bit(11n, fee(over)), bitBefore: [bit(10n, fee(1n))] }))).toEqual([]);
  });
});

describe("the critical rules hold only where a payout must stop", () => {
  it("only fmtao.backing_true of the new rules can hold (its alpha side, once BACKING_HOLD is on), and it isn't muted by a hold", () => {
    const short = { alpha: { backing: 1n }, wTaoSupply: E18, lockPoolFmTao: E18 };
    const run = (c: Config) => deps.fmtaoBackingTrue.run(ctx({ cfg: c, bit: bit(12n, short), bitBefore: [bit(11n, short), bit(10n, {})] }));
    const r = reconcile(env.DB, { open: [], findings: run(testConfig({ BACKING_HOLD: "true" })), nowS: NOW, t: DEFAULTS, holdActive: true });
    expect(r.holds.map((h) => h.rule)).toEqual(["fmtao.backing_true"]);
    expect(reconcile(env.DB, { open: [], findings: run(cfg), nowS: NOW, t: DEFAULTS, holdActive: true }).holds).toEqual([]);
    expect(Object.entries(RULES).filter(([id, s]) => s.canHold && /^(fmtao\.backing_true|fmtao\.lock|fmtao\.role_change|validator|ccip\.rate|root\.|oracle\.|payout\.fee|rail\.)/.test(id)).map(([id]) => id)).toEqual(["fmtao.backing_true"]);
  });
});

describe("a pool's rate-limit config through the store", () => {
  it("survives decoding (the struct stored as JSON by plain()), D1 and logOf, so the rule still reads its capacity", async () => {
    await wipe(env.DB);
    const raw = rawLog({
      address: t.bittensor.lockPool,
      abi: DEPENDENCY_EVENTS,
      eventName: "ChainConfigured",
      args: {
        remoteChainSelector: CCIP_SELECTOR.base,
        outboundRateLimiterConfig: { isEnabled: false, capacity: 0n, rate: 0n },
        inboundRateLimiterConfig: { isEnabled: true, capacity: 5000n * E18, rate: 6n * 10n ** 17n },
      },
      block: 6_900_500n,
      logIndex: 0,
      txHash: keccak256(toBytes("configure the lane")),
    });
    const [l] = identify("bittensor", [raw]).map((x) => decode("bittensor", x, rolesOf(cfg.deployment, cfg.bridges, cfg.tokens)) as StoredLog);
    expect(l).toMatchObject({ contract: "tokenPool", event: "ChainConfigured", args: { remoteChainSelector: String(CCIP_SELECTOR.base) } });
    expect(JSON.parse(String(l.args.outboundRateLimiterConfig))).toEqual({ isEnabled: false, capacity: "0", rate: "0" });
    expect(JSON.parse(String(l.args.inboundRateLimiterConfig))).toEqual({ isEnabled: true, capacity: String(5000n * E18), rate: String(6n * 10n ** 17n) });
    await env.DB.batch(upsertLogs(env.DB, [l]));
    const back = (await env.DB.prepare("SELECT * FROM logs WHERE contract = 'tokenPool'").all<Record<string, unknown>>()).results.map(logOf);
    expect(back.map((x) => x.args)).toEqual([l.args]);
    const [f] = deps.fmtaoRoleChange.run(ctx({ logs: back }));
    expect(f).toMatchObject({ rule: "fmtao.role_change_critical", key: `fmtao.role_change_critical:bittensor:${l.txHash}` });
    expect(f.subject).toContain("no limit");
  });
});
