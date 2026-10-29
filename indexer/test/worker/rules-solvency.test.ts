import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import { depositsBounced, frontDoorSolvency, vaultEvents, vaultSolvency } from "../../src/rules/solvency.ts";
import type { BaseState, BitState, ChainReading } from "../../src/snapshot.ts";
import { baseState, bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";

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
  });
});
