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
import { REREAD_S } from "../../src/scan.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { TICK_RULES } from "../../src/tick.ts";
import { wipe } from "./d1-count.ts";
import { rawLog, testConfig, testConfigV32 } from "./fixtures.ts";
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
    // today's root.unlock_interval, renamed on every deployment (plan Task 57)
    expect(RULES["root.hold_interval"]).toMatchObject({ tier: "critical", kind: "condition", canHold: false });
    expect(Object.hasOwn(RULES, "root.unlock_interval")).toBe(false);
    expect(RULES["root.pair_stamped"]).toMatchObject({ tier: "warning", kind: "event" });
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
      "root.hold_interval",
      "root.pair_stamped",
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
    // (Bittensor's blocks are judged once the re-read margin, 4,800 s, behind the settled point, over the hour before)
    expect(REREAD_S.bittensor + DEFAULTS.logsCheckBittensorS).toBeLessThan(3 * 3600);
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

  it("a pause until a time to come is critical, and an expired one isn't", () => {
    const [f] = railAlphaVault.run(on({ isPaused: true, pausedUntil: BigInt(NOW + 3600) }));
    expect(f).toMatchObject({ rule: "rail.alpha_vault" });
    // isPaused() is block.timestamp < pausedUntil, which a guardian's pause and the operator's adminHold both set
    expect(f.subject).toContain("paused until 2027-01-15 09:00 UTC (its guardian's pause, or its operator's adminHold)");
    expect(railAlphaVault.run(on({ pausedUntil: BigInt(NOW - 1) }))).toEqual([]);
  });

  it("an operator's adminHold past the guardian's 2-day cap is named as the operator's; a halt with no end (a finished migration's) never throws", () => {
    // adminHold(until) sets pausedUntil to any finite time (AlphaVault.sol:466-476 at e80a443); a guardian's shot is at most 2 days
    const [held] = railAlphaVault.run(on({ isPaused: true, pausedUntil: BigInt(NOW + 3 * 86_400) }));
    expect(held.subject).toContain("held by its operator until 2027-01-18 08:00 UTC (adminHold: longer than a guardian's 2-day pause)");
    expect(held.facts["paused until"]).toBe("2027-01-18 08:00 UTC");
    // finishMigration sets pausedUntil to the largest uint256, and an adminHold can set any time past a Date's range
    const [forever] = railAlphaVault.run(on({ isPaused: true, migrationFinished: true, pausedUntil: 2n ** 256n - 1n }));
    expect(forever.subject).toContain("halted with no end");
    expect(forever.facts["paused until"]).toBe("no end");
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

describe("ForeverMoney's admin actions the events don't show (R3 FM-L2)", () => {
  // the live rail on 2026-11-05 (R3): each registry's entry is (ForeverMoney's Safe, none pending, the watched pool); the
  // lock pool has no rebalancer; the batch lane's buckets hold 5,000 TAO, refilling 0.6 a second
  const SAFE = "0xadf60fcc63217961c931d57f1dce2c5d70af3546" as Hex;
  const OTHER_POOL = "0x00000000000000000000000000000000000000cc" as Hex;
  const entry = (tokenPool: Hex, pendingAdministrator: Hex = ZERO, administrator: Hex = SAFE) => ({ administrator, pendingAdministrator, tokenPool });
  const bucketOf = (tao: bigint, capacity = 5000n, isEnabled = true): Bucket => ({ tokens: tao * E18, isEnabled, capacity: capacity * E18, rate: isEnabled ? 6n * 10n ** 17n : 0n });
  const lane = (o: Partial<{ inbound: Bucket; outbound: Bucket; supported: boolean }> = {}) => ({ inbound: bucketOf(5000n), outbound: bucketOf(5000n), supported: true, ...o });
  const onBase = (block: bigint, o: Partial<BaseState> = {}) => base(block, { maxBatchValue: 10n * E18, lane: lane(), registry: entry(t.base.tokenPool), ...o });
  const onBit = (block: bigint, o: Partial<BitState> = {}) => bit(block, { lane: lane(), registry: entry(t.bittensor.lockPool), lockPoolRebalancer: ZERO, ...o });
  const all = (c: RuleCtx) => [...deps.railPool.run(c), ...deps.fmtaoRebalancerSet.run(c), ...deps.fmtaoRegistryAdmin.run(c)];
  const both = (b: Partial<BaseState> = {}, x: Partial<BitState> = {}, meta: Record<string, string> = {}) =>
    ctx({ base: onBase(11n, b), baseBefore: [onBase(10n, b)], bit: onBit(11n, x), bitBefore: [onBit(10n, x)], meta });

  it("are in the tick on every deployment, each with its tier and a runbook line", () => {
    for (const r of [deps.railPool, deps.fmtaoRebalancerSet, deps.fmtaoRegistryAdmin]) expect(TICK_RULES).toContain(r);
    expect(RULES["rail.pool"]).toEqual({ tier: "critical", kind: "condition", canHold: false, mutedByHold: false });
    expect(RULES["rail.pool_low"]).toMatchObject({ tier: "warning", kind: "condition" });
    expect(RULES["fmtao.rebalancer_set"]).toEqual({ tier: "critical", kind: "condition", canHold: false, mutedByHold: false });
    expect(RULES["fmtao.registry_admin"]).toEqual({ tier: "critical", kind: "condition", canHold: false, mutedByHold: false });
    for (const id of ["rail.pool", "rail.pool_low", "fmtao.rebalancer_set", "fmtao.registry_admin"] as const) expect(RUNBOOK[id]({}).length, id).toBeGreaterThan(80);
    expect(deps.fmtaoRegistryAdmin.raises).toContain("fmtao.role_change");
    expect(deps.railPool.raises).toContain("rail.pool_low");
  });

  it("are quiet on the live rail", () => {
    const c = both();
    expect(all(c)).toEqual([]);
    expect(c.unjudged).toEqual([]);
  });

  it("rail.pool: the registry naming another pool for FM-TAO (Base) or wTAO (Bittensor), or none, is critical on two readings, each chain its own alert", () => {
    // one reading alone can't trip it
    expect(deps.railPool.run(ctx({ base: onBase(11n, { registry: entry(OTHER_POOL) }), baseBefore: [onBase(10n)], bit: onBit(11n), bitBefore: [onBit(10n)] }))).toEqual([]);
    const [f] = deps.railPool.run(both({ registry: entry(OTHER_POOL) }));
    expect(f).toMatchObject({ rule: "rail.pool", key: "rail.pool:base" });
    expect(f.subject).toContain("FM-TAO");
    expect(f.facts).toMatchObject({ "the registry's pool": OTHER_POOL, "the pool watched (TOKENS)": t.base.tokenPool });
    expect(f.facts.why).toContain("in-flight messages execute through it");
    expect(f.hold).toBeUndefined();
    const [g] = deps.railPool.run(both({}, { registry: entry(ZERO) }));
    expect(g).toMatchObject({ rule: "rail.pool", key: "rail.pool:bittensor" });
    expect(g.facts.why).toContain("no pool");
    expect(RUNBOOK["rail.pool"](f.facts)).toContain("TOKENS.base.tokenPool");
  });

  it("rail.pool's runbook: a pool that isn't ForeverMoney's takes what crosses it, so the guardian pauses the door and the vault", () => {
    const [f] = deps.railPool.run(both({ registry: entry(OTHER_POOL) }));
    const says = RUNBOOK["rail.pool"](f.facts);
    // CCIP's router hands a send's tokens to the pool the registry names: the next batch or payout is the loss
    expect(says).toContain("A pool that isn't ForeverMoney's takes the next batch or payout sent through it");
    expect(says).toContain("pause() the front door and the vault");
    // the old line: no funds lost, exits keep working (on v3-launch the door's pause stops requestRedeem, and payouts
    // kept crossing while the vault ran)
    expect(says).not.toMatch(/loses funds|keep working/);
  });

  it("rail.pool: the batch lane's bucket off (no limit), the lane removed, or a capacity below a full batch is critical", () => {
    const off = deps.railPool.run(both({ lane: lane({ outbound: bucketOf(0n, 0n, false) }) }));
    expect(off.map((f) => f.key)).toEqual(["rail.pool:base"]);
    expect(off[0].facts.why).toContain("no rate limit");
    const gone = deps.railPool.run(both({}, { lane: lane({ inbound: bucketOf(0n, 0n, false), supported: false }) }));
    expect(gone.map((f) => f.key)).toEqual(["rail.pool:bittensor"]);
    expect(gone[0].facts.why).toContain("no longer lists Base");
    // capacity 9 TAO against 10-TAO batches: a full batch can never cross
    const small = deps.railPool.run(both({ lane: lane({ outbound: bucketOf(9n, 9n) }) }));
    expect(small[0].facts.why).toContain("at most 9 TAO");
    // only the batch lane counts here (the payout lane's buckets are ccip.rate_limited's): Base's inbound and the lock
    // pool's outbound off are quiet
    expect(deps.railPool.run(both({ lane: lane({ inbound: bucketOf(0n, 0n, false) }) }, { lane: lane({ outbound: bucketOf(0n, 0n, false) }) }))).toEqual([]);
  });

  it("rail.pool_low: an enabled batch-lane bucket below a full batch for over an hour is a warning, marked in meta", () => {
    const low = (b: Partial<BaseState>, meta: Record<string, string> = {}) => both(b, {}, meta);
    const first = low({ lane: lane({ outbound: bucketOf(4n) }) });
    expect(deps.railPool.run(first)).toEqual([]);
    expect(written(first)).toEqual({ "rail_pool_low_since:base": String(NOW) });
    expect(deps.railPool.run(low({ lane: lane({ outbound: bucketOf(4n) }) }, { "rail_pool_low_since:base": String(NOW - 3600) }))).toEqual([]);
    const [f] = deps.railPool.run(low({ lane: lane({ outbound: bucketOf(4n) }) }, { "rail_pool_low_since:base": String(NOW - 3601) }));
    expect(f).toMatchObject({ rule: "rail.pool_low", key: "rail.pool_low:base", facts: { left: "4 TAO", "a full batch": "10 TAO" } });
    // refilled: the mark clears
    const back = low({}, { "rail_pool_low_since:base": String(NOW - 7200) });
    expect(deps.railPool.run(back)).toEqual([]);
    expect(written(back)).toEqual({ "rail_pool_low_since:base": "" });
  });

  it("rail.pool: unjudged without a reading or a field it needs, its marks left as they are", () => {
    const c = ctx({ base: base(11n), baseBefore: [base(10n)], meta: { "rail_pool_low_since:base": String(NOW - 7200) } });
    expect(deps.railPool.run(c)).toEqual([]);
    expect(c.unjudged).toEqual(expect.arrayContaining([{ rule: "rail.pool", key: "rail.pool:base" }, { rule: "rail.pool", key: "rail.pool:bittensor" }]));
    expect(c.writes.meta).toEqual([]);
  });

  it("fmtao.rebalancer_set: a rebalancer on the lock pool (setRebalancer logs nothing) is critical on two readings; unread is unjudged", () => {
    const REB = "0x00000000000000000000000000000000000000dd" as Hex;
    expect(deps.fmtaoRebalancerSet.run(ctx({ bit: onBit(11n, { lockPoolRebalancer: REB }), bitBefore: [onBit(10n)] }))).toEqual([]);
    const [f] = deps.fmtaoRebalancerSet.run(both({}, { lockPoolRebalancer: REB }));
    expect(f).toMatchObject({ rule: "fmtao.rebalancer_set", key: `fmtao.rebalancer_set:${REB}`, facts: { rebalancer: REB } });
    expect(f.subject).toContain("can now withdraw the wTAO locked");
    expect(RUNBOOK["fmtao.rebalancer_set"](f.facts)).toContain("LiquidityRemoved");
    const c = ctx({ bit: bit(11n), bitBefore: [bit(10n)] });
    expect(deps.fmtaoRebalancerSet.run(c)).toEqual([]);
    expect(c.unjudged).toEqual([{ rule: "fmtao.rebalancer_set" }]);
  });

  it("fmtao.registry_admin: an administrator transfer requested in either registry is critical on two readings; a completed one is a warning, once", () => {
    const NEW = "0x00000000000000000000000000000000000000ee" as Hex;
    const [f] = deps.fmtaoRegistryAdmin.run(both({ registry: entry(t.base.tokenPool, NEW) }));
    expect(f).toMatchObject({ rule: "fmtao.registry_admin", key: "fmtao.registry_admin:base", facts: { "proposed administrator": NEW, administrator: SAFE } });
    // the first reading remembers the administrator, silently
    const first = both();
    expect(deps.fmtaoRegistryAdmin.run(first)).toEqual([]);
    expect(written(first)).toEqual({ "registry_admin:base": SAFE, "registry_admin:bittensor": SAFE });
    // moved, on two readings: a warning event, and the new one remembered
    const moved = both({}, { registry: entry(t.bittensor.lockPool, ZERO, NEW) }, { "registry_admin:base": SAFE, "registry_admin:bittensor": SAFE });
    const [m] = deps.fmtaoRegistryAdmin.run(moved);
    expect(m).toMatchObject({ rule: "fmtao.role_change", key: `fmtao.role_change:registry:bittensor:${NEW}`, facts: { before: SAFE, after: NEW } });
    expect(written(moved)).toEqual({ "registry_admin:bittensor": NEW });
    // a single reading that answers another administrator moves nothing
    const once = ctx({ base: onBase(11n), baseBefore: [onBase(10n)], bit: onBit(11n, { registry: entry(t.bittensor.lockPool, ZERO, NEW) }), bitBefore: [onBit(10n)], meta: { "registry_admin:base": SAFE, "registry_admin:bittensor": SAFE } });
    expect(deps.fmtaoRegistryAdmin.run(once)).toEqual([]);
    expect(once.writes.meta).toEqual([]);
  });

  it("fmtao.role_change: FM-TAO's MINTER_ROLE or BURNER_ROLE revoked from its CCIP pool is critical (the lane halts); from anyone else, a warning", () => {
    const revoke = (role: Hex, account: Hex) =>
      slog({ contract: "fmTao", chain: "base", event: "RoleRevoked", args: { role, account, sender: SAFE }, block: 37_000_500n, address: t.base.fmTao, txHash: keccak256(toBytes(`revoke ${role} ${account}`)) });
    for (const role of [MINTER_ROLE, BURNER_ROLE]) {
      const [f] = deps.fmtaoRoleChange.run(ctx({ logs: [revoke(role, t.base.tokenPool)] }));
      expect(f.rule, role).toBe("fmtao.role_change_critical");
      expect(f.facts["what it means"]).toContain("the lane is halted");
    }
    // the pool the registry names counts too, when it is another than TOKENS'
    const [viaRegistry] = deps.fmtaoRoleChange.run(ctx({ logs: [revoke(MINTER_ROLE, OTHER_POOL)], base: onBase(11n, { registry: entry(OTHER_POOL) }) }));
    expect(viaRegistry.rule).toBe("fmtao.role_change_critical");
    expect(deps.fmtaoRoleChange.run(ctx({ logs: [revoke(MINTER_ROLE, STRANGER)] }))[0].rule).toBe("fmtao.role_change");
    expect(deps.fmtaoRoleChange.run(ctx({ logs: [revoke(keccak256(toBytes("OPERATOR_ROLE")), t.base.tokenPool)] }))[0].rule).toBe("fmtao.role_change");
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

describe("the standby validator (STANDBY_HOTKEY), watched beside the primary by the same rules (B7e)", () => {
  // Yuma (spec question 11): root uid 20, take 9%; a configuration value, never a constant
  const YUMA = "0x40c47b6a294686fe9612b5d78dd369f4c77fa3bbf96a4286ede97410ba2e3209" as Hex;
  const withStandby = testConfigV32({ STANDBY_HOTKEY: YUMA });
  type V = NonNullable<BitState["validator"]>;
  const primary: V = { hotkey: HK, take: 0, rootStake: 1_000_000n * 10n ** 9n, rootUid: 1 };
  const yuma: V = { hotkey: YUMA, take: 5898, rootStake: 500_000n * 10n ** 9n, rootUid: 20 };
  const r = (block: bigint, sb: Partial<V> = {}, pv: Partial<V> = {}) => bit(block, { validator: { ...primary, ...pv }, standby: { ...yuma, ...sb } });
  const c = (o: Parameters<typeof ctx>[0]) => ctx({ cfg: withStandby, ...o });
  const four = (x: RuleCtx) => [...deps.validatorTake.run(x), ...deps.validatorRootStakeDrop.run(x), ...deps.validatorRootUidLost.run(x)];

  it("the live pair is quiet: Yuma's 9% take is at the limit, not above it", () => {
    const x = c({ bit: r(12n), bitBefore: [r(11n), r(10n)] });
    expect(four(x)).toEqual([]);
    expect(x.unjudged).toEqual([]);
  });

  it("validator.take_changed and validator.take_high run for the standby, keyed by its hotkey, its emails saying standby", () => {
    const up = { take: 7864 }; // 12%
    const found = deps.validatorTake.run(c({ bit: r(12n, up), bitBefore: [r(11n, up), r(10n)] }));
    const changed = found.find((f) => f.rule === "validator.take_changed");
    expect(changed).toMatchObject({ key: `validator.take_changed:${YUMA}:11`, facts: { hotkey: YUMA, before: "9.00%", after: "12.00%", validator: "standby (STANDBY_HOTKEY)" } });
    expect(changed?.subject).toBe("The standby validator's take changed: 9.00% → 12.00%");
    const high = found.find((f) => f.rule === "validator.take_high");
    expect(high).toMatchObject({ key: `validator.take_high:${YUMA}`, facts: { take: "12.00%", validator: "standby (STANDBY_HOTKEY)" } });
    expect(high?.subject).toBe("The standby validator's take is 12.00%, above 9.00%");
    expect(RUNBOOK["validator.take_high"](high!.facts)).toContain("standby");
    // the primary's alerts are as they were: no standby fact, today's subject
    const p = deps.validatorTake.run(c({ bit: r(12n, {}, { take: 5965 }), bitBefore: [r(11n, {}, { take: 5965 }), r(10n, {}, { take: 5965 })] }));
    expect(p.map((f) => f.key)).toEqual([`validator.take_high:${HK}`]);
    expect(p[0].subject).toBe("The validator's take is 9.10%, above 9.00%");
    expect(p[0].facts.validator).toBeUndefined();
  });

  it("validator.root_stake_drop reads the standby's own hour rows (standbyStakeHigh)", () => {
    const day = 500_000n * 10n ** 9n;
    const hours: HourAgg[] = [{ hour: NOW - 7200, ticks: 60, spotSum: 0, spotCount: 0, validatorStakeHigh: primary.rootStake, standbyStakeHigh: day }];
    const fell = { rootStake: (day * 70n) / 100n };
    const [f] = deps.validatorRootStakeDrop.run(c({ bit: r(12n, fell), bitBefore: [r(11n, fell)], hours }));
    expect(f).toMatchObject({ rule: "validator.root_stake_drop", key: `validator.root_stake_drop:${YUMA}`, facts: { "below the day's high": "30.00%", validator: "standby (STANDBY_HOTKEY)" } });
    expect(f.subject).toBe("The standby validator's root stake fell 30.00% in a day");
    // the primary's high doesn't stand in for the standby's
    expect(deps.validatorRootStakeDrop.run(c({ bit: r(12n), bitBefore: [r(11n)], hours: [{ ...hours[0], standbyStakeHigh: undefined }] }))).toEqual([]);
  });

  it("validator.root_uid_lost for the standby, once a uid was read for it (remembered per hotkey)", () => {
    const off = { rootUid: null };
    const [f] = deps.validatorRootUidLost.run(c({ bit: r(12n, off), bitBefore: [r(11n, off), r(10n)] }));
    expect(f).toMatchObject({ rule: "validator.root_uid_lost", key: `validator.root_uid_lost:${YUMA}`, facts: { "uid before": "seen in an earlier reading", validator: "standby (STANDBY_HOTKEY)" } });
    expect(f.subject).toBe("The standby validator's hotkey is no longer registered on root");
    const first = c({ bit: r(10n) });
    deps.validatorRootUidLost.run(first);
    expect(written(first)).toEqual({ [`root_uid_seen:${HK}`]: "1", [`root_uid_seen:${YUMA}`]: "20" });
  });

  it("a standby that is the stake hotkey (Task 68's setStakeHotkey(Yuma) for a moveStake) is judged once, as the primary", () => {
    const same = (block: bigint) => bit(block, { validator: { ...yuma, take: 7864 }, standby: { ...yuma, take: 7864 } });
    const found = deps.validatorTake.run(c({ bit: same(12n), bitBefore: [same(11n), same(10n)] }));
    expect(found.map((f) => [f.key, f.facts.validator])).toEqual([[`validator.take_high:${YUMA}`, undefined]]);
  });

  it("STANDBY_HOTKEY set but the standby unread is unjudged under its own keys; unset, nothing is said of a standby", () => {
    const unread = c({ bit: bit(12n, { validator: primary }), bitBefore: [bit(11n, { validator: primary })] });
    expect(four(unread)).toEqual([]);
    expect(unread.unjudged).toEqual(
      expect.arrayContaining([
        { rule: "validator.take_high", key: `validator.take_high:${YUMA}` },
        { rule: "validator.root_stake_drop", key: `validator.root_stake_drop:${YUMA}` },
        { rule: "validator.root_uid_lost", key: `validator.root_uid_lost:${YUMA}` },
      ]),
    );
    expect(unread.unjudged.some((u) => u.key?.includes(HK))).toBe(false);
    const none = ctx({ cfg: testConfigV32(), bit: r(12n, { take: 7864 }), bitBefore: [r(11n, { take: 7864 }), r(10n)] });
    expect(four(none)).toEqual([]);
    expect(none.unjudged).toEqual([]);
  });
});

describe("ForeverMoney's admin-action rules on a v3.2 deployment", () => {
  it("are the same rules: quiet on the live rail, and keyed as on v3-launch", () => {
    const SAFE = "0xadf60fcc63217961c931d57f1dce2c5d70af3546" as Hex;
    const lane = { inbound: { tokens: 5000n * E18, isEnabled: true, capacity: 5000n * E18, rate: 1n }, outbound: { tokens: 5000n * E18, isEnabled: true, capacity: 5000n * E18, rate: 1n }, supported: true };
    const b = (block: bigint, pool: Hex) => base(block, { maxBatchValue: 10n * E18, lane, registry: { administrator: SAFE, pendingAdministrator: ZERO, tokenPool: pool } });
    const x = (block: bigint) => bit(block, { lane, registry: { administrator: SAFE, pendingAdministrator: ZERO, tokenPool: t.bittensor.lockPool }, lockPoolRebalancer: ZERO });
    const v32 = testConfigV32();
    const quiet = ctx({ cfg: v32, base: b(11n, t.base.tokenPool), baseBefore: [b(10n, t.base.tokenPool)], bit: x(11n), bitBefore: [x(10n)] });
    expect([...deps.railPool.run(quiet), ...deps.fmtaoRebalancerSet.run(quiet), ...deps.fmtaoRegistryAdmin.run(quiet)]).toEqual([]);
    const OTHER = "0x00000000000000000000000000000000000000cc" as Hex;
    const moved = ctx({ cfg: v32, base: b(11n, OTHER), baseBefore: [b(10n, OTHER)], bit: x(11n), bitBefore: [x(10n)] });
    expect(deps.railPool.run(moved).map((f) => f.key)).toEqual(["rail.pool:base"]);
  });

  it("rail.pool's runbook on v3.2: a paused front door never stops a close (I-20), so the guardian's option is disableBridge of the primary", () => {
    const SAFE = "0xadf60fcc63217961c931d57f1dce2c5d70af3546" as Hex;
    const OTHER = "0x00000000000000000000000000000000000000cc" as Hex;
    const lane = { inbound: { tokens: 5000n * E18, isEnabled: true, capacity: 5000n * E18, rate: 1n }, outbound: { tokens: 5000n * E18, isEnabled: true, capacity: 5000n * E18, rate: 1n }, supported: true };
    const b = (block: bigint) => base(block, { maxBatchValue: 10n * E18, lane, registry: { administrator: SAFE, pendingAdministrator: ZERO, tokenPool: OTHER } });
    const x = (block: bigint) => bit(block, { lane, registry: { administrator: SAFE, pendingAdministrator: ZERO, tokenPool: t.bittensor.lockPool }, lockPoolRebalancer: ZERO });
    const run = (c?: Config) => deps.railPool.run(ctx({ cfg: c, base: b(11n), baseBefore: [b(10n)], bit: x(11n), bitBefore: [x(10n)] }))[0];
    const f = run(testConfigV32());
    expect(f.facts.contracts).toBe("v3.2");
    const says = RUNBOOK["rail.pool"](f.facts);
    expect(says).toContain("A pool that isn't ForeverMoney's takes the next batch or payout sent through it");
    expect(says).toContain("never stops a close");
    expect(says).toContain("pause() the vault");
    expect(says).toContain("disableBridge(<the primary bridge>) on the front door");
    expect(says).toContain("PrimaryBridgeDisabled");
    expect(says).toContain("your call");
    // v3-launch's facts and line are as the port has them: its door's pause stops closes
    const g = run(cfg);
    expect(g.facts.contracts).toBeUndefined();
    expect(RUNBOOK["rail.pool"](g.facts)).toContain("pause() the front door and the vault until the pool is checked");
    expect(RUNBOOK["rail.pool"](g.facts)).not.toContain("disableBridge");
  });
});

describe("ForeverMoney's runbooks on v3.2 say what a front-door pause doesn't stop (I-20: never a close)", () => {
  const v32 = testConfigV32();
  const SAFE = "0xadf60fcc63217961c931d57f1dce2c5d70af3546" as Hex;
  /** What every v3.2 line must say, and the v3-launch claim it must not make. */
  const saysV32 = (text: string) => {
    expect(text).not.toMatch(/no new batch crosses|new batches stop|stops new batches|no new FM-TAO enters/);
    expect(text).toContain("never stops a close");
    expect(text).toContain("deposit, depositFor and deliver");
    expect(text).toContain("pause() the vault");
    expect(text).toContain("disableBridge(<the primary bridge>) on the front door");
    expect(text).toContain("cancelPayoutBatch(key, payouts)");
  };

  it("fmtao.backing_true's alpha side", () => {
    const live = { alpha: { backing: 13_992_856_362_690_000_000_000n }, wTaoSupply: 13_985_652_876_083_000_000_000n, lockPoolFmTao: 13_985_605_961_534_429_495_505n };
    const short = { ...live, alpha: { backing: (live.wTaoSupply * 9985n) / 10_000n } };
    const run = (c: Config) => deps.fmtaoBackingTrue.run(ctx({ cfg: c, bit: bit(12n, short), bitBefore: [bit(11n, short), bit(10n, live)] }))[0];
    const f = run(v32);
    expect(f.facts).toMatchObject({ side: "alpha", contracts: "v3.2" });
    saysV32(RUNBOOK["fmtao.backing_true"](f.facts));
    // v3-launch's line is as it was: its door's pause stops closes
    const g = run(cfg);
    expect(g.facts.contracts).toBeUndefined();
    expect(RUNBOOK["fmtao.backing_true"](g.facts)).toContain("pause() the front door (new batches stop) and the vault (payouts stop)");
  });

  it("R6b (U6): fmtao.backing_true's alpha side at a backing of 0, ForeverMoney's validator hotkey swapped (stakedValueRao reads 0): the cause, the queued burns and the owner's cancel are named", () => {
    const live = { alpha: { backing: 13_992_856_362_690_000_000_000n }, wTaoSupply: 13_985_652_876_083_000_000_000n, lockPoolFmTao: 13_985_605_961_534_429_495_505n };
    const gone = { ...live, alpha: { backing: 0n } };
    const f = deps.fmtaoBackingTrue.run(ctx({ cfg: v32, bit: bit(12n, gone), bitBefore: [bit(11n, gone), bit(10n, live)] }))[0];
    expect(f).toMatchObject({ key: "fmtao.backing_true:alpha", facts: { side: "alpha", "AlphaVault backing (backing(wTAO))": "0 TAO", "a stake of 0": "yes: most likely ForeverMoney's validator swapped its hotkey" } });
    const line = RUNBOOK["fmtao.backing_true"](f.facts);
    expect(line).toMatch(
      /^ForeverMoney's AlphaVault reads no stake at all \(its backing is 0\): most likely its validator swapped its hotkey, so its conversions both ways revert until ForeverMoney repoints it \(migrateValidator\)\. Unstakes from Base delivered meanwhile can burn into the payout queue and wait until then; owner: cancelPayoutBatch\(key, payouts\) gives their shares back \(runbook 7\.8\)\. Tell ForeverMoney now\. /,
    );
    // a short backing that isn't 0 says no swap
    const short = { ...live, alpha: { backing: (live.wTaoSupply * 9985n) / 10_000n } };
    const g = deps.fmtaoBackingTrue.run(ctx({ cfg: v32, bit: bit(12n, short), bitBefore: [bit(11n, short), bit(10n, live)] }))[0];
    expect(g.facts["a stake of 0"]).toBeUndefined();
    expect(RUNBOOK["fmtao.backing_true"](g.facts)).not.toContain("swapped its hotkey");
  });

  it("fmtao.role_change_critical", () => {
    const revoke = slog({ contract: "fmTao", chain: "base", event: "RoleRevoked", args: { role: MINTER_ROLE, account: t.base.tokenPool, sender: SAFE }, block: 37_000_500n, address: t.base.fmTao, txHash: keccak256(toBytes("v3.2 revoke")) });
    const [f] = deps.fmtaoRoleChange.run(ctx({ cfg: v32, logs: [revoke] }));
    expect(f).toMatchObject({ rule: "fmtao.role_change_critical", facts: { contracts: "v3.2" } });
    saysV32(RUNBOOK["fmtao.role_change_critical"](f.facts));
    const [g] = deps.fmtaoRoleChange.run(ctx({ logs: [revoke] }));
    expect(g.facts.contracts).toBeUndefined();
    expect(RUNBOOK["fmtao.role_change_critical"](g.facts)).toContain("guardian pause() the front door (no new batch crosses) and the vault (no payout crosses)");
  });

  it("fmtao.rebalancer_set", () => {
    const REB = "0x00000000000000000000000000000000000000dd" as Hex;
    const run = (c: Config) => deps.fmtaoRebalancerSet.run(ctx({ cfg: c, bit: bit(11n, { lockPoolRebalancer: REB }), bitBefore: [bit(10n, { lockPoolRebalancer: REB })] }))[0];
    const f = run(v32);
    expect(f.facts.contracts).toBe("v3.2");
    saysV32(RUNBOOK["fmtao.rebalancer_set"](f.facts));
    expect(RUNBOOK["fmtao.rebalancer_set"](f.facts)).toContain("LiquidityRemoved");
    const g = run(cfg);
    expect(g.facts.contracts).toBeUndefined();
    expect(RUNBOOK["fmtao.rebalancer_set"](g.facts)).toContain("pause() the front door (no new FM-TAO enters a rail that may be drained)");
  });

  it("rail.pool's v3.2 line names the same options, the cancel of payouts not yet sent among them", () => {
    saysV32(RUNBOOK["rail.pool"]({ contracts: "v3.2", setting: "TOKENS.base.tokenPool" }));
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

describe("root.hold_interval (today's root.unlock_interval, renamed)", () => {
  it("is critical once RootStakeUnlockInterval is set, on two readings; unset (0) is quiet", () => {
    const set = (block: bigint) => bit(block, { rootUnlockInterval: 360n });
    const [f] = deps.rootHoldInterval.run(ctx({ bit: set(12n), bitBefore: [set(11n)] }));
    expect(f).toMatchObject({ rule: "root.hold_interval", key: "root.hold_interval", facts: { blocks: "360", "about": "72 minutes" } });
    expect(deps.rootHoldInterval.run(ctx({ bit: set(12n), bitBefore: [bit(11n, { rootUnlockInterval: 0n })] }))).toEqual([]);
    expect(deps.rootHoldInterval.run(ctx({ bit: bit(12n, { rootUnlockInterval: 0n }), bitBefore: [bit(11n, { rootUnlockInterval: 0n })] }))).toEqual([]);
    // the front door has pause() only: no redeem-only pause to point at
    expect(RUNBOOK["root.hold_interval"](f.facts)).not.toMatch(/pausing redeems|pause redeems/);
    expect(RUNBOOK["root.hold_interval"](f.facts)).toContain("no redeem-only pause");
    // v3-launch's email is today's: no buffer facts
    expect(f.facts["idle buffer"]).toBeUndefined();
  });

  it("on v3.2 names the idle buffer that keeps exits liquid, and the one that covers the pending payouts plus a day's floor (spec §3.8)", () => {
    // 1,000 TAO booked, a 0.5% buffer (5 TAO, so the 10-TAO daily floor: _idleBuffer keeps the larger), 30 TAO of
    // payouts pending: 40 TAO is 4%
    const s = { rootUnlockInterval: 360n, bookedStake: 1000n * 10n ** 9n, idleBufferBps: 50, pendingPayouts: 30n * E18, minDailyOutflow: 10n * E18 };
    const [f] = deps.rootHoldInterval.run(ctx({ cfg: testConfigV32(), bit: bit(12n, s), bitBefore: [bit(11n, s)] }));
    expect(f.facts).toMatchObject({ contracts: "v3.2", "idle buffer": "50 bps: 10 TAO kept liquid", "a buffer that covers the pending payouts and a day's floor": "400 bps (40 TAO)" });
    expect(RUNBOOK["root.hold_interval"](f.facts)).toContain("setIdleBuffer(400)");
    // R6b: under a hold the guardian pauses the front door's deposits and the founder funds the buffer with
    // depositDirect
    expect(RUNBOOK["root.hold_interval"](f.facts)).toContain(
      "Payouts the buffer can't cover revert and wait; nothing is lost. Guardian: pause() the front door (deposits stop; batches of unstakes still deliver and pay out). Founder: fund the buffer with depositDirect() on Bittensor (runbook 7.6).",
    );
    // above the 10% cap: says so
    const big = { ...s, pendingPayouts: 200n * E18 };
    const [g] = deps.rootHoldInterval.run(ctx({ cfg: testConfigV32(), bit: bit(12n, big), bitBefore: [bit(11n, big)] }));
    expect(g.facts["a buffer that covers the pending payouts and a day's floor"]).toBe("2100 bps (210 TAO): more than the 1000 bps the vault allows");
    // a missing reading leaves it unjudged, never quiet
    const c = ctx({ cfg: testConfigV32(), bit: bit(12n, {}), bitBefore: [bit(11n, s)] });
    expect(deps.rootHoldInterval.run(c)).toEqual([]);
    expect(c.unjudged).toEqual([{ rule: "root.hold_interval", key: "root.hold_interval" }]);
  });
});

describe("root.pair_stamped", () => {
  it("is unjudged on v3.2 while the hold stamp's storage key is unconfirmed (Task 62), never a silent 'no stamp'; v3-launch doesn't run it", () => {
    const c = ctx({ cfg: testConfigV32(), bit: bit(12n, { rootUnlockInterval: 360n }), bitBefore: [bit(11n, { rootUnlockInterval: 360n })] });
    expect(deps.rootPairStamped.run(c)).toEqual([]);
    expect(c.unjudged).toEqual([{ rule: "root.pair_stamped" }]);
    expect(deps.ROOT_HOLD_STAMP_KEY).toBeUndefined();
    const v31 = ctx({ bit: bit(12n), bitBefore: [bit(11n)] });
    expect(deps.rootPairStamped.run(v31)).toEqual([]);
    expect(v31.unjudged).toEqual([]);
    expect(RUNBOOK["root.pair_stamped"]({})).toContain("Task 62");
  });
});

describe("the oracle", () => {
  const pools = (taoWeth: number, next = 2000) => ({ taoWethPool: { cardinality: taoWeth, cardinalityNext: next }, wethUsdcPool: { cardinality: 5000, cardinalityNext: 5000 } });

  it("oracle.cardinality: a pool keeping fewer observations than the 30-minute window needs at Base's block time as measured (1,801 on its 200 ms blocks: one a second at most) warns, saying when it grows by itself", () => {
    // the live TAO/WETH pool on 2026-10-31: 600, growing to 2,000
    const [f] = deps.oracleCardinality.run(ctx({ base: base(11n, pools(600)), baseBefore: [base(10n, pools(600))] }));
    expect(f).toMatchObject({ rule: "oracle.cardinality", key: "oracle.cardinality:taoWeth", facts: { observations: "600", needed: "1801", "growing to": "2000" } });
    expect(deps.oracleCardinality.run(ctx({ base: base(11n, pools(1_801)), baseBefore: [base(10n, pools(1_801))] }))).toEqual([]);
    expect(deps.oracleCardinality.run(ctx({ base: base(11n, pools(1_800)), baseBefore: [base(10n, pools(1_800))] }))[0].facts.needed).toBe("1801");
    // the threshold is the window at one observation a second, 1,801, whatever the block time reads (a pool never writes
    // two in one second, Revision 28): on 2-second blocks too, and with the block time unread
    const at = (blockS: Record<string, number>, n: number) => deps.oracleCardinality.run({ ...ctx({ base: base(11n, pools(n)), baseBefore: [base(10n, pools(n))] }), blockS });
    expect(at({ base: 2, bittensor: 12 }, 1_801)).toEqual([]);
    expect(at({ base: 2, bittensor: 12 }, 901)[0].facts.needed).toBe("1801");
    expect(at({}, 1_801)).toEqual([]);
    expect(at({}, 1_800)[0].facts.needed).toBe("1801");
  });

  it("oracle.cardinality on v3.2 judges against the oracle's own MIN_CARDINALITY (its constructor's precondition) too, whichever needs more", () => {
    const v32 = testConfigV32();
    // both pools at `n`
    const at = (block: bigint, n: number, min?: number) =>
      base(block, { taoWethPool: { cardinality: n, cardinalityNext: n }, wethUsdcPool: { cardinality: n, cardinalityNext: n }, ...(min === undefined ? {} : { minCardinality: min }) });
    // an oracle asking more (a later one's constant) is followed
    expect(deps.oracleCardinality.run(ctx({ cfg: v32, base: at(11n, 18_000, 18_001), baseBefore: [at(10n, 18_000, 18_001)] })).map((f) => f.facts)).toMatchObject([
      { observations: "18000", needed: "18001" },
      { observations: "18000", needed: "18001" },
    ]);
    expect(deps.oracleCardinality.run(ctx({ cfg: v32, base: at(11n, 18_001, 18_001), baseBefore: [at(10n, 18_001, 18_001)] }))).toEqual([]);
    // v3.2's own oracle: MIN_CARDINALITY 1,801 (TWAP_WINDOW + 1, Revision 28)
    expect(deps.oracleCardinality.run(ctx({ cfg: v32, base: at(11n, 1_801, 1_801), baseBefore: [at(10n, 1_801, 1_801)] }))).toEqual([]);
    expect(deps.oracleCardinality.run(ctx({ cfg: v32, base: at(11n, 1_800, 1_801), baseBefore: [at(10n, 1_800, 1_801)] }))[0].facts.needed).toBe("1801");
    // an oracle asking less than the window needs at Base's block time: the window's 1,801
    expect(deps.oracleCardinality.run(ctx({ cfg: v32, base: at(11n, 950, 901), baseBefore: [at(10n, 950, 901)] }))[0].facts.needed).toBe("1801");
    // unread, the window and the threshold stand in
    expect(deps.oracleCardinality.run(ctx({ cfg: v32, base: at(11n, 1_801), baseBefore: [at(10n, 1_801)] }))).toEqual([]);
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

  it("Task 65: the claim's gas is held to Bittensor's per-transaction ceiling, as the keeper sends it: at claimGasRequired 63.4M, 64.9M gas, not 65.4M", () => {
    const top = { claimGasRequired: 63_400_000n, baseFee: 5_000_000_000n };
    const [f] = keeperLowTao.run(ctx({ bit: bit(10n, { ...top, keeperBalance: 10n ** 16n }) }));
    expect(f).toMatchObject({ facts: { needed: "0.3345 TAO", "a claim's gas up front": "0.3245 TAO (64900000 gas at 5 gwei)" } });
    expect(keeperLowTao.run(ctx({ bit: bit(10n, { ...top, keeperBalance: 3345n * 10n ** 14n }) }))).toEqual([]);
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

describe("R12a: batch.redeem_fee_thin", () => {
  // the launch (the founder, 2026-11-16): 0.0002 ETH a request, 50 of them, 0.01 ETH; a full 50 + 50 batch quotes about
  // 0.0043 ETH toward Bittensor (7,000,000 gas): 2.32 times, quiet. The 0.0001 ETH before (v3-launch's) paid 0.005 ETH:
  // 1.16 times, a warning
  const LAUNCH_FEE = 2n * 10n ** 14n;
  const OLD_FEE = 10n ** 14n;
  const door = (quote: bigint, fee = LAUNCH_FEE, maxRedeems = 50) => ({ redeemRequestFee: fee, maxRedeems, fullBatchQuote: quote });
  const QUOTE = 43n * 10n ** 14n;

  it("is a warning in the tick, and its runbook line names the owner's setRedeemRequestFee, immediate, at most 0.001 ETH", () => {
    expect(RULES["batch.redeem_fee_thin"]).toEqual({ tier: "warning", kind: "condition", canHold: false, mutedByHold: false });
    expect(TICK_RULES).toContain(deps.redeemFeeThin);
    const line = RUNBOOK["batch.redeem_fee_thin"]({ "the fee that covers 1.5×": "0.000129 ETH" });
    expect(line).toContain("setRedeemRequestFee(");
    expect(line).toContain("immediate");
    expect(line).toContain("0.001 ETH");
    expect(line).toContain("0.000129 ETH");
    // R12d (a nit): no ops command writes it yet, as the runbook says: the email says so too
    expect(line).toContain("No ops command writes setRedeemRequestFee yet (the sign page refuses a call it doesn't know)");
    expect(line).toContain("SETTINGS_V32_LAUNCH.frontDoor.redeemRequestFee");
  });

  it("warns on two readings when a full redeem list's fees cover a full batch's close quote less than 1.5 times", () => {
    // the 0.0001 ETH before: 0.005 against 0.0043, 1.16 times
    const thin = door(QUOTE, OLD_FEE);
    const [f] = deps.redeemFeeThin.run(ctx({ base: base(11n, thin), baseBefore: [base(10n, thin)] }));
    expect(f).toMatchObject({
      rule: "batch.redeem_fee_thin",
      key: "batch.redeem_fee_thin",
      subject: "A full redeem list's fees cover a full batch's bridge fee only 1.16 times",
      facts: {
        "redeem request fee": "0.0001 ETH",
        "a full redeem list pays": "0.005 ETH (50 requests)",
        "a full batch's close quote (50 + 50)": "0.0043 ETH",
        cover: "1.16×",
        "the fee that covers 1.5×": "0.000129 ETH",
      },
    });
    // one reading only, or the one before it covered: quiet
    const launch = door(QUOTE);
    expect(deps.redeemFeeThin.run(ctx({ base: base(11n, thin), baseBefore: [base(10n, launch)] }))).toEqual([]);
    // the launch's 0.0002 ETH (the founder, 2026-11-16): 0.01 against 0.0043, 2.32 times: quiet
    expect(deps.redeemFeeThin.run(ctx({ base: base(11n, launch), baseBefore: [base(10n, launch)] }))).toEqual([]);
    // at the launch's fee it warns once a full batch's quote passes 0.01 ETH / 1.5, about 0.0067 ETH
    const near = door(66n * 10n ** 14n);
    expect(deps.redeemFeeThin.run(ctx({ base: base(11n, near), baseBefore: [base(10n, near)] }))).toEqual([]);
    const risen = door(67n * 10n ** 14n);
    const [r] = deps.redeemFeeThin.run(ctx({ base: base(11n, risen), baseBefore: [base(10n, risen)] }));
    expect(r).toMatchObject({
      subject: "A full redeem list's fees cover a full batch's bridge fee only 1.49 times",
      facts: { "redeem request fee": "0.0002 ETH", "a full redeem list pays": "0.01 ETH (50 requests)", cover: "1.49×", "the fee that covers 1.5×": "0.000201 ETH" },
    });
    // exactly 1.5 times is enough; a wei less is not
    const edge = door(3n * 10n ** 15n, 9n * 10n ** 13n);
    expect(deps.redeemFeeThin.run(ctx({ base: base(11n, edge), baseBefore: [base(10n, edge)] }))).toEqual([]);
    const under = door(3n * 10n ** 15n, 9n * 10n ** 13n - 1n);
    expect(rules(deps.redeemFeeThin, ctx({ base: base(11n, under), baseBefore: [base(10n, under)] }))).toEqual(["batch.redeem_fee_thin"]);
    // a fee that would cover it above the front door's 0.001 ETH says so
    const dear = door(10n ** 17n);
    const [d] = deps.redeemFeeThin.run(ctx({ base: base(11n, dear), baseBefore: [base(10n, dear)] }));
    expect(d.facts["the fee that covers 1.5×"]).toBe("0.003 ETH, above the front door's most (0.001 ETH)");
  });

  it("is unjudged while the fee, the redeem limit or the quote is unread", () => {
    for (const o of [{ ...door(QUOTE), fullBatchQuote: undefined }, { ...door(QUOTE), redeemRequestFee: undefined }, { ...door(QUOTE), maxRedeems: undefined }]) {
      const c = ctx({ base: base(11n, o), baseBefore: [base(10n, o)] });
      expect(deps.redeemFeeThin.run(c)).toEqual([]);
      expect(c.unjudged).toContainEqual({ rule: "batch.redeem_fee_thin", key: "batch.redeem_fee_thin" });
    }
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
