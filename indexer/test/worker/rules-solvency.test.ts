import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import { depositsBounced, depositsRefused, frontDoorSolvency, SOLVENCY_RULES, vaultEvents, vaultSolvency } from "../../src/rules/solvency.ts";
import { RULES } from "../../src/rules/ids.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import type { BaseState, BitState, ChainReading } from "../../src/snapshot.ts";
import { baseState, bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";
import { UNDERWATER_TOLERANCE_WEI } from "../../src/abi.ts";
import { testConfigV32 } from "./fixtures.ts";

const E18 = 10n ** 18n;
const USER = "0x00000000000000000000000000000000000000b1" as Hex;
const KEY = `0x${"ab".repeat(32)}` as Hex;

const open = { id: 42n, start: 0, totalDeposits: 3n * E18, feePot: 10n ** 15n, nDeposits: 2, nRedeems: 0 };
const fd = (block: bigint, o: Partial<BaseState> = {}): ChainReading<BaseState> =>
  reading(block, Number(block), baseState({ openBatch: open, totalClaimable: E18, frontDoorTao: 4n * E18, totalFeeCredit: 2n * 10n ** 15n, frontDoorEth: 3n * 10n ** 15n, ...o }));
const vt = (block: bigint, o: Partial<BitState> = {}): ChainReading<BitState> =>
  reading(block, Number(block), bitState({ rootStakeRao: 5n * 10n ** 9n, balance: E18, pendingPayouts: 6n * E18 - 10n ** 12n, ...o }));

function baseCtx(now: ChainReading<BaseState>, history: ChainReading<BaseState>[]): RuleCtx {
  const c = ruleCtx();
  return ruleCtx({ snap: { ...c.snap, base: now }, history: { base: history, bittensor: [] }, previous: { base: history[0] } });
}
function bitCtx(now: ChainReading<BitState>, history: ChainReading<BitState>[]): RuleCtx {
  const c = ruleCtx();
  return ruleCtx({ snap: { ...c.snap, bittensor: now }, history: { base: [], bittensor: history }, previous: { bittensor: history[0] } });
}

describe("frontdoor.solvency", () => {
  it("is quiet when the front door holds exactly what it owes", () => {
    expect(frontDoorSolvency.run(baseCtx(fd(11n), [fd(10n)]))).toEqual([]);
  });

  it("finds TAO one wei short on two readings from increasing blocks, with a hold raised once, and not on one", () => {
    const short = { frontDoorTao: 4n * E18 - 1n };
    expect(frontDoorSolvency.run(baseCtx(fd(11n, short), [fd(10n)]))).toEqual([]);
    const [f] = frontDoorSolvency.run(baseCtx(fd(12n, short), [fd(11n, short), fd(10n)]));
    expect(f).toMatchObject({ rule: "frontdoor.solvency", key: "frontdoor.solvency:tao" });
    expect(f.facts).toMatchObject({ holds: "3999999999999999999", owes: "4000000000000000000", short: "1" });
    expect(f.hold?.id).toBe("frontdoor.solvency:tao:11");
    // still short next tick: the same alert, no new hold
    const [g] = frontDoorSolvency.run(baseCtx(fd(13n, short), [fd(12n, short), fd(11n, short), fd(10n)]));
    expect(g.key).toBe(f.key);
    expect(g.hold).toBeUndefined();
    // not compared with an older block
    expect(frontDoorSolvency.run(baseCtx(fd(11n, short), [fd(11n, short)]))).toEqual([]);
  });

  it("finds ETH below the fee pot and fee credit twice", () => {
    const low = { frontDoorEth: 3n * 10n ** 15n - 1n };
    const [f] = frontDoorSolvency.run(baseCtx(fd(12n, low), [fd(11n, low)]));
    expect(f).toMatchObject({ key: "frontdoor.solvency:eth" });
    expect(f.hold?.id).toBe("frontdoor.solvency:eth:11");
  });

  it("skips a reading missing a field", () => {
    expect(frontDoorSolvency.run(baseCtx(fd(12n, { frontDoorTao: undefined }), [fd(11n, { frontDoorTao: undefined })]))).toEqual([]);
  });
});

describe("vault.solvency", () => {
  it("is quiet with exactly the 1e12 margin, and finds one wei less twice, with a hold", () => {
    expect(vaultSolvency.run(bitCtx(vt(11n), [vt(10n)]))).toEqual([]);
    const short = { pendingPayouts: 6n * E18 - 10n ** 12n + 1n };
    expect(vaultSolvency.run(bitCtx(vt(11n, short), [vt(10n)]))).toEqual([]);
    const [f] = vaultSolvency.run(bitCtx(vt(12n, short), [vt(11n, short), vt(10n)]));
    expect(f).toMatchObject({ rule: "vault.solvency", key: "vault.solvency" });
    expect(f.hold?.id).toBe("vault.solvency:11");
  });
});

describe("vault.solvency on v3.2: the vault's own underwater rule on the lens's grossAssets", () => {
  const cfg32 = testConfigV32();
  const TOL = UNDERWATER_TOLERANCE_WEI;
  const RAO = 10n ** 9n;
  /** gross 5 TAO against 5 TAO queued, nothing vesting, no shares left: the corner an emptied vault's last exit leaves */
  const v32 = (block: bigint, o: Partial<BitState> = {}): ChainReading<BitState> =>
    reading(block, Number(block), bitState({ grossAssets: 5n * E18, pendingPayouts: 5n * E18, unvestedRewards: 0n, totalSupply: 0n, ...o }));
  const ctx32 = (now: ChainReading<BitState>, history: ChainReading<BitState>[]) => ({ ...bitCtx(now, history), cfg: cfg32 });
  const run = (o: Partial<BitState>) => vaultSolvency.run(ctx32(v32(12n, o), [v32(11n, o), v32(10n)]));

  it("the carried corner (a supply of 0, nothing vesting, short by up to 1,000 rao) raises nothing", () => {
    expect(TOL).toBe(1_000n * RAO);
    expect(run({ pendingPayouts: 5n * E18 + TOL })).toEqual([]);
    expect(run({})).toEqual([]);
  });

  it("short by 1,001 rao there raises the critical on two readings, with a hold, naming the tolerance", () => {
    const short = { pendingPayouts: 5n * E18 + TOL + RAO };
    expect(vaultSolvency.run(ctx32(v32(11n, short), [v32(10n)]))).toEqual([]);
    const [f] = run(short);
    expect(f).toMatchObject({ rule: "vault.solvency", key: "vault.solvency" });
    expect(f.hold?.id).toBe("vault.solvency:11");
    expect(f.facts).toMatchObject({ holds: String(5n * E18), owes: String(5n * E18 + TOL + RAO), short: String(TOL + RAO), "allowed short": expect.stringContaining("1000000000000") });
  });

  it("at a supply of 0 the vault writes a schedule nobody owns down to what the gross holds beyond the payouts first: whatever vests, only the payouts short past 1,000 rao count", () => {
    // a hole in the schedule (1 wei, or 3 TAO) with the payouts covered: written down, the mint accepted
    expect(run({ unvestedRewards: 1n, pendingPayouts: 5n * E18 })).toEqual([]);
    expect(run({ unvestedRewards: 3n * E18, pendingPayouts: 5n * E18 })).toEqual([]);
    expect(run({ unvestedRewards: 3n * E18, pendingPayouts: 5n * E18 + TOL })).toEqual([]);
    // the payouts themselves short by 1,001 rao: the critical, the schedule not counted as owed
    const [f] = run({ unvestedRewards: 3n * E18, pendingPayouts: 5n * E18 + TOL + RAO });
    expect(f.facts).toMatchObject({ holds: String(5n * E18), owes: String(5n * E18 + TOL + RAO), short: String(TOL + RAO), "allowed short": expect.stringContaining("1000000000000") });
  });

  it("with shares outstanding the schedule is the holders' (never written down): one wei short of the payouts and the schedule counts", () => {
    const [f] = run({ totalSupply: 1n, pendingPayouts: 5n * E18 + 1n });
    expect(f.facts).toMatchObject({ short: "1", "allowed short": "none" });
    expect(run({ totalSupply: 1n })).toEqual([]);
    expect(run({ totalSupply: 1n, unvestedRewards: 1n })).toHaveLength(1);
    expect(run({ totalSupply: 1n, unvestedRewards: 1n, pendingPayouts: 5n * E18 - 1n })).toEqual([]);
  });

  it("judges nothing while a field it needs is unread, and never v3.1's stake-and-balance sum", () => {
    for (const k of ["grossAssets", "pendingPayouts", "unvestedRewards", "totalSupply"] as const) {
      const c = ctx32(v32(12n, { [k]: undefined }), [v32(11n, { [k]: undefined }), v32(10n)]);
      expect(vaultSolvency.run(c), k).toEqual([]);
      expect(c.unjudged, k).toEqual([{ rule: "vault.solvency", key: "vault.solvency" }]);
    }
    // a v3.1 reading's fields short by v3.1's sum, the lens's gross whole: nothing
    expect(run({ rootStakeRao: 0n, balance: 0n })).toEqual([]);
  });

  it("v3-launch's rule is unchanged: v3.2's fields don't enter it", () => {
    const short = { pendingPayouts: 6n * E18 - 10n ** 12n + 1n, grossAssets: 100n * E18, unvestedRewards: 0n, totalSupply: 0n };
    expect(vaultSolvency.run(bitCtx(vt(12n, short), [vt(11n, short), vt(10n)])).map((f) => f.key)).toEqual(["vault.solvency"]);
  });
});

describe("vault.deposits_refused (v3.2): below half the launch price, every deposit is refused", () => {
  const v32 = testConfigV32();
  // the launch price is 1e-6 TAO a share (CascadeMath's 1e6 virtual shares a wei); half of it is assets × 2,000,000 < supply
  const at = (block: bigint, assets: bigint | undefined, supply: bigint | undefined) => vt(block, { totalAssets: assets, totalSupply: supply });
  const run = (now: ChainReading<BitState>, before: ChainReading<BitState>[]) => depositsRefused.run(ruleCtx({ ...bitCtx(now, before), cfg: v32 }));
  const S = 2_000_000n * E18;

  it("is a critical condition in the tick, with a runbook line", () => {
    expect(SOLVENCY_RULES).toContain(depositsRefused);
    expect(RULES["vault.deposits_refused"]).toEqual({ tier: "critical", kind: "condition", canHold: false, mutedByHold: false });
    expect(RUNBOOK["vault.deposits_refused"]({}).length).toBeGreaterThan(80);
  });

  it("is quiet at exactly half the launch price, and critical one wei below it on two readings (a slow slide price.drop misses)", () => {
    expect(run(at(11n, E18, S), [at(10n, E18, S)])).toEqual([]);
    expect(run(at(11n, E18 - 1n, S), [at(10n, E18, S)])).toEqual([]);
    const [f] = run(at(11n, E18 - 1n, S), [at(10n, E18 - 1n, S)]);
    expect(f).toMatchObject({ rule: "vault.deposits_refused", key: "vault.deposits_refused", facts: { "total assets": "0.999999999999999999 TAO (999999999999999999 wei)", "the line": "0.0000005 TAO a share (half the launch price)" } });
    expect(f.subject).toBe("The vault refuses every deposit: its share price is below half the launch price");
    expect(f.hold).toBeUndefined();
    expect(RUNBOOK["vault.deposits_refused"](f.facts)).toContain("bounce");
  });

  it("no shares is never this line (vault.solvency judges an empty vault); unread is unjudged; v3-launch doesn't run it", () => {
    expect(run(at(11n, 0n, 0n), [at(10n, 0n, 0n)])).toEqual([]);
    const c = ruleCtx({ ...bitCtx(at(11n, undefined, S), [at(10n, 1n, S)]), cfg: v32 });
    expect(depositsRefused.run(c)).toEqual([]);
    expect(c.unjudged).toEqual([{ rule: "vault.deposits_refused", key: "vault.deposits_refused" }]);
    const v31 = bitCtx(at(11n, 1n, S), [at(10n, 1n, S)]);
    expect(depositsRefused.run(v31)).toEqual([]);
    expect(v31.unjudged).toEqual([]);
  });
});

describe("deposits.bounced and vault.events", () => {
  /** `logs` are first stored by this tick, `stored` on an earlier one. */
  const ctx = (logs: StoredLog[], stored: StoredLog[] = []) => ruleCtx({ logs: logQuery([...stored, ...logs]), newUids: new Set(logs.map((l) => l.uid)) });

  it("names the user and amount of a bounced deposit, once: on the tick it is first stored", () => {
    const l = slog({ contract: "vault", event: "DepositBounced", block: 150n, args: { key: KEY, user: USER, assets: String(2n * E18) } });
    const [f] = depositsBounced.run(ctx([l]));
    expect(f).toMatchObject({ rule: "deposits.bounced", key: `deposits.bounced:${l.uid}` });
    expect(f.facts).toMatchObject({ user: USER, amount: "2 TAO (2000000000000000000 wei)", batch: KEY });
    expect(f.hold).toBeUndefined();
    expect(depositsBounced.run(ctx([], [l]))).toEqual([]);
  });

  it("on v3.2 says why the deposit bounced (DepositBounced's reason): insolvent, or the user redeems through another chain", () => {
    const v32 = (logs: StoredLog[]) => ruleCtx({ cfg: testConfigV32(), logs: logQuery(logs), newUids: new Set(logs.map((l) => l.uid)) });
    const bounce = (reason: number) => slog({ contract: "vault", event: "DepositBounced", block: 6_900_100n, args: { key: KEY, user: USER, assets: String(E18), reason } });
    const [f] = depositsBounced.run(v32([bounce(0)]));
    expect(f.facts.reason).toBe("Insolvent: the vault was below half the launch price, or underwater");
    expect(f.subject).toBe("The vault bounced a deposit: it was below half the launch price, or underwater");
    const [g] = depositsBounced.run(v32([bounce(1)]));
    expect(g.facts.reason).toBe("ForeignOrigin: this address redeems through another chain's front doors");
    expect(g.subject).toBe("The vault bounced a deposit: the user redeems through another chain");
    expect(RUNBOOK["deposits.bounced"](g.facts)).toContain("setRedeemOrigin");
    // v3-launch's email is today's
    const [old] = depositsBounced.run(ctx([slog({ contract: "vault", event: "DepositBounced", block: 150n, args: { key: KEY, user: USER, assets: "1" } })]));
    expect(old.facts.reason).toBeUndefined();
    expect(old.subject).toBe("The vault bounced a deposit");
  });

  it("reports a bounced deposit and a vault edge case a re-read found late, below the blocks settled before", () => {
    const later = slog({ contract: "vault", event: "Staked", block: 9_000n });
    const bounced = slog({ contract: "vault", event: "DepositBounced", block: 5n, args: { key: KEY, user: USER, assets: "1" } });
    const deferred = slog({ contract: "vault", event: "RedeemDeferred", block: 6n, args: { key: KEY, user: USER, requested: "5" } });
    expect(depositsBounced.run(ctx([bounced], [later])).map((f) => f.key)).toEqual([`deposits.bounced:${bounced.uid}`]);
    expect(vaultEvents.run(ctx([deferred], [later])).map((f) => f.key)).toEqual([`vault.events:${deferred.uid}`]);
  });

  it("reports RedeemDeferred, PayoutDust, DepositSkipped and an unknown log, and not a csTAO Transfer", () => {
    const logs = [
      slog({ contract: "vault", event: "RedeemDeferred", block: 110n, args: { key: KEY, user: USER, requested: "5" } }),
      slog({ contract: "vault", event: "PayoutDust", block: 120n, args: { key: KEY, user: USER, assets: "7" } }),
      slog({ contract: "vault", event: "DepositSkipped", block: 130n, args: { key: KEY, user: USER, assets: "9" } }),
      slog({ contract: "bitAdapter", event: "unknown", block: 140n }),
      slog({ contract: "vault", event: "Transfer", block: 150n, args: { from: USER, to: KEY.slice(0, 42), value: "1" } }),
    ];
    const found = vaultEvents.run(ctx(logs));
    expect(found.map((f) => f.facts.event)).toEqual(["vault RedeemDeferred", "vault PayoutDust", "vault DepositSkipped", "Bittensor adapter unknown"]);
    expect(found.every((f) => f.rule === "vault.events" && f.key === `vault.events:${logs.find((l) => f.facts.transaction.endsWith(l.txHash))?.uid}`)).toBe(true);
    expect(found[0].facts).toMatchObject({ user: USER, requested: "5" });
    // v3-launch's email names no cause (its causes are the limit and the minimum, as before)
    expect(found[0].facts).not.toHaveProperty("why (the likely cause)");
  });

  it("on v3.2 a RedeemDeferred names its likely cause from what is cheap to tell, the event naming none: a closed rail, the one-day hold, the minimum, else the allowance", () => {
    const cfg32 = testConfigV32();
    const PRIMARY = cfg32.deployment.bitAdapter.toLowerCase() as Hex;
    const B = 6_950_000n;
    const deferred = (requested: string) => slog({ contract: "vault", event: "RedeemDeferred", block: B, logIndex: 5, args: { key: KEY, user: USER, requested } });
    const deposited = (block: bigint) => slog({ contract: "vault", event: "Deposited", block, logIndex: 1, args: { key: block === B ? KEY : `0x${"99".repeat(32)}`, user: USER, assets: String(E18), shares: String(E18) } });
    const bit = (canSendPayouts: boolean) =>
      reading(6_960_000n, 1_800_000_000, { stakes: {}, alpha: {}, payoutBatches: {}, price: E18, primaryBridge: PRIMARY, rails: { [PRIMARY]: { canSendPayouts } } } as unknown as BitState);
    const run = (logs: StoredLog[], canSend = true) => {
      const c = ruleCtx({ cfg: cfg32, logs: logQuery(logs), newUids: new Set(logs.map((l) => l.uid)) });
      return vaultEvents.run({ ...c, snap: { ...c.snap, bittensor: bit(canSend) } }).find((f) => f.facts.event === "vault RedeemDeferred")?.facts["why (the likely cause)"];
    };
    const big = String(E18);
    expect(run([deferred(big)], false)).toBe("the vault's bridge can't send payouts now (rail.payouts_closed): every front-door redeem is deferred meanwhile");
    expect(run([deposited(B), deferred(big)])).toBe("the one-day hold: the holder deposited in the same batch");
    expect(run([deposited(B - 3_600n), deferred(big)])).toBe("the one-day hold: the holder deposited about 12 hours before");
    // a deposit past the hold's day is no hold
    expect(run([deposited(B - 7_201n), deferred(big)])).toBe("the day's unstake allowance or the entry limit spent (the event names no cause; see outflow.near_limit)");
    // under 0.03 TAO at the price read
    expect(run([deferred(String(2n * 10n ** 16n))])).toBe("the request was worth less than the 0.03 TAO minimum at the price read");
    const line = RUNBOOK["vault.events"]({ event: "vault RedeemDeferred", contracts: "v3.2" });
    expect(line).toMatch(/one-day hold/);
    expect(line).toMatch(/rail\.payouts_closed/);
    expect(line).toMatch(/nothing is taken/);
  });
});
