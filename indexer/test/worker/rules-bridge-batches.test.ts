import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import { bridgeBatches } from "../../src/rules/bridge.ts";
import type { BatchCheckRow, BatchCheckWrite } from "../../src/store.ts";
import { type BatchFixture, D, h, honestBatch, withArgs } from "./bridge-fixtures.ts";
import { ruleCtx } from "./rule-ctx.ts";

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
