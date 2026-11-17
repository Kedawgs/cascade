import { encodeAbiParameters, getAddress, type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import { groupDelivered } from "../../src/crosscheck/pairing.ts";
import { checkPayout, chunkEntries, deliveredChecks, encodePayoutsMessage, payoutList } from "../../src/crosscheck/payouts.ts";
import { chunk, V3, v3Logs } from "./v3-test-fixtures.ts";
import type { StoredLog } from "../../src/logs.ts";
import { bridgePayouts } from "../../src/rules/bridge.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import type { Snapshot } from "../../src/snapshot.ts";
import type { ChunkCheckRow, ChunkCheckWrite } from "../../src/store.ts";
import { D, h, type PayoutEntry, type PayoutFixture, parkedBatch, parkLog, payoutBatch, withArgs } from "./bridge-fixtures.ts";
import { REFUND_CHUNK } from "../../src/parks.ts";
import { testConfig, testConfigV32 } from "./fixtures.ts";
import { ruleCtx, slog } from "./rule-ctx.ts";

const E18 = 10n ** 18n;
const A = "0x00000000000000000000000000000000000000a1" as Hex;
const B = "0x00000000000000000000000000000000000000b2" as Hex;
const C = "0x00000000000000000000000000000000000000c3" as Hex;
const EVIL = "0x00000000000000000000000000000000000000e6" as Hex;
const SECOND = "0x89ed499783Be6bD00724Cb268224E727B26731a5" as Hex;
const LANDED_AT = 1_800_000_000;
const KEY = h("payout key");
const FEE = 10n ** 15n;

const list: PayoutEntry[] = [
  { user: A, shares: 0n, assets: 2n * E18 },
  { user: B, shares: 5n, assets: E18 },
  { user: C, shares: 7n, assets: 3n * E18 },
];

const ENTRIES = { type: "tuple[]", components: [{ name: "user", type: "address" }, { name: "amount", type: "uint256" }] } as const;
const hashOf = (key: Hex, chunk: number, entries: { user: Hex; amount: bigint }[]) =>
  keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "uint32" }, ENTRIES], [2, key, chunk, entries]));

const rowOf = (w: ChunkCheckWrite): ChunkCheckRow => ({
  landedUid: w.landedUid,
  batchKey: w.batchKey,
  chunk: w.chunk,
  landedTx: w.landedTx,
  landedBlock: w.landedBlock,
  sentTx: w.sentTx ?? null,
  messageId: w.messageId ?? null,
  expectedHash: w.expectedHash ?? null,
  status: w.status,
  detail: w.detail ?? null,
  firstSeen: w.firstSeen ?? null,
});

/** A tick at LANDED_AT (unless `nowS`), with Bittensor settled `bitLag` seconds past every landing. */
function tick(
  logs: StoredLog[],
  o: { rows?: ChunkCheckRow[]; reads?: Snapshot["deliveredReads"]; cfg?: Config; bitLag?: number; fresh?: boolean; newUids?: Hex[]; nowS?: number; noTimes?: boolean } = {},
): RuleCtx {
  const base = ruleCtx();
  return ruleCtx({
    cfg: o.cfg ?? testConfig(),
    nowS: o.nowS ?? LANDED_AT,
    logs: logQuery(logs),
    // every log given is first stored by this tick, unless `fresh` is false or `newUids` names them
    newUids: new Set(o.newUids ?? (o.fresh === false ? [] : logs.map((l) => l.uid))),
    snap: { ...base.snap, deliveredReads: o.reads ?? [] },
    checks: { batches: [], chunks: o.rows ?? [] },
    settled: { base: base.settled.base, bittensor: { block: 10n ** 9n, time: LANDED_AT + (o.bitLag ?? 60) } },
    blockTime: (chain) => (o.noTimes ? undefined : chain === "base" ? LANDED_AT : LANDED_AT - 900),
  });
}
const all = (...ps: PayoutFixture[]) => ps.flatMap((p) => [...p.bit, ...p.base]);
const read = (landing: StoredLog, value: boolean, block = landing.block) => ({ landedUid: landing.uid, key: String(landing.args.batchKey) as Hex, chunk: Number(landing.args.chunk), block, value });

describe("bridge.payout_mismatch: honest chunks pass", () => {
  it("two chunks of one batch (the second's cursor is the first's taken) await their read, then pass", () => {
    const p = payoutBatch({ key: KEY, list, chunks: [{ taken: 2, fee: FEE }, { taken: 1, fee: FEE }] });
    const first = tick(all(p));
    expect(bridgePayouts.run(first)).toEqual([]);
    expect(first.writes.chunkChecks).toEqual(
      p.chunks.map((c) => ({
        landedUid: c.landing!.uid,
        batchKey: KEY,
        chunk: c.chunk,
        landedTx: c.landTx,
        landedBlock: c.landing!.block,
        sentTx: c.chunkTx,
        messageId: c.messageId,
        expectedHash: hashOf(KEY, c.chunk, c.entries),
        status: "awaiting_read",
        firstSeen: LANDED_AT,
      })),
    );
    expect(p.chunks[1].entries.map((e) => e.user)).toEqual([C]);
    const next = tick(all(p), { rows: first.writes.chunkChecks.map(rowOf), fresh: false, reads: p.chunks.map((c) => read(c.landing!, true)) });
    expect(bridgePayouts.run(next)).toEqual([]);
    expect(next.writes.chunkChecks.map((w) => [w.chunk, w.status])).toEqual([
      [0, "ok"],
      [1, "ok"],
    ]);
  });

  it("two chunks of different keys paid out in one transaction both pass", () => {
    const t = h("one payout tx");
    const a = payoutBatch({ key: h("key a"), list: list.slice(0, 1), chunks: [{ taken: 1, fee: FEE }], chunkTx: t });
    const b = payoutBatch({ key: h("key b"), list: list.slice(1), chunks: [{ taken: 2, fee: FEE }], chunkTx: t, chunkAt: 2 });
    const c = tick(all(a, b));
    expect(bridgePayouts.run(c)).toEqual([]);
    expect(c.writes.chunkChecks.map((w) => w.status)).toEqual(["awaiting_read", "awaiting_read"]);
  });

  it("two landings in one transaction both pass, each PayoutReceived list filtered by key and chunk", () => {
    const t = h("one landing tx");
    const a = payoutBatch({ key: h("key a"), list, chunks: [{ taken: 3, fee: FEE }], landTx: t });
    const b = payoutBatch({ key: h("key b"), list: list.slice(1), chunks: [{ taken: 2, fee: FEE }], landTx: t, landAt: a.base.length });
    const c = tick(all(a, b));
    expect(bridgePayouts.run(c)).toEqual([]);
    expect(c.writes.chunkChecks.map((w) => [w.batchKey, w.status])).toEqual([
      [h("key a"), "awaiting_read"],
      [h("key b"), "awaiting_read"],
    ]);
  });

  it("waits until Bittensor is settled past the landing", () => {
    const p = payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE }] });
    const c = tick(all(p), { bitLag: -1 });
    expect(bridgePayouts.run(c)).toEqual([]);
    expect(c.writes.chunkChecks.map((w) => w.status)).toEqual(["waiting"]);
    const next = tick(all(p), { rows: c.writes.chunkChecks.map(rowOf), fresh: false });
    bridgePayouts.run(next);
    expect(next.writes.chunkChecks.map((w) => w.status)).toEqual(["awaiting_read"]);
  });

  it("a second bridge added to BRIDGES passes", () => {
    const cfg = testConfig({ BRIDGES: JSON.stringify({ base: [getAddress(D.baseAdapter), SECOND], bittensor: [getAddress(D.bitAdapter)] }) });
    const p = payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE }], bridge: SECOND.toLowerCase() as Hex });
    const c = tick(all(p), { cfg });
    expect(bridgePayouts.run(c)).toEqual([]);
    expect(c.writes.chunkChecks.map((w) => w.status)).toEqual(["awaiting_read"]);
  });

  it("a PayoutChunkSent with net = 0 expects no landing", () => {
    const dust: PayoutEntry[] = [...list, { user: EVIL, shares: 1n, assets: 900_000_000n }];
    const p = payoutBatch({ key: KEY, list: dust, chunks: [{ taken: 3, fee: FEE }, { taken: 1, fee: FEE }] });
    expect(p.chunks[1].net).toBe(0n);
    const c = tick(all(p));
    expect(bridgePayouts.run(c)).toEqual([]);
    expect(c.writes.chunkChecks.map((w) => [w.chunk, w.status])).toEqual([[0, "awaiting_read"]]);
  });
});

describe("bridge.payout_mismatch: v3.2's chunks", () => {
  const cfg32 = testConfigV32();

  it("a chunk's entries bear what they were charged plus the walk's unstake cost, not the fee the bridge was paid, and pass", () => {
    // the fee is the quote: 0.0005 TAO above the ceiling was the caller's top-up, so the entries paid `charged`, and the
    // walk's cost (what the chain kept, 3 rao) on top
    const p = payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE + 5n * 10n ** 14n, charged: FEE, unstakeCost: 3n * 10n ** 9n }] });
    const c = tick(all(p), { cfg: cfg32 });
    expect(bridgePayouts.run(c)).toEqual([]);
    expect(c.writes.chunkChecks.map((w) => [w.status, w.expectedHash])).toEqual([["awaiting_read", hashOf(KEY, 0, p.chunks[0].entries)]]);
    // rebuilt with the fee instead, the entries would pay less than the chunk's net
    const v31Args = ({ charged: _c, unstakeCost: _u, ...rest }: StoredLog["args"]) => rest;
    const asFee = p.bit.map((l) => (l.event === "PayoutChunkSent" ? { ...l, args: v31Args(l.args) } : l));
    const wrong = tick([...asFee, ...p.base], { cfg: cfg32 });
    expect(bridgePayouts.run(wrong).map((f) => f.rule)).toEqual(["bridge.payout_mismatch"]);
  });

  it("after the owner's cancel carried bounced entries forward, the next chunk (its cursor back at 0 in the carried list) passes: the carried list is the batch's, continued", () => {
    const X = "0x00000000000000000000000000000000000000d4" as Hex;
    // two bounces and a redeem; the first chunk pays A, the cancel re-mints C's shares and carries X (the last bounce)
    const carried: PayoutEntry[] = [list[0], { user: X, shares: 0n, assets: E18 }, list[2]];
    const p = payoutBatch({
      key: KEY,
      list: carried,
      chunks: [
        { taken: 1, fee: FEE, charged: FEE },
        { taken: 1, fee: FEE, charged: FEE },
      ],
      cancel: { after: 0, bouncesCarried: 1 },
    });
    expect(p.chunks[1].entries.map((e) => e.user)).toEqual([X]);
    const c = tick(all(p), { cfg: cfg32 });
    expect(bridgePayouts.run(c)).toEqual([]);
    expect(c.writes.chunkChecks.map((w) => [w.chunk, w.status])).toEqual([
      [0, "awaiting_read"],
      [1, "awaiting_read"],
    ]);
    // the unsent bounces are the bounce section's tail from the cursor on, so the carried list holds what the batch's
    // list holds there: placed by every earlier chunk's taken, as before
    expect(payoutList(p.bit, KEY)).toEqual(carried);
    expect(p.bit.filter((l) => l.event === "PayoutBatchCancelled").map((l) => l.args.bouncesCarried)).toEqual([1]);
  });

  it("chunkEntries splits charged + unstakeCost over a chunk as deductFee does (each share rounded up, each net floored to rao)", () => {
    const two = [
      { user: A, shares: 1n, assets: 2n * E18 },
      { user: B, shares: 1n, assets: E18 },
    ];
    // 0.001 TAO charged and 0.0005 TAO of walk cost over 3 TAO: 1/2000 each
    expect(chunkEntries(two, 0, 2, 3n * E18, 10n ** 15n + 5n * 10n ** 14n)).toEqual([
      { user: A, amount: 1_999_000_000_000_000_000n },
      { user: B, amount: 999_500_000_000_000_000n },
    ]);
  });
});

describe("bridge.payout_mismatch: each step", () => {
  const p = () => payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE }] });
  const mismatch = (logs: StoredLog[], cfg?: Config) => {
    const c = tick(logs, { cfg });
    const found = bridgePayouts.run(c);
    expect(c.writes.chunkChecks.map((w) => w.status)).toEqual(["mismatch"]);
    expect(found.map((f) => f.rule)).toEqual(["bridge.payout_mismatch"]);
    return { f: found[0], row: c.writes.chunkChecks[0] };
  };
  const change = (x: PayoutFixture, pick: (l: StoredLog) => boolean, args: StoredLog["args"]) => [...x.bit, ...x.base.map((l) => (pick(l) ? withArgs(l, args) : l))];

  it("a bridge outside BRIDGES (step 1)", () => {
    const x = payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE }], bridge: SECOND.toLowerCase() as Hex });
    const { f } = mismatch(all(x));
    expect(f.facts.step).toMatch(/^1/);
    expect(f.facts.side).toBe("base");
    expect(f.hold?.id).toBe(`bridge.payout:${KEY}:0:${x.chunks[0].landing!.uid}`);
  });

  it("an amount that isn't the chunk's net (step 2)", () => {
    const x = p();
    expect(mismatch(change(x, (l) => l.event === "PayoutsDelivered", { amount: String(x.chunks[0].net + 1n) })).f.facts.step).toMatch(/^2/);
  });

  it("a message id the Bittensor adapter never sent (step 3)", () => {
    const x = p();
    expect(mismatch(change(x, (l) => l.event === "Delivered", { messageId: h("never sent") })).f.facts.step).toMatch(/^3/);
  });

  it("one user changed, or one amount off by 1 wei (step 4)", () => {
    const x = p();
    const second = (l: StoredLog) => l.event === "PayoutReceived" && l.args.user === B;
    expect(mismatch(change(x, second, { user: EVIL })).f.facts.step).toMatch(/^4/);
    const y = p();
    const amount = BigInt(String(y.base.find((l) => l.event === "PayoutReceived" && l.args.user === B)!.args.amount));
    expect(mismatch(change(y, (l) => l.event === "PayoutReceived" && l.args.user === B, { amount: String(amount + 1n) })).f.facts.step).toMatch(/^4/);
  });

  it("delivered() false from a reading before the landing keeps awaiting it; at or after the landing it is a mismatch; true is ok", () => {
    const x = p();
    const first = tick(all(x));
    bridgePayouts.run(first);
    const rows = first.writes.chunkChecks.map(rowOf);
    const landing = x.chunks[0].landing!;
    const before = tick(all(x), { rows, fresh: false, reads: [read(landing, false, landing.block - 1n)] });
    expect(bridgePayouts.run(before)).toEqual([]);
    expect(before.writes.chunkChecks).toEqual([]);
    const at = tick(all(x), { rows, fresh: false, reads: [read(landing, false)] });
    const [f] = bridgePayouts.run(at);
    expect(f.facts.step).toMatch(/^5/);
    expect(at.writes.chunkChecks.map((w) => w.status)).toEqual(["mismatch"]);
    const yes = tick(all(x), { rows, fresh: false, reads: [read(landing, true, landing.block + 5n)] });
    expect(bridgePayouts.run(yes)).toEqual([]);
    expect(yes.writes.chunkChecks.map((w) => w.status)).toEqual(["ok"]);
  });
});

describe("bridge.duplicate and ccip.unexpected_source, Base side", () => {
  it("a second landing for one (key, chunk) is a duplicate: the honest row stays ok, the forged one is a mismatch", () => {
    const x = payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE }] });
    const t1 = tick(all(x));
    bridgePayouts.run(t1);
    const t2 = tick(all(x), { rows: t1.writes.chunkChecks.map(rowOf), fresh: false, reads: [read(x.chunks[0].landing!, true)] });
    bridgePayouts.run(t2);
    const honest = t2.writes.chunkChecks.map(rowOf);
    expect(honest.map((r) => r.status)).toEqual(["ok"]);
    // the same message replayed through the landing path, paying EVIL instead of B; a re-read finds it
    // late, far below the blocks settled before
    const forgedTx = h("forged landing");
    const forged = x.base.map((l, i) => {
      const copy = { ...l, uid: h(`forged ${i}`), txHash: forgedTx, block: 36_000_000n };
      return l.event === "PayoutReceived" && l.args.user === B ? withArgs(copy, { user: EVIL }) : copy;
    });
    const t3 = tick([...all(x), ...forged], { rows: honest, newUids: forged.map((l) => l.uid) });
    const found = bridgePayouts.run(t3);
    const dup = found.find((f) => f.rule === "bridge.duplicate");
    expect(dup?.key).toBe(`bridge.duplicate:payout:${KEY}:0:2`);
    expect(dup?.hold?.id).toBe(dup?.key);
    expect(dup?.facts.side).toBe("base");
    expect(found.filter((f) => f.rule === "bridge.payout_mismatch").map((f) => f.facts.step)).toEqual([expect.stringMatching(/^4/)]);
    expect(t3.writes.chunkChecks.map((w) => [w.landedUid, w.status])).toEqual([[forged[0].uid, "mismatch"]]);
  });

  it("a Base adapter Delivered into the front door from another sender is an unexpected source, with a hold", () => {
    const x = payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE }] });
    const base = x.base.map((l) => (l.event === "Delivered" ? withArgs(l, { sender: EVIL }) : l));
    const found = bridgePayouts.run(tick([...x.bit, ...base]));
    const u = found.find((f) => f.rule === "ccip.unexpected_source");
    expect(u?.key).toBe(`ccip.unexpected_source:base:${x.chunks[0].landTx}`);
    expect(u?.hold?.id).toBe(u?.key);
    expect(u?.facts.sender).toBe(EVIL);
    // found late, far below the blocks settled before: still reported; stored before: not again
    const late = base.map((l) => ({ ...l, block: 36_000_000n }));
    expect(bridgePayouts.run(tick([...x.bit, ...late])).map((f) => f.rule)).toContain("ccip.unexpected_source");
    expect(bridgePayouts.run(tick([...x.bit, ...base], { fresh: false })).map((f) => f.rule)).not.toContain("ccip.unexpected_source");
  });
});

describe("bridge.payout_mismatch: no landing skips its check", () => {
  it("a landing a re-read found late, far below the blocks settled before, is checked", () => {
    const x = payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE }], landBlock: 36_000_000n });
    const c = tick(all(x));
    bridgePayouts.run(c);
    expect(c.writes.chunkChecks.map((w) => [w.landedUid, w.status])).toEqual([[x.chunks[0].landing!.uid, "awaiting_read"]]);
  });

  it("a landing whose row was stored with its log but never decided (a rule failed) is checked on a later tick", () => {
    const x = payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE }] });
    const l = x.chunks[0].landing!;
    const stored = rowOf({ landedUid: l.uid, batchKey: KEY, chunk: 0, landedTx: l.txHash, landedBlock: l.block, status: "waiting" });
    const c = tick(all(x), { rows: [stored], fresh: false });
    bridgePayouts.run(c);
    expect(c.writes.chunkChecks.map((w) => [w.landedUid, w.status])).toEqual([[l.uid, "awaiting_read"]]);
  });
});

describe("bridge.payout_unchecked: no landing waits unchecked without a critical", () => {
  const p = () => payoutBatch({ key: KEY, list, chunks: [{ taken: 3, fee: FEE }] });
  const stuckKey = (l: StoredLog) => `bridge.payout_unchecked:${KEY}:0:${l.uid}`;

  it("warns 60 minutes after a landing still waiting for Bittensor, timed from its block", () => {
    const x = p();
    const l = x.chunks[0].landing!;
    const first = tick(all(x), { bitLag: -1 });
    bridgePayouts.run(first);
    const rows = first.writes.chunkChecks.map(rowOf);
    expect(rows.map((r) => [r.status, r.firstSeen])).toEqual([["waiting", LANDED_AT]]);
    expect(bridgePayouts.run(tick(all(x), { rows, fresh: false, bitLag: -1, nowS: LANDED_AT + 3599 }))).toEqual([]);
    const late = tick(all(x), { rows, fresh: false, bitLag: -1, nowS: LANDED_AT + 3600 });
    const [f] = bridgePayouts.run(late);
    expect(f).toMatchObject({ rule: "bridge.payout_unchecked", key: stuckKey(l), facts: { side: "base", key: KEY, chunk: "0" } });
    expect(late.writes.chunkChecks).toEqual([]);
  });

  it("times a landing from when its row was first seen when its block time is never fetched, and when its log isn't loaded", () => {
    const x = p();
    const l = x.chunks[0].landing!;
    // a row stored with its log has no first-seen time yet: the rule gives it one
    const stored = rowOf({ landedUid: l.uid, batchKey: KEY, chunk: 0, landedTx: l.txHash, landedBlock: l.block, status: "waiting" });
    const first = tick(all(x), { rows: [stored], fresh: false, noTimes: true });
    expect(bridgePayouts.run(first)).toEqual([]);
    expect(first.writes.chunkChecks.map((w) => [w.status, w.firstSeen])).toEqual([["waiting", LANDED_AT]]);
    const rows = first.writes.chunkChecks.map(rowOf);
    expect(bridgePayouts.run(tick(all(x), { rows, fresh: false, noTimes: true, nowS: LANDED_AT + 3599 }))).toEqual([]);
    expect(bridgePayouts.run(tick(all(x), { rows, fresh: false, noTimes: true, nowS: LANDED_AT + 3600 })).map((f) => f.key)).toEqual([stuckKey(l)]);
    // its log not loaded at all: the row alone is enough
    const noLog = tick([], { rows: [stored] });
    expect(bridgePayouts.run(noLog)).toEqual([]);
    expect(noLog.writes.chunkChecks.map((w) => [w.landedUid, w.status, w.firstSeen])).toEqual([[l.uid, "waiting", LANDED_AT]]);
    expect(bridgePayouts.run(tick([], { rows, nowS: LANDED_AT + 3600 })).map((f) => f.key)).toEqual([stuckKey(l)]);
  });

  it("warns about a landing awaiting its delivered() read for 60 minutes", () => {
    const x = p();
    const l = x.chunks[0].landing!;
    const first = tick(all(x));
    bridgePayouts.run(first);
    const rows = first.writes.chunkChecks.map(rowOf);
    expect(rows.map((r) => r.status)).toEqual(["awaiting_read"]);
    // no read yet, or only from a reading before the landing
    expect(bridgePayouts.run(tick(all(x), { rows, fresh: false, nowS: LANDED_AT + 3599 }))).toEqual([]);
    const late = tick(all(x), { rows, fresh: false, nowS: LANDED_AT + 3600, reads: [read(l, false, l.block - 1n)] });
    expect(bridgePayouts.run(late).map((f) => f.key)).toEqual([stuckKey(l)]);
    expect(late.writes.chunkChecks).toEqual([]);
    // decided this tick: no warning
    expect(bridgePayouts.run(tick(all(x), { rows, fresh: false, nowS: LANDED_AT + 3600, reads: [read(l, true)] }))).toEqual([]);
  });
});

describe("the payout list, a chunk's entries and the message", () => {
  it("lists bounced deposits (0 shares) first, then redeems, each in log order, for one key only", () => {
    const x = payoutBatch({ key: KEY, list: [list[1], list[0], list[2]], chunks: [{ taken: 3, fee: FEE }] });
    const other = slog({ contract: "vault", event: "Redeemed", block: 1n, args: { key: h("other"), user: EVIL, shares: "1", assets: "1" } });
    expect(payoutList([...x.bit, other], KEY)).toEqual([list[0], list[1], list[2]]);
  });

  it("chunkEntries matches _deductFee on worked examples", () => {
    // fee / gross = 1/1000 exactly: B is floored to rao, the 1-gwei tail becomes dust and is dropped
    const exact = [
      { user: A, shares: 1n, assets: 3n * E18 },
      { user: B, shares: 1n, assets: 999_999_999_000_000_000n },
      { user: C, shares: 1n, assets: 1_000_000_000n },
    ];
    expect(chunkEntries(exact, 0, 3, 4n * E18, 4n * 10n ** 15n)).toEqual([
      { user: A, amount: 2_997_000_000_000_000_000n },
      { user: B, amount: 998_999_999_000_000_000n },
    ]);
    // a fee that doesn't divide: each entry pays the fee rounded up, then is floored to rao
    const ceil = [
      { user: A, shares: 1n, assets: 2n * E18 },
      { user: B, shares: 1n, assets: E18 },
    ];
    expect(chunkEntries([exact[0], ...ceil], 1, 2, 3n * E18, 10n ** 15n)).toEqual([
      { user: A, amount: 1_999_333_333_000_000_000n },
      { user: B, amount: 999_666_666_000_000_000n },
    ]);
  });

  it("encodes abi.encode(uint8 2, bytes32 key, uint32 chunk, Entry[] entries)", () => {
    const entries = [{ user: A, amount: E18 }];
    expect(keccak256(encodePayoutsMessage(KEY, 3, entries))).toBe(hashOf(KEY, 3, entries));
  });

  it("hands the snapshot the delivered() reads of the landings awaiting one", () => {
    const row = (o: Partial<ChunkCheckRow>): ChunkCheckRow => ({
      landedUid: h("l"),
      batchKey: KEY,
      chunk: 0,
      landedTx: h("t"),
      landedBlock: 5n,
      sentTx: null,
      messageId: null,
      expectedHash: h("hash"),
      status: "awaiting_read",
      detail: null,
      firstSeen: null,
      bridge: D.baseAdapter,
      ...o,
    });
    expect(deliveredChecks([row({}), row({ landedUid: h("w"), status: "waiting" }), row({ landedUid: h("n"), expectedHash: null })])).toEqual([
      { landedUid: h("l"), key: KEY, chunk: 0, bridge: D.baseAdapter, hash: h("hash") },
    ]);
  });

  // the fixture (scripts/record-fixtures.ts): v3-test batch 2 chunk 0, its processPayouts transaction and its
  // landing, with the front door's delivered(baseAdapter, hash) at the landing block
  it("recomputes v3-test batch 2 chunk 0's message hash (real bytes)", () => {
    const { base, bittensor } = v3Logs();
    const landing = base.find((l) => l.contract === "frontDoor" && l.event === "PayoutsDelivered");
    if (!landing) throw new Error("no landing in the fixture");
    expect(landing.txHash).toBe(chunk.landingTx);
    const sent = bittensor.find((l) => l.event === "PayoutChunkSent");
    expect(sent?.args).toMatchObject({ key: chunk.key, chunk: 0, net: String(77_877_092n * 10n ** 9n - 1_061_267n * 10n ** 9n) });
    // rebuilt from the vault's events alone (the delivery's Redeemed, the chunk's gross and fee), paired and
    // grouped by log order in the real transactions
    const group = groupDelivered(base.filter((l) => l.txHash === landing.txHash), { opener: "frontDoor:PayoutsDelivered", adapter: "baseAdapter", recipient: V3.frontDoor })[0];
    const v = checkPayout({
      d: V3,
      bridges: [V3.baseAdapter],
      landing,
      group,
      vaultLogs: bittensor.filter((l) => l.contract === "vault"),
      bitTx: (hash) => bittensor.filter((l) => l.txHash === hash),
    });
    expect(v).toMatchObject({ status: "awaiting_read", sentTx: chunk.chunkTx, messageId: chunk.messageId });
    // the hash the front door recorded: delivered() reads true for it at the landing block (and not before)
    expect(v.expectedHash).toBe(chunk.delivered.hash);
    expect(chunk.delivered).toMatchObject({ atLanding: true, beforeLanding: false });
  });
});

// ---- v3.2 (Task 56): a park's refund lands on Base as chunk 4294967295, with no PayoutChunkSent ----

describe("v3.2: a park's refund (chunk 4294967295) is checked against the parked batch, never as a vault chunk", () => {
  const CFG32 = testConfigV32();
  const deposits = [
    { user: A, amount: 3n * E18 },
    { user: B, amount: E18 },
  ];
  const TOTAL = 4n * E18;
  /** A front-door batch that parked on Bittensor, was refunded 14 days on (the adapter's Sent from the vault to the front
   * door, then ParkedRefunded), and landed on Base as PayoutsDelivered(parkKey, REFUND_CHUNK) with a PayoutReceived per
   * deposit. */
  function refunded(o: { entries?: { user: Hex; amount: bigint }[]; deliveredMessage?: Hex; noPark?: boolean; noRefund?: boolean; park?: (l: StoredLog) => StoredLog } = {}) {
    const b = parkedBatch({ id: 46n, deposits });
    const R = h("refund message 46");
    const refundTx = h("refund tx 46");
    const bit = [
      slog({
        contract: "bitAdapter",
        chain: "bittensor",
        address: D.bitAdapter,
        event: "Sent",
        block: 6_901_000n,
        txHash: refundTx,
        logIndex: 0,
        topic1: R,
        args: { messageId: R, destChain: "8453", sender: D.vault, recipient: D.frontDoor, amount: String(TOTAL), fee: "1", gasLimit: "1" },
      }),
      parkLog("ParkedRefunded", { key: b.parkKey, block: 6_901_000n, txHash: refundTx, logIndex: 1, messageId: R }),
    ];
    const landTx = h("refund landing 46");
    const fd = (event: string, args: StoredLog["args"], logIndex: number) => slog({ contract: "frontDoor", chain: "base", address: D.frontDoor, event, args, block: 37_001_000n, txHash: landTx, logIndex, topic1: b.parkKey });
    const entries = o.entries ?? deposits;
    const landing = fd("PayoutsDelivered", { batchKey: b.parkKey, chunk: REFUND_CHUNK, amount: String(TOTAL), bridge: D.baseAdapter }, 0);
    const base = [
      landing,
      ...entries.map((e, i) => fd("PayoutReceived", { batchKey: b.parkKey, chunk: REFUND_CHUNK, user: e.user, amount: String(e.amount) }, 1 + i)),
      slog({
        contract: "baseAdapter",
        chain: "base",
        address: D.baseAdapter,
        event: "Delivered",
        block: 37_001_000n,
        txHash: landTx,
        logIndex: 1 + entries.length,
        topic1: o.deliveredMessage ?? R,
        args: { messageId: o.deliveredMessage ?? R, sourceChain: "964", sender: D.vault, recipient: D.frontDoor, amount: String(TOTAL) },
      }),
    ];
    const parked = (o.park ?? ((l) => l))(b.park[0]);
    return { b, landing, refundTx, R, logs: [...b.base, ...(o.noPark ? [] : [parked]), ...(o.noRefund ? [] : bit), ...base] };
  }
  const mismatchStep = (logs: StoredLog[], cfg: Config = CFG32) => {
    const c = tick(logs, { cfg });
    const found = bridgePayouts.run(c);
    expect(c.writes.chunkChecks.map((w) => w.status)).toEqual(["mismatch"]);
    expect(found.map((f) => f.rule)).toEqual(["bridge.payout_mismatch"]);
    return found[0].facts;
  };

  it("an honest refund awaits the front door's delivered() of the parked batch's deposits as a PAYOUTS message, then passes: no false alarm", () => {
    const r = refunded();
    const first = tick(r.logs, { cfg: CFG32 });
    expect(bridgePayouts.run(first)).toEqual([]);
    expect(first.writes.chunkChecks).toEqual([
      {
        landedUid: r.landing.uid,
        batchKey: r.b.parkKey,
        chunk: REFUND_CHUNK,
        landedTx: r.landing.txHash,
        landedBlock: r.landing.block,
        status: "awaiting_read",
        firstSeen: LANDED_AT,
        sentTx: r.refundTx,
        messageId: r.R,
        expectedHash: hashOf(r.b.parkKey, REFUND_CHUNK, deposits),
      },
    ]);
    const rows = first.writes.chunkChecks.map(rowOf);
    const ok = tick(r.logs, { cfg: CFG32, rows, fresh: false, reads: [read(r.landing, true)] });
    expect(bridgePayouts.run(ok)).toEqual([]);
    expect(ok.writes.chunkChecks.map((w) => w.status)).toEqual(["ok"]);
  });

  it("fails a refund landing that isn't the park's: no ParkedRefunded of its key (step 2), a stranger's park (step 2), another message (step 3), another depositor or amount (step 4)", () => {
    expect(mismatchStep(refunded({ noRefund: true }).logs).step).toMatch(/^2: the park the adapter refunded/);
    expect(mismatchStep(refunded({ park: (l) => withArgs(l, { sender: EVIL }) }).logs).detail).toMatch(/isn't a batch from the front door to the vault/);
    expect(mismatchStep(refunded({ deliveredMessage: h("another refund") }).logs).step).toMatch(/^3/);
    expect(mismatchStep(refunded({ entries: [{ user: EVIL, amount: 3n * E18 }, { user: B, amount: E18 }] }).logs).step).toMatch(/^4/);
    expect(mismatchStep(refunded({ entries: [{ user: A, amount: 3n * E18 + 1n }, { user: B, amount: E18 - 1n }] }).logs).step).toMatch(/^4/);
    // the parked batch can't be found on Base (its close, by the park's message id): step 4, worded so
    const r = refunded();
    expect(mismatchStep(r.logs.filter((l) => !(l.chain === "base" && l.event === "BatchClosed"))).detail).toMatch(/can't rebuild the parked batch/);
  });

  it("on v3-launch a chunk 4294967295 is no refund: it still fails as a chunk the vault never sent", () => {
    const r = refunded();
    expect(mismatchStep(r.logs, testConfig()).step).toMatch(/^2: the chunk the vault sent/);
  });
});
