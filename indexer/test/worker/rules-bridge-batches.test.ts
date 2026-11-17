import { type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery, type RuleCtx, utc } from "../../src/rules/context.ts";
import { bridgeBatches, bridgeCushionLow, bridgeParked, bridgeRefundsAndDrops, bridgeRetireBlocked, CUSHION_LOW_DIVISOR, parkedTokensDuringMigration } from "../../src/rules/bridge.ts";
import { RULES } from "../../src/rules/ids.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import type { BitAdapterState, BitState } from "../../src/snapshot.ts";
import type { BatchCheckRow, BatchCheckWrite } from "../../src/store.ts";
import { TICK_RULES } from "../../src/tick.ts";
import { type BatchFixture, D, h, honestBatch, parkedBatch, parkLog, withArgs } from "./bridge-fixtures.ts";
import { testConfig, testConfigV32 } from "./fixtures.ts";
import deploymentV32 from "../fixtures/deployment-v3.2.json";
import { bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";
import { checkBatch } from "../../src/crosscheck/batches.ts";
import { groupDelivered, pairSent } from "../../src/crosscheck/pairing.ts";
import { batches, stored, V3, v3Logs } from "./v3-test-fixtures.ts";
import { numberToHex, pad } from "viem";
import { type RawLog, topic0Of } from "../../src/logs.ts";

const E18 = 10n ** 18n;
const A = "0x00000000000000000000000000000000000000a1" as Hex;
const B = "0x00000000000000000000000000000000000000b2" as Hex;
const C = "0x00000000000000000000000000000000000000c3" as Hex;
const EVIL = "0x00000000000000000000000000000000000000e6" as Hex;
/** every delivery's block time, unless a test says otherwise */
const DELIVERED_AT = 1_800_000_000;
const NOW = DELIVERED_AT + 120;

const rowOf = (w: BatchCheckWrite): BatchCheckRow => ({
  batchId: w.batchId,
  deliveredKey: w.deliveredKey,
  deliveredUid: w.deliveredUid,
  deliveredTx: w.deliveredTx,
  closedTx: w.closedTx ?? null,
  messageId: w.messageId ?? null,
  expectedKey: w.expectedKey ?? null,
  status: w.status,
  detail: w.detail ?? null,
  approvedNote: null,
  approvedAt: null,
  queuedBlock: w.queuedBlock ?? null,
  payoutDoneBlock: null,
  sourceChain: w.sourceChain ?? null,
  frontDoor: w.frontDoor ?? null,
  firstSeen: w.firstSeen ?? null,
});

/** The row store.ts upsertLogs makes with a delivery's log, before any rule decides it. */
const storedRow = (b: BatchFixture): BatchCheckRow =>
  rowOf({ batchId: b.id, deliveredKey: b.key, deliveredUid: b.delivery.uid, deliveredTx: b.deliveryTx, status: "waiting", sourceChain: 8453, frontDoor: D.frontDoor });

/** A tick with Base settled `baseLag` seconds past every delivery. Every log given is stored for the
 * first time by this tick, unless `isNew` is false (all stored before) or `newUids` names them. */
function tick(
  logs: StoredLog[],
  o: { rows?: BatchCheckRow[]; baseLag?: number; nowS?: number; isNew?: boolean; newUids?: Hex[]; noTimes?: boolean; payoutDelayS?: number } = {},
): RuleCtx {
  const base = ruleCtx();
  return ruleCtx({
    nowS: o.nowS ?? NOW,
    logs: logQuery(logs),
    newUids: new Set(o.newUids ?? (o.isNew === false ? [] : logs.map((l) => l.uid))),
    checks: { batches: o.rows ?? [], chunks: [] },
    settled: { base: { block: 10n ** 9n, time: DELIVERED_AT + (o.baseLag ?? 60) }, bittensor: base.settled.bittensor },
    blockTime: (chain) => (o.noTimes ? undefined : chain === "bittensor" ? DELIVERED_AT : DELIVERED_AT - 600),
    payoutDelayS: o.payoutDelayS ?? 1800,
  });
}
const all = (...bs: BatchFixture[]) => bs.flatMap((b) => [...b.base, ...b.bit]);
const swapLast = (bit: StoredLog[], extra: StoredLog): StoredLog[] => {
  const last = bit[bit.length - 1];
  return [...bit.slice(0, -1), { ...extra, logIndex: last.logIndex }, { ...last, logIndex: last.logIndex + 1 }];
};

const deps = [
  { user: A, amount: 3n * E18 },
  { user: B, amount: E18 },
];
const reds = [{ user: C, amount: 5n * 10n ** 17n }];

describe("bridge.batch_mismatch: honest batches pass", () => {
  it("an honest batch passes, and its row records the close, the message id, the key, the queue and the source", () => {
    const b = honestBatch({ id: 43n, deposits: deps, redeems: reds });
    const c = tick(all(b));
    expect(bridgeBatches.run(c)).toEqual([]);
    expect(c.writes.batchChecks).toEqual([
      {
        batchId: 43n,
        deliveredKey: b.key,
        deliveredUid: b.delivery.uid,
        deliveredTx: b.deliveryTx,
        closedTx: b.closeTx,
        messageId: b.messageId,
        expectedKey: b.key,
        status: "ok",
        queuedBlock: b.delivery.block,
        sourceChain: 8453,
        frontDoor: D.frontDoor,
        firstSeen: NOW,
      },
    ]);
  });

  it("two honest batches closed in one transaction both pass", () => {
    const t = h("one close tx");
    const b43 = honestBatch({ id: 43n, deposits: deps, closeTx: t, closeBlock: 37_000_600n, closeAt: 0 });
    const b44 = honestBatch({ id: 44n, deposits: [{ user: C, amount: E18 }], redeems: reds, closeTx: t, closeBlock: 37_000_600n, closeAt: 2 });
    const c = tick(all(b43, b44));
    expect(bridgeBatches.run(c)).toEqual([]);
    expect(c.writes.batchChecks.map((w) => [w.batchId, w.status])).toEqual([
      [43n, "ok"],
      [44n, "ok"],
    ]);
  });

  it("two honest batches delivered in one transaction both pass", () => {
    const t = h("one delivery tx");
    const b43 = honestBatch({ id: 43n, deposits: deps, redeems: reds, deliveryTx: t, deliveryBlock: 6_900_600n });
    const b44 = honestBatch({ id: 44n, deposits: [{ user: C, amount: E18 }], deliveryTx: t, deliveryBlock: 6_900_600n, deliveryAt: b43.bit.length });
    const c = tick(all(b43, b44));
    expect(bridgeBatches.run(c)).toEqual([]);
    expect(c.writes.batchChecks.map((w) => [w.batchId, w.status, w.queuedBlock])).toEqual([
      [43n, "ok", 6_900_600n],
      [44n, "ok", undefined],
    ]);
  });
});

describe("bridge.batch_mismatch: no delivery skips its check", () => {
  it("a delivery a re-read found late, far below the blocks settled before, is checked", () => {
    const b = honestBatch({ id: 43n, deposits: deps, deliveryBlock: 6_000_000n });
    const c = tick(all(b));
    bridgeBatches.run(c);
    expect(c.writes.batchChecks.map((w) => [w.deliveredUid, w.status])).toEqual([[b.delivery.uid, "ok"]]);
  });

  it("a delivery whose row was stored with its log but never decided (a rule failed) is checked on a later tick", () => {
    const b = honestBatch({ id: 43n, deposits: deps });
    const c = tick(all(b), { rows: [storedRow(b)], isNew: false });
    expect(bridgeBatches.run(c)).toEqual([]);
    expect(c.writes.batchChecks.map((w) => [w.deliveredUid, w.status])).toEqual([[b.delivery.uid, "ok"]]);
  });

  it("a delivery stored before, whose row isn't loaded, is left alone rather than decided twice", () => {
    const b = honestBatch({ id: 43n, deposits: deps });
    const c = tick(all(b), { isNew: false });
    expect(bridgeBatches.run(c)).toEqual([]);
    expect(c.writes.batchChecks).toEqual([]);
  });
});

describe("bridge.batch_mismatch: waiting", () => {
  it("waits while Base isn't settled past the delivery's time, then judges", () => {
    const b = honestBatch({ id: 43n, deposits: deps });
    const first = tick(all(b), { baseLag: -1 });
    expect(bridgeBatches.run(first)).toEqual([]);
    expect(first.writes.batchChecks.map((w) => [w.status, w.firstSeen])).toEqual([["waiting", NOW]]);
    // the next tick: the row is open, the delivery no longer new
    const next = tick(all(b), { rows: first.writes.batchChecks.map(rowOf), isNew: false });
    expect(bridgeBatches.run(next)).toEqual([]);
    expect(next.writes.batchChecks.map((w) => w.status)).toEqual(["ok"]);
  });

  it("warns that a check is stuck 60 minutes after its delivery, naming checks:approve", () => {
    const b = honestBatch({ id: 43n, deposits: deps });
    const rows = tick(all(b), { baseLag: -1 });
    bridgeBatches.run(rows);
    const waiting = rows.writes.batchChecks.map(rowOf);
    expect(bridgeBatches.run(tick(all(b), { rows: waiting, isNew: false, baseLag: -1, nowS: DELIVERED_AT + 3599 }))).toEqual([]);
    const late = tick(all(b), { rows: waiting, isNew: false, baseLag: -1, nowS: DELIVERED_AT + 3600 });
    const [f] = bridgeBatches.run(late);
    expect(f).toMatchObject({ rule: "bridge.check_stuck", key: `bridge.check_stuck:43:${b.key}` });
    expect(f.facts.key).toBe(b.key);
    // still waiting: nothing to write
    expect(late.writes.batchChecks).toEqual([]);
  });

  it("times a stuck check from when its row was first seen when the delivery's block time is never fetched", () => {
    const b = honestBatch({ id: 43n, deposits: deps });
    // a row stored with its log has no first-seen time yet: the rule gives it one
    const first = tick(all(b), { rows: [storedRow(b)], isNew: false, noTimes: true });
    expect(bridgeBatches.run(first)).toEqual([]);
    expect(first.writes.batchChecks.map((w) => [w.status, w.firstSeen])).toEqual([["waiting", NOW]]);
    const rows = first.writes.batchChecks.map(rowOf);
    expect(bridgeBatches.run(tick(all(b), { rows, isNew: false, noTimes: true, nowS: NOW + 3599 }))).toEqual([]);
    const late = tick(all(b), { rows, isNew: false, noTimes: true, nowS: NOW + 3600 });
    expect(bridgeBatches.run(late).map((f) => f.rule)).toEqual(["bridge.check_stuck"]);
    expect(late.writes.batchChecks).toEqual([]);
    // and a row whose delivery log isn't loaded at all is timed the same way
    expect(bridgeBatches.run(tick([], { rows, nowS: NOW + 3600 })).map((f) => f.rule)).toEqual(["bridge.check_stuck"]);
  });
});

describe("bridge.batch_mismatch: each step", () => {
  const b = () => honestBatch({ id: 43n, deposits: deps, redeems: reds });
  const mismatch = (logs: StoredLog[], o: { payoutDelayS?: number } = {}) => {
    const c = tick(logs, o);
    const found = bridgeBatches.run(c);
    expect(c.writes.batchChecks.map((w) => w.status)).toEqual(["mismatch"]);
    expect(found.map((f) => f.rule)).toEqual(["bridge.batch_mismatch"]);
    return { f: found[0], row: c.writes.batchChecks[0] };
  };

  it("an amount that differs from totalDeposits (step 2)", () => {
    const x = b();
    const { f, row } = mismatch([...x.base, ...x.bit.map((l) => (l.uid === x.delivery.uid ? withArgs(l, { amount: String(4n * E18 + 1n) }) : l))]);
    expect(f.facts.step).toMatch(/^2/);
    expect(f.hold?.id).toBe(`bridge.batch:43:${x.key}`);
    expect(f.key).toBe(`bridge.batch:43:${x.key}`);
    expect(row.detail).toContain("totalDeposits");
  });

  it("no BatchClosed for the batch id (step 2)", () => {
    const x = b();
    expect(mismatch([...x.base.filter((l) => l.event !== "BatchClosed"), ...x.bit]).f.facts.step).toMatch(/^2/);
  });

  it("one more redeem outcome than nRedeems (step 3)", () => {
    const x = b();
    const extra = withArgs(x.bit.find((l) => l.event === "Redeemed")!, { user: EVIL });
    expect(mismatch([...x.base, ...swapLast(x.bit, { ...extra, uid: h("extra"), event: "RedeemSkipped" })]).f.facts.step).toMatch(/^3/);
  });

  it("a message id the Base adapter never sent (step 4)", () => {
    const x = b();
    const bit = x.bit.map((l) => (l.event === "Delivered" ? withArgs(l, { messageId: h("never sent") }) : l));
    expect(mismatch([...x.base, ...bit]).f.facts.step).toMatch(/^4/);
  });

  it("a key that isn't the replayed batch's (step 5)", () => {
    const x = b();
    // the front door took B's deposit before A's: the message it built isn't the one delivered
    const base = x.base.map((l) => (l.event === "DepositRequested" ? { ...l, logIndex: 1 - l.logIndex } : l));
    const { f, row } = mismatch([...base, ...x.bit]);
    expect(f.facts.step).toMatch(/^5/);
    expect(row.expectedKey).toBeDefined();
    expect(row.expectedKey).not.toBe(x.key);
  });

  it("can't rebuild: a cancel the replay has no entry for (step 5, worded so)", () => {
    const x = b();
    const cancel = { ...x.base[0], uid: h("cancel"), event: "DepositCancelled", logIndex: 50, args: { batchId: "43", user: EVIL, amount: "1" } };
    const { f } = mismatch([...x.base, cancel, ...x.bit]);
    expect(f.facts.step).toMatch(/^5/);
    expect(f.subject).toContain("can't rebuild");
  });

  it("a deposit outcome naming another user (step 6)", () => {
    const x = b();
    const bit = x.bit.map((l) => (l.event === "Deposited" && l.args.user === B ? withArgs(l, { user: EVIL }) : l));
    expect(mismatch([...x.base, ...bit]).f.facts.step).toMatch(/^6/);
  });

  it("a burned redeem above its request (step 6)", () => {
    const x = b();
    const bit = x.bit.map((l) => (l.event === "Redeemed" ? withArgs(l, { shares: String(5n * 10n ** 17n + 1n) }) : l));
    expect(mismatch([...x.base, ...bit]).f.facts.step).toMatch(/^6/);
  });

  it("the email facts carry the cancel deadline: queued time + payoutDelay, in UTC", () => {
    const x = b();
    const { f } = mismatch([...x.base, ...x.bit.map((l) => (l.uid === x.delivery.uid ? withArgs(l, { amount: "1" }) : l))]);
    expect(f.facts.deadline).toBe(`${new Date((DELIVERED_AT + 1800) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(f.facts.side).toBe("bittensor");
  });

  it("a payoutDelay that isn't a number still reports the mismatch, without a deadline", () => {
    const x = b();
    const { f } = mismatch([...x.base, ...x.bit.map((l) => (l.uid === x.delivery.uid ? withArgs(l, { amount: "1" }) : l))], { payoutDelayS: Number.NaN });
    expect(f.facts.deadline).toBeUndefined();
    expect(f.hold?.id).toBe(`bridge.batch:43:${x.key}`);
  });
});

describe("bridge.duplicate and ccip.unexpected_source, vault side", () => {
  it("a forged delivery reusing an honest batch id can't block it, and the duplicate still holds", () => {
    // the forger delivers "batch 43" before the front door has even closed it
    const forged = honestBatch({ id: 43n, deposits: [{ user: EVIL, amount: E18 }], deliveryTx: h("forged tx"), deliveryBlock: 6_900_100n, messageId: h("forged") });
    const t1 = tick(forged.bit);
    const first = bridgeBatches.run(t1);
    expect(t1.writes.batchChecks.map((w) => [w.deliveredKey, w.status])).toEqual([[forged.key, "mismatch"]]);
    expect(first.map((f) => f.rule)).toEqual(["bridge.batch_mismatch"]);
    // the honest batch 43 closes and is delivered later
    const honest = honestBatch({ id: 43n, deposits: deps, redeems: reds });
    const t2 = tick([...forged.bit, ...all(honest)], { rows: t1.writes.batchChecks.map(rowOf), newUids: all(honest).map((l) => l.uid) });
    const second = bridgeBatches.run(t2);
    expect(t2.writes.batchChecks.map((w) => [w.deliveredKey, w.status])).toEqual([[honest.key, "ok"]]);
    const dup = second.find((f) => f.rule === "bridge.duplicate");
    expect(dup?.key).toBe("bridge.duplicate:batch:43:2");
    expect(dup?.hold?.id).toBe(dup?.key);
    expect(dup?.facts.side).toBe("bittensor");
    expect(second.filter((f) => f.rule === "bridge.batch_mismatch")).toEqual([]);
  });

  it("two deliveries of one batch id decided in one tick raise one duplicate", () => {
    const one = honestBatch({ id: 43n, deposits: deps });
    const two = honestBatch({ id: 43n, deposits: [{ user: EVIL, amount: E18 }], deliveryTx: h("second"), deliveryBlock: 6_900_900n, messageId: h("m2") });
    const found = bridgeBatches.run(tick([...all(one), ...two.bit]));
    expect(found.filter((f) => f.rule === "bridge.duplicate").map((f) => f.key)).toEqual(["bridge.duplicate:batch:43:2"]);
  });

  it("a second delivery a re-read found late is still a duplicate", () => {
    const one = honestBatch({ id: 43n, deposits: deps });
    const t1 = tick(all(one));
    bridgeBatches.run(t1);
    const late = honestBatch({ id: 43n, deposits: [{ user: EVIL, amount: E18 }], deliveryTx: h("late"), deliveryBlock: 6_000_000n, messageId: h("m late") });
    const found = bridgeBatches.run(tick([...all(one), ...late.bit], { rows: t1.writes.batchChecks.map(rowOf), newUids: late.bit.map((l) => l.uid) }));
    expect(found.filter((f) => f.rule === "bridge.duplicate").map((f) => f.key)).toEqual(["bridge.duplicate:batch:43:2"]);
  });

  it("a delivery from another front door is an unexpected source, with a hold and a mismatch row (never ok)", () => {
    const x = honestBatch({ id: 43n, deposits: deps });
    const other = "0x00000000000000000000000000000000000000f0";
    const bit = x.bit.map((l) => (l.event === "BatchDelivered" ? withArgs(l, { frontDoor: other }) : l.event === "Delivered" ? withArgs(l, { sender: other }) : l));
    const c = tick([...x.base, ...bit]);
    const found = bridgeBatches.run(c);
    expect(found.map((f) => [f.rule, f.key])).toEqual([["ccip.unexpected_source", `ccip.unexpected_source:bittensor:${x.deliveryTx}`]]);
    expect(found[0].hold?.id).toBe(found[0].key);
    expect(found[0].facts).toMatchObject({ side: "bittensor", sender: other });
    expect(c.writes.batchChecks.map((w) => [w.status, w.frontDoor])).toEqual([["mismatch", other]]);
    expect(c.writes.batchChecks[0].detail).toMatch(/^1: the source/);
  });

  it("a delivery from Base's chain but another sender id is an unexpected source too", () => {
    const x = honestBatch({ id: 43n, deposits: deps });
    const bit = x.bit.map((l) => (l.event === "BatchDelivered" ? withArgs(l, { sourceChain: "1" }) : l));
    expect(bridgeBatches.run(tick([...x.base, ...bit])).map((f) => f.rule)).toEqual(["ccip.unexpected_source"]);
  });

  it("an unexpected source a re-read found late, from its stored row or its adapter Delivered, is still reported", () => {
    const x = honestBatch({ id: 43n, deposits: deps, deliveryBlock: 6_000_000n });
    const other = "0x00000000000000000000000000000000000000f0";
    const foreign = x.bit.map((l) => (l.event === "BatchDelivered" ? withArgs(l, { frontDoor: other }) : l));
    const row = { ...storedRow(x), frontDoor: other as Hex };
    const fromRow = bridgeBatches.run(tick([...x.base, ...foreign], { rows: [row], isNew: false }));
    expect(fromRow.map((f) => f.rule)).toEqual(["ccip.unexpected_source"]);
    const adapterOnly = x.bit.map((l) => (l.event === "Delivered" ? withArgs(l, { sender: other }) : l)).filter((l) => l.event === "Delivered");
    expect(bridgeBatches.run(tick(adapterOnly)).map((f) => f.key)).toEqual([`ccip.unexpected_source:bittensor:${x.deliveryTx}`]);
  });

  it("checks a delivery once: one already checked isn't checked again", () => {
    const x = honestBatch({ id: 43n, deposits: deps });
    const t1 = tick(all(x));
    bridgeBatches.run(t1);
    const t2 = tick(all(x), { rows: t1.writes.batchChecks.map(rowOf) });
    expect(bridgeBatches.run(t2)).toEqual([]);
    expect(t2.writes.batchChecks).toEqual([]);
  });
});

describe("real bytes (v3-test batches 1 and 2, recorded)", () => {
  it("pairs each close with its Sent, groups each delivery's outcomes, and passes both batches", () => {
    const { base, bittensor } = v3Logs();
    const frontDoorLogs = base.filter((l) => l.contract === "frontDoor");
    for (const b of batches.batches) {
      const closeTx = base.filter((l) => l.txHash === b.closeTx);
      const close = closeTx.find((l) => l.event === "BatchClosed");
      expect(pairSent(closeTx, { closer: "frontDoor:BatchClosed", adapter: "baseAdapter", sender: V3.frontDoor }).get(close!.uid)?.args.messageId).toBe(b.messageId);
      const deliveryTx = bittensor.filter((l) => l.txHash === b.deliveryTx);
      const [group] = groupDelivered(deliveryTx, { opener: "vault:BatchDelivered", adapter: "bitAdapter", recipient: V3.vault });
      expect(group.delivered?.args.messageId).toBe(b.messageId);
      const v = checkBatch({ d: V3, delivery: group.opener, group, frontDoorLogs, baseTx: (hash) => base.filter((l) => l.txHash === hash) });
      expect(v).toEqual({ status: "ok", closedTx: b.closeTx, messageId: b.messageId, expectedKey: b.deliveredKey });
    }
  });

  it("fails batch 1 at its key when one recorded deposit's amount is changed by a wei", () => {
    const requested = topic0Of("frontDoor", "DepositRequested");
    const one = pad(numberToHex(1n));
    let tampered = 0;
    const raws = (batches.base as RawLog[]).map((l) => {
      if (tampered > 0 || l.topics[0] !== requested || l.topics[1] !== one) return l;
      tampered++;
      // DepositRequested's data: the amount, then the payer
      const amount = BigInt(`0x${l.data.slice(2, 66)}`) + 1n;
      return { ...l, data: `0x${amount.toString(16).padStart(64, "0")}${l.data.slice(66)}` as Hex };
    });
    expect(tampered).toBe(1);
    const base = stored("base", raws);
    const { bittensor } = v3Logs();
    const b = batches.batches[0];
    const [group] = groupDelivered(
      bittensor.filter((l) => l.txHash === b.deliveryTx),
      { opener: "vault:BatchDelivered", adapter: "bitAdapter", recipient: V3.vault },
    );
    const v = checkBatch({ d: V3, delivery: group.opener, group, frontDoorLogs: base.filter((l) => l.contract === "frontDoor"), baseTx: (hash) => base.filter((l) => l.txHash === hash) });
    expect(v).toMatchObject({ status: "mismatch", step: "5: the batch's key", closedTx: b.closeTx, messageId: b.messageId });
    expect(v.expectedKey).not.toBe(b.deliveredKey);
  });
});

// ---- v3.2 (Task 56): the parks ----

describe("v3.2: the parks (bridge.parked and its kin)", () => {
  const CFG32 = testConfigV32();
  const KEY = h("a park key");
  const MSG = h("a park's message");
  const PARKED_AT = 1_800_000_000;
  const PARK_BLOCK = 6_900_500n;
  const STRANGER = "0x00000000000000000000000000000000000000e7" as Hex;
  const SECOND_BIT = "0x2222222222222222222222222222222222222222" as Hex;
  const ADAPTER = D.bitAdapter;
  const park = (o: Partial<Parameters<typeof parkLog>[1]> = {}) => parkLog("BatchParked", { key: KEY, block: PARK_BLOCK, messageId: MSG, amount: 3n * E18, ...o });
  /** A v3.2 tick: Bittensor settled to `settledBlock` (default 100 blocks past the park) at PARKED_AT + `age` s. */
  function ptick(
    logs: StoredLog[],
    o: { age?: number; settledBlock?: bigint; noTimes?: boolean; bit?: Partial<BitState>; noReading?: boolean; meta?: Record<string, string>; newUids?: Hex[]; cfg?: Config } = {},
  ): RuleCtx {
    const base = ruleCtx({ cfg: o.cfg ?? CFG32 });
    const at = PARKED_AT + (o.age ?? 0);
    return ruleCtx({
      cfg: o.cfg ?? CFG32,
      nowS: at + 30,
      logs: logQuery(logs),
      newUids: new Set(o.newUids ?? logs.map((l) => l.uid)),
      snap: { ...base.snap, bittensor: o.noReading ? undefined : reading(o.settledBlock ?? PARK_BLOCK + 100n, at, bitState(o.bit ?? {})) },
      settled: { base: base.settled.base, bittensor: { block: o.settledBlock ?? PARK_BLOCK + 100n, time: at } },
      blockTime: (chain, block) => (o.noTimes ? undefined : chain === "bittensor" && block === PARK_BLOCK ? PARKED_AT : PARKED_AT + 60),
      meta: o.meta ?? {},
    });
  }
  const marks = (c: RuleCtx) => c.unjudged.map((u) => u.key ?? u.rule);
  const metaOf = (c: RuleCtx) => Object.fromEntries(c.writes.meta.map((w) => [w.k, w.v]));
  const totals = (over: Partial<BitAdapterState> = {}): Partial<BitState> => ({
    adapters: { [ADAPTER]: { balance: 3n * E18 + 10n ** 15n, tokens: 10n ** 15n, parkedNative: 3n * E18, parkedTokens: 0n, reserveTarget: 10n ** 15n, tokenReserveTarget: 10n ** 15n, tokenCushion: 10n ** 15n, ...over } },
  });

  describe("bridge.parked", () => {
    it("is critical once a front-door batch has been parked for an hour by the settled history, naming why, how it is held, and when it can be refunded", () => {
      expect(RULES["bridge.parked"]).toMatchObject({ tier: "critical", kind: "condition", canHold: false });
      const p = park();
      expect(bridgeParked.run(ptick([p], { age: 3599, bit: totals() }))).toEqual([]);
      const [f] = bridgeParked.run(ptick([p], { age: 3600, bit: totals() }));
      expect(f).toMatchObject({ rule: "bridge.parked", key: `bridge.parked:${ADAPTER}:${KEY}:${p.uid}`, subject: "A front-door batch of 3 TAO has been parked in the Bittensor adapter for 60 minutes" });
      expect(f.facts).toMatchObject({
        adapter: ADAPTER,
        key: KEY,
        amount: "3 TAO",
        "held as": "native TAO (the vault refused it)",
        why: "the vault refused it: stake is missing (StakeMissing)",
        "parked at": utc(PARKED_AT),
        "refundable from": utc(PARKED_AT + 14 * 86_400),
        ccip: `https://ccip.chain.link/msg/${MSG}`,
        transaction: `https://evm.taostats.io/tx/${p.txHash}`,
      });
      const line = RUNBOOK["bridge.parked"](f.facts);
      expect(line).toContain("deliverParked");
      expect(line).toContain("refundParked");
    });

    it("keeps a converted park parked (now native TAO), and is quiet once it is delivered, refunded or dropped", () => {
      const tokens = park({ converted: false, reason: keccak256(toBytes("ConversionShort()")).slice(0, 10) as Hex });
      const conv = parkLog("ParkedConverted", { key: KEY, block: PARK_BLOCK + 10n });
      expect(bridgeParked.run(ptick([tokens], { age: 7200 }))[0].facts["held as"]).toBe("tokens (wTAO: the conversion failed)");
      const [f] = bridgeParked.run(ptick([tokens, conv], { age: 7200 }));
      expect(f.facts).toMatchObject({ "held as": "native TAO (converted; its recipient refused it since)", why: "the conversion came out short with the native reserve empty (ConversionShort)" });
      for (const end of ["ParkedDelivered", "ParkedRefunded", "ParkedDropped"] as const) {
        expect(bridgeParked.run(ptick([tokens, conv, parkLog(end, { key: KEY, block: PARK_BLOCK + 20n })], { age: 7200 })), end).toEqual([]);
      }
      // parked again after it ended (the same batch delivered again): a new park, timed from its own BatchParked
      const again = park({ block: PARK_BLOCK + 30n });
      const c = ptick([tokens, parkLog("ParkedDelivered", { key: KEY, block: PARK_BLOCK + 20n }), again], { age: 7200 });
      expect(bridgeParked.run(c).map((x) => x.key)).toEqual([`bridge.parked:${ADAPTER}:${KEY}:${again.uid}`]);
    });

    it("tells a park's age by its block when its time isn't known, at Bittensor's block time as measured (12 s; 6 s, an hour is 600 blocks)", () => {
      const p = park();
      expect(bridgeParked.run(ptick([p], { noTimes: true, settledBlock: PARK_BLOCK + 299n }))).toEqual([]);
      expect(bridgeParked.run(ptick([p], { noTimes: true, settledBlock: PARK_BLOCK + 300n })).map((f) => f.rule)).toEqual(["bridge.parked"]);
      const at6 = (settledBlock: bigint) => bridgeParked.run({ ...ptick([p], { noTimes: true, settledBlock }), blockS: { base: 0.2, bittensor: 6 } });
      expect(at6(PARK_BLOCK + 599n)).toEqual([]);
      expect(at6(PARK_BLOCK + 600n).map((f) => f.rule)).toEqual(["bridge.parked"]);
    });

    it("is a warning, once, for a stranger's park (another sender, or another recipient: R3 A-L2), never the critical", () => {
      expect(RULES["bridge.parked_stranger"]).toMatchObject({ tier: "warning", kind: "event" });
      const s = park({ sender: STRANGER });
      const [f] = bridgeParked.run(ptick([s], { age: 100_000 }));
      expect(f).toMatchObject({ rule: "bridge.parked_stranger", key: `bridge.parked_stranger:${s.uid}`, subject: "Someone else's batch parked in the Bittensor adapter" });
      expect(f.facts).toMatchObject({ sender: STRANGER, recipient: D.vault, amount: "3 TAO" });
      expect(bridgeParked.run(ptick([s], { age: 100_000, newUids: [] }))).toEqual([]);
      expect(bridgeParked.run(ptick([park({ recipient: STRANGER })], { age: 100_000 })).map((x) => x.rule)).toEqual(["bridge.parked_stranger"]);
    });

    it("is critical when an adapter owes its parks more than the parks seen, for an hour (a BatchParked the logs missed); unjudged while its totals are unread", () => {
      // owes 5 TAO, the parks seen owe 3
      const owing = totals({ parkedNative: 5n * E18 });
      const first = ptick([park()], { age: 60, bit: owing });
      expect(bridgeParked.run(first)).toEqual([]);
      expect(metaOf(first)).toEqual({ [`parks_unseen_since:${ADAPTER}`]: String(PARKED_AT + 90) });
      const later = ptick([park()], { age: 60, bit: owing, meta: { [`parks_unseen_since:${ADAPTER}`]: String(PARKED_AT + 90 - 3600) } });
      const [f] = bridgeParked.run(later);
      expect(f).toMatchObject({ rule: "bridge.parked", key: `bridge.parked:${ADAPTER}:unseen`, subject: "The Bittensor adapter owes 2 TAO more to its parks than the parks the monitor has seen" });
      expect(f.facts).toMatchObject({ unseen: "2 TAO", "it owes": "5 TAO as native TAO, 0 TAO as tokens", "the parks seen": "3 TAO" });
      // the totals agree: the mark is cleared
      const ok = ptick([park()], { age: 60, bit: totals(), meta: { [`parks_unseen_since:${ADAPTER}`]: "1" } });
      expect(bridgeParked.run(ok)).toEqual([]);
      expect(metaOf(ok)).toEqual({ [`parks_unseen_since:${ADAPTER}`]: "" });
      // unread: unjudged (the open alert kept), never quiet
      for (const c of [ptick([], { noReading: true }), ptick([], { bit: totals({ parkedNative: undefined }) })]) {
        expect(bridgeParked.run(c)).toEqual([]);
        expect(marks(c)).toEqual([`bridge.parked:${ADAPTER}:unseen`]);
      }
    });

    it("is v3.2's: v3-launch has no parks", () => {
      expect(bridgeParked.run(ptick([park()], { age: 7200, cfg: testConfig() }))).toEqual([]);
    });
  });

  describe("bridge.parked_tokens_during_migration", () => {
    it("is critical at once while ForeverMoney's migration notice runs and any token park exists, naming them; unjudged while either is unread", () => {
      expect(RULES["bridge.parked_tokens_during_migration"]).toMatchObject({ tier: "critical", kind: "condition" });
      const tokens = park({ converted: false });
      /** null: migrationReadyAt unread */
      const during = (over: Partial<BitAdapterState>, ready: bigint | null = 1_900_000_000n): Partial<BitState> => ({ ...totals({ parkedNative: 0n, parkedTokens: 3n * E18, ...over }), alpha: { migrationReadyAt: ready ?? undefined } });
      const [f] = parkedTokensDuringMigration.run(ptick([tokens], { bit: during({}) }));
      expect(f).toMatchObject({ rule: "bridge.parked_tokens_during_migration", key: `bridge.parked_tokens_during_migration:${ADAPTER}`, subject: "3 TAO is parked as tokens while ForeverMoney's migration notice runs" });
      expect(f.facts).toMatchObject({ "migration ready at": utc(1_900_000_000), "parked as tokens": "3 TAO", "token parks": `${KEY}: 3 TAO` });
      expect(RUNBOOK["bridge.parked_tokens_during_migration"](f.facts)).toContain("deliverParked");
      // no notice, or no token park: nothing, and judged
      for (const bit of [during({}, 0n), during({ parkedTokens: 0n }), during({ parkedTokens: 0n }, null)]) {
        const c = ptick([tokens], { bit });
        expect(parkedTokensDuringMigration.run(c)).toEqual([]);
        expect(marks(c)).toEqual([]);
      }
      // unread: unjudged
      for (const c of [ptick([tokens], { bit: during({}, null) }), ptick([tokens], { bit: during({ parkedTokens: undefined }) }), ptick([tokens], { noReading: true })]) {
        expect(parkedTokensDuringMigration.run(c)).toEqual([]);
        expect(marks(c)).toEqual([`bridge.parked_tokens_during_migration:${ADAPTER}`]);
      }
    });
  });

  describe("bridge.cushion_low", () => {
    it("warns when the native reserve above what the adapter owes its parks, or the booked token cushion, is under half its target", () => {
      expect(RULES["bridge.cushion_low"]).toMatchObject({ tier: "warning", kind: "condition" });
      expect(CUSHION_LOW_DIVISOR).toBe(2n);
      expect(bridgeCushionLow.run(ptick([], { bit: totals() }))).toEqual([]);
      // anyone's sweepSurplus leaves exactly the reserve's target, the cushion falls a rao per shortfall it covers, and each
      // covers about a million: 1 wei under its target, or at exactly half of it, is expected, not low (review Minor 1)
      const HALF = 10n ** 15n / 2n;
      for (const over of [{ balance: 3n * E18 + 10n ** 15n - 1n }, { balance: 3n * E18 + HALF }, { tokenCushion: 10n ** 15n - 1n }, { tokenCushion: HALF }]) {
        expect(bridgeCushionLow.run(ptick([], { bit: totals(over) })), JSON.stringify(over, (_, v) => (typeof v === "bigint" ? String(v) : v))).toEqual([]);
      }
      const [n] = bridgeCushionLow.run(ptick([], { bit: totals({ balance: 3n * E18 + HALF - 1n }) }));
      expect(n).toMatchObject({ rule: "bridge.cushion_low", key: `bridge.cushion_low:${ADAPTER}`, subject: "The Bittensor adapter's native reserve is below half its target" });
      expect(n.facts).toMatchObject({
        short: "native reserve",
        "native reserve": "0.000499999999999999 TAO of 0.001 TAO (above 3 TAO owed to parks)",
        "token cushion": "0.001 TAO booked of 0.001 TAO (fundCushion; beside 0 TAO owed to parks)",
        "unbooked surplus (the sweep's)": "0 TAO",
      });
      const line = RUNBOOK["bridge.cushion_low"](n.facts);
      expect(line).toContain("fundReserve");
      expect(line).toContain("below half its target");
      expect(line).toContain("sweepSurplus");
      const [t] = bridgeCushionLow.run(ptick([], { bit: totals({ tokenCushion: HALF - 1n }) }));
      expect(t.subject).toBe("The Bittensor adapter's token cushion is below half its target");
      const [b] = bridgeCushionLow.run(ptick([], { bit: totals({ balance: 0n, tokenCushion: HALF - 1n }) }));
      expect(b.subject).toBe("The Bittensor adapter's native reserve and token cushion are below half their targets");
      const unread = ptick([], { bit: totals({ tokenCushion: undefined }) });
      expect(bridgeCushionLow.run(unread)).toEqual([]);
      expect(marks(unread)).toEqual([`bridge.cushion_low:${ADAPTER}`]);
    });

    it("the cushion is the booked tokenCushion() (R4, F-1), never the wTAO above the parks: a plain transfer is the sweep's surplus, shown as a fact", () => {
      // wTAO sent to the adapter by a plain transfer, nothing booked: the cushion is empty, the transfer surplus
      const [e] = bridgeCushionLow.run(ptick([], { bit: totals({ tokens: 5n * 10n ** 15n, tokenCushion: 0n }) }));
      expect(e.subject).toBe("The Bittensor adapter's token cushion is empty: nothing is booked by fundCushion");
      expect(e.facts).toMatchObject({ short: "token cushion", "token cushion": "0 TAO booked of 0.001 TAO (fundCushion; beside 0 TAO owed to parks)", "unbooked surplus (the sweep's)": "0.005 TAO" });
      const [both] = bridgeCushionLow.run(ptick([], { bit: totals({ balance: 0n, tokenCushion: 0n }) }));
      expect(both.subject).toBe("The Bittensor adapter's native reserve is below half its target, and its token cushion is empty: nothing is booked by fundCushion");
      // a booked cushion counts whatever the balance above the parks reads, and the surplus is what lies above both
      expect(bridgeCushionLow.run(ptick([], { bit: totals({ tokens: 3n * 10n ** 15n, parkedTokens: 10n ** 15n }) }))).toEqual([]);
      const [s] = bridgeCushionLow.run(ptick([], { bit: totals({ tokens: 3n * 10n ** 15n, parkedTokens: 10n ** 15n, balance: 0n }) }));
      expect(s.facts["unbooked surplus (the sweep's)"]).toBe("0.001 TAO");
      // the balance unread: still judged, its surplus not read
      const [u] = bridgeCushionLow.run(ptick([], { bit: totals({ tokens: undefined, tokenCushion: 0n }) }));
      expect(u.facts["unbooked surplus (the sweep's)"]).toBe("not read");
      // the line says how to book it, and that a plain transfer isn't cushion
      const line = RUNBOOK["bridge.cushion_low"](e.facts);
      expect(line).toMatch(/approve/);
      expect(line).toContain("fundCushion(amount)");
      expect(line).toMatch(/A plain transfer of wTAO is surplus/);
      // R6b (U7): a surplus never refills it, even below its target (the README's older sweep sentence said otherwise)
      expect(line).toContain("A surplus never refills the token cushion, even below its target: only fundCushion does.");
      expect(line).not.toMatch(/the token cushion with a plain transfer/);
    });
  });

  describe("bridge.refunded and bridge.dropped", () => {
    it("are warning events, once each, naming the park they end", () => {
      expect(RULES["bridge.refunded"]).toMatchObject({ tier: "warning", kind: "event" });
      expect(RULES["bridge.dropped"]).toMatchObject({ tier: "warning", kind: "event" });
      const p = park({ converted: false });
      const refund = parkLog("ParkedRefunded", { key: KEY, block: PARK_BLOCK + 9000n, messageId: h("refund") });
      const [f] = bridgeRefundsAndDrops.run(ptick([p, refund], { newUids: [refund.uid] }));
      expect(f).toMatchObject({ rule: "bridge.refunded", key: `bridge.refunded:${refund.uid}`, subject: "A parked batch of 3 TAO was refunded to its depositors on Base" });
      expect(f.facts).toMatchObject({ key: KEY, amount: "3 TAO", "held as": "tokens (wTAO: the conversion failed)", door: "yes", "refund message": `https://ccip.chain.link/msg/${h("refund")}`, "parked at": utc(PARKED_AT) });
      expect(RUNBOOK["bridge.refunded"](f.facts)).toContain("claimable");
      const empty = park({ amount: 0n });
      const drop = parkLog("ParkedDropped", { key: KEY, block: PARK_BLOCK + 9000n });
      const [d] = bridgeRefundsAndDrops.run(ptick([empty, drop], { newUids: [drop.uid] }));
      expect(d).toMatchObject({ rule: "bridge.dropped", key: `bridge.dropped:${drop.uid}`, subject: "An empty parked batch was dropped" });
      expect(RUNBOOK["bridge.dropped"](d.facts)).toContain("request again");
      // not new, or the deployment's setup: nothing
      expect(bridgeRefundsAndDrops.run(ptick([p, refund], { newUids: [] }))).toEqual([]);
      const setup = parkLog("ParkedDropped", { key: KEY, block: CFG32.deployment.bittensor.baselineBlock });
      expect(bridgeRefundsAndDrops.run(ptick([setup]))).toEqual([]);
      // a refund whose park isn't loaded still reports, saying so
      const [lone] = bridgeRefundsAndDrops.run(ptick([refund]));
      expect(lone.facts.amount).toBe("not known (its BatchParked isn't loaded)");
    });
  });

  describe("bridge.retire_blocked", () => {
    const two = testConfigV32({ BRIDGES: JSON.stringify({ base: [deploymentV32.baseAdapter], bittensor: [deploymentV32.bitAdapter, SECOND_BIT] }) });
    it("warns while a Bittensor adapter that is no longer the vault's primary bridge still holds parks", () => {
      expect(RULES["bridge.retire_blocked"]).toMatchObject({ tier: "warning", kind: "condition" });
      const bit = (primary: Hex | undefined, over: Partial<BitAdapterState> = {}): Partial<BitState> => ({ primaryBridge: primary, adapters: { ...totals(over).adapters, [SECOND_BIT.toLowerCase() as Hex]: { parkedNative: 0n, parkedTokens: 0n } } });
      const [f] = bridgeRetireBlocked.run(ptick([park()], { cfg: two, bit: bit(SECOND_BIT.toLowerCase() as Hex) }));
      expect(f).toMatchObject({ rule: "bridge.retire_blocked", key: `bridge.retire_blocked:${ADAPTER}`, subject: "A retiring Bittensor adapter still holds parks: 3 TAO" });
      expect(f.facts).toMatchObject({ adapter: ADAPTER, "the vault's primary bridge": SECOND_BIT.toLowerCase(), parked: "3 TAO as native TAO, 0 TAO as tokens", parks: `${KEY}: 3 TAO (the front door's)` });
      expect(RUNBOOK["bridge.retire_blocked"](f.facts)).toContain("refundParked");
      // the primary itself, or nothing owed: nothing
      expect(bridgeRetireBlocked.run(ptick([park()], { cfg: two, bit: bit(ADAPTER) }))).toEqual([]);
      expect(bridgeRetireBlocked.run(ptick([], { cfg: two, bit: bit(SECOND_BIT.toLowerCase() as Hex, { parkedNative: 0n }) }))).toEqual([]);
      // the primary unread, or the totals: unjudged
      const u = ptick([], { cfg: two, bit: bit(undefined) });
      expect(bridgeRetireBlocked.run(u)).toEqual([]);
      expect(marks(u)).toEqual(["bridge.retire_blocked"]);
      const t = ptick([], { cfg: two, bit: bit(SECOND_BIT.toLowerCase() as Hex, { parkedTokens: undefined }) });
      expect(bridgeRetireBlocked.run(t)).toEqual([]);
      expect(marks(t)).toEqual([`bridge.retire_blocked:${ADAPTER}`]);
    });
  });

  describe("the batch cross-check on v3.2", () => {
    const tick32 = (logs: StoredLog[], o: Parameters<typeof tick>[1] = {}): RuleCtx => ({ ...tick(logs, o), cfg: CFG32 });
    it("a stranger's message the vault refused (parked: Delivered is logged after a park) is no unexpected source; one the vault took still is", () => {
      const tx = h("a stranger's park tx");
      const delivered = (sender: Hex) =>
        slog({ contract: "bitAdapter", chain: "bittensor", address: D.bitAdapter, event: "Delivered", block: PARK_BLOCK, txHash: tx, logIndex: 1, topic1: MSG, args: { messageId: MSG, sourceChain: "8453", sender, recipient: D.vault, amount: "0" } });
      const parkedTx = park({ sender: STRANGER, txHash: tx, logIndex: 0, amount: 0n });
      expect(bridgeBatches.run(tick32([parkedTx, delivered(STRANGER)]))).toEqual([]);
      // another message's park in the same transaction doesn't excuse this one
      const otherPark = park({ sender: STRANGER, txHash: tx, logIndex: 0, amount: 0n, messageId: h("another message") });
      expect(bridgeBatches.run(tick32([otherPark, delivered(STRANGER)])).map((f) => f.rule)).toEqual(["ccip.unexpected_source"]);
      expect(bridgeBatches.run(tick32([delivered(STRANGER)])).map((f) => f.rule)).toEqual(["ccip.unexpected_source"]);
    });

    it("a batch that parked and was delivered later with deliverParked passes: its message id and route are its park's, and its park key is the replayed batch's", () => {
      const b = parkedBatch({ id: 45n, deposits: deps, redeems: reds });
      const c = tick32([...b.base, ...b.park, ...b.bit]);
      expect(bridgeBatches.run(c)).toEqual([]);
      expect(c.writes.batchChecks.map((w) => [w.status, w.messageId, w.closedTx, w.expectedKey])).toEqual([["ok", b.messageId, b.closeTx, b.key]]);
    });

    it("fails a deliverParked delivery whose park doesn't match the batch: no park seen, another message id, another route or amount, another park key (steps 4 and 5)", () => {
      const b = parkedBatch({ id: 45n, deposits: deps, redeems: reds });
      const fail = (logs: StoredLog[]) => {
        const c = tick32(logs);
        const found = bridgeBatches.run(c);
        expect(found.map((f) => f.rule)).toEqual(["bridge.batch_mismatch"]);
        return c.writes.batchChecks[0].detail;
      };
      expect(fail([...b.base, ...b.bit])).toMatch(/^4: the bridge message: no BatchParked for the park/);
      const [bp, dl] = b.park;
      expect(fail([...b.base, withArgs(bp, { messageId: h("forged") }), dl, ...b.bit])).toMatch(/^4: .*message id .* parked, .* sent/);
      expect(fail([...b.base, withArgs(bp, { sender: STRANGER }), dl, ...b.bit])).toMatch(/^4: .*front door → vault with the batch's amount/);
      expect(fail([...b.base, withArgs(bp, { amount: "1" }), dl, ...b.bit])).toMatch(/^4: .*front door → vault with the batch's amount/);
      // a park of another key closed in this transaction: its BatchParked is another batch's
      const other = parkLog("BatchParked", { key: h("another park"), block: bp.block, messageId: b.messageId, amount: 4n * E18 });
      const swapped = b.bit.map((l) => (l.event === "ParkedDelivered" ? { ...parkLog("ParkedDelivered", { key: h("another park"), block: l.block, txHash: l.txHash, logIndex: l.logIndex }) } : l));
      expect(fail([...b.base, other, ...swapped])).toMatch(/^5: the batch's key: the park's key/);
    });

    it("on v3-launch a delivery with no Delivered still fails at step 4, as before", () => {
      const b = parkedBatch({ id: 45n, deposits: deps, redeems: reds });
      const c = tick([...b.base, ...b.park, ...b.bit]);
      bridgeBatches.run(c);
      expect(c.writes.batchChecks[0].detail).toMatch(/^4: the bridge message: no Bittensor adapter Delivered/);
    });
  });

  it("every park rule runs in the tick, with a runbook line", () => {
    for (const r of [bridgeParked, parkedTokensDuringMigration, bridgeCushionLow, bridgeRefundsAndDrops, bridgeRetireBlocked]) expect(TICK_RULES).toContain(r);
    for (const id of ["bridge.parked", "bridge.parked_tokens_during_migration", "bridge.cushion_low", "bridge.refunded", "bridge.dropped", "bridge.retire_blocked", "bridge.parked_stranger"] as const) {
      expect(RUNBOOK[id]({}).length, id).toBeGreaterThan(40);
    }
  });
});

describe("R4 (the forged-message review's F-2): a forged redeem-only batch is matched against the door's requests and refused", () => {
  it("a compromised lane's redeem-only batch (no request, no close on Base; real holders' shares burned) fails at step 2: critical, a hold, and no ok row (its key never enters okKeys); the honest one passes", () => {
    const forged = honestBatch({ id: 44n, deposits: [], redeems: [{ user: A, amount: 2n * E18 }] });
    const c = tick([...forged.bit]);
    const found = bridgeBatches.run(c);
    expect(found.map((f) => [f.rule, f.facts.step?.slice(0, 1)])).toEqual([["bridge.batch_mismatch", "2"]]);
    expect(found[0].hold?.id).toBe(`bridge.batch:44:${forged.key}`);
    expect(RULES["bridge.batch_mismatch"]).toMatchObject({ tier: "critical", canHold: true });
    expect(c.writes.batchChecks.map((w) => w.status)).toEqual(["mismatch"]);
    // the same batch with its requests and close on Base: ok
    const honest = honestBatch({ id: 45n, deposits: [], redeems: [{ user: A, amount: 2n * E18 }] });
    const h2 = tick(all(honest));
    expect(bridgeBatches.run(h2)).toEqual([]);
    expect(h2.writes.batchChecks.map((w) => w.status)).toEqual(["ok"]);
  });
});
